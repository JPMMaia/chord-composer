import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useRecordExtend } from '@/hooks/useRecordExtend';
import { useRecordSession } from '@/hooks/useRecordSession';
import { createUndoRedoMiddleware } from '@/engine/undoRedo';
import { projectStore, setRecordingGate } from '@/store/projectStore';
import { editorStore } from '@/store/editorStore';
import { selectionStore } from '@/store/selectionStore';
import { openTestPhrase } from '../helpers/phrases';
import type { ChordSegment, Project } from '@/types/music';

/**
 * Running off the end of a phrase while recording lengthens it; everything else
 * still loops.
 *
 * The hook never touches the transport: it only makes the phrase longer before the
 * playhead can reach the seam, which is what the audition's range is derived from.
 * So every case here is about *when* a bar is added, and about giving back the ones
 * the take reached for but never used.
 */

const state = () => projectStore.getState();
const trackId = (): string => state().project!.tracks[0].id;
const phraseLength = (): number =>
  state().project!.phrases.find(p => p.id === state().editingPhraseId)!.bars.length;

/** Somewhere to put a note. 4/4 throughout, so a bar is four beats. */
function song(bars: number): void {
  state().resetProject();
  state().createProject();
  while (state().project!.bars.length < bars) state().addBar();
}

const note = (id: string): ChordSegment => ({
  id,
  kind: 'note',
  pitch: 60,
  velocity: 100,
  lane: 0,
  duration: 1,
});

/** The hook as App mounts it: one flag, one playhead reading in phrase beats. */
function mount(active: boolean, beat: number) {
  return renderHook(
    (props: { active: boolean; beat: number }) => useRecordExtend(props.active, props.beat),
    { initialProps: { active, beat } }
  );
}

beforeEach(() => {
  song(8);
  selectionStore.getState().clearSelection();
  selectionStore.getState().selectTrack(trackId());
  editorStore.setState({ view: 'phrase', phraseLoop: null, recordArmed: true });
  openTestPhrase(trackId(), 2);
});

afterEach(cleanup);

describe('useRecordExtend', () => {
  it('adds a bar when the playhead enters the last one', () => {
    const { rerender } = mount(true, 0);
    rerender({ active: true, beat: 4 });

    expect(phraseLength()).toBe(3);
  });

  it('leaves the phrase alone while there is still a bar ahead', () => {
    const { rerender } = mount(true, 0);
    rerender({ active: true, beat: 3 });

    expect(phraseLength()).toBe(2);
  });

  // The pass that opens the take is not a playhead reading: the recording pass takes
  // its undo baseline on that same commit, and it must see the phrase as the user
  // left it.
  it('adds nothing on the commit the take opens on', () => {
    mount(true, 4);
    expect(phraseLength()).toBe(2);
  });

  it('adds one bar at a time as the take runs on', () => {
    const { rerender } = mount(true, 0);
    rerender({ active: true, beat: 4 });
    expect(phraseLength()).toBe(3);

    // Still in bar 1 of three: nothing more is needed yet.
    rerender({ active: true, beat: 6 });
    expect(phraseLength()).toBe(3);

    rerender({ active: true, beat: 8 });
    expect(phraseLength()).toBe(4);
  });

  it('does nothing when the transport is not armed and rolling', () => {
    const { rerender } = mount(false, 0);
    rerender({ active: false, beat: 4 });

    expect(phraseLength()).toBe(2);
  });

  // A range drawn on the phrase ruler is an explicit "repeat this".
  it('keeps looping a drawn play range', () => {
    editorStore.setState({ phraseLoop: { start: 0, end: 8 } });
    const { rerender } = mount(true, 0);
    rerender({ active: true, beat: 4 });

    expect(phraseLength()).toBe(2);
  });

  it('does nothing in the arrangement, where there is no phrase to grow', () => {
    const phraseId = state().editingPhraseId!;
    state().closePhrase();
    const { rerender } = mount(true, 0);
    rerender({ active: true, beat: 4 });

    expect(state().project!.phrases.find(p => p.id === phraseId)!.bars.length).toBe(2);
  });

  describe('when the take ends', () => {
    it('gives back the bars it reached for and never wrote into', () => {
      const { rerender } = mount(true, 0);
      rerender({ active: true, beat: 4 });
      expect(phraseLength()).toBe(3);

      rerender({ active: false, beat: 4 });
      expect(phraseLength()).toBe(2);
    });

    it('keeps a bar the take actually played in', () => {
      const { rerender } = mount(true, 0);
      rerender({ active: true, beat: 4 });
      state().recordSegment(trackId(), 9, note('take'));
      expect(phraseLength()).toBe(3);

      rerender({ active: false, beat: 9 });
      expect(phraseLength()).toBe(3);
    });

    it('never trims below the length the phrase opened at', () => {
      // An empty two-bar phrase stays two bars, however little was played into it.
      const { rerender } = mount(true, 0);
      rerender({ active: true, beat: 4 });
      rerender({ active: false, beat: 4 });

      expect(phraseLength()).toBe(2);
    });

    it('trims on unmount too', () => {
      const { rerender, unmount } = mount(true, 0);
      rerender({ active: true, beat: 4 });
      expect(phraseLength()).toBe(3);

      unmount();
      expect(phraseLength()).toBe(2);
    });
  });

  // The bars a take adds belong to the take: one Ctrl+Z takes both.
  describe('the undo pass', () => {
    it('folds the growth into the take rather than making history of its own', () => {
      const ur = createUndoRedoMiddleware<Project | null>(null, 50);
      setRecordingGate(ur.setRecording);
      const unsubscribe = projectStore.subscribe(full => ur.pushState(full.project));

      const { rerender } = renderHook(
        (props: { active: boolean; beat: number }) => {
          useRecordExtend(props.active, props.beat);
          useRecordSession(props.active, ur);
        },
        { initialProps: { active: true, beat: 0 } }
      );

      rerender({ active: true, beat: 4 });
      state().recordSegment(trackId(), 9, note('take'));
      expect(phraseLength()).toBe(3);
      expect(ur.hasPassChanges()).toBe(true);

      // App's mid-take undo: scrap the pass, back to what it opened on.
      projectStore.setState({ project: ur.abortPass() });
      expect(phraseLength()).toBe(2);

      rerender({ active: false, beat: 9 });
      unsubscribe();
      setRecordingGate(null);
    });
  });
});
