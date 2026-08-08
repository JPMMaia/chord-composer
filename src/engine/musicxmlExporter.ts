import type { Bar, ChordQuality, ChordSegment, Note, NoteName, Project, TimeSignature } from '@/types/music';
import {
  barChords,
  barNotes,
  getBarTimeSignature,
  timeSignatureBeats,
} from '@/engine/timeline';

/**
 * MusicXML divisions per quarter note. Eight divisions resolve down to a
 * thirty-second note, which matches the smallest grid the editor exposes
 * (`MIN_SEGMENT_BEATS`). Fewer would make `toDivisions` round the shortest blocks
 * up, and measures would stop summing to their own length.
 */
const DIVISIONS = 8;

// ---------------------------------------------------------------------------
// Pitch spelling
// ---------------------------------------------------------------------------

interface SpelledPitch {
  step: string;
  alter: number;
  octave: number;
}

/** Sharp spelling of the twelve pitch classes: [step, alter]. */
const SHARP_SPELLING: [string, number][] = [
  ['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0],
  ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0],
];

/** Flat spelling of the twelve pitch classes: [step, alter]. */
const FLAT_SPELLING: [string, number][] = [
  ['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0],
  ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0],
];

/**
 * Convert a MIDI pitch (0-127) to a MusicXML step/alter/octave triplet.
 * Flat keys (and C major / A minor) are spelled with flats, sharp keys with
 * sharps, so accidentals agree with the key signature.
 */
function midiToPitch(midi: number, useFlats: boolean): SpelledPitch {
  const table = useFlats ? FLAT_SPELLING : SHARP_SPELLING;
  const [step, alter] = table[((midi % 12) + 12) % 12];
  // A flat spelling borrows its letter from the step above, but the octave
  // number only changes at C, which is never spelled as a flat here.
  return { step, alter, octave: Math.floor(midi / 12) - 1 };
}

// ---------------------------------------------------------------------------
// Key signatures
// ---------------------------------------------------------------------------

/** Position on the circle of fifths for each major key. */
const MAJOR_FIFTHS: Record<NoteName, number> = {
  'C': 0, 'G': 1, 'D': 2, 'A': 3, 'E': 4, 'B': 5, 'F#': 6,
  'C#': 7, 'F': -1, 'A#': -2, 'D#': -3, 'G#': -4,
};

/** Position on the circle of fifths for each minor key. */
const MINOR_FIFTHS: Record<NoteName, number> = {
  'A': 0, 'E': 1, 'B': 2, 'F#': 3, 'C#': 4, 'G#': 5, 'D#': 6,
  'D': -1, 'G': -2, 'C': -3, 'F': -4, 'A#': -5,
};

/** Map a key name and mode to a MusicXML `fifths` value. */
function keyToFifths(key: NoteName, mode: 'major' | 'minor'): number {
  const table = mode === 'major' ? MAJOR_FIFTHS : MINOR_FIFTHS;
  return table[key] ?? 0;
}

// ---------------------------------------------------------------------------
// Chord kinds
// ---------------------------------------------------------------------------

/** Map an internal chord quality to a MusicXML `kind` value. */
const KIND_BY_QUALITY: Record<ChordQuality, string> = {
  major: 'major',
  minor: 'minor',
  diminished: 'diminished',
  augmented: 'augmented',
  sus2: 'suspended-second',
  sus4: 'suspended-fourth',
  dominant7: 'dominant',
  maj7: 'major-seventh',
  min7: 'minor-seventh',
  dim7: 'diminished-seventh',
  halfDim7: 'half-diminished',
  minMaj7: 'major-minor',
};

/** Split a note name into a MusicXML step plus alteration. */
function noteNameToStepAlter(note: NoteName): { step: string; alter: number } {
  return note.length > 1 ? { step: note[0], alter: 1 } : { step: note, alter: 0 };
}

// ---------------------------------------------------------------------------
// Note types
// ---------------------------------------------------------------------------

/** Note-type names by duration in quarter-note beats, longest first. */
const NOTE_TYPES: [beats: number, type: string][] = [
  [4, 'whole'],
  [2, 'half'],
  [1, 'quarter'],
  [0.5, 'eighth'],
  [0.25, '16th'],
  [0.125, '32nd'],
];

/**
 * Get the MusicXML note-type name that best fits a duration in beats.
 * Dotted and tied values are approximated by the nearest plain type.
 */
