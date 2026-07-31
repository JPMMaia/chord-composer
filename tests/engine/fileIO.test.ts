import { describe, it, expect, beforeEach } from 'vitest';
import {
  serializeProject,
  deserializeProject,
  validateProject,
  saveToFile,
  loadFromFile,
  autoSaveToLocalStorage,
  loadFromLocalStorage,
  clearLocalStorage,
} from '@/engine/fileIO';
import { Project, Bar, Track, Note, ChordSegment, TimeSignature } from '@/types/music';
import { generateId } from '@/utils/id';

// Helper to create a minimal valid project for testing
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
        id: generateId(),
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
        scale: { root: 'C', type: 'major' },
        chords: [
          { id: generateId(), romanNumeral: 'I', chordSymbol: 'C', duration: 4, root: 'C', quality: 'major' },
        ],
        notes: [
          { id: generateId(), pitch: 60, startBeat: 0, duration: 1, velocity: 100 },
          { id: generateId(), pitch: 64, startBeat: 1, duration: 1, velocity: 90 },
          { id: generateId(), pitch: 67, startBeat: 2, duration: 2, velocity: 85 },
        ],
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
      expect(parsed.bars[0].notes).toHaveLength(3);
      expect(parsed.bars[0].chords).toHaveLength(1);
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

      expect(deserialized.bars[0].notes).toHaveLength(3);
      expect(deserialized.bars[0].notes[0].pitch).toBe(60);
      expect(deserialized.bars[0].notes[0].startBeat).toBe(0);
      expect(deserialized.bars[0].notes[0].velocity).toBe(100);
    });

    it('preserves chord data after round-trip', () => {
      const project = createTestProject();
      const json = serializeProject(project);
      const deserialized = deserializeProject(json);

      expect(deserialized.bars[0].chords[0].romanNumeral).toBe('I');
      expect(deserialized.bars[0].chords[0].chordSymbol).toBe('C');
      expect(deserialized.bars[0].chords[0].duration).toBe(4);
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
          { id: generateId(), barIndex: 0, scale: { root: 'C', type: 'major' }, chords: [], notes: [] },
          { id: generateId(), barIndex: 1, scale: { root: 'F', type: 'major' }, chords: [], notes: [] },
          { id: generateId(), barIndex: 2, scale: { root: 'G', type: 'major' }, chords: [], notes: [] },
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
      const project = createTestProject({ tracks: [] });
      const result = validateProject(project);
      expect(result.valid).toBe(true);
    });

    it('allows project with no bars', () => {
      const project = createTestProject({ bars: [] });
      const result = validateProject(project);
      expect(result.valid).toBe(true);
    });
  });

  describe('saveToFile', () => {
    it('creates a downloadable file with project JSON', async () => {
      // Mock the File System Access API and fallback download
      const mockBlob = new Blob(['test'], { type: 'application/json' });
      const mockUrl = 'http://mock.url/test.mid';
      const mockDownload = vi.fn();
      const mockRemove = vi.fn();

      // Mock URL.createObjectURL and URL.revokeObjectURL
      global.URL.createObjectURL = vi.fn().mockReturnValue(mockUrl);
      global.URL.revokeObjectURL = mockRemove as any;

      // Mock anchor element for download fallback
      const mockAnchor = {
        href: '',
        download: '',
        click: mockDownload,
      };
      const mockCreateElement = vi.fn().mockReturnValue(mockAnchor);
      document.createElement = mockCreateElement as any;

      const project = createTestProject();
      await saveToFile(project, 'my-project.json');

      expect(mockDownload).toHaveBeenCalled();
      expect(mockRemove).toHaveBeenCalledWith(mockUrl);
    });

    it('uses the provided filename', async () => {
      const mockAnchor = {
        href: '',
        download: '',
        click: vi.fn(),
      };
      document.createElement = vi.fn().mockReturnValue(mockAnchor) as any;
      global.URL.createObjectURL = vi.fn().mockReturnValue('http://mock.url');

      const project = createTestProject();
      await saveToFile(project, 'custom-name.json');

      expect(mockAnchor.download).toBe('custom-name.json');
    });

    it('throws on invalid project', async () => {
      const invalidProject = { name: '', bpm: 0 } as any;
      await expect(saveToFile(invalidProject, 'test.json')).rejects.toThrow();
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
            scale: { root: 'C', type: 'major' },
            chords: [
              { id: 'seg-1', kind: 'chord', romanNumeral: 'viiø7', chordSymbol: 'Bø7', duration: 2, root: 'B', quality: 'halfDim7' },
              { id: 'seg-2', kind: 'note', duration: 1, pitch: 64, root: 'E' },
            ],
            notes: [],
          },
          {
            id: 'bar-b',
            barIndex: 1,
            scale: { root: 'C', type: 'major' },
            chords: [],
            notes: [],
          },
        ],
      });
    }

    it('declares schema version 1.1', () => {
      const parsed = JSON.parse(serializeProject(createTestProject()));
      expect(parsed.version).toBe('1.1');
    });

    it('round-trips per-bar time signatures', () => {
      const restored = deserializeProject(serializeProject(revampProject()));

      expect(restored.bars[0].timeSignature).toEqual({ beatsPerMeasure: 3, beatUnit: 4 });
      // A bar that inherits the project meter stores nothing of its own.
      expect(restored.bars[1].timeSignature).toBeUndefined();
    });

    it('round-trips segment kind and pitch', () => {
      const restored = deserializeProject(serializeProject(revampProject()));
      const [chordSeg, noteSeg] = restored.bars[0].chords;

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
        bars: [{ id: 'bar-a', barIndex: 0, timeSignature: { beatsPerMeasure: 4, beatUnit: 5 }, scale: { root: 'C', type: 'major' }, chords: [], notes: [] }],
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
            scale: { root: 'C', type: 'major' },
            chords: [{ id: 'c1', romanNumeral: 'I', chordSymbol: 'C', duration: 4, root: 'C', quality: 'major' }],
            notes: [{ id: 'n1', pitch: 60, startBeat: 0, duration: 1, velocity: 100 }],
          },
        ],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });

      const restored = deserializeProject(legacy);

      expect(restored.bars[0].timeSignature).toBeUndefined();
      expect(restored.bars[0].chords[0]).toMatchObject({ kind: 'chord', root: 'C', duration: 4 });
      expect(restored.bars[0].notes).toHaveLength(1);
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
