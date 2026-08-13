import { describe, it, expect, beforeEach } from 'vitest';
import {
  serializeProject,
  deserializeProject,
  validateProject,
  serializeForSave,
  loadFromFile,
  autoSaveToLocalStorage,
  loadFromLocalStorage,
  clearLocalStorage,
  SCHEMA_VERSION,
} from '@/engine/fileIO';
import { Project, Bar, Track, Note, ChordSegment, TimeSignature } from '@/types/music';
import { generateId } from '@/utils/id';

// Helper to create a minimal valid project for testing
/**
 * The instrument fixtures hang their material on. Fixed rather than generated so
 * that a bar's `content` key and its track's id are the same literal on the page.
 */
const FIXTURE_TRACK_ID = 'track-fixture';

/** Bar content for the fixture instrument. */
function fixtureContent(
  chords: Bar['content'][string]['chords'] = [],
  notes: Bar['content'][string]['notes'] = []
): Bar['content'] {
  return { [FIXTURE_TRACK_ID]: { chords, notes } };
}

/**
 * The content of a bar that holds exactly one instrument's material.
 *
 * Used by the legacy-file tests, where the instrument is synthesised on load and
 * its id is therefore not something the fixture gets to choose.
 */
function soleContent(bar: Bar) {
  const entries = Object.values(bar.content);
  expect(entries).toHaveLength(1);
  return entries[0];
}

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
        id: FIXTURE_TRACK_ID,
        name: 'Piano',
        instrument: 'acoustic_grand_piano',
        volume: 0.8,
        pan: 0,
        muted: false,
        solo: false,
        visible: true,
      },
    ],
    bars: [
      {
        id: generateId(),
        barIndex: 0,
        content: {
          [FIXTURE_TRACK_ID]: {
            chords: [
              { id: generateId(), romanNumeral: 'I', chordSymbol: 'C', duration: 4, root: 'C', quality: 'major' },
            ],
            notes: [
              { id: generateId(), pitch: 60, startBeat: 0, duration: 1, velocity: 100 },
              { id: generateId(), pitch: 64, startBeat: 1, duration: 1, velocity: 90 },
              { id: generateId(), pitch: 67, startBeat: 2, duration: 2, velocity: 85 },
            ],
          },
        },
      },
    ],
    createdAt: now,
    updatedAt: new Date('2024-01-01T00:01:00.000Z'),
    ...overrides,
  };
}

