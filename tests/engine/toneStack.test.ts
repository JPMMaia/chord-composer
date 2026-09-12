import { describe, it, expect } from 'vitest';
import {
  SCHEMA_VERSION,
  deserializeProject,
  serializeProject,
  validateProject,
} from '@/engine/fileIO';
import { PHRASE_TRACK_KEY } from '@/engine/phrases';
import { generateNotesFromSegments } from '@/engine/chordOperations';
import { CHORD_INTERVALS } from '@/engine/chords';
import { DEFAULT_TIME_SIGNATURE } from '@/utils/constants';
import type { Bar, ChordQuality, ChordSegment, Project, Scale } from '@/types/music';

/**
 * Schema 1.21: a block chooses how many notes it stacks.
 *
 * Two claims are worth a test. The first is that a stack survives a round trip. The
 * second, and the one that matters far more, is that a project which names no stack
 * is untouched by the feature existing — in what it sounds and in what it writes.
 */

const C_MAJOR: Scale = { root: 'C', type: 'major' };

function bar(chords: ChordSegment[]): Bar {
  return {
    id: 'bar-1',
    barIndex: 0,
    content: { [PHRASE_TRACK_KEY]: { chords, notes: [] } },
  };
}

function project(chords: ChordSegment[]): Project {
  return {
    id: 'p1',
    name: 'Stacks',
    bpm: 120,
    timeSignature: DEFAULT_TIME_SIGNATURE,
    key: 'C',
    keyMode: 'major',
    tracks: [
      {
        id: 'trk-1',
        name: 'Piano',
        instrument: 'acoustic_grand_piano',
        volume: 1,
        pan: 0,
        muted: false,
        solo: false,
      },
    ],
    phrases: [{ id: 'ph-1', name: 'A', bars: [bar(chords)] }],
    clips: [{ id: 'clip-1', phraseId: 'ph-1', trackId: 'trk-1', startBar: 0 }],
    bars: [],
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  };
}

function chord(overrides: Partial<ChordSegment> = {}): ChordSegment {
  return {
    id: 'seg-1',
    kind: 'chord',
    root: 'C',
    quality: 'major',
    romanNumeral: 'I',
    duration: 4,
    scale: C_MAJOR,
    ...overrides,
  };
}

/** The JSON a project is written as, as a plain object to read keys off. */
function written(chords: ChordSegment[]) {
  return JSON.parse(serializeProject(project(chords)));
}

/** One written segment, for the tests about what does and does not reach the file. */
function writtenSegment(chords: ChordSegment[]) {
  return written(chords).phrases[0].bars[0].content[PHRASE_TRACK_KEY].chords[0];
}

/** The segments a project comes back with, after a full write and read. */
function roundTrip(chords: ChordSegment[]): ChordSegment[] {
  const read = deserializeProject(serializeProject(project(chords)));
  return read.phrases[0].bars[0].content[PHRASE_TRACK_KEY].chords;
}

/** A written project, hand-edited the way a user with a text editor would. */
function tamper(chords: ChordSegment[], edit: (segment: Record<string, unknown>) => void) {
  const json = written(chords);
  edit(json.phrases[0].bars[0].content[PHRASE_TRACK_KEY].chords[0]);
  const read = deserializeProject(JSON.stringify(json));
  return read.phrases[0].bars[0].content[PHRASE_TRACK_KEY].chords[0];
}

/** What one segment sounds, as the piano roll would draw it. */
function pitchesOf(segment: ChordSegment): number[] {
  return generateNotesFromSegments([segment], bar([segment]), C_MAJOR, DEFAULT_TIME_SIGNATURE, 4)
    .map(n => n.pitch)
    .sort((a, b) => a - b);
}

describe('a stack in the project file', () => {
  it('states the current schema version', () => {
    expect(SCHEMA_VERSION).toBe('1.22');
  });

  it('round-trips a stack that names its own tones', () => {
    const [read] = roundTrip([chord({ tones: [0, 2] })]);
    expect(read.tones).toEqual([0, 2]);
  });

  it('round-trips a ninth, which no quality can name', () => {
    const [read] = roundTrip([chord({ quality: 'maj7', tones: [0, 1, 2, 3, 4] })]);
    expect(read.tones).toEqual([0, 1, 2, 3, 4]);
    expect(pitchesOf(read)).toEqual([60, 64, 67, 71, 74]);
  });

  it('round-trips a pinned quality', () => {
    const [read] = roundTrip([chord({ qualityPinned: true })]);
    expect(read.qualityPinned).toBe(true);
  });

  it('leaves an unpinned quality unmarked, rather than writing false', () => {
    expect(writtenSegment([chord()]).qualityPinned).toBeUndefined();
  });
});

describe('a project nobody has restacked', () => {
  // The compatibility claim, stated the way 1.19 and 1.20 state theirs: a block that
  // sounds every tone of its quality writes no stack, so the file is byte for byte
  // the one 1.20 wrote and goes on meaning the same thing to an older build.
  it('writes no stack when the tones are simply the quality', () => {
    expect(writtenSegment([chord({ tones: [0, 1, 2] })]).tones).toBeUndefined();
    expect(
      writtenSegment([chord({ quality: 'dominant7', tones: [0, 1, 2, 3] })]).tones
    ).toBeUndefined();
  });

  it('serialises exactly as it did before stacks existed', () => {
    expect(serializeProject(project([chord({ tones: [0, 1, 2] })]))).toBe(
      serializeProject(project([chord()]))
    );
  });

  it('sounds every quality exactly as its intervals say, with no stack named', () => {
    // The load-bearing guarantee: a pre-1.21 file names no tones, so every chord in
    // it has to come back the triad or seventh its quality already named.
    for (const quality of Object.keys(CHORD_INTERVALS) as ChordQuality[]) {
      const [read] = roundTrip([chord({ quality, romanNumeral: undefined })]);
      expect(read.tones).toBeUndefined();
      expect(pitchesOf(read)).toEqual(CHORD_INTERVALS[quality].map(i => 60 + i));
    }
  });
});

describe('a hand-edited stack', () => {
  it('keeps only the tones this app has a name for', () => {
    const read = tamper([chord()], s => {
      s.tones = [4, 9, 'x', -1, 1, 1];
    });
    expect(read.tones).toEqual([0, 1, 4]);
  });

  it('reads an empty stack as no stack at all', () => {
    expect(tamper([chord()], s => { s.tones = []; }).tones).toBeUndefined();
  });

  it('is rejected by validation when it names no chord tone', () => {
    const invalid = project([chord({ tones: [7] })]);
    const result = validateProject(invalid);

    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('invalid tones');
  });

  it('passes validation when every tone is one the app can voice', () => {
    expect(validateProject(project([chord({ tones: [0, 2, 4] })])).valid).toBe(true);
  });
});
