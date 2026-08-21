import { describe, it, expect, beforeEach } from 'vitest';
import { projectStore } from '@/store/projectStore';
import { Bar, ChordSegment, NoteName, ScaleType } from '@/types/music';
import { barChords, barNotes } from '@/engine/timeline';
import { laneKey } from '@/engine/parameterAutomation';
import { DEFAULT_INSTRUMENT_ID } from '@/engine/instrumentCatalog';
import type { TemplateInstrument } from '@/engine/instrumentTemplate';
import { addEditableBar, editKey, editableBars, openTestPhrase } from '../helpers/phrases';
import { PHRASE_TRACK_KEY } from '@/engine/phrases';

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
  return barChords(bar, editKey(trackId())).reduce((max, c) => Math.max(max, (c.startBeat ?? 0) + c.duration), 0);
}

/**
 * Place a segment in the first bar with room for it, adding a bar when none has any.
 * With free placement there is no "end of the list" to append to, so tests that only
 * care about a filled bar say so this way.
 */
function appendSegment(segment: ChordSegment): void {
  const state = () => projectStore.getState();
  const project = state().project!;

  for (const bar of editableBars()) {
    const capacity = (bar.timeSignature ?? project.timeSignature).beatsPerMeasure;
    if (endOf(bar) + segment.duration <= capacity) {
      state().insertSegment(bar.id, endOf(bar), segment, trackId());
      return;
    }
  }

  addEditableBar();
  const bars = editableBars();
  state().insertSegment(bars[bars.length - 1].id, 0, segment, trackId());
}

/** The bar holding a given segment, or undefined. */
function barOf(segmentId: string): Bar | undefined {
  return editableBars().find(b => barChords(b, editKey(trackId())).some(c => c.id === segmentId));
}

