import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Bar, ChordSegment, TimeSignature } from '@/types/music';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { editorStore } from '@/store/editorStore';
import {
  barChords,
  flattenSegments,
  getBarBeats,
  getBarPulse,
  getBarStartBeat,
  getTotalBeats,
  snapBeat,
  SNAP_OPTIONS,
} from '@/engine/timeline';
import { describeMeter } from '@/engine/meterDisplay';
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

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * Gridline positions at `step` intervals across a bar, from its start up to but not
 * including its end. Multiplied out from an index rather than accumulated, so a
 * step like 1.5 cannot drift a line off the lattice by the end of a long bar.
 */
function stepsAcross(beats: number, step: number): number[] {
  if (!(step > 0)) return [];
  const count = Math.ceil(beats / step);
  return Array.from({ length: count }, (_, i) => i * step);
}

/** A beat as an integer key, so lines that should coincide dedupe despite float drift. */
const gridKey = (beat: number) => Math.round(beat * 1000);

/**
 * The faint grid: every step of each interval, minus the positions `covered` by a
 * line already drawn. Intervals may overlap — the metre's subdivision and the
 * chosen snap usually do — so each position is emitted at most once.
 */
function gridPositions(beats: number, steps: number[], covered: number[]): number[] {
  const taken = new Set(covered.map(gridKey));
  const positions: number[] = [];

  for (const step of steps) {
    for (const beat of stepsAcross(beats, step)) {
      const key = gridKey(beat);
      if (taken.has(key)) continue;
      taken.add(key);
      positions.push(beat);
    }
  }

  return positions.sort((a, b) => a - b);
}

/** Where a block sat when a drag began, or would land if released now. */
interface SegmentPlacement {
  barIndex: number;
  startBeat: number;
}

/** Where a block sat when a drag began, plus what the clamp needs to know about it. */
interface DragOrigin extends SegmentPlacement {
  /** In beats — what decides how far right the block may travel inside its bar. */
  duration: number;
}

/**
 * A drag in flight. The whole selection travels, so this tracks the block actually
 * grabbed and carries every selected block's origin to offset against it.
 */
interface DragState {
  /** The block under the pointer — the one the delta is measured from. */
  segmentId: string;
  /** Beats between the grabbed block's left edge and the point it was grabbed by. */
  grabOffset: number;
  /** Where each dragged block sat when the gesture began. */
  origins: Map<string, DragOrigin>;
  /** Where each dragged block would land if the pointer were released now. */
  preview: Map<string, SegmentPlacement>;
  /** False until the pointer actually travels, so a press is not mistaken for a drag. */
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

  const moveSegments = projectStore(s => s.moveSegments);

  const selectedBarId = selectionStore(s => s.selectedBarId);
  // The timeline is the *editing* surface, so it shows one instrument at a time.
  // Other instruments stay visible on the piano roll below, in their own colours.
  const selectedTrackId = selectionStore(s => s.selectedTrackId);
  const selectedSegmentIds = selectionStore(s => s.selectedSegmentIds);
  const selectBar = selectionStore(s => s.selectBar);
  const selectSegment = selectionStore(s => s.selectSegment);
  const setSelectedSegments = selectionStore(s => s.setSelectedSegments);
  const toggleSegment = selectionStore(s => s.toggleSegment);
  const anchorSegment = selectionStore(s => s.anchorSegment);
  const clearSegmentSelection = selectionStore(s => s.clearSegmentSelection);

  const snapBeats = editorStore(s => s.snapBeats);
  const setSnapBeats = editorStore(s => s.setSnapBeats);
  const paletteScale = editorStore(s => s.paletteScale);
  const scrollX = editorStore(s => s.scrollX);
  const setScrollX = editorStore(s => s.setScrollX);
  const setTimelineMouseBeat = editorStore(s => s.setTimelineMouseBeat);

  /** Where the insertion caret sits while a palette block hovers. */
  const [dropIndicator, setDropIndicator] = useState<{ barId: string; beat: number } | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [rangeDrag, setRangeDrag] = useState<RangeDragState | null>(null);

  const rulerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rangeDragRef = useRef<RangeDragState | null>(null);
  rangeDragRef.current = rangeDrag;

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

      const currentProject = projectStore.getState().project;
      if (!currentProject) return;
      const currentBars = currentProject.bars;

