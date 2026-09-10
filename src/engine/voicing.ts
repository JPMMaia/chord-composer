import type {
  ArpeggioPattern,
  ChordSegment,
  Scale,
  SegmentBreak,
  SegmentVoicing,
  SpacingPreset,
  ToneDoubling,
} from '@/types/music';
import { segmentChordTones } from '@/engine/chords';
import type { ChordTones } from '@/engine/chords';
import { PIANO_ROLL_MAX_MIDI, PIANO_ROLL_MIN_MIDI } from '@/utils/constants';

/**
 * How a chord segment is voiced and broken up in time.
 *
 * Everything here is pure and total: it runs on every edit, from
 * `generateNotesFromSegments`, so it must never throw however odd a hand-edited
 * file turns out to be. Where a value makes no sense — a doubling of a tone the
 * chord does not have, a strum wider than the segment — the rule is to fall back
 * to something audible rather than to produce silence or a negative duration.
 *
 * An absent voicing must reproduce the plain block chord exactly, since that is
 * what every chord written before this module sounded like.
 */

/** Re-exported so a caller voicing a chord needs only this module. */
export type { ChordTones };

/** One voice of a chord, still expressed as semitones above the chord root. */
export interface VoicedTone {
  /** Which chord tone this is: 0 root, 1 third, 2 fifth, 3 seventh, 4 ninth. */
  tone: number;
  interval: number;
  /** True for a doubling copy rather than the chord tone itself. */
  doubled: boolean;
}

/** One voice as it finally sounds, still naming the chord tone it belongs to. */
export interface VoicedPitch {
  tone: number;
  pitch: number;
  doubled: boolean;
}

/** A pitch placed in time, before it becomes a `Note` with an id. */
export interface TimedPitch {
  pitch: number;
  startBeat: number;
  duration: number;
  velocity: number;
}

/**
 * The velocity a note carries when nothing states one — the fixed value this app
 * used everywhere before live recording could capture a real one, which is what
 * keeps projects written before then sounding identical. Blocks dropped from the
 * palette state one of their own (`PALETTE_VELOCITY`).
 */
export const DEFAULT_VELOCITY = 100;

/** How far a tone may be pushed from its chord, in octaves, either way. */
const MAX_OFFSET_OCTAVES = 3;

/**
 * The voices a chord sounds, in *tone* order rather than pitch order.
 *
 * Tone order is what an arpeggio's "as played" pattern means, and sorting is
 * cheap, so callers that want ascending pitch sort for themselves.
 *
 * @param chord - The stack to voice, from `segmentChordTones`.
 * @param inversion - How many voices to lift, as `invertIntervals` counts them.
 * @param voicing - Absent means close position with no doubling.
 */
export function voiceChord(
  chord: ChordTones,
  inversion: number,
  voicing?: SegmentVoicing
): VoicedTone[] {
  if (chord.intervals.length === 0) return [];

  const tones: VoicedTone[] = chord.intervals.map((interval, position) => ({
    // The tone this interval belongs to, which is only the same as its position
    // while the stack has no gaps in it.
    tone: chord.tones[position] ?? position,
    interval,
    doubled: false,
  }));

  // The same rotation `invertIntervals` performs, but written as a lift of each
  // voice in turn so a tone keeps its index. That is what lets a hand-tweaked
  // offset stay attached to the third when the inversion changes underneath it.
  const rotations = Math.max(0, Math.floor(inversion));
  for (let i = 0; i < rotations; i++) {
    tones[i % tones.length].interval += 12;
  }

  // A preset only ever seeds `offsets`, so explicit offsets win: they are what
  // the user last said, and a file carrying only a preset still voices correctly.
  const offsets = voicing?.offsets ?? spacingOffsets(tones, voicing?.spacing ?? 'close');
  // By tone, not by position: an offset written on the seventh has to keep moving
  // the seventh when the fifth below it is not sounding.
  for (const voice of tones) {
    voice.interval += clampOffset(offsets[voice.tone]) * 12;
  }

  for (const doubling of voicing?.doublings ?? []) {
    const source = tones.find(t => t.tone === doubling.tone && !t.doubled);
    // A doubling can outlive the chord it was written for — switch a seventh to a
    // triad, or simply omit the fifth, and the doubling has nothing to copy. Drop
    // it quietly; toggling the tone back on brings the doubling back with it.
    if (!source) continue;
    tones.push({
      tone: doubling.tone,
      interval: source.interval + clampOffset(doubling.octaves) * 12,
      doubled: true,
    });
  }

  return tones;
}

