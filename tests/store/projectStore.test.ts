import { describe, it, expect, beforeEach } from 'vitest';
import { projectStore } from '@/store/projectStore';
import { Bar, NoteName, ScaleType, TimeSignature } from '@/types/music';

describe('projectStore', () => {
  beforeEach(() => {
    projectStore.getState().resetProject();
  });

  describe('createProject', () => {
    it('creates a project with default values', () => {
      projectStore.getState().createProject();
      const project = projectStore.getState().project;
      expect(project).not.toBeNull();
      expect(project!.name).toBe('Untitled');
      expect(project!.bpm).toBe(120);
      expect(project!.timeSignature).toEqual({ beatsPerMeasure: 4, beatUnit: 4 });
      expect(project!.key).toBe('C');
      expect(project!.keyMode).toBe('major');
    });

    it('sets bpm to 120 by default', () => {
      projectStore.getState().createProject();
      expect(projectStore.getState().project!.bpm).toBe(120);
    });

    it('sets timeSignature to 4/4 by default', () => {
      projectStore.getState().createProject();
      expect(projectStore.getState().project!.timeSignature.beatsPerMeasure).toBe(4);
      expect(projectStore.getState().project!.timeSignature.beatUnit).toBe(4);
    });

    it('sets key to C major by default', () => {
      projectStore.getState().createProject();
      expect(projectStore.getState().project!.key).toBe('C');
      expect(projectStore.getState().project!.keyMode).toBe('major');
    });

    it('creates an empty bars array', () => {
      projectStore.getState().createProject();
      expect(projectStore.getState().project!.bars).toEqual([]);
    });

    it('creates an empty tracks array', () => {
      projectStore.getState().createProject();
      expect(projectStore.getState().project!.tracks).toEqual([]);
    });

    it('generates a unique project id', () => {
      projectStore.getState().createProject();
      const id1 = projectStore.getState().project!.id;
      projectStore.getState().resetProject();
      projectStore.getState().createProject();
      const id2 = projectStore.getState().project!.id;
      expect(id1).not.toBe(id2);
    });

    it('returns null when no project exists', () => {
      expect(projectStore.getState().project).toBeNull();
    });

    it('sets createdAt and updatedAt timestamps', () => {
      projectStore.getState().createProject();
      const project = projectStore.getState().project;
      expect(project!.createdAt).toBeInstanceOf(Date);
      expect(project!.updatedAt).toBeInstanceOf(Date);
    });
  });

  describe('setBpm', () => {
    beforeEach(() => {
      projectStore.getState().createProject();
    });

    it('updates bpm to 100', () => {
      projectStore.getState().setBpm(100);
      expect(projectStore.getState().project!.bpm).toBe(100);
    });

    it('rejects bpm < 20', () => {
      expect(() => projectStore.getState().setBpm(19)).toThrow('BPM must be between 20 and 300');
    });

    it('rejects bpm > 300', () => {
      expect(() => projectStore.getState().setBpm(301)).toThrow('BPM must be between 20 and 300');
    });

    it('rejects bpm = 0', () => {
      expect(() => projectStore.getState().setBpm(0)).toThrow('BPM must be between 20 and 300');
    });

    it('accepts boundary values 20 and 300', () => {
      projectStore.getState().setBpm(20);
      expect(projectStore.getState().project!.bpm).toBe(20);
      projectStore.getState().setBpm(300);
      expect(projectStore.getState().project!.bpm).toBe(300);
    });
  });

  describe('setTimeSignature', () => {
    beforeEach(() => {
      projectStore.getState().createProject();
    });

    it('sets 3/4 time signature', () => {
      projectStore.getState().setTimeSignature({ beatsPerMeasure: 3, beatUnit: 4 });
      expect(projectStore.getState().project!.timeSignature).toEqual({ beatsPerMeasure: 3, beatUnit: 4 });
    });

    it('sets 6/8 time signature', () => {
      projectStore.getState().setTimeSignature({ beatsPerMeasure: 6, beatUnit: 8 });
      expect(projectStore.getState().project!.timeSignature).toEqual({ beatsPerMeasure: 6, beatUnit: 8 });
    });

    it('rejects invalid numerator (< 2)', () => {
      expect(() => projectStore.getState().setTimeSignature({ beatsPerMeasure: 1, beatUnit: 4 })).toThrow('Invalid time signature');
    });

    it('rejects invalid denominator (not 4 or 8)', () => {
      expect(() => projectStore.getState().setTimeSignature({ beatsPerMeasure: 4, beatUnit: 2 })).toThrow('Invalid time signature');
    });

    it('rejects numerator = 0', () => {
      expect(() => projectStore.getState().setTimeSignature({ beatsPerMeasure: 0, beatUnit: 4 })).toThrow('Invalid time signature');
    });
  });

  describe('setKey', () => {
    beforeEach(() => {
      projectStore.getState().createProject();
    });

    it('sets key to G major', () => {
      projectStore.getState().setKey('G');
      expect(projectStore.getState().project!.key).toBe('G');
    });

    it('sets key mode to minor', () => {
      projectStore.getState().setKey('A', 'minor');
      expect(projectStore.getState().project!.key).toBe('A');
      expect(projectStore.getState().project!.keyMode).toBe('minor');
    });

    it('updates key and keyMode together', () => {
      projectStore.getState().setKey('Eb', 'minor');
      expect(projectStore.getState().project!.key).toBe('Eb');
      expect(projectStore.getState().project!.keyMode).toBe('minor');
    });

    it('defaults to major mode when mode not specified', () => {
      projectStore.getState().setKey('D');
      expect(projectStore.getState().project!.keyMode).toBe('major');
    });

    it('handles flat notes', () => {
      projectStore.getState().setKey('Bb', 'major');
      expect(projectStore.getState().project!.key).toBe('Bb');
    });

    it('handles sharp notes', () => {
      projectStore.getState().setKey('F#', 'minor');
      expect(projectStore.getState().project!.key).toBe('F#');
    });
  });

  describe('addBar', () => {
    beforeEach(() => {
      projectStore.getState().createProject();
    });

    it('adds a bar with the project current key/scale', () => {
      projectStore.getState().addBar();
      const bars = projectStore.getState().project!.bars;
      expect(bars.length).toBe(1);
      expect(bars[0].scale.root).toBe('C');
      expect(bars[0].scale.type).toBe('major');
    });

    it('increments barIndex sequentially', () => {
      projectStore.getState().addBar();
      projectStore.getState().addBar();
      projectStore.getState().addBar();
      const bars = projectStore.getState().project!.bars;
      expect(bars[0].barIndex).toBe(0);
      expect(bars[1].barIndex).toBe(1);
      expect(bars[2].barIndex).toBe(2);
    });

    it('generates a unique bar id', () => {
      projectStore.getState().addBar();
      projectStore.getState().addBar();
      const bars = projectStore.getState().project!.bars;
      expect(bars[0].id).not.toBe(bars[1].id);
    });

    it('creates empty chords and notes arrays', () => {
      projectStore.getState().addBar();
      const bar = projectStore.getState().project!.bars[0];
      expect(bar.chords).toEqual([]);
      expect(bar.notes).toEqual([]);
    });

    it('creates multiple bars correctly', () => {
      for (let i = 0; i < 8; i++) {
        projectStore.getState().addBar();
      }
      expect(projectStore.getState().project!.bars.length).toBe(8);
    });
  });

  describe('removeBar', () => {
    beforeEach(() => {
      projectStore.getState().createProject();
      projectStore.getState().addBar();
      projectStore.getState().addBar();
      projectStore.getState().addBar();
    });

    it('removes a bar by id', () => {
      const barId = projectStore.getState().project!.bars[1].id;
      projectStore.getState().removeBar(barId);
      expect(projectStore.getState().project!.bars.length).toBe(2);
    });

    it('removes the correct bar', () => {
      const middleBar = projectStore.getState().project!.bars[1];
      projectStore.getState().removeBar(middleBar.id);
      const bars = projectStore.getState().project!.bars;
      expect(bars[0].id).toBe(projectStore.getState().project!.bars[0].id);
      expect(bars[1].id).not.toBe(middleBar.id);
    });

    it('throws when bar id does not exist', () => {
      expect(() => projectStore.getState().removeBar('nonexistent-id')).toThrow('Bar not found');
    });

    it('allows removing the last bar', () => {
      const lastBar = projectStore.getState().project!.bars[2];
      projectStore.getState().removeBar(lastBar.id);
      expect(projectStore.getState().project!.bars.length).toBe(2);
    });

    it('allows removing all bars', () => {
      const bars = [...projectStore.getState().project!.bars];
      for (const bar of bars) {
        projectStore.getState().removeBar(bar.id);
      }
      expect(projectStore.getState().project!.bars.length).toBe(0);
    });
  });

  describe('updateBarScale', () => {
    beforeEach(() => {
      projectStore.getState().createProject();
      projectStore.getState().addBar();
    });

    it('updates the scale of an existing bar', () => {
      const barId = projectStore.getState().project!.bars[0].id;
      projectStore.getState().updateBarScale(barId, { root: 'G', type: 'major' });
      const bar = projectStore.getState().project!.bars[0];
      expect(bar.scale.root).toBe('G');
      expect(bar.scale.type).toBe('major');
    });

    it('preserves bar index and other properties', () => {
      const barId = projectStore.getState().project!.bars[0].id;
      projectStore.getState().updateBarScale(barId, { root: 'D', type: 'minor' });
      const bar = projectStore.getState().project!.bars[0];
      expect(bar.barIndex).toBe(0);
      expect(bar.chords).toEqual([]);
      expect(bar.notes).toEqual([]);
    });

    it('throws when bar id does not exist', () => {
      expect(() => projectStore.getState().updateBarScale('nonexistent', { root: 'C', type: 'major' })).toThrow('Bar not found');
    });

    it('handles flat root notes', () => {
      const barId = projectStore.getState().project!.bars[0].id;
      projectStore.getState().updateBarScale(barId, { root: 'Eb', type: 'naturalMinor' });
      expect(projectStore.getState().project!.bars[0].scale.root).toBe('Eb');
    });

    it('handles all scale types', () => {
      const barId = projectStore.getState().project!.bars[0].id;
      projectStore.getState().updateBarScale(barId, { root: 'C', type: 'blues' });
      expect(projectStore.getState().project!.bars[0].scale.type).toBe('blues');
    });
  });

  describe('resetProject', () => {
    it('clears project state', () => {
      projectStore.getState().createProject();
      projectStore.getState().addBar();
      projectStore.getState().resetProject();
      expect(projectStore.getState().project).toBeNull();
    });

    it('can be followed by createProject', () => {
      projectStore.getState().createProject();
      projectStore.getState().resetProject();
      projectStore.getState().createProject();
      expect(projectStore.getState().project).not.toBeNull();
    });

    it('clears localStorage autosave', () => {
      projectStore.getState().createProject();
      projectStore.getState().resetProject();
      const saved = localStorage.getItem('chord-composer-autosave');
      expect(saved).toBeNull();
    });
  });
});
