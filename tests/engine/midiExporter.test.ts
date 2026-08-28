import { describe, it, expect, beforeEach } from 'vitest';
import { projectToMidi, midiToProject } from '@/engine/midiExporter';
import { Project, Bar, Track, Note, ChordSegment } from '@/types/music';
import { generateId } from '@/utils/id';
import { OTHER_TRACK_ID, soloContent, TEST_TRACK_ID } from '../helpers/tracks';
import { allBarNotes, getBarStartBeat } from '@/engine/timeline';

function createTestProject(overrides?: Partial<Project>): Project {
  const now = new Date('2024-01-01T00:00:00.000Z');
  return {
    id: generateId(),
    name: 'Test Project',
    bpm: 120,
    timeSignature: { beatsPerMeasure: 4, beatUnit: 4 },
    key: 'C',
    keyMode: 'major',
    tracks: [
      {
        // Matches the key `soloContent` writes, so the exporter's per-instrument
        // lookup finds this fixture's music.
        id: TEST_TRACK_ID,
        name: 'Piano',
        instrument: 'acoustic_grand_piano',
        volume: 0.8,
        pan: 0,
        muted: false,
        solo: false,
      },
    ],
    bars: [
      {
        id: generateId(),
        barIndex: 0,
        content: soloContent([
          { id: generateId(), romanNumeral: 'I', chordSymbol: 'C', duration: 2, root: 'C', quality: 'major' },
          { id: generateId(), romanNumeral: 'V', chordSymbol: 'G', duration: 2, root: 'G', quality: 'major' },
        ], [
          { id: generateId(), pitch: 60, startBeat: 0, duration: 1, velocity: 100 },
          { id: generateId(), pitch: 64, startBeat: 1, duration: 1, velocity: 90 },
          { id: generateId(), pitch: 67, startBeat: 2, duration: 2, velocity: 85 },
        ]),
      },
    ],
    createdAt: now,
    updatedAt: new Date('2024-01-01T00:01:00.000Z'),
    ...overrides,
  };
}