      // Hit-test rather than track the origin lane, so a block can be dragged
      // into a different bar.
      const lane = document
        .elementFromPoint?.(e.clientX, e.clientY)
        ?.closest(`[${LANE_ATTRIBUTE}]`);
      if (!lane) return;

      const barId = lane.getAttribute(LANE_ATTRIBUTE)!;
      const barIndex = currentBars.findIndex(bar => bar.id === barId);
      if (barIndex < 0) return;

      const grabbed = state.origins.get(state.segmentId);
      if (!grabbed) return;

      // The grabbed block follows the pointer; everything else in the selection
      // keeps its offset from it, so the shape of the selection is preserved.
      const startBeat = snapBeat(beatIn(lane, e.clientX) - state.grabOffset, snapBeats);
      const origins = [...state.origins.values()];

      // Clamp the delta once for the whole selection, never each block's landing
      // separately. Per-block clamping collapses blocks onto the same beat, and the
      // commit then ripples them apart again in reverse order — drag four blocks
      // hard against the bar line and they come back reversed. Holding the delta
      // instead keeps the selection's shape, so the preview and the commit agree.
      const barDelta = clamp(
        barIndex - grabbed.barIndex,
        -Math.min(...origins.map(o => o.barIndex)),
        currentBars.length - 1 - Math.max(...origins.map(o => o.barIndex))
      );

      let low = -Infinity;
      let high = Infinity;
      for (const origin of origins) {
        const target = currentBars[origin.barIndex + barDelta];
        const capacity = getBarBeats(target, currentProject.timeSignature);
        low = Math.max(low, -origin.startBeat);
        high = Math.min(high, capacity - origin.duration - origin.startBeat);
      }
      // A block that already overruns its bar would invert the window; the start of
      // the bar wins, and the refit sorts out the overflow as it always has.
      const beatDelta = clamp(startBeat - grabbed.startBeat, low, Math.max(low, high));

      const preview = new Map<string, SegmentPlacement>();
      for (const [segmentId, origin] of state.origins) {
        preview.set(segmentId, {
          barIndex: origin.barIndex + barDelta,
          startBeat: origin.startBeat + beatDelta,
        });
      }

      const moved =
        state.moved ||
        barDelta !== 0 ||
        Math.abs(beatDelta) * PIXELS_PER_BEAT > DRAG_THRESHOLD_PX;

