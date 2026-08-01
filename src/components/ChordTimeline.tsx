import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Bar, ChordSegment, TimeSignature } from '@/types/music';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { editorStore } from '@/store/editorStore';
import {
  getBarBeats,
  getBarStartBeat,
  getTotalBeats,
  snapBeat,
  SNAP_OPTIONS,
} from '@/engine/timeline';
import { paletteItemToSegment, type PaletteItem } from '@/engine/palette';
import { PALETTE_DRAG_TYPE } from '@/components/ScalePalette';
import { ChordSegmentBlock } from '@/components/ChordSegmentBlock';
import { BAR_LINE_WIDTH, PIANO_KEYS_WIDTH, PIXELS_PER_BEAT } from '@/utils/constants';

/** Beats a freshly dropped block occupies before the user resizes it. */
const DROP_DURATION_BEATS = 1;

/** Meters offered per bar. */
const TIME_SIGNATURES: TimeSignature[] = [
  { beatsPerMeasure: 2, beatUnit: 4 },
  { beatsPerMeasure: 3, beatUnit: 4 },
  { beatsPerMeasure: 4, beatUnit: 4 },
  { beatsPerMeasure: 5, beatUnit: 4 },
  { beatsPerMeasure: 6, beatUnit: 8 },
  { beatsPerMeasure: 7, beatUnit: 8 },
  { beatsPerMeasure: 12, beatUnit: 8 },
];

function formatTs(ts: TimeSignature): string {
  return `${ts.beatsPerMeasure}/${ts.beatUnit}`;
}

function parseTs(value: string): TimeSignature {
  const [beatsPerMeasure, beatUnit] = value.split('/').map(Number);
  return { beatsPerMeasure, beatUnit };
}

/** A drag in flight: where the block would land if the pointer were released now. */
interface DragState {
  segmentId: string;
  /** Beats between the block's left edge and the point the user grabbed it by. */
  grabOffset: number;
  barId: string;
  startBeat: number;
  /** False until the pointer actually travels, so a click is not mistaken for a drag. */
  moved: boolean;
}

/** How far the pointer may wander before the gesture counts as a drag, in pixels. */
const DRAG_THRESHOLD_PX = 3;

/** A play-range drag in flight, in absolute beats from the start of the project. */
interface RangeDragState {
  /** The edge that stays put: the pointer's origin, or the far edge when resizing. */
  anchorBeat: number;
  /** Where the pointer went down. Only used to tell a click from a drag. */
  originBeat: number;
  /** The edge that follows the pointer. */
  beat: number;
  moved: boolean;
  /** True when the gesture began on an existing edge handle rather than open ruler. */
  fromHandle: boolean;
}

/** Width of the grab strips at the play range's edges, in pixels. */
const RANGE_HANDLE_PX = 8;

/** Attribute the drag hit-test looks for; a lane carries its bar's id. */
const LANE_ATTRIBUTE = 'data-timeline-lane';

/**
 * The chord area: every bar of the project laid out on one scrollable horizontal
 * timeline, with bar lines, beat gridlines and per-bar meters.
 *
 * Segments are positioned by accumulating durations within their bar; the store's
 * reflow guarantees they always fit, so nothing here has to handle overflow.
 */