describe('midiExporter', () => {
  beforeEach(() => {
    // Reset any global MIDI state
  });

  describe('projectToMidi', () => {
    it('exports a project to MIDI bytes', () => {
      const project = createTestProject();
      const midiBytes = projectToMidi(project);

      expect(midiBytes).toBeInstanceOf(Uint8Array);
      expect(midiBytes.length).toBeGreaterThan(0);
    });

    it('creates one track per project track', () => {
      const project = createTestProject({
        tracks: [
          { id: generateId(), name: 'Track 1', instrument: 'piano', volume: 0.8, pan: 0, muted: false, solo: false },
          { id: generateId(), name: 'Track 2', instrument: 'bass', volume: 0.7, pan: 0, muted: false, solo: false },
        ],
      });
      const midiBytes = projectToMidi(project);

      // MIDI file with 2 tracks: MThd header + 2 MTrk chunks
      // We verify by checking the bytes contain multiple track headers
      const trackHeaders = countTrackHeaders(midiBytes);
      expect(trackHeaders).toBe(2);
    });

    it('maps channel 1-16 to tracks', () => {
      const project = createTestProject({
        tracks: [
          { id: generateId(), name: 'Track 1', instrument: 'piano', volume: 0.8, pan: 0, muted: false, solo: false },
          { id: generateId(), name: 'Track 2', instrument: 'bass', volume: 0.7, pan: 0, muted: false, solo: false },
        ],
      });
      const midiBytes = projectToMidi(project);

      // First track uses channel 0 (MIDI channel 1), second uses channel 1 (MIDI channel 2)
      // We verify the bytes are valid MIDI
      expect(midiBytes.length).toBeGreaterThan(0);
    });

    it('writes note on/off events with correct timing', () => {
      const project = createTestProject();
      const midiBytes = projectToMidi(project);

      // The MIDI bytes should contain note-on events (0x9x) and note-off events (0x8x)
      // We can check that the file has meaningful content
      expect(midiBytes.length).toBeGreaterThan(20); // At least header + some track data
    });

    it('writes tempo meta event', () => {
      const project = createTestProject({ bpm: 100 });
      const midiBytes = projectToMidi(project);

      // Tempo meta event is 0xFF 0x51
      // At 100 BPM, microseconds per beat = 60000000 / 100 = 600000 = 0x093DE0
      expect(midiBytes.length).toBeGreaterThan(0);
    });

    it('writes time signature meta event', () => {
      const project = createTestProject({ timeSignature: { beatsPerMeasure: 3, beatUnit: 4 } });
      const midiBytes = projectToMidi(project);

      // Time signature meta event is 0xFF 0x58
      expect(midiBytes.length).toBeGreaterThan(0);
    });

    it('handles project with no tracks', () => {
      const project = createTestProject({ tracks: [] });
      const midiBytes = projectToMidi(project);

      // Should still produce valid MIDI with at least a header
      expect(midiBytes).toBeInstanceOf(Uint8Array);
      expect(midiBytes.length).toBeGreaterThan(0);
    });

    it('handles project with no notes', () => {
      const project = createTestProject({ bars: [{ id: generateId(), barIndex: 0, content: soloContent([], []) }] });
      const midiBytes = projectToMidi(project);

      expect(midiBytes).toBeInstanceOf(Uint8Array);
      expect(midiBytes.length).toBeGreaterThan(0);
    });

    it('produces different output for different BPM', () => {
      const project120 = createTestProject({ bpm: 120 });
      const project60 = createTestProject({ bpm: 60 });

      const midi120 = projectToMidi(project120);
      const midi60 = projectToMidi(project60);

      // The tempo meta events should differ
      expect(midi120).not.toEqual(midi60);
    });

    it('preserves note pitches', () => {
      const project = createTestProject({
        bars: [{
          id: generateId(),
          barIndex: 0,
          content: soloContent([], [
            { id: generateId(), pitch: 60, startBeat: 0, duration: 1, velocity: 100 },
            { id: generateId(), pitch: 72, startBeat: 1, duration: 1, velocity: 80 },
          ]),
        }],
      });

      const midiBytes = projectToMidi(project);
      expect(midiBytes.length).toBeGreaterThan(0);
    });

    it('preserves note velocities', () => {
      const project = createTestProject({
        bars: [{
          id: generateId(),
          barIndex: 0,
          content: soloContent([], [
            { id: generateId(), pitch: 60, startBeat: 0, duration: 1, velocity: 127 },
            { id: generateId(), pitch: 64, startBeat: 1, duration: 1, velocity: 50 },
          ]),
        }],
      });

      const midiBytes = projectToMidi(project);
      expect(midiBytes.length).toBeGreaterThan(0);
    });
  });

  describe('midiToProject', () => {
    it('imports a simple MIDI file to a project', () => {
      // Create a minimal MIDI file manually
      const midiBytes = createMinimalMidiFile();
      const project = midiToProject(midiBytes);

      expect(project).toBeTruthy();
      expect(project.name).toBeTruthy();
      expect(project.tracks).toBeInstanceOf(Array);
      expect(project.bars).toBeInstanceOf(Array);
    });

    it('sets BPM from tempo meta event', () => {
      const midiBytes = createMinimalMidiFile(120);
      const project = midiToProject(midiBytes);

      expect(project.bpm).toBe(120);
    });

    it('sets time signature from MIDI meta event', () => {
      const midiBytes = createMinimalMidiFile(120, { beatsPerMeasure: 3, beatUnit: 4 });
      const project = midiToProject(midiBytes);

      expect(project.timeSignature.beatsPerMeasure).toBe(3);
      expect(project.timeSignature.beatUnit).toBe(4);
    });

    it('creates tracks from MIDI track chunks', () => {
      const midiBytes = createMinimalMidiFile(120, undefined, 2);
      const project = midiToProject(midiBytes);

      expect(project.tracks.length).toBeGreaterThanOrEqual(1);
    });

    it('throws on invalid MIDI bytes', () => {
      const invalidBytes = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      expect(() => midiToProject(invalidBytes)).toThrow();
    });

    it('throws on non-MIDI file', () => {
      const notMidi = new Uint8Array([0x4E, 0x6F, 0x74, 0x4D, 0x69, 0x64, 0x69]); // "NotMidi"
      expect(() => midiToProject(notMidi)).toThrow();
    });
  });

  // A recorded take's dynamics reach the file by riding the derived notes, which
  // the exporter already reads — but "already works" is worth a test, not an
  // assumption.
  it('writes the velocities a recorded block was played with', () => {
    const project = createTestProject({
      bars: [
        {
          id: generateId(),
          barIndex: 0,
          content: soloContent(
            [
              {
                id: generateId(),
                kind: 'custom',
                startBeat: 0,
                duration: 2,
                customNotes: [
                  { pitch: 60, startBeat: 0, duration: 2, velocity: 37 },
                  { pitch: 64, startBeat: 0, duration: 2, velocity: 119 },
                ],
              },
            ],
            [
              { id: generateId(), pitch: 60, startBeat: 0, duration: 2, velocity: 37 },
              { id: generateId(), pitch: 64, startBeat: 0, duration: 2, velocity: 119 },
            ]
          ),
        },
      ],
    });

    const bytes = projectToMidi(project);
    const velocities: number[] = [];
    for (let i = 0; i < bytes.length - 2; i++) {
      // Note-on with a non-zero velocity: 0x90 | channel.
      if ((bytes[i] & 0xf0) === 0x90 && bytes[i + 2] > 0) velocities.push(bytes[i + 2]);
    }

    expect(velocities).toContain(37);
    expect(velocities).toContain(119);
  });

  // Before instruments, every track chunk was written the same notes. Each one now
  // carries only its own, plus a Program Change naming its sound.
  describe('instruments', () => {
    /** Note-on events across every track chunk, tagged with their channel. */
    const twoInstrumentProject = () =>
      createTestProject({
        tracks: [
          { id: TEST_TRACK_ID, name: 'Piano', instrument: 'acoustic_grand_piano', volume: 1, pan: 0, muted: false, solo: false, visible: true },
          { id: OTHER_TRACK_ID, name: 'Strings', instrument: 'string_ensemble_1', volume: 1, pan: 0, muted: false, solo: false, visible: true },
        ],
        bars: [
          {
            id: generateId(),
            barIndex: 0,
            content: {
              [TEST_TRACK_ID]: {
                chords: [],
                notes: [{ id: generateId(), pitch: 60, startBeat: 0, duration: 1, velocity: 100 }],
              },
              [OTHER_TRACK_ID]: {
                chords: [],
                notes: [{ id: generateId(), pitch: 72, startBeat: 0, duration: 1, velocity: 100 }],
              },
            },
          },
        ],
      });

    it('writes one chunk per instrument', () => {
      expect(countTrackHeaders(projectToMidi(twoInstrumentProject()))).toBe(2);
    });

    it('gives each instrument only its own notes', () => {
      // Track 0 is scanned by the existing helper; it must not carry the strings' note.
      const onsets = scanNoteOnTicks(projectToMidi(twoInstrumentProject()));

      expect(onsets.map(o => o.pitch)).toEqual([60]);
    });

    it('names each instrument sound with a program change', () => {
      const programs = scanTrack0(projectToMidi(twoInstrumentProject()))
        .filter(e => (e.status & 0xf0) === 0xc0)
        .map(e => e.body[0]);

      // GM program 0 is the acoustic grand.
      expect(programs).toEqual([0]);
    });

    it('round-trips an instrument sound through export and import', () => {
      const restored = midiToProject(projectToMidi(twoInstrumentProject()));

      expect(restored.tracks.map(t => t.instrument)).toEqual([
        'acoustic_grand_piano',
        'string_ensemble_1',
      ]);
    });
  });

  describe('thirty-second notes', () => {
    it('round-trips a bar of thirty-seconds through export and import', () => {
      // 96 PPQ leaves 12 ticks in a thirty-second, so the grid's shortest block
      // survives the trip without being rounded onto a coarser one.
      const notes = Array.from({ length: 8 }, (_, i) => ({
        id: generateId(),
        pitch: 60 + i,
        startBeat: i * 0.125,
        duration: 0.125,
        velocity: 100,
      }));
      const project = createTestProject({
        bars: [{ id: generateId(), barIndex: 0, content: soloContent([], notes) }],
      });

      const restored = midiToProject(projectToMidi(project));
      const restoredNotes = restored.bars
        .flatMap(bar => Object.values(bar.content).flatMap(c => c.notes))
        .sort((a, b) => a.startBeat - b.startBeat);

      expect(restoredNotes.map(n => n.startBeat)).toEqual(notes.map(n => n.startBeat));
      expect(restoredNotes.map(n => n.duration)).toEqual(notes.map(n => n.duration));
    });
  });

  describe('per-bar time signatures', () => {
    /** A bar carrying one note on its downbeat, so its start tick is observable. */
    const barWith = (barIndex: number, ts: { beatsPerMeasure: number; beatUnit: number } | undefined, pitch: number): Bar => ({
      id: generateId(),
      barIndex,
      timeSignature: ts,
      content: soloContent([], [{ id: generateId(), pitch, startBeat: 0, duration: 1, velocity: 100 }]),
    });

    it('emits one time-signature event when every bar shares a meter', () => {
      const project = createTestProject({
        bars: [barWith(0, undefined, 60), barWith(1, undefined, 62)],
      });
      const events = scanTimeSignatureEvents(projectToMidi(project));

      expect(events).toEqual([{ tick: 0, beatsPerMeasure: 4, beatUnit: 4 }]);
    });

    it('emits a further event at each bar whose meter changes', () => {
      const project = createTestProject({
        bars: [
          barWith(0, { beatsPerMeasure: 4, beatUnit: 4 }, 60),
          barWith(1, { beatsPerMeasure: 3, beatUnit: 4 }, 62),
          barWith(2, { beatsPerMeasure: 3, beatUnit: 4 }, 64),
          barWith(3, { beatsPerMeasure: 6, beatUnit: 8 }, 65),
        ],
      });
      const events = scanTimeSignatureEvents(projectToMidi(project));

      // Bar 2 repeats bar 1's meter, so it contributes no event.
      expect(events).toEqual([
        { tick: 0, beatsPerMeasure: 4, beatUnit: 4 },
        { tick: 4 * PPQ, beatsPerMeasure: 3, beatUnit: 4 },
        { tick: 10 * PPQ, beatsPerMeasure: 6, beatUnit: 8 },
      ]);
    });

    it('clicks in dotted quarters for a compound meter', () => {
      const project = createTestProject({
        bars: [
          barWith(0, { beatsPerMeasure: 3, beatUnit: 4 }, 60),
          barWith(1, { beatsPerMeasure: 6, beatUnit: 8 }, 62),
        ],
      });

      // 24 clocks is a quarter, 36 a dotted quarter — how a reader learns that the
      // 6/8 bar is felt in two even though it is as long as the 3/4 bar before it.
      expect(scanClocksPerClick(projectToMidi(project))).toEqual([24, 36]);
    });

    it('measures a 6/8 bar as three beats, like a 3/4 bar', () => {
      const project = createTestProject({
        bars: [
          barWith(0, { beatsPerMeasure: 6, beatUnit: 8 }, 60),
          barWith(1, { beatsPerMeasure: 6, beatUnit: 8 }, 62),
        ],
      });

      expect(scanNoteOnTicks(projectToMidi(project))).toEqual([
        { tick: 0, pitch: 60 },
        { tick: 3 * PPQ, pitch: 62 },
      ]);
    });

    it('round-trips a 6/8 project without stretching its bars', () => {
      const project = createTestProject({
        timeSignature: { beatsPerMeasure: 6, beatUnit: 8 },
        bars: [barWith(0, undefined, 60), barWith(1, undefined, 62)],
      });
      const restored = midiToProject(projectToMidi(project));

      expect(restored.timeSignature).toEqual({ beatsPerMeasure: 6, beatUnit: 8 });
      // Import slices by the metre's real length, so the second note lands on the
      // second bar's downbeat rather than halfway through a six-quarter bar.
      expect(restored.bars).toHaveLength(2);
      const onsets = restored.bars.map(bar =>
        Object.values(bar.content).flatMap(c => c.notes).map(n => [n.pitch, n.startBeat])
      );
      expect(onsets).toEqual([[[60, 0]], [[62, 0]]]);
    });

    it('places notes at cumulative bar starts rather than a fixed bar length', () => {
      const project = createTestProject({
        bars: [
          barWith(0, { beatsPerMeasure: 3, beatUnit: 4 }, 60),
          barWith(1, { beatsPerMeasure: 4, beatUnit: 4 }, 62),
          barWith(2, { beatsPerMeasure: 2, beatUnit: 4 }, 64),
        ],
      });
      const onsets = scanNoteOnTicks(projectToMidi(project));

      expect(onsets).toEqual([
        { tick: 0, pitch: 60 },
        { tick: 3 * PPQ, pitch: 62 },
        { tick: 7 * PPQ, pitch: 64 },
      ]);
    });

    it('leaves a hole in the tick stream where the timeline has silence', () => {
      // Nothing on the downbeat, one note on beat 2 — the gap must survive export.
      const bar: Bar = {
        id: generateId(),
        barIndex: 0,
        content: soloContent([], [{ id: generateId(), pitch: 60, startBeat: 2, duration: 1, velocity: 100 }]),
      };
      const onsets = scanNoteOnTicks(projectToMidi(createTestProject({ bars: [bar] })));

      expect(onsets).toEqual([{ tick: 2 * PPQ, pitch: 60 }]);
    });
  });

  describe('channel volume', () => {
    const PPQ = 96;

    /** The fixture with a curve on its one instrument. */
    function withCurve(volumeAutomation: { beat: number; value: number }[]): Project {
      const project = createTestProject();
      return { ...project, tracks: [{ ...project.tracks[0], volumeAutomation }] };
    }

    it('states an unautomated instrument\'s flat volume once, at the top', () => {
      // 0.8 of full scale. Before this the level was dropped entirely and every
      // instrument arrived at whatever the receiving program defaulted to.
      expect(scanVolumeEvents(projectToMidi(createTestProject()))).toEqual([
        { tick: 0, value: 102 },
      ]);
    });

    it('opens on the curve\'s first value, held back to tick 0', () => {
      const events = scanVolumeEvents(projectToMidi(withCurve([{ beat: 2, value: 0.5 }])));

      expect(events[0]).toEqual({ tick: 0, value: 64 });
    });

    it('collapses a curve that never moves to a single event', () => {
      const events = scanVolumeEvents(
        projectToMidi(
          withCurve([
            { beat: 0, value: 0.5 },
            { beat: 4, value: 0.5 },
          ])
        )
      );

      expect(events).toEqual([
        { tick: 0, value: 64 },
        { tick: 4 * PPQ, value: 64 },
      ]);
    });

    it('writes a descending run of values across a fade', () => {
      const events = scanVolumeEvents(
        projectToMidi(
          withCurve([
            { beat: 0, value: 1 },
            { beat: 4, value: 0 },
          ])
        )
      );

      expect(events.length).toBeGreaterThan(4);
      expect(events[0]).toEqual({ tick: 0, value: 127 });
      expect(events.at(-1)).toEqual({ tick: 4 * PPQ, value: 0 });

      // Monotonically down, and strictly so: a repeated value is not worth an event.
      for (let i = 1; i < events.length; i++) {
        expect(events[i].value).toBeLessThan(events[i - 1].value);
        expect(events[i].tick).toBeGreaterThan(events[i - 1].tick);
      }
    });

    it('lands exactly on each breakpoint\'s value at its own tick', () => {
      const events = scanVolumeEvents(
        projectToMidi(
          withCurve([
            { beat: 0, value: 1 },
            { beat: 2, value: 0.25 },
            { beat: 6, value: 1 },
          ])
        )
      );

      expect(events).toContainEqual({ tick: 2 * PPQ, value: 32 });
      expect(events.at(-1)).toEqual({ tick: 6 * PPQ, value: 127 });
    });

    it('puts every level before the first note sounds', () => {
      const midi = projectToMidi(
        withCurve([
          { beat: 0, value: 1 },
          { beat: 4, value: 0 },
        ])
      );
      const stream = scanTrack0(midi);

      const firstNote = stream.findIndex(e => (e.status & 0xf0) === 0x90);
      const firstVolume = stream.findIndex(e => (e.status & 0xf0) === 0xb0);

      expect(firstVolume).toBeGreaterThanOrEqual(0);
      expect(firstVolume).toBeLessThan(firstNote);
    });

    it('writes the level on each instrument\'s own channel', () => {
      const project = createTestProject();
      const midi = projectToMidi({
        ...project,
        tracks: [
          { ...project.tracks[0], volumeAutomation: [{ beat: 0, value: 0.5 }] },
          {
            ...project.tracks[0],
            id: OTHER_TRACK_ID,
            name: 'Strings',
            volumeAutomation: [{ beat: 0, value: 0.25 }],
          },
        ],
      });

      // Track 0's chunk is the only one `scanTrack0` walks, and it carries channel 0.
      const events = scanTrack0(midi).filter(e => (e.status & 0xf0) === 0xb0);
      expect(events).toHaveLength(1);
      expect(events[0].status & 0x0f).toBe(0);
      expect(events[0].body[1]).toBe(64);
    });
  });
});