describe('fileIO', () => {
  beforeEach(() => {
    // Clear localStorage before each test
    clearLocalStorage();
  });

  describe('serializeProject', () => {
    it('serializes a project to JSON string', () => {
      const project = createTestProject();
      const json = serializeProject(project);
      expect(json).toBeString();
      const parsed = JSON.parse(json);
      expect(parsed).toHaveProperty('id');
      expect(parsed).toHaveProperty('name');
      expect(parsed).toHaveProperty('bpm');
    });

    it('includes all project fields', () => {
      const project = createTestProject();
      const json = serializeProject(project);
      const parsed = JSON.parse(json);

      expect(parsed.name).toBe('Test Project');
      expect(parsed.bpm).toBe(120);
      expect(parsed.timeSignature).toEqual({ beatsPerMeasure: 4, beatUnit: 4 });
      expect(parsed.key).toBe('C');
      expect(parsed.keyMode).toBe('major');
      expect(parsed.tracks).toHaveLength(1);
      expect(parsed.bars).toHaveLength(1);
    });

    it('excludes computed fields', () => {
      const project = createTestProject();
      const json = serializeProject(project);
      const parsed = JSON.parse(json);

      // createdAt and updatedAt should be ISO strings (serializable), not Date objects
      expect(typeof parsed.createdAt).toBe('string');
      expect(typeof parsed.updatedAt).toBe('string');
      // No circular references or non-serializable values
      expect(() => JSON.parse(json)).not.toThrow();
    });

    it('preserves track data', () => {
      const project = createTestProject();
      const json = serializeProject(project);
      const parsed = JSON.parse(json);
      expect(parsed.tracks[0].name).toBe('Piano');
      expect(parsed.tracks[0].volume).toBe(0.8);
      expect(parsed.tracks[0].muted).toBe(false);
    });

    it('preserves bar data with notes and chords', () => {
      const project = createTestProject();
      const json = serializeProject(project);
      const parsed = JSON.parse(json);
      expect(parsed.bars[0].barIndex).toBe(0);
      expect(parsed.bars[0].content[FIXTURE_TRACK_ID].notes).toHaveLength(3);
      expect(parsed.bars[0].content[FIXTURE_TRACK_ID].chords).toHaveLength(1);
    });

    it('handles empty project (no tracks, no bars)', () => {
      const project = createTestProject({ tracks: [], bars: [] });
      const json = serializeProject(project);
      const parsed = JSON.parse(json);
      expect(parsed.tracks).toEqual([]);
      expect(parsed.bars).toEqual([]);
    });

    it('includes version field for future compatibility', () => {
      const project = createTestProject();
      const json = serializeProject(project);
      const parsed = JSON.parse(json);
      expect(parsed).toHaveProperty('version');
    });
  });

  describe('deserializeProject', () => {
    it('deserializes a JSON string back to a Project', () => {
      const project = createTestProject();
      const json = serializeProject(project);
      const deserialized = deserializeProject(json);

      expect(deserialized.name).toBe('Test Project');
      expect(deserialized.bpm).toBe(120);
      expect(deserialized.key).toBe('C');
      expect(deserialized.keyMode).toBe('major');
      expect(deserialized.tracks).toHaveLength(1);
      expect(deserialized.bars).toHaveLength(1);
    });

    it('preserves note data after round-trip', () => {
      const project = createTestProject();
      const json = serializeProject(project);
      const deserialized = deserializeProject(json);

      expect(deserialized.bars[0].content[FIXTURE_TRACK_ID].notes).toHaveLength(3);
      expect(deserialized.bars[0].content[FIXTURE_TRACK_ID].notes[0].pitch).toBe(60);
      expect(deserialized.bars[0].content[FIXTURE_TRACK_ID].notes[0].startBeat).toBe(0);
      expect(deserialized.bars[0].content[FIXTURE_TRACK_ID].notes[0].velocity).toBe(100);
    });

    it('preserves chord data after round-trip', () => {
      const project = createTestProject();
      const json = serializeProject(project);
      const deserialized = deserializeProject(json);

      expect(deserialized.bars[0].content[FIXTURE_TRACK_ID].chords[0].romanNumeral).toBe('I');
      expect(deserialized.bars[0].content[FIXTURE_TRACK_ID].chords[0].chordSymbol).toBe('C');
      expect(deserialized.bars[0].content[FIXTURE_TRACK_ID].chords[0].duration).toBe(4);
    });

    it('throws on invalid JSON string', () => {
      expect(() => deserializeProject('not valid json')).toThrow();
    });

    it('throws on missing required fields', () => {
      const invalid = '{ "name": "Incomplete" }';
      expect(() => deserializeProject(invalid)).toThrow();
    });

    it('handles project with multiple tracks', () => {
      const project = createTestProject({
        tracks: [
          { id: generateId(), name: 'Track 1', instrument: 'piano', volume: 0.7, pan: -0.3, muted: false, solo: false },
          { id: generateId(), name: 'Track 2', instrument: 'bass', volume: 0.9, pan: 0.2, muted: true, solo: false },
        ],
      });
      const json = serializeProject(project);
      const deserialized = deserializeProject(json);
      expect(deserialized.tracks).toHaveLength(2);
      expect(deserialized.tracks[1].name).toBe('Track 2');
      expect(deserialized.tracks[1].muted).toBe(true);
    });

    it('handles project with multiple bars', () => {
      const project = createTestProject({
        bars: [
          { id: generateId(), barIndex: 0, content: fixtureContent() },
          { id: generateId(), barIndex: 1, content: fixtureContent() },
          { id: generateId(), barIndex: 2, content: fixtureContent() },
        ],
      });
      const json = serializeProject(project);
      const deserialized = deserializeProject(json);
      expect(deserialized.bars).toHaveLength(3);
      expect(deserialized.bars[2].barIndex).toBe(2);
    });
  });

  describe('validateProject', () => {
    it('returns valid for a correct project', () => {
      const project = createTestProject();
      const result = validateProject(project);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects project with missing name', () => {
      const project = createTestProject({ name: '' });
      const result = validateProject(project);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('name'))).toBe(true);
    });

    it('rejects project with invalid BPM', () => {
      const project = createTestProject({ bpm: 0 });
      const result = validateProject(project);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('bpm') || e.includes('BPM'))).toBe(true);
    });

    it('rejects project with BPM > 300', () => {
      const project = createTestProject({ bpm: 500 });
      const result = validateProject(project);
      expect(result.valid).toBe(false);
    });

    it('rejects project with invalid time signature', () => {
      const project = createTestProject({ timeSignature: { beatsPerMeasure: 0, beatUnit: 0 } });
      const result = validateProject(project);
      expect(result.valid).toBe(false);
    });

    it('rejects project with invalid key', () => {
      const project = createTestProject({ key: 'X' as any });
      const result = validateProject(project);
      expect(result.valid).toBe(false);
    });

    it('rejects project with invalid key mode', () => {
      const project = createTestProject({ keyMode: 'invalid' as any });
      const result = validateProject(project);
      expect(result.valid).toBe(false);
    });

    it('allows project with no tracks', () => {
      const project = createTestProject({ tracks: [], bars: [] });
      const result = validateProject(project);
      expect(result.valid).toBe(true);
    });

    // Content keyed by an instrument that is not in the project would be both
    // silent and invisible, so it is caught rather than carried around.
    it('rejects bar content belonging to no instrument', () => {
      const project = createTestProject({ tracks: [] });
      const result = validateProject(project);

      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toContain('unknown instrument');
    });

    it('allows project with no bars', () => {
      const project = createTestProject({ bars: [] });
      const result = validateProject(project);
      expect(result.valid).toBe(true);
    });
  });

  describe('serializeForSave', () => {
    it('produces the same text as serializeProject for a valid project', () => {
      const project = createTestProject();
      expect(serializeForSave(project)).toBe(serializeProject(project));
    });

    it('refuses a project that would not load back', () => {
      const invalidProject = { name: '', bpm: 0 } as any;
      expect(() => serializeForSave(invalidProject)).toThrow(/Cannot save/);
    });
  });

  describe('loadFromFile', () => {
    it('loads and deserializes a valid project JSON file', async () => {
      const project = createTestProject();
      const json = serializeProject(project);
      const blob = new Blob([json], { type: 'application/json' });
      const file = new File([blob], 'test.json', { type: 'application/json' });

      const loaded = await loadFromFile(file);
      expect(loaded.name).toBe('Test Project');
      expect(loaded.bpm).toBe(120);
      expect(loaded.key).toBe('C');
    });

    it('throws on invalid JSON file', async () => {
      const blob = new Blob(['not json'], { type: 'application/json' });
      const file = new File([blob], 'test.json', { type: 'application/json' });

      await expect(loadFromFile(file)).rejects.toThrow();
    });

    it('throws on file with wrong MIME type warning (still tries to parse)', async () => {
      const project = createTestProject();
      const json = serializeProject(project);
      // Wrong type but valid JSON
      const blob = new Blob([json], { type: 'text/plain' });
      const file = new File([blob], 'test.json', { type: 'text/plain' });

      // Should still parse since we try to read content
      const loaded = await loadFromFile(file);
      expect(loaded.name).toBe('Test Project');
    });
  });

  describe('autoSaveToLocalStorage', () => {
    it('saves project to localStorage', () => {
      const project = createTestProject();
      autoSaveToLocalStorage(project);

      const stored = localStorage.getItem('chord-composer-autosave');
      expect(stored).toBeTruthy();

      const saved = JSON.parse(stored!);
      expect(saved.name).toBe('Test Project');
      expect(saved.bpm).toBe(120);
    });

    it('overwrites previous localStorage entry', () => {
      const project1 = createTestProject({ name: 'Project 1' });
      const project2 = createTestProject({ name: 'Project 2' });

      autoSaveToLocalStorage(project1);
      autoSaveToLocalStorage(project2);

      const stored = localStorage.getItem('chord-composer-autosave');
      const saved = JSON.parse(stored!);
      expect(saved.name).toBe('Project 2');
    });

    it('includes version in stored data', () => {
      const project = createTestProject();
      autoSaveToLocalStorage(project);

      const stored = localStorage.getItem('chord-composer-autosave');
      const saved = JSON.parse(stored!);
      expect(saved).toHaveProperty('version');
    });
  });

  describe('loadFromLocalStorage', () => {
    it('loads a project from localStorage', () => {
      const project = createTestProject();
      autoSaveToLocalStorage(project);

      const loaded = loadFromLocalStorage();
      expect(loaded).toBeTruthy();
      expect(loaded!.name).toBe('Test Project');
      expect(loaded!.bpm).toBe(120);
    });

    it('returns null when no saved project exists', () => {
      const loaded = loadFromLocalStorage();
      expect(loaded).toBeNull();
    });

    it('returns null for corrupted data', () => {
      localStorage.setItem('chord-composer-autosave', 'corrupted data');
      const loaded = loadFromLocalStorage();
      expect(loaded).toBeNull();
    });
  });

  describe('schema 1.1 fields', () => {
    /** A project exercising every field added by the chord-editor revamp. */
    function revampProject(): Project {
      return createTestProject({
        bars: [
          {
            id: 'bar-a',
            barIndex: 0,
            timeSignature: { beatsPerMeasure: 3, beatUnit: 4 },
            content: fixtureContent([
              { id: 'seg-1', kind: 'chord', romanNumeral: 'viiø7', chordSymbol: 'Bø7', duration: 2, root: 'B', quality: 'halfDim7' },
              { id: 'seg-2', kind: 'note', duration: 1, pitch: 64, root: 'E' },
            ], []),
          },
          {
            id: 'bar-b',
            barIndex: 1,
            content: fixtureContent([], []),
          },
        ],
      });
    }

    it('declares the current schema version', () => {
      const parsed = JSON.parse(serializeProject(createTestProject()));
      expect(parsed.version).toBe(SCHEMA_VERSION);
    });

    describe('voicing', () => {
      /** A project whose one chord carries every kind of voicing at once. */
      function voicedProject(voicing: unknown): Project {
        return createTestProject({
          bars: [
            {
              id: 'bar-a',
              barIndex: 0,
              content: fixtureContent(
                [
                  {
                    id: 'seg-1',
                    kind: 'chord',
                    duration: 4,
                    root: 'C',
                    quality: 'major',
                    voicing,
                  } as never,
                ],
                []
              ),
            },
          ],
        });
      }

      const restoredVoicing = (project: Project) =>
        deserializeProject(serializeProject(project)).bars[0].content[FIXTURE_TRACK_ID]
          .chords[0].voicing;

      it('round-trips a spacing, offsets, doublings and an arpeggio', () => {
        const voicing = {
          spacing: 'drop2' as const,
          offsets: [0, -1, 0],
          doublings: [{ tone: 0, octaves: -1 as const }],
          break: { mode: 'arpeggio' as const, pattern: 'upDown' as const, gate: 0.5 },
        };
        expect(restoredVoicing(voicedProject(voicing))).toEqual(voicing);
      });

      it('round-trips a strum', () => {
        const voicing = {
          break: { mode: 'strum' as const, spreadBeats: 0.0625, direction: 'down' as const },
        };
        expect(restoredVoicing(voicedProject(voicing))?.break).toEqual(voicing.break);
      });

      it('reads a pre-1.6 chord as having no voicing at all', () => {
        const json = JSON.parse(serializeProject(createTestProject()));
        for (const content of Object.values(json.bars[0].content) as { chords: unknown[] }[]) {
          for (const chord of content.chords as Record<string, unknown>[]) {
            delete chord.voicing;
          }
        }
        const restored = deserializeProject(JSON.stringify(json));
        for (const chord of restored.bars[0].content[FIXTURE_TRACK_ID].chords) {
          expect(chord.voicing).toBeUndefined();
        }
      });

      // A voicing read from garbage would be worse than no voicing: the chord
      // would sound wrong rather than plain.
      it('drops nonsense rather than trusting it', () => {
        expect(
          restoredVoicing(
            voicedProject({
              spacing: 'banana',
              offsets: ['x', null],
              doublings: [{ tone: 'root', octaves: 5 }, { tone: 1, octaves: 2 }],
              break: { mode: 'nope' },
            })
          )
        ).toBeUndefined();
      });

      it('keeps the sound of a doubtful value inside the engine\'s own limits', () => {
        const restored = restoredVoicing(
          voicedProject({ offsets: [99, -99], break: { mode: 'strum', spreadBeats: -1 } })
        );
        expect(restored?.offsets).toEqual([3, -3]);
        // A strum that staggers by nothing is just a block chord.
        expect(restored?.break).toBeUndefined();
      });

      it('falls back to a sane arpeggio when the pattern is unknown', () => {
        const restored = restoredVoicing(
          voicedProject({ break: { mode: 'arpeggio', pattern: 'sideways', gate: 12 } })
        );
        expect(restored?.break).toEqual({ mode: 'arpeggio', pattern: 'up', gate: undefined });
      });
    });

    it('round-trips the play range and repeat flag', () => {
      const project = createTestProject({ loopStart: 4, loopEnd: 12, loopEnabled: true });
      const restored = deserializeProject(serializeProject(project));

      expect(restored.loopStart).toBe(4);
      expect(restored.loopEnd).toBe(12);
      expect(restored.loopEnabled).toBe(true);
    });

    it('round-trips the metronome', () => {
      const project = createTestProject({ metronomeEnabled: true });
      expect(deserializeProject(serializeProject(project)).metronomeEnabled).toBe(true);
    });

    it('reads a file written before the metronome was saved as having it off', () => {
      const json = JSON.parse(serializeProject(createTestProject()));
      delete json.metronomeEnabled;
      expect(deserializeProject(JSON.stringify(json)).metronomeEnabled).toBe(false);
    });

    it('reads a pre-1.4 file as having no range and no repeat', () => {
      const json = JSON.parse(serializeProject(createTestProject()));
      delete json.loopEnabled;

      const restored = deserializeProject(JSON.stringify({ ...json, version: '1.3' }));

      expect(restored.loopStart).toBeUndefined();
      expect(restored.loopEnd).toBeUndefined();
      expect(restored.loopEnabled).toBe(false);
    });

    it('discards a range missing one of its bounds', () => {
      const json = JSON.parse(serializeProject(createTestProject({ loopStart: 4, loopEnd: 12 })));
      delete json.loopEnd;

      const restored = deserializeProject(JSON.stringify(json));

      expect(restored.loopStart).toBeUndefined();
      expect(restored.loopEnd).toBeUndefined();
    });

    it('rejects a backwards play range', () => {
      const result = validateProject(createTestProject({ loopStart: 8, loopEnd: 4 }));

      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toContain('must be before its end');
    });

    it('round-trips a segment octave', () => {
      const project = revampProject();
      project.bars[0].content[FIXTURE_TRACK_ID].chords[0].octave = 2;
      const restored = deserializeProject(serializeProject(project));

      expect(restored.bars[0].content[FIXTURE_TRACK_ID].chords[0].octave).toBe(2);
    });

    it('leaves a pre-1.3 segment without an octave, so it reads as 4', () => {
      const json = JSON.parse(serializeProject(revampProject()));
      for (const chord of json.bars[0].content[FIXTURE_TRACK_ID].chords) delete chord.octave;

      const restored = deserializeProject(JSON.stringify({ ...json, version: '1.2' }));
      expect(restored.bars[0].content[FIXTURE_TRACK_ID].chords[0].octave).toBeUndefined();
    });

    it('round-trips a segment key', () => {
      const project = revampProject();
      project.bars[0].content[FIXTURE_TRACK_ID].chords[0].scale = {
        root: 'F',
        type: 'lydian',
      };
      const restored = deserializeProject(serializeProject(project));

      expect(restored.bars[0].content[FIXTURE_TRACK_ID].chords[0].scale).toEqual({
        root: 'F',
        type: 'lydian',
      });
    });

    it('pushes a pre-1.8 bar key down onto its segments', () => {
      const json = JSON.parse(serializeProject(revampProject()));
      // What a 1.7 file looked like: one key per bar, none on any segment.
      json.bars[0].scale = { root: 'A', type: 'naturalMinor' };
      json.bars[1].scale = { root: 'E', type: 'phrygian' };
      for (const bar of json.bars) {
        for (const chord of bar.content[FIXTURE_TRACK_ID].chords) delete chord.scale;
      }

      const restored = deserializeProject(JSON.stringify({ ...json, version: '1.7' }));

      for (const chord of restored.bars[0].content[FIXTURE_TRACK_ID].chords) {
        expect(chord.scale).toEqual({ root: 'A', type: 'naturalMinor' });
      }
      for (const chord of restored.bars[1].content[FIXTURE_TRACK_ID].chords) {
        expect(chord.scale).toEqual({ root: 'E', type: 'phrygian' });
      }
    });

    it('leaves a segment keyless when the pre-1.8 bar key is unreadable', () => {
      const json = JSON.parse(serializeProject(revampProject()));
      json.bars[0].scale = { root: 'H', type: 'major' };
      for (const chord of json.bars[0].content[FIXTURE_TRACK_ID].chords) delete chord.scale;

      const restored = deserializeProject(JSON.stringify({ ...json, version: '1.7' }));
      // Keyless reads as the project key rather than inventing something.
      expect(restored.bars[0].content[FIXTURE_TRACK_ID].chords[0].scale).toBeUndefined();
    });

    it('round-trips per-bar time signatures', () => {
      const restored = deserializeProject(serializeProject(revampProject()));

      expect(restored.bars[0].timeSignature).toEqual({ beatsPerMeasure: 3, beatUnit: 4 });
      // A bar that inherits the project meter stores nothing of its own.
      expect(restored.bars[1].timeSignature).toBeUndefined();
    });

    it('round-trips segment kind and pitch', () => {
      const restored = deserializeProject(serializeProject(revampProject()));
      const [chordSeg, noteSeg] = restored.bars[0].content[FIXTURE_TRACK_ID].chords;

      expect(chordSeg).toMatchObject({ kind: 'chord', quality: 'halfDim7', root: 'B' });
      expect(chordSeg.pitch).toBeUndefined();
      expect(noteSeg).toMatchObject({ kind: 'note', pitch: 64, duration: 1 });
    });

    it('accepts the seventh-chord qualities the palette can produce', () => {
      const result = validateProject(revampProject());
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });

    it('drops a per-bar time signature that is not a legal meter', () => {
      const json = JSON.stringify({
        ...JSON.parse(serializeProject(createTestProject())),
        bars: [{ id: 'bar-a', barIndex: 0, timeSignature: { beatsPerMeasure: 4, beatUnit: 5 }, content: fixtureContent() }],
      });

      expect(deserializeProject(json).bars[0].timeSignature).toBeUndefined();
    });

    it('loads a v1.0 file as an all-chord project inheriting the project meter', () => {
      // Exactly what the previous schema wrote: no version bump, no kind, no
      // pitch, no per-bar time signature.
      const legacy = JSON.stringify({
        version: '1.0',
        id: 'p1',
        name: 'Legacy',
        bpm: 100,
        timeSignature: { beatsPerMeasure: 4, beatUnit: 4 },
        key: 'C',
        keyMode: 'major',
        tracks: [],
        bars: [
          {
            id: 'bar-a',
            barIndex: 0,
            chords: [{ id: 'c1', romanNumeral: 'I', chordSymbol: 'C', duration: 4, root: 'C', quality: 'major' }],
            notes: [{ id: 'n1', pitch: 60, startBeat: 0, duration: 1, velocity: 100 }],
          },
        ],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });

      const restored = deserializeProject(legacy);

      expect(restored.bars[0].timeSignature).toBeUndefined();
      expect(soleContent(restored.bars[0]).chords[0]).toMatchObject({ kind: 'chord', root: 'C', duration: 4 });
      expect(soleContent(restored.bars[0]).notes).toHaveLength(1);
    });
  });

  // The regression that matters most: every project written before instruments
  // existed had exactly one timbre, and must still open with its music intact.
  describe('schema 1.5 instruments', () => {
    /** A 1.4 file: flat bar arrays, no instrument list. */
    const legacy14 = () =>
      JSON.stringify({
        version: '1.4',
        id: 'p1',
        name: 'Pre-instruments',
        bpm: 100,
        timeSignature: { beatsPerMeasure: 4, beatUnit: 4 },
        key: 'C',
        keyMode: 'major',
        tracks: [],
        bars: [
          {
            id: 'bar-a',
            barIndex: 0,
            chords: [
              { id: 'c1', kind: 'chord', startBeat: 0, romanNumeral: 'I', chordSymbol: 'C', duration: 2, root: 'C', quality: 'major' },
            ],
            notes: [
              { id: 'n1', pitch: 60, startBeat: 0, duration: 2, velocity: 100 },
              { id: 'n2', pitch: 64, startBeat: 0, duration: 2, velocity: 100 },
            ],
          },
        ],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });

    it('gives a 1.4 file one Piano instrument to hang its music on', () => {
      const restored = deserializeProject(legacy14());

      expect(restored.tracks).toHaveLength(1);
      expect(restored.tracks[0].name).toBe('Piano');
      expect(restored.tracks[0].instrument).toBe('acoustic_grand_piano');
      expect(restored.tracks[0].visible).toBe(true);
    });

    it('loads a 1.4 file with its segments and notes intact', () => {
      const restored = deserializeProject(legacy14());
      const content = soleContent(restored.bars[0]);

      expect(content.chords).toHaveLength(1);
      expect(content.chords[0]).toMatchObject({ id: 'c1', root: 'C', quality: 'major', duration: 2 });
      expect(content.notes.map(n => n.pitch)).toEqual([60, 64]);
    });

    it('keys a 1.4 file\'s content to the instrument it synthesised', () => {
      const restored = deserializeProject(legacy14());
      expect(Object.keys(restored.bars[0].content)).toEqual([restored.tracks[0].id]);
    });

    it('reads the same legacy file the same way twice', () => {
      // A generated id here would make an unchanged file look edited on reload.
      const first = deserializeProject(legacy14());
      const second = deserializeProject(legacy14());
      expect(first.tracks[0].id).toBe(second.tracks[0].id);
    });

    it('keeps a legacy file\'s own tracks and puts the music on the first', () => {
      const withTracks = JSON.parse(legacy14());
      withTracks.tracks = [
        { id: 'the-part', name: 'Lead', volume: 1, pan: 0, muted: false, solo: false },
        { id: 'other', name: 'Second', volume: 1, pan: 0, muted: false, solo: false },
      ];

      const restored = deserializeProject(JSON.stringify(withTracks));

      expect(restored.tracks.map(t => t.id)).toEqual(['the-part', 'other']);
      // A pre-1.5 track named no sound, so it reads as the piano it always was.
      expect(restored.tracks[0].instrument).toBe('acoustic_grand_piano');
      expect(Object.keys(restored.bars[0].content)).toEqual(['the-part']);
    });

    it('round-trips two instruments independently at 1.5', () => {
      const project = createTestProject({
        tracks: [
          { id: 'a', name: 'Piano', instrument: 'acoustic_grand_piano', volume: 1, pan: 0, muted: false, solo: false, visible: true },
          { id: 'b', name: 'Strings', instrument: 'string_ensemble_1', volume: 1, pan: 0, muted: true, solo: false, visible: false },
        ],
        bars: [
          {
            id: 'bar-a',
            barIndex: 0,
            content: {
              a: { chords: [{ id: 'ca', kind: 'chord', startBeat: 0, duration: 1, root: 'C', quality: 'major' }], notes: [] },
              b: { chords: [{ id: 'cb', kind: 'chord', startBeat: 2, duration: 1, root: 'G', quality: 'major' }], notes: [] },
            },
          },
        ],
      });

      const restored = deserializeProject(serializeProject(project));

      expect(restored.tracks[1].instrument).toBe('string_ensemble_1');
      expect(restored.tracks[1].muted).toBe(true);
      expect(restored.tracks[1].visible).toBe(false);
      expect(restored.bars[0].content.a.chords.map(c => c.id)).toEqual(['ca']);
      expect(restored.bars[0].content.b.chords.map(c => c.id)).toEqual(['cb']);
    });
  });

  describe('schema 1.2 segment positions', () => {
    /** A bar with a hole in the middle of it: block, silence, block. */
    function spacedProject(): Project {
      return createTestProject({
        bars: [
          {
            id: 'bar-a',
            barIndex: 0,
            content: fixtureContent([
              { id: 'seg-1', kind: 'chord', startBeat: 0, duration: 1, root: 'C', quality: 'major' },
              { id: 'seg-2', kind: 'chord', startBeat: 3, duration: 1, root: 'G', quality: 'major' },
            ], []),
          },
        ],
      });
    }

    it('round-trips the beat a segment starts on', () => {
      const restored = deserializeProject(serializeProject(spacedProject()));
      expect(restored.bars[0].content[FIXTURE_TRACK_ID].chords.map(c => c.startBeat)).toEqual([0, 3]);
    });

    it('keeps a segment on beat 0 rather than losing it as a falsy value', () => {
      const parsed = JSON.parse(serializeProject(spacedProject()));
      expect(parsed.bars[0].content[FIXTURE_TRACK_ID].chords[0].startBeat).toBe(0);
    });

    it('leaves a position-less segment unpositioned, for the store to pack', () => {
      // Deserialization does not invent positions: `loadProject` packs them, which
      // is the one place that rule lives.
      const legacy = JSON.stringify({
        ...JSON.parse(serializeProject(createTestProject())),
        version: '1.1',
        bars: [
          {
            id: 'bar-a',
            barIndex: 0,
            content: fixtureContent([
              { id: 'c1', kind: 'chord', duration: 2, root: 'C', quality: 'major' },
              { id: 'c2', kind: 'chord', duration: 2, root: 'G', quality: 'major' },
            ], []),
          },
        ],
      });

      const restored = deserializeProject(legacy);
      expect(restored.bars[0].content[FIXTURE_TRACK_ID].chords.every(c => c.startBeat === undefined)).toBe(true);
    });

    it('ignores a start beat that is not a number', () => {
      const json = JSON.stringify({
        ...JSON.parse(serializeProject(createTestProject())),
        bars: [
          {
            id: 'bar-a',
            barIndex: 0,
            content: fixtureContent([{ id: 'c1', kind: 'chord', startBeat: 'two', duration: 1 }], []),
          },
        ],
      });

      expect(soleContent(deserializeProject(json).bars[0]).chords[0].startBeat).toBeUndefined();
    });
  });

  describe('schema 1.12 alterations', () => {
    it('states the current schema version', () => {
      expect(SCHEMA_VERSION).toBe('1.12');
    });

    const withNote = (alter?: number) =>
      createTestProject({
        bars: [
          {
            id: 'bar-a',
            barIndex: 0,
            content: fixtureContent(
              [{ id: 'c1', kind: 'note', startBeat: 0, duration: 1, pitch: 61, alter }],
              []
            ),
          },
        ],
      });

    it('round-trips which degree an off-scale note means', () => {
      const restored = deserializeProject(serializeProject(withNote(1)));
      expect(restored.bars[0].content[FIXTURE_TRACK_ID].chords[0].alter).toBe(1);
    });

    it('writes nothing for a piece with no accidentals in it', () => {
      const parsed = JSON.parse(serializeProject(withNote()));
      expect('alter' in parsed.bars[0].content[FIXTURE_TRACK_ID].chords[0]).toBe(false);
    });

    it('reads a pre-1.12 note as the diatonic one it was', () => {
      const restored = deserializeProject(serializeProject(withNote()));
      expect(restored.bars[0].content[FIXTURE_TRACK_ID].chords[0].alter).toBeUndefined();
    });

    it('clamps an alteration no accidental could spell', () => {
      const project = withNote(9);
      const restored = deserializeProject(serializeProject(project));
      expect(restored.bars[0].content[FIXTURE_TRACK_ID].chords[0].alter).toBe(2);
    });
  });

  describe('schema 1.9 velocity', () => {

    it('round-trips a segment velocity', () => {
      const project = createTestProject({
        bars: [
          {
            id: 'bar-a',
            barIndex: 0,
            content: fixtureContent([
              { id: 'c1', kind: 'chord', startBeat: 0, duration: 4, root: 'C', quality: 'major', velocity: 64 },
            ], []),
          },
        ],
      });

      const restored = deserializeProject(serializeProject(project));
      expect(restored.bars[0].content[FIXTURE_TRACK_ID].chords[0].velocity).toBe(64);
    });

    it('writes no velocity for a project that has none', () => {
      // A project nobody has recorded into must serialise exactly as it did under
      // 1.8 — an absent key, not an explicit null.
      const parsed = JSON.parse(serializeProject(createTestProject()));
      const chord = parsed.bars[0].content[FIXTURE_TRACK_ID].chords[0];
      expect('velocity' in chord).toBe(false);
    });

    it('reads a pre-1.9 file unchanged — no velocity', () => {
      const legacy = JSON.stringify({
        ...JSON.parse(serializeProject(createTestProject())),
        version: '1.8',
      });

      const segment = deserializeProject(legacy).bars[0].content[FIXTURE_TRACK_ID].chords[0];
      expect(segment.kind).toBe('chord');
      expect(segment.velocity).toBeUndefined();
    });

    it('reads an unknown kind as a chord, as every version has', () => {
      const json = JSON.stringify({
        ...JSON.parse(serializeProject(createTestProject())),
        bars: [
          {
            id: 'bar-a',
            barIndex: 0,
            content: fixtureContent([{ id: 'c1', kind: 'nonsense', duration: 1 }], []),
          },
        ],
      });

      expect(soleContent(deserializeProject(json).bars[0]).chords[0].kind).toBe('chord');
    });
  });

  describe('schema 1.11 — sub-lanes', () => {
    /** A project holding a two-note chord, stacked across two lanes. */
    function stackedProject(): Project {
      const project = createTestProject({
        bars: [
          {
            id: 'bar-a',
            barIndex: 0,
            content: fixtureContent(
              [
                { id: 'lo', kind: 'note', pitch: 60, startBeat: 0, duration: 2 },
                { id: 'hi', kind: 'note', pitch: 64, startBeat: 0, duration: 2, lane: 1 },
              ],
              []
            ),
          },
        ],
      });
      return {
        ...project,
        tracks: [{ ...project.tracks[0], laneCount: 2 }],
      };
    }

    it('round-trips a lane and a lane count', () => {
      const restored = deserializeProject(serializeProject(stackedProject()));

      expect(restored.tracks[0].laneCount).toBe(2);
      expect(soleContent(restored.bars[0]).chords.map(c => c.lane)).toEqual([undefined, 1]);
    });

    it('writes neither key for a project with nothing stacked', () => {
      // A one-lane project must serialise exactly as it did under 1.10 — an
      // absent key, not an explicit 0 or 1.
      const parsed = JSON.parse(serializeProject(createTestProject()));
      expect('lane' in parsed.bars[0].content[FIXTURE_TRACK_ID].chords[0]).toBe(false);
      expect('laneCount' in parsed.tracks[0]).toBe(false);
    });

    it('reads a pre-1.11 file as the single lane it always was', () => {
      const legacy = JSON.stringify({
        ...JSON.parse(serializeProject(createTestProject())),
        version: '1.10',
      });
      const restored = deserializeProject(legacy);

      expect(restored.tracks[0].laneCount).toBeUndefined();
      expect(soleContent(restored.bars[0]).chords[0].lane).toBeUndefined();
    });

    it('reads a nonsensical lane as the first one', () => {
      const json = JSON.stringify({
        ...JSON.parse(serializeProject(createTestProject())),
        bars: [
          {
            id: 'bar-a',
            barIndex: 0,
            content: fixtureContent(
              [{ id: 'c1', kind: 'chord', duration: 1, lane: -3 }],
              []
            ),
          },
        ],
      });

      expect(soleContent(deserializeProject(json).bars[0]).chords[0].lane).toBeUndefined();
    });

    it('reads a 1.9 custom block as a chord, its notes gone with the kind', () => {
      // The `custom` kind is retired: sub-lanes say what it said, as named notes.
      // An unrecognised kind has always read back as a chord.
      const json = JSON.stringify({
        ...JSON.parse(serializeProject(createTestProject())),
        bars: [
          {
            id: 'bar-a',
            barIndex: 0,
            content: fixtureContent(
              [
                {
                  id: 'take-1',
                  kind: 'custom',
                  duration: 2,
                  customNotes: [{ pitch: 60, startBeat: 0, duration: 2 }],
                },
              ],
              []
            ),
          },
        ],
      });

      const segment = soleContent(deserializeProject(json).bars[0]).chords[0];
      expect(segment.kind).toBe('chord');
      expect('customNotes' in segment).toBe(false);
    });
  });

  describe('schema 1.10 — volume automation', () => {
    /** A project whose one instrument fades away across its first two bars. */
    function automatedProject(): Project {
      const project = createTestProject();
      return {
        ...project,
        tracks: [
          {
            ...project.tracks[0],
            volumeAutomation: [
              { beat: 0, value: 1 },
              { beat: 8, value: 0.2 },
            ],
          },
        ],
      };
    }

    it('round-trips a curve', () => {
      const restored = deserializeProject(serializeProject(automatedProject()));

      expect(restored.tracks[0].volumeAutomation).toEqual([
        { beat: 0, value: 1 },
        { beat: 8, value: 0.2 },
      ]);
    });

    it('writes nothing at all for an instrument with no curve', () => {
      const json = JSON.parse(serializeProject(createTestProject()));

      expect(json.tracks[0]).not.toHaveProperty('volumeAutomation');
    });

    it('writes nothing for an empty curve, which means the same as none', () => {
      const project = createTestProject();
      const json = JSON.parse(
        serializeProject({
          ...project,
          tracks: [{ ...project.tracks[0], volumeAutomation: [] }],
        })
      );

      expect(json.tracks[0].volumeAutomation).toBeUndefined();
    });

    it('opens a pre-1.10 file with no curve, so it plays at its flat volume', () => {
      const json = serializeProject(createTestProject());
      const restored = deserializeProject(JSON.stringify({ ...JSON.parse(json), version: '1.9' }));

      expect(restored.tracks[0].volumeAutomation).toBeUndefined();
      expect(restored.tracks[0].volume).toBe(0.8);
    });

    it('sorts a hand-edited file rather than trusting its order', () => {
      const project = automatedProject();
      const json = JSON.parse(serializeProject(project));
      json.tracks[0].volumeAutomation = [
        { beat: 8, value: 0.2 },
        { beat: 0, value: 1 },
      ];

      expect(deserializeProject(JSON.stringify(json)).tracks[0].volumeAutomation).toEqual([
        { beat: 0, value: 1 },
        { beat: 8, value: 0.2 },
      ]);
    });

    it('drops malformed points rather than failing the load', () => {
      const json = JSON.parse(serializeProject(automatedProject()));
      json.tracks[0].volumeAutomation = [
        { beat: 'nonsense', value: 1 },
        { beat: 4, value: 5 },
        { beat: 8, value: 0.2 },
      ];

      const restored = deserializeProject(JSON.stringify(json));
      expect(restored.tracks[0].volumeAutomation).toEqual([{ beat: 8, value: 0.2 }]);
    });

    it('reads a curve that is not a list at all as no curve', () => {
      const json = JSON.parse(serializeProject(automatedProject()));
      json.tracks[0].volumeAutomation = 'loud';

      expect(deserializeProject(JSON.stringify(json)).tracks[0].volumeAutomation).toBeUndefined();
    });

    describe('validateProject', () => {
      it('accepts a well-formed curve', () => {
        expect(validateProject(automatedProject()).valid).toBe(true);
      });

      it('rejects a level outside 0-1', () => {
        const project = automatedProject();
        const result = validateProject({
          ...project,
          tracks: [{ ...project.tracks[0], volumeAutomation: [{ beat: 0, value: 2 }] }],
        });

        expect(result.valid).toBe(false);
        expect(result.errors.join(' ')).toContain('volume automation value');
      });

      it('rejects a point before the start of the project', () => {
        const project = automatedProject();
        const result = validateProject({
          ...project,
          tracks: [{ ...project.tracks[0], volumeAutomation: [{ beat: -1, value: 1 }] }],
        });

        expect(result.valid).toBe(false);
        expect(result.errors.join(' ')).toContain('volume automation beat');
      });
    });
  });

  describe('clearLocalStorage', () => {
    it('removes the autosave key from localStorage', () => {
      const project = createTestProject();
      autoSaveToLocalStorage(project);
      expect(localStorage.getItem('chord-composer-autosave')).toBeTruthy();

      clearLocalStorage();
      expect(localStorage.getItem('chord-composer-autosave')).toBeNull();
    });
  });
});
