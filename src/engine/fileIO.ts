import type { ChordQuality, NoteName, Project, ScaleType } from '@/types/music';
import { isValidTimeSignature } from '@/engine/timeline';

/**
 * Current schema version for forward/backward compatibility.
 */
export const SCHEMA_VERSION = '1.0';

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
  'dominant7', 'maj7', 'min7', 'dim7',
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
    tracks: project.tracks.map(t => ({
      id: t.id,
      name: t.name,
      instrument: t.instrument,
      volume: t.volume,
      pan: t.pan,
      muted: t.muted,
      solo: t.solo,
    })),
    bars: project.bars.map(b => ({
      id: b.id,
      barIndex: b.barIndex,
      scale: b.scale,
      chords: b.chords.map(c => ({
        id: c.id,
        romanNumeral: c.romanNumeral,
        chordSymbol: c.chordSymbol,
        duration: c.duration,
        root: c.root,
        inversion: c.inversion,
        quality: c.quality,
      })),
      notes: b.notes.map(n => ({
        id: n.id,
        pitch: n.pitch,
        startBeat: n.startBeat,
        duration: n.duration,
        velocity: n.velocity,
      })),
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
  const tracks = Array.isArray(p.tracks)
    ? (p.tracks as Record<string, unknown>[]).map((t, i) => ({
        id: (t.id as string) ?? `track-${i}`,
        name: (t.name as string) ?? `Track ${i + 1}`,
        instrument: (t.instrument as string) ?? '',
        volume: typeof t.volume === 'number' ? t.volume : 1.0,
        pan: typeof t.pan === 'number' ? t.pan : 0,
        muted: t.muted === true,
        solo: t.solo === true,
      }))
    : [];

  const bars = Array.isArray(p.bars)
    ? (p.bars as Record<string, unknown>[]).map((b, i) => ({
        id: (b.id as string) ?? `bar-${i}`,
        barIndex: typeof b.barIndex === 'number' ? b.barIndex : i,
        scale: (b.scale as { root: NoteName; type: ScaleType }) ?? { root: 'C', type: 'major' },
        chords: Array.isArray(b.chords)
          ? (b.chords as Record<string, unknown>[]).map((c, j) => ({
              id: (c.id as string) ?? `chord-${i}-${j}`,
              romanNumeral: typeof c.romanNumeral === 'string' ? c.romanNumeral : undefined,
              chordSymbol: typeof c.chordSymbol === 'string' ? c.chordSymbol : undefined,
              duration: typeof c.duration === 'number' ? c.duration : 4,
              root: typeof c.root === 'string' ? (c.root as NoteName) : undefined,
              inversion: typeof c.inversion === 'number' ? c.inversion : 0,
              quality: typeof c.quality === 'string' ? (c.quality as ChordQuality) : undefined,
            }))
          : [],
        notes: Array.isArray(b.notes)
          ? (b.notes as Record<string, unknown>[]).map((n, k) => ({
              id: (n.id as string) ?? `note-${i}-${k}`,
              pitch: typeof n.pitch === 'number' ? n.pitch : 60,
              startBeat: typeof n.startBeat === 'number' ? n.startBeat : 0,
              duration: typeof n.duration === 'number' ? n.duration : 1,
              velocity: typeof n.velocity === 'number' ? n.velocity : 100,
            }))
          : [],
      }))
    : [];

  return {
    id: p.id as string,
    name,
    bpm,
    timeSignature,
    key,
    keyMode,
    tracks,
    bars,
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
    for (let j = 0; j < b.chords.length; j++) {
      const c = b.chords[j];
      if (c.quality && !VALID_QUALITIES.includes(c.quality)) {
        errors.push(`Bar ${i}, chord ${j}: invalid quality "${c.quality}".`);
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
