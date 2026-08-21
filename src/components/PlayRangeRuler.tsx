import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Bar, TimeSignature } from '@/types/music';
import { editorStore } from '@/store/editorStore';
import { getBarIndexAtBeat, getBarStartBeat, getTotalBeats, snapBeat } from '@/engine/timeline';

/**
 * A ruler with a play range on it: bar ticks, the range itself, and — where the
 * surface owns bars — the menu that adds and takes them away.
 *
 * It measures the beats of whichever surface it is handed, and states none of them
 * itself: the range comes in as a prop and goes out through `onRangeChange`. That is
 * what lets one component serve two surfaces whose beats mean different things — the
 * arrangement, where a beat is an absolute beat in the song and the range is
 * `Project.loopStart`/`loopEnd`, and the phrase editor, where the bars are local to
 * one phrase and the range is the stretch being auditioned.
 *
 * Extracted whole from `ChordTimeline`, gesture and all: a range drag anchors on the
 * edge that stays put, which is what lets drawing a new range and resizing an existing
 * one fall out of one code path.
 */

/** A play-range drag in flight, in beats from the start of the surface. */
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

/** How far the pointer may wander before the gesture counts as a drag, in pixels. */
const DRAG_THRESHOLD_PX = 3;

/** Height of the ruler strip, in pixels — `h-5`. */
export const RULER_HEIGHT = 20;

export interface PlayRangeRulerProps {
  bars: Bar[];
  timeSignature: TimeSignature;
  /** The range to draw, in this surface's own beats. Null means "the whole of it". */
  range: { start: number; end: number } | null;
  /** Called with the dragged range, or with nulls when a click clears it. */
  onRangeChange: (start: number | null, end: number | null) => void;
  /**
   * What right-clicking a bar tick offers, in the bars of whichever surface mounted
   * this. Each supplies its own action, because "insert a bar here" means the song's
   * grid in the arrangement and the open phrase's own bars in the editor. Absent where
   * a surface has no bars of its own to open up, and the menu then never appears.
   *
   * Insert puts the bars *before* the clicked one; remove takes the clicked one and
   * the rest of the count after it. Both read from the same place, which is the bar
   * the user pointed at.
   */
  onInsertBars?: (barIndex: number, count: number) => void;
  onRemoveBars?: (barIndex: number, count: number) => void;
  /**
   * Why Remove cannot go ahead for this run of bars, or null when it can.
   *
   * A surface answers rather than the menu working it out, because the reasons are the
   * surface's own — a placement playing over a song bar, a phrase down to its last.
   * The message becomes the disabled button's tooltip, so the refusal is something the
   * user can read instead of a button that looks live and does nothing.
   */
  removeBlockedReason?: (barIndex: number, count: number) => string | null;
}

