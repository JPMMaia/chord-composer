import type {
  ArpeggioPattern,
  AutomationPoint,
  AutomationTarget,
  ChordQuality,
  ChordSegment,
  Note,
  NoteName,
  ParameterAutomation,
  Project,
  Scale,
  ScaleType,
  Section,
  SegmentBreak,
  SegmentKind,
  SegmentVoicing,
  SpacingPreset,
  TimeSignature,
  Track,
  TrackContent,
  TrackGroup,
} from '@/types/music';
import { barChords, getTotalBeats, isValidTimeSignature } from '@/engine/timeline';
import { normalizePoints } from '@/engine/volumeAutomation';
import { MAX_CC, normalizeParameterAutomation } from '@/engine/parameterAutomation';
import { normalizeSections } from '@/engine/sections';
import { normalizeTrackOrder } from '@/engine/trackGroups';
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
 *
 * 1.6 gave each chord segment a voicing: a spacing preset, per-tone octave
 * offsets, doubled tones, and an arpeggio or strum. An absent voicing is the
 * plain block chord — every tone in close position, sounded together — which is
 * the only thing a pre-1.6 chord could be, so older files sound identical.
 *
 * 1.7 lets a track name a native VST3 plugin instead of a General MIDI sound,
 * and carries that plugin's own state — its preset — alongside. The instrument
 * id needed no migration: a bare id still means General MIDI, and only the new
 * `vst3:` prefix means a plugin. `vst3State` is absent for every other track,
 * and for a plugin that has not been touched, which reads as "whatever the
 * plugin comes up in" — exactly what a pre-1.7 file meant.
 *
 * 1.8 moved the key off the bar and onto each segment, so two blocks in one bar
 * can be in different keys. A pre-1.8 file states one scale per bar, which is
 * what every segment in that bar was written against — so reading one pushes the
 * bar's scale down onto its segments and the piece sounds identical. The bar's
 * own `scale` is no longer written; a segment with no key of its own falls back
 * to the project key.
 *
 * 1.8 also carries `metronomeEnabled`, which the project always had but which no
 * version ever wrote — reopening a file silently turned the click off. Every file
 * older than this one, whatever version it states, reads as off, which is exactly
 * what those files have always come back as; so nothing changes for them and the
 * version stays where it is.
 *
 * 1.9 added the custom block — a segment carrying the notes it was played with,
 * each with its own onset, length and velocity — and an optional velocity on every
 * segment. Both are what live MIDI recording produces. Neither key is written when
 * absent, so a project nobody has recorded into serialises byte for byte as it did
 * under 1.8, and a pre-1.9 file has no custom blocks and no velocities: its notes
 * sound at the fixed 100 they always did.
 *
 * 1.10 gave every instrument an optional volume curve: breakpoints in absolute
 * beats with linear ramps between them, overriding the flat `volume` whenever it
 * has any. The key is omitted when the curve is empty, so a project nobody has
 * automated serialises exactly as it did under 1.9, and a pre-1.10 file has no
 * curves at all — its instruments play at the one level they always did.
 *
 * 1.11 gave each instrument stacked sub-lanes: a `lane` on every segment and a
 * `laneCount` on every instrument. Blocks may not overlap within a lane, so a lane
 * is what lets a played chord be the several simultaneous note blocks it is. Both
 * keys are omitted at their defaults — lane 0, one lane — so a project with nothing
 * stacked serialises exactly as it did under 1.10, and a pre-1.11 file reads back as
 * the single lane it always was.
 *
 * 1.11 also retired the `custom` block that 1.9 introduced. Sub-lanes express a
 * recording directly, as named notes, so nothing needs the opaque form any more.
 * A `custom` segment in an older file is unrecognised and, like every unrecognised
 * kind, reads back as a chord.
 *
 * 1.12 let a note sit off the scale: an `alter` on a segment, in semitones, saying
 * which degree an off-scale note means. Nothing else can say it — a raised seventh and
 * the tonic above it are the same MIDI number — and without it the arrow keys and a
 * change of key would both flatten the accidental out. Omitted at 0, so a piece with no
 * accidentals in it serialises byte for byte as it did under 1.11, and a pre-1.12 file
 * reads back as the wholly diatonic piece it was.
 *
 * 1.13 added sections: named spans over the arrangement — Intro, Verse, Chorus — in
 * absolute beats, like the play range and unlike a chord segment. They label and
 * nothing else; no note's sound depends on one. The key is omitted when there are
 * none, so an unlabelled project serialises byte for byte as it did under 1.12, and
 * a pre-1.13 file reads back as the unlabelled timeline it always was.
 *
 * 1.14 added plugin parameter automation: per-track curves driving a VST3 plugin's own
 * parameters by id, on the same absolute-beat axis and the same 0-1 scale as the volume
 * curve — which is also VST3's normalised range, so a breakpoint needs no conversion.
 * Each lane stores the parameter's title beside its id, so a lane can still name itself
 * on a machine where the plugin is not installed. The key is omitted when there are no
 * lanes, so a project with no parameter curves serialises byte for byte as it did under
 * 1.13, and a pre-1.14 file reads back with nothing automated but its volume.
 *
 * 1.15 let a lane drive a MIDI controller as well as a named parameter, which is what
 * reaches a sampler whose own controls are bound by MIDI learn rather than published
 * under useful names. A lane's `paramId` became a `target` — `{kind: 'param', paramId}`
 * or `{kind: 'cc', controller}` — because a controller has to be stored as the number
 * the user bound rather than as the id it currently resolves to, which belongs to this
 * installed version of this plugin. A 1.14 lane's bare `paramId` reads back as a
 * `param` target, so nothing automated under 1.14 loses its curve.
 *
 * 1.16 grouped the sidebar: `trackGroups` names the groups, and each track's optional
 * `groupId` says which one it is in. A group is a label carrying a collapsed state and
 * its own mute and solo, and owns no music — removing one leaves every instrument
 * playing exactly what it played. Membership is stored on the track rather than as a
 * list of ids on the group so `tracks` stays the one place instrument order is written;
 * a group's members are the run of tracks carrying its id, which the reader below
 * re-normalizes into a contiguous run whatever order the file had them in. Both keys
 * are omitted when nothing is grouped, so an ungrouped project serialises byte for byte
 * as it did under 1.15, and a pre-1.16 file reads back as the flat sidebar it always was.
 */
