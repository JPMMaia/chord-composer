import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { ArrangementView } from '@/components/ArrangementView';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { editorStore } from '@/store/editorStore';
import { DEFAULT_SNAP_BEATS } from '@/engine/timeline';
import { PIXELS_PER_BEAT } from '@/utils/constants';

/**
 * The song seen whole. Everything here is measured in *bars*, so the fixtures below
 * speak in bars and convert to pixels only where a pointer event demands it.
 *
 * jsdom has no layout, so two things have to be told what the pointer is over: the
 * rows container's rect reads as zero, which is what makes `clientX` read straight as
 * pixels, and `document.elementFromPoint` is stubbed to the row a drag should land on.
 */

const state = () => projectStore.getState();
const clips = () => state().project!.clips;
const phrases = () => state().project!.phrases;

/** The project's instruments, in row order. */
const trackId = (index = 0) => state().project!.tracks[index].id;

/** Beats per bar in the fixtures — every bar is 4/4. */
const BAR_BEATS = 4;
const BAR_PX = BAR_BEATS * PIXELS_PER_BEAT;

function row(id: string) {
  return screen.getByTestId(`arrangement-row-${id}`);
}

/** Drag across one row from bar to bar, which draws a new phrase. */
function dragRow(id: string, fromBar: number, toBar: number) {
  const target = row(id);
  document.elementFromPoint = () => target;
  fireEvent.pointerDown(target, { clientX: fromBar * BAR_PX, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: toBar * BAR_PX + 1, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: toBar * BAR_PX + 1, pointerId: 1 });
}

/** Drag an existing block, possibly onto another row. */
function dragClip(
  clipId: string,
  fromBar: number,
  toBar: number,
  toTrackId: string,
  modifiers: Partial<PointerEventInit> = {}
) {
  document.elementFromPoint = () => row(toTrackId);
  fireEvent.pointerDown(screen.getByTestId(`clip-${clipId}`), {
    clientX: fromBar * BAR_PX,
    pointerId: 1,
  });
  fireEvent.pointerMove(window, { clientX: toBar * BAR_PX + 1, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: toBar * BAR_PX + 1, pointerId: 1, ...modifiers });
}