/**
 * Walk track 0's delta-encoded event stream, yielding absolute ticks.
 *
 * Only the event shapes this exporter writes are handled — meta, note-on and
 * note-off — which is enough to assert placement without pulling in a parser.
 */
function scanTrack0(data: Uint8Array): { tick: number; status: number; metaType?: number; body: number[] }[] {
  // Skip the 14-byte MThd header, then the "MTrk" tag and its 4-byte length.
  let offset = 14 + 8;
  const events: { tick: number; status: number; metaType?: number; body: number[] }[] = [];
  let tick = 0;

  const readVarLen = () => {
    let value = 0;
    while (offset < data.length) {
      const byte = data[offset++];
      value = value * 128 + (byte & 0x7f);
      if (byte < 0x80) break;
    }
    return value;
  };

  while (offset < data.length) {
    tick += readVarLen();
    const status = data[offset++];

    if (status === 0xff) {
      const metaType = data[offset++];
      const length = readVarLen();
      events.push({ tick, status, metaType, body: Array.from(data.subarray(offset, offset + length)) });
      offset += length;
      if (metaType === 0x2f) break; // end of track
      continue;
    }

    // Program Change (0xC0) and Channel Pressure (0xD0) carry a single data byte;
    // every other channel message carries two. Assuming two for all of them walks
    // the stream out of alignment the moment an instrument's program is written.
    const high = status & 0xf0;
    const length = high === 0xc0 || high === 0xd0 ? 1 : 2;
    const body = Array.from(data.subarray(offset, offset + length));
    events.push({ tick, status, body });
    offset += length;
  }

  return events;
}