/**
 * The offsets a spacing preset produces for a chord already in this inversion.
 *
 * Presets are defined on the *sounding* order — "the second voice from the top
 * drops an octave" — so they have to be resolved against the inverted chord
 * rather than the root-position one, or drop-2 would move the wrong note in
 * every inversion but the first.
 *
 * Indexed by `VoicedTone.tone` rather than by position, because `withSpacing`
 * writes the result straight into `voicing.offsets` and `withToneOffset` then pads
 * that same array by tone. If the two disagreed, a hand-tweak after a preset would
 * land on the wrong voice.
 *
 * @returns One offset per tone, indexed by `VoicedTone.tone`.
 */
export function spacingOffsets(tones: VoicedTone[], preset: SpacingPreset): number[] {
  const size = tones.reduce((max, t) => Math.max(max, t.tone + 1), 0);
  const offsets = new Array<number>(size).fill(0);
  if (preset === 'close' || tones.length === 0) return offsets;

  // Top voice first, so "nth from the top" is just an index.
  const fromTop = tones
    .filter(t => !t.doubled)
    .map(t => ({ tone: t.tone, interval: t.interval }))
    .sort((a, b) => b.interval - a.interval);

  const drop = (nthFromTop: number) => {
    const voice = fromTop[nthFromTop];
    if (voice) offsets[voice.tone] = -1;
  };

  switch (preset) {
    case 'drop2':
      drop(1);
      break;
    case 'drop3':
      // Undefined for anything thinner than a triad; leaving it closed is the
      // honest answer, and the panel disables the button in that case anyway.
      if (fromTop.length >= 3) drop(2);
      break;
    case 'open':
      // Every other voice from the top falls away, which spreads the chord over
      // two registers. On a triad this coincides exactly with drop-2 — that is
      // what open position *is* on three notes, not a collision worth hiding.
      for (let i = 1; i < fromTop.length; i += 2) drop(i);
      break;
  }

  return offsets;
}

/**
 * The absolute MIDI pitches a chord segment sounds.
 *
 * Returned in *tone* order — root, third, fifth, then any doublings — not lowest
 * to highest. Under a drop voicing the two differ, and following the chord's own
 * function is what an "as played" arpeggio means. Callers that want pitch order,
 * `breakChord` among them, sort for themselves.
 *
 * @param baseMidi - MIDI number of the chord root in its chosen register.
 * @returns Voices in tone order, within the piano roll's range, no duplicates.
 */
export function voicedVoices(
  chord: ChordTones,
  inversion: number,
  baseMidi: number,
  voicing?: SegmentVoicing
): VoicedPitch[] {
  const voices: VoicedPitch[] = [];
  const seen = new Set<number>();

  for (const tone of voiceChord(chord, inversion, voicing)) {
    const pitch = baseMidi + tone.interval;
    // Dropped rather than clamped: folding an out-of-range doubling back into
    // the roll would land it on a note the user did not ask for, usually a
    // unison with the tone it was doubling.
    if (pitch < PIANO_ROLL_MIN_MIDI || pitch > PIANO_ROLL_MAX_MIDI) continue;
    // A drop and a doubling can arrive at the same pitch. Two note-ons there
    // would confuse the sampler and the MIDI export both.
    if (seen.has(pitch)) continue;
    seen.add(pitch);
    voices.push({ tone: tone.tone, pitch, doubled: tone.doubled });
  }

  return voices;
}

/**
 * The absolute MIDI pitches a chord segment sounds, in tone order.
 *
 * The pitch half of `voicedVoices`. A caller that needs to know *which* tone a
 * pitch belongs to must use that instead: pitches are dropped here when they leave
 * the roll or collide, so this list cannot be indexed by tone.
 */
export function voicedPitches(
  chord: ChordTones,
  inversion: number,
  baseMidi: number,
  voicing?: SegmentVoicing
): number[] {
  return voicedVoices(chord, inversion, baseMidi, voicing).map(v => v.pitch);
}

/**
 * The order an arpeggio visits its pitches in.
 *
 * `upDown` turns without repeating either end, so a triad gives four steps
 * rather than six and the pattern loops cleanly.
 */
