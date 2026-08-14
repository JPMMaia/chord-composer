import React, { useEffect, useRef, useState } from 'react';
import { editorStore } from '@/store/editorStore';
import { selectionStore } from '@/store/selectionStore';
import { getBarStartBeat, snapBeat } from '@/engine/timeline';
import type { AutomationPoint, Bar, TimeSignature } from '@/types/music';

/**
 * One curve over time, drawn on the chord timeline's beat axis.
 *
 * Target-agnostic: the selected instrument stacks one of these per curve — its
 * volume first, then one per automated plugin parameter — and the lane itself
 * knows only that it is drawing points between 0 and 1. What a point *means* is
 * the caller's business, carried in through `onAdd`/`onMove`/`onRemove`, which is
 * what lets a plugin parameter reuse every gesture the volume curve has.
 *
 * Drawn in SVG rather than on a canvas like the piano roll: the points have to be
 * individually hit-testable and draggable, which the DOM gives for free, and a
 * handful of circles over a few thousand pixels is nothing to lay out. The piano
 * roll's canvas earns itself by drawing hundreds of notes that are never grabbed.
 *
 * Positions are absolute beats — the same axis the ruler above uses — so this is
 * one continuous coordinate space rather than one piece per bar, and a ramp crosses
 * a bar line without being cut in two.
 */

/** Height of the lane in pixels. Value 1.0 sits at the top, 0 at the bottom. */
export const AUTOMATION_LANE_HEIGHT = 64;

/** Grab radius of a point, and the radius it is drawn at. */
const POINT_RADIUS = 5;

/** How far the pointer must travel before a press counts as a drag, not a click. */
const DRAG_THRESHOLD_PX = 3;

/** A point being dragged, previewed locally until the pointer comes up. */
interface PointDrag {
  index: number;
  beat: number;
  value: number;
  /** Whether the pointer has travelled far enough to be a move rather than a click. */
  moved: boolean;
}

interface AutomationLaneProps {
  /** This lane's identity, from `@/engine/parameterAutomation`. */
  laneKey: string;
  /** For the accessible name — "Volume", or the parameter's own title. */
  label: string;
  points: AutomationPoint[];
  /**
   * The level to draw as a dashed flat line when there are no points.
   *
   * Null for a plugin parameter, which has no flat value to show: an empty
   * parameter lane drives nothing, and the plugin keeps whatever its preset or
   * its own editor last said. Drawing a line at some invented level would claim
   * otherwise.
   */
  flatLevel: number | null;
  /**
   * Read the stored points back after a commit.
   *
   * A commit re-sorts, so where a point landed in the list is not something this
   * component can work out for itself — it has to ask.
   */
  readPoints: () => AutomationPoint[];
  onAdd: (beat: number, value: number) => void;
  onMove: (index: number, beat: number, value: number) => void;
  onRemove: (index: number) => void;
  bars: Bar[];
  projectTs: TimeSignature;
  /** Width of the lane in beats — the project's full length. */
  totalBeats: number;
}