function getNoteType(beats: number): string {
  for (const [threshold, type] of NOTE_TYPES) {
    if (beats >= threshold) return type;
  }
  return '32nd';
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Convert a duration in beats to MusicXML divisions (minimum one division). */
function toDivisions(beats: number): number {
  return Math.max(1, Math.round(beats * DIVISIONS));
}

// ---------------------------------------------------------------------------
// Export: Project → MusicXML string
// ---------------------------------------------------------------------------

/**
 * Convert a Project to a MusicXML 4.0 `score-partwise` document.
 *
 * One `<part>` is written per track, one `<measure>` per bar. Chord segments
 * become `<harmony>` elements and notes become `<note>` elements; gaps between
 * notes are filled with rests so every measure adds up to its full length.
 */
export function projectToMusicXML(project: Project): string {
  const { name, bpm, timeSignature, key, keyMode, tracks, bars } = project;
  const fifths = keyToFifths(key, keyMode);
  const useFlats = fifths <= 0;

  const lines: string[] = [];

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  lines.push('<score-partwise version="4.0">');
  lines.push('  <work>');
  lines.push(`    <work-title>${escapeXml(name)}</work-title>`);
  lines.push('  </work>');
  lines.push('  <identification>');
  lines.push('    <encoding>');
  lines.push('      <software>Chord Composer</software>');
  lines.push('    </encoding>');
  lines.push('  </identification>');

  // Part list — one score-part per track.
  lines.push('  <part-list>');
  for (let t = 0; t < tracks.length; t++) {
    lines.push(`    <score-part id="P${t + 1}">`);
    lines.push(`      <part-name>${escapeXml(tracks[t].name)}</part-name>`);
    lines.push('    </score-part>');
  }
  lines.push('  </part-list>');

  for (let t = 0; t < tracks.length; t++) {
    lines.push(`  <part id="P${t + 1}">`);

    // A part needs at least one measure to be well-formed.
    const measures: Bar[] = bars.length > 0
      ? bars
      : [{ id: 'empty', barIndex: 0, content: {} }];

    // A measure restates the metre only when it differs from the one before it.
    let previousTs: TimeSignature | null = null;

    // Notes still sounding at the previous bar line, to be tied into this measure.
    let carried: CarriedNote[] = [];

    measures.forEach((bar, index) => {
      lines.push(`    <measure number="${index + 1}">`);

      const barTs = getBarTimeSignature(bar, timeSignature);
      const metreChanged =
        previousTs === null ||
        previousTs.beatsPerMeasure !== barTs.beatsPerMeasure ||
        previousTs.beatUnit !== barTs.beatUnit;
      previousTs = barTs;

      if (index === 0 || metreChanged) {
        lines.push('      <attributes>');
        if (index === 0) {
          lines.push(`        <divisions>${DIVISIONS}</divisions>`);
          lines.push('        <key>');
          lines.push(`          <fifths>${fifths}</fifths>`);
          lines.push(`          <mode>${keyMode}</mode>`);
          lines.push('        </key>');
        }
        if (metreChanged) {
          lines.push('        <time>');
          lines.push(`          <beats>${barTs.beatsPerMeasure}</beats>`);
          lines.push(`          <beat-type>${barTs.beatUnit}</beat-type>`);
          lines.push('        </time>');
        }
        if (index === 0) {
          lines.push('        <clef>');
          lines.push('          <sign>G</sign>');
          lines.push('          <line>2</line>');
          lines.push('        </clef>');
        }
        lines.push('      </attributes>');
      }

      if (index === 0) {
        lines.push('      <direction placement="above">');
        lines.push('        <direction-type>');
        lines.push('          <metronome>');
        lines.push('            <beat-unit>quarter</beat-unit>');
        lines.push(`            <per-minute>${bpm}</per-minute>`);
        lines.push('          </metronome>');
        lines.push('        </direction-type>');
        lines.push(`        <sound tempo="${bpm}"/>`);
        lines.push('      </direction>');
      }

      // Chord symbols are attached to the first part only; repeating them on
      // every staff would duplicate the harmony in notation software.
      if (t === 0) {
        for (const chord of barChords(bar, tracks[t].id)) {
          lines.push(...renderHarmony(chord));
        }
      }

      // Each part carries only its own instrument's notes. A note may outlast its
      // bar, so what is left sounding at the bar line is handed to the next measure
      // to be written as a tied continuation.
      const rendered = renderMeasureNotes(
        barNotes(bar, tracks[t].id),
        timeSignatureBeats(barTs),
        useFlats,
        carried
      );
      carried = rendered.carried;
      lines.push(...rendered.lines);

      lines.push('    </measure>');
    });

    lines.push('  </part>');
  }

  lines.push('</score-partwise>');

  return lines.join('\n');
}

/** Render a chord segment as a `<harmony>` element. */
function renderHarmony(chord: ChordSegment): string[] {
  const root = chord.root ?? (chord.chordSymbol?.[0] as NoteName | undefined);
  if (!root) return [];

  const quality: ChordQuality = chord.quality ?? 'major';
  const { step, alter } = noteNameToStepAlter(root);

  const lines: string[] = [];
  lines.push('      <harmony>');
  lines.push('        <root>');
  lines.push(`          <root-step>${step}</root-step>`);
  if (alter !== 0) {
    lines.push(`          <root-alter>${alter}</root-alter>`);
  }
  lines.push('        </root>');
  lines.push(`        <kind text="${escapeXml(quality)}">${KIND_BY_QUALITY[quality] ?? 'other'}</kind>`);
  lines.push('      </harmony>');
  return lines;
}

/**
 * How close two onsets must be to be written as one chord, in beats.
 *
 * Notation has no way to say "strummed": the voices of a rolled chord arrive a
 * few milliseconds apart, but the thing on the page is still a chord.
 *
 * This is measured from the *first* onset of a group, so it has to clear the widest
 * spread a whole chord can carry, not the gap between adjacent voices: four voices at
 * the inspector's widest strum put the last one 0.1875 beats late. That floors this
 * value above a thirty-second, so it can no longer track `MIN_SEGMENT_BEATS` the way
 * it did when the grid stopped at a sixteenth — hence the literal.
 *
 * Being wider than the shortest note, it cannot be the only test for a chord, or a
 * run of thirty-seconds would collapse into one. The overlap check at the call site
 * is what carries that distinction; this only bounds how far a strum may reach.
 */
export const CHORD_ONSET_TOLERANCE = 0.25;

/**
 * A note that was still sounding when the bar line arrived, waiting to be written
 * into the next measure as the far half of a tie.
 */
interface CarriedNote {
  pitch: number;
  /** Beats still to be written, measured from the start of the next measure. */
  beats: number;
}

/** What one measure produced: its markup, and whatever it left ringing. */
interface RenderedMeasure {
  lines: string[];
  carried: CarriedNote[];
}

/**
 * Render the notes of one bar, filling gaps and the tail of the measure with
 * rests. Notes that start together — or near enough — are written as one chord.
 *
 * A note may be longer than the measure has room for, because a segment on the
 * timeline is free to run past its bar line. Notation has no way to write a note
 * through a bar line, so such a note is cut at the line and tied to a continuation
 * in the next measure — which is what a musician reads as one held chord. `carried`
 * is that continuation arriving from the previous measure.
 */
function renderMeasureNotes(
  notes: Note[],
  measureBeats: number,
  useFlats: boolean,
  carried: CarriedNote[] = []
): RenderedMeasure {
  const lines: string[] = [];
  const carriedOut: CarriedNote[] = [];

  if (notes.length === 0 && carried.length === 0) {
    return { lines: renderMeasureRest(measureBeats), carried: carriedOut };
  }

  const sorted = [...notes].sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch);
  let cursor = 0;

  // The tie arriving from the previous bar sounds from the downbeat, so it is
  // written first and the measure's own notes queue up behind it.
  if (carried.length > 0) {
    const beats = Math.min(measureBeats, ...carried.map(c => c.beats));
    carried.forEach((note, index) => {
      const overruns = note.beats > beats;
      lines.push(
        ...renderNote(note.pitch, beats, index > 0, useFlats, { tieStop: true, tieStart: overruns })
      );
      if (overruns) carriedOut.push({ pitch: note.pitch, beats: note.beats - beats });
    });
    cursor = beats;
  }

  for (let i = 0; i < sorted.length; ) {
    const startBeat = sorted[i].startBeat;

    if (startBeat > cursor) {
      lines.push(...renderRest(startBeat - cursor));
      cursor = startBeat;
    }

    // Collect every note starting on this beat — they form one chord. Written
    // as a tolerance rather than an equality so a strummed chord notates as the
    // chord it is, instead of as a stack of hair-thin notes after a rest.
    //
    // Nearness alone is not enough to say "chord", because the tolerance has to be
    // wider than a whole strum is, which is wider than a thirty-second: a run of
    // thirty-seconds would be swallowed into chords by proximity. What separates the
    // two is that a strum's voices *sound together* — they overlap — whereas
    // successive notes of a rhythm only meet end to end. So a note joins the group
    // only if it begins before the group's first voice has finished.
    const firstEnd = startBeat + sorted[i].duration;
    const chordNotes: Note[] = [];
    while (
      i < sorted.length &&
      sorted[i].startBeat - startBeat < CHORD_ONSET_TOLERANCE &&
      (chordNotes.length === 0 || sorted[i].startBeat < firstEnd)
    ) {
      chordNotes.push(sorted[i]);
      i++;
    }

    // The chord advances the cursor by its shortest member so later notes
    // still line up; longer members are truncated rather than overlapping.
    // Measured from the group's own onset, so a strum's staggered releases do
    // not read as one voice being shorter than the rest.
    const sounded = Math.min(...chordNotes.map(n => n.startBeat + n.duration - startBeat));
    // …and by no more than the measure has left, whatever the chord's own length.
    const beats = Math.min(sounded, measureBeats - startBeat);
    if (beats <= 0) break;

    const overruns = sounded > beats;
    chordNotes.forEach((note, index) => {
      lines.push(...renderNote(note.pitch, beats, index > 0, useFlats, { tieStart: overruns }));
      if (overruns) carriedOut.push({ pitch: note.pitch, beats: sounded - beats });
    });
    cursor = startBeat + beats;
  }

  if (cursor < measureBeats) {
    lines.push(...renderRest(measureBeats - cursor));
  }

  return { lines, carried: carriedOut };
}

