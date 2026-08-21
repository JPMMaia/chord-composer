import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { ChordTimeline } from '@/components/ChordTimeline';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { editorStore } from '@/store/editorStore';
import { DEFAULT_SNAP_BEATS } from '@/engine/timeline';
import { phraseById } from '@/engine/phrases';
import { openTestPhrase } from '../helpers/phrases';
import { PIXELS_PER_BEAT } from '@/utils/constants';

/**
 * The automation stack, in the view it belongs to.
 *
 * It used to hang under the arrangement, which was honest while a curve was one line
 * across the whole song drawn under one instrument. A curve belongs to the *phrase*
 * now — written once on its own local beats and heard at every placement of it — so
 * the stack is where the phrase is edited, and it is the phrase, not the instrument,
 * that a point is written to.
 */

const tracks = () => projectStore.getState().project!.tracks;

/** The instrument the phrase is placed on — the Piano every project starts with. */
const trackId = () => tracks()[0].id;

/** The phrase the timeline has open, and whose curves the stack shows. */
let phraseId = '';
const phrase = () => phraseById(projectStore.getState().project!.phrases, phraseId)!;

/**
 * A second phrase on the same instrument, placed after the open one.
 *
 * `openTestPhrase` always places at bar 0, which the phrase under test already
 * occupies, so the tests that need two of them ask for the next free bar directly.
 */
function secondPhrase(startBar: number): string {
  const clipId = projectStore.getState().addPhraseClip(trackId(), startBar, 1)!;
  return projectStore.getState().project!.clips.find(c => c.id === clipId)!.phraseId;
}

beforeEach(() => {
  selectionStore.getState().clearSelection();
  editorStore.setState({
    snapBeats: DEFAULT_SNAP_BEATS,
    pixelsPerBeat: PIXELS_PER_BEAT,
    scrollX: 0,
    maxScrollX: 0,
    viewportWidth: 0,
    showAutomation: true,
    paletteScale: { root: 'C', type: 'major' },
    paletteOctave: 4,
    formulaStartDegree: 0,
    draggingFormulaId: null,
  });
  projectStore.getState().createProject();
  // The timeline draws the open phrase against the selected instrument, and needs
  // both: the phrase for its bars and curves, the instrument for its fader.
  selectionStore.getState().selectTrack(trackId());
  phraseId = openTestPhrase(trackId(), 2).phraseId;
});

describe('ChordTimeline volume automation lane', () => {
  it('shows the lane under the phrase lanes by default', () => {
    render(<ChordTimeline />);

    expect(screen.getByTestId('automation-lane')).toBeInTheDocument();
    // Labelled in the gutter, which is outside the scroll container so the label
    // stays put while the lane beside it scrolls.
    expect(within(screen.getByTestId('timeline-gutter')).getByText('Volume')).toBeInTheDocument();
  });

  it('hides the lane, and its gutter label, when toggled off', () => {
    render(<ChordTimeline />);

    fireEvent.click(screen.getByLabelText('Automation lanes'));

    expect(screen.queryByTestId('automation-lane')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('timeline-gutter')).queryByText('Volume')).toBeNull();
  });

  it('reports its state on the toggle, so it reads as pressed', () => {
    render(<ChordTimeline />);
    const toggle = screen.getByLabelText('Automation lanes');

    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('spans the phrase, on the same axis as its ruler', () => {
    render(<ChordTimeline />);

    // Two bars of four beats: the phrase's own length, not the song's.
    const width = `${8 * PIXELS_PER_BEAT}px`;
    expect(screen.getByTestId('timeline-ruler')).toHaveStyle({ width });
    expect(screen.getByTestId('automation-lane')).toHaveStyle({ width });
  });

  it('writes a point onto the phrase rather than onto the instrument', () => {
    projectStore.getState().addVolumePoint(phraseId, 2, 0.5);
    render(<ChordTimeline />);

    expect(phrase().volumeAutomation).toEqual([{ beat: 2, value: 0.5 }]);
    expect(screen.getByTestId('automation-point-0')).toBeInTheDocument();
  });

  describe('clearing the curve', () => {
    const clearLabel = () => `Clear volume curve for ${phrase().name}`;

    it('offers nothing to clear until there is a curve', () => {
      render(<ChordTimeline />);

      expect(screen.queryByLabelText(clearLabel())).not.toBeInTheDocument();
    });

    it('offers a Clear once a point exists', () => {
      projectStore.getState().addVolumePoint(phraseId, 2, 0.5);
      render(<ChordTimeline />);

      expect(screen.getByLabelText(clearLabel())).toBeInTheDocument();
    });

    it('removes every point, handing the phrase back to the fader', () => {
      projectStore.getState().addVolumePoint(phraseId, 2, 0.5);
      projectStore.getState().addVolumePoint(phraseId, 6, 0.2);
      render(<ChordTimeline />);

      fireEvent.click(screen.getByLabelText(clearLabel()));

      expect(phrase().volumeAutomation).toBeUndefined();
      // And the instrument with it: the compiled curve is gone, so the flat fader
      // is what drives it again.
      expect(tracks()[0].volumeAutomation).toBeUndefined();
      expect(screen.getByTestId('automation-flat-line')).toBeInTheDocument();
      expect(screen.queryByTestId('automation-curve')).not.toBeInTheDocument();
    });

    it('takes itself away once there is nothing left to clear', () => {
      projectStore.getState().addVolumePoint(phraseId, 2, 0.5);
      render(<ChordTimeline />);

      fireEvent.click(screen.getByLabelText(clearLabel()));

      expect(screen.queryByLabelText(clearLabel())).not.toBeInTheDocument();
    });

    it('clears only the open phrase', () => {
      const other = secondPhrase(2);
      projectStore.getState().addVolumePoint(other, 0, 0.5);
      projectStore.getState().addVolumePoint(phraseId, 4, 0.25);
      projectStore.getState().openPhrase(phraseId);
      render(<ChordTimeline />);

      fireEvent.click(screen.getByLabelText(clearLabel()));

      expect(phrase().volumeAutomation).toBeUndefined();
      expect(phraseById(projectStore.getState().project!.phrases, other)!.volumeAutomation).toEqual(
        [{ beat: 0, value: 0.5 }]
      );
    });
  });

  // The stack shows one phrase at a time — the one the timeline has open — because
  // its beats are that phrase's own and mean nothing on another.
  it('follows the open phrase', () => {
    projectStore.getState().addVolumePoint(phraseId, 2, 0.5);
    const second = secondPhrase(2);
    projectStore.getState().openPhrase(phraseId);

    render(<ChordTimeline />);
    expect(screen.getByTestId('automation-point-0')).toBeInTheDocument();

    act(() => projectStore.getState().openPhrase(second));
    expect(screen.queryByTestId('automation-point-0')).not.toBeInTheDocument();
    expect(screen.getByTestId('automation-flat-line')).toBeInTheDocument();
  });
});
