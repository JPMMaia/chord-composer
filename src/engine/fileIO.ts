import type {
  ChordQuality,
  ChordSegment,
  Note,
  NoteName,
  Project,
  ScaleType,
  SegmentKind,
  TimeSignature,
  Track,
  TrackContent,
} from '@/types/music';
import { barChords, isValidTimeSignature } from '@/engine/timeline';
import { DEFAULT_INSTRUMENT_ID } from '@/engine/instrumentCatalog';
import { trackColorAt } from '@/utils/constants';

/**
 * Track id given to the piano synthesised for a pre-1.5 file that listed no tracks.
 *
 * Fixed rather than generated so that loading the same legacy file twice produces
 * the same project — otherwise a round-trip through save would look like a change.
 */
const LEGACY_TRACK_ID = 'track-legacy';

/**
 * Current schema version for forward/backward compatibility.
 *
 * 1.1 added per-bar time signatures and note segments. Files written by 1.0 read
 * back unchanged: an absent bar meter means "inherit the project's" and an absent
 * segment kind means "chord", which is exactly what 1.0 could express.
 *
 * 1.2 added segment start beats, so blocks can sit anywhere in a bar with silence
 * between them. Older files carry no positions, and the store packs those segments
 * end to end on load — which is exactly what having no position used to mean.
 *
 * 1.3 added a per-segment octave, so chords can be voiced in any register. An
 * absent octave is read as 4, the octave every pre-1.3 chord was generated in,
 * so older files sound identical.
 *
 * 1.4 added the play range and the repeat flag. Absent fields mean "no range, no
 * repeat" — play the whole project once — which is all a pre-1.4 file could mean.
 *
 * 1.5 made instruments real. A bar's segments and notes moved from flat `chords`
 * and `notes` arrays into `content`, keyed by track id, and tracks gained a sound,
 * a colour and a visibility flag. A pre-1.5 file had one timbre — a piano — and no
 * way to say which instrument played what, so its flat arrays are read into a
 * single Piano track, synthesised if the file listed no tracks at all. That is
 * exactly what those files always meant.
 */
export const SCHEMA_VERSION = '1.5';

/**
 * Validation error returned by validateProject.
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Valid note names for validation.
 */
const VALID_NOTES: NoteName[] = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
];

/**
 * Valid chord qualities for validation.
 */
const VALID_QUALITIES: ChordQuality[] = [
  'major', 'minor', 'diminished', 'augmented', 'sus2', 'sus4',
  'dominant7', 'maj7', 'min7', 'dim7', 'halfDim7', 'minMaj7',
];

/**
 * Valid scale types for validation.
 */
const VALID_SCALE_TYPES = [
  'major', 'naturalMinor', 'harmonicMinor', 'melodicMinor',
  'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian',
  'pentatonicMajor', 'pentatonicMinor', 'blues',
];

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a Project to a JSON string.
 * Dates are converted to ISO strings. A version field is added for future
 * schema compatibility checks.
 */
export function serializeProject(project: Project): string {
  const payload = {
    version: SCHEMA_VERSION,
    id: project.id,
    name: project.name,
    bpm: project.bpm,
    timeSignature: project.timeSignature,
    key: project.key,
    keyMode: project.keyMode,
    // Undefined bounds drop out of the JSON, which is exactly "no range".
    loopStart: project.loopStart,
    loopEnd: project.loopEnd,
    loopEnabled: project.loopEnabled ?? false,
    tracks: project.tracks.map(t => ({
      id: t.id,
      name: t.name,
      instrument: t.instrument,
      volume: t.volume,
      pan: t.pan,
      muted: t.muted,
      solo: t.solo,
      // Absent has always meant visible, so only `false` is worth writing.
      visible: t.visible !== false,
      color: t.color,
    })),
    bars: project.bars.map(b => ({
      id: b.id,
      barIndex: b.barIndex,
      // Written only when the bar overrides the project meter, so a uniform
      // project still serialises exactly as it did under schema 1.0.
      timeSignature: b.timeSignature,
      scale: b.scale,
      // Per-instrument from 1.5 on. The inner shape is unchanged from 1.4, so a
      // reader that understands one bar's chords understands these.
      content: Object.fromEntries(
        Object.entries(b.content).map(([trackId, trackContent]) => [
          trackId,
          {
            chords: trackContent.chords.map(c => ({
              id: c.id,
              startBeat: c.startBeat,
              kind: c.kind ?? 'chord',
              romanNumeral: c.romanNumeral,
              chordSymbol: c.chordSymbol,
              duration: c.duration,
              pitch: c.pitch,
              octave: c.octave,
              root: c.root,
              inversion: c.inversion,
              quality: c.quality,
            })),
            notes: trackContent.notes.map(n => ({
              id: n.id,
              pitch: n.pitch,
              startBeat: n.startBeat,
              duration: n.duration,
              velocity: n.velocity,
            })),
          },
        ])
      ),
    })),
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };

  return JSON.stringify(payload, null, 2);
}

