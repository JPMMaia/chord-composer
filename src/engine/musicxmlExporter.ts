import type { Bar, ChordQuality, ChordSegment, Note, NoteName, Project } from '@/types/music';

/**
 * MusicXML divisions per quarter note. Four divisions resolve down to a
 * sixteenth note, which matches the smallest grid the editor exposes.
 */
const DIVISIONS = 4;

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
  const beatsPerMeasure = timeSignature.beatsPerMeasure;

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
      : [{ id: 'empty', barIndex: 0, scale: { root: key, type: 'major' }, chords: [], notes: [] }];

    measures.forEach((bar, index) => {
      lines.push(`    <measure number="${index + 1}">`);

      if (index === 0) {
        lines.push('      <attributes>');
        lines.push(`        <divisions>${DIVISIONS}</divisions>`);
        lines.push('        <key>');
        lines.push(`          <fifths>${fifths}</fifths>`);
        lines.push(`          <mode>${keyMode}</mode>`);
        lines.push('        </key>');
        lines.push('        <time>');
        lines.push(`          <beats>${timeSignature.beatsPerMeasure}</beats>`);
        lines.push(`          <beat-type>${timeSignature.beatUnit}</beat-type>`);
        lines.push('        </time>');
        lines.push('        <clef>');
        lines.push('          <sign>G</sign>');
        lines.push('          <line>2</line>');
        lines.push('        </clef>');
        lines.push('      </attributes>');

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
        for (const chord of bar.chords) {
          lines.push(...renderHarmony(chord));
        }
      }

      lines.push(...renderMeasureNotes(bar.notes, beatsPerMeasure, useFlats));

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
 * Render the notes of one bar, filling gaps and the tail of the measure with
 * rests. Notes that start on the same beat are written as a single chord.
 */
function renderMeasureNotes(notes: Note[], beatsPerMeasure: number, useFlats: boolean): string[] {
  const lines: string[] = [];

  if (notes.length === 0) {
    return renderMeasureRest(beatsPerMeasure);
  }

  const sorted = [...notes].sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch);
  let cursor = 0;

  for (let i = 0; i < sorted.length; ) {
    const startBeat = sorted[i].startBeat;

    if (startBeat > cursor) {
      lines.push(...renderRest(startBeat - cursor));
      cursor = startBeat;
    }

    // Collect every note starting on this beat — they form one chord.
    const chordNotes: Note[] = [];
    while (i < sorted.length && sorted[i].startBeat === startBeat) {
      chordNotes.push(sorted[i]);
      i++;
    }

    // The chord advances the cursor by its shortest member so later notes
    // still line up; longer members are truncated rather than overlapping.
    const beats = Math.min(...chordNotes.map(n => n.duration));
    chordNotes.forEach((note, index) => {
      lines.push(...renderNote(note, beats, index > 0, useFlats));
    });
    cursor = startBeat + beats;
  }

  if (cursor < beatsPerMeasure) {
    lines.push(...renderRest(beatsPerMeasure - cursor));
  }

  return lines;
}

/** Render a single `<note>` element. */
function renderNote(note: Note, beats: number, isChordMember: boolean, useFlats: boolean): string[] {
  const { step, alter, octave } = midiToPitch(note.pitch, useFlats);
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
  lines.push('        <voice>1</voice>');
  lines.push(`        <type>${getNoteType(beats)}</type>`);
  if (alter !== 0) {
    lines.push(`        <accidental>${alter > 0 ? 'sharp' : 'flat'}</accidental>`);
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