      setDrag({ ...state, preview, moved });
    };

    const handleUp = () => {
      const state = dragRef.current;
      setDrag(null);
      if (!state || !state.moved) return;

      const currentBars = projectStore.getState().project?.bars;
      if (!currentBars) return;

      moveSegments(
        [...state.preview].map(([segmentId, placement]) => ({
          segmentId,
          targetBarId: currentBars[placement.barIndex].id,
          startBeat: placement.startBeat,
        }))
      );
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [snapBeats, moveSegments]);

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

  // Track mouse position on the timeline ruler so paste can use it as the
  // anchor point. The value is published as an absolute beat offset that
  // the copy/paste hook converts into a target bar / startBeat.
  useEffect(() => {
    const ruler = rulerRef.current;
    const scrollEl = scrollRef.current;
    if (!ruler || !scrollEl) return;

    const updateMouseBeat = (clientX: number) => {
      const rect = ruler.getBoundingClientRect();
      const beat = (clientX - rect.left) / PIXELS_PER_BEAT;
      const totalBeats = getTotalBeats(project.bars, project.timeSignature);
      if (clientX >= rect.left && clientX <= rect.right && Number.isFinite(beat)) {
        setTimelineMouseBeat(Math.max(0, Math.min(beat, totalBeats)));
      } else {
        setTimelineMouseBeat(null);
      }
    };

    const handlePointerMove = (e: PointerEvent) => {
      // Only update while the pointer is within the timeline container.
      const timeline = e.currentTarget as HTMLElement;
      const rect = timeline.getBoundingClientRect();
      if (e.clientX >= rect.left && e.clientX <= rect.right) {
        updateMouseBeat(e.clientX);
      } else {
        setTimelineMouseBeat(null);
      }
    };

    const handlePointerLeave = () => {
      setTimelineMouseBeat(null);
    };

    ruler.addEventListener('pointermove', handlePointerMove);
    scrollEl.addEventListener('pointermove', handlePointerMove);
    scrollEl.addEventListener('pointerleave', handlePointerLeave);
    ruler.addEventListener('pointerleave', handlePointerLeave);

    return () => {
      ruler.removeEventListener('pointermove', handlePointerMove);
      scrollEl.removeEventListener('pointermove', handlePointerMove);
      scrollEl.removeEventListener('pointerleave', handlePointerLeave);
      ruler.removeEventListener('pointerleave', handlePointerLeave);
    };
  }, [project, setTimelineMouseBeat]);

  // Nothing tells the selection when a block is deleted, so it would otherwise keep
  // a dead id and arm the keyboard shortcuts over nothing. Only write on a real
  // shrink, or this loops against its own update.
  useEffect(() => {
    if (!project || !selectedTrackId || selectedSegmentIds.length === 0) return;
    const live = new Set(flattenSegments(project.bars, selectedTrackId).map(s => s.id));
    const kept = selectedSegmentIds.filter(id => live.has(id));
    if (kept.length !== selectedSegmentIds.length) setSelectedSegments(kept);
  }, [project, selectedTrackId, selectedSegmentIds, setSelectedSegments]);

  if (!project) return null;

  if (!selectedTrackId) {
    return (
      <div
        data-testid="chord-timeline"
        className="shrink-0 flex items-center justify-center h-24 bg-gray-900 border-b border-gray-700"
      >
        <p className="text-xs text-gray-500 italic">
          Select an instrument to edit its notes.
        </p>
      </div>
    );
  }

  const { bars, timeSignature: projectTs } = project;
  const totalBeats = getTotalBeats(bars, projectTs);
  const selectedTrack = project.tracks.find(t => t.id === selectedTrackId);

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
      // The palette's key rather than the item's own: the block is written in
      // whatever the strip is currently offering, and carries that from here on.
      paletteItemToSegment(item, DROP_DURATION_BEATS, paletteScale),
      selectedTrackId
    );
    selectBar(bar.id);
  };

  /** Where a block sits, by id, across the whole project — the drag's starting point. */
  const placementOf = (segmentId: string): DragOrigin | null => {
    const barIndex = bars.findIndex(bar =>
      barChords(bar, selectedTrackId).some(c => c.id === segmentId)
    );
    if (barIndex < 0) return null;
    const segment = barChords(bars[barIndex], selectedTrackId).find(c => c.id === segmentId)!;
    return { barIndex, startBeat: segment.startBeat ?? 0, duration: segment.duration };
  };

  /**
   * Press on a block: resolve the selection, then arm a drag for everything in it.
   *
   * Ctrl/Cmd toggles and Shift extends, and neither begins a drag — those gestures
   * are about *changing* the selection, and dragging on them reads as an accident.
   * A plain press on a block that is already selected keeps the selection intact,
   * which is what lets a multi-selection be dragged as a unit.
   */
  const handleMoveStart = (
    e: React.PointerEvent,
    bar: Bar,
    segment: ChordSegment,
    startBeat: number
  ) => {
    if (e.ctrlKey || e.metaKey) {
      toggleSegment(segment.id);
      selectBar(bar.id);
      return;
    }

    // Read the selection live rather than from the render closure: a press is the
    // start of a gesture that acts on whatever is selected *now*.
    const current = selectionStore.getState().selectedSegmentIds;

    if (e.shiftKey) {
      const order = flattenSegments(bars, selectedTrackId).map(s => s.id);
      const anchor = selectionStore.getState().anchorSegmentId;
      const from = anchor ? order.indexOf(anchor) : -1;
      const to = order.indexOf(segment.id);
      setSelectedSegments(
        from < 0
          ? [segment.id]
          : order.slice(Math.min(from, to), Math.max(from, to) + 1)
      );
      selectBar(bar.id);
      return;
    }

    // Keep a multi-selection the user is about to drag; otherwise this block alone.
    const dragged = current.includes(segment.id) ? current : [segment.id];
    if (current.includes(segment.id)) {
      // The selection stands, but the block just pressed is where the next Shift
      // range measures from — otherwise the anchor sticks to a stale block.
      anchorSegment(segment.id);
    } else {
      selectSegment(segment.id);
    }
    selectBar(bar.id);

    const origins = new Map<string, DragOrigin>();
    for (const id of dragged) {
      const placement = placementOf(id);
      if (placement) origins.set(id, placement);
    }
    if (!origins.has(segment.id)) return;

    const lane = (e.target as Element).closest(`[${LANE_ATTRIBUTE}]`);
    const pointerBeat = lane
      ? Math.max(0, (e.clientX - lane.getBoundingClientRect().left) / PIXELS_PER_BEAT)
      : startBeat;

    setDrag({
      segmentId: segment.id,
      grabOffset: pointerBeat - startBeat,
      origins,
      preview: new Map<string, SegmentPlacement>(origins),
      moved: false,
    });
  };

  /** Move a block by one grid step, the visible meaning of the arrow keys. */
  const nudge = (bar: Bar, segment: ChordSegment, startBeat: number, direction: -1 | 1) => {
    moveSegment(segment.id, bar.id, Math.max(0, startBeat + direction * snapBeats));
  };

  /**
   * The blocks a lane draws: its own, with any being dragged re-drawn wherever the
   * pointer currently puts them — which may be another lane.
   *
   * A block that stays in its own lane keeps its position in the array. That is not
   * cosmetic: reordering here moves the DOM node, and a node that moves between a
   * pointerdown and a pointerup takes the click event with it. Blocks that lift
   * above their neighbours do so via z-index instead.
   */
  const laneSegments = (bar: Bar, barIndex: number): ChordSegment[] => {
    const chords = barChords(bar, selectedTrackId);
    if (!drag) return chords;

    const at = (segmentId: string) => drag.preview.get(segmentId);

    const own = chords
      .filter(s => (at(s.id) ? at(s.id)!.barIndex === barIndex : true))
      .map(s => (at(s.id) ? { ...s, startBeat: at(s.id)!.startBeat } : s));

    // Blocks dragged in from another bar, which this lane has no copy of yet.
    const incoming = bars
      .filter((_, index) => index !== barIndex)
      .flatMap(other => barChords(other, selectedTrackId))
      .filter(s => at(s.id)?.barIndex === barIndex)
      .map(s => ({ ...s, startBeat: at(s.id)!.startBeat }));

    return [...own, ...incoming];
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

        {/* Which instrument a drop will land on. The lanes show only this one's
            blocks, so without this the timeline going empty on an instrument
            switch reads as data loss. */}
        {selectedTrack && (
          <span data-testid="timeline-track-name" className="flex items-center gap-1.5">
            <span
              style={{ backgroundColor: selectedTrack.color ?? undefined }}
              className="w-2 h-2 rounded-sm"
            />
            <span className="text-gray-300">{selectedTrack.name}</span>
          </span>
        )}
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
          const pulse = getBarPulse(bar, projectTs);
          const isSelectedBar = selectedBarId === bar.id;

          // Where the metre's beats fall: every quarter in 3/4, every dotted
          // quarter in 6/8. The two bars are the same width, so these lines are
          // most of what tells them apart.
          const pulses = stepsAcross(beats, pulse.pulseBeats);

          // The faint grid: the metre's own subdivisions — which is what groups
          // 6/8 into threes — plus wherever the chosen snap will land, minus the
          // positions a pulse line already covers.
          const subdivisions = gridPositions(beats, [pulse.subdivisionBeats, snapBeats], pulses);

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
                {/* Two bars of the same width may be in different metres, so say how
                    this one counts: 3/4 is three quarters, 6/8 two beats of three. */}
                <div className="text-[10px] text-gray-500 truncate" data-testid="bar-meter">
                  {describeMeter(bar.timeSignature ?? projectTs)}
                </div>
              </div>

              {/* Segment lane */}
              <div
                data-testid={`timeline-lane-${bar.id}`}
                data-timeline-lane={bar.id}
                // A press on empty lane space selects the bar and drops the block
                // selection — the discoverable way out of a multi-selection. Blocks
                // stop propagation, so this only ever hears the background.
                onPointerDown={() => {
                  selectBar(bar.id);
                  clearSegmentSelection();
                }}
                onDragOver={e => handleDragOver(e, bar)}
                onDrop={e => handleDrop(e, bar)}
                className="relative h-20 bg-gray-900"
              >
                {/* Beat gridlines, on the metre's pulse */}
                {pulses.map((beat, i) => (
                  <div
                    key={beat}
                    data-testid="beat-line"
                    style={{ left: `${beat * PIXELS_PER_BEAT}px` }}
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

                {laneSegments(bar, barIndex).map(segment => {
                  const startBeat = segment.startBeat ?? 0;

                  return (
                    <ChordSegmentBlock
                      key={segment.id}
                      segment={segment}
                      isSelected={selectedSegmentIds.includes(segment.id)}
                      isDragging={drag?.preview.has(segment.id) ?? false}
                      startBeat={startBeat}
                      pixelsPerBeat={PIXELS_PER_BEAT}
                      onSelect={id => {
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