export const PlayRangeRuler: React.FC<PlayRangeRulerProps> = ({
  bars,
  timeSignature,
  range,
  onRangeChange,
  onInsertBars,
  onRemoveBars,
  removeBlockedReason,
}) => {
  const pixelsPerBeat = editorStore(s => s.pixelsPerBeat);
  const snapBeats = editorStore(s => s.snapBeats);

  const rulerRef = useRef<HTMLDivElement>(null);
  const [rangeDrag, setRangeDrag] = useState<RangeDragState | null>(null);
  const rangeDragRef = useRef<RangeDragState | null>(null);
  rangeDragRef.current = rangeDrag;

  /** The right-clicked ruler tick's bar and the click's screen position. */
  const [barMenu, setBarMenu] = useState<{
    barIndex: number;
    x: number;
    y: number;
  } | null>(null);
  const [barCount, setBarCount] = useState(1);

  /** The snapped absolute beat under a screen x, measured against the ruler itself. */
  const rulerBeatAt = useCallback(
    (clientX: number): number => {
      const rect = rulerRef.current?.getBoundingClientRect();
      if (!rect) return 0;
      return Math.max(0, snapBeat((clientX - rect.left) / pixelsPerBeat, snapBeats));
    },
    [pixelsPerBeat, snapBeats]
  );

  // Window listeners rather than element ones, so a gesture survives the pointer
  // leaving the ruler — the same pattern the block drag uses.
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
          Math.abs(beat - state.originBeat) * pixelsPerBeat > DRAG_THRESHOLD_PX,
      });
    };

    const handleUp = () => {
      const state = rangeDragRef.current;
      setRangeDrag(null);
      if (!state) return;

      if (!state.moved) {
        // A click on open ruler clears the range — the discoverable way to get the
        // whole project playing again. A click on a handle just misses; leave it be.
        if (!state.fromHandle) onRangeChange(null, null);
        return;
      }

      onRangeChange(
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
  }, [rulerBeatAt, onRangeChange, pixelsPerBeat]);

  const totalBeats = getTotalBeats(bars, timeSignature);

  /**
   * Why the open menu's Remove is unavailable, or null when it can go ahead.
   *
   * Asked afresh on every render rather than at right-click time, so typing a larger
   * count re-asks: a run of two may be free where a run of five runs into something.
   */
  const blockedReason =
    barMenu && removeBlockedReason ? removeBlockedReason(barMenu.barIndex, barCount) : null;

  /** The range to draw: the one being dragged if there is one, else the stored one. */
  const shownRange = rangeDrag
    ? {
        start: Math.min(rangeDrag.anchorBeat, rangeDrag.beat),
        end: Math.max(rangeDrag.anchorBeat, rangeDrag.beat),
      }
    : range;

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

  return (
    <>
      {/* One continuous strip rather than one piece per bar, so pointer positions
          read as absolute beats with no per-bar arithmetic. */}
      <div
        ref={rulerRef}
        data-testid="timeline-ruler"
        onPointerDown={e => startRangeDrag(e)}
        onContextMenu={e => {
          if (!onInsertBars) return;
          // The native menu has nothing useful to offer here; ours does.
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          const beat = Math.max(0, (e.clientX - rect.left) / pixelsPerBeat);
          // A fresh menu always offers one bar, however many the last one moved.
          setBarCount(1);
          setBarMenu({
            barIndex: getBarIndexAtBeat(bars, timeSignature, beat),
            x: e.clientX,
            y: e.clientY,
          });
        }}
        style={{ width: `${totalBeats * pixelsPerBeat}px` }}
        title="Drag to set the play range, click to clear it"
        className="relative h-5 bg-gray-800 border-b border-gray-700 cursor-ew-resize select-none"
      >
        {/* Bar ticks, lining up with the bar lines below */}
        {bars.map((bar, barIndex) => (
          <div
            key={bar.id}
            data-testid="ruler-tick"
            style={{ left: `${getBarStartBeat(bars, barIndex, timeSignature) * pixelsPerBeat}px` }}
            className="absolute top-0 bottom-0 w-px bg-gray-600"
          />
        ))}

        {shownRange && (
          <div
            data-testid="loop-range"
            style={{
              left: `${shownRange.start * pixelsPerBeat}px`,
              width: `${(shownRange.end - shownRange.start) * pixelsPerBeat}px`,
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

      {/* Where right-clicking the ruler adds empty bars before the clicked bar, or
          takes the clicked bar and the ones after it away. */}
      {barMenu && onInsertBars && (
        <div
          data-testid="bar-menu"
          style={{ position: 'fixed', left: barMenu.x, top: barMenu.y, zIndex: 50 }}
          className="bg-gray-800 border border-gray-600 rounded p-2 flex items-center gap-2 shadow-lg text-xs"
        >
          <input
            data-testid="bar-menu-count"
            type="number"
            min={1}
            value={barCount}
            onChange={e => setBarCount(Number(e.target.value) || 1)}
            className="w-14 bg-gray-700 border border-gray-600 rounded text-gray-200 px-1 focus:outline-none focus:border-indigo-500"
            aria-label="Bars to insert or remove"
          />
          <button
            data-testid="insert-bars"
            title={`Add ${barCount === 1 ? 'a bar' : `${barCount} bars`} before bar ${barMenu.barIndex + 1}`}
            onClick={() => {
              onInsertBars(barMenu.barIndex, barCount);
              setBarMenu(null);
            }}
            className="px-2 py-0.5 rounded bg-indigo-600 hover:bg-indigo-500 text-gray-100 transition-colors"
          >
            Insert
          </button>
          {onRemoveBars && (
            <button
              data-testid="remove-bars"
              disabled={blockedReason !== null}
              title={
                blockedReason ??
                `Take ${barCount === 1 ? 'bar' : `${barCount} bars from bar`} ${barMenu.barIndex + 1} away`
              }
              onClick={() => {
                onRemoveBars(barMenu.barIndex, barCount);
                setBarMenu(null);
              }}
              className="px-2 py-0.5 rounded bg-red-600 hover:bg-red-500 text-gray-100 transition-colors disabled:opacity-30 disabled:hover:bg-red-600"
            >
              Remove
            </button>
          )}
          <button
            data-testid="bar-menu-cancel"
            onClick={() => setBarMenu(null)}
            className="px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}
    </>
  );
};