export function arpeggioOrder(pitches: number[], pattern: ArpeggioPattern): number[] {
  if (pitches.length <= 1) return [...pitches];

  switch (pattern) {
    case 'asPlayed':
      return [...pitches];
    case 'up':
      return [...pitches].sort((a, b) => a - b);
    case 'down':
      return [...pitches].sort((a, b) => b - a);
    case 'upDown': {
      const up = [...pitches].sort((a, b) => a - b);
      return [...up, ...up.slice(1, -1).reverse()];
    }
  }
}

/**
 * Spread a chord's pitches across its segment: as a block, an arpeggio or a strum.
 *
 * Every note returned lies within `[startBeat, startBeat + duration]`. That is
 * what keeps a broken chord inside the bar line — `refitBars` guarantees the
 * *segment* sits in its bar, and note generation drops anything starting past the
 * bar's end, so a strum that spilled over would simply go missing.
 *
 * @param pitches - In tone order, as `voicedPitches` returns them.
 * @param spec - Absent means the block chord: every pitch at once, full length.
 * @param velocity - How hard the whole chord sounds. One value for every voice:
 *   a chord block is a single gesture, and per-voice dynamics are what a custom
 *   block is for.
 */
export function breakChord(
  pitches: number[],
  startBeat: number,
  duration: number,
  spec: SegmentBreak | undefined,
  velocity: number = DEFAULT_VELOCITY
): TimedPitch[] {
  if (pitches.length === 0 || duration <= 0) return [];

  if (!spec) {
    // Sounded together, so the order is only ever a listing order — and low to
    // high is the one every chord had before voicings existed.
    return [...pitches]
      .sort((a, b) => a - b)
      .map(pitch => ({ pitch, startBeat, duration, velocity }));
  }

  if (spec.mode === 'arpeggio') {
    const order = arpeggioOrder(pitches, spec.pattern);
    const step = duration / order.length;
    const gate = spec.gate !== undefined && spec.gate > 0 ? Math.min(spec.gate, 1) : 1;

    return order.map((pitch, i) => {
      const offset = i * step;
      // The tail is measured back from the segment's end rather than forward in
      // steps, so rounding cannot let the last note ring past the block.
      const span = i === order.length - 1 ? duration - offset : step * gate;
      return {
        pitch,
        startBeat: startBeat + offset,
        duration: Math.max(span, 0),
        velocity,
      };
    });
  }

  const order =
    spec.direction === 'down'
      ? [...pitches].sort((a, b) => b - a)
      : [...pitches].sort((a, b) => a - b);

  // A spread wide enough to outlast the segment would give the last voices zero
  // or negative length. Squeezing the gesture into the block keeps every note
  // audible, which is nearer what was meant than dropping half the chord.
  const requested = Math.max(spec.spreadBeats, 0);
  const spread =
    requested * (order.length - 1) >= duration ? duration / order.length : requested;

  return order.map((pitch, i) => ({
    pitch,
    startBeat: startBeat + i * spread,
    // Every voice releases together, which is both what a strummed chord does
    // and what guarantees nothing extends past the segment.
    duration: duration - i * spread,
    velocity,
  }));
}

/* -------------------------------------------------------------------------- */
/* Segment transforms                                                          */
/* -------------------------------------------------------------------------- */

/**
 * These sit here rather than in the store because deciding what "drop 2" does to
 * a chord is theory, not state management. The store's job is only to hand each
 * one the scale of the bar its segment lives in.
 */

/** Apply a spacing preset, recording it and seeding the concrete offsets it implies. */
export function withSpacing(
  segment: ChordSegment,
  scale: Scale,
  preset: SpacingPreset
): ChordSegment {
  if (!isChord(segment)) return segment;

  const tones = voiceChord(segmentChordTones(segment, scale), segment.inversion ?? 0, {
    ...segment.voicing,
    // Seed from the chord as it sits before spacing, not as the previous preset
    // left it, or each click would compound on the last.
    offsets: undefined,
    spacing: 'close',
  });

  return withVoicing(segment, {
    ...segment.voicing,
    spacing: preset,
    offsets: spacingOffsets(tones, preset),
  });
}

/**
 * Move one chord tone by whole octaves.
 *
 * Hand-tweaking clears `spacing`: the voicing is no longer the preset's, and the
 * panel lights no button rather than claiming a shape the chord has left.
 */
export function withToneOffset(
  segment: ChordSegment,
  tone: number,
  offsetOctaves: number
): ChordSegment {
  if (!isChord(segment) || tone < 0) return segment;

  const current = segment.voicing?.offsets ?? [];
  const offsets = [...current];
  while (offsets.length <= tone) offsets.push(0);
  offsets[tone] = clampOffset(offsetOctaves);

  return withVoicing(segment, { ...segment.voicing, spacing: undefined, offsets });
}

