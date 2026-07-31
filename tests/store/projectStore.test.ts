import { describe, it, expect, beforeEach } from 'vitest';
import { projectStore } from '@/store/projectStore';
import { Bar, ChordSegment, NoteName, ScaleType, TimeSignature } from '@/types/music';

/** Build a chord segment without having to spell out every optional field. */
function chordSegment(overrides: Partial<ChordSegment> = {}): ChordSegment {
  return {
    id: `seg-${Math.random().toString(36).slice(2)}`,
    kind: 'chord',
    duration: 1,
    root: 'C',
    quality: 'major',
    ...overrides,
  };
}

/** Append a segment to the end of the flat segment list. */
function appendSegment(segment: ChordSegment): void {
  const bars = projectStore.getState().project!.bars;
  const count = bars.reduce((n, b) => n + b.chords.length, 0);
  projectStore.getState().insertSegment(count, segment);
}

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

    it('accepts a half-note beat unit', () => {
      projectStore.getState().setTimeSignature({ beatsPerMeasure: 2, beatUnit: 2 });
      expect(projectStore.getState().project!.timeSignature).toEqual({ beatsPerMeasure: 2, beatUnit: 2 });
    });

    it('accepts a sixteenth-note beat unit', () => {
      projectStore.getState().setTimeSignature({ beatsPerMeasure: 7, beatUnit: 16 });
      expect(projectStore.getState().project!.timeSignature.beatUnit).toBe(16);
    });

    it('rejects a beat unit that is not a power of two up to 16', () => {
      expect(() => projectStore.getState().setTimeSignature({ beatsPerMeasure: 4, beatUnit: 3 })).toThrow('Invalid time signature');
      expect(() => projectStore.getState().setTimeSignature({ beatsPerMeasure: 4, beatUnit: 32 })).toThrow('Invalid time signature');
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

  describe('setBarTimeSignature', () => {
    beforeEach(() => {
      projectStore.getState().createProject();
      projectStore.getState().addBar();
    });

    it('sets a per-bar time signature', () => {
      const barId = projectStore.getState().project!.bars[0].id;
      projectStore.getState().setBarTimeSignature(barId, { beatsPerMeasure: 3, beatUnit: 4 });
      expect(projectStore.getState().project!.bars[0].timeSignature).toEqual({
        beatsPerMeasure: 3,
        beatUnit: 4,
      });
    });

    it('leaves other bars on the project time signature', () => {
      projectStore.getState().addBar();
      const barId = projectStore.getState().project!.bars[0].id;
      projectStore.getState().setBarTimeSignature(barId, { beatsPerMeasure: 3, beatUnit: 4 });
      expect(projectStore.getState().project!.bars[1].timeSignature).toBeUndefined();
    });

    it('reflows segments that no longer fit the shortened bar', () => {
      for (let i = 0; i < 4; i++) appendSegment(chordSegment());
      const barId = projectStore.getState().project!.bars[0].id;
      projectStore.getState().setBarTimeSignature(barId, { beatsPerMeasure: 3, beatUnit: 4 });

      const bars = projectStore.getState().project!.bars;
      expect(bars[0].chords.length).toBe(3);
      expect(bars[1].chords.length).toBe(1);
    });

    it('rejects an invalid time signature', () => {
      const barId = projectStore.getState().project!.bars[0].id;
      expect(() =>
        projectStore.getState().setBarTimeSignature(barId, { beatsPerMeasure: 0, beatUnit: 4 })
      ).toThrow('Invalid time signature');
    });

    it('throws when the bar id does not exist', () => {
      expect(() =>
        projectStore.getState().setBarTimeSignature('nope', { beatsPerMeasure: 3, beatUnit: 4 })
      ).toThrow('Bar not found');
    });
  });

  describe('insertSegment', () => {
    beforeEach(() => {
      projectStore.getState().createProject();
      projectStore.getState().addBar();
    });

    it('inserts a segment into the first bar', () => {
      projectStore.getState().insertSegment(0, chordSegment({ id: 'a' }));
      expect(projectStore.getState().project!.bars[0].chords.map(c => c.id)).toEqual(['a']);
    });

    it('inserts at the given position in the flat segment list', () => {
      appendSegment(chordSegment({ id: 'a' }));
      appendSegment(chordSegment({ id: 'b' }));
      projectStore.getState().insertSegment(1, chordSegment({ id: 'mid' }));
      expect(projectStore.getState().project!.bars[0].chords.map(c => c.id)).toEqual([
        'a',
        'mid',
        'b',
      ]);
    });

    it('pushes the fifth beat of a 4/4 bar into the next bar', () => {
      for (let i = 0; i < 5; i++) appendSegment(chordSegment());
      const bars = projectStore.getState().project!.bars;
      expect(bars.length).toBe(2);
      expect(bars[0].chords.length).toBe(4);
      expect(bars[1].chords.length).toBe(1);
    });

    it('generates the triad notes for a chord segment', () => {
      projectStore.getState().insertSegment(0, chordSegment({ root: 'C', quality: 'major' }));
      const notes = projectStore.getState().project!.bars[0].notes;
      expect(notes.map(n => n.pitch)).toEqual([60, 64, 67]);
    });

    it('generates four notes for a seventh chord', () => {
      projectStore.getState().insertSegment(0, chordSegment({ root: 'C', quality: 'maj7' }));
      expect(projectStore.getState().project!.bars[0].notes.length).toBe(4);
    });

    it('generates exactly one note for a note segment', () => {
      projectStore.getState().insertSegment(0, chordSegment({ kind: 'note', pitch: 62 }));
      const notes = projectStore.getState().project!.bars[0].notes;
      expect(notes.length).toBe(1);
      expect(notes[0].pitch).toBe(62);
    });

    it('regenerates notes in the bar a segment overflows into', () => {
      for (let i = 0; i < 5; i++) appendSegment(chordSegment({ root: 'C', quality: 'major' }));
      const bars = projectStore.getState().project!.bars;
      expect(bars[1].notes.map(n => n.pitch)).toEqual([60, 64, 67]);
      expect(bars[1].notes[0].startBeat).toBe(0);
    });

    it('creates a bar to drop into when the project has none', () => {
      projectStore.getState().removeBar(projectStore.getState().project!.bars[0].id);
      projectStore.getState().insertSegment(0, chordSegment({ id: 'a' }));
      const bars = projectStore.getState().project!.bars;
      expect(bars.length).toBe(1);
      expect(bars[0].chords.map(c => c.id)).toEqual(['a']);
    });
  });

  describe('removeSegment', () => {
    beforeEach(() => {
      projectStore.getState().createProject();
      projectStore.getState().addBar();
    });

    it('removes a segment by id', () => {
      appendSegment(chordSegment({ id: 'a' }));
      appendSegment(chordSegment({ id: 'b' }));
      projectStore.getState().removeSegment('a');
      expect(projectStore.getState().project!.bars[0].chords.map(c => c.id)).toEqual(['b']);
    });

    it('empties the generated notes when the last segment goes', () => {
      appendSegment(chordSegment({ id: 'a' }));
      expect(projectStore.getState().project!.bars[0].notes.length).toBe(3);
      projectStore.getState().removeSegment('a');
      expect(projectStore.getState().project!.bars[0].notes).toEqual([]);
    });

    it('pulls a segment back from the following bar', () => {
      for (let i = 0; i < 5; i++) appendSegment(chordSegment({ id: `s${i}` }));
      projectStore.getState().removeSegment('s0');
      const bars = projectStore.getState().project!.bars;
      expect(bars[0].chords.map(c => c.id)).toEqual(['s1', 's2', 's3', 's4']);
      expect(bars[1].chords).toEqual([]);
    });

    it('ignores an unknown segment id', () => {
      appendSegment(chordSegment({ id: 'a' }));
      projectStore.getState().removeSegment('nope');
      expect(projectStore.getState().project!.bars[0].chords.length).toBe(1);
    });
  });

  describe('moveSegment', () => {
    beforeEach(() => {
      projectStore.getState().createProject();
      projectStore.getState().addBar();
      appendSegment(chordSegment({ id: 'a' }));
      appendSegment(chordSegment({ id: 'b' }));
      appendSegment(chordSegment({ id: 'c' }));
    });

    it('moves a segment later in the list', () => {
      projectStore.getState().moveSegment(0, 2);
      expect(projectStore.getState().project!.bars[0].chords.map(c => c.id)).toEqual([
        'b',
        'c',
        'a',
      ]);
    });

    it('moves a segment earlier in the list', () => {
      projectStore.getState().moveSegment(2, 0);
      expect(projectStore.getState().project!.bars[0].chords.map(c => c.id)).toEqual([
        'c',
        'a',
        'b',
      ]);
    });

    it('regenerates notes in the new order', () => {
      projectStore.getState().moveSegment(0, 2);
      const notes = projectStore.getState().project!.bars[0].notes;
      expect(notes.length).toBe(9);
      expect(notes[0].startBeat).toBe(0);
    });

    it('ignores an out-of-range index', () => {
      projectStore.getState().moveSegment(0, 9);
      expect(projectStore.getState().project!.bars[0].chords.map(c => c.id)).toEqual([
        'a',
        'b',
        'c',
      ]);
    });
  });

  describe('resizeSegmentDuration', () => {
    beforeEach(() => {
      projectStore.getState().createProject();
      projectStore.getState().addBar();
    });

    it('sets a new duration', () => {
      appendSegment(chordSegment({ id: 'a' }));
      projectStore.getState().resizeSegmentDuration('a', 2);
      expect(projectStore.getState().project!.bars[0].chords[0].duration).toBe(2);
    });

    it('updates the generated notes duration', () => {
      appendSegment(chordSegment({ id: 'a' }));
      projectStore.getState().resizeSegmentDuration('a', 2);
      const notes = projectStore.getState().project!.bars[0].notes;
      expect(notes.every(n => n.duration === 2)).toBe(true);
    });

    it('snaps to the editing grid', () => {
      appendSegment(chordSegment({ id: 'a' }));
      projectStore.getState().resizeSegmentDuration('a', 1.3);
      expect(projectStore.getState().project!.bars[0].chords[0].duration).toBe(1.25);
    });

    it('clamps to the containing bar capacity', () => {
      appendSegment(chordSegment({ id: 'a' }));
      projectStore.getState().resizeSegmentDuration('a', 99);
      expect(projectStore.getState().project!.bars[0].chords[0].duration).toBe(4);
    });

    it('pushes later segments over the bar line when it grows', () => {
      appendSegment(chordSegment({ id: 'a' }));
      appendSegment(chordSegment({ id: 'b' }));
      appendSegment(chordSegment({ id: 'c' }));
      appendSegment(chordSegment({ id: 'd' }));
      projectStore.getState().resizeSegmentDuration('a', 2);
      const bars = projectStore.getState().project!.bars;
      expect(bars[0].chords.map(c => c.id)).toEqual(['a', 'b', 'c']);
      expect(bars[1].chords.map(c => c.id)).toEqual(['d']);
    });

    it('ignores an unknown segment id', () => {
      appendSegment(chordSegment({ id: 'a' }));
      projectStore.getState().resizeSegmentDuration('nope', 2);
      expect(projectStore.getState().project!.bars[0].chords[0].duration).toBe(1);
    });
  });

  describe('updateBarScale note regeneration', () => {
    beforeEach(() => {
      projectStore.getState().createProject();
      projectStore.getState().addBar();
    });

    it('re-interprets roman numerals against the new scale', () => {
      appendSegment(chordSegment({ id: 'a', root: undefined, quality: undefined, romanNumeral: 'I' }));
      expect(projectStore.getState().project!.bars[0].notes.map(n => n.pitch)).toEqual([60, 64, 67]);

      const barId = projectStore.getState().project!.bars[0].id;
      projectStore.getState().updateBarScale(barId, { root: 'D', type: 'major' });
      expect(projectStore.getState().project!.bars[0].notes.map(n => n.pitch)).toEqual([62, 66, 69]);
    });

    it('retunes segments that carry an explicit root and quality', () => {
      // This is the shape the palette and splitBarIntoChords actually produce:
      // an explicit root/quality alongside the numeral.
      appendSegment(
        chordSegment({ id: 'a', romanNumeral: 'I', root: 'C', quality: 'major', chordSymbol: 'C' })
      );
      const barId = projectStore.getState().project!.bars[0].id;
      projectStore.getState().updateBarScale(barId, { root: 'D', type: 'major' });

      const bar = projectStore.getState().project!.bars[0];
      expect(bar.chords[0].root).toBe('D');
      expect(bar.chords[0].chordSymbol).toBe('D');
      expect(bar.notes.map(n => n.pitch)).toEqual([62, 66, 69]);
    });

    it('follows the new scale when the degree quality changes', () => {
      appendSegment(
        chordSegment({ id: 'a', romanNumeral: 'ii', root: 'D', quality: 'minor', chordSymbol: 'Dm' })
      );
      const barId = projectStore.getState().project!.bars[0].id;
      projectStore.getState().updateBarScale(barId, { root: 'A', type: 'naturalMinor' });

      const bar = projectStore.getState().project!.bars[0];
      expect(bar.chords[0].chordSymbol).toBe('B°');
      // B diminished: B, D, F.
      expect(bar.notes.map(n => n.pitch)).toEqual([71, 74, 77]);
    });

    it('leaves other bars notes untouched', () => {
      projectStore.getState().addBar();
      appendSegment(chordSegment({ id: 'a', root: 'C', quality: 'major' }));
      const barId = projectStore.getState().project!.bars[1].id;
      projectStore.getState().updateBarScale(barId, { root: 'G', type: 'major' });
      expect(projectStore.getState().project!.bars[0].notes.map(n => n.pitch)).toEqual([60, 64, 67]);
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
