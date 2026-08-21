import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { projectStore, setRecordingGate } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { editorStore } from '@/store/editorStore';
import { usePhraseEditorGuard } from '@/hooks/usePhraseEditorGuard';
import { createUndoRedoMiddleware } from '@/engine/undoRedo';
import { PHRASE_TRACK_KEY } from '@/engine/phrases';
import { barChords } from '@/engine/timeline';
import type { Project } from '@/types/music';

/**
 * Undo, across the seam between the arrangement and the phrase editor.
 *
 * The two halves here are the ones the store cannot get right on its own. An undo
 * puts a whole `project` back without going through any action, so anything holding
 * an id into the document — `editingPhraseId` — has to be re-checked afterwards
 * rather than kept in step by the action that changed it.
 */

const state = () => projectStore.getState();
const clips = () => state().project!.clips;
const trackId = (index = 0) => state().project!.tracks[index].id;

/** Runs the rule App runs, and nothing else. */
const Guard: React.FC = () => {
  usePhraseEditorGuard();
  return null;
};

describe('E2E — phrases and undo', () => {
  let ur: ReturnType<typeof createUndoRedoMiddleware<Project | null>>;
  let unsub: (() => void) | undefined;

  /** Put the project back the way undo would: whole, and through no action. */
  const undo = () =>
    act(() => {
      const prev = ur.undo();
      if (prev) projectStore.setState({ project: prev });
    });

  beforeEach(() => {
    unsub?.();
    state().resetProject();
    selectionStore.getState().clearSelection();
    editorStore.getState().setView('arrangement');

    ur = createUndoRedoMiddleware<Project | null>(null, 50);
    setRecordingGate(ur.setRecording);
    unsub = projectStore.subscribe(full => ur.pushState(full.project));

    state().createProject();
    for (let i = 0; i < 8; i++) state().addBar();
    state().addTrack('Strings');
    selectionStore.getState().selectTrack(trackId());
  });

  afterEach(() => {
    unsub?.();
    cleanup();
  });

  it('restores a clip to the row and bar it was moved from', () => {
    const clipId = state().addPhraseClip(trackId(), 0, 2)!;

    state().moveClip(clipId, trackId(1), 4);
    expect(clips()[0]).toMatchObject({ trackId: trackId(1), startBar: 4 });

    undo();

    expect(clips()[0]).toMatchObject({ trackId: trackId(), startBar: 0 });
  });

  // A duplicate brings a phrase into the project as well as a clip, so undoing one
  // has to take both away — and leave the phrase it was copied from untouched.
  it('undo takes back a duplicate, phrase and all', () => {
    const clipId = state().addPhraseClip(trackId(), 0, 2)!;
    state().openClip(clipId);
    const original = state().editingPhraseId!;
    const bar = state().project!.phrases.find(p => p.id === original)!.bars[0];
    state().insertSegment(bar.id, 0, { id: 's1', startBeat: 0, duration: 1, notes: [] }, trackId());

    const copyId = state().duplicateClip(clipId, trackId(), 4)!;
    const copy = clips().find(c => c.id === copyId)!.phraseId;
    state().openClip(copyId);
    const copyBar = state().project!.phrases.find(p => p.id === copy)!.bars[1];
    state().insertSegment(
      copyBar.id,
      0,
      { id: 's2', startBeat: 0, duration: 1, notes: [] },
      trackId()
    );

    render(<Guard />);
    undo(); // the edit to the copy
    undo(); // the duplicate itself

    expect(state().project!.phrases.some(p => p.id === copy)).toBe(false);
    expect(clips()).toHaveLength(1);
    // The phrase it was copied from kept its own segment, and none of the copy's.
    const bars = state().project!.phrases.find(p => p.id === original)!.bars;
    expect(barChords(bars[0], PHRASE_TRACK_KEY).map(c => c.id)).toEqual(['s1']);
    expect(barChords(bars[1], PHRASE_TRACK_KEY)).toHaveLength(0);
  });

  // The copy Make Unique made is what the editor was left pointing at, and undo takes
  // it away without telling anyone. Left alone, the timeline would go on showing a
  // phrase that is no longer in the project and drop every edit made into it.
  it('closes the editor when undo takes away the phrase it was editing', () => {
    const clipId = state().addPhraseClip(trackId(), 0, 2)!;
    const copyId = state().linkClip(clipId, trackId(), 4)!;

    state().makeClipUnique(copyId);
    const unique = clips().find(c => c.id === copyId)!.phraseId;
    state().openClip(copyId);
    expect(state().editingPhraseId).toBe(unique);

    render(<Guard />);
    undo();

    expect(state().project!.phrases.some(p => p.id === unique)).toBe(false);
    expect(state().editingPhraseId).toBeNull();
    expect(editorStore.getState().view).toBe('arrangement');
  });

  // Inserting bars mid-phrase moves two things that are stored apart — the bars, and
  // the curves running across them — so undo has to put both back, not just the grid.
  it('puts the bars and the curves back after a mid-phrase insert', () => {
    const clipId = state().addPhraseClip(trackId(), 0, 2)!;
    const phraseId = state().project!.phrases[0].id;
    state().addVolumePoint(phraseId, 0, 0.2);
    state().addVolumePoint(phraseId, 4, 1);
    state().openClip(clipId);

    state().insertPhraseBarsAt(phraseId, 1, 1);
    expect(state().project!.phrases[0].bars).toHaveLength(3);
    expect(state().project!.phrases[0].volumeAutomation).toEqual([
      { beat: 0, value: 0.2 },
      { beat: 8, value: 1 },
    ]);

    render(<Guard />);
    undo();

    expect(state().project!.phrases[0].bars).toHaveLength(2);
    expect(state().project!.phrases[0].volumeAutomation).toEqual([
      { beat: 0, value: 0.2 },
      { beat: 4, value: 1 },
    ]);
    expect(state().editingPhraseId).toBe(phraseId);
  });

  // The other way round: a phrase that survives the undo is still being edited, so
  // the guard has to leave it alone rather than closing on any change at all.
  it('leaves the editor open when the phrase survives the undo', () => {
    const clipId = state().addPhraseClip(trackId(), 0, 2)!;
    state().openClip(clipId);
    const phraseId = state().editingPhraseId;

    state().setPhraseLength(phraseId!, 4);
    render(<Guard />);
    undo();

    expect(state().editingPhraseId).toBe(phraseId);
    expect(editorStore.getState().view).toBe('phrase');
  });

  // Which *placement* is open is what the audition plays, so it has to be let go of
  // on the same terms as the phrase — and an undo that removes the block, like one
  // that removes the phrase, goes around every action that would have cleared it.
  it('lets go of the open placement when the editor closes', () => {
    const clipId = state().addPhraseClip(trackId(), 0, 2)!;
    state().openClip(clipId);
    expect(state().editingClipId).toBe(clipId);

    state().closePhrase();

    expect(state().editingClipId).toBeNull();
  });

  it('lets go of it when undo takes away the phrase it belonged to', () => {
    const clipId = state().addPhraseClip(trackId(), 0, 2)!;
    const copyId = state().linkClip(clipId, trackId(), 4)!;
    state().makeClipUnique(copyId);
    state().openClip(copyId);

    render(<Guard />);
    undo();

    expect(state().editingClipId).toBeNull();
  });

  // Make Unique gives the block its own copy of the phrase; the block itself is the
  // same one, and it is still what the editor is pointed at.
  it('keeps the open placement across a Make Unique', () => {
    const clipId = state().addPhraseClip(trackId(), 0, 2)!;
    const copyId = state().linkClip(clipId, trackId(), 4)!;
    state().openClip(copyId);

    state().makeClipUnique(copyId);

    expect(state().editingClipId).toBe(copyId);
  });
});