describe('ArrangementView', () => {
  const originalElementFromPoint = document.elementFromPoint;

  beforeEach(() => {
    state().resetProject();
    selectionStore.getState().clearSelection();
    editorStore.setState({
      snapBeats: DEFAULT_SNAP_BEATS,
      pixelsPerBeat: PIXELS_PER_BEAT,
      scrollX: 0,
      maxScrollX: 0,
      viewportWidth: 0,
      view: 'arrangement',
    });

    state().createProject();
    for (let i = 0; i < 7; i++) state().addBar();
    state().addTrack('Bass');
  });

  afterEach(() => {
    document.elementFromPoint = originalElementFromPoint;
    cleanup();
  });

  // ---------------------------------------------------------------------------
  // Rows and blocks
  // ---------------------------------------------------------------------------

  it('renders one row per instrument, in the sidebar’s order', () => {
    render(<ArrangementView />);

    expect(row(trackId(0))).toBeInTheDocument();
    expect(row(trackId(1))).toBeInTheDocument();
    expect(screen.getByTestId(`arrangement-gutter-${trackId(1)}`)).toHaveTextContent('Bass');
  });

  it('renders a block per placement, on the row of the instrument playing it', () => {
    const clipId = state().addPhraseClip(trackId(1), 2, 2)!;
    render(<ArrangementView />);

    const block = screen.getByTestId(`clip-${clipId}`);
    expect(row(trackId(1))).toContainElement(block);
    expect(block).toHaveStyle({ left: `${2 * BAR_PX}px`, width: `${2 * BAR_PX}px` });
  });

  it('shows a group’s members as their own rows, under its header', () => {
    const groupId = state().addTrackGroup('Rhythm')!;
    state().moveTrack(trackId(1), groupId, null);
    render(<ArrangementView />);

    expect(screen.getByTestId(`arrangement-group-${groupId}`)).toHaveTextContent('Rhythm');
    expect(row(trackId(1))).toBeInTheDocument();
  });

  it('marks a phrase played in several places, and lists none as unplaced', () => {
    const first = state().addPhraseClip(trackId(0), 0, 2)!;
    const phraseId = clips().find(c => c.id === first)!.phraseId;
    const second = state().placePhrase(phraseId, trackId(1), 4)!;

    render(<ArrangementView />);

    expect(screen.getByTestId(`clip-linked-${first}`)).toBeInTheDocument();
    expect(screen.getByTestId(`clip-linked-${second}`)).toBeInTheDocument();
    expect(screen.getByTestId('phrase-library')).toHaveTextContent('every phrase is placed');
  });

  it('keeps a phrase whose last placement was removed, in the library', () => {
    const clipId = state().addPhraseClip(trackId(0), 0, 2)!;
    const phraseId = clips().find(c => c.id === clipId)!.phraseId;
    state().removeClip(clipId);

    render(<ArrangementView />);

    expect(screen.getByTestId(`library-phrase-${phraseId}`)).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Creating, moving, opening
  // ---------------------------------------------------------------------------

  it('creates a phrase spanning the bars a drag crossed', () => {
    render(<ArrangementView />);
    dragRow(trackId(0), 1, 3);

    expect(clips()).toHaveLength(1);
    expect(clips()[0]).toMatchObject({ trackId: trackId(0), startBar: 1 });
    expect(phrases()[0].bars).toHaveLength(3);
  });

  it('draws a preview while a create drag is in flight', () => {
    render(<ArrangementView />);
    const target = row(trackId(0));
    document.elementFromPoint = () => target;

    fireEvent.pointerDown(target, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 2 * BAR_PX + 1, pointerId: 1 });

    expect(screen.getByTestId('clip-ghost')).toHaveStyle({ width: `${3 * BAR_PX}px` });

    fireEvent.pointerUp(window, { clientX: 2 * BAR_PX + 1, pointerId: 1 });
    expect(screen.queryByTestId('clip-ghost')).not.toBeInTheDocument();
  });

  it('moves a block to another instrument, which then plays it', () => {
    const clipId = state().addPhraseClip(trackId(0), 0, 2)!;
    render(<ArrangementView />);

    dragClip(clipId, 0, 4, trackId(1));

    expect(clips()[0]).toMatchObject({ trackId: trackId(1), startBar: 4 });
  });

  it('refuses a move that would land on another block, leaving both put', () => {
    const first = state().addPhraseClip(trackId(0), 0, 2)!;
    const second = state().addPhraseClip(trackId(0), 4, 2)!;
    render(<ArrangementView />);

    dragClip(second, 4, 1, trackId(0));

    expect(clips().find(c => c.id === second)!.startBar).toBe(4);
    expect(clips().find(c => c.id === first)!.startBar).toBe(0);
  });

  it('opens the phrase editor on a double-click', () => {
    const clipId = state().addPhraseClip(trackId(1), 2, 2)!;
    render(<ArrangementView />);

    fireEvent.doubleClick(screen.getByTestId(`clip-${clipId}`));

    expect(state().editingPhraseId).toBe(clips()[0].phraseId);
    expect(editorStore.getState().view).toBe('phrase');
    // The editor takes its sound from the row the block was opened on.
    expect(selectionStore.getState().selectedTrackId).toBe(trackId(1));
  });

  it('selects a block on press, and removes it on Delete', () => {
    const clipId = state().addPhraseClip(trackId(0), 0, 2)!;
    render(<ArrangementView />);

    fireEvent.pointerDown(screen.getByTestId(`clip-${clipId}`), { clientX: 0, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 0, pointerId: 1 });
    expect(selectionStore.getState().selectedClipId).toBe(clipId);

    fireEvent.keyDown(window, { key: 'Delete' });
    expect(clips()).toHaveLength(0);
    // …and the music it placed is still there to be placed again.
    expect(phrases()).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Duplicating — with music of its own, or linked
  // ---------------------------------------------------------------------------

  /** Pick a block the way a press does, so the clip shortcuts are listening. */
  function select(clipId: string) {
    fireEvent.pointerDown(screen.getByTestId(`clip-${clipId}`), { clientX: 0, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 0, pointerId: 1 });
  }

  it('duplicates with Ctrl+D, right after the block it copied, music and all', () => {
    const clipId = state().addPhraseClip(trackId(0), 0, 2)!;
    render(<ArrangementView />);

    select(clipId);
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true });

    expect(clips()).toHaveLength(2);
    // A phrase of its own is the whole difference from the linked copy below.
    expect(phrases()).toHaveLength(2);
    expect(clips()[1].startBar).toBe(2);
    expect(clips()[1].phraseId).not.toBe(clips()[0].phraseId);
  });

  it('duplicates linked with Ctrl+Shift+D, sharing the one phrase', () => {
    const clipId = state().addPhraseClip(trackId(0), 0, 2)!;
    render(<ArrangementView />);

    select(clipId);
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true, shiftKey: true });

    expect(clips()).toHaveLength(2);
    expect(phrases()).toHaveLength(1);
    expect(clips()[1]).toMatchObject({ phraseId: clips()[0].phraseId, startBar: 2 });
  });

  it('walks past an occupied span rather than refusing the duplicate', () => {
    const clipId = state().addPhraseClip(trackId(0), 0, 2)!;
    state().addPhraseClip(trackId(0), 2, 2);
    render(<ArrangementView />);

    select(clipId);
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true, shiftKey: true });

    expect(clips()).toHaveLength(3);
    expect(clips().find(c => c.startBar === 4)!.phraseId).toBe(clips()[0].phraseId);
  });

  it('leaves an independent copy behind when a drag is released with Ctrl held', () => {
    const clipId = state().addPhraseClip(trackId(0), 0, 2)!;
    render(<ArrangementView />);

    dragClip(clipId, 0, 4, trackId(1), { ctrlKey: true });

    expect(clips()).toHaveLength(2);
    expect(phrases()).toHaveLength(2);
    expect(clips().find(c => c.id === clipId)).toMatchObject({
      trackId: trackId(0),
      startBar: 0,
    });
    expect(clips().find(c => c.id !== clipId)).toMatchObject({
      trackId: trackId(1),
      startBar: 4,
    });
  });

  it('leaves a linked copy behind when a drag is released with Alt held', () => {
    const clipId = state().addPhraseClip(trackId(0), 0, 2)!;
    render(<ArrangementView />);

    dragClip(clipId, 0, 4, trackId(1), { altKey: true });

    expect(clips()).toHaveLength(2);
    expect(phrases()).toHaveLength(1);
    expect(clips()[1].phraseId).toBe(clips()[0].phraseId);
  });

  // ---------------------------------------------------------------------------
  // The clip menu
  // ---------------------------------------------------------------------------

  it('right-clicking a block picks it and offers both ways to copy it', () => {
    const clipId = state().addPhraseClip(trackId(1), 0, 2)!;
    render(<ArrangementView />);

    fireEvent.contextMenu(screen.getByTestId(`clip-${clipId}`));

    expect(selectionStore.getState().selectedClipId).toBe(clipId);
    fireEvent.click(screen.getByTestId('clip-menu-duplicate'));

    expect(clips()).toHaveLength(2);
    expect(phrases()).toHaveLength(2);
    // The menu closes behind the command it ran.
    expect(screen.queryByTestId('clip-menu')).toBeNull();
  });

  it('duplicates linked from the menu', () => {
    const clipId = state().addPhraseClip(trackId(0), 0, 2)!;
    render(<ArrangementView />);

    fireEvent.contextMenu(screen.getByTestId(`clip-${clipId}`));
    fireEvent.click(screen.getByTestId('clip-menu-link'));

    expect(clips()).toHaveLength(2);
    expect(phrases()).toHaveLength(1);
  });

  it('offers Make unique only on a block that shares its phrase', () => {
    const first = state().addPhraseClip(trackId(0), 0, 2)!;
    render(<ArrangementView />);

    fireEvent.contextMenu(screen.getByTestId(`clip-${first}`));
    expect(screen.queryByTestId('clip-menu-unique')).toBeNull();

    fireEvent.click(screen.getByTestId('clip-menu-link'));
    fireEvent.contextMenu(screen.getByTestId(`clip-${first}`));
    expect(screen.getByTestId('clip-menu-unique')).toBeInTheDocument();
  });

  it('closes the menu on Escape and on a press elsewhere', () => {
    const clipId = state().addPhraseClip(trackId(0), 0, 2)!;
    render(<ArrangementView />);

    fireEvent.contextMenu(screen.getByTestId(`clip-${clipId}`));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('clip-menu')).toBeNull();

    fireEvent.contextMenu(screen.getByTestId(`clip-${clipId}`));
    fireEvent.pointerDown(row(trackId(1)), { clientX: 0, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 0, pointerId: 1 });
    expect(screen.queryByTestId('clip-menu')).toBeNull();
  });

  // The press that grabs a block stops the event so the row does not also start
  // drawing on it, which is why the menu listens in the capture phase.
  it('closes the menu on a press on another block', () => {
    const first = state().addPhraseClip(trackId(0), 0, 2)!;
    const second = state().addPhraseClip(trackId(0), 4, 2)!;
    render(<ArrangementView />);

    fireEvent.contextMenu(screen.getByTestId(`clip-${first}`));
    fireEvent.pointerDown(screen.getByTestId(`clip-${second}`), { clientX: 0, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 0, pointerId: 1 });

    expect(screen.queryByTestId('clip-menu')).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Resizing and the library
  // ---------------------------------------------------------------------------

  it('resizing a block changes the phrase, and so every placement of it', () => {
    const first = state().addPhraseClip(trackId(0), 0, 2)!;
    const phraseId = clips().find(c => c.id === first)!.phraseId;
    state().placePhrase(phraseId, trackId(1), 4);

    render(<ArrangementView />);
    document.elementFromPoint = () => row(trackId(0));

    const grip = within(row(trackId(0))).getByRole('button', { name: /^Resize / });
    fireEvent.pointerDown(grip, { clientX: 2 * BAR_PX - 1, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 3 * BAR_PX + 1, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 3 * BAR_PX + 1, pointerId: 1 });

    expect(phrases()[0].bars).toHaveLength(4);
  });

  it('places a phrase dragged out of the library onto the row it is dropped on', () => {
    const clipId = state().addPhraseClip(trackId(0), 0, 2)!;
    const phraseId = clips().find(c => c.id === clipId)!.phraseId;
    state().removeClip(clipId);

    render(<ArrangementView />);
    document.elementFromPoint = () => row(trackId(1));

    fireEvent.pointerDown(screen.getByTestId(`library-phrase-${phraseId}`), {
      clientX: 0,
      pointerId: 1,
    });
    fireEvent.pointerMove(window, { clientX: 4 * BAR_PX + 1, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 4 * BAR_PX + 1, pointerId: 1 });

    expect(clips()).toEqual([
      expect.objectContaining({ phraseId, trackId: trackId(1), startBar: 4 }),
    ]);
  });

  // ---------------------------------------------------------------------------
  // Playhead
  // ---------------------------------------------------------------------------

  it('draws the playhead at the beat playback has reached', () => {
    render(<ArrangementView playheadBeat={6} />);

    expect(screen.getByTestId('arrangement-playhead')).toHaveStyle({
      left: `${6 * PIXELS_PER_BEAT}px`,
    });
  });

  it('parks the playhead at the top of the song when nothing is playing', () => {
    render(<ArrangementView />);

    expect(screen.getByTestId('arrangement-playhead')).toHaveStyle({ left: '0px' });
  });

  it('scales the playhead with the zoom, like everything else on the beat axis', () => {
    const { rerender } = render(<ArrangementView playheadBeat={6} />);

    editorStore.getState().setPixelsPerBeat(PIXELS_PER_BEAT * 2);
    rerender(<ArrangementView playheadBeat={6} />);

    expect(screen.getByTestId('arrangement-playhead')).toHaveStyle({
      left: `${6 * PIXELS_PER_BEAT * 2}px`,
    });
  });

  it('clamps the playhead to the end of the song', () => {
    const totalBeats = state().project!.bars.length * BAR_BEATS;
    render(<ArrangementView playheadBeat={totalBeats + 20} />);

    expect(screen.getByTestId('arrangement-playhead')).toHaveStyle({
      left: `${totalBeats * PIXELS_PER_BEAT}px`,
    });
  });

  // Drags hit-test with `document.elementFromPoint`, so a playhead that answered the
  // pointer would swallow every gesture that passed under it.
  it('keeps the playhead out of the way of the pointer', () => {
    render(<ArrangementView playheadBeat={6} />);

    expect(screen.getByTestId('arrangement-playhead')).toHaveClass('pointer-events-none');
  });
});
