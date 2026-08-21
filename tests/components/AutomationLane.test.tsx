import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AutomationLane, AUTOMATION_LANE_HEIGHT } from '@/components/AutomationLane';
import { projectStore } from '@/store/projectStore';
import { editorStore } from '@/store/editorStore';
import { selectionStore } from '@/store/selectionStore';
import { DEFAULT_SNAP_BEATS, getTotalBeats } from '@/engine/timeline';
import { laneKey, VOLUME_LANE_KEY } from '@/engine/parameterAutomation';
import { phraseById } from '@/engine/phrases';
import { openTestPhrase } from '../helpers/phrases';
import { PIXELS_PER_BEAT } from '@/utils/constants';

/**
 * jsdom has no layout engine, so every `getBoundingClientRect` reads as zero. That
 * makes `clientX` the offset within the lane and `clientY` the offset from its top,
 * which is exactly what the component's own arithmetic wants — the same convenience
 * `ChordTimeline.test.tsx` leans on.
 */
const at = (beat: number, value: number) => ({
  clientX: beat * PIXELS_PER_BEAT,
  clientY: (1 - value) * AUTOMATION_LANE_HEIGHT,
  pointerId: 1,
  button: 0,
});

function trackId(): string {
  return projectStore.getState().project!.tracks[0].id;
}

/**
 * The phrase the curves belong to — one, spanning the whole song, opened in
 * `beforeEach`.
 *
 * A curve is written on the phrase rather than on the instrument, so every gesture
 * here is checked by reading it back off the phrase. This one covers the song end to
 * end, which is what makes a beat in the lane and a beat in the song the same number.
 */
let openPhraseId = '';
const phraseId = (): string => openPhraseId;

function phrase() {
  return phraseById(projectStore.getState().project!.phrases, openPhraseId)!;
}

function points() {
  return phrase().volumeAutomation;
}

/**
 * Render the volume lane for the project's one instrument.
 *
 * The lane is target-agnostic, so the wiring that makes it *the volume lane*
 * lives in the caller — here, and in `ChordTimeline`. Keeping that wiring in one
 * helper is what lets these cases go on being written in terms of the curve.
 */
function renderLane() {
  const project = projectStore.getState().project!;
  const track = project.tracks[0];
  const store = () => projectStore.getState();

  return render(
    <AutomationLane
      laneKey={VOLUME_LANE_KEY}
      label="Volume"
      points={points() ?? []}
      flatLevel={track.volume}
      readPoints={() => points() ?? []}
      onAdd={(beat, value) => store().addVolumePoint(phraseId(), beat, value)}
      onMove={(i, beat, value) => store().moveVolumePoint(phraseId(), i, beat, value)}
      onRemove={i => store().removeVolumePoint(phraseId(), i)}
      bars={phrase().bars}
      projectTs={project.timeSignature}
      totalBeats={getTotalBeats(phrase().bars, project.timeSignature)}
    />
  );
}

/** Pick a point in the volume lane, the way the component itself would. */
function selectVolumePoint(index: number | null) {
  selectionStore
    .getState()
    .selectAutomationPoint(index === null ? null : { laneKey: VOLUME_LANE_KEY, index });
}

/** Press, move and release — the drag gesture, in lane coordinates. */
function drag(testId: string, to: { beat: number; value: number }) {
  fireEvent.pointerDown(screen.getByTestId(testId), at(0, 1));
  fireEvent.pointerMove(window, at(to.beat, to.value));
  fireEvent.pointerUp(window, at(to.beat, to.value));
}