export const AutomationLane: React.FC<AutomationLaneProps> = ({
  laneKey,
  label,
  points,
  flatLevel,
  readPoints,
  onAdd,
  onMove,
  onRemove,
  bars,
  projectTs,
  totalBeats,
}) => {
  const pixelsPerBeat = editorStore(s => s.pixelsPerBeat);
  const snapBeats = editorStore(s => s.snapBeats);

  const selection = selectionStore(s => s.selectedAutomationPoint);
  const selectAutomationPoint = selectionStore(s => s.selectAutomationPoint);

  /** The picked index, but only when it was picked *in this lane*. */
  const selectedIndex = selection?.laneKey === laneKey ? selection.index : null;

  /** Pick a point in this lane, or let go of the pick. */
  const select = (index: number | null) =>
    selectAutomationPoint(index === null ? null : { laneKey, index });

  const [drag, setDrag] = useState<PointDrag | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  /**
   * The caller's callbacks, for the window listeners and the key handler.
   *
   * Those are installed once per lane, but the parent rebuilds these props on
   * every render — so closing over them directly would tear the listeners down
   * and reinstall them inside every pointer move of a drag. The ref is the same
   * answer `dragRef` below gives to the same problem, and is written during
   * render rather than in an effect so a listener firing before the next commit
   * still reaches the current callbacks.
   */
  const handlers = useRef({ onMove, onRemove, readPoints });
  handlers.current = { onMove, onRemove, readPoints };

  /**
   * The live drag, for the window listeners, which are installed once and would
   * otherwise keep reading whatever the state was when they were installed.
   *
   * Written only by `applyDrag`, never during render. Assigning it from the state on
   * every render — as the chord timeline's gestures do — races the gesture itself: a
   * render flushed *between* two pointer events puts the ref back to the state as of
   * the last committed update, undoing the eager write and losing the move.
   */
  const dragRef = useRef<PointDrag | null>(null);

  /**
   * Advance the drag, writing the ref as well as the state.
   *
   * The ref eagerly rather than on the next render: `setDrag` is asynchronous, so a
   * pointer event arriving before React re-renders would read a null at the start of
   * a gesture, or a stale `moved` at the end of one — which silently drops the whole
   * drag. A real pointer leaves milliseconds between events, but a gesture should not
   * depend on a render landing inside it.
   */
  const applyDrag = (next: PointDrag | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const width = Math.max(1, totalBeats * pixelsPerBeat);

  const xOf = (beat: number) => beat * pixelsPerBeat;
  const yOf = (value: number) => (1 - value) * AUTOMATION_LANE_HEIGHT;

  /** Lane coordinates from a viewport position: beat snapped, level not. */
  const positionAt = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    const left = rect?.left ?? 0;
    const top = rect?.top ?? 0;

    const rawBeat = (clientX - left) / pixelsPerBeat;
    const rawValue = 1 - (clientY - top) / AUTOMATION_LANE_HEIGHT;

    return {
      // The beat snaps to the grid the whole editor shares; the level does not. A
      // level is not on a lattice, and quantising it would make fine rides
      // impossible without ever being asked for.
      beat: snapBeat(Number.isFinite(rawBeat) ? Math.max(0, rawBeat) : 0, snapBeats),
      value: Math.min(1, Math.max(0, Number.isFinite(rawValue) ? rawValue : 0)),
    };
  };

  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      const state = dragRef.current;
      if (!state) return;

      const { beat, value } = positionAt(e.clientX, e.clientY);
      const travelled =
        Math.abs(beat - state.beat) * pixelsPerBeat > DRAG_THRESHOLD_PX ||
        Math.abs(value - state.value) * AUTOMATION_LANE_HEIGHT > DRAG_THRESHOLD_PX;

      applyDrag({ ...state, beat, value, moved: state.moved || travelled });
    };

    const handleUp = () => {
      const state = dragRef.current;
      applyDrag(null);
      if (!state || !state.moved) return;

      // Committed once, on release, rather than on every move: the store re-sorts,
      // so a per-move commit would invalidate the index mid-gesture, and the whole
      // drag is one entry on the undo stack this way.
      handlers.current.onMove(state.index, state.beat, state.value);

      // That sort may have moved the point in the list — dragging one past its
      // neighbour does exactly that — so the selection follows it to where it
      // landed rather than staying on whatever now holds the old index.
      const landed = handlers.current.readPoints().findIndex(p => p.beat === state.beat);
      select(landed >= 0 ? landed : null);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
    // `positionAt` and `select` are rebuilt every render but read only the values
    // below; the caller's callbacks come through `handlers` for that same reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pixelsPerBeat, snapBeats, laneKey, selectAutomationPoint]);

  /**
   * Delete erases the selected point; Escape lets it go.
   *
   * Safe to run alongside the block shortcuts in `useSegmentShortcuts`, which read
   * the same key: selecting a point clears the block selection and those shortcuts
   * bail on an empty one, so exactly one of the two ever acts on a press.
   */
  useEffect(() => {
    if (selectedIndex === null) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // A point is not selected *into* a field, so a keystroke aimed at one — the
      // instrument rename box, say — is none of this lane's business.
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        handlers.current.onRemove(selectedIndex);
        select(null);
        e.preventDefault();
        return;
      }

      if (e.key === 'Escape') {
        select(null);
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // `select` is rebuilt every render but reads only `laneKey`, below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIndex, selectAutomationPoint, laneKey]);

  // A curve that shrank under the selection — a Clear, an undo, a point removed
  // from elsewhere — must not leave the index pointing past the end of the list.
  useEffect(() => {
    if (selectedIndex !== null && selectedIndex >= points.length) select(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIndex, points.length, selectAutomationPoint, laneKey]);

  /**
   * A press on the lane background adds a point where it landed — and grabs it, so
   * placing and positioning one is a single gesture rather than a click followed by
   * a second aim at a five-pixel circle.
   */
  const handleLanePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;

    const { beat, value } = positionAt(e.clientX, e.clientY);
    onAdd(beat, value);

    // Read back rather than assume: the store sorts, so where the new point landed
    // in the list depends on what was already there.
    const index = readPoints().findIndex(p => p.beat === beat);
    if (index < 0) return;

    // The new point comes up selected, so it can be erased with Delete straight
    // away rather than having to be aimed at a second time.
    select(index);
    applyDrag({ index, beat, value, moved: false });
  };

  const handlePointPointerDown = (e: React.PointerEvent, index: number) => {
    if (e.button !== 0) return;
    // Or the press would also add a second point underneath the one being grabbed.
    e.stopPropagation();

    select(index);

    const point = points[index];
    applyDrag({ index, beat: point.beat, value: point.value, moved: false });
  };

  /** What the curve looks like right now, with any drag previewed in place. */
  const shown: AutomationPoint[] =
    drag && drag.moved
      ? points.map((p, i) => (i === drag.index ? { beat: drag.beat, value: drag.value } : p))
      : points;

  /**
   * The polyline for the curve: a flat run in from the left edge, the points
   * themselves, and a flat run out to the right — the drawn form of `valueAtBeat`'s
   * rule that a curve holds its end values rather than fading to silence at the
   * edges. Sorted for drawing only; the store owns the real order.
   */
  const drawn = [...shown].sort((a, b) => a.beat - b.beat);
  const polyline =
    drawn.length > 0
      ? [
          `0,${yOf(drawn[0].value)}`,
          ...drawn.map(p => `${xOf(p.beat)},${yOf(p.value)}`),
          `${width},${yOf(drawn[drawn.length - 1].value)}`,
        ].join(' ')
      : '';

  return (
    <div
      data-testid="automation-lane"
      className="relative bg-gray-900 border-t border-gray-800"
      style={{ width: `${width}px`, height: `${AUTOMATION_LANE_HEIGHT}px` }}
    >
      <svg
        ref={svgRef}
        width={width}
        height={AUTOMATION_LANE_HEIGHT}
        className="block"
        role="group"
        aria-label={`${label} automation lane`}
      >
        {/* Bar lines, at the same beats the ruler ticks and the lanes above use. */}
        {bars.map((bar, barIndex) => (
          <line
            key={bar.id}
            data-testid="automation-bar-line"
            x1={xOf(getBarStartBeat(bars, barIndex, projectTs))}
            x2={xOf(getBarStartBeat(bars, barIndex, projectTs))}
            y1={0}
            y2={AUTOMATION_LANE_HEIGHT}
            className="stroke-gray-700"
            strokeWidth={1}
          />
        ))}

        {/* Half level, so a ride around the middle has something to read against. */}
        <line
          x1={0}
          x2={width}
          y1={yOf(0.5)}
          y2={yOf(0.5)}
          className="stroke-gray-800"
          strokeWidth={1}
          strokeDasharray="2 4"
        />

        {/* Click target. Last of the background layers so it catches the presses,
            first in the tree so the points above it win their own. */}
        <rect
          x={0}
          y={0}
          width={width}
          height={AUTOMATION_LANE_HEIGHT}
          fill="transparent"
          className="cursor-crosshair"
          onPointerDown={handleLanePointerDown}
        />

        {drawn.length === 0 ? (
          // No curve. For volume that means the flat level the instrument actually
          // plays at, dashed to say it is the fader's value rather than something
          // drawn here. For a plugin parameter there is no such level to show —
          // nothing is driving it — so the lane is left empty rather than
          // asserting a value the app made up.
          flatLevel !== null && (
            <line
              data-testid="automation-flat-line"
              x1={0}
              x2={width}
              y1={yOf(flatLevel)}
              y2={yOf(flatLevel)}
              className="stroke-indigo-500/60"
              strokeWidth={2}
              strokeDasharray="6 4"
              pointerEvents="none"
            />
          )
        ) : (
          <polyline
            data-testid="automation-curve"
            points={polyline}
            fill="none"
            className="stroke-indigo-400"
            strokeWidth={2}
            pointerEvents="none"
          />
        )}

        {shown.map((point, index) => {
          const isSelected = selectedIndex === index;
          return (
            <circle
              key={index}
              data-testid={`automation-point-${index}`}
              data-selected={isSelected || undefined}
              aria-label={`${label} point at beat ${point.beat}, ${Math.round(point.value * 100)}%`}
              cx={xOf(point.beat)}
              cy={yOf(point.value)}
              // The selected point is drawn larger as well as ringed: a colour
              // change alone is easy to miss on a five-pixel dot.
              r={isSelected ? POINT_RADIUS + 2 : POINT_RADIUS}
              className={
                drag?.index === index
                  ? 'fill-indigo-300 stroke-gray-900 cursor-grabbing'
                  : isSelected
                    ? 'fill-white stroke-indigo-300 cursor-grab'
                    : 'fill-indigo-400 stroke-gray-900 cursor-grab hover:fill-indigo-300'
              }
              strokeWidth={isSelected ? 2 : 1.5}
              onPointerDown={e => handlePointPointerDown(e, index)}
              onDoubleClick={() => onRemove(index)}
            />
          );
        })}
      </svg>
    </div>
  );
};
