import React, { useEffect, useRef, useState } from 'react';
import type { Bar, ChordSegment, TimeSignature } from '@/types/music';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { editorStore } from '@/store/editorStore';
import { getBarBeats, snapBeat, SNAP_OPTIONS } from '@/engine/timeline';
import { paletteItemToSegment, type PaletteItem } from '@/engine/palette';
import { PALETTE_DRAG_TYPE } from '@/components/ScalePalette';
import { ChordSegmentBlock } from '@/components/ChordSegmentBlock';
import { PIANO_KEYS_WIDTH } from '@/utils/constants';

/** Horizontal zoom of the timeline. A beat is this many pixels wide. */
export const PIXELS_PER_BEAT = 80;

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

  const selectedBarId = selectionStore(s => s.selectedBarId);
  const selectedSegmentId = selectionStore(s => s.selectedSegmentId);
  const selectBar = selectionStore(s => s.selectBar);
  const selectSegment = selectionStore(s => s.selectSegment);

  const snapBeats = editorStore(s => s.snapBeats);
  const setSnapBeats = editorStore(s => s.setSnapBeats);

  /** Where the insertion caret sits while a palette block hovers. */
  const [dropIndicator, setDropIndicator] = useState<{ barId: string; beat: number } | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

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

  if (!project) return null;

  const { bars, timeSignature: projectTs } = project;

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

      <div data-testid="timeline-scroll" className="flex-1 overflow-x-auto">
        <div className="flex items-stretch min-w-max">
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
              // The heavy left rule is the bar line; the last bar closes with a
              // second one on its right.
              className={`shrink-0 border-l-2 border-gray-400 ${
                barIndex === bars.length - 1 ? 'border-r-2' : ''
              }`}
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
            </div>
          );
        })}
        </div>
      </div>
      </div>
    </div>
  );
};
