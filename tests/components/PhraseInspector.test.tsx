import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { PhraseInspector } from '@/components/PhraseInspector';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';

/**
 * What the selected block can do that the arrangement's gestures cannot say.
 *
 * The two duplicate buttons are the panel's whole reason to be tested: they differ
 * only in what they leave behind, which is invisible in the block itself until
 * something is edited.
 */

const state = () => projectStore.getState();
const clips = () => state().project!.clips;
const phrases = () => state().project!.phrases;
const trackId = () => state().project!.tracks[0].id;

describe('PhraseInspector', () => {
  beforeEach(() => {
    state().resetProject();
    selectionStore.getState().clearSelection();
    state().createProject();
    for (let i = 0; i < 8; i++) state().addBar();
  });

  afterEach(cleanup);

  it('shows nothing until a block is selected', () => {
    state().addPhraseClip(trackId(), 0, 2);
    render(<PhraseInspector />);

    expect(screen.queryByTestId('phrase-inspector')).toBeNull();
  });

  it('duplicates the block with music of its own, and follows the copy', () => {
    const clipId = state().addPhraseClip(trackId(), 0, 2)!;
    selectionStore.getState().selectClip(clipId);
    render(<PhraseInspector />);

    fireEvent.click(screen.getByTestId('duplicate-clip'));

    expect(clips()).toHaveLength(2);
    expect(phrases()).toHaveLength(2);
    expect(clips()[1].startBar).toBe(2);
    expect(selectionStore.getState().selectedClipId).toBe(clips()[1].id);
  });

  it('duplicates it linked, sharing the one phrase, and then offers Make unique', () => {
    const clipId = state().addPhraseClip(trackId(), 0, 2)!;
    selectionStore.getState().selectClip(clipId);
    render(<PhraseInspector />);

    expect(screen.queryByTestId('make-unique')).toBeNull();

    fireEvent.click(screen.getByTestId('link-clip'));

    expect(clips()).toHaveLength(2);
    expect(phrases()).toHaveLength(1);
    expect(screen.getByTestId('phrase-placements')).toHaveTextContent('2 places');
    expect(screen.getByTestId('make-unique')).toBeInTheDocument();
  });
});