export const SCHEMA_VERSION = '1.16';

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
    // Part of how the piece is worked on rather than of the piece, but it lives on
    // the project and was being dropped on every round-trip — reopening a file
    // silently turned the click off.
    metronomeEnabled: project.metronomeEnabled ?? false,
    // Omitted when nothing is named, so an unlabelled project gains no bytes and
    // still round-trips exactly as it did under 1.12.
    sections: project.sections?.length
      ? project.sections.map(s => ({
          id: s.id,
          name: s.name,
          startBeat: s.startBeat,
          endBeat: s.endBeat,
          color: s.color,
        }))
      : undefined,
    // Omitted when the sidebar is flat, on the same terms as `sections` above.
    trackGroups: project.trackGroups?.length
      ? project.trackGroups.map(g => ({
          id: g.id,
          name: g.name,
          // Only the non-default state of each flag is worth writing; absent reads
          // as expanded, unmuted and unsoloed.
          collapsed: g.collapsed || undefined,
          muted: g.muted || undefined,
          solo: g.solo || undefined,
          color: g.color,
        }))
      : undefined,
    tracks: project.tracks.map(t => ({
      id: t.id,
      name: t.name,
      // Absent means ungrouped, which is what every instrument was before 1.16.
      groupId: t.groupId,
      instrument: t.instrument,
      // Absent means the single lane every instrument had before 1.11.
      laneCount: t.laneCount !== undefined && t.laneCount > 1 ? t.laneCount : undefined,
      volume: t.volume,
      // Omitted when there is no curve, so an unautomated project gains no bytes
      // and still round-trips byte for byte as it did under 1.9.
      volumeAutomation:
        t.volumeAutomation && t.volumeAutomation.length > 0 ? t.volumeAutomation : undefined,
      // Omitted on the same terms, and additionally without its empty lanes: a
      // lane with no points survives an edit — it is one just added, waiting to be
      // drawn on — but saving one would preserve a gesture rather than a curve.
      parameterAutomation: serializeParameterAutomation(t.parameterAutomation),
      pan: t.pan,
      muted: t.muted,
      solo: t.solo,
      // Absent has always meant visible, so only `false` is worth writing.
      visible: t.visible !== false,
      color: t.color,
      // Only plugins have one, and only once the plugin has been asked for it.
      vst3State: t.vst3State,
    })),
    bars: project.bars.map(b => ({
      id: b.id,
      barIndex: b.barIndex,
      // Written only when the bar overrides the project meter, so a uniform
      // project still serialises exactly as it did under schema 1.0.
      timeSignature: b.timeSignature,
      // Per-instrument from 1.5 on. The inner shape is unchanged from 1.4, so a
      // reader that understands one bar's chords understands these.
      content: Object.fromEntries(
        Object.entries(b.content).map(([trackId, trackContent]) => [
          trackId,
          {
            chords: trackContent.chords.map(c => ({
              id: c.id,
              startBeat: c.startBeat,
              // Absent means lane 0, so a project with nothing stacked gains no
              // bytes and round-trips exactly as it did under 1.10.
              lane: c.lane,
              kind: c.kind ?? 'chord',
              romanNumeral: c.romanNumeral,
              chordSymbol: c.chordSymbol,
              duration: c.duration,
              pitch: c.pitch,
              // Which degree an off-scale note means, as semitones off it. Absent on
              // every unaltered note, so a piece with no accidentals in it serialises
              // exactly as it did under 1.11.
              alter: c.alter,
              octave: c.octave,
              root: c.root,
              inversion: c.inversion,
              quality: c.quality,
              velocity: c.velocity,
              // The key this block is written in — a bar-level `scale` is no
              // longer written, so this is where a 1.8 file states its keys.
              scale: c.scale,
              // Absent on an unvoiced chord, and an absent key drops out of the
              // JSON entirely — so a project nobody has voiced still serialises
              // byte for byte as it did under 1.5.
              voicing: c.voicing,
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

const VALID_SPACING_PRESETS: SpacingPreset[] = ['close', 'open', 'drop2', 'drop3'];
const VALID_ARPEGGIO_PATTERNS: ArpeggioPattern[] = ['up', 'down', 'upDown', 'asPlayed'];

/** How far a file may push a voice from its chord, matching the engine's own limit. */
const MAX_FILE_OFFSET_OCTAVES = 3;

/**
 * Read a segment's voicing out of a file, keeping only what makes sense.
 *
 * Everything here is dropped rather than repaired when it does not fit: an
 * unrecognised preset or a doubling of no particular tone says nothing about
 * what the author meant, and a chord that sounds plainly is a better answer than
 * one voiced from garbage. Returns undefined when nothing survives, which is
 * exactly how a pre-1.6 file reads.
 */
function readVoicing(raw: unknown): SegmentVoicing | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const v = raw as Record<string, unknown>;

  const spacing = VALID_SPACING_PRESETS.includes(v.spacing as SpacingPreset)
    ? (v.spacing as SpacingPreset)
    : undefined;

  const offsets = Array.isArray(v.offsets)
    ? v.offsets.map(o =>
        typeof o === 'number' && Number.isFinite(o)
          ? Math.max(-MAX_FILE_OFFSET_OCTAVES, Math.min(MAX_FILE_OFFSET_OCTAVES, Math.trunc(o)))
          : 0
      )
    : undefined;

  const doublings = Array.isArray(v.doublings)
    ? (v.doublings as Record<string, unknown>[])
        .filter(
          d =>
            typeof d?.tone === 'number' &&
            Number.isInteger(d.tone) &&
            d.tone >= 0 &&
            (d.octaves === 1 || d.octaves === -1)
        )
        .map(d => ({ tone: d.tone as number, octaves: d.octaves as 1 | -1 }))
    : undefined;

  const brk = readBreak(v.break);

  const keptOffsets = offsets?.some(o => o !== 0) ? offsets : undefined;
  const keptDoublings = doublings?.length ? doublings : undefined;

  if (!spacing && !keptOffsets && !keptDoublings && !brk) return undefined;
  return { spacing, offsets: keptOffsets, doublings: keptDoublings, break: brk };
}

function readBreak(raw: unknown): SegmentBreak | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const b = raw as Record<string, unknown>;

  if (b.mode === 'arpeggio') {
    const pattern = VALID_ARPEGGIO_PATTERNS.includes(b.pattern as ArpeggioPattern)
      ? (b.pattern as ArpeggioPattern)
      : 'up';
    // A gate outside (0, 1] is not a shorter note, it is a longer one — which is
    // what the absent default already means.
    const gate =
      typeof b.gate === 'number' && b.gate > 0 && b.gate <= 1 ? b.gate : undefined;
    return { mode: 'arpeggio', pattern, gate };
  }

  if (b.mode === 'strum') {
    // A non-positive spread is a block chord wearing a strum's clothes; the
    // engine clamps a too-wide one, so only the sign has to be settled here.
    const spreadBeats =
      typeof b.spreadBeats === 'number' && Number.isFinite(b.spreadBeats) && b.spreadBeats > 0
        ? b.spreadBeats
        : undefined;
    if (spreadBeats === undefined) return undefined;
    return {
      mode: 'strum',
      spreadBeats,
      direction: b.direction === 'down' ? 'down' : 'up',
    };
  }

  return undefined;
}

/**
 * Read a MIDI velocity, or undefined when the file states none or states nonsense.
 *
 * Undefined rather than 100: the two sound the same, but only the absence
 * round-trips back to a file that says nothing, which is what keeps a pre-1.9
 * project serialising unchanged.
 */
function readVelocity(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.max(1, Math.min(127, Math.round(raw)));
}

/**
 * Read a segment's sub-lane, or undefined for the first one.
 *
 * Undefined rather than 0, for `readVelocity`'s reason: the two mean the same, but
 * only the absence round-trips back to a file that says nothing, which is what keeps
 * a project with nothing stacked serialising exactly as it did under 1.10. A
 * negative or fractional lane is nonsense rather than a position, and reads as the
 * first lane.
 */
function readLane(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return undefined;
  return Math.floor(raw);
}

/** Read an instrument's lane count, or undefined for the single lane that is the default. */
function readLaneCount(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 2) return undefined;
  return Math.floor(raw);
}

/**
 * Read a track's volume curve off a file.
 *
 * Absent when there is nothing usable, rather than an empty array: absent is what
 * hands the instrument back to its flat `volume`, and an empty array would only be
 * a longer way of saying the same thing.
 */
function parseAutomation(raw: unknown): AutomationPoint[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const points = normalizePoints(raw as AutomationPoint[]);
  return points.length > 0 ? points : undefined;
}

/** How a lane names itself in a validation message. */
function describeTarget(target: { kind?: string; paramId?: unknown; controller?: unknown }): string {
  return target?.kind === 'cc' ? `CC ${target.controller}` : `parameter ${target?.paramId}`;
}

/**
 * A track's parameter lanes as they go into a file, or absent when there are none.
 *
 * Empty lanes are dropped on the way out: one survives an *edit*, because a lane
 * just added is waiting to be drawn on, but a saved file describing a curve with
 * no points in it records a gesture rather than any music.
 */
function serializeParameterAutomation(
  lanes: ParameterAutomation[] | undefined
): ParameterAutomation[] | undefined {
  const kept = normalizeParameterAutomation(lanes ?? [], { dropEmpty: true });
  return kept.length > 0 ? kept : undefined;
}

/**
 * Read a track's plugin lanes off a file.
 *
 * Absent when there is nothing usable, rather than an empty array — the same rule
 * `parseAutomation` follows above, and what a project written before parameter
 * automation says. A malformed lane is dropped rather than repaired: a curve with
 * nothing to drive says nothing about what the author meant.
 *
 * A 1.14 lane carried a bare `paramId` where a 1.15 one carries a `target`; it is
 * read as the parameter target it always meant. No version is consulted to decide
 * that, in keeping with every other key here: the shape says which it is.
 */
function readParameterAutomation(raw: unknown): ParameterAutomation[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const upgraded = raw.map(lane => {
    if (typeof lane !== 'object' || lane === null) return lane;
    const legacy = lane as { target?: unknown; paramId?: unknown };
    if (legacy.target !== undefined || typeof legacy.paramId !== 'number') return lane;

    return { ...legacy, target: { kind: 'param', paramId: legacy.paramId } };
  });

  const lanes = normalizeParameterAutomation(upgraded as ParameterAutomation[], {
    dropEmpty: true,
  });
  return lanes.length > 0 ? lanes : undefined;
}

/**
 * Read the project's sections off a file.
 *
 * Absent when there is nothing usable, rather than an empty array: absent is what a
 * project written before sections existed says, and an empty array would only be a
 * longer way of saying the same thing. A malformed entry is dropped rather than
 * repaired — a span with no bounds says nothing about what the author meant, and an
 * unlabelled stretch is a better answer than a band drawn from garbage.
 */
function readSections(raw: unknown, songEnd: number): Section[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const sections = normalizeSections(
    (raw as Record<string, unknown>[])
      .filter(
        s =>
          typeof s?.id === 'string' &&
          typeof s?.name === 'string' &&
          typeof s?.startBeat === 'number' &&
          typeof s?.endBeat === 'number' &&
          Number.isFinite(s.startBeat) &&
          Number.isFinite(s.endBeat) &&
          s.startBeat >= 0 &&
          s.endBeat > s.startBeat
      )
      .map(s => ({
        id: s.id as string,
        name: s.name as string,
        startBeat: s.startBeat as number,
        endBeat: s.endBeat as number,
        color: typeof s.color === 'string' ? s.color : undefined,
      })),
    songEnd
  );

  return sections.length > 0 ? sections : undefined;
}

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

  // Read before the tracks, which need it to tell a real `groupId` from a stale one.
  // An entry without a usable id or name is dropped rather than shown as a nameless
  // header: its members simply come back ungrouped, which loses a label and no music.
  const trackGroups: TrackGroup[] = Array.isArray(p.trackGroups)
    ? (p.trackGroups as Record<string, unknown>[]).flatMap((g, i) =>
        typeof g?.id === 'string' && g.id && typeof g.name === 'string' && g.name
          ? [
              {
                id: g.id,
                name: g.name,
                collapsed: g.collapsed === true,
                muted: g.muted === true,
                solo: g.solo === true,
                color: typeof g.color === 'string' ? g.color : trackColorAt(i),
              },
            ]
          : []
      )
    : [];
  const groupIds = new Set(trackGroups.map(g => g.id));

  // Type-check tracks and bars
  const parsedTracks = Array.isArray(p.tracks)
    ? (p.tracks as Record<string, unknown>[]).map((t, i) => ({
        id: (t.id as string) ?? `track-${i}`,
        name: (t.name as string) ?? `Track ${i + 1}`,
        // A groupId naming no group is dropped here rather than left to read as
        // ungrouped downstream, so what loads is what saves.
        groupId:
          typeof t.groupId === 'string' && groupIds.has(t.groupId) ? t.groupId : undefined,
        // A pre-1.5 track named no sound; every project was a piano.
        instrument:
          typeof t.instrument === 'string' && t.instrument
            ? t.instrument
            : DEFAULT_INSTRUMENT_ID,
        // Pre-1.11 tracks had one lane, which is what an absent count means.
        laneCount: readLaneCount(t.laneCount),
        volume: typeof t.volume === 'number' ? t.volume : 1.0,
        // Normalised on read rather than trusted: it is the one field a hand-edited
        // file can put out of order, and everything downstream assumes it is sorted.
        // Anything malformed is dropped, which lands the track back on its flat
        // volume rather than failing the whole load.
        volumeAutomation: parseAutomation(t.volumeAutomation),
        // Normalised for the same reason, and dropped on the same terms: a lane
        // naming no parameter drives nothing, and losing it is better than
        // failing the load over it.
        parameterAutomation: readParameterAutomation(t.parameterAutomation),
        pan: typeof t.pan === 'number' ? t.pan : 0,
        muted: t.muted === true,
        solo: t.solo === true,
        visible: t.visible !== false,
        color: typeof t.color === 'string' ? t.color : trackColorAt(i),
        // Base64 plugin state, opaque here. Anything that is not a string is
        // dropped rather than passed to the plugin, which would reject it.
        vst3State: typeof t.vst3State === 'string' ? t.vst3State : undefined,
      }))
    : [];

  // A file with no tracks at all is pre-1.5 — and pre-instruments, since 1.5 always
  // writes at least one. Its flat bar arrays are a piano part, so it gets a piano to
  // hang them on rather than opening as a project that can play nothing.
  const tracks: Track[] =
    parsedTracks.length > 0
      ? // Contiguous runs are an invariant the panel and the writers keep, but a
        // hand-edited file need not have honoured it — so it is restored on read
        // rather than assumed, and a scattered group loads as one group.
        normalizeTrackOrder(parsedTracks, trackGroups)
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

  /**
   * A scale from raw JSON, or undefined when it is absent or not a real one.
   *
   * A bad key is dropped rather than repaired: falling back to the project key is
   * a defensible reading of "no key", but silently correcting `H harmonicMinor`
   * to something would hide a broken file.
   */
  const readScale = (raw: unknown): Scale | undefined => {
    if (!raw || typeof raw !== 'object') return undefined;
    const { root, type } = raw as { root?: unknown; type?: unknown };
    if (!VALID_NOTES.includes(root as NoteName)) return undefined;
    if (!VALID_SCALE_TYPES.includes(type as ScaleType)) return undefined;
    return { root: root as NoteName, type: type as ScaleType };
  };

  const readChords = (
    raw: unknown,
    barIndex: number,
    /** The bar's own scale in a pre-1.8 file — what its segments were written in. */
    legacyBarScale: Scale | undefined
  ): ChordSegment[] =>
    Array.isArray(raw)
      ? (raw as Record<string, unknown>[]).map((c, j) => ({
          id: (c.id as string) ?? `chord-${barIndex}-${j}`,
          // Schema 1.1 and earlier had no positions; leaving it undefined lets
          // the store pack the bar, which is what those files meant.
          startBeat: typeof c.startBeat === 'number' ? c.startBeat : undefined,
          // Schema 1.10 and earlier had one lane per instrument; an absent lane is
          // that lane, which is what those files meant.
          lane: readLane(c.lane),
          // Schema 1.0 had no note segments, so anything unlabelled is a chord —
          // and so is anything unrecognised, which is what a file from a future
          // version, or a 1.9 `custom` block, looks like.
          kind: (c.kind === 'note' ? c.kind : 'chord') as SegmentKind,
          romanNumeral: typeof c.romanNumeral === 'string' ? c.romanNumeral : undefined,
          chordSymbol: typeof c.chordSymbol === 'string' ? c.chordSymbol : undefined,
          duration: typeof c.duration === 'number' ? c.duration : 4,
          pitch: typeof c.pitch === 'number' ? c.pitch : undefined,
          // Schema 1.11 and earlier had no accidentals; an absent alteration is a note
          // sitting on its degree, which is all those files could write. Clamped like
          // the formula reader does — nothing can spell more than a double accidental.
          alter:
            typeof c.alter === 'number' && Number.isFinite(c.alter)
              ? Math.max(-2, Math.min(2, Math.round(c.alter))) || undefined
              : undefined,
          // Schema 1.2 and earlier had no register; note generation reads an
          // absent octave as 4, which is the only one those files could mean.
          octave: typeof c.octave === 'number' ? c.octave : undefined,
          root: typeof c.root === 'string' ? (c.root as NoteName) : undefined,
          inversion: typeof c.inversion === 'number' ? c.inversion : 0,
          quality: typeof c.quality === 'string' ? (c.quality as ChordQuality) : undefined,
          // Schema 1.7 and earlier stated one key per bar. That is the key every
          // segment in the bar was written against, so it migrates down onto each
          // of them and the piece reads back identically.
          scale: readScale(c.scale) ?? legacyBarScale,
          // Schema 1.5 and earlier had no voicing; an absent one means the plain
          // block chord, which is all those files could express.
          voicing: readVoicing(c.voicing),
          // Schema 1.8 and earlier had none. An absent velocity is the fixed 100
          // every note used to carry.
          velocity: readVelocity(c.velocity),
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
        // Pre-1.8 only. Both bar shapes below are handed it, so a 1.4 file's flat
        // arrays migrate exactly as a 1.7 file's per-instrument ones do.
        const legacyBarScale = readScale(b.scale);

        const content: Record<string, TrackContent> =
          b.content && typeof b.content === 'object'
            ? Object.fromEntries(
                Object.entries(b.content as Record<string, Record<string, unknown>>).map(
                  ([trackId, raw]) => [
                    trackId,
                    {
                      chords: readChords(raw?.chords, i, legacyBarScale),
                      notes: readNotes(raw?.notes, i),
                    },
                  ]
                )
              )
            : {
                [legacyTrackId]: {
                  chords: readChords(b.chords, i, legacyBarScale),
                  notes: readNotes(b.notes, i),
                },
              };

        return {
          id: (b.id as string) ?? `bar-${i}`,
          barIndex: typeof b.barIndex === 'number' ? b.barIndex : i,
          // A missing — or nonsensical — meter means the bar follows the project's.
          timeSignature: isValidTimeSignature(b.timeSignature as TimeSignature | undefined)
            ? (b.timeSignature as TimeSignature)
            : undefined,
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
    // Kept undefined rather than empty when nothing is grouped, so a re-save of a
    // pre-1.16 file writes no `trackGroups` key at all.
    trackGroups: trackGroups.length > 0 ? trackGroups : undefined,
    bars,
    loopStart: hasRange ? (p.loopStart as number) : undefined,
    loopEnd: hasRange ? (p.loopEnd as number) : undefined,
    loopEnabled: p.loopEnabled === true,
    metronomeEnabled: p.metronomeEnabled === true,
    // Normalised against the song the file actually describes, so a hand-edited
    // list cannot hand the editor a band reaching past the last bar.
    sections: readSections(p.sections, getTotalBeats(bars, timeSignature)),
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

  // Validate the sections: named, well-formed spans that do not overlap. Gaps
  // between them are fine — music nobody has named is a normal state.
  const sections = project.sections ?? [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (!s.name || s.name.trim().length === 0) {
      errors.push(`Section ${i}: name is required and cannot be empty.`);
    }
    if (s.startBeat < 0) {
      errors.push(`Section ${i}: start must be >= 0. Got: ${s.startBeat}.`);
    } else if (s.startBeat >= s.endBeat) {
      errors.push(`Section ${i}: start (${s.startBeat}) must be before its end (${s.endBeat}).`);
    }
    const previous = sections[i - 1];
    if (previous && s.startBeat < previous.endBeat) {
      errors.push(`Section ${i} ("${s.name}") overlaps "${previous.name}".`);
    }
  }

  // Validate the instrument groups: named, uniquely identified labels. Being empty
  // is fine — a group is made before anything is dragged into it.
  const groups = project.trackGroups ?? [];
  const groupIds = new Set<string>();
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g.id) {
      errors.push(`Instrument group ${i}: missing id.`);
    } else if (groupIds.has(g.id)) {
      errors.push(`Instrument group ${i}: duplicate id "${g.id}".`);
    } else {
      groupIds.add(g.id);
    }
    if (!g.name || g.name.trim().length === 0) {
      errors.push(`Instrument group ${i}: name is required and cannot be empty.`);
    }
  }

  // Validate tracks
  for (let i = 0; i < (project.tracks?.length ?? 0); i++) {
    const t = project.tracks[i];
    if (!t.id) errors.push(`Track ${i}: missing id.`);
    if (t.groupId !== undefined && !groupIds.has(t.groupId)) {
      errors.push(`Track ${i}: group "${t.groupId}" does not exist.`);
    }
    if (typeof t.volume !== 'number' || t.volume < 0 || t.volume > 1) {
      errors.push(`Track ${i}: volume must be between 0 and 1.`);
    }
    if (typeof t.pan !== 'number' || t.pan < -1 || t.pan > 1) {
      errors.push(`Track ${i}: pan must be between -1 and 1.`);
    }
    if (t.volumeAutomation !== undefined) {
      if (!Array.isArray(t.volumeAutomation)) {
        errors.push(`Track ${i}: volume automation must be a list of points.`);
      } else {
        for (const point of t.volumeAutomation) {
          if (typeof point?.beat !== 'number' || !Number.isFinite(point.beat) || point.beat < 0) {
            errors.push(`Track ${i}: volume automation beat must be a number >= 0.`);
            break;
          }
          if (
            typeof point.value !== 'number' ||
            !Number.isFinite(point.value) ||
            point.value < 0 ||
            point.value > 1
          ) {
            errors.push(`Track ${i}: volume automation value must be between 0 and 1.`);
            break;
          }
        }
      }
    }

    if (t.parameterAutomation !== undefined) {
      if (!Array.isArray(t.parameterAutomation)) {
        errors.push(`Track ${i}: parameter automation must be a list of lanes.`);
      } else {
        for (const lane of t.parameterAutomation) {
          // A 1.14 lane named its parameter directly, so it is read the same way
          // `readParameterAutomation` reads one — validating a file must not
          // reject what opening it accepts. The cast is what says this arrives
          // untrusted, whatever the declared type claims.
          const legacy = lane as { target?: AutomationTarget; paramId?: number };
          const target: AutomationTarget | { kind: 'param'; paramId?: number } =
            legacy?.target ?? { kind: 'param', paramId: legacy?.paramId };
          const named = describeTarget(target);

          // A VST3 ParamID is an unsigned 32-bit integer and a MIDI controller is
          // 0-127; anything else names nothing the plugin could be sent.
          const usable =
            target.kind === 'param'
              ? Number.isInteger(target.paramId) && (target.paramId ?? -1) >= 0
              : target.kind === 'cc' &&
                Number.isInteger(target.controller) &&
                target.controller >= 0 &&
                target.controller <= MAX_CC;
          if (!usable) {
            errors.push(
              `Track ${i}: automation needs a whole parameter id >= 0 or a controller 0-${MAX_CC}.`
            );
            break;
          }
          if (!Array.isArray(lane.points)) {
            errors.push(`Track ${i}: ${named} needs a list of points.`);
            break;
          }
          const bad = lane.points.find(
            p =>
              typeof p?.beat !== 'number' ||
              !Number.isFinite(p.beat) ||
              p.beat < 0 ||
              typeof p?.value !== 'number' ||
              !Number.isFinite(p.value) ||
              p.value < 0 ||
              p.value > 1
          );
          if (bad) {
            errors.push(
              `Track ${i}: ${named} needs a beat >= 0 and a value between 0 and 1.`
            );
            break;
          }
        }
      }
    }
  }

  // Validate bars
  for (let i = 0; i < (project.bars?.length ?? 0); i++) {
    const b = project.bars[i];
    if (!b.id) errors.push(`Bar ${i}: missing id.`);
    // A segment may omit its key to follow the project's, but not carry a bad one.
    for (const content of Object.values(b.content ?? {})) {
      for (const c of content.chords ?? []) {
        if (!c.scale) continue;
        if (!VALID_NOTES.includes(c.scale.root)) {
          errors.push(`Bar ${i}: invalid scale root "${c.scale.root}".`);
        }
        if (!VALID_SCALE_TYPES.includes(c.scale.type)) {
          errors.push(`Bar ${i}: invalid scale type "${c.scale.type}".`);
        }
      }
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
        // A lane names a row, so a fraction or a negative names none. Absent is
        // the first lane and always fine.
        if (
          c.lane !== undefined &&
          (!Number.isInteger(c.lane) || c.lane < 0)
        ) {
          errors.push(`Bar ${i}, chord ${j}: invalid lane "${c.lane}".`);
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
 * The text to write for a project, refusing to produce any for one that is broken.
 *
 * Where that text *goes* is not decided here — see `writeRef` in `projectFile.ts`,
 * which knows about paths, file handles and downloads. This function is the last
 * gate before a project reaches a file, and the check belongs at that gate rather
 * than at each of the three call sites that write one.
 */
export function serializeForSave(project: Project): string {
  const validation = validateProject(project);
  if (!validation.valid) {
    throw new Error(`Cannot save: ${validation.errors.join(' ')}`);
  }
  return serializeProject(project);
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