/** Which ends of a tie a note carries, if any. */
interface Ties {
  tieStart?: boolean;
  tieStop?: boolean;
}

/** Render a single `<note>` element. */
function renderNote(
  pitch: number,
  beats: number,
  isChordMember: boolean,
  useFlats: boolean,
  ties: Ties = {}
): string[] {
  const { step, alter, octave } = midiToPitch(pitch, useFlats);
  const lines: string[] = [];

  lines.push('      <note>');
  if (isChordMember) {
    lines.push('        <chord/>');
  }
  lines.push('        <pitch>');
  lines.push(`          <step>${step}</step>`);
  if (alter !== 0) {
    lines.push(`          <alter>${alter}</alter>`);
  }
  lines.push(`          <octave>${octave}</octave>`);
  lines.push('        </pitch>');
  lines.push(`        <duration>${toDivisions(beats)}</duration>`);
  // `<tie>` is the sounding instruction and `<tied>` below is the slur a reader
  // sees; MusicXML wants both, and the stop end always precedes the start.
  if (ties.tieStop) lines.push('        <tie type="stop"/>');
  if (ties.tieStart) lines.push('        <tie type="start"/>');
  lines.push('        <voice>1</voice>');
  lines.push(`        <type>${getNoteType(beats)}</type>`);
  if (alter !== 0) {
    lines.push(`        <accidental>${alter > 0 ? 'sharp' : 'flat'}</accidental>`);
  }
  if (ties.tieStop || ties.tieStart) {
    lines.push('        <notations>');
    if (ties.tieStop) lines.push('          <tied type="stop"/>');
    if (ties.tieStart) lines.push('          <tied type="start"/>');
    lines.push('        </notations>');
  }
  lines.push('      </note>');
  return lines;
}

/** Render a rest of the given length in beats. */
function renderRest(beats: number): string[] {
  return [
    '      <note>',
    '        <rest/>',
    `        <duration>${toDivisions(beats)}</duration>`,
    '        <voice>1</voice>',
    `        <type>${getNoteType(beats)}</type>`,
    '      </note>',
  ];
}

/** Render a whole-measure rest. */
function renderMeasureRest(beatsPerMeasure: number): string[] {
  return [
    '      <note>',
    '        <rest measure="yes"/>',
    `        <duration>${toDivisions(beatsPerMeasure)}</duration>`,
    '        <voice>1</voice>',
    '      </note>',
  ];
}
