import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { autoSaveStore } from '@/store/autoSaveStore';

describe('autoSaveStore', () => {
  beforeEach(() => {
    localStorage.clear();
    autoSaveStore.getState().setDebounceDelay(50);
  });

  afterEach(() => {
    localStorage.clear();
    autoSaveStore.getState().clear();
  });

  describe('save', () => {
    it('saves project data to localStorage', async () => {
      autoSaveStore.getState().save({
        project: {
          id: 'test-id',
          name: 'Test Project',
          bpm: 120,
          timeSignature: { beatsPerMeasure: 4, beatUnit: 4 },
          key: 'C',
          keyMode: 'major',
          tracks: [],
          bars: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        tracks: [],
      });

      await new Promise(resolve => setTimeout(resolve, 100));
      const saved = localStorage.getItem('chord-composer-autosave');
      expect(saved).not.toBeNull();
    });

    it('stores valid JSON in localStorage', async () => {
      autoSaveStore.getState().save({
        project: {
          id: 'test-id',
          name: 'Test',
          bpm: 100,
          timeSignature: { beatsPerMeasure: 3, beatUnit: 4 },
          key: 'G',
          keyMode: 'minor',
          tracks: [],
          bars: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        tracks: [],
      });

      await new Promise(resolve => setTimeout(resolve, 100));
      const saved = localStorage.getItem('chord-composer-autosave');
      expect(() => JSON.parse(saved!)).not.toThrow();
    });

    it('persists project id in saved data', async () => {
      autoSaveStore.getState().save({
        project: {
          id: 'unique-project-123',
          name: 'Test',
          bpm: 120,
          timeSignature: { beatsPerMeasure: 4, beatUnit: 4 },
          key: 'C',
          keyMode: 'major',
          tracks: [],
          bars: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        tracks: [],
      });

      await new Promise(resolve => setTimeout(resolve, 100));
      const saved = JSON.parse(localStorage.getItem('chord-composer-autosave')!);
      expect(saved.project.id).toBe('unique-project-123');
    });

    it('persists bpm in saved data', async () => {
      autoSaveStore.getState().save({
        project: {
          id: 'test',
          name: 'Test',
          bpm: 90,
          timeSignature: { beatsPerMeasure: 4, beatUnit: 4 },
          key: 'C',
          keyMode: 'major',
          tracks: [],
          bars: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        tracks: [],
      });

      await new Promise(resolve => setTimeout(resolve, 100));
      const saved = JSON.parse(localStorage.getItem('chord-composer-autosave')!);
      expect(saved.project.bpm).toBe(90);
    });

    it('persists key and keyMode in saved data', async () => {
      autoSaveStore.getState().save({
        project: {
          id: 'test',
          name: 'Test',
          bpm: 120,
          timeSignature: { beatsPerMeasure: 4, beatUnit: 4 },
          key: 'Eb',
          keyMode: 'minor',
          tracks: [],
          bars: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        tracks: [],
      });

      await new Promise(resolve => setTimeout(resolve, 100));
      const saved = JSON.parse(localStorage.getItem('chord-composer-autosave')!);
      expect(saved.project.key).toBe('Eb');
      expect(saved.project.keyMode).toBe('minor');
    });
  });

  describe('load', () => {
    it('loads project from localStorage', () => {
      const testData = {
        project: {
          id: 'load-test-id',
          name: 'Loaded Project',
          bpm: 110,
          timeSignature: { beatsPerMeasure: 6, beatUnit: 8 },
          key: 'D',
          keyMode: 'minor',
          tracks: [],
          bars: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        tracks: [],
      };
      localStorage.setItem('chord-composer-autosave', JSON.stringify(testData));

      const loaded = autoSaveStore.getState().load();
      expect(loaded).not.toBeNull();
      expect(loaded!.project.id).toBe('load-test-id');
      expect(loaded!.project.name).toBe('Loaded Project');
      expect(loaded!.project.bpm).toBe(110);
      expect(loaded!.project.timeSignature.beatsPerMeasure).toBe(6);
      expect(loaded!.project.key).toBe('D');
      expect(loaded!.project.keyMode).toBe('minor');
    });

    it('returns null when no saved data exists', () => {
      const loaded = autoSaveStore.getState().load();
      expect(loaded).toBeNull();
    });

    it('handles corrupted JSON gracefully', () => {
      localStorage.setItem('chord-composer-autosave', 'not-valid-json');
      const loaded = autoSaveStore.getState().load();
      expect(loaded).toBeNull();
    });

    it('handles missing project field gracefully', () => {
      localStorage.setItem('chord-composer-autosave', JSON.stringify({ tracks: [] }));
      const loaded = autoSaveStore.getState().load();
      expect(loaded).toBeNull();
    });
  });

  describe('clear', () => {
    it('clears localStorage on clear', async () => {
      autoSaveStore.getState().save({
        project: {
          id: 'test',
          name: 'Test',
          bpm: 120,
          timeSignature: { beatsPerMeasure: 4, beatUnit: 4 },
          key: 'C',
          keyMode: 'major',
          tracks: [],
          bars: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        tracks: [],
      });

      await new Promise(resolve => setTimeout(resolve, 100));
      expect(localStorage.getItem('chord-composer-autosave')).not.toBeNull();

      autoSaveStore.getState().clear();
      expect(localStorage.getItem('chord-composer-autosave')).toBeNull();
    });

    it('can be followed by a new save', async () => {
      autoSaveStore.getState().clear();
      autoSaveStore.getState().save({
        project: {
          id: 'fresh-start',
          name: 'New Project',
          bpm: 120,
          timeSignature: { beatsPerMeasure: 4, beatUnit: 4 },
          key: 'C',
          keyMode: 'major',
          tracks: [],
          bars: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        tracks: [],
      });

      await new Promise(resolve => setTimeout(resolve, 100));
      const saved = JSON.parse(localStorage.getItem('chord-composer-autosave')!);
      expect(saved.project.id).toBe('fresh-start');
    });
  });

  describe('debounce behavior', () => {
    it('debounces saves (not every state change)', async () => {
      for (let i = 0; i < 5; i++) {
        autoSaveStore.getState().save({
          project: {
            id: `debounce-${i}`,
            name: `Test ${i}`,
            bpm: 120,
            timeSignature: { beatsPerMeasure: 4, beatUnit: 4 },
            key: 'C',
            keyMode: 'major',
            tracks: [],
            bars: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          tracks: [],
        });
      }

      await new Promise(resolve => setTimeout(resolve, 100));
      const saved = JSON.parse(localStorage.getItem('chord-composer-autosave')!);
      expect(saved.project.id).toBe('debounce-4');
    });

    it('save function does not throw on rapid calls', () => {
      expect(() => {
        for (let i = 0; i < 10; i++) {
          autoSaveStore.getState().save({
            project: {
              id: `rapid-${i}`,
              name: `Test`,
              bpm: 120,
              timeSignature: { beatsPerMeasure: 4, beatUnit: 4 },
              key: 'C',
              keyMode: 'major',
              tracks: [],
              bars: [],
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            tracks: [],
          });
        }
      }).not.toThrow();
    });
  });

  describe('tracks persistence', () => {
    it('persists tracks array', async () => {
      autoSaveStore.getState().save({
        project: {
          id: 'test',
          name: 'Test',
          bpm: 120,
          timeSignature: { beatsPerMeasure: 4, beatUnit: 4 },
          key: 'C',
          keyMode: 'major',
          tracks: [],
          bars: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        tracks: [
          {
            id: 'track-1',
            name: 'Piano',
            instrument: 'Grand Piano',
            volume: 0.8,
            pan: 0,
            muted: false,
            solo: false,
          },
        ],
      });

      await new Promise(resolve => setTimeout(resolve, 100));
      const saved = JSON.parse(localStorage.getItem('chord-composer-autosave')!);
      expect(saved.tracks.length).toBe(1);
      expect(saved.tracks[0].name).toBe('Piano');
      expect(saved.tracks[0].volume).toBe(0.8);
    });
  });
});