// ---------------------------------------------------------------------------
// Deserialization
// ---------------------------------------------------------------------------

/**
 * Deserialize a JSON string back to a Project.
 * Throws on invalid JSON or missing required fields.
 */
export function deserializeProject(json: string): Project {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invalid JSON: unable to parse project file.');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Invalid project: expected an object.');
  }

  const p = parsed as Record<string, unknown>;

  // Required scalar fields
  const requiredFields = ['id', 'name', 'bpm', 'timeSignature', 'key', 'keyMode'] as const;
  for (const field of requiredFields) {
    if (!(field in p)) {
      throw new Error(`Invalid project: missing required field "${field}".`);
    }
  }

  const name = p.name as string;
  const bpm = p.bpm as number;
  const key = p.key as NoteName;
  const keyMode = p.keyMode as 'major' | 'minor';
  const timeSignature = p.timeSignature as { beatsPerMeasure: number; beatUnit: number };

  // Type-check tracks and bars
  const parsedTracks = Array.isArray(p.tracks)
    ? (p.tracks as Record<string, unknown>[]).map((t, i) => ({
        id: (t.id as string) ?? `track-${i}`,
        name: (t.name as string) ?? `Track ${i + 1}`,
        // A pre-1.5 track named no sound; every project was a piano.
        instrument:
          typeof t.instrument === 'string' && t.instrument
            ? t.instrument
            : DEFAULT_INSTRUMENT_ID,
        volume: typeof t.volume === 'number' ? t.volume : 1.0,
        pan: typeof t.pan === 'number' ? t.pan : 0,
        muted: t.muted === true,
        solo: t.solo === true,
        visible: t.visible !== false,
        color: typeof t.color === 'string' ? t.color : trackColorAt(i),
      }))
    : [];

  // A file with no tracks at all is pre-1.5 — and pre-instruments, since 1.5 always
  // writes at least one. Its flat bar arrays are a piano part, so it gets a piano to
  // hang them on rather than opening as a project that can play nothing.
  const tracks: Track[] =
    parsedTracks.length > 0
      ? parsedTracks
      : [
          {
            id: LEGACY_TRACK_ID,
            name: 'Piano',
            instrument: DEFAULT_INSTRUMENT_ID,
            volume: 1.0,
            pan: 0,
            muted: false,
            solo: false,
            visible: true,
            color: trackColorAt(0),
          },
        ];

  /** Where a pre-1.5 bar's flat arrays land: the first instrument. */
  const legacyTrackId = tracks[0].id;

  const readChords = (raw: unknown, barIndex: number): ChordSegment[] =>
    Array.isArray(raw)
      ? (raw as Record<string, unknown>[]).map((c, j) => ({
          id: (c.id as string) ?? `chord-${barIndex}-${j}`,
          // Schema 1.1 and earlier had no positions; leaving it undefined lets
          // the store pack the bar, which is what those files meant.
          startBeat: typeof c.startBeat === 'number' ? c.startBeat : undefined,
          // Schema 1.0 had no note segments, so anything unlabelled is a chord.
          kind: (c.kind === 'note' ? 'note' : 'chord') as SegmentKind,
          romanNumeral: typeof c.romanNumeral === 'string' ? c.romanNumeral : undefined,
          chordSymbol: typeof c.chordSymbol === 'string' ? c.chordSymbol : undefined,
          duration: typeof c.duration === 'number' ? c.duration : 4,
          pitch: typeof c.pitch === 'number' ? c.pitch : undefined,
          // Schema 1.2 and earlier had no register; note generation reads an
          // absent octave as 4, which is the only one those files could mean.
          octave: typeof c.octave === 'number' ? c.octave : undefined,
          root: typeof c.root === 'string' ? (c.root as NoteName) : undefined,
          inversion: typeof c.inversion === 'number' ? c.inversion : 0,
          quality: typeof c.quality === 'string' ? (c.quality as ChordQuality) : undefined,
        }))
      : [];

  const readNotes = (raw: unknown, barIndex: number): Note[] =>
    Array.isArray(raw)
      ? (raw as Record<string, unknown>[]).map((n, k) => ({
          id: (n.id as string) ?? `note-${barIndex}-${k}`,
          pitch: typeof n.pitch === 'number' ? n.pitch : 60,
          startBeat: typeof n.startBeat === 'number' ? n.startBeat : 0,
          duration: typeof n.duration === 'number' ? n.duration : 1,
          velocity: typeof n.velocity === 'number' ? n.velocity : 100,
        }))
      : [];

  const bars = Array.isArray(p.bars)
    ? (p.bars as Record<string, unknown>[]).map((b, i) => {
        // 1.5 and later carry `content`; anything earlier carries flat arrays that
        // belong to the one instrument those files could express.
        const content: Record<string, TrackContent> =
          b.content && typeof b.content === 'object'
            ? Object.fromEntries(
                Object.entries(b.content as Record<string, Record<string, unknown>>).map(
                  ([trackId, raw]) => [
                    trackId,
                    { chords: readChords(raw?.chords, i), notes: readNotes(raw?.notes, i) },
                  ]
                )
              )
            : { [legacyTrackId]: { chords: readChords(b.chords, i), notes: readNotes(b.notes, i) } };

        return {
          id: (b.id as string) ?? `bar-${i}`,
          barIndex: typeof b.barIndex === 'number' ? b.barIndex : i,
          // A missing — or nonsensical — meter means the bar follows the project's.
          timeSignature: isValidTimeSignature(b.timeSignature as TimeSignature | undefined)
            ? (b.timeSignature as TimeSignature)
            : undefined,
          scale: (b.scale as { root: NoteName; type: ScaleType }) ?? { root: 'C', type: 'major' },
          content,
        };
      })
    : [];

  // A range needs both bounds to mean anything; a half-written one is discarded
  // rather than half-applied.
  const hasRange =
    typeof p.loopStart === 'number' &&
    typeof p.loopEnd === 'number' &&
    p.loopStart >= 0 &&
    p.loopEnd > p.loopStart;

  return {
    id: p.id as string,
    name,
    bpm,
    timeSignature,
    key,
    keyMode,
    tracks,
    bars,
    loopStart: hasRange ? (p.loopStart as number) : undefined,
    loopEnd: hasRange ? (p.loopEnd as number) : undefined,
    loopEnabled: p.loopEnabled === true,
    createdAt: new Date(p.createdAt as string),
    updatedAt: new Date(p.updatedAt as string),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a Project and return a ValidationResult.
 */
export function validateProject(project: Project): ValidationResult {
  const errors: string[] = [];

  if (!project.name || project.name.trim().length === 0) {
    errors.push('Project name is required and cannot be empty.');
  }

  if (typeof project.bpm !== 'number' || project.bpm < 20 || project.bpm > 300) {
    errors.push(`BPM must be a number between 20 and 300. Got: ${project.bpm}.`);
  }

  if (!project.timeSignature) {
    errors.push('Time signature is required.');
  } else if (!isValidTimeSignature(project.timeSignature)) {
    const { beatsPerMeasure, beatUnit } = project.timeSignature;
    errors.push(
      `Invalid time signature ${beatsPerMeasure}/${beatUnit}: beatsPerMeasure must be >= 2 and beatUnit one of 2, 4, 8, 16.`
    );
  }

  if (!VALID_NOTES.includes(project.key)) {
    errors.push(`Invalid key: ${project.key}. Must be one of ${VALID_NOTES.join(', ')}.`);
  }

  if (project.keyMode !== 'major' && project.keyMode !== 'minor') {
    errors.push(`Invalid keyMode: ${project.keyMode}. Must be "major" or "minor".`);
  }

  // Validate the play range: both bounds together, non-negative, non-empty.
  const { loopStart, loopEnd } = project;
  if ((loopStart === undefined) !== (loopEnd === undefined)) {
    errors.push('Play range needs both a start and an end.');
  } else if (loopStart !== undefined && loopEnd !== undefined) {
    if (loopStart < 0 || loopEnd < 0) {
      errors.push(`Play range bounds must be >= 0. Got: ${loopStart}, ${loopEnd}.`);
    } else if (loopStart >= loopEnd) {
      errors.push(`Play range start (${loopStart}) must be before its end (${loopEnd}).`);
    }
  }

  // Validate tracks
  for (let i = 0; i < (project.tracks?.length ?? 0); i++) {
    const t = project.tracks[i];
    if (!t.id) errors.push(`Track ${i}: missing id.`);
    if (typeof t.volume !== 'number' || t.volume < 0 || t.volume > 1) {
      errors.push(`Track ${i}: volume must be between 0 and 1.`);
    }
    if (typeof t.pan !== 'number' || t.pan < -1 || t.pan > 1) {
      errors.push(`Track ${i}: pan must be between -1 and 1.`);
    }
  }

  // Validate bars
  for (let i = 0; i < (project.bars?.length ?? 0); i++) {
    const b = project.bars[i];
    if (!b.id) errors.push(`Bar ${i}: missing id.`);
    if (!VALID_NOTES.includes(b.scale.root)) {
      errors.push(`Bar ${i}: invalid scale root "${b.scale.root}".`);
    }
    if (!VALID_SCALE_TYPES.includes(b.scale.type)) {
      errors.push(`Bar ${i}: invalid scale type "${b.scale.type}".`);
    }
    // A bar may omit its meter to follow the project's, but not carry a bad one.
    if (b.timeSignature && !isValidTimeSignature(b.timeSignature)) {
      const { beatsPerMeasure, beatUnit } = b.timeSignature;
      errors.push(`Bar ${i}: invalid time signature ${beatsPerMeasure}/${beatUnit}.`);
    }
    // Content keyed by an instrument that does not exist would be silently
    // unplayable and invisible, so it is worth catching at the door.
    const trackIds = new Set(project.tracks.map(t => t.id));
    for (const trackId of Object.keys(b.content)) {
      if (!trackIds.has(trackId)) {
        errors.push(`Bar ${i}: content for unknown instrument "${trackId}".`);
        continue;
      }
      const chords = barChords(b, trackId);
      for (let j = 0; j < chords.length; j++) {
        const c = chords[j];
        if (c.quality && !VALID_QUALITIES.includes(c.quality)) {
          errors.push(`Bar ${i}, chord ${j}: invalid quality "${c.quality}".`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ---------------------------------------------------------------------------
// File save / load
// ---------------------------------------------------------------------------

/**
 * Save a project to a file using the File System Access API (if available)
 * or fall back to a traditional download via a Blob URL.
 */
export async function saveToFile(project: Project, filename: string): Promise<void> {
  const validation = validateProject(project);
  if (!validation.valid) {
    throw new Error(`Cannot save: ${validation.errors.join(' ')}`);
  }

  const json = serializeProject(project);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  // Try File System Access API first
  if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: filename,
        types: [{
          description: 'Chord Composer Project',
          accept: { 'application/json': ['.json'] },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      URL.revokeObjectURL(url);
      return;
    } catch {
      // User cancelled or API failed — fall through to download
    }
  }

  // Fallback: trigger a download through a detached anchor
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Load a project from a File object (e.g. from a file picker).
 */
export async function loadFromFile(file: File): Promise<Project> {
  const text = await file.text();
  return deserializeProject(text);
}

// ---------------------------------------------------------------------------
// LocalStorage helpers
// ---------------------------------------------------------------------------

const LOCAL_STORAGE_KEY = 'chord-composer-autosave';

/**
 * Save a project to localStorage (for auto-save).
 */
export function autoSaveToLocalStorage(project: Project): void {
  try {
    const json = serializeProject(project);
    localStorage.setItem(LOCAL_STORAGE_KEY, json);
  } catch (e) {
    console.warn('Auto-save to localStorage failed:', e);
  }
}

/**
 * Load a project from localStorage, or return null if not found / invalid.
 */
export function loadFromLocalStorage(): Project | null {
  try {
    const json = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!json) return null;
    return deserializeProject(json);
  } catch {
    return null;
  }
}

/**
 * Clear the autosave entry from localStorage.
 */
export function clearLocalStorage(): void {
  try {
    localStorage.removeItem(LOCAL_STORAGE_KEY);
  } catch {
    // Storage may be unavailable
  }
}