describe('AutomationLane', () => {
  beforeEach(() => {
    editorStore.setState({
      snapBeats: DEFAULT_SNAP_BEATS,
      pixelsPerBeat: PIXELS_PER_BEAT,
      showAutomation: true,
    });
    selectionStore.getState().clearSelection();
    projectStore.getState().createProject();
    projectStore.getState().addBar();
    projectStore.getState().addBar();
    projectStore.getState().setTrackVolume(trackId(), 0.8);
    // Two bars of phrase over the song's two, so a beat in the lane is a beat in
    // the song and the cases can go on being written in absolute numbers.
    openPhraseId = openTestPhrase(trackId(), 2).phraseId;
  });

  it('draws the flat volume when there is no curve', () => {
    renderLane();

    expect(screen.getByTestId('automation-flat-line')).toBeInTheDocument();
    expect(screen.queryByTestId('automation-curve')).not.toBeInTheDocument();
    // Drawn at the level the instrument actually plays at: 0.8 of the lane, from
    // the top, because 1.0 is the top and 0 the bottom.
    expect(screen.getByTestId('automation-flat-line')).toHaveAttribute(
      'y1',
      String((1 - 0.8) * AUTOMATION_LANE_HEIGHT)
    );
  });

  it('adds a point where the lane is pressed', () => {
    renderLane();
    fireEvent.pointerDown(screen.getByTestId('automation-lane').querySelector('rect')!, at(2, 0.5));

    expect(points()).toEqual([{ beat: 2, value: 0.5 }]);
  });

  it('snaps the beat to the shared grid but leaves the level alone', () => {
    editorStore.getState().setSnapBeats(1);
    renderLane();
    fireEvent.pointerDown(
      screen.getByTestId('automation-lane').querySelector('rect')!,
      at(1.4, 0.7)
    );

    expect(points()![0].beat).toBe(1);
    // A level is not on a lattice — quantising it would make a fine ride impossible.
    expect(points()![0].value).toBeCloseTo(0.7, 5);
  });

  it('snaps to a finer grid when the editor is set to one', () => {
    editorStore.getState().setSnapBeats(0.5);
    renderLane();
    fireEvent.pointerDown(
      screen.getByTestId('automation-lane').querySelector('rect')!,
      at(1.4, 0.5)
    );

    expect(points()![0].beat).toBe(1.5);
  });

  it('draws a curve once there are points', () => {
    projectStore.getState().addVolumePoint(phraseId(), 0, 1);
    projectStore.getState().addVolumePoint(phraseId(), 4, 0);
    renderLane();

    expect(screen.queryByTestId('automation-flat-line')).not.toBeInTheDocument();

    const project = projectStore.getState().project!;
    const endX = getTotalBeats(project.bars, project.timeSignature) * PIXELS_PER_BEAT;
    const top = 0;
    const bottom = AUTOMATION_LANE_HEIGHT;

    // A flat run in from the left edge, the two points, then a flat run out to the
    // right: a curve holds its end values rather than fading to silence at the edges.
    expect(screen.getByTestId('automation-curve')).toHaveAttribute(
      'points',
      `0,${top} 0,${top} ${4 * PIXELS_PER_BEAT},${bottom} ${endX},${bottom}`
    );
  });

  it('labels each point with where it sits and how loud it is', () => {
    projectStore.getState().addVolumePoint(phraseId(), 4, 0.5);
    renderLane();

    expect(screen.getByLabelText('Volume point at beat 4, 50%')).toBeInTheDocument();
  });

  it('moves a point on release, not on every move', () => {
    projectStore.getState().addVolumePoint(phraseId(), 0, 1);
    renderLane();

    fireEvent.pointerDown(screen.getByTestId('automation-point-0'), at(0, 1));
    fireEvent.pointerMove(window, at(2, 0.5));

    // Still where it started: a drag is one edit, committed when the pointer lifts,
    // so it is also one entry on the undo stack.
    expect(points()).toEqual([{ beat: 0, value: 1 }]);

    fireEvent.pointerUp(window, at(2, 0.5));
    expect(points()).toEqual([{ beat: 2, value: 0.5 }]);
  });

  it('leaves a point alone when the press never travels', () => {
    projectStore.getState().addVolumePoint(phraseId(), 2, 0.5);
    renderLane();

    fireEvent.pointerDown(screen.getByTestId('automation-point-0'), at(2, 0.5));
    fireEvent.pointerUp(window, at(2, 0.5));

    expect(points()).toEqual([{ beat: 2, value: 0.5 }]);
  });

  it('does not also add a point when one is grabbed', () => {
    projectStore.getState().addVolumePoint(phraseId(), 2, 0.5);
    renderLane();

    fireEvent.pointerDown(screen.getByTestId('automation-point-0'), at(2, 0.5));

    expect(points()).toHaveLength(1);
  });

  it('re-sorts when a point is dragged past its neighbour', () => {
    projectStore.getState().addVolumePoint(phraseId(), 0, 1);
    projectStore.getState().addVolumePoint(phraseId(), 2, 0.5);
    renderLane();

    drag('automation-point-0', { beat: 4, value: 0.25 });

    expect(points()).toEqual([
      { beat: 2, value: 0.5 },
      { beat: 4, value: 0.25 },
    ]);
  });

  it('removes a point on a double click', () => {
    projectStore.getState().addVolumePoint(phraseId(), 0, 1);
    projectStore.getState().addVolumePoint(phraseId(), 4, 0);
    renderLane();

    fireEvent.doubleClick(screen.getByTestId('automation-point-1'));

    expect(points()).toEqual([{ beat: 0, value: 1 }]);
  });

  it('goes back to the flat line once the last point is removed', () => {
    projectStore.getState().addVolumePoint(phraseId(), 4, 0.5);
    const { rerender } = renderLane();

    fireEvent.doubleClick(screen.getByTestId('automation-point-0'));

    const project = projectStore.getState().project!;
    rerender(
      <AutomationLane
        laneKey={VOLUME_LANE_KEY}
        label="Volume"
        points={points() ?? []}
        flatLevel={project.tracks[0].volume}
        readPoints={() => points() ?? []}
        onAdd={() => {}}
        onMove={() => {}}
        onRemove={() => {}}
        bars={phrase().bars}
        projectTs={project.timeSignature}
        totalBeats={getTotalBeats(phrase().bars, project.timeSignature)}
      />
    );

    expect(points()).toBeUndefined();
    expect(screen.getByTestId('automation-flat-line')).toBeInTheDocument();
  });

  it('clamps a drag that leaves the lane rather than refusing it', () => {
    projectStore.getState().addVolumePoint(phraseId(), 2, 0.5);
    renderLane();

    // Well above the top of the lane and left of its start.
    drag('automation-point-0', { beat: -3, value: 2 });

    expect(points()).toEqual([{ beat: 0, value: 1 }]);
  });

  it('draws a bar line for every bar, on the ruler\'s beats', () => {
    renderLane();

    const lines = screen.getAllByTestId('automation-bar-line');
    expect(lines).toHaveLength(projectStore.getState().project!.bars.length);
    expect(lines[1]).toHaveAttribute('x1', String(4 * PIXELS_PER_BEAT));
  });

  describe('selecting and erasing a point', () => {
    const selected = () => selectionStore.getState().selectedAutomationPoint?.index ?? null;
    const key = (k: string, target: EventTarget = window) =>
      fireEvent.keyDown(target, { key: k });

    beforeEach(() => {
      projectStore.getState().addVolumePoint(phraseId(), 0, 1);
      projectStore.getState().addVolumePoint(phraseId(), 4, 0.5);
      projectStore.getState().addVolumePoint(phraseId(), 8, 0);
      selectVolumePoint(null);
    });

    it('selects the point that was pressed', () => {
      renderLane();
      fireEvent.pointerDown(screen.getByTestId('automation-point-1'), at(4, 0.5));

      expect(selected()).toBe(1);
    });

    it('marks the selected point so it can be seen', () => {
      selectVolumePoint(1);
      renderLane();

      expect(screen.getByTestId('automation-point-1')).toHaveAttribute('data-selected', 'true');
      expect(screen.getByTestId('automation-point-0')).not.toHaveAttribute('data-selected');
    });

    it('erases only the selected point on Delete', () => {
      selectVolumePoint(1);
      renderLane();

      key('Delete');

      expect(points()).toEqual([
        { beat: 0, value: 1 },
        { beat: 8, value: 0 },
      ]);
    });

    it('accepts Backspace as well as Delete', () => {
      selectVolumePoint(0);
      renderLane();

      key('Backspace');

      expect(points()).toEqual([
        { beat: 4, value: 0.5 },
        { beat: 8, value: 0 },
      ]);
    });

    it('drops the selection with the point it erased', () => {
      selectVolumePoint(1);
      renderLane();

      key('Delete');

      // Or the index would name whichever point slid into that slot, and a second
      // Delete would erase a point nobody picked.
      expect(selected()).toBeNull();
    });

    it('erases nothing when no point is selected', () => {
      renderLane();

      key('Delete');

      expect(points()).toHaveLength(3);
    });

    it('lets the point go on Escape without erasing it', () => {
      selectVolumePoint(1);
      renderLane();

      key('Escape');

      expect(selected()).toBeNull();
      expect(points()).toHaveLength(3);
    });

    // The block shortcuts read the same key, and bail on an empty block selection.
    it('drops any block selection, so Delete has one meaning', () => {
      selectionStore.getState().selectSegment('some-block');
      renderLane();

      fireEvent.pointerDown(screen.getByTestId('automation-point-1'), at(4, 0.5));

      expect(selectionStore.getState().selectedSegmentIds).toEqual([]);
      expect(selected()).toBe(1);
    });

    it('ignores Delete typed into a field', () => {
      selectVolumePoint(1);
      renderLane();

      const input = document.createElement('input');
      document.body.appendChild(input);
      key('Delete', input);
      input.remove();

      expect(points()).toHaveLength(3);
    });

    it('ignores Delete held with a modifier', () => {
      selectVolumePoint(1);
      renderLane();

      fireEvent.keyDown(window, { key: 'Delete', ctrlKey: true });

      expect(points()).toHaveLength(3);
    });

    it('selects a freshly added point, ready to be erased again', () => {
      renderLane();
      fireEvent.pointerDown(screen.getByTestId('automation-lane').querySelector('rect')!, at(2, 0.5));

      // The new point sorts between beats 0 and 4.
      expect(selected()).toBe(1);
      expect(points()![1]).toEqual({ beat: 2, value: 0.5 });
    });

    it('follows a point the sort moved when a drag crosses its neighbour', () => {
      selectVolumePoint(0);
      renderLane();

      drag('automation-point-0', { beat: 6, value: 0.25 });

      // Dragged from beat 0 past beat 4, so it is now the middle point.
      expect(points()).toEqual([
        { beat: 4, value: 0.5 },
        { beat: 6, value: 0.25 },
        { beat: 8, value: 0 },
      ]);
      expect(selected()).toBe(1);
    });

    it('lets go of an index the curve has shrunk past', () => {
      selectVolumePoint(2);
      const { rerender } = renderLane();

      projectStore.getState().clearVolumeAutomation(phraseId());
      const project = projectStore.getState().project!;
      rerender(
        <AutomationLane
          laneKey={VOLUME_LANE_KEY}
          label="Volume"
          points={points() ?? []}
          flatLevel={project.tracks[0].volume}
          readPoints={() => points() ?? []}
          onAdd={() => {}}
          onMove={() => {}}
          onRemove={() => {}}
          bars={phrase().bars}
          projectTs={project.timeSignature}
          totalBeats={getTotalBeats(phrase().bars, project.timeSignature)}
        />
      );

      expect(selected()).toBeNull();
    });
  });

  /**
   * The lane knows nothing about volume — the point of generalising it. These
   * drive it through a plugin parameter instead, which is the same component with
   * different callbacks behind it.
   */
  describe('driving a plugin parameter instead', () => {
    const PARAM = 42;
    const TARGET = { kind: 'param', paramId: PARAM } as const;
    const KEY = laneKey(TARGET);

    /** The parameter lane's stored points, straight from the store. */
    const paramPoints = () => phrase().parameterAutomation?.[0].points ?? [];

    function renderParamLane() {
      const project = projectStore.getState().project!;
      const track = project.tracks[0];
      const store = () => projectStore.getState();

      return render(
        <AutomationLane
          laneKey={KEY}
          label="Cutoff"
          points={paramPoints()}
          // A parameter has no fader behind it, so there is no flat level to draw.
          flatLevel={null}
          readPoints={paramPoints}
          onAdd={(beat, value) => store().addLanePoint(phraseId(), KEY, beat, value)}
          onMove={(i, beat, value) => store().moveLanePoint(phraseId(), KEY, i, beat, value)}
          onRemove={i => store().removeLanePoint(phraseId(), KEY, i)}
          bars={phrase().bars}
          projectTs={project.timeSignature}
          totalBeats={getTotalBeats(phrase().bars, project.timeSignature)}
        />
      );
    }

    beforeEach(() => {
      projectStore.getState().addLane(phraseId(), TARGET, 'Cutoff');
    });

    // Nothing is driving the parameter, so a line at any level would be a claim
    // the app made up.
    it('draws no flat line when there is no curve', () => {
      renderParamLane();

      expect(screen.queryByTestId('automation-flat-line')).not.toBeInTheDocument();
      expect(screen.queryByTestId('automation-curve')).not.toBeInTheDocument();
    });

    it('adds a point to the parameter, not to the volume curve', () => {
      renderParamLane();
      fireEvent.pointerDown(
        screen.getByTestId('automation-lane').querySelector('rect')!,
        at(2, 0.5)
      );

      expect(paramPoints()).toEqual([{ beat: 2, value: 0.5 }]);
      expect(points()).toBeUndefined();
    });

    it('names itself and its points after the parameter', () => {
      projectStore.getState().addLanePoint(phraseId(), KEY, 4, 0.5);
      renderParamLane();

      expect(screen.getByLabelText('Cutoff automation lane')).toBeInTheDocument();
      expect(screen.getByLabelText('Cutoff point at beat 4, 50%')).toBeInTheDocument();
    });

    it('drags a point on release, like the volume lane does', () => {
      projectStore.getState().addLanePoint(phraseId(), KEY, 0, 1);
      renderParamLane();

      drag('automation-point-0', { beat: 2, value: 0.5 });

      expect(paramPoints()).toEqual([{ beat: 2, value: 0.5 }]);
    });

    // The reason the selection carries a lane key at all: an index picked in one
    // lane must not read as picked in another, or Delete would erase from both.
    it('does not answer to a point selected in the volume lane', () => {
      projectStore.getState().addLanePoint(phraseId(), KEY, 0, 1);
      selectVolumePoint(0);
      renderParamLane();

      expect(screen.getByTestId('automation-point-0')).not.toHaveAttribute('data-selected');

      fireEvent.keyDown(window, { key: 'Delete' });
      expect(paramPoints()).toHaveLength(1);
    });

    it('erases its own selected point on Delete', () => {
      projectStore.getState().addLanePoint(phraseId(), KEY, 0, 1);
      projectStore.getState().addLanePoint(phraseId(), KEY, 4, 0.5);
      renderParamLane();

      fireEvent.pointerDown(screen.getByTestId('automation-point-1'), at(4, 0.5));
      fireEvent.pointerUp(window, at(4, 0.5));
      fireEvent.keyDown(window, { key: 'Delete' });

      expect(paramPoints()).toEqual([{ beat: 0, value: 1 }]);
    });
  });

  it('redraws at the zoom the rest of the timeline is at', () => {
    projectStore.getState().addVolumePoint(phraseId(), 2, 0.5);
    editorStore.getState().setPixelsPerBeat(160);
    renderLane();

    expect(screen.getByTestId('automation-point-0')).toHaveAttribute('cx', String(2 * 160));
  });
});