/** Add a doubling of one tone, or remove it when that exact one is already there. */
export function withToggledDoubling(
  segment: ChordSegment,
  tone: number,
  octaves: 1 | -1
): ChordSegment {
  if (!isChord(segment) || tone < 0) return segment;

  const current = segment.voicing?.doublings ?? [];
  const existing = current.some(d => d.tone === tone && d.octaves === octaves);
  const doublings: ToneDoubling[] = existing
    ? current.filter(d => !(d.tone === tone && d.octaves === octaves))
    : [...current, { tone, octaves }];

  return withVoicing(segment, { ...segment.voicing, doublings });
}

/** Set how the chord is broken up in time; `null` returns it to a block chord. */
export function withBreak(segment: ChordSegment, spec: SegmentBreak | null): ChordSegment {
  if (!isChord(segment)) return segment;
  return withVoicing(segment, { ...segment.voicing, break: spec ?? undefined });
}

/**
 * Set an absolute inversion, wrapping within the chord's own size.
 *
 * The `i` shortcut cycles; the panel names a specific one. Both end up here-shaped
 * so an inversion past the chord's size means the same thing either way.
 */
export function withInversion(
  segment: ChordSegment,
  scale: Scale,
  inversion: number
): ChordSegment {
  if (!isChord(segment)) return segment;

  const size = segmentChordTones(segment, scale).tones.length;
  if (size === 0) return segment;

  const wrapped = ((Math.floor(inversion) % size) + size) % size;
  return { ...segment, inversion: wrapped };
}

/**
 * Set how hard the whole block sounds.
 *
 * The one transform here that is *not* guarded by `isChord`: a note segment and a
 * recorded block both carry a velocity, and only a chord has tones to space. On a
 * custom block this sets the fallback its own notes may each override, which is
 * what `generateNotesFromSegments` already reads it as.
 *
 * A velocity equal to the default is written out rather than cleared. Absence
 * means "never stated", and erasing an explicit choice would leave the field
 * unable to be set back to 100 once it had held anything else.
 */
export function withVelocity(segment: ChordSegment, velocity: number): ChordSegment {
  if (!Number.isFinite(velocity)) return segment;
  return { ...segment, velocity: Math.max(1, Math.min(127, Math.round(velocity))) };
}

/** Strip the voicing entirely, returning the chord to close position, sounded as a block. */
export function withoutVoicing(segment: ChordSegment): ChordSegment {
  if (segment.voicing === undefined) return segment;
  const { voicing: _voicing, ...rest } = segment;
  return rest;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Only a chord has a voicing to edit.
 *
 * A note segment carries one pitch and so has no tones to space, double or break,
 * and an absent `kind` has always meant a chord.
 */
function isChord(segment: ChordSegment): boolean {
  return segment.kind !== 'note';
}

function clampOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(-MAX_OFFSET_OCTAVES, Math.min(MAX_OFFSET_OCTAVES, Math.trunc(value)));
}

/**
 * Attach a voicing, pruning one that says nothing back to `undefined`.
 *
 * Without this, clicking Close after Drop 2 would leave `{ spacing: 'close',
 * offsets: [0,0,0] }` behind — sounding right but serialising as a change, so a
 * project that had been returned to its original state would no longer look like it.
 */
function withVoicing(segment: ChordSegment, voicing: SegmentVoicing): ChordSegment {
  const offsets = voicing.offsets?.some(o => o !== 0) ? voicing.offsets : undefined;
  const doublings = voicing.doublings?.length ? voicing.doublings : undefined;
  // 'close' is the default, so recording it says nothing the absence would not.
  const spacing = voicing.spacing === 'close' ? undefined : voicing.spacing;

  if (!offsets && !doublings && !spacing && !voicing.break) {
    return withoutVoicing(segment);
  }

  return { ...segment, voicing: { spacing, offsets, doublings, break: voicing.break } };
}

// ---------------------------------------------------------------------------
// Reading a voicing out of a file
// ---------------------------------------------------------------------------
//
// Shared by the project reader and the formula-library reader: both take a voicing
// off a document a user may have hand-edited, and both want the same answer for the
// same garbage. One copy, so the two can never drift apart about what a file means.

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
export function readVoicing(raw: unknown): SegmentVoicing | undefined {
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

export function readBreak(raw: unknown): SegmentBreak | undefined {
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