export const ChordTimeline: React.FC = () => {
  const project = projectStore(s => s.project);
  const insertSegment = projectStore(s => s.insertSegment);
  const removeSegment = projectStore(s => s.removeSegment);
  const moveSegment = projectStore(s => s.moveSegment);
  const resizeSegmentDuration = projectStore(s => s.resizeSegmentDuration);
  const setBarTimeSignature = projectStore(s => s.setBarTimeSignature);
  const setLoopRegion = projectStore(s => s.setLoopRegion);

  const selectedBarId = selectionStore(s => s.selectedBarId);
  const selectedSegmentId = selectionStore(s => s.selectedSegmentId);
  const selectBar = selectionStore(s => s.selectBar);
  const selectSegment = selectionStore(s => s.selectSegment);

  const snapBeats = editorStore(s => s.snapBeats);
  const setSnapBeats = editorStore(s => s.setSnapBeats);
  const scrollX = editorStore(s => s.scrollX);
  const setScrollX = editorStore(s => s.setScrollX);

  /** Where the insertion caret sits while a palette block hovers. */
  const [dropIndicator, setDropIndicator] = useState<{ barId: string; beat: number } | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [rangeDrag, setRangeDrag] = useState<RangeDragState | null>(null);

  const rulerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rangeDragRef = useRef<RangeDragState | null>(null);
  rangeDragRef.current = rangeDrag;

  // Read by the click handler to tell a drag from a click. A ref, not state,
  // because the click arrives after the gesture has already been committed.
  const draggedRef = useRef(false);
  // The live drag, for the window listeners, which are installed once.
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  useEffect(() => {
    /** Beats from the start of a lane element to a viewport x coordinate. */
    const beatIn = (lane: Element, clientX: number): number => {
      const beat = (clientX - lane.getBoundingClientRect().left) / PIXELS_PER_BEAT;
      return Number.isFinite(beat) ? Math.max(0, beat) : 0;
    };

    const handleMove = (e: PointerEvent) => {
      const state = dragRef.current;
      if (!state) return;

      // Hit-test rather than track the origin lane, so a block can be dragged
      // into a different bar.
      const lane = document
        .elementFromPoint?.(e.clientX, e.clientY)
        ?.closest(`[${LANE_ATTRIBUTE}]`);
      if (!lane) return;

      const barId = lane.getAttribute(LANE_ATTRIBUTE)!;
      const startBeat = snapBeat(beatIn(lane, e.clientX) - state.grabOffset, snapBeats);
      const moved =
        state.moved ||
        barId !== state.barId ||
        Math.abs(startBeat - state.startBeat) * PIXELS_PER_BEAT > DRAG_THRESHOLD_PX;

      setDrag({ ...state, barId, startBeat, moved });
    };

    const handleUp = () => {
      const state = dragRef.current;
      setDrag(null);
      if (!state) return;

      draggedRef.current = state.moved;
      if (state.moved) {
        moveSegment(state.segmentId, state.barId, state.startBeat);
      }
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [snapBeats, moveSegment]);

  /** Absolute beat under a viewport x coordinate, snapped to the editing grid. */
  const rulerBeatAt = useCallback(
    (clientX: number): number => {
      const ruler = rulerRef.current;
      if (!ruler) return 0;
      const beat = (clientX - ruler.getBoundingClientRect().left) / PIXELS_PER_BEAT;
      return snapBeat(Number.isFinite(beat) ? beat : 0, snapBeats);
    },
    [snapBeats]
  );

  // The play-range drag, on the same window-listener pattern as the segment drag
  // above so a gesture survives the pointer leaving the ruler.
  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      const state = rangeDragRef.current;
      if (!state) return;

      const beat = rulerBeatAt(e.clientX);
      setRangeDrag({
        ...state,
        beat,
        moved:
          state.moved ||
          Math.abs(beat - state.originBeat) * PIXELS_PER_BEAT > DRAG_THRESHOLD_PX,
      });
    };

    const handleUp = () => {
      const state = rangeDragRef.current;
      setRangeDrag(null);
      if (!state) return;

      if (!state.moved) {
        // A click on open ruler clears the range — the discoverable way to get the
        // whole project playing again. A click on a handle just misses; leave it be.
        if (!state.fromHandle) setLoopRegion(null, null);
        return;
      }

      setLoopRegion(
        Math.min(state.anchorBeat, state.beat),
        Math.max(state.anchorBeat, state.beat)
      );
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [rulerBeatAt, setLoopRegion]);

  // The lanes follow the shared offset, so scrolling the piano roll or the bar at
  // the bottom of the editor moves them too. Writing only on a real difference is
  // what keeps this from looping against the scroll handler that publishes it.
  useEffect(() => {
    const element = scrollRef.current;
    if (element && Math.abs(element.scrollLeft - scrollX) > 1) {
      element.scrollLeft = scrollX;
    }
  }, [scrollX]);

  if (!project) return null;

  const { bars, timeSignature: projectTs } = project;
  const totalBeats = getTotalBeats(bars, projectTs);

  /** The range to draw: the one being dragged if there is one, else the stored one. */
  const shownRange = rangeDrag
    ? {
        start: Math.min(rangeDrag.anchorBeat, rangeDrag.beat),
        end: Math.max(rangeDrag.anchorBeat, rangeDrag.beat),
      }
    : project.loopStart !== undefined && project.loopEnd !== undefined
      ? { start: project.loopStart, end: project.loopEnd }
      : null;

  /**
   * Begin a range gesture. `anchorBeat` is the edge that stays put — for a handle
   * that is the range's opposite edge, which is what makes resizing fall out of the
   * same code path as drawing.
   */
  const startRangeDrag = (e: React.PointerEvent, anchorBeat?: number) => {
    e.stopPropagation();
    const originBeat = rulerBeatAt(e.clientX);
    setRangeDrag({
      anchorBeat: anchorBeat ?? originBeat,
      originBeat,
      beat: originBeat,
      moved: false,
      fromHandle: anchorBeat !== undefined,
    });
  };

  /** Beats from the start of a lane to the pointer. */
  const beatAt = (e: React.DragEvent<HTMLDivElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    const beat = (e.clientX - rect.left) / PIXELS_PER_BEAT;
    // A drag with no usable coordinate lands at the bar's start rather than
    // poisoning the drop position with NaN.
    return Number.isFinite(beat) ? Math.max(0, beat) : 0;
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>, bar: Bar) => {
    // Without this the browser refuses the drop outright.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropIndicator({ barId: bar.id, beat: snapBeat(beatAt(e), snapBeats) });
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>, bar: Bar) => {
    e.preventDefault();
    setDropIndicator(null);

    const raw = e.dataTransfer.getData(PALETTE_DRAG_TYPE);
    if (!raw) return;

    let item: PaletteItem;
    try {
      item = JSON.parse(raw) as PaletteItem;
    } catch {
      // A foreign drag landed here; ignore it rather than corrupting the timeline.
      return;
    }

    insertSegment(
      bar.id,
      snapBeat(beatAt(e), snapBeats),
      paletteItemToSegment(item, DROP_DURATION_BEATS)
    );
    selectBar(bar.id);
  };

  const handleMoveStart = (
    e: React.PointerEvent,
    bar: Bar,
    segment: ChordSegment,
    startBeat: number
  ) => {
    draggedRef.current = false;
    const lane = (e.target as Element).closest(`[${LANE_ATTRIBUTE}]`);
    const pointerBeat = lane
      ? Math.max(0, (e.clientX - lane.getBoundingClientRect().left) / PIXELS_PER_BEAT)
      : startBeat;

    setDrag({
      segmentId: segment.id,
      grabOffset: pointerBeat - startBeat,
      barId: bar.id,
      startBeat,
      moved: false,
    });
  };

  /** Move a block by one grid step, the visible meaning of the arrow keys. */
  const nudge = (bar: Bar, segment: ChordSegment, startBeat: number, direction: -1 | 1) => {
    moveSegment(segment.id, bar.id, Math.max(0, startBeat + direction * snapBeats));
  };

  /**
   * The blocks a lane draws: its own, with the one being dragged pulled out and
   * re-drawn wherever the pointer currently puts it — which may be another lane.
   */
  const laneSegments = (bar: Bar): ChordSegment[] => {
    if (!drag) return bar.chords;

    const dragged = bars.flatMap(b => b.chords).find(s => s.id === drag.segmentId);
    const own = bar.chords.filter(s => s.id !== drag.segmentId);
    return dragged && drag.barId === bar.id
      ? [...own, { ...dragged, startBeat: drag.startBeat }]
      : own;
  };

  return (
    <div
      data-testid="chord-timeline"
      // shrink-0 keeps the lanes at their natural height when the piano roll
      // below competes for space in the column.
      className="shrink-0 flex flex-col bg-gray-900 border-b border-gray-700"
      onDragLeave={() => setDropIndicator(null)}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-2 py-1 border-b border-gray-800 text-xs text-gray-400">
        <label className="flex items-center gap-1">
          Snap
          <select
            aria-label="Snap"
            value={snapBeats}
            onChange={e => setSnapBeats(Number(e.target.value))}
            className="bg-gray-700 border border-gray-600 rounded text-gray-200 px-1 focus:outline-none focus:border-indigo-500"
          >
            {SNAP_OPTIONS.map(option => (
              <option key={option.label} value={option.beats}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex items-stretch">
      {/* Matches the piano roll's key column, so bar 1 starts where its grid
          does. It sits outside the scroll container for the same reason that
          column does: it must not slide away when the timeline scrolls. */}
      <div
        data-testid="timeline-gutter"
        style={{ width: `${PIANO_KEYS_WIDTH}px` }}
        className="shrink-0 bg-gray-800 border-r border-gray-700"
      />

      {/* Still a scroll container, so wheel and trackpad work over the lanes, but
          it draws no bar of its own: the editor has one, under the piano roll. */}
      <div
        ref={scrollRef}
        data-testid="timeline-scroll"
        onScroll={e => setScrollX(e.currentTarget.scrollLeft)}
        className="flex-1 overflow-x-auto scrollbar-hidden"
      >
        <div className="min-w-max">
        {/* Play-range ruler. One continuous strip rather than one piece per bar, so
            pointer positions read as absolute beats with no per-bar arithmetic. */}
        <div
          ref={rulerRef}
          data-testid="timeline-ruler"
          onPointerDown={e => startRangeDrag(e)}
          style={{ width: `${totalBeats * PIXELS_PER_BEAT}px` }}
          title="Drag to set the play range, click to clear it"
          className="relative h-5 bg-gray-800 border-b border-gray-700 cursor-ew-resize select-none"
        >
          {/* Bar ticks, lining up with the bar lines below */}
          {bars.map((bar, barIndex) => (
            <div
              key={bar.id}
              data-testid="ruler-tick"
              style={{ left: `${getBarStartBeat(bars, barIndex, projectTs) * PIXELS_PER_BEAT}px` }}
              className="absolute top-0 bottom-0 w-px bg-gray-600"
            />
          ))}

          {shownRange && (
            <div
              data-testid="loop-range"
              style={{
                left: `${shownRange.start * PIXELS_PER_BEAT}px`,
                width: `${(shownRange.end - shownRange.start) * PIXELS_PER_BEAT}px`,
              }}
              className="absolute top-0 bottom-0 bg-indigo-500/30 border-x-2 border-indigo-400"
            >
              {/* Edge handles. Each drags against the opposite edge as its anchor. */}
              <div
                role="button"
                aria-label="Loop start"
                onPointerDown={e => startRangeDrag(e, shownRange.end)}
                style={{ width: `${RANGE_HANDLE_PX}px`, left: `${-RANGE_HANDLE_PX / 2}px` }}
                className="absolute top-0 bottom-0 cursor-ew-resize"
              />
              <div
                role="button"
                aria-label="Loop end"
                onPointerDown={e => startRangeDrag(e, shownRange.start)}
                style={{ width: `${RANGE_HANDLE_PX}px`, right: `${-RANGE_HANDLE_PX / 2}px` }}
                className="absolute top-0 bottom-0 cursor-ew-resize"
              />
            </div>
          )}
        </div>

        <div className="flex items-stretch">
        {bars.map((bar, barIndex) => {
          const beats = getBarBeats(bar, projectTs);
          const width = beats * PIXELS_PER_BEAT;
          const isSelectedBar = selectedBarId === bar.id;

          // Every position the grid will snap to, minus the ones a beat line
          // already draws.
          const subdivisions =
            snapBeats < 1
              ? Array.from({ length: Math.round(beats / snapBeats) }, (_, i) => i * snapBeats).filter(
                  beat => !Number.isInteger(beat)
                )
              : [];

          return (
            <div
              key={bar.id}
              data-testid={`timeline-bar-${bar.id}`}
              style={{ width: `${width}px` }}
              className="relative shrink-0"
            >
              {/* Bar header */}
              <div
                className={`px-2 py-1 text-xs border-b border-gray-700 ${
                  isSelectedBar ? 'bg-indigo-900/50' : 'bg-gray-800'
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="font-medium text-gray-200">Bar {barIndex + 1}</span>
                  <select
                    aria-label={`Time signature for bar ${barIndex + 1}`}
                    value={formatTs(bar.timeSignature ?? projectTs)}
                    onChange={e => setBarTimeSignature(bar.id, parseTs(e.target.value))}
                    className="bg-gray-700 border border-gray-600 rounded text-gray-200 text-[10px] px-1 focus:outline-none focus:border-indigo-500"
                  >
                    {TIME_SIGNATURES.map(ts => (
                      <option key={formatTs(ts)} value={formatTs(ts)}>
                        {formatTs(ts)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="text-[10px] text-gray-400 truncate">
                  {bar.scale.root} {bar.scale.type.replace(/([A-Z])/g, ' $1').trim()}
                </div>
              </div>

              {/* Segment lane */}
              <div
                data-testid={`timeline-lane-${bar.id}`}
                data-timeline-lane={bar.id}
                onClick={() => selectBar(bar.id)}
                onDragOver={e => handleDragOver(e, bar)}
                onDrop={e => handleDrop(e, bar)}
                className="relative h-20 bg-gray-900"
              >
                {/* Beat gridlines */}
                {Array.from({ length: beats }, (_, i) => (
                  <div
                    key={i}
                    data-testid="beat-line"
                    style={{ left: `${i * PIXELS_PER_BEAT}px` }}
                    className={`absolute top-0 bottom-0 w-px ${
                      i === 0 ? 'bg-transparent' : 'bg-gray-700'
                    }`}
                  />
                ))}

                {/* Where a finer grid will land, drawn faintly so the beats still read */}
                {subdivisions.map(beat => (
                  <div
                    key={beat}
                    data-testid="subdivision-line"
                    style={{ left: `${beat * PIXELS_PER_BEAT}px` }}
                    className="absolute top-0 bottom-0 w-px bg-gray-800"
                  />
                ))}

                {/* Insertion caret */}
                {dropIndicator?.barId === bar.id && (
                  <div
                    data-testid="drop-indicator"
                    style={{ left: `${dropIndicator.beat * PIXELS_PER_BEAT}px` }}
                    className="absolute top-0 bottom-0 w-0.5 bg-indigo-400 pointer-events-none"
                  />
                )}

                {laneSegments(bar).map(segment => {
                  const startBeat = segment.startBeat ?? 0;

                  return (
                    <ChordSegmentBlock
                      key={segment.id}
                      segment={segment}
                      isSelected={selectedSegmentId === segment.id}
                      isDragging={drag?.segmentId === segment.id}
                      startBeat={startBeat}
                      pixelsPerBeat={PIXELS_PER_BEAT}
                      onSelect={id => {
                        // A drag ends in a click too; only a still pointer selects.
                        if (draggedRef.current) return;
                        // Bar first: selecting a new bar drops the segment selection.
                        selectBar(bar.id);
                        selectSegment(id);
                      }}
                      onRemove={removeSegment}
                      onResize={resizeSegmentDuration}
                      onMoveStart={e => handleMoveStart(e, bar, segment, startBeat)}
                      onMoveLeft={() => nudge(bar, segment, startBeat, -1)}
                      onMoveRight={() => nudge(bar, segment, startBeat, 1)}
                    />
                  );
                })}
              </div>

              {/* The bar line, and on the last bar the closing one. An overlay
                  rather than a border on the bar: a border sits inside the box, so
                  it would push the lane — and every beat line, block and drop
                  position in it — two pixels right of the beat the piano roll
                  draws below. Last in the bar so it paints over the lane's own
                  background, which would otherwise hide it. */}
              <div
                data-testid="bar-line"
                style={{ left: 0, width: `${BAR_LINE_WIDTH}px` }}
                className="absolute top-0 bottom-0 bg-gray-400 pointer-events-none"
              />
              {barIndex === bars.length - 1 && (
                <div
                  data-testid="bar-line"
                  style={{ right: 0, width: `${BAR_LINE_WIDTH}px` }}
                  className="absolute top-0 bottom-0 bg-gray-400 pointer-events-none"
                />
              )}
            </div>
          );
        })}
        </div>
        </div>
      </div>
      </div>
    </div>
  );
};
