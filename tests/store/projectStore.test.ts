import { describe, it, expect, beforeEach } from 'vitest';
import { projectStore } from '@/store/projectStore';
import { Bar, ChordSegment, NoteName, ScaleType, TimeSignature } from '@/types/music';
import { barChords, barNotes } from '@/engine/timeline';
import { DEFAULT_INSTRUMENT_ID } from '@/engine/instrumentCatalog';

/**
 * The instrument these tests write to: the Piano every project is created with.
 *
 * Read live rather than captured, because most tests call `createProject` in their
 * own setup and each one mints a fresh instrument id.
 */
function trackId(): string {
  return projectStore.getState().project!.tracks[0].id;
}

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
  return barChords(bar, trackId()).reduce((max, c) => Math.max(max, (c.startBeat ?? 0) + c.duration), 0);
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
      state().insertSegment(bar.id, endOf(bar), segment, trackId());
      return;
    }
  }

  state().addBar();
  const bars = state().project!.bars;
  state().insertSegment(bars[bars.length - 1].id, 0, segment, trackId());
}

/** The bar holding a given segment, or undefined. */
function barOf(segmentId: string): Bar | undefined {
  return projectStore.getState().project!.bars.find(b => barChords(b, trackId()).some(c => c.id === segmentId));
}

/** `id@start` for every segment in a bar, so placement assertions read at a glance. */
function layout(bar: Bar): string[] {
  return barChords(bar, trackId()).map(c => `${c.id}@${c.startBeat}`);
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

    // A project with no instruments has nowhere to put a chord, so one is created
    // up front rather than waiting for the user to add it.
    it('creates one Piano instrument', () => {
      projectStore.getState().createProject();
      const tracks = projectStore.getState().project!.tracks;

      expect(tracks).toHaveLength(1);
      expect(tracks[0].name).toBe('Piano');
      expect(tracks[0].instrument).toBe(DEFAULT_INSTRUMENT_ID);
      expect(tracks[0].muted).toBe(false);
      expect(tracks[0].visible).toBe(true);
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

    it('adds an empty bar', () => {
      projectStore.getState().addBar();
      const bars = projectStore.getState().project!.bars;
      expect(bars.length).toBe(1);
      expect(bars[0].content).toEqual({});
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
      expect(barChords(bar, trackId())).toEqual([]);
      expect(barNotes(bar, trackId())).toEqual([]);
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
      expect(barChords(bars[0], trackId()).length).toBe(3);
      expect(barChords(bars[1], trackId()).length).toBe(1);
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
      projectStore.getState().insertSegment(firstBarId(), 2, chordSegment({ id: 'a' }), trackId());
      expect(layout(projectStore.getState().project!.bars[0])).toEqual(['a@2']);
    });

    it('leaves the space before a segment as silence', () => {
      projectStore.getState().insertSegment(firstBarId(), 2, chordSegment({ id: 'a' }), trackId());
      const notes = barNotes(projectStore.getState().project!.bars[0], trackId());
      expect(notes.every(n => n.startBeat === 2)).toBe(true);
    });

    it('snaps nothing itself — it places exactly where it is told', () => {
      // Snapping is the caller's job, so an unsnapped beat survives intact.
      projectStore.getState().insertSegment(firstBarId(), 1.5, chordSegment({ id: 'a' }), trackId());
      expect(barChords(projectStore.getState().project!.bars[0], trackId())[0].startBeat).toBe(1.5);
    });

    it('clamps a drop that would cross the bar line', () => {
      projectStore
        .getState()
        .insertSegment(firstBarId(), 3.5, chordSegment({ id: 'wide', duration: 2 }), trackId());
      expect(layout(projectStore.getState().project!.bars[0])).toEqual(['wide@2']);
    });

    it('pushes the block it lands on to the right', () => {
      appendSegment(chordSegment({ id: 'a' }));
      appendSegment(chordSegment({ id: 'b' }));
      projectStore.getState().insertSegment(firstBarId(), 0, chordSegment({ id: 'new' }), trackId());
      expect(layout(projectStore.getState().project!.bars[0])).toEqual(['new@0', 'a@1', 'b@2']);
    });

    it('spills the last block into the next bar when the ripple fills the bar', () => {
      for (let i = 0; i < 4; i++) appendSegment(chordSegment({ id: `s${i}` }));
      projectStore.getState().insertSegment(firstBarId(), 0, chordSegment({ id: 'new' }), trackId());
      const bars = projectStore.getState().project!.bars;
      expect(bars).toHaveLength(2);
      expect(layout(bars[0])).toEqual(['new@0', 's0@1', 's1@2', 's2@3']);
      expect(layout(bars[1])).toEqual(['s3@0']);
    });

    it('generates the triad notes for a chord segment', () => {
      projectStore
        .getState()
        .insertSegment(firstBarId(), 0, chordSegment({ root: 'C', quality: 'major' }), trackId());
      const notes = barNotes(projectStore.getState().project!.bars[0], trackId());
      expect(notes.map(n => n.pitch)).toEqual([60, 64, 67]);
    });

    it('generates four notes for a seventh chord', () => {
      projectStore
        .getState()
        .insertSegment(firstBarId(), 0, chordSegment({ root: 'C', quality: 'maj7' }), trackId());
      expect(barNotes(projectStore.getState().project!.bars[0], trackId()).length).toBe(4);
    });

    it('generates exactly one note for a note segment', () => {
      projectStore
        .getState()
        .insertSegment(firstBarId(), 0, chordSegment({ kind: 'note', pitch: 62 }), trackId());
      const notes = barNotes(projectStore.getState().project!.bars[0], trackId());
      expect(notes.length).toBe(1);
      expect(notes[0].pitch).toBe(62);
    });

    it('regenerates notes in the bar a segment overflows into', () => {
      for (let i = 0; i < 4; i++) {
        appendSegment(chordSegment({ id: `s${i}`, root: 'C', quality: 'major' }));
      }
      projectStore.getState().insertSegment(firstBarId(), 0, chordSegment({ id: 'new' }), trackId());
      const bars = projectStore.getState().project!.bars;
      expect(barNotes(bars[1], trackId()).map(n => n.pitch)).toEqual([60, 64, 67]);
      expect(barNotes(bars[1], trackId())[0].startBeat).toBe(0);
    });

    it('ignores an unknown bar id', () => {
      projectStore.getState().insertSegment('nope', 0, chordSegment({ id: 'a' }), trackId());
      expect(barChords(projectStore.getState().project!.bars[0], trackId())).toEqual([]);
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
      expect(barChords(projectStore.getState().project!.bars[0], trackId()).map(c => c.id)).toEqual(['b']);
    });

    it('empties the generated notes when the last segment goes', () => {
      appendSegment(chordSegment({ id: 'a' }));
      expect(barNotes(projectStore.getState().project!.bars[0], trackId()).length).toBe(3);
      projectStore.getState().removeSegment('a');
      expect(barNotes(projectStore.getState().project!.bars[0], trackId())).toEqual([]);
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
      expect(barChords(projectStore.getState().project!.bars[0], trackId()).length).toBe(1);
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
      expect(barNotes(bars()[0], trackId()).every(n => n.startBeat === 1)).toBe(true);
      expect(barNotes(bars()[1], trackId()).every(n => n.startBeat === 2)).toBe(true);
    });

    it('clamps a move that would cross the bar line', () => {
      projectStore.getState().resizeSegmentDuration('a', 2);
      projectStore.getState().moveSegment('a', bars()[0].id, 3.5);
      expect(barChords(barOf('a')!, trackId()).find(c => c.id === 'a')!.startBeat).toBe(2);
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
      expect(barNotes(bars()[1], trackId()).every(n => n.startBeat === 2)).toBe(true);
      expect(barNotes(bars()[0], trackId()).some(n => n.startBeat === 0)).toBe(false);
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
        .flatMap(b => barChords(b, trackId()))
        .find(c => c.id === id)!;

    beforeEach(() => {
      projectStore.getState().createProject();
      projectStore.getState().addBar();
      projectStore.getState().addBar();
      appendSegment(chordSegment({ id: 'a' }));
      // 'b' is written in G major, 'a' in the project's C — the two keys are what
      // makes "each within its own" mean anything below.
      projectStore
        .getState()
        .insertSegment(
          bars()[1].id,
          0,
          chordSegment({
            id: 'b',
            root: 'G',
            chordSymbol: 'G',
            scale: { root: 'G', type: 'major' },
          }),
          trackId()
        );
    });

    it('steps each segment within its own key', () => {
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
      expect(barChords(projectStore.getState().project!.bars[0], trackId())[0].duration).toBe(2);
    });

    it('updates the generated notes duration', () => {
      appendSegment(chordSegment({ id: 'a' }));
      projectStore.getState().resizeSegmentDuration('a', 2);
      const notes = barNotes(projectStore.getState().project!.bars[0], trackId());
      expect(notes.every(n => n.duration === 2)).toBe(true);
    });

    it('snaps to the editing grid', () => {
      appendSegment(chordSegment({ id: 'a' }));
      projectStore.getState().resizeSegmentDuration('a', 1.3);
      expect(barChords(projectStore.getState().project!.bars[0], trackId())[0].duration).toBe(1.25);
    });

    it('clamps to the containing bar capacity', () => {
      appendSegment(chordSegment({ id: 'a' }));
      projectStore.getState().resizeSegmentDuration('a', 99);
      expect(barChords(projectStore.getState().project!.bars[0], trackId())[0].duration).toBe(4);
    });

    it('caps growth at the bar line, not at the bar length', () => {
      // A block starting on beat 3 of a 4/4 bar has one beat of room, not four.
      const barId = projectStore.getState().project!.bars[0].id;
      projectStore.getState().insertSegment(barId, 3, chordSegment({ id: 'a' }), trackId());
      projectStore.getState().resizeSegmentDuration('a', 99);
      expect(barChords(projectStore.getState().project!.bars[0], trackId())[0].duration).toBe(1);
    });

    it('pushes later segments over the bar line when it grows', () => {
      appendSegment(chordSegment({ id: 'a' }));
      appendSegment(chordSegment({ id: 'b' }));
      appendSegment(chordSegment({ id: 'c' }));
      appendSegment(chordSegment({ id: 'd' }));
      projectStore.getState().resizeSegmentDuration('a', 2);
      const bars = projectStore.getState().project!.bars;
      expect(barChords(bars[0], trackId()).map(c => c.id)).toEqual(['a', 'b', 'c']);
      expect(barChords(bars[1], trackId()).map(c => c.id)).toEqual(['d']);
    });

    it('ignores an unknown segment id', () => {
      appendSegment(chordSegment({ id: 'a' }));
      projectStore.getState().resizeSegmentDuration('nope', 2);
      expect(barChords(projectStore.getState().project!.bars[0], trackId())[0].duration).toBe(1);
    });
  });

  describe('setSegmentsScale note regeneration', () => {
    const segmentOf = (id: string) =>
      projectStore
        .getState()
        .project!.bars.flatMap(b => barChords(b, trackId()))
        .find(c => c.id === id)!;

    beforeEach(() => {
      projectStore.getState().createProject();
      projectStore.getState().addBar();
    });

    it('re-interprets roman numerals against the new scale', () => {
      appendSegment(chordSegment({ id: 'a', root: undefined, quality: undefined, romanNumeral: 'I' }));
      expect(barNotes(projectStore.getState().project!.bars[0], trackId()).map(n => n.pitch)).toEqual([60, 64, 67]);

      projectStore.getState().setSegmentsScale(['a'], { root: 'D', type: 'major' });
      expect(barNotes(projectStore.getState().project!.bars[0], trackId()).map(n => n.pitch)).toEqual([62, 66, 69]);
    });

    it('retunes segments that carry an explicit root and quality', () => {
      // This is the shape the palette and splitBarIntoChords actually produce:
      // an explicit root/quality alongside the numeral.
      appendSegment(
        chordSegment({ id: 'a', romanNumeral: 'I', root: 'C', quality: 'major', chordSymbol: 'C' })
      );
      projectStore.getState().setSegmentsScale(['a'], { root: 'D', type: 'major' });

      const bar = projectStore.getState().project!.bars[0];
      expect(barChords(bar, trackId())[0].root).toBe('D');
      expect(barChords(bar, trackId())[0].chordSymbol).toBe('D');
      expect(barNotes(bar, trackId()).map(n => n.pitch)).toEqual([62, 66, 69]);
    });

    it('follows the new scale when the degree quality changes', () => {
      appendSegment(
        chordSegment({ id: 'a', romanNumeral: 'ii', root: 'D', quality: 'minor', chordSymbol: 'Dm' })
      );
      projectStore.getState().setSegmentsScale(['a'], { root: 'A', type: 'naturalMinor' });

      const bar = projectStore.getState().project!.bars[0];
      expect(barChords(bar, trackId())[0].chordSymbol).toBe('B°');
      // B diminished: B, D, F.
      expect(barNotes(bar, trackId()).map(n => n.pitch)).toEqual([71, 74, 77]);
    });

    it('records the key on the segment, so a second edit retunes from it', () => {
      appendSegment(
        chordSegment({ id: 'a', romanNumeral: 'I', root: 'C', quality: 'major', chordSymbol: 'C' })
      );
      projectStore.getState().setSegmentsScale(['a'], { root: 'D', type: 'major' });
      expect(segmentOf('a').scale).toEqual({ root: 'D', type: 'major' });

      // Retuning from D, not from the C it was written in: the tonic of E major,
      // not the supertonic that reading a stale key would give.
      projectStore.getState().setSegmentsScale(['a'], { root: 'E', type: 'major' });
      expect(segmentOf('a').chordSymbol).toBe('E');
    });

    it('changes the type across a selection without disturbing its roots', () => {
      appendSegment(
        chordSegment({
          id: 'a',
          romanNumeral: 'I',
          root: 'C',
          quality: 'major',
          scale: { root: 'C', type: 'major' },
        })
      );
      appendSegment(
        chordSegment({
          id: 'b',
          romanNumeral: 'I',
          root: 'G',
          quality: 'major',
          scale: { root: 'G', type: 'major' },
        })
      );
      projectStore.getState().setSegmentsScale(['a', 'b'], { type: 'naturalMinor' });

      expect(segmentOf('a').scale).toEqual({ root: 'C', type: 'naturalMinor' });
      expect(segmentOf('b').scale).toEqual({ root: 'G', type: 'naturalMinor' });
      expect(segmentOf('a').chordSymbol).toBe('Cm');
      expect(segmentOf('b').chordSymbol).toBe('Gm');
    });

    it('leaves unselected segments in the same bar untouched', () => {
      appendSegment(chordSegment({ id: 'a', romanNumeral: 'I', root: 'C', quality: 'major' }));
      appendSegment(chordSegment({ id: 'b', romanNumeral: 'I', root: 'C', quality: 'major' }));
      projectStore.getState().setSegmentsScale(['a'], { root: 'G', type: 'major' });

      expect(segmentOf('a').root).toBe('G');
      expect(segmentOf('b').root).toBe('C');
      expect(segmentOf('b').scale).toBeUndefined();
    });

    it('leaves the project untouched when no id matches', () => {
      appendSegment(chordSegment({ id: 'a' }));
      const before = projectStore.getState().project;
      projectStore.getState().setSegmentsScale(['nope'], { root: 'G', type: 'major' });
      projectStore.getState().setSegmentsScale([], { root: 'G', type: 'major' });
      expect(projectStore.getState().project).toBe(before);
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
      state().project!.bars.flatMap(b => barChords(b, trackId())).find(c => c.id === id)!;

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

      it('reads the key the segment is actually written in', () => {
        const segment = chordSegment({
          root: 'G',
          romanNumeral: 'VII',
          chordSymbol: 'G',
          scale: { root: 'A', type: 'naturalMinor' },
        });
        state().insertSegment(state().project!.bars[1].id, 0, segment, trackId());

        state().stepSegmentPitch(segment.id, 1);

        // A minor's VII steps up to i without changing register.
        expect(segmentOf(segment.id)).toMatchObject({ root: 'A', octave: 4 });
      });

      it('regenerates the bar\'s notes so the roll follows', () => {
        const segment = chordSegment({ romanNumeral: 'I', chordSymbol: 'C', octave: 4 });
        appendSegment(segment);
        expect(barNotes(barOf(segment.id)!, trackId()).map(n => n.pitch)).toEqual([60, 64, 67]);

        state().stepSegmentPitch(segment.id, 1);

        // Dm at octave 4.
        expect(barNotes(barOf(segment.id)!, trackId()).map(n => n.pitch)).toEqual([62, 65, 69]);
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
        expect(barNotes(barOf(segment.id)!, trackId()).map(n => n.pitch)).toEqual([72]);
      });

      it('moves a chord down a register', () => {
        const segment = chordSegment({ octave: 4 });
        appendSegment(segment);

        state().shiftSegmentOctave(segment.id, -1);

        expect(segmentOf(segment.id).octave).toBe(3);
        expect(barNotes(barOf(segment.id)!, trackId()).map(n => n.pitch)).toEqual([48, 52, 55]);
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
        expect(barNotes(barOf(segment.id)!, trackId()).map(n => n.pitch)).toEqual([64, 67, 72]);

        state().cycleSegmentInversion(segment.id);
        state().cycleSegmentInversion(segment.id);
        expect(segmentOf(segment.id).inversion).toBe(0);
        expect(barNotes(barOf(segment.id)!, trackId()).map(n => n.pitch)).toEqual([60, 64, 67]);
      });

      it('ignores an unknown segment id', () => {
        const before = state().project;
        state().cycleSegmentInversion('nope');
        expect(state().project).toBe(before);
      });
    });

    describe('voicing', () => {
      const pitchesOf = (id: string) =>
        barNotes(barOf(id)!, trackId()).map(n => n.pitch);

      it('spaces a chord by a preset and seeds the offsets it implies', () => {
        const segment = chordSegment({ octave: 4 });
        appendSegment(segment);

        state().setSegmentSpacing(segment.id, 'drop2');

        expect(segmentOf(segment.id).voicing).toMatchObject({
          spacing: 'drop2',
          offsets: [0, -1, 0],
        });
        // C major with the third dropped: 52 instead of 64.
        expect(pitchesOf(segment.id)).toEqual([52, 60, 67]);
      });

      it('makes the voicing custom when one tone is hand-tweaked', () => {
        const segment = chordSegment({ octave: 4 });
        appendSegment(segment);

        state().setSegmentSpacing(segment.id, 'drop2');
        state().setSegmentToneOffset(segment.id, 2, -1);

        expect(segmentOf(segment.id).voicing?.spacing).toBeUndefined();
        expect(pitchesOf(segment.id)).toEqual([52, 55, 60]);
      });

      it('keeps an offset on its own chord tone across an inversion change', () => {
        // The reason offsets are keyed by tone rather than by sounding position:
        // the third stays dropped when the chord rotates underneath it.
        const segment = chordSegment({ octave: 4 });
        appendSegment(segment);

        state().setSegmentToneOffset(segment.id, 1, -1);
        state().setSegmentInversion(segment.id, 1);

        expect(segmentOf(segment.id).voicing?.offsets?.[1]).toBe(-1);
        // Root and fifth rotate up to 72 and 67; the third stays where the
        // offset put it rather than following the voice that used to be there.
        expect(pitchesOf(segment.id)).toEqual([52, 67, 72]);
      });

      it('sets an absolute inversion, wrapping within the chord', () => {
        const segment = chordSegment({ octave: 4 });
        appendSegment(segment);

        state().setSegmentInversion(segment.id, 2);
        expect(segmentOf(segment.id).inversion).toBe(2);

        // A triad has three inversions, so the fourth is root position again.
        state().setSegmentInversion(segment.id, 3);
        expect(segmentOf(segment.id).inversion).toBe(0);
      });

      it('adds and removes a doubled tone', () => {
        const segment = chordSegment({ octave: 4 });
        appendSegment(segment);

        state().toggleSegmentDoubling(segment.id, 0, -1);
        expect(pitchesOf(segment.id)).toEqual([48, 60, 64, 67]);

        state().toggleSegmentDoubling(segment.id, 0, -1);
        expect(pitchesOf(segment.id)).toEqual([60, 64, 67]);
        expect(segmentOf(segment.id).voicing).toBeUndefined();
      });

      it('arpeggiates without moving or resizing the block itself', () => {
        const segment = chordSegment({ octave: 4, duration: 3 });
        appendSegment(segment);
        const before = segmentOf(segment.id);

        state().setSegmentBreak(segment.id, { mode: 'arpeggio', pattern: 'up' });

        const after = segmentOf(segment.id);
        expect(after.startBeat).toBe(before.startBeat);
        expect(after.duration).toBe(before.duration);
        expect(barNotes(barOf(segment.id)!, trackId()).map(n => n.startBeat)).toEqual([0, 1, 2]);
      });

      it('applies to a whole selection spanning different keys', () => {
        const first = chordSegment({ octave: 4 });
        appendSegment(first);
        const second = chordSegment({
          root: 'A',
          quality: 'minor',
          romanNumeral: 'i',
          octave: 4,
          scale: { root: 'A', type: 'naturalMinor' },
        });
        state().insertSegment(state().project!.bars[1].id, 0, second, trackId());

        state().setSegmentsSpacing([first.id, second.id], 'drop2');

        expect(segmentOf(first.id).voicing?.spacing).toBe('drop2');
        expect(segmentOf(second.id).voicing?.spacing).toBe('drop2');
      });

      it('restores the original notes when the voicing is cleared', () => {
        const segment = chordSegment({ octave: 4 });
        appendSegment(segment);
        const original = pitchesOf(segment.id);

        state().setSegmentSpacing(segment.id, 'open');
        state().toggleSegmentDoubling(segment.id, 0, 1);
        state().setSegmentBreak(segment.id, { mode: 'arpeggio', pattern: 'up' });
        expect(pitchesOf(segment.id)).not.toEqual(original);

        state().clearSegmentVoicing(segment.id);

        expect(segmentOf(segment.id).voicing).toBeUndefined();
        expect(pitchesOf(segment.id)).toEqual(original);
      });

      it('leaves a note segment alone — one pitch has nothing to voice', () => {
        const segment: ChordSegment = {
          id: 'note-seg',
          kind: 'note',
          pitch: 60,
          duration: 1,
        };
        appendSegment(segment);

        state().setSegmentSpacing(segment.id, 'drop2');

        expect(segmentOf(segment.id).voicing).toBeUndefined();
        expect(pitchesOf(segment.id)).toEqual([60]);
      });

      it('ignores an unknown segment id', () => {
        const before = state().project;
        state().setSegmentSpacing('nope', 'drop2');
        state().clearSegmentVoicing('nope');
        expect(state().project).toBe(before);
      });
    });
  });

  describe('instruments', () => {
    const state = () => projectStore.getState();
    const tracks = () => state().project!.tracks;
    /** The second instrument, added by the setup below. */
    const second = () => tracks()[1].id;

    beforeEach(() => {
      state().createProject();
      state().addBar();
      state().addTrack('Strings');
    });

    it('adds an instrument on the default sound', () => {
      expect(tracks()).toHaveLength(2);
      expect(tracks()[1].name).toBe('Strings');
      expect(tracks()[1].instrument).toBe(DEFAULT_INSTRUMENT_ID);
    });

    it('gives each instrument its own colour', () => {
      expect(tracks()[0].color).not.toBe(tracks()[1].color);
    });

    it('changes an instrument sound without touching the others', () => {
      state().setTrackInstrument(second(), 'string_ensemble_1');

      expect(tracks()[1].instrument).toBe('string_ensemble_1');
      expect(tracks()[0].instrument).toBe(DEFAULT_INSTRUMENT_ID);
    });

    it('toggles mute and visibility independently', () => {
      state().toggleTrackMute(second());
      expect(tracks()[1].muted).toBe(true);
      expect(tracks()[1].visible).toBe(true);

      state().toggleTrackVisible(second());
      expect(tracks()[1].muted).toBe(true);
      expect(tracks()[1].visible).toBe(false);

      state().toggleTrackVisible(second());
      expect(tracks()[1].visible).toBe(true);
    });

    it('ignores an unknown instrument id rather than throwing', () => {
      expect(() => state().toggleTrackMute('nope')).not.toThrow();
      expect(() => state().setTrackInstrument('nope', 'flute')).not.toThrow();
      expect(() => state().removeTrack('nope')).not.toThrow();
    });

    // The whole point of the per-instrument content model: writing to one
    // instrument must be invisible to every other.
    it('keeps each instrument\'s segments separate', () => {
      const barId = state().project!.bars[0].id;
      state().insertSegment(barId, 0, chordSegment({ id: 'piano-1' }), trackId());
      state().insertSegment(barId, 0, chordSegment({ id: 'strings-1' }), second());

      const bar = state().project!.bars[0];
      expect(barChords(bar, trackId()).map(c => c.id)).toEqual(['piano-1']);
      expect(barChords(bar, second()).map(c => c.id)).toEqual(['strings-1']);
    });

    it('generates notes for each instrument from its own segments', () => {
      const barId = state().project!.bars[0].id;
      state().insertSegment(barId, 0, chordSegment({ root: 'C', quality: 'major' }), trackId());
      state().insertSegment(barId, 0, chordSegment({ root: 'D', quality: 'minor' }), second());

      const bar = state().project!.bars[0];
      expect(barNotes(bar, trackId()).map(n => n.pitch)).toEqual([60, 64, 67]);
      expect(barNotes(bar, second()).map(n => n.pitch)).toEqual([62, 65, 69]);
    });

    it('drops an instrument\'s content along with the instrument', () => {
      const barId = state().project!.bars[0].id;
      state().insertSegment(barId, 0, chordSegment({ id: 'piano-1' }), trackId());
      state().insertSegment(barId, 0, chordSegment({ id: 'strings-1' }), second());
      const removed = second();

      state().removeTrack(removed);

      expect(tracks()).toHaveLength(1);
      expect(state().project!.bars[0].content[removed]).toBeUndefined();
      // The instrument that stayed keeps everything it had.
      expect(barChords(state().project!.bars[0], trackId()).map(c => c.id)).toEqual(['piano-1']);
    });

    it('refuses a segment aimed at an instrument that does not exist', () => {
      const barId = state().project!.bars[0].id;
      const before = state().project;

      state().insertSegment(barId, 0, chordSegment({ id: 'orphan' }), 'no-such-track');

      expect(state().project).toBe(before);
    });
  });

  describe('duplicateTrack', () => {
    const state = () => projectStore.getState();
    const tracks = () => state().project!.tracks;

    beforeEach(() => {
      state().createProject();
      state().addBar();
    });

    it('creates a copy with " (copy)" appended to the name', () => {
      const sourceId = trackId();
      const newId = state().duplicateTrack(sourceId);

      expect(newId).not.toBeNull();
      expect(newId).not.toBe(sourceId);
      expect(tracks()[1].name).toBe('Piano (copy)');
    });

    it('copies track settings from the source', () => {
      const sourceId = trackId();
      state().setTrackVolume(sourceId, 0.5);
      state().setTrackPan(sourceId, 0.7);
      state().toggleTrackMute(sourceId);
      state().duplicateTrack(sourceId);

      const copy = tracks().find(t => t.name === 'Piano (copy)')!;
      expect(copy.volume).toBe(0.5);
      expect(copy.pan).toBe(0.7);
      expect(copy.muted).toBe(true);
      expect(copy.solo).toBe(false);
      expect(copy.instrument).toBe(DEFAULT_INSTRUMENT_ID);
    });

    it('does not copy vst3State', () => {
      const sourceId = trackId();
      state().project = {
        ...state().project!,
        tracks: state().project!.tracks.map(t =>
          t.id === sourceId ? { ...t, vst3State: 'some-base64-data' } : t
        ),
      };
      state().duplicateTrack(sourceId);

      const copy = tracks().find(t => t.name === 'Piano (copy)')!;
      expect(copy.vst3State).toBeUndefined();
    });

    it('assigns a distinct colour', () => {
      state().duplicateTrack(trackId());
      expect(tracks()[0].color).not.toBe(tracks()[1].color);
    });

    it('inserts the copy after the source in the track list', () => {
      state().addTrack('Strings');
      const source = trackId(); // Piano, index 0
      state().duplicateTrack(source);

      expect(tracks().map(t => t.name)).toEqual(['Piano', 'Piano (copy)', 'Strings']);
    });

    it('copies chord segments across all bars with new ids', () => {
      const barId = state().project!.bars[0].id;
      state().insertSegment(barId, 0, chordSegment({ id: 'a' }), trackId());
      state().insertSegment(barId, 1, chordSegment({ id: 'b' }), trackId());

      const newId = state().duplicateTrack(trackId());
      expect(newId).not.toBeNull();

      const bar = state().project!.bars[0];
      const sourceChords = barChords(bar, trackId());
      const copyChords = barChords(bar, newId!);

      expect(copyChords.length).toBe(2);
      // New ids, not the originals
      expect(copyChords[0].id).not.toBe(sourceChords[0].id);
      expect(copyChords[1].id).not.toBe(sourceChords[1].id);
      // But same properties
      expect(copyChords[0].startBeat).toBe(sourceChords[0].startBeat);
      expect(copyChords[0].duration).toBe(sourceChords[0].duration);
      expect(copyChords[0].root).toBe(sourceChords[0].root);
      expect(copyChords[0].quality).toBe(sourceChords[0].quality);
    });

    it('copies segments across multiple bars', () => {
      state().addBar();
      const bar0 = state().project!.bars[0].id;
      const bar1 = state().project!.bars[1].id;
      state().insertSegment(bar0, 0, chordSegment({ id: 'a' }), trackId());
      state().insertSegment(bar1, 2, chordSegment({ id: 'b' }), trackId());

      const newId = state().duplicateTrack(trackId());

      expect(barChords(state().project!.bars[0], newId!).length).toBe(1);
      expect(barChords(state().project!.bars[1], newId!).length).toBe(1);
      expect(barChords(state().project!.bars[1], newId!)[0].startBeat).toBe(2);
    });

    it('skips bars the source has no content in', () => {
      state().addBar();
      state().addBar();
      // Only bar 0 has content; bars 1 and 2 are empty for this track
      state().insertSegment(state().project!.bars[0].id, 0, chordSegment({ id: 'a' }), trackId());

      const newId = state().duplicateTrack(trackId());

      // Copy only has content in bar 0
      expect(state().project!.bars[0].content[newId!]).toBeDefined();
      expect(state().project!.bars[1].content[newId!]).toBeUndefined();
      expect(state().project!.bars[2].content[newId!]).toBeUndefined();
    });

    it('regenerates notes for the copy', () => {
      const barId = state().project!.bars[0].id;
      state().insertSegment(barId, 0, chordSegment({ root: 'C', quality: 'major' }), trackId());

      const newId = state().duplicateTrack(trackId());

      const copyNotes = barNotes(state().project!.bars[0], newId!);
      expect(copyNotes.map(n => n.pitch)).toEqual([60, 64, 67]);
    });

    it('copies voicing from source segments', () => {
      const barId = state().project!.bars[0].id;
      const seg = chordSegment({ id: 'a', root: 'C', quality: 'major', octave: 4 });
      state().insertSegment(barId, 0, seg, trackId());
      state().setSegmentSpacing(seg.id, 'drop2');

      const newId = state().duplicateTrack(trackId());
      const copySeg = barChords(state().project!.bars[0], newId!)[0];

      expect(copySeg.voicing).toMatchObject({ spacing: 'drop2', offsets: [0, -1, 0] });
    });

    it('copies segment keys (scale) from source segments', () => {
      const barId = state().project!.bars[0].id;
      const seg = chordSegment({
        id: 'a',
        root: 'G',
        quality: 'major',
        romanNumeral: 'V',
        scale: { root: 'C', type: 'major' },
      });
      state().insertSegment(barId, 0, seg, trackId());

      const newId = state().duplicateTrack(trackId());
      const copySeg = barChords(state().project!.bars[0], newId!)[0];

      expect(copySeg.scale).toEqual({ root: 'C', type: 'major' });
    });

    it('leaves the source instrument untouched', () => {
      const barId = state().project!.bars[0].id;
      state().insertSegment(barId, 0, chordSegment({ id: 'a' }), trackId());

      const before = barChords(state().project!.bars[0], trackId());
      state().duplicateTrack(trackId());

      expect(barChords(state().project!.bars[0], trackId())).toEqual(before);
    });

    it('returns null when source track id does not exist', () => {
      const result = state().duplicateTrack('nope');
      expect(result).toBeNull();
    });

    it('returns null when no project exists', () => {
      state().resetProject();
      const result = state().duplicateTrack('anything');
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // pasteSegments
  // ---------------------------------------------------------------------------

  describe('pasteSegments', () => {
    const state = () => projectStore.getState();

    it('returns null when no project exists', () => {
      state().resetProject();
      const result = state().pasteSegments([], 'track-x', 0);
      expect(result).toBeNull();
    });

    it('returns null when segments list is empty', () => {
      state().createProject();
      const result = state().pasteSegments([], trackId(), 0);
      expect(result).toBeNull();
    });

    it('returns null when target track does not exist', () => {
      state().createProject();
      const result = state().pasteSegments(
        [
          {
            segment: { kind: 'chord' as const, duration: 1, root: 'C', quality: 'major' as const },
            startBeat: 0,
            barIndex: 0,
            baseStartBeat: 0,
          },
        ],
        'nope',
        0
      );
      expect(result).toBeNull();
    });

    it('pastes a single segment into the target bar', () => {
      state().createProject();
      state().addBar(); // bar 0 at index 0
      state().insertSegment(state().project!.bars[0].id, 0, chordSegment({ root: 'C', quality: 'major', duration: 1 }), trackId());
      state().addBar(); // bar 1 at index 1

      const before = state().project!.bars.length;
      const ids = state().pasteSegments(
        [
          {
            segment: { kind: 'chord', duration: 1, root: 'D', quality: 'minor' as const },
            startBeat: 0,
            barIndex: 0,
            baseStartBeat: 0,
          },
        ],
        trackId(),
        1
      );

      expect(ids).not.toBeNull();
      expect(ids!.length).toBe(1);

      const bar = state().project!.bars[1];
      const chords = barChords(bar, trackId());
      expect(chords.length).toBe(1);
      expect(chords[0].root).toBe('D');
      expect(chords[0].quality).toBe('minor');
      expect(chords[0].startBeat).toBe(0);
      expect(chords[0].duration).toBe(1);
      // Pasted segments get a fresh id.
      expect(chords[0].id).not.toBe('seg-paste-target');
      expect(state().project!.bars.length).toBe(before);
    });

    it('pastes a single segment at an offset within the target bar', () => {
      state().createProject();
      state().addBar(); // bar 0
      state().insertSegment(state().project!.bars[0].id, 0, chordSegment({ duration: 1 }), trackId());
      state().addBar(); // bar 1

      state().pasteSegments(
        [
          {
            segment: { kind: 'chord', duration: 1, root: 'E', quality: 'major' as const },
            startBeat: 2,
            barIndex: 0,
            baseStartBeat: 0,
          },
        ],
        trackId(),
        1
      );

      const bar = state().project!.bars[1];
      const chords = barChords(bar, trackId());
      expect(chords.length).toBe(1);
      expect(chords[0].startBeat).toBe(2);
    });

    it('offsets multiple segments so the first lands at the cursor', () => {
      state().createProject();
      state().addBar(); // bar 0
      state().addBar(); // bar 1

      // Paste two segments: originally at startBeat 0 and 2 in bar 0,
      // into bar 1 with baseStartBeat 0. The offset is 0, so positions stay.
      state().pasteSegments(
        [
          {
            segment: { kind: 'chord', duration: 1, root: 'C', quality: 'major' as const },
            startBeat: 0,
            barIndex: 0,
            baseStartBeat: 0,
          },
          {
            segment: { kind: 'chord', duration: 1, root: 'E', quality: 'major' as const },
            startBeat: 2,
            barIndex: 0,
            baseStartBeat: 0,
          },
        ],
        trackId(),
        1
      );

      const bar = state().project!.bars[1];
      const chords = barChords(bar, trackId());
      expect(chords.length).toBe(2);
      expect(chords[0].startBeat).toBe(0);
      expect(chords[1].startBeat).toBe(2);
    });

    it('shifts segments when baseStartBeat is non-zero', () => {
      state().createProject();
      state().addBar(); // bar 0
      state().addBar(); // bar 1

      // Segments at startBeat 1 and 3, baseStartBeat 1.
      // Paste target is bar 1 with offsetBarIndex 1.
      // offset = startBeat - baseStartBeat = 0 for the first segment.
      // So first segment lands at 0, second at 2.
      state().pasteSegments(
        [
          {
            segment: { kind: 'chord', duration: 1, root: 'A', quality: 'minor' as const },
            startBeat: 1,
            barIndex: 0,
            baseStartBeat: 1,
          },
          {
            segment: { kind: 'chord', duration: 1, root: 'B', quality: 'minor' as const },
            startBeat: 3,
            barIndex: 0,
            baseStartBeat: 1,
          },
        ],
        trackId(),
        1
      );

      const bar = state().project!.bars[1];
      const chords = barChords(bar, trackId());
      expect(chords.length).toBe(2);
      // Offset: startBeat - baseStartBeat = 1 - 1 = 0 for first, 3 - 1 = 2 for second
      expect(chords[0].startBeat).toBe(0);
      expect(chords[1].startBeat).toBe(2);
    });

    it('appends bars when the paste destination exceeds existing bars', () => {
      state().createProject();
      // No bars exist yet

      const before = state().project!.bars.length;
      const ids = state().pasteSegments(
        [
          {
            segment: { kind: 'chord', duration: 1, root: 'X', quality: 'major' as const },
            startBeat: 0,
            barIndex: 2, // bar index 2 — needs bars 0, 1, 2
            baseStartBeat: 0,
          },
        ],
        trackId(),
        1
      );

      expect(ids).not.toBeNull();
      expect(state().project!.bars.length).toBe(before + 2);
      // The segment was at barIndex 2, offsetBarIndex 1, so target bar = 1 + (2 - 2) = 1
      const targetBar = state().project!.bars[1];
      const chords = barChords(targetBar, trackId());
      expect(chords.length).toBe(1);
      expect(chords[0].root).toBe('X');
    });

    it('preserves original segment properties (voicing, scale, etc.)', () => {
      state().createProject();
      state().addBar(); // bar 0
      state().addBar(); // bar 1

      state().pasteSegments(
        [
          {
            segment: {
              kind: 'chord',
              duration: 2,
              root: 'G',
              quality: 'dominant7' as const,
              inversion: 1,
              octave: 5,
              scale: { root: 'C' as NoteName, type: 'major' as ScaleType },
              voicing: { spacing: 'open' as const },
            },
            startBeat: 0,
            barIndex: 0,
            baseStartBeat: 0,
          },
        ],
        trackId(),
        1
      );

      const bar = state().project!.bars[1];
      const chords = barChords(bar, trackId());
      expect(chords.length).toBe(1);
      expect(chords[0].root).toBe('G');
      expect(chords[0].quality).toBe('dominant7');
      expect(chords[0].inversion).toBe(1);
      expect(chords[0].octave).toBe(5);
      expect(chords[0].scale).toEqual({ root: 'C', type: 'major' });
      expect(chords[0].voicing).toEqual({ spacing: 'open' });
    });

    it('does not affect segments in other tracks', () => {
      state().createProject();
      state().addBar(); // bar 0
      const otherTrackId = state().addTrack('Other');
      state().insertSegment(state().project!.bars[0].id, 0, chordSegment({ root: 'C' }), trackId());
      state().insertSegment(state().project!.bars[0].id, 0, chordSegment({ root: 'C' }), otherTrackId!);
      state().addBar(); // bar 1

      state().pasteSegments(
        [
          {
            segment: { kind: 'chord', duration: 1, root: 'P', quality: 'major' as const },
            startBeat: 0,
            barIndex: 0,
            baseStartBeat: 0,
          },
        ],
        trackId(),
        1
      );

      // Target track has the pasted segment in bar 1
      const targetBar = state().project!.bars[1];
      expect(barChords(targetBar, trackId()).length).toBe(1);
      expect(barChords(targetBar, trackId())[0].root).toBe('P');

      // Other track is untouched
      expect(barChords(targetBar, otherTrackId!).length).toBe(0);
    });
  });
});