/** `id@start` for every segment in a bar, so placement assertions read at a glance. */
function layout(bar: Bar): string[] {
  return barChords(bar, editKey(trackId())).map(c => `${c.id}@${c.startBeat}`);
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
      expect(editableBars()).toEqual([]);
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
      addEditableBar();
      const bars = editableBars();
      expect(bars.length).toBe(1);
      expect(bars[0].content).toEqual({});
    });

    it('increments barIndex sequentially', () => {
      addEditableBar();
      addEditableBar();
      addEditableBar();
      const bars = editableBars();
      expect(bars[0].barIndex).toBe(0);
      expect(bars[1].barIndex).toBe(1);
      expect(bars[2].barIndex).toBe(2);
    });

    it('generates a unique bar id', () => {
      addEditableBar();
      addEditableBar();
      const bars = editableBars();
      expect(bars[0].id).not.toBe(bars[1].id);
    });

    it('creates empty chords and notes arrays', () => {
      addEditableBar();
      const bar = editableBars()[0];
      expect(barChords(bar, editKey(trackId()))).toEqual([]);
      expect(barNotes(bar, editKey(trackId()))).toEqual([]);
    });

    it('creates multiple bars correctly', () => {
      for (let i = 0; i < 8; i++) {
        addEditableBar();
      }
      expect(editableBars().length).toBe(8);
    });
  });

  describe('removeBar', () => {
    beforeEach(() => {
      projectStore.getState().createProject();
      addEditableBar();
      addEditableBar();
      addEditableBar();
    });

    it('removes a bar by id', () => {
      const barId = editableBars()[1].id;
      projectStore.getState().removeBar(barId);
      expect(editableBars().length).toBe(2);
    });

    it('removes the correct bar', () => {
      const middleBar = editableBars()[1];
      projectStore.getState().removeBar(middleBar.id);
      const bars = editableBars();
      expect(bars[0].id).toBe(editableBars()[0].id);
      expect(bars[1].id).not.toBe(middleBar.id);
    });

    it('throws when bar id does not exist', () => {
      expect(() => projectStore.getState().removeBar('nonexistent-id')).toThrow('Bar not found');
    });

    it('allows removing the last bar', () => {
      const lastBar = editableBars()[2];
      projectStore.getState().removeBar(lastBar.id);
      expect(editableBars().length).toBe(2);
    });

    it('allows removing all bars', () => {
      const bars = [...editableBars()];
      for (const bar of bars) {
        projectStore.getState().removeBar(bar.id);
      }
      expect(editableBars().length).toBe(0);
    });
  });

  describe('insertBar', () => {
    const state = () => projectStore.getState();

    beforeEach(() => {
      state().createProject();
      addEditableBar();
      addEditableBar();
      addEditableBar();
    });

    it('inserts a fresh empty bar at the front and shifts the originals', () => {
      const originalIds = editableBars().map(b => b.id);

      state().insertBar(0, 1);

      const bars = editableBars();
      expect(bars).toHaveLength(4);
      expect(bars[0].content).toEqual({});
      expect(bars[0].id).not.toBe(originalIds[0]);
      expect(bars.map(b => b.id)).toEqual([bars[0].id, ...originalIds]);
      expect(bars.map(b => b.barIndex)).toEqual([0, 1, 2, 3]);
    });

    it('inserts a bar in the middle and re-indexes the bars after it', () => {
      const ids = editableBars().map(b => b.id);

      state().insertBar(2, 1);

      const bars = editableBars();
      expect(bars).toHaveLength(4);
      expect(bars.map(b => b.id)).toEqual([ids[0], ids[1], bars[2].id, ids[2]]);
      expect(bars.map(b => b.barIndex)).toEqual([0, 1, 2, 3]);
      expect(bars[2].content).toEqual({});
    });

    it('appends a bar at the end when the index is at the end', () => {
      const ids = editableBars().map(b => b.id);

      state().insertBar(3, 1);

      const bars = editableBars();
      expect(bars).toHaveLength(4);
      expect(bars.map(b => b.id)).toEqual([...ids, bars[3].id]);
      expect(bars[3].barIndex).toBe(3);
    });

    it('inserts several bars at once, re-indexing the whole list', () => {
      state().insertBar(1, 2);

      const bars = editableBars();
      expect(bars).toHaveLength(5);
      expect(bars.map(b => b.barIndex)).toEqual([0, 1, 2, 3, 4]);
    });

    it('preserves the existing bars\' content while shifting their indexes', () => {
      // Placed at song bar 1, so the block it holds sounds there.
      const clipId = state().addPhraseClip(trackId(), 1, 1)!;
      state().openClip(clipId);
      state().insertSegment(editableBars()[0].id, 0, chordSegment({ id: 'a' }), trackId());
      expect(barChords(state().project!.bars[1], trackId())).toHaveLength(1);

      state().insertBar(0, 1);

      // The placement moved along with the bar it was written against, so the music
      // is one bar later and nothing was lost on the way.
      expect(state().project!.clips[0].startBar).toBe(2);
      expect(barChords(state().project!.bars[1], trackId())).toHaveLength(0);
      expect(barChords(state().project!.bars[2], trackId())).toHaveLength(1);
      expect(barChords(state().project!.bars[2], trackId())[0].startBeat).toBe(0);
    });
  });

  describe('removeBars', () => {
    const state = () => projectStore.getState();

    beforeEach(() => {
      state().createProject();
      addEditableBar();
      addEditableBar();
      addEditableBar();
    });

    it('takes the named bar and the ones after it, re-indexing the rest', () => {
      addEditableBar();
      const ids = editableBars().map(b => b.id);

      state().removeBars(1, 2);

      const bars = editableBars();
      expect(bars.map(b => b.id)).toEqual([ids[0], ids[3]]);
      expect(bars.map(b => b.barIndex)).toEqual([0, 1]);
    });

    it('closes the placements after the run up behind it', () => {
      for (let i = 0; i < 8; i++) addEditableBar();
      state().addPhraseClip(trackId(), 8, 2);

      state().removeBars(1, 2);

      expect(state().project!.clips[0].startBar).toBe(6);
    });

    // A placement is as long as its phrase and cannot be trimmed, so the grid would
    // grow straight back underneath it on the next compile.
    it('refuses the whole run when anything is playing over any of it', () => {
      for (let i = 0; i < 8; i++) addEditableBar();
      state().addPhraseClip(trackId(), 3, 2);
      const before = state().project;

      state().removeBars(2, 3);

      expect(state().project).toBe(before);
    });

    it('refuses a run that would take every bar', () => {
      const before = state().project;

      state().removeBars(0, 4);

      expect(state().project).toBe(before);
    });

    it('does nothing for a non-positive count or an index past the end', () => {
      const before = state().project;

      state().removeBars(1, 0);
      state().removeBars(1, -2);
      state().removeBars(99, 1);

      expect(state().project).toBe(before);
    });
  });

  describe('setBarTimeSignature', () => {
    beforeEach(() => {
      projectStore.getState().createProject();
      addEditableBar();
    });

    it('sets a per-bar time signature', () => {
      const barId = editableBars()[0].id;
      projectStore.getState().setBarTimeSignature(barId, { beatsPerMeasure: 3, beatUnit: 4 });
      expect(editableBars()[0].timeSignature).toEqual({
        beatsPerMeasure: 3,
        beatUnit: 4,
      });
    });

    it('leaves other bars on the project time signature', () => {
      addEditableBar();
      const barId = editableBars()[0].id;
      projectStore.getState().setBarTimeSignature(barId, { beatsPerMeasure: 3, beatUnit: 4 });
      expect(editableBars()[1].timeSignature).toBeUndefined();
    });

    it('leaves the music alone when a bar it plays over is shortened', () => {
      const clipId = projectStore.getState().addPhraseClip(trackId(), 0, 1)!;
      projectStore.getState().openClip(clipId);
      for (let i = 0; i < 4; i++) appendSegment(chordSegment());
      const barId = projectStore.getState().project!.bars[0].id;

      projectStore.getState().setBarTimeSignature(barId, { beatsPerMeasure: 3, beatUnit: 4 });

      // The song lost a beat, but the phrase did not lose a block. A phrase may be
      // playing over several bars in several metres, so no one of them gets to rewrite
      // it; the fourth block simply sounds past the bar line, as a held chord always
      // could.
      expect(projectStore.getState().project!.bars[0].timeSignature).toEqual({
        beatsPerMeasure: 3,
        beatUnit: 4,
      });
      expect(barChords(editableBars()[0], PHRASE_TRACK_KEY)).toHaveLength(4);
    });

    it('rejects an invalid time signature', () => {
      const barId = editableBars()[0].id;
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
      addEditableBar();
      openTestPhrase(trackId(), editableBars().length);
    });

    const firstBarId = () => editableBars()[0].id;

    it('inserts a segment at the beat it was dropped on', () => {
      projectStore.getState().insertSegment(firstBarId(), 2, chordSegment({ id: 'a' }), trackId());
      expect(layout(editableBars()[0])).toEqual(['a@2']);
    });

    it('leaves the space before a segment as silence', () => {
      projectStore.getState().insertSegment(firstBarId(), 2, chordSegment({ id: 'a' }), trackId());
      const notes = barNotes(editableBars()[0], editKey(trackId()));
      expect(notes.every(n => n.startBeat === 2)).toBe(true);
    });

    it('snaps nothing itself — it places exactly where it is told', () => {
      // Snapping is the caller's job, so an unsnapped beat survives intact.
      projectStore.getState().insertSegment(firstBarId(), 1.5, chordSegment({ id: 'a' }), trackId());
      expect(barChords(editableBars()[0], editKey(trackId()))[0].startBeat).toBe(1.5);
    });

    it('lets a dropped block hang over the bar line', () => {
      projectStore
        .getState()
        .insertSegment(firstBarId(), 3.5, chordSegment({ id: 'wide', duration: 2 }), trackId());
      expect(layout(editableBars()[0])).toEqual(['wide@3.5']);
    });

    it('holds a dropped block’s onset inside the bar it was dropped on', () => {
      projectStore
        .getState()
        .insertSegment(firstBarId(), 9, chordSegment({ id: 'late' }), trackId());
      // Four beats in 4/4, so the last beat a block can begin on is one
      // thirty-second short of the bar line.
      expect(layout(editableBars()[0])).toEqual(['late@3.875']);
    });

    it('pushes the block it lands on to the right', () => {
      appendSegment(chordSegment({ id: 'a' }));
      appendSegment(chordSegment({ id: 'b' }));
      projectStore.getState().insertSegment(firstBarId(), 0, chordSegment({ id: 'new' }), trackId());
      expect(layout(editableBars()[0])).toEqual(['new@0', 'a@1', 'b@2']);
    });

    it('spills the last block into the next bar when the ripple fills the bar', () => {
      for (let i = 0; i < 4; i++) appendSegment(chordSegment({ id: `s${i}` }));
      projectStore.getState().insertSegment(firstBarId(), 0, chordSegment({ id: 'new' }), trackId());
      const bars = editableBars();
      expect(bars).toHaveLength(2);
      expect(layout(bars[0])).toEqual(['new@0', 's0@1', 's1@2', 's2@3']);
      expect(layout(bars[1])).toEqual(['s3@0']);
    });

    it('generates the triad notes for a chord segment', () => {
      projectStore
        .getState()
        .insertSegment(firstBarId(), 0, chordSegment({ root: 'C', quality: 'major' }), trackId());
      const notes = barNotes(editableBars()[0], editKey(trackId()));
      expect(notes.map(n => n.pitch)).toEqual([60, 64, 67]);
    });

    it('generates four notes for a seventh chord', () => {
      projectStore
        .getState()
        .insertSegment(firstBarId(), 0, chordSegment({ root: 'C', quality: 'maj7' }), trackId());
      expect(barNotes(editableBars()[0], editKey(trackId())).length).toBe(4);
    });

    it('generates exactly one note for a note segment', () => {
      projectStore
        .getState()
        .insertSegment(firstBarId(), 0, chordSegment({ kind: 'note', pitch: 62 }), trackId());
      const notes = barNotes(editableBars()[0], editKey(trackId()));
      expect(notes.length).toBe(1);
      expect(notes[0].pitch).toBe(62);
    });

    it('regenerates notes in the bar a segment overflows into', () => {
      for (let i = 0; i < 4; i++) {
        appendSegment(chordSegment({ id: `s${i}`, root: 'C', quality: 'major' }));
      }
      projectStore.getState().insertSegment(firstBarId(), 0, chordSegment({ id: 'new' }), trackId());
      const bars = editableBars();
      expect(barNotes(bars[1], editKey(trackId())).map(n => n.pitch)).toEqual([60, 64, 67]);
      expect(barNotes(bars[1], editKey(trackId()))[0].startBeat).toBe(0);
    });

    it('ignores an unknown bar id', () => {
      projectStore.getState().insertSegment('nope', 0, chordSegment({ id: 'a' }), trackId());
      expect(barChords(editableBars()[0], editKey(trackId()))).toEqual([]);
    });
  });

  describe('recordSegment', () => {
    const state = () => projectStore.getState();

    beforeEach(() => {
      state().createProject();
      openTestPhrase(trackId(), editableBars().length);
      // Four bars, so an absolute beat can name something other than bar 1.
      for (let i = 0; i < 3; i++) addEditableBar();
    });

    /** `id@start+duration` for one bar, since a take's length is the point here. */
    const spans = (barIndex: number): string[] =>
      barChords(editableBars()[barIndex], editKey(trackId())).map(
        c => `${c.id}@${c.startBeat}+${c.duration}`
      );

    it('writes at an absolute beat, resolving the bar itself', () => {
      state().recordSegment(trackId(), 9, chordSegment({ id: 'a' }));
      expect(spans(2)).toEqual(['a@1+1']);
    });

    it('overwrites what it lands on instead of rippling it', () => {
      state().insertSegment(editableBars()[0].id, 0, chordSegment({ id: 'old' }), trackId());
      state().insertSegment(editableBars()[0].id, 2, chordSegment({ id: 'keep' }), trackId());

      state().recordSegment(trackId(), 0, chordSegment({ id: 'take' }));

      // `old` is gone and `keep` has not budged — the whole point of a punch-in.
      expect(spans(0)).toEqual(['take@0+1', 'keep@2+1']);
    });

    it('trims a block it only partly covers', () => {
      state()
        .insertSegment(editableBars()[0].id, 0, chordSegment({ id: 'long', duration: 4 }), trackId());

      state().recordSegment(trackId(), 2, chordSegment({ id: 'take', duration: 2 }));

      expect(spans(0)).toEqual(['long@0+2', 'take@2+2']);
    });

    it('extends the open take rather than duplicating it', () => {
      const take = chordSegment({ id: 'take', duration: 0.25 });
      state().recordSegment(trackId(), 1, take);
      state().recordSegment(trackId(), 1, { ...take, duration: 2 });

      expect(spans(0)).toEqual(['take@1+2']);
    });

    it('lets a take run across the bar line as one segment', () => {
      state().recordSegment(trackId(), 3, chordSegment({ id: 'held', duration: 3 }));
      expect(spans(0)).toEqual(['held@3+3']);
      expect(spans(1)).toEqual([]);
    });

    it('clears what a growing take reaches over', () => {
      state().insertSegment(editableBars()[1].id, 0, chordSegment({ id: 'next' }), trackId());
      const take = chordSegment({ id: 'take', duration: 0.25 });
      state().recordSegment(trackId(), 3, take);
      state().recordSegment(trackId(), 3, { ...take, duration: 3 });

      expect(spans(0)).toEqual(['take@3+3']);
      expect(spans(1)).toEqual([]);
    });

    it('leaves another instrument alone', () => {
      state().addTrack('Strings');
      const other = state().project!.tracks[1].id;
      const mine = projectStore.getState().editingPhraseId!;
      // The other instrument gets a phrase of its own, since a take can only ever
      // land in the one that is open.
      openTestPhrase(other, 1);
      state().insertSegment(editableBars()[0].id, 0, chordSegment({ id: 'theirs' }), other);
      state().openPhrase(mine);

      state().recordSegment(trackId(), 0, chordSegment({ id: 'take' }));

      expect(barChords(state().project!.bars[0], other)).toHaveLength(1);
    });

    it('ignores an unknown instrument', () => {
      state().recordSegment('nope', 0, chordSegment({ id: 'a' }));
      expect(barChords(editableBars()[0], editKey(trackId()))).toEqual([]);
    });

    it('ignores a beat past the end of the song', () => {
      const before = editableBars().length;
      state().recordSegment(trackId(), 999, chordSegment({ id: 'a' }));
      expect(editableBars().length).toBe(before);
      expect(editableBars().every(b => barChords(b, editKey(trackId())).length === 0)).toBe(true);
    });

    // Recording a chord is several simultaneous blocks, one per key. A lane is
    // what gives each of them somewhere to be.
    describe('sub-lanes', () => {
      const laneSpans = (barIndex: number) =>
        barChords(editableBars()[barIndex], editKey(trackId())).map(
          c => `${c.id}@${c.startBeat}/${c.lane ?? 0}`
        );

      it('grows the instrument to hold the lane written to', () => {
        state().recordSegment(trackId(), 0, chordSegment({ id: 'hi', lane: 2 }));

        expect(state().project!.tracks[0].laneCount).toBe(3);
      });

      it('leaves a lane count that already covers the lane alone', () => {
        state().setTrackLaneCount(trackId(), 4);
        state().recordSegment(trackId(), 0, chordSegment({ id: 'hi', lane: 1 }));

        expect(state().project!.tracks[0].laneCount).toBe(4);
      });

      it('lands two takes on the same beat in different lanes', () => {
        state().recordSegment(trackId(), 0, chordSegment({ id: 'lo', lane: 0 }));
        state().recordSegment(trackId(), 0, chordSegment({ id: 'hi', lane: 1 }));

        expect(laneSpans(0)).toEqual(['lo@0/0', 'hi@0/1']);
      });

      it('punches only its own lane, leaving what is stacked with it', () => {
        state().recordSegment(trackId(), 0, chordSegment({ id: 'lo', duration: 4, lane: 0 }));
        state().recordSegment(trackId(), 0, chordSegment({ id: 'hi', duration: 4, lane: 1 }));

        // Re-recording over lane 1 replaces its block and spares lane 0's.
        state().recordSegment(trackId(), 0, chordSegment({ id: 'hi2', duration: 4, lane: 1 }));

        expect(laneSpans(0)).toEqual(['lo@0/0', 'hi2@0/1']);
      });
    });

    describe('setTrackLaneCount', () => {
      it('adds and removes a lane', () => {
        state().setTrackLaneCount(trackId(), 3);
        expect(state().project!.tracks[0].laneCount).toBe(3);

        state().setTrackLaneCount(trackId(), 1);
        expect(state().project!.tracks[0].laneCount).toBe(1);
      });

      it('refuses to shrink over a lane that still holds blocks', () => {
        state().recordSegment(trackId(), 0, chordSegment({ id: 'hi', lane: 2 }));

        state().setTrackLaneCount(trackId(), 1);

        expect(state().project!.tracks[0].laneCount).toBe(3);
        expect(barChords(editableBars()[0], editKey(trackId()))).toHaveLength(1);
      });

      it('never goes below one lane, and ignores nonsense', () => {
        state().setTrackLaneCount(trackId(), 3);
        state().setTrackLaneCount(trackId(), 0);
        expect(state().project!.tracks[0].laneCount).toBe(1);

        const before = state().project;
        state().setTrackLaneCount(trackId(), Number.NaN);
        state().setTrackLaneCount('nope', 3);
        expect(state().project).toBe(before);
      });
    });
  });

  describe('removeSegment', () => {
    beforeEach(() => {
      projectStore.getState().createProject();
      addEditableBar();
      openTestPhrase(trackId(), editableBars().length);
    });

    it('removes a segment by id', () => {
      appendSegment(chordSegment({ id: 'a' }));
      appendSegment(chordSegment({ id: 'b' }));
      projectStore.getState().removeSegment('a');
      expect(barChords(editableBars()[0], editKey(trackId())).map(c => c.id)).toEqual(['b']);
    });

    it('empties the generated notes when the last segment goes', () => {
      appendSegment(chordSegment({ id: 'a' }));
      expect(barNotes(editableBars()[0], editKey(trackId())).length).toBe(3);
      projectStore.getState().removeSegment('a');
      expect(barNotes(editableBars()[0], editKey(trackId()))).toEqual([]);
    });

    it('leaves the hole where a segment was, rather than closing it up', () => {
      // The gap is now the point: deleting a block writes a rest, it does not
      // drag everything after it a beat earlier.
      for (let i = 0; i < 3; i++) appendSegment(chordSegment({ id: `s${i}` }));
      projectStore.getState().removeSegment('s0');
      expect(layout(editableBars()[0])).toEqual(['s1@1', 's2@2']);
    });

    it('ignores an unknown segment id', () => {
      appendSegment(chordSegment({ id: 'a' }));
      projectStore.getState().removeSegment('nope');
      expect(barChords(editableBars()[0], editKey(trackId())).length).toBe(1);
    });
  });

  describe('removeSegments', () => {
    beforeEach(() => {
      projectStore.getState().createProject();
      addEditableBar();
      openTestPhrase(trackId(), editableBars().length);
    });

    it('removes every named segment in one write', () => {
      for (let i = 0; i < 4; i++) appendSegment(chordSegment({ id: `s${i}` }));
      const before = projectStore.getState().project;

      projectStore.getState().removeSegments(['s0', 's2']);

      expect(layout(editableBars()[0])).toEqual(['s1@1', 's3@3']);
      // One store write, so one undo step however many blocks went.
      expect(projectStore.getState().project).not.toBe(before);
    });

    it('removes segments spanning several bars', () => {
      addEditableBar();
      appendSegment(chordSegment({ id: 'a' }));
      const second = editableBars()[1].id;
      projectStore.getState().insertSegment(second, 0, chordSegment({ id: 'b' }), trackId());

      projectStore.getState().removeSegments(['a', 'b']);

      const bars = editableBars();
      expect(barChords(bars[0], editKey(trackId()))).toEqual([]);
      expect(barChords(bars[1], editKey(trackId()))).toEqual([]);
    });

    it('leaves known segments alone when an unknown id rides along', () => {
      appendSegment(chordSegment({ id: 'a' }));
      appendSegment(chordSegment({ id: 'b' }));
      projectStore.getState().removeSegments(['nope', 'a']);
      expect(barChords(editableBars()[0], editKey(trackId())).map(c => c.id)).toEqual(['b']);
    });

    it('leaves the project untouched when nothing matches', () => {
      appendSegment(chordSegment({ id: 'a' }));
      const before = projectStore.getState().project;
      projectStore.getState().removeSegments(['nope']);
      expect(projectStore.getState().project).toBe(before);
    });

    it('leaves the project untouched when the list is empty', () => {
      appendSegment(chordSegment({ id: 'a' }));
      const before = projectStore.getState().project;
      projectStore.getState().removeSegments([]);
      expect(projectStore.getState().project).toBe(before);
    });
  });

  // Destinations are beats from the start of the project, so with four-beat bars
  // beat 6 means "bar 2, beat 2".
  describe('moveSegments, one block', () => {
    const bars = () => editableBars();

    beforeEach(() => {
      projectStore.getState().createProject();
      addEditableBar();
      addEditableBar();
      openTestPhrase(trackId(), editableBars().length);
      appendSegment(chordSegment({ id: 'a' }));
      appendSegment(chordSegment({ id: 'b' }));
    });

    it('moves a segment to a free beat in its own bar', () => {
      projectStore.getState().moveSegments([{ segmentId: 'a', absoluteBeat: 3 }]);
      expect(layout(bars()[0])).toEqual(['b@1', 'a@3']);
    });

    it('moves a segment into another bar', () => {
      projectStore.getState().moveSegments([{ segmentId: 'a', absoluteBeat: 6 }]);
      expect(layout(bars()[0])).toEqual(['b@1']);
      expect(layout(bars()[1])).toEqual(['a@2']);
      expect(barOf('a')!.id).toBe(bars()[1].id);
    });

    it('regenerates the notes in both the bar it left and the bar it joined', () => {
      projectStore.getState().moveSegments([{ segmentId: 'a', absoluteBeat: 6 }]);
      expect(barNotes(bars()[0], editKey(trackId())).every(n => n.startBeat === 1)).toBe(true);
      expect(barNotes(bars()[1], editKey(trackId())).every(n => n.startBeat === 2)).toBe(true);
    });

    it('lets a moved block hang over the bar line', () => {
      projectStore.getState().resizeSegmentDuration('a', 2, 0.25);
      projectStore.getState().moveSegments([{ segmentId: 'a', absoluteBeat: 3.5 }]);
      expect(barChords(barOf('a')!, editKey(trackId())).find(c => c.id === 'a')!.startBeat).toBe(3.5);
      // It still belongs to the bar its onset falls in, not the one it reaches into.
      expect(barOf('a')!.id).toBe(bars()[0].id);
    });

    it('pushes a block it is dropped on top of', () => {
      projectStore.getState().moveSegments([{ segmentId: 'a', absoluteBeat: 1 }]);
      expect(layout(bars()[0])).toEqual(['a@1', 'b@2']);
    });

    it('grows the project when a block is moved past the last bar', () => {
      const barCount = bars().length;
      // One bar's worth past the end, so exactly one bar has to be appended.
      projectStore
        .getState()
        .moveSegments([{ segmentId: 'a', absoluteBeat: barCount * 4 + 1 }]);
      expect(bars()).toHaveLength(barCount + 1);
      expect(layout(bars()[barCount])).toEqual(['a@1']);
    });

    it('ignores an unknown id or a beat off the line', () => {
      projectStore.getState().moveSegments([{ segmentId: 'nope', absoluteBeat: 2 }]);
      projectStore.getState().moveSegments([{ segmentId: 'a', absoluteBeat: -2 }]);
      expect(layout(bars()[0])).toEqual(['a@0', 'b@1']);
    });
  });

  describe('moveSegments', () => {
    const bars = () => editableBars();

    beforeEach(() => {
      projectStore.getState().createProject();
      addEditableBar();
      addEditableBar();
      openTestPhrase(trackId(), editableBars().length);
      appendSegment(chordSegment({ id: 'a' }));
      appendSegment(chordSegment({ id: 'b' }));
      appendSegment(chordSegment({ id: 'c' }));
    });

    it('moves several blocks in one call', () => {
      projectStore.getState().moveSegments([
        { segmentId: 'a', absoluteBeat: 1 },
        { segmentId: 'b', absoluteBeat: 2 },
      ]);
      expect(layout(bars()[0])).toEqual(['a@1', 'b@2', 'c@3']);
    });

    it('swaps two blocks without either rippling the other', () => {
      // Each lands where the other was. Lifting both out first is what makes this
      // work: placed one at a time, the first would push the second aside.
      projectStore.getState().moveSegments([
        { segmentId: 'a', absoluteBeat: 1 },
        { segmentId: 'b', absoluteBeat: 0 },
      ]);
      expect(layout(bars()[0])).toEqual(['b@0', 'a@1', 'c@2']);
    });

    it('is order-independent: the destinations decide the ripple', () => {
      const listedBackwards = () => {
        projectStore.getState().createProject();
        addEditableBar();
        openTestPhrase(trackId(), editableBars().length);
        appendSegment(chordSegment({ id: 'a' }));
        appendSegment(chordSegment({ id: 'b' }));
        projectStore.getState().moveSegments([
          { segmentId: 'b', absoluteBeat: 3 },
          { segmentId: 'a', absoluteBeat: 2 },
        ]);
        return layout(bars()[0]);
      };
      expect(listedBackwards()).toEqual(['a@2', 'b@3']);
    });

    it('carries a selection into another bar together', () => {
      projectStore.getState().moveSegments([
        { segmentId: 'a', absoluteBeat: 4 },
        { segmentId: 'b', absoluteBeat: 5 },
      ]);
      expect(layout(bars()[0])).toEqual(['c@2']);
      expect(layout(bars()[1])).toEqual(['a@0', 'b@1']);
    });

    it('carries a selection across a bar line, each block keeping its own beat', () => {
      // Two beats right from beats 2 and 3 of the first bar: one block stays put in
      // the bar it is in, the other steps over the line. Nothing is pulled onto a
      // downbeat, and the gap between them is exactly what it was.
      projectStore.getState().moveSegments([
        { segmentId: 'b', absoluteBeat: 3 },
        { segmentId: 'c', absoluteBeat: 4 },
      ]);
      expect(layout(bars()[0])).toEqual(['a@0', 'b@3']);
      expect(layout(bars()[1])).toEqual(['c@0']);
    });

    it('holds each block’s onset inside its own destination bar', () => {
      projectStore.getState().resizeSegmentDuration('a', 2, 0.25);
      projectStore.getState().moveSegments([{ segmentId: 'a', absoluteBeat: 7.5 }]);
      // The onset stands; only its tail crosses into the bar beyond.
      expect(layout(bars()[1])).toEqual(['a@3.5']);
    });

    it('regenerates notes once, for every bar the batch touched', () => {
      projectStore.getState().moveSegments([{ segmentId: 'a', absoluteBeat: 6 }]);
      expect(barNotes(bars()[1], editKey(trackId())).every(n => n.startBeat === 2)).toBe(true);
      expect(barNotes(bars()[0], editKey(trackId())).some(n => n.startBeat === 0)).toBe(false);
    });

    it('skips unknown ids rather than failing the whole gesture', () => {
      projectStore.getState().moveSegments([
        { segmentId: 'nope', absoluteBeat: 3 },
        { segmentId: 'a', absoluteBeat: Number.NaN },
        { segmentId: 'c', absoluteBeat: 4 },
      ]);
      expect(layout(bars()[0])).toEqual(['a@0', 'b@1']);
      expect(layout(bars()[1])).toEqual(['c@0']);
    });

    it('leaves the project untouched when nothing resolves', () => {
      const before = projectStore.getState().project;
      projectStore.getState().moveSegments([]);
      projectStore.getState().moveSegments([{ segmentId: 'nope', absoluteBeat: 1 }]);
      expect(projectStore.getState().project).toBe(before);
    });
  });

  describe('multi-segment pitch edits', () => {
    const bars = () => editableBars();
    const segmentOf = (id: string) =>
      bars()
        .flatMap(b => barChords(b, editKey(trackId())))
        .find(c => c.id === id)!;

    beforeEach(() => {
      projectStore.getState().createProject();
      addEditableBar();
      addEditableBar();
      openTestPhrase(trackId(), editableBars().length);
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
      addEditableBar();
      openTestPhrase(trackId(), editableBars().length);
    });

    it('sets a new duration', () => {
      appendSegment(chordSegment({ id: 'a' }));
      projectStore.getState().resizeSegmentDuration('a', 2, 0.25);
      expect(barChords(editableBars()[0], editKey(trackId()))[0].duration).toBe(2);
    });

    it('updates the generated notes duration', () => {
      appendSegment(chordSegment({ id: 'a' }));
      projectStore.getState().resizeSegmentDuration('a', 2, 0.25);
      const notes = barNotes(editableBars()[0], editKey(trackId()));
      expect(notes.every(n => n.duration === 2)).toBe(true);
    });

    it('snaps to the editing grid', () => {
      appendSegment(chordSegment({ id: 'a' }));
      projectStore.getState().resizeSegmentDuration('a', 1.3, 0.25);
      expect(barChords(editableBars()[0], editKey(trackId()))[0].duration).toBe(1.25);
    });

    it('clamps to the end of the song', () => {
      appendSegment(chordSegment({ id: 'a' }));
      projectStore.getState().resizeSegmentDuration('a', 99, 0.25);
      expect(barChords(editableBars()[0], editKey(trackId()))[0].duration).toBe(4);
    });

    it('grows straight through the bar line', () => {
      // A block on beat 3 of bar 1 has one beat of bar left but three of song, and
      // a chord held over the barline is ordinary music.
      addEditableBar();
      const barId = editableBars()[0].id;
      projectStore.getState().insertSegment(barId, 3, chordSegment({ id: 'a' }), trackId());
      projectStore.getState().resizeSegmentDuration('a', 4, 0.25);
      const bar = editableBars()[0];
      expect(barChords(bar, editKey(trackId()))[0].duration).toBe(4);
      // It stays in the bar it starts in, and its notes are written from there.
      expect(barNotes(bar, editKey(trackId())).every(n => n.startBeat === 3 && n.duration === 4)).toBe(true);
    });

    it('caps growth at the end of the last bar', () => {
      const barId = editableBars()[0].id;
      projectStore.getState().insertSegment(barId, 3, chordSegment({ id: 'a' }), trackId());
      projectStore.getState().resizeSegmentDuration('a', 99, 0.25);
      expect(barChords(editableBars()[0], editKey(trackId()))[0].duration).toBe(1);
    });

    it('pushes later segments over the bar line when it grows', () => {
      appendSegment(chordSegment({ id: 'a' }));
      appendSegment(chordSegment({ id: 'b' }));
      appendSegment(chordSegment({ id: 'c' }));
      appendSegment(chordSegment({ id: 'd' }));
      projectStore.getState().resizeSegmentDuration('a', 2, 0.25);
      const bars = editableBars();
      expect(barChords(bars[0], editKey(trackId())).map(c => c.id)).toEqual(['a', 'b', 'c']);
      expect(barChords(bars[1], editKey(trackId())).map(c => c.id)).toEqual(['d']);
    });

    it('ignores an unknown segment id', () => {
      appendSegment(chordSegment({ id: 'a' }));
      projectStore.getState().resizeSegmentDuration('nope', 2, 0.25);
      expect(barChords(editableBars()[0], editKey(trackId()))[0].duration).toBe(1);
    });
  });

  describe('setSegmentsScale note regeneration', () => {
    const segmentOf = (id: string) =>
      projectStore
        .getState()
        .project!.phrases.flatMap(p => p.bars).flatMap(b => barChords(b, editKey(trackId())))
        .find(c => c.id === id)!;

    beforeEach(() => {
      projectStore.getState().createProject();
      addEditableBar();
      openTestPhrase(trackId(), editableBars().length);
    });

    it('re-interprets roman numerals against the new scale', () => {
      appendSegment(chordSegment({ id: 'a', root: undefined, quality: undefined, romanNumeral: 'I' }));
      expect(barNotes(editableBars()[0], editKey(trackId())).map(n => n.pitch)).toEqual([60, 64, 67]);

      projectStore.getState().setSegmentsScale(['a'], { root: 'D', type: 'major' });
      expect(barNotes(editableBars()[0], editKey(trackId())).map(n => n.pitch)).toEqual([62, 66, 69]);
    });

    it('retunes segments that carry an explicit root and quality', () => {
      // This is the shape the palette and splitBarIntoChords actually produce:
      // an explicit root/quality alongside the numeral.
      appendSegment(
        chordSegment({ id: 'a', romanNumeral: 'I', root: 'C', quality: 'major', chordSymbol: 'C' })
      );
      projectStore.getState().setSegmentsScale(['a'], { root: 'D', type: 'major' });

      const bar = editableBars()[0];
      expect(barChords(bar, editKey(trackId()))[0].root).toBe('D');
      expect(barChords(bar, editKey(trackId()))[0].chordSymbol).toBe('D');
      expect(barNotes(bar, editKey(trackId())).map(n => n.pitch)).toEqual([62, 66, 69]);
    });

    it('follows the new scale when the degree quality changes', () => {
      appendSegment(
        chordSegment({ id: 'a', romanNumeral: 'ii', root: 'D', quality: 'minor', chordSymbol: 'Dm' })
      );
      projectStore.getState().setSegmentsScale(['a'], { root: 'A', type: 'naturalMinor' });

      const bar = editableBars()[0];
      expect(barChords(bar, editKey(trackId()))[0].chordSymbol).toBe('B°');
      // B diminished: B, D, F.
      expect(barNotes(bar, editKey(trackId())).map(n => n.pitch)).toEqual([71, 74, 77]);
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
      addEditableBar();
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
      addEditableBar();
      addEditableBar(); // two 4/4 bars: eight beats of song
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

  describe('sections', () => {
    const state = () => projectStore.getState();
    const sections = () => state().project!.sections ?? [];

    beforeEach(() => {
      state().createProject();
      addEditableBar();
      addEditableBar(); // two 4/4 bars: eight beats of song
    });

    it('starts with none', () => {
      expect(sections()).toEqual([]);
    });

    it('returns the new section id and names it by default', () => {
      const id = state().addSection(0, 4);
      expect(id).not.toBeNull();
      expect(sections()).toHaveLength(1);
      expect(sections()[0]).toMatchObject({ id, name: 'Section 1', startBeat: 0, endBeat: 4 });
    });

    it('assigns a colour by position', () => {
      state().addSection(0, 4);
      state().addSection(4, 8);
      expect(sections()[0].color).not.toBe(sections()[1].color);
    });

    it('takes the name it is given', () => {
      state().addSection(0, 4, 'Intro');
      expect(sections()[0].name).toBe('Intro');
    });

    it('trims the earlier section when a later one is drawn over it', () => {
      state().addSection(0, 6, 'Intro');
      state().addSection(4, 8, 'Verse');

      expect(sections().map(s => [s.name, s.startBeat, s.endBeat])).toEqual([
        ['Intro', 0, 4],
        ['Verse', 4, 8],
      ]);
    });

    it('refuses a span the song has no room for', () => {
      expect(state().addSection(8, 12)).toBeNull();
      expect(sections()).toEqual([]);
    });

    it('clamps a resize to the end of the song', () => {
      const id = state().addSection(0, 4)!;
      state().setSectionRange(id, 2, 99);
      expect(sections()[0]).toMatchObject({ startBeat: 2, endBeat: 8 });
    });

    it('renames a section', () => {
      const id = state().addSection(0, 4)!;
      state().renameSection(id, 'Chorus');
      expect(sections()[0].name).toBe('Chorus');
    });

    it('keeps the old name rather than accepting an empty one', () => {
      const id = state().addSection(0, 4, 'Intro')!;
      state().renameSection(id, '   ');
      expect(sections()[0].name).toBe('Intro');
    });

    it('is a no-op on an unknown id', () => {
      state().addSection(0, 4, 'Intro');
      const before = state().project;

      state().renameSection('nope', 'Chorus');
      state().setSectionRange('nope', 0, 2);
      state().removeSection('nope');

      expect(state().project).toBe(before);
    });

    it('preserves a gap between two sections', () => {
      state().addSection(0, 2, 'Intro');
      state().addSection(6, 8, 'Outro');
      expect(sections().map(s => [s.startBeat, s.endBeat])).toEqual([
        [0, 2],
        [6, 8],
      ]);
    });

    it('leaves every block where it was when a section is removed', () => {
      openTestPhrase(trackId(), editableBars().length);
      const bar = editableBars()[0];
      state().insertSegment(bar.id, 0, chordSegment({ id: 'seg-1' }), trackId());

      const id = state().addSection(0, 4)!;
      state().removeSection(id);

      expect(sections()).toEqual([]);
      expect(barChords(editableBars()[0], editKey(trackId())).map(c => c.id)).toEqual(['seg-1']);
    });
  });

  describe('segment pitch editing', () => {
    const state = () => projectStore.getState();

    /** The segment with this id, wherever in the project it lives. */
    const segmentOf = (id: string): ChordSegment =>
      editableBars().flatMap(b => barChords(b, editKey(trackId()))).find(c => c.id === id)!;

    beforeEach(() => {
      state().createProject();
      addEditableBar();
      addEditableBar();
      openTestPhrase(trackId(), editableBars().length);
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
        state().insertSegment(editableBars()[1].id, 0, segment, trackId());

        state().stepSegmentPitch(segment.id, 1);

        // A minor's VII steps up to i without changing register.
        expect(segmentOf(segment.id)).toMatchObject({ root: 'A', octave: 4 });
      });

      it('regenerates the bar\'s notes so the roll follows', () => {
        const segment = chordSegment({ romanNumeral: 'I', chordSymbol: 'C', octave: 4 });
        appendSegment(segment);
        expect(barNotes(barOf(segment.id)!, editKey(trackId())).map(n => n.pitch)).toEqual([60, 64, 67]);

        state().stepSegmentPitch(segment.id, 1);

        // Dm at octave 4.
        expect(barNotes(barOf(segment.id)!, editKey(trackId())).map(n => n.pitch)).toEqual([62, 65, 69]);
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
        expect(barNotes(barOf(segment.id)!, editKey(trackId())).map(n => n.pitch)).toEqual([72]);
      });

      it('moves a chord down a register', () => {
        const segment = chordSegment({ octave: 4 });
        appendSegment(segment);

        state().shiftSegmentOctave(segment.id, -1);

        expect(segmentOf(segment.id).octave).toBe(3);
        expect(barNotes(barOf(segment.id)!, editKey(trackId())).map(n => n.pitch)).toEqual([48, 52, 55]);
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
        expect(barNotes(barOf(segment.id)!, editKey(trackId())).map(n => n.pitch)).toEqual([64, 67, 72]);

        state().cycleSegmentInversion(segment.id);
        state().cycleSegmentInversion(segment.id);
        expect(segmentOf(segment.id).inversion).toBe(0);
        expect(barNotes(barOf(segment.id)!, editKey(trackId())).map(n => n.pitch)).toEqual([60, 64, 67]);
      });

      it('ignores an unknown segment id', () => {
        const before = state().project;
        state().cycleSegmentInversion('nope');
        expect(state().project).toBe(before);
      });
    });

    describe('voicing', () => {
      const pitchesOf = (id: string) =>
        barNotes(barOf(id)!, editKey(trackId())).map(n => n.pitch);

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
        expect(barNotes(barOf(segment.id)!, editKey(trackId())).map(n => n.startBeat)).toEqual([0, 1, 2]);
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
        state().insertSegment(editableBars()[1].id, 0, second, trackId());

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

      describe('alteration', () => {
        it('raises a note, relabels it, and sounds the pitch it now names', () => {
          const note: ChordSegment = { id: 'note-alt', kind: 'note', pitch: 60, duration: 1 };
          appendSegment(note);

          state().setSegmentsAlter([note.id], 1);

          expect(segmentOf(note.id)).toMatchObject({
            pitch: 61,
            alter: 1,
            chordSymbol: 'C#4',
          });
          // The derived notes are what reaches the sampler, so the edit is only
          // real once they have moved too.
          expect(pitchesOf(note.id)).toEqual([61]);
        });

        it('puts it back on its degree, leaving no alteration behind', () => {
          const note: ChordSegment = { id: 'note-nat', kind: 'note', pitch: 60, duration: 1 };
          appendSegment(note);

          state().setSegmentsAlter([note.id], 1);
          state().setSegmentsAlter([note.id], 0);

          expect(segmentOf(note.id).pitch).toBe(60);
          expect(segmentOf(note.id).alter).toBeUndefined();
        });

        it('leaves a chord alone — there is no one note to bend', () => {
          const chord = chordSegment({ octave: 4 });
          appendSegment(chord);
          const before = pitchesOf(chord.id);

          state().setSegmentsAlter([chord.id], 1);

          expect(pitchesOf(chord.id)).toEqual(before);
        });
      });

      describe('velocity', () => {
        const velocitiesOf = (id: string) =>
          barNotes(barOf(id)!, editKey(trackId())).map(n => n.velocity);

        it('applies to every kind in one selection, and regenerates the notes', () => {
          // The one segment edit that is not chords-only: a note sounds at some
          // velocity just as a chord does.
          const chord = chordSegment({ octave: 4 });
          const note: ChordSegment = { id: 'note-vel', kind: 'note', pitch: 60, duration: 1 };
          appendSegment(chord);
          appendSegment(note);

          state().setSegmentsVelocity([chord.id, note.id], 40);

          expect(segmentOf(chord.id).velocity).toBe(40);
          expect(segmentOf(note.id).velocity).toBe(40);
          // Derived notes are what actually reaches the sampler, so the edit is
          // only real once they carry it. Both pack into one bar, so this is the
          // triad's three plus one for the note.
          expect(velocitiesOf(chord.id)).toEqual([40, 40, 40, 40]);
        });

        it('leaves a stacked note in another lane alone', () => {
          // Blocks in different lanes are independent material, so a velocity edit
          // aimed at one must not reach the one sounding beside it.
          const lo: ChordSegment = { id: 'lo-vel', kind: 'note', pitch: 60, duration: 1 };
          const hi: ChordSegment = {
            id: 'hi-vel',
            kind: 'note',
            pitch: 64,
            duration: 1,
            lane: 1,
            velocity: 88,
          };
          appendSegment(lo);
          appendSegment(hi);

          state().setSegmentVelocity(lo.id, 40);

          expect(segmentOf(hi.id).velocity).toBe(88);
          expect(velocitiesOf(lo.id).sort()).toEqual([40, 88]);
        });

        it('ignores an unknown segment id', () => {
          const before = state().project;
          state().setSegmentVelocity('nope', 40);
          expect(state().project).toBe(before);
        });
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
      addEditableBar();
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

    /**
     * Write one segment into each instrument's own phrase, both placed at bar 0.
     *
     * Two instruments can no longer be written to through one open surface, because a
     * phrase holds one part. So each gets its own, and what they play together is read
     * off the compiled song rather than out of either phrase.
     */
    const writeToBoth = (a: ChordSegment, b: ChordSegment) => {
      openTestPhrase(trackId(), 1);
      state().insertSegment(editableBars()[0].id, 0, a, trackId());
      openTestPhrase(second(), 1);
      state().insertSegment(editableBars()[0].id, 0, b, second());
    };

    // The whole point of the per-instrument content model: writing to one
    // instrument must be invisible to every other.
    it('keeps each instrument\'s segments separate', () => {
      writeToBoth(chordSegment({ id: 'piano-1' }), chordSegment({ id: 'strings-1' }));

      const bar = state().project!.bars[0];
      expect(barChords(bar, trackId())).toHaveLength(1);
      expect(barChords(bar, second())).toHaveLength(1);
      expect(barChords(bar, trackId())[0].id).not.toBe(barChords(bar, second())[0].id);
    });

    it('generates notes for each instrument from its own segments', () => {
      writeToBoth(
        chordSegment({ root: 'C', quality: 'major' }),
        chordSegment({ root: 'D', quality: 'minor' })
      );

      const bar = state().project!.bars[0];
      expect(barNotes(bar, trackId()).map(n => n.pitch)).toEqual([60, 64, 67]);
      expect(barNotes(bar, second()).map(n => n.pitch)).toEqual([62, 65, 69]);
    });

    it('drops an instrument\'s content along with the instrument', () => {
      writeToBoth(chordSegment({ id: 'piano-1' }), chordSegment({ id: 'strings-1' }));
      const removed = second();

      state().removeTrack(removed);

      expect(tracks()).toHaveLength(1);
      expect(state().project!.bars[0].content[removed]).toBeUndefined();
      // The instrument that stayed keeps everything it had.
      expect(barChords(state().project!.bars[0], trackId())).toHaveLength(1);
    });

    it('refuses a segment aimed at an instrument that does not exist', () => {
      const barId = editableBars()[0].id;
      const before = state().project;

      state().insertSegment(barId, 0, chordSegment({ id: 'orphan' }), 'no-such-track');

      expect(state().project).toBe(before);
    });
  });

  describe('duplicateTrack', () => {
    const state = () => projectStore.getState();
    const tracks = () => state().project!.tracks;
    /**
     * The compiled song, where an instrument's material can be read back per bar.
     *
     * A duplicated instrument plays the *same phrases* as its source — the copy is a
     * second set of placements, not a second copy of the music — so what it plays is
     * visible in the song rather than in any phrase of its own.
     */
    const songBars = () => state().project!.bars;

    beforeEach(() => {
      state().createProject();
      addEditableBar();
      openTestPhrase(trackId(), editableBars().length);
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

    // The preset is part of the instrument: a copy without it would sound like the
    // plugin's defaults rather than like the instrument that was duplicated.
    it('copies vst3State', () => {
      const sourceId = trackId();
      state().project = {
        ...state().project!,
        tracks: state().project!.tracks.map(t =>
          t.id === sourceId ? { ...t, vst3State: 'some-base64-data' } : t
        ),
      };
      state().duplicateTrack(sourceId);

      const copy = tracks().find(t => t.name === 'Piano (copy)')!;
      expect(copy.vst3State).toBe('some-base64-data');
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
      const barId = editableBars()[0].id;
      state().insertSegment(barId, 0, chordSegment({ id: 'a' }), trackId());
      state().insertSegment(barId, 1, chordSegment({ id: 'b' }), trackId());

      const newId = state().duplicateTrack(trackId());
      expect(newId).not.toBeNull();

      const bar = songBars()[0];
      const sourceChords = barChords(bar, trackId());
      const copyChords = barChords(bar, newId!);

      expect(copyChords.length).toBe(2);
      // Each placement puts the material into the timeline under its own ids, so the
      // two instruments' blocks stay distinguishable even sharing one phrase.
      expect(copyChords[0].id).not.toBe(sourceChords[0].id);
      expect(copyChords[1].id).not.toBe(sourceChords[1].id);
      // But same properties
      expect(copyChords[0].startBeat).toBe(sourceChords[0].startBeat);
      expect(copyChords[0].duration).toBe(sourceChords[0].duration);
      expect(copyChords[0].root).toBe(sourceChords[0].root);
      expect(copyChords[0].quality).toBe(sourceChords[0].quality);
    });

    it('copies segments across multiple bars', () => {
      addEditableBar();
      const bar0 = editableBars()[0].id;
      const bar1 = editableBars()[1].id;
      state().insertSegment(bar0, 0, chordSegment({ id: 'a' }), trackId());
      state().insertSegment(bar1, 2, chordSegment({ id: 'b' }), trackId());

      const newId = state().duplicateTrack(trackId());

      expect(barChords(songBars()[0], newId!).length).toBe(1);
      expect(barChords(songBars()[1], newId!).length).toBe(1);
      expect(barChords(songBars()[1], newId!)[0].startBeat).toBe(2);
    });

    it('skips bars the source has no content in', () => {
      addEditableBar();
      addEditableBar();
      // Only bar 0 has content; bars 1 and 2 are empty for this track
      state().insertSegment(editableBars()[0].id, 0, chordSegment({ id: 'a' }), trackId());

      const newId = state().duplicateTrack(trackId());

      // Copy only has content in bar 0
      expect(songBars()[0].content[newId!]).toBeDefined();
      expect(songBars()[1].content[newId!]).toBeUndefined();
      expect(songBars()[2].content[newId!]).toBeUndefined();
    });

    it('regenerates notes for the copy', () => {
      const barId = editableBars()[0].id;
      state().insertSegment(barId, 0, chordSegment({ root: 'C', quality: 'major' }), trackId());

      const newId = state().duplicateTrack(trackId());

      const copyNotes = barNotes(songBars()[0], newId!);
      expect(copyNotes.map(n => n.pitch)).toEqual([60, 64, 67]);
    });

    it('copies voicing from source segments', () => {
      const barId = editableBars()[0].id;
      const seg = chordSegment({ id: 'a', root: 'C', quality: 'major', octave: 4 });
      state().insertSegment(barId, 0, seg, trackId());
      state().setSegmentSpacing(seg.id, 'drop2');

      const newId = state().duplicateTrack(trackId());
      const copySeg = barChords(songBars()[0], newId!)[0];

      expect(copySeg.voicing).toMatchObject({ spacing: 'drop2', offsets: [0, -1, 0] });
    });

    it('copies segment keys (scale) from source segments', () => {
      const barId = editableBars()[0].id;
      const seg = chordSegment({
        id: 'a',
        root: 'G',
        quality: 'major',
        romanNumeral: 'V',
        scale: { root: 'C', type: 'major' },
      });
      state().insertSegment(barId, 0, seg, trackId());

      const newId = state().duplicateTrack(trackId());
      const copySeg = barChords(songBars()[0], newId!)[0];

      expect(copySeg.scale).toEqual({ root: 'C', type: 'major' });
    });

    it('leaves the source instrument untouched', () => {
      const barId = editableBars()[0].id;
      state().insertSegment(barId, 0, chordSegment({ id: 'a' }), trackId());

      const before = barChords(editableBars()[0], editKey(trackId()));
      state().duplicateTrack(trackId());

      expect(barChords(editableBars()[0], editKey(trackId()))).toEqual(before);
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
  // appendInstruments
  // ---------------------------------------------------------------------------

  describe('appendInstruments', () => {
    const state = () => projectStore.getState();
    const tracks = () => state().project!.tracks;

    const entry = (over: Partial<TemplateInstrument> = {}): TemplateInstrument => ({
      name: 'Strings',
      instrument: DEFAULT_INSTRUMENT_ID,
      volume: 0.6,
      pan: -0.25,
      ...over,
    });

    beforeEach(() => {
      state().createProject();
      addEditableBar();
    });

    it('adds the instruments after the ones already there', () => {
      const first = state().appendInstruments([entry({ name: 'Strings' }), entry({ name: 'Bass' })]);

      expect(tracks().map(t => t.name)).toEqual(['Piano', 'Strings', 'Bass']);
      expect(first).toBe(tracks()[1].id);
    });

    it('carries the sound, mix settings and plugin state', () => {
      state().appendInstruments([
        entry({ instrument: 'vst3:565354416d736e6f53757267652058ab', vst3State: 'AQID', color: '#abc' }),
      ]);

      expect(tracks()[1]).toMatchObject({
        instrument: 'vst3:565354416d736e6f53757267652058ab',
        vst3State: 'AQID',
        volume: 0.6,
        pan: -0.25,
        color: '#abc',
      });
    });

    it('starts every instrument audible and visible', () => {
      state().toggleTrackMute(trackId());
      state().appendInstruments([entry()]);

      expect(tracks()[1]).toMatchObject({ muted: false, solo: false, visible: true });
      expect(tracks()[1].volumeAutomation).toBeUndefined();
    });

    // A template captured from this very project must produce copies, not collisions.
    it('gives every appended instrument a fresh id', () => {
      state().appendInstruments([entry(), entry()]);

      const ids = tracks().map(t => t.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('colours an instrument that arrives without one', () => {
      state().appendInstruments([entry({ color: undefined })]);
      expect(tracks()[1].color).toBeDefined();
      expect(tracks()[1].color).not.toBe(tracks()[0].color);
    });

    it('leaves the existing instruments and all bar content untouched', () => {
      const barId = editableBars()[0].id;
      state().insertSegment(barId, 0, chordSegment({ id: 'a' }), trackId());
      const before = editableBars().map(b => b.content);

      state().appendInstruments([entry()]);

      expect(tracks()[0].name).toBe('Piano');
      expect(editableBars().map(b => b.content)).toEqual(before);
      expect(editableBars()[0].content[tracks()[1].id]).toBeUndefined();
    });

    it('returns null for an empty template or no project', () => {
      expect(state().appendInstruments([])).toBeNull();
      state().resetProject();
      expect(state().appendInstruments([entry()])).toBeNull();
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
      addEditableBar(); // bar 0 at index 0
      openTestPhrase(trackId(), editableBars().length);
      state().insertSegment(editableBars()[0].id, 0, chordSegment({ root: 'C', quality: 'major', duration: 1 }), trackId());
      addEditableBar(); // bar 1 at index 1

      const before = editableBars().length;
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

      const bar = editableBars()[1];
      const chords = barChords(bar, editKey(trackId()));
      expect(chords.length).toBe(1);
      expect(chords[0].root).toBe('D');
      expect(chords[0].quality).toBe('minor');
      expect(chords[0].startBeat).toBe(0);
      expect(chords[0].duration).toBe(1);
      // Pasted segments get a fresh id.
      expect(chords[0].id).not.toBe('seg-paste-target');
      expect(editableBars().length).toBe(before);
    });

    it('pastes a single segment at an offset within the target bar', () => {
      state().createProject();
      addEditableBar(); // bar 0
      openTestPhrase(trackId(), editableBars().length);
      state().insertSegment(editableBars()[0].id, 0, chordSegment({ duration: 1 }), trackId());
      addEditableBar(); // bar 1

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

      const bar = editableBars()[1];
      const chords = barChords(bar, editKey(trackId()));
      expect(chords.length).toBe(1);
      expect(chords[0].startBeat).toBe(2);
    });

    it('offsets multiple segments so the first lands at the cursor', () => {
      state().createProject();
      addEditableBar(); // bar 0
      addEditableBar(); // bar 1
      openTestPhrase(trackId(), editableBars().length);

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

      const bar = editableBars()[1];
      const chords = barChords(bar, editKey(trackId()));
      expect(chords.length).toBe(2);
      expect(chords[0].startBeat).toBe(0);
      expect(chords[1].startBeat).toBe(2);
    });

    it('shifts segments when baseStartBeat is non-zero', () => {
      state().createProject();
      addEditableBar(); // bar 0
      addEditableBar(); // bar 1
      openTestPhrase(trackId(), editableBars().length);

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

      const bar = editableBars()[1];
      const chords = barChords(bar, editKey(trackId()));
      expect(chords.length).toBe(2);
      // Offset: startBeat - baseStartBeat = 1 - 1 = 0 for first, 3 - 1 = 2 for second
      expect(chords[0].startBeat).toBe(0);
      expect(chords[1].startBeat).toBe(2);
    });

    it('appends bars when the paste destination exceeds existing bars', () => {
      state().createProject();
      addEditableBar();
      openTestPhrase(trackId(), 1);

      const before = editableBars().length;
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
      // The phrase grew to reach the destination bar, rather than the paste being
      // clamped back into the bar it already had.
      expect(before).toBe(1);
      expect(editableBars().length).toBe(2);
      // The segment was at barIndex 2, offsetBarIndex 1, so target bar = 1 + (2 - 2) = 1
      const targetBar = editableBars()[1];
      const chords = barChords(targetBar, editKey(trackId()));
      expect(chords.length).toBe(1);
      expect(chords[0].root).toBe('X');
    });

    it('preserves original segment properties (voicing, scale, etc.)', () => {
      state().createProject();
      addEditableBar(); // bar 0
      addEditableBar(); // bar 1
      openTestPhrase(trackId(), editableBars().length);

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

      const bar = editableBars()[1];
      const chords = barChords(bar, editKey(trackId()));
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
      addEditableBar(); // bar 0
      openTestPhrase(trackId(), editableBars().length);
      const otherTrackId = state().addTrack('Other');
      state().insertSegment(editableBars()[0].id, 0, chordSegment({ root: 'C' }), trackId());
      state().insertSegment(editableBars()[0].id, 0, chordSegment({ root: 'C' }), otherTrackId!);
      addEditableBar(); // bar 1

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
      const targetBar = editableBars()[1];
      expect(barChords(targetBar, editKey(trackId())).length).toBe(1);
      expect(barChords(targetBar, editKey(trackId()))[0].root).toBe('P');

      // Other track is untouched
      expect(barChords(targetBar, otherTrackId!).length).toBe(0);
    });
  });

  /**
   * Curves live on the *phrase* now, not on the instrument.
   *
   * A curve written once on a phrase's own beats is heard at every placement of it,
   * so every action below is addressed by phrase id; what lands on the instrument is
   * the compiled result of its placements, which no action writes to directly.
   */
  describe('volume automation', () => {
    const state = () => projectStore.getState();

    /** The phrase these tests write to, placed on the Piano at bar 0. */
    let phraseId = '';
    const phrase = () => state().project!.phrases.find(p => p.id === phraseId)!;
    const points = () => phrase().volumeAutomation;

    /** A second phrase, on the same instrument, to prove edits stay put. */
    const otherPhrase = (startBar: number) => {
      const clipId = state().addPhraseClip(trackId(), startBar, 1)!;
      return state().project!.clips.find(c => c.id === clipId)!.phraseId;
    };

    beforeEach(() => {
      state().createProject();
      phraseId = openTestPhrase(trackId(), 2).phraseId;
    });

    it('starts with no curve, so the flat volume stands', () => {
      expect(points()).toBeUndefined();
    });

    it('adds points in beat order however they arrive', () => {
      state().addVolumePoint(phraseId, 6, 0);
      state().addVolumePoint(phraseId, 4, 1);

      expect(points()).toEqual([
        { beat: 4, value: 1 },
        { beat: 6, value: 0 },
      ]);
    });

    it('replaces a point already on that beat', () => {
      state().addVolumePoint(phraseId, 4, 1);
      state().addVolumePoint(phraseId, 4, 0.25);

      expect(points()).toEqual([{ beat: 4, value: 0.25 }]);
    });

    it('clamps rather than throwing, unlike setTrackVolume', () => {
      // These come from a pointer drag: out of range means the gesture left the
      // lane, which is not a programming error.
      expect(() => state().addVolumePoint(phraseId, -5, 3)).not.toThrow();
      expect(points()).toEqual([{ beat: 0, value: 1 }]);
    });

    it('ignores a non-finite position', () => {
      state().addVolumePoint(phraseId, Number.NaN, 0.5);
      expect(points()).toEqual([{ beat: 0, value: 0.5 }]);
    });

    it('moves a point and re-sorts', () => {
      state().addVolumePoint(phraseId, 2, 1);
      state().addVolumePoint(phraseId, 4, 0);
      state().moveVolumePoint(phraseId, 0, 6, 0.5);

      expect(points()).toEqual([
        { beat: 4, value: 0 },
        { beat: 6, value: 0.5 },
      ]);
    });

    it('replaces the occupant when a move lands on another point', () => {
      state().addVolumePoint(phraseId, 4, 1);
      state().addVolumePoint(phraseId, 6, 0);
      state().moveVolumePoint(phraseId, 0, 6, 0.5);

      expect(points()).toEqual([{ beat: 6, value: 0.5 }]);
    });

    it('removes a point by index', () => {
      state().addVolumePoint(phraseId, 4, 1);
      state().addVolumePoint(phraseId, 6, 0);
      state().removeVolumePoint(phraseId, 0);

      expect(points()).toEqual([{ beat: 6, value: 0 }]);
    });

    it('drops the array entirely once the last point goes, so the fader takes over', () => {
      state().addVolumePoint(phraseId, 4, 1);
      state().removeVolumePoint(phraseId, 0);

      expect(points()).toBeUndefined();
    });

    it('clears the whole curve', () => {
      state().addVolumePoint(phraseId, 4, 1);
      state().addVolumePoint(phraseId, 6, 0);
      state().clearVolumeAutomation(phraseId);

      expect(points()).toBeUndefined();
    });

    it('leaves the project alone for an unknown phrase', () => {
      const before = state().project;
      state().addVolumePoint('no-such-phrase', 4, 1);
      expect(state().project).toBe(before);
    });

    it('leaves the project alone for an index that is not there', () => {
      state().addVolumePoint(phraseId, 4, 1);
      const before = state().project;
      state().moveVolumePoint(phraseId, 9, 1, 1);
      state().removeVolumePoint(phraseId, 9);
      expect(state().project).toBe(before);
    });

    it('touches only the phrase it is aimed at', () => {
      const other = otherPhrase(2);
      state().addVolumePoint(phraseId, 4, 0.5);

      expect(state().project!.phrases.find(p => p.id === other)!.volumeAutomation).toBeUndefined();
    });

    // The instrument's own curve is compiled from its placements, so it appears
    // without ever being written to, on the song's beats rather than the phrase's.
    it('reaches the instrument through the placement', () => {
      state().addVolumePoint(phraseId, 4, 0.5);

      expect(state().project!.tracks[0].volumeAutomation).toContainEqual({
        beat: 4,
        value: 0.5,
      });
    });

    // The copy plays the same phrases at the same places, so the same curve is
    // compiled onto it — not because anything was copied, but because the
    // placements were.
    it('is carried by duplicateTrack, through the placements', () => {
      state().addVolumePoint(phraseId, 4, 1);
      state().addVolumePoint(phraseId, 6, 0);
      state().duplicateTrack(trackId());

      const copy = state().project!.tracks.find(t => t.name === 'Piano (copy)')!;
      expect(copy.volumeAutomation).toEqual(state().project!.tracks[0].volumeAutomation);
      expect(copy.volumeAutomation).toContainEqual({ beat: 4, value: 1 });
    });
  });

  describe('plugin parameter automation', () => {
    const state = () => projectStore.getState();

    let phraseId = '';
    const phrase = () => state().project!.phrases.find(p => p.id === phraseId)!;
    const lanes = () => phrase().parameterAutomation;
    const keys = () => lanes()!.map(l => laneKey(l.target));
    const pointsOf = (key: string) => lanes()?.find(l => laneKey(l.target) === key)?.points;
    /** A parameter target, which most of these cases do not care about. */
    const param = (paramId: number) => ({ kind: 'param', paramId }) as const;

    beforeEach(() => {
      state().createProject();
      phraseId = openTestPhrase(trackId(), 2).phraseId;
    });

    it('starts with no lanes, so nothing drives the plugin', () => {
      expect(lanes()).toBeUndefined();
    });

    // Unlike a volume curve, an empty lane survives: it is one just added, and
    // there is no fader behind it to hand control back to.
    it('keeps a lane that has no points yet', () => {
      state().addLane(phraseId, param(7), 'Cutoff');

      expect(lanes()).toEqual([{ target: param(7), name: 'Cutoff', points: [] }]);
    });

    it('sorts lanes by key however they arrive', () => {
      state().addLane(phraseId, param(9), 'Resonance');
      state().addLane(phraseId, param(2), 'Cutoff');

      expect(keys()).toEqual(['param:2', 'param:9']);
    });

    it('leaves an existing lane alone rather than wiping its curve', () => {
      state().addLane(phraseId, param(7), 'Cutoff');
      state().addLanePoint(phraseId, 'param:7', 4, 0.5);
      state().addLane(phraseId, param(7), 'Cutoff');

      expect(pointsOf('param:7')).toEqual([{ beat: 4, value: 0.5 }]);
    });

    it('adds points in beat order however they arrive', () => {
      state().addLane(phraseId, param(7), 'Cutoff');
      state().addLanePoint(phraseId, 'param:7', 6, 0);
      state().addLanePoint(phraseId, 'param:7', 4, 1);

      expect(pointsOf('param:7')).toEqual([
        { beat: 4, value: 1 },
        { beat: 6, value: 0 },
      ]);
    });

    it('moves a point and re-sorts, like the volume curve', () => {
      state().addLane(phraseId, param(7), 'Cutoff');
      state().addLanePoint(phraseId, 'param:7', 2, 1);
      state().addLanePoint(phraseId, 'param:7', 4, 0);
      state().moveLanePoint(phraseId, 'param:7', 0, 6, 0.5);

      expect(pointsOf('param:7')).toEqual([
        { beat: 4, value: 0 },
        { beat: 6, value: 0.5 },
      ]);
    });

    it('removes a point by index, leaving the lane standing', () => {
      state().addLane(phraseId, param(7), 'Cutoff');
      state().addLanePoint(phraseId, 'param:7', 4, 1);
      state().removeLanePoint(phraseId, 'param:7', 0);

      expect(pointsOf('param:7')).toEqual([]);
    });

    it('removes a whole lane', () => {
      state().addLane(phraseId, param(7), 'Cutoff');
      state().addLane(phraseId, param(9), 'Resonance');
      state().removeLane(phraseId, 'param:7');

      expect(keys()).toEqual(['param:9']);
    });

    it('drops the array entirely once the last lane goes', () => {
      state().addLane(phraseId, param(7), 'Cutoff');
      state().removeLane(phraseId, 'param:7');

      expect(lanes()).toBeUndefined();
    });

    it('edits one lane without disturbing another', () => {
      state().addLane(phraseId, param(7), 'Cutoff');
      state().addLane(phraseId, param(9), 'Resonance');
      state().addLanePoint(phraseId, 'param:9', 4, 0.5);
      state().addLanePoint(phraseId, 'param:7', 2, 1);

      expect(pointsOf('param:7')).toEqual([{ beat: 2, value: 1 }]);
      expect(pointsOf('param:9')).toEqual([{ beat: 4, value: 0.5 }]);
    });

    it('leaves the volume curve alone', () => {
      state().addVolumePoint(phraseId, 4, 0.5);
      state().addLane(phraseId, param(7), 'Cutoff');
      state().removeLane(phraseId, 'param:7');

      expect(phrase().volumeAutomation).toEqual([{ beat: 4, value: 0.5 }]);
    });

    it('leaves the project alone for an unknown phrase', () => {
      const before = state().project;
      state().addLane('no-such-phrase', param(7), 'Cutoff');
      expect(state().project).toBe(before);
    });

    // A no-op must not land an entry on the undo stack, which is snapshot-based
    // and pushes on every `set`.
    it('leaves the project alone for a parameter with no lane', () => {
      state().addLane(phraseId, param(7), 'Cutoff');
      const before = state().project;

      state().addLanePoint(phraseId, 'param:99', 4, 0.5);
      state().removeLane(phraseId, 'param:99');

      expect(state().project).toBe(before);
    });

    it('touches only the phrase it is aimed at', () => {
      const clipId = state().addPhraseClip(trackId(), 2, 1)!;
      const other = state().project!.clips.find(c => c.id === clipId)!.phraseId;
      state().addLane(phraseId, param(7), 'Cutoff');

      expect(
        state().project!.phrases.find(p => p.id === other)!.parameterAutomation
      ).toBeUndefined();
    });

    // A parameter and a controller of the same number are different things, and
    // one lane must never stand in for the other.
    it('keeps a controller lane beside a parameter lane of the same number', () => {
      state().addLane(phraseId, param(20), 'Slot 20');
      state().addLane(phraseId, { kind: 'cc', controller: 20 }, 'CC 20');
      state().addLanePoint(phraseId, 'cc:20', 4, 0.5);

      expect(keys()).toEqual(['cc:20', 'param:20']);
      expect(pointsOf('param:20')).toEqual([]);
      expect(pointsOf('cc:20')).toEqual([{ beat: 4, value: 0.5 }]);
    });

    // The name a curve carries has to be the user's: "CC 20" says nothing about
    // what it drives, and a sampler titles all its slots the same thing.
    it('renames a lane, leaving its curve alone', () => {
      state().addLane(phraseId, { kind: 'cc', controller: 20 }, 'CC 20');
      state().addLanePoint(phraseId, 'cc:20', 4, 0.5);
      state().renameLane(phraseId, 'cc:20', 'Filter Cutoff');

      expect(lanes()![0].name).toBe('Filter Cutoff');
      expect(pointsOf('cc:20')).toEqual([{ beat: 4, value: 0.5 }]);
    });

    it('leaves the project alone for a rename that changes nothing', () => {
      state().addLane(phraseId, param(7), 'Cutoff');
      const before = state().project;

      state().renameLane(phraseId, 'param:7', 'Cutoff');
      state().renameLane(phraseId, 'param:7', '  ');
      state().renameLane(phraseId, 'param:99', 'Nowhere');

      expect(state().project).toBe(before);
    });

    it('is carried by duplicateTrack, through the placements', () => {
      state().addLane(phraseId, param(7), 'Cutoff');
      state().addLanePoint(phraseId, 'param:7', 4, 1);
      state().duplicateTrack(trackId());

      const copy = state().project!.tracks.find(t => t.name === 'Piano (copy)')!;
      expect(copy.parameterAutomation).toEqual([
        { target: param(7), name: 'Cutoff', points: [{ beat: 4, value: 1 }] },
      ]);
    });
  });

  describe('instrument groups', () => {
    const state = () => projectStore.getState();
    const project = () => state().project!;
    const groups = () => project().trackGroups ?? [];

    /** The sidebar's instruments, as `group/name` or `name`. */
    const order = () =>
      project().tracks.map(t => {
        const group = groups().find(g => g.id === t.groupId);
        return group ? `${group.name}/${t.name}` : t.name;
      });

    /** An instrument's id by name — every action here is addressed by id. */
    const idOf = (name: string) => project().tracks.find(t => t.name === name)!.id;
    const groupIdOf = (name: string) => groups().find(g => g.name === name)!.id;

    beforeEach(() => {
      state().createProject(); // one instrument: Piano
      state().addTrack('Bass');
      state().addTrack('Lead');
    });

    describe('addTrackGroup', () => {
      it('adds an empty group and returns its id', () => {
        const id = state().addTrackGroup('Rhythm');

        expect(id).not.toBeNull();
        expect(groups()).toHaveLength(1);
        expect(groups()[0]).toMatchObject({ id: id!, name: 'Rhythm' });
      });

      it('names a group after its position when none is given', () => {
        state().addTrackGroup();
        state().addTrackGroup();

        expect(groups().map(g => g.name)).toEqual(['Group 1', 'Group 2']);
      });

      it('gives each group a colour from the palette', () => {
        state().addTrackGroup();
        expect(groups()[0].color).toBeTruthy();
      });

      it('leaves every instrument where it was', () => {
        state().addTrackGroup('Rhythm');
        expect(order()).toEqual(['Piano', 'Bass', 'Lead']);
      });
    });

    describe('moveTrack', () => {
      beforeEach(() => {
        state().addTrackGroup('Rhythm');
      });

      // A group with no members yet sits at the bottom of the panel — `tracks` has
      // nowhere else to put it — so the instrument dropped into it lands there too,
      // which is where the user let go of it.
      it('moves an instrument into a group', () => {
        state().moveTrack(idOf('Bass'), groupIdOf('Rhythm'), null);

        expect(order()).toEqual(['Piano', 'Lead', 'Rhythm/Bass']);
      });

      it('gathers the instruments of a group into one run', () => {
        const rhythm = groupIdOf('Rhythm');
        state().moveTrack(idOf('Piano'), rhythm, null);
        state().moveTrack(idOf('Lead'), rhythm, null);

        expect(order()).toEqual(['Bass', 'Rhythm/Piano', 'Rhythm/Lead']);
      });

      it('puts an instrument before a member it is dropped above', () => {
        const rhythm = groupIdOf('Rhythm');
        state().moveTrack(idOf('Piano'), rhythm, null);
        state().moveTrack(idOf('Lead'), rhythm, idOf('Piano'));

        expect(order()).toEqual(['Bass', 'Rhythm/Lead', 'Rhythm/Piano']);
      });

      it('moves an instrument back out of a group', () => {
        state().moveTrack(idOf('Bass'), groupIdOf('Rhythm'), null);
        state().moveTrack(idOf('Bass'), null, null);

        expect(order()).toEqual(['Piano', 'Lead', 'Bass']);
        expect(project().tracks.find(t => t.name === 'Bass')!.groupId).toBeUndefined();
      });

      it('reorders ungrouped instruments', () => {
        state().moveTrack(idOf('Lead'), null, idOf('Piano'));

        expect(order()).toEqual(['Lead', 'Piano', 'Bass']);
      });

      // A drag that ends where it started is a common miss, and must not cost an undo.
      it('leaves the project alone for a move that changes nothing', () => {
        const before = state().project;

        state().moveTrack(idOf('Lead'), null, null);
        state().moveTrack('nope', null, null);
        state().moveTrack(idOf('Lead'), 'no-such-group', null);

        expect(state().project).toBe(before);
      });

      it('keeps everything the instrument plays', () => {
        appendSegment(chordSegment({ id: 'seg-1' }));
        const bars = project().bars;

        state().moveTrack(trackId(), groupIdOf('Rhythm'), null);

        expect(project().bars).toEqual(bars);
      });
    });

    describe('moveTrackGroup', () => {
      beforeEach(() => {
        state().addTrackGroup('Rhythm');
        state().addTrackGroup('Horns');
        state().moveTrack(idOf('Piano'), groupIdOf('Rhythm'), null);
        state().moveTrack(idOf('Bass'), groupIdOf('Horns'), null);
      });

      it('moves a group before another, instruments and all', () => {
        state().moveTrackGroup(groupIdOf('Horns'), groupIdOf('Rhythm'));

        expect(groups().map(g => g.name)).toEqual(['Horns', 'Rhythm']);
        expect(order()).toEqual(['Lead', 'Horns/Bass', 'Rhythm/Piano']);
      });

      it('moves a group to the end', () => {
        state().moveTrackGroup(groupIdOf('Rhythm'), null);

        expect(groups().map(g => g.name)).toEqual(['Horns', 'Rhythm']);
      });

      it('leaves the project alone for a move that changes nothing', () => {
        const before = state().project;

        state().moveTrackGroup('nope', null);
        state().moveTrackGroup(groupIdOf('Rhythm'), groupIdOf('Rhythm'));

        expect(state().project).toBe(before);
      });
    });

    describe('removeTrackGroup', () => {
      beforeEach(() => {
        state().addTrackGroup('Rhythm');
        state().moveTrack(idOf('Piano'), groupIdOf('Rhythm'), null);
        state().moveTrack(idOf('Bass'), groupIdOf('Rhythm'), null);
      });

      // A group is a label. Removing a label must never remove what it labelled.
      it('keeps every instrument and everything it plays', () => {
        appendSegment(chordSegment({ id: 'seg-1' }));
        const bars = project().bars;

        state().removeTrackGroup(groupIdOf('Rhythm'));

        expect(order()).toEqual(['Lead', 'Piano', 'Bass']);
        expect(project().bars).toEqual(bars);
      });

      it('ungroups its members', () => {
        state().removeTrackGroup(groupIdOf('Rhythm'));

        expect(project().tracks.every(t => t.groupId === undefined)).toBe(true);
      });

      it('leaves the project alone for an id that is not there', () => {
        const before = state().project;
        state().removeTrackGroup('nope');
        expect(state().project).toBe(before);
      });
    });

    describe('renameTrackGroup', () => {
      beforeEach(() => {
        state().addTrackGroup('Rhythm');
      });

      it('renames a group', () => {
        state().renameTrackGroup(groupIdOf('Rhythm'), 'Backline');
        expect(groups()[0].name).toBe('Backline');
      });

      // An empty name would leave a header nothing can be read off.
      it('refuses an empty name', () => {
        state().renameTrackGroup(groupIdOf('Rhythm'), '  ');
        expect(groups()[0].name).toBe('Rhythm');
      });
    });

    describe('toggles', () => {
      beforeEach(() => {
        state().addTrackGroup('Rhythm');
      });

      it('collapses and expands', () => {
        const id = groupIdOf('Rhythm');
        expect(groups()[0].collapsed).toBeFalsy();

        state().toggleTrackGroupCollapsed(id);
        expect(groups()[0].collapsed).toBe(true);

        state().toggleTrackGroupCollapsed(id);
        expect(groups()[0].collapsed).toBe(false);
      });

      // The group's flags sit beside the members' own rather than overwriting them,
      // so ungrouping hands back the mix the user built.
      it('mutes a group without touching its instruments', () => {
        state().moveTrack(idOf('Piano'), groupIdOf('Rhythm'), null);
        state().toggleTrackGroupMute(groupIdOf('Rhythm'));

        expect(groups()[0].muted).toBe(true);
        expect(project().tracks.every(t => t.muted === false)).toBe(true);
      });

      it('solos a group without touching its instruments', () => {
        state().moveTrack(idOf('Piano'), groupIdOf('Rhythm'), null);
        state().toggleTrackGroupSolo(groupIdOf('Rhythm'));

        expect(groups()[0].solo).toBe(true);
        expect(project().tracks.every(t => t.solo === false)).toBe(true);
      });
    });

    describe('duplicateTrack', () => {
      it('puts the copy in the same group as its original', () => {
        state().addTrackGroup('Rhythm');
        state().moveTrack(idOf('Piano'), groupIdOf('Rhythm'), null);

        state().duplicateTrack(idOf('Piano'));

        expect(order()).toEqual(['Bass', 'Lead', 'Rhythm/Piano', 'Rhythm/Piano (copy)']);
      });
    });
  });
});