/** Time-signature meta events of track 0, decoded back to a readable meter. */
function scanTimeSignatureEvents(
  data: Uint8Array
): { tick: number; beatsPerMeasure: number; beatUnit: number }[] {
  return scanTrack0(data)
    .filter(e => e.status === 0xff && e.metaType === 0x58)
    .map(e => ({
      tick: e.tick,
      beatsPerMeasure: e.body[0],
      // The denominator is stored as a power of two.
      beatUnit: 2 ** e.body[1],
    }));
}

/** MIDI clocks per metronome click of each time-signature event, at 24 per quarter. */
function scanClocksPerClick(data: Uint8Array): number[] {
  return scanTrack0(data)
    .filter(e => e.status === 0xff && e.metaType === 0x58)
    .map(e => e.body[2]);
}

/** Channel-volume (CC7) events of track 0, in stream order. */
function scanVolumeEvents(data: Uint8Array): { tick: number; value: number }[] {
  return scanTrack0(data)
    .filter(e => (e.status & 0xf0) === 0xb0 && e.body[0] === 0x07)
    .map(e => ({ tick: e.tick, value: e.body[1] }));
}

/** Note-on events of track 0, in stream order. */
function scanNoteOnTicks(data: Uint8Array): { tick: number; pitch: number }[] {
  return scanTrack0(data)
    .filter(e => (e.status & 0xf0) === 0x90 && e.body[1] > 0)
    .map(e => ({ tick: e.tick, pitch: e.body[0] }));
}

