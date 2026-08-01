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

/** Beats occupied in a bar, i.e. where the next block butts up against the last. */
function endOf(bar: Bar): number {
  return bar.chords.reduce((max, c) => Math.max(max, (c.startBeat ?? 0) + c.duration), 0);
}

/**
 * Place a segment in the first bar with room for it, adding a bar when none has any.
 * With free placement there is no "end of the list" to append to, so tests that only
 * care about a filled bar say so this way.
 */
function appendSegment(segment: ChordSegment): void {
  const state = () => projectStore.getState();
  const project = state().project!;

  for (const bar of project.bars) {
    const capacity = (bar.timeSignature ?? project.timeSignature).beatsPerMeasure;
    if (endOf(bar) + segment.duration <= capacity) {
      state().insertSegment(bar.id, endOf(bar), segment);
      return;
    }
  }

  state().addBar();
  const bars = state().project!.bars;
  state().insertSegment(bars[bars.length - 1].id, 0, segment);
}

/** The bar holding a given segment, or undefined. */
function barOf(segmentId: string): Bar | undefined {
  return projectStore.getState().project!.bars.find(b => b.chords.some(c => c.id === segmentId));
}

/** `id@start` for every segment in a bar, so placement assertions read at a glance. */
function layout(bar: Bar): string[] {
  return bar.chords.map(c => `${c.id}@${c.startBeat}`);
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

    const firstBarId = () => projectStore.getState().project!.bars[0].id;

    it('inserts a segment at the beat it was dropped on', () => {
      projectStore.getState().insertSegment(firstBarId(), 2, chordSegment({ id: 'a' }));
      expect(layout(projectStore.getState().project!.bars[0])).toEqual(['a@2']);
    });

    it('leaves the space before a segment as silence', () => {
      projectStore.getState().insertSegment(firstBarId(), 2, chordSegment({ id: 'a' }));
      const notes = projectStore.getState().project!.bars[0].notes;
      expect(notes.every(n => n.startBeat === 2)).toBe(true);
    });

    it('snaps nothing itself — it places exactly where it is told', () => {
      // Snapping is the caller's job, so an unsnapped beat survives intact.
      projectStore.getState().insertSegment(firstBarId(), 1.5, chordSegment({ id: 'a' }));
      expect(projectStore.getState().project!.bars[0].chords[0].startBeat).toBe(1.5);
    });

    it('clamps a drop that would cross the bar line', () => {
      projectStore
        .getState()
        .insertSegment(firstBarId(), 3.5, chordSegment({ id: 'wide', duration: 2 }));
      expect(layout(projectStore.getState().project!.bars[0])).toEqual(['wide@2']);
    });

    it('pushes the block it lands on to the right', () => {
      appendSegment(chordSegment({ id: 'a' }));
      appendSegment(chordSegment({ id: 'b' }));
      projectStore.getState().insertSegment(firstBarId(), 0, chordSegment({ id: 'new' }));
      expect(layout(projectStore.getState().project!.bars[0])).toEqual(['new@0', 'a@1', 'b@2']);
    });

    it('spills the last block into the next bar when the ripple fills the bar', () => {
      for (let i = 0; i < 4; i++) appendSegment(chordSegment({ id: `s${i}` }));
      projectStore.getState().insertSegment(firstBarId(), 0, chordSegment({ id: 'new' }));
      const bars = projectStore.getState().project!.bars;
      expect(bars).toHaveLength(2);
      expect(layout(bars[0])).toEqual(['new@0', 's0@1', 's1@2', 's2@3']);
      expect(layout(bars[1])).toEqual(['s3@0']);
    });

    it('generates the triad notes for a chord segment', () => {
      projectStore
        .getState()
        .insertSegment(firstBarId(), 0, chordSegment({ root: 'C', quality: 'major' }));
      const notes = projectStore.getState().project!.bars[0].notes;
      expect(notes.map(n => n.pitch)).toEqual([60, 64, 67]);
    });

    it('generates four notes for a seventh chord', () => {
      projectStore
        .getState()
        .insertSegment(firstBarId(), 0, chordSegment({ root: 'C', quality: 'maj7' }));
      expect(projectStore.getState().project!.bars[0].notes.length).toBe(4);
    });

    it('generates exactly one note for a note segment', () => {
      projectStore
        .getState()
        .insertSegment(firstBarId(), 0, chordSegment({ kind: 'note', pitch: 62 }));
      const notes = projectStore.getState().project!.bars[0].notes;
      expect(notes.length).toBe(1);
      expect(notes[0].pitch).toBe(62);
    });

    it('regenerates notes in the bar a segment overflows into', () => {
      for (let i = 0; i < 4; i++) {
        appendSegment(chordSegment({ id: `s${i}`, root: 'C', quality: 'major' }));
      }
      projectStore.getState().insertSegment(firstBarId(), 0, chordSegment({ id: 'new' }));
      const bars = projectStore.getState().project!.bars;
      expect(bars[1].notes.map(n => n.pitch)).toEqual([60, 64, 67]);
      expect(bars[1].notes[0].startBeat).toBe(0);
    });

    it('ignores an unknown bar id', () => {
      projectStore.getState().insertSegment('nope', 0, chordSegment({ id: 'a' }));
      expect(projectStore.getState().project!.bars[0].chords).toEqual([]);
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

    it('leaves the hole where a segment was, rather than closing it up', () => {
      // The gap is now the point: deleting a block writes a rest, it does not
      // drag everything after it a beat earlier.
      for (let i = 0; i < 3; i++) appendSegment(chordSegment({ id: `s${i}` }));
      projectStore.getState().removeSegment('s0');
      expect(layout(projectStore.getState().project!.bars[0])).toEqual(['s1@1', 's2@2']);
    });

    it('ignores an unknown segment id', () => {
      appendSegment(chordSegment({ id: 'a' }));
      projectStore.getState().removeSegment('nope');
      expect(projectStore.getState().project!.bars[0].chords.length).toBe(1);
    });
  });

  describe('moveSegment', () => {
    const bars = () => projectStore.getState().project!.bars;

    beforeEach(() => {
      projectStore.getState().createProject();
      projectStore.getState().addBar();
      projectStore.getState().addBar();
      appendSegment(chordSegment({ id: 'a' }));
      appendSegment(chordSegment({ id: 'b' }));
    });

    it('moves a segment to a free beat in its own bar', () => {
      projectStore.getState().moveSegment('a', bars()[0].id, 3);
      expect(layout(bars()[0])).toEqual(['b@1', 'a@3']);
    });

    it('moves a segment into another bar', () => {
      projectStore.getState().moveSegment('a', bars()[1].id, 2);
      expect(layout(bars()[0])).toEqual(['b@1']);
      expect(layout(bars()[1])).toEqual(['a@2']);
      expect(barOf('a')!.id).toBe(bars()[1].id);
    });

    it('regenerates the notes in both the bar it left and the bar it joined', () => {
      projectStore.getState().moveSegment('a', bars()[1].id, 2);
      expect(bars()[0].notes.every(n => n.startBeat === 1)).toBe(true);
      expect(bars()[1].notes.every(n => n.startBeat === 2)).toBe(true);
    });

    it('clamps a move that would cross the bar line', () => {
      projectStore.getState().resizeSegmentDuration('a', 2);
      projectStore.getState().moveSegment('a', bars()[0].id, 3.5);
      expect(barOf('a')!.chords.find(c => c.id === 'a')!.startBeat).toBe(2);
    });

    it('pushes a block it is dropped on top of', () => {
      projectStore.getState().moveSegment('a', bars()[0].id, 1);
      expect(layout(bars()[0])).toEqual(['a@1', 'b@2']);
    });

    it('ignores an unknown segment or bar id', () => {
      projectStore.getState().moveSegment('nope', bars()[0].id, 2);
      projectStore.getState().moveSegment('a', 'nope', 2);
      expect(layout(bars()[0])).toEqual(['a@0', 'b@1']);
    });
  });

  describe('moveSegments', () => {
    const bars = () => projectStore.getState().project!.bars;

    beforeEach(() => {
      projectStore.getState().createProject();
      projectStore.getState().addBar();
      projectStore.getState().addBar();
      appendSegment(chordSegment({ id: 'a' }));
      appendSegment(chordSegment({ id: 'b' }));
      appendSegment(chordSegment({ id: 'c' }));
    });

    it('moves several blocks in one call', () => {
      projectStore.getState().moveSegments([
        { segmentId: 'a', targetBarId: bars()[0].id, startBeat: 1 },
        { segmentId: 'b', targetBarId: bars()[0].id, startBeat: 2 },
      ]);
      expect(layout(bars()[0])).toEqual(['a@1', 'b@2', 'c@3']);
    });

    it('swaps two blocks without either rippling the other', () => {
      // Each lands where the other was. Lifting both out first is what makes this
      // work: placed one at a time, the first would push the second aside.
      projectStore.getState().moveSegments([
        { segmentId: 'a', targetBarId: bars()[0].id, startBeat: 1 },
        { segmentId: 'b', targetBarId: bars()[0].id, startBeat: 0 },
      ]);
      expect(layout(bars()[0])).toEqual(['b@0', 'a@1', 'c@2']);
    });

    it('is order-independent: the destinations decide the ripple', () => {
      const listedBackwards = () => {
        projectStore.getState().createProject();
        projectStore.getState().addBar();
        appendSegment(chordSegment({ id: 'a' }));
        appendSegment(chordSegment({ id: 'b' }));
        projectStore.getState().moveSegments([
          { segmentId: 'b', targetBarId: bars()[0].id, startBeat: 3 },
          { segmentId: 'a', targetBarId: bars()[0].id, startBeat: 2 },
        ]);
        return layout(bars()[0]);
      };
      expect(listedBackwards()).toEqual(['a@2', 'b@3']);
    });

    it('carries a selection into another bar together', () => {
      projectStore.getState().moveSegments([
        { segmentId: 'a', targetBarId: bars()[1].id, startBeat: 0 },
        { segmentId: 'b', targetBarId: bars()[1].id, startBeat: 1 },
      ]);
      expect(layout(bars()[0])).toEqual(['c@2']);
      expect(layout(bars()[1])).toEqual(['a@0', 'b@1']);
    });

    it('clamps each block inside its own destination bar', () => {
      projectStore.getState().resizeSegmentDuration('a', 2);
      projectStore.getState().moveSegments([
        { segmentId: 'a', targetBarId: bars()[1].id, startBeat: 3.5 },
      ]);
      expect(layout(bars()[1])).toEqual(['a@2']);
    });

    it('regenerates notes once, for every bar the batch touched', () => {
      projectStore.getState().moveSegments([
        { segmentId: 'a', targetBarId: bars()[1].id, startBeat: 2 },
      ]);
      expect(bars()[1].notes.every(n => n.startBeat === 2)).toBe(true);
      expect(bars()[0].notes.some(n => n.startBeat === 0)).toBe(false);
    });

    it('skips unknown ids rather than failing the whole gesture', () => {
      projectStore.getState().moveSegments([
        { segmentId: 'nope', targetBarId: bars()[0].id, startBeat: 3 },
        { segmentId: 'a', targetBarId: 'no-such-bar', startBeat: 3 },
        { segmentId: 'c', targetBarId: bars()[1].id, startBeat: 0 },
      ]);
      expect(layout(bars()[0])).toEqual(['a@0', 'b@1']);
      expect(layout(bars()[1])).toEqual(['c@0']);
    });

    it('leaves the project untouched when nothing resolves', () => {
      const before = projectStore.getState().project;
      projectStore.getState().moveSegments([]);
      projectStore
        .getState()
        .moveSegments([{ segmentId: 'nope', targetBarId: bars()[0].id, startBeat: 1 }]);
      expect(projectStore.getState().project).toBe(before);
    });
  });

  describe('multi-segment pitch edits', () => {
    const bars = () => projectStore.getState().project!.bars;
    const segmentOf = (id: string) =>
      bars()
        .flatMap(b => b.chords)
        .find(c => c.id === id)!;

    beforeEach(() => {
      projectStore.getState().createProject();
      projectStore.getState().addBar();
      projectStore.getState().addBar();
      appendSegment(chordSegment({ id: 'a' }));
      projectStore.getState().updateBarScale(bars()[1].id, { root: 'G', type: 'major' });
      projectStore
        .getState()
        .insertSegment(bars()[1].id, 0, chordSegment({ id: 'b', root: 'G', chordSymbol: 'G' }));
    });

    it('steps each segment within its own bar’s scale', () => {
      projectStore.getState().stepSegmentsPitch(['a', 'b'], 1);
      expect(segmentOf('a').root).toBe('D');
      expect(segmentOf('b').root).toBe('A');
    });

    it('shifts every named segment an octave', () => {
      projectStore.getState().shiftSegmentsOctave(['a', 'b'], 1);
      expect(segmentOf('a').octave).toBe(5);
      expect(segmentOf('b').octave).toBe(5);
    });

    it('cycles every named segment’s inversion', () => {
      projectStore.getState().cycleSegmentsInversion(['a', 'b']);
      expect(segmentOf('a').inversion).toBe(1);
      expect(segmentOf('b').inversion).toBe(1);
    });

    it('ignores unknown ids, editing the ones it recognizes', () => {
      projectStore.getState().stepSegmentsPitch(['nope', 'a'], 1);
      expect(segmentOf('a').root).toBe('D');
    });

    it('leaves the project untouched when no id matches', () => {
      const before = projectStore.getState().project;
      projectStore.getState().stepSegmentsPitch(['nope'], 1);
      projectStore.getState().stepSegmentsPitch([], 1);
      expect(projectStore.getState().project).toBe(before);
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

    it('caps growth at the bar line, not at the bar length', () => {
      // A block starting on beat 3 of a 4/4 bar has one beat of room, not four.
      const barId = projectStore.getState().project!.bars[0].id;
      projectStore.getState().insertSegment(barId, 3, chordSegment({ id: 'a' }));
      projectStore.getState().resizeSegmentDuration('a', 99);
      expect(projectStore.getState().project!.bars[0].chords[0].duration).toBe(1);
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

  describe('play range', () => {
    const state = () => projectStore.getState();
    const project = () => state().project!;

    beforeEach(() => {
      state().createProject();
      state().addBar();
      state().addBar(); // two 4/4 bars: eight beats of song
    });

    it('starts with no range and repeat off', () => {
      expect(project().loopStart).toBeUndefined();
      expect(project().loopEnd).toBeUndefined();
      expect(project().loopEnabled).toBeFalsy();
    });

    it('stores a range', () => {
      state().setLoopRegion(1, 5);
      expect([project().loopStart, project().loopEnd]).toEqual([1, 5]);
    });

    it('orders a backwards range', () => {
      state().setLoopRegion(6, 2);
      expect([project().loopStart, project().loopEnd]).toEqual([2, 6]);
    });

    it('clamps a range to the length of the song', () => {
      state().setLoopRegion(-3, 99);
      expect([project().loopStart, project().loopEnd]).toEqual([0, 8]);
    });

    it('ignores a range too short to hear, keeping the previous one', () => {
      state().setLoopRegion(1, 5);
      state().setLoopRegion(2, 2);
      expect([project().loopStart, project().loopEnd]).toEqual([1, 5]);
    });

    it('clears the range when a bound is null', () => {
      state().setLoopRegion(1, 5);
      state().setLoopRegion(null, null);
      expect([project().loopStart, project().loopEnd]).toEqual([undefined, undefined]);
    });

    it('toggles repeat without touching the range', () => {
      state().setLoopRegion(1, 5);

      state().toggleLoopEnabled();
      expect(project().loopEnabled).toBe(true);
      expect([project().loopStart, project().loopEnd]).toEqual([1, 5]);

      state().toggleLoopEnabled();
      expect(project().loopEnabled).toBe(false);
    });
  });

  describe('segment pitch editing', () => {
    const state = () => projectStore.getState();

    /** The segment with this id, wherever in the project it lives. */
    const segmentOf = (id: string): ChordSegment =>
      state().project!.bars.flatMap(b => b.chords).find(c => c.id === id)!;

    beforeEach(() => {
      state().createProject();
      state().addBar();
      state().addBar();
    });

    describe('stepSegmentPitch', () => {
      it('moves a chord to the next degree of its own bar\'s scale', () => {
        const segment = chordSegment({ romanNumeral: 'I', chordSymbol: 'C', octave: 4 });
        appendSegment(segment);

        state().stepSegmentPitch(segment.id, 1);

        expect(segmentOf(segment.id)).toMatchObject({ root: 'D', romanNumeral: 'ii' });
      });

      it('reads the scale of the bar the segment is actually in', () => {
        const bars = state().project!.bars;
        state().updateBarScale(bars[1].id, { root: 'A', type: 'naturalMinor' });

        const segment = chordSegment({ root: 'G', romanNumeral: 'VII', chordSymbol: 'G' });
        state().insertSegment(state().project!.bars[1].id, 0, segment);

        state().stepSegmentPitch(segment.id, 1);

        // A minor's VII steps up to i without changing register.
        expect(segmentOf(segment.id)).toMatchObject({ root: 'A', octave: 4 });
      });

      it('regenerates the bar\'s notes so the roll follows', () => {
        const segment = chordSegment({ romanNumeral: 'I', chordSymbol: 'C', octave: 4 });
        appendSegment(segment);
        expect(barOf(segment.id)!.notes.map(n => n.pitch)).toEqual([60, 64, 67]);

        state().stepSegmentPitch(segment.id, 1);

        // Dm at octave 4.
        expect(barOf(segment.id)!.notes.map(n => n.pitch)).toEqual([62, 65, 69]);
      });

      it('ignores an unknown segment id', () => {
        const before = state().project;
        state().stepSegmentPitch('nope', 1);
        expect(state().project).toBe(before);
      });
    });

    describe('shiftSegmentOctave', () => {
      it('moves a note a full octave and resyncs its note', () => {
        const segment = chordSegment({ kind: 'note', pitch: 60, quality: undefined });
        appendSegment(segment);

        state().shiftSegmentOctave(segment.id, 1);

        expect(segmentOf(segment.id).pitch).toBe(72);
        expect(barOf(segment.id)!.notes.map(n => n.pitch)).toEqual([72]);
      });

      it('moves a chord down a register', () => {
        const segment = chordSegment({ octave: 4 });
        appendSegment(segment);

        state().shiftSegmentOctave(segment.id, -1);

        expect(segmentOf(segment.id).octave).toBe(3);
        expect(barOf(segment.id)!.notes.map(n => n.pitch)).toEqual([48, 52, 55]);
      });

      it('ignores an unknown segment id', () => {
        const before = state().project;
        state().shiftSegmentOctave('nope', 1);
        expect(state().project).toBe(before);
      });
    });

    describe('cycleSegmentInversion', () => {
      it('rotates the voicing and cycles back to root position', () => {
        const segment = chordSegment({ octave: 4 });
        appendSegment(segment);

        state().cycleSegmentInversion(segment.id);
        expect(segmentOf(segment.id).inversion).toBe(1);
        expect(barOf(segment.id)!.notes.map(n => n.pitch)).toEqual([64, 67, 72]);

        state().cycleSegmentInversion(segment.id);
        state().cycleSegmentInversion(segment.id);
        expect(segmentOf(segment.id).inversion).toBe(0);
        expect(barOf(segment.id)!.notes.map(n => n.pitch)).toEqual([60, 64, 67]);
      });

      it('ignores an unknown segment id', () => {
        const before = state().project;
        state().cycleSegmentInversion('nope');
        expect(state().project).toBe(before);
      });
    });
  });
});