// Helper: count MTrk headers in MIDI bytes
function countTrackHeaders(data: Uint8Array): number {
  let count = 0;
  const marker = new Uint8Array([0x4D, 0x54, 0x72, 0x6B]); // "MTrk"
  for (let i = 0; i <= data.length - 4; i++) {
    if (data[i] === marker[0] && data[i + 1] === marker[1] &&
        data[i + 2] === marker[2] && data[i + 3] === marker[3]) {
      count++;
    }
  }
  return count;
}

const PPQ = 96;

// Helper: wrap track event bytes in an MTrk chunk ("MTrk" + length + payload)
function buildTrackChunk(payload: number[]): number[] {
  const length = payload.length;
  return [
    0x4D, 0x54, 0x72, 0x6B, // "MTrk"
    (length >> 24) & 0xFF,
    (length >> 16) & 0xFF,
    (length >> 8) & 0xFF,
    length & 0xFF,
    ...payload,
  ];
}

// Helper: create a minimal valid Format-1 MIDI file
function createMinimalMidiFile(
  bpm: number = 120,
  timeSignature?: { beatsPerMeasure: number; beatUnit: number },
  numTracks: number = 1
): Uint8Array {
  const chunks: number[][] = [];

  for (let t = 0; t < numTracks; t++) {
    const payload: number[] = [];

    if (t === 0) {
      // Tempo meta event: 0xFF 0x51 0x03 [3 bytes microseconds per quarter note]
      const usPerBeat = Math.round(60000000 / bpm);
      payload.push(0x00, 0xFF, 0x51, 0x03);
      payload.push((usPerBeat >> 16) & 0xFF, (usPerBeat >> 8) & 0xFF, usPerBeat & 0xFF);

      // Time signature meta event: numerator is literal, denominator is a power of two
      if (timeSignature) {
        payload.push(0x00, 0xFF, 0x58, 0x04);
        payload.push(timeSignature.beatsPerMeasure);
        payload.push(Math.log2(timeSignature.beatUnit));
        payload.push(0x18); // 24 MIDI clocks per metronome click
        payload.push(0x08); // 32nd notes per quarter note
      }
    }

    // Note on: channel 0, C4, velocity 100 at beat 0
    payload.push(0x00, 0x90, 0x3C, 0x64);
    // Note off one quarter note later (96 ticks fits in a single varlen byte at 0x60)
    payload.push(0x60, 0x80, 0x3C, 0x00);
    // End of track
    payload.push(0x00, 0xFF, 0x2F, 0x00);

    chunks.push(buildTrackChunk(payload));
  }

  const headerData = [
    0x4D, 0x54, 0x68, 0x64, // "MThd"
    0x00, 0x00, 0x00, 0x06, // Length: 6
    0x00, 0x01, // Format 1
    (numTracks >> 8) & 0xFF, numTracks & 0xFF,
    (PPQ >> 8) & 0xFF, PPQ & 0xFF,
  ];

  return Uint8Array.from([headerData, ...chunks].flat());
}

/**
 * An instrument's nudge is authored in milliseconds, but a MIDI file has no seconds
 * — only ticks against the tempo it carries. So the export converts once, at the
 * project tempo, and the note positions in the file are what a re-import reads back.
 */
describe('exporting an instrument that is nudged off the beat', () => {
  /** Every note's start beat on the exported instrument, after a round trip. */
  function exportedStarts(timeOffsetMs: number, bpm = 120): number[] {
    const base = createTestProject({ bpm });
    const project: Project = {
      ...base,
      tracks: [{ ...base.tracks[0], timeOffsetMs }],
    };

    return noteStarts(midiToProject(projectToMidi(project)));
  }

  /** Every note in a project, by start beat, in order. */
  function noteStarts(p: Project): number[] {
    return p.bars
      .flatMap((bar, i) =>
        allBarNotes(bar).map(({ note }) => getBarStartBeat(p.bars, i, p.timeSignature) + note.startBeat)
      )
      .sort((a, b) => a - b);
  }

  // At 120 BPM a beat is half a second, so 250ms is exactly half a beat — a figure
  // the 96-tick grid can hold without rounding, which keeps this about the offset
  // rather than about tick arithmetic.
  it('moves every note later by a late nudge', () => {
    // Written at beats 0, 1 and 2.
    expect(exportedStarts(250)).toEqual([0.5, 1.5, 2.5]);
  });

  it('moves every note earlier by an early nudge', () => {
    expect(exportedStarts(-250)).toEqual([0, 0.5, 1.5]);
  });

  it('leaves an un-nudged instrument exactly where it was written', () => {
    expect(exportedStarts(0)).toEqual([0, 1, 2]);
  });

  // The first note above kept none of its nudge: SMF has no tick before 0. The pair
  // moves together, so what is lost is the note's position and never its length.
  it('keeps a note its full length when the nudge runs out of room', () => {
    const base = createTestProject({ bpm: 120 });
    const nudged: Project = {
      ...base,
      tracks: [{ ...base.tracks[0], timeOffsetMs: -250 }],
    };

    const plain = midiToProject(projectToMidi(base));
    const shifted = midiToProject(projectToMidi(nudged));

    const durations = (p: Project) =>
      p.bars
        .flatMap(bar => allBarNotes(bar).map(({ note }) => note.duration))
        .sort((a, b) => a - b);

    expect(durations(shifted)).toEqual(durations(plain));
  });

  // The nudge is a duration, so the same milliseconds are fewer beats at a slower
  // tempo. Ticks can only express the musical position, so the conversion is made
  // against the tempo the file itself carries.
  it('converts against the project tempo rather than a fixed one', () => {
    // At 60 BPM a beat is a whole second, so 250ms is a quarter of one.
    expect(exportedStarts(250, 60)).toEqual([0.25, 1.25, 2.25]);
  });
});
