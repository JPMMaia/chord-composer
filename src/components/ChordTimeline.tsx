import React, { useEffect, useRef, useState } from 'react';
import type { Bar, ChordSegment } from '@/types/music';
import { editSurface, projectStore } from '@/store/projectStore';
import {
  PHRASE_TRACK_KEY,
  phraseBarsForDisplay,
  phraseById,
  placementCount,
} from '@/engine/phrases';
import { selectionStore } from '@/store/selectionStore';
import { editorStore, ZOOM_LEVELS } from '@/store/editorStore';
import {
  barChords,
  flattenSegments,
  getBarBeats,
  getBarPulse,
  getBarStartBeat,
  getTotalBeats,
  laneOf,
  resolveBeatPosition,
  snapBeat,
  SNAP_OPTIONS,
  trackLaneCount,
} from '@/engine/timeline';
import { describeMeter, formatTs } from '@/engine/meterDisplay';
import { paletteItemToSegment, type PaletteItem } from '@/engine/palette';
import {
  FORMULA_DRAG_TYPE,
  formulaLengthBeats,
  realizeFormula,
  type MelodicFormula,
} from '@/engine/formulas';
import { findLoadedFormula } from '@/store/formulaLibraryStore';
import type { CopiedSegment } from '@/store/clipboardStore';
import { PALETTE_DRAG_TYPE } from '@/components/ScalePalette';
import { ChordSegmentBlock } from '@/components/ChordSegmentBlock';
import { PlayRangeRuler } from '@/components/PlayRangeRuler';
import {
  AutomationGutter,
  AutomationLanes,
  CcLaneStrip,
  useAutomationLanes,
} from '@/components/AutomationStack';
import { BAR_LINE_WIDTH, PIANO_KEYS_WIDTH, PIXELS_PER_BEAT } from '@/utils/constants';

/** Beats a freshly dropped block occupies before the user resizes it. */
const DROP_DURATION_BEATS = 1;

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

/** Where a block would land if released now, in the bar-relative terms it is drawn in. */
interface SegmentPlacement {
  barIndex: number;
  startBeat: number;
  /** Which of the instrument's stacked sub-lanes. */
  lane: number;
}

/**
 * Where a block sat when a drag began.
 *
 * Held in absolute beats rather than as a bar and an offset, because that is the
 * frame the gesture works in: a drag is one distance along the timeline, and bar
 * lines have no say in it. Turning it back into bars is the last step, not the first.
 */
interface DragOrigin {
  /** Beats from the start of the project. */
  absoluteBeat: number;
  /** Which of the instrument's stacked sub-lanes. */
  lane: number;
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
  /** How far along the timeline the selection has travelled, in beats. */
  beatDelta: number;
  /** How many sub-lanes down it has travelled. */
  laneDelta: number;
  /**
   * Where each dragged block would land if the pointer were released now.
   *
   * A block carried past the last bar names a `barIndex` the project does not have
   * yet, so no lane draws it and it goes unseen until release, when the commit grows
   * the song to hold it.
   */
  preview: Map<string, SegmentPlacement>;
  /** False until the pointer actually travels, so a press is not mistaken for a drag. */
  moved: boolean;
}

/** How far the pointer may wander before the gesture counts as a drag, in pixels. */
const DRAG_THRESHOLD_PX = 3;

/** Attribute the drag hit-test looks for; a lane carries its bar's id. */
const LANE_ATTRIBUTE = 'data-timeline-lane';

/** Which of the bar's stacked sub-lanes a lane element is. */
const SUBLANE_ATTRIBUTE = 'data-timeline-sublane';

/** Height of one sub-lane row, in pixels. Matches the `h-20` a single lane used to be. */
const SUBLANE_HEIGHT = 80;

/** The sub-lane index an element carries, or 0 when it names none. */
function sublaneOfElement(lane: Element): number {
  const raw = Number(lane.getAttribute(SUBLANE_ATTRIBUTE));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/**
 * The chord area: every bar of the project laid out on one scrollable horizontal
 * timeline, with bar lines, beat gridlines and per-bar meters.
 *
 * A segment is drawn in the bar its onset falls in, at the beat it carries. Its
 * length is its own business: a block longer than the space left in its bar reaches
 * across the bar line into the next one, which is why blocks are lifted above the
 * lanes and the bar lines above the blocks.
 */
export const ChordTimeline: React.FC = () => {
  const project = projectStore(s => s.project);
  const insertSegment = projectStore(s => s.insertSegment);
  const pasteSegments = projectStore(s => s.pasteSegments);
  const removeSegment = projectStore(s => s.removeSegment);
  const resizeSegmentDuration = projectStore(s => s.resizeSegmentDuration);
  const setTrackLaneCount = projectStore(s => s.setTrackLaneCount);

  const moveSegments = projectStore(s => s.moveSegments);

  const selectedBarId = selectionStore(s => s.selectedBarId);
  /**
   * The timeline is the *editing* surface, and what it edits is one phrase.
   *
   * The instrument still matters — it decides the sound a block auditions with, the
   * lanes available to stack in, and the automation shown underneath — but it is no
   * longer where the blocks live. They live in the phrase, filed under
   * `PHRASE_TRACK_KEY`, which is what lets the same phrase be dragged onto another
   * row in the arrangement and simply be played by that instrument instead.
   */
  const selectedTrackId = selectionStore(s => s.selectedTrackId);
  const closePhrase = projectStore(s => s.closePhrase);
  const renamePhrase = projectStore(s => s.renamePhrase);
  const setPhraseLength = projectStore(s => s.setPhraseLength);
  const insertPhraseBarsAt = projectStore(s => s.insertPhraseBarsAt);
  const removePhraseBarsAt = projectStore(s => s.removePhraseBarsAt);
  const phrase = projectStore(s =>
    s.project && s.editingPhraseId ? phraseById(s.project.phrases, s.editingPhraseId) : null
  );
  const placements = projectStore(s =>
    s.project && s.editingPhraseId ? placementCount(s.project.clips, s.editingPhraseId) : 0
  );
  // Read up here rather than after the guard below, because the controller list
  // is a hook and hooks cannot be called conditionally. The reference is stable —
  // `find` hands back the object already in the store — so this does not
  // re-render on every state change.
  const selectedTrack = projectStore(s =>
    s.project?.tracks.find(t => t.id === selectedTrackId)
  );
  /**
   * The curves under the lanes: the phrase's own, drawn against the instrument that
   * plays it. A hook, so it is read up here for the same reason `selectedTrack` is.
   */
  const automationLanes = useAutomationLanes(phrase ?? undefined, selectedTrack);

  /**
   * The stretch Play repeats, in this phrase's own beats. Null is the whole of it.
   *
   * Cleared when the editor moves to another phrase: a range names beats in one
   * piece of music, and carrying it across would repeat a stretch of something else.
   * `setView` does the same on the way out to the arrangement, but re-opening a
   * different block never passes through it — `openClip` is already in the phrase
   * view — so the rule is stated at both doors.
   */
  const phraseLoop = editorStore(s => s.phraseLoop);
  const setPhraseLoop = editorStore(s => s.setPhraseLoop);
  const editingPhraseId = projectStore(s => s.editingPhraseId);
  useEffect(() => {
    setPhraseLoop(null, null);
  }, [editingPhraseId, setPhraseLoop]);

  const selectedSegmentIds = selectionStore(s => s.selectedSegmentIds);
  const selectBar = selectionStore(s => s.selectBar);
  const selectSegment = selectionStore(s => s.selectSegment);
  const setSelectedSegments = selectionStore(s => s.setSelectedSegments);
  const toggleSegment = selectionStore(s => s.toggleSegment);
  const anchorSegment = selectionStore(s => s.anchorSegment);
  const clearSegmentSelection = selectionStore(s => s.clearSegmentSelection);

  const snapBeats = editorStore(s => s.snapBeats);
  const pixelsPerBeat = editorStore(s => s.pixelsPerBeat);
  const setSnapBeats = editorStore(s => s.setSnapBeats);
  const setPixelsPerBeat = editorStore(s => s.setPixelsPerBeat);
  const showAutomation = editorStore(s => s.showAutomation);
  const setShowAutomation = editorStore(s => s.setShowAutomation);
  const phraseContext = editorStore(s => s.phraseContext);
  const setPhraseContext = editorStore(s => s.setPhraseContext);
  const paletteScale = editorStore(s => s.paletteScale);
  const paletteOctave = editorStore(s => s.paletteOctave);
  const formulaStartDegree = editorStore(s => s.formulaStartDegree);
  const draggingFormulaId = editorStore(s => s.draggingFormulaId);
  const setDraggingFormulaId = editorStore(s => s.setDraggingFormulaId);
  const scrollX = editorStore(s => s.scrollX);
  const setScrollX = editorStore(s => s.setScrollX);
  const setTimelineMouseBeat = editorStore(s => s.setTimelineMouseBeat);

  /** Where the insertion caret sits while a palette block hovers. */
  const [dropIndicator, setDropIndicator] = useState<{
    barId: string;
    lane: number;
    beat: number;
  } | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // The live drag, for the window listeners, which are installed once.
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  useEffect(() => {
    /** Beats from the start of a lane element to a viewport x coordinate. */
    const beatIn = (lane: Element, clientX: number): number => {
      const beat = (clientX - lane.getBoundingClientRect().left) / pixelsPerBeat;
      return Number.isFinite(beat) ? Math.max(0, beat) : 0;
    };

    const handleMove = (e: PointerEvent) => {
      const state = dragRef.current;
      if (!state) return;

      const currentProject = projectStore.getState().project;
      if (!currentProject) return;
      // Read live rather than closed over, so the gesture measures against the phrase
      // as it is now — a drag that lengthens it mid-flight must not go on resolving
      // beats against the bars it had when the pointer went down.
      const surface = editSurface();
      if (!surface) return;
      const currentBars = surface.bars;

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

      const projectTs = currentProject.timeSignature;
      const barStart = getBarStartBeat(currentBars, barIndex, projectTs);

      // One lane delta for the whole selection, for the same reason as the beat
      // delta below: a chord dragged down a row must stay a chord. The live track
      // is read here rather than closed over, so the gesture cannot clamp against
      // a lane count that has since grown.
      const draggedTrack = currentProject.tracks.find(
        t => t.id === selectionStore.getState().selectedTrackId
      );
      const laneCount = draggedTrack ? trackLaneCount(draggedTrack) : 1;
      const laneDelta = clamp(
        sublaneOfElement(lane) - grabbed.lane,
        -Math.min(...[...state.origins.values()].map(o => o.lane)),
        laneCount - 1 - Math.max(...[...state.origins.values()].map(o => o.lane))
      );

      // The grabbed block follows the pointer; everything else in the selection
      // keeps its offset from it, so the shape of the selection is preserved.
      //
      // The snap is taken in the frame of the bar the block lands in, not of the
      // whole line, so it lands on the gridlines actually drawn — bars may carry
      // their own meter, and an absolute grid would drift away from theirs.
      const raw = Math.max(0, barStart + beatIn(lane, e.clientX) - state.grabOffset);
      const landing = resolveBeatPosition(raw, currentBars, projectTs, true);
      if (!landing) return;
      const snapped =
        getBarStartBeat(currentBars, landing.barIndex, projectTs) +
        snapBeat(landing.startBeat, snapBeats);

      // Clamp the delta once for the whole selection, never each block's landing
      // separately. Per-block clamping collapses blocks onto the same beat, and the
      // commit then ripples them apart again in reverse order — drag four blocks
      // hard against the bar line and they come back reversed. Holding the delta
      // instead keeps the selection's shape, so the preview and the commit agree.
      //
      // Only one bound is needed: nothing may start before the song does. There is
      // no upper one, because there is nothing up there to stop at — a block may sit
      // across a bar line, and past the last bar the commit grows the song. The bound
      // is pulled inwards onto the snap grid so a selection dragged hard left stops on
      // the lattice it was dragged along rather than beside it.
      const origins = [...state.origins.values()];
      const low =
        Math.ceil(-Math.min(...origins.map(o => o.absoluteBeat)) / snapBeats) * snapBeats;
      const beatDelta = Math.max(snapped - grabbed.absoluteBeat, low);

      const preview = new Map<string, SegmentPlacement>();
      for (const [segmentId, origin] of state.origins) {
        // `extend` so a block carried off the end keeps counting rather than piling
        // onto the last bar: the commit will grow the song to match.
        const at = resolveBeatPosition(
          origin.absoluteBeat + beatDelta,
          currentBars,
          projectTs,
          true
        );
        if (!at) continue;
        preview.set(segmentId, {
          barIndex: at.barIndex,
          startBeat: at.startBeat,
          lane: origin.lane + laneDelta,
        });
      }

      const moved =
        state.moved ||
        laneDelta !== 0 ||
        Math.abs(beatDelta) * pixelsPerBeat > DRAG_THRESHOLD_PX;

      setDrag({ ...state, beatDelta, laneDelta, preview, moved });
    };

    const handleUp = () => {
      const state = dragRef.current;
      setDrag(null);
      if (!state || !state.moved) return;

      // Committed from the origins and the delta rather than from the preview: the
      // preview is bars, which a block dragged off the end has run out of, while the
      // delta is the gesture itself and always says exactly where every block goes.
      moveSegments(
        [...state.origins].map(([segmentId, origin]) => ({
          segmentId,
          absoluteBeat: origin.absoluteBeat + state.beatDelta,
          lane: origin.lane + state.laneDelta,
        }))
      );
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [snapBeats, moveSegments, pixelsPerBeat]);

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
    if (!ruler || !scrollEl || !project) return;

    const updateMouseBeat = (clientX: number) => {
      const rect = ruler.getBoundingClientRect();
      const beat = (clientX - rect.left) / pixelsPerBeat;
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
  }, [project, setTimelineMouseBeat, pixelsPerBeat]);

  // Nothing tells the selection when a block is deleted, so it would otherwise keep
  // a dead id and arm the keyboard shortcuts over nothing. Only write on a real
  // shrink, or this loops against its own update.
  useEffect(() => {
    if (!phrase || selectedSegmentIds.length === 0) return;
    const live = new Set(flattenSegments(phrase.bars, PHRASE_TRACK_KEY).map(s => s.id));
    const kept = selectedSegmentIds.filter(id => live.has(id));
    if (kept.length !== selectedSegmentIds.length) setSelectedSegments(kept);
  }, [phrase, selectedSegmentIds, setSelectedSegments]);

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

  if (!phrase) {
    return (
      <div
        data-testid="chord-timeline"
        className="shrink-0 flex items-center justify-center h-24 bg-gray-900 border-b border-gray-700"
      >
        <p className="text-xs text-gray-500 italic" data-testid="no-phrase-open">
          Open a phrase from the arrangement to edit it.
        </p>
      </div>
    );
  }

  const { timeSignature: projectTs } = project;
  /**
   * The phrase's own bars, wearing the metre of the song bars its first placement
   * covers. Metre is the bar's *capacity*, so showing one metre while the store
   * refits against another would let a block into space the user cannot see.
   */
  const bars = phraseBarsForDisplay(phrase, project);
  /** Where this surface's blocks are filed — never an instrument id. */
  const trackKey = PHRASE_TRACK_KEY;
  const totalBeats = getTotalBeats(bars, projectTs);
  /**
   * The sub-lane rows to draw, as indices.
   *
   * Taken from the instrument's own count, but never fewer rows than there are
   * lanes with something in them: a block left in a lane the count no longer
   * covers still has to be visible, or it would be unreachable and inaudibly
   * present. `setTrackLaneCount` refuses to create that state; a hand-edited file
   * can still arrive in it.
   */
  const laneCount = Math.max(
    selectedTrack ? trackLaneCount(selectedTrack) : 1,
    ...flattenSegments(bars, trackKey).map(s => laneOf(s) + 1),
    1
  );
  const laneIndices = Array.from({ length: laneCount }, (_, i) => i);
  /**
   * True while the phrase's last bar is empty, so dropping it takes nothing with it.
   *
   * The same rule `canRemoveLane` follows below, and for the same reason: the − beside
   * a count is a nudge, not a decision to delete music. Shrinking a phrase over a bar
   * that still holds blocks stays possible, but only through the inspector's length
   * field, where the number typed says plainly how much is being thrown away.
   */
  const canRemoveBar =
    bars.length > 1 && barChords(bars[bars.length - 1], trackKey).length === 0;

  /** True while the last lane is empty, so removing it takes nothing with it. */
  const canRemoveLane =
    laneCount > 1 &&
    !flattenSegments(bars, trackKey).some(s => laneOf(s) >= laneCount - 1);

  /**
   * Length of the formula being dragged, in beats, or null when the drag is a
   * single palette block. The caret is sized from this so a phrase shows how much
   * room it will take before it is committed.
   */
  const draggedFormulaBeats = (() => {
    if (!draggingFormulaId) return null;
    const formula = findLoadedFormula(draggingFormulaId);
    return formula ? formulaLengthBeats(formula) : null;
  })();

  /** Beats from the start of a lane to the pointer. */
  const beatAt = (e: React.DragEvent<HTMLDivElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    const beat = (e.clientX - rect.left) / pixelsPerBeat;
    // A drag with no usable coordinate lands at the bar's start rather than
    // poisoning the drop position with NaN.
    return Number.isFinite(beat) ? Math.max(0, beat) : 0;
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>, bar: Bar, lane: number) => {
    // Without this the browser refuses the drop outright.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropIndicator({ barId: bar.id, lane, beat: snapBeat(beatAt(e), snapBeats) });
  };

  /**
   * Drop a whole melodic formula: every note it names, in one gesture.
   *
   * Routed through `pasteSegments` rather than a run of `insertSegment` calls,
   * because a phrase is exactly what paste already knows how to place — it appends
   * the bars a long formula needs, keeps the spacing between the notes, and writes
   * the project once, so the whole phrase is a single undo step.
   */
  const dropFormula = (formula: MelodicFormula, bar: Bar, lane: number, dropBeat: number) => {
    const phraseStart = getBarStartBeat(bars, bar.barIndex, projectTs) + dropBeat;

    // The formula is already a set of offsets from its own start, which is exactly
    // what the clipboard holds — so the notes go in verbatim, anchored at the drop.
    const placed = realizeFormula(
      formula,
      paletteScale,
      paletteOctave,
      formulaStartDegree
    ).map<CopiedSegment>(({ segment, offsetBeats }) => ({
      segment: { ...segment, lane },
      offsetBeat: offsetBeats,
      laneOffset: 0,
    }));

    if (placed.length === 0) return;

    const ids = pasteSegments(placed, selectedTrackId, phraseStart);

    selectBar(bar.id);
    if (ids && ids.length > 0) setSelectedSegments(ids);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>, bar: Bar, lane: number) => {
    e.preventDefault();
    setDropIndicator(null);
    setDraggingFormulaId(null);

    const formulaRaw = e.dataTransfer.getData(FORMULA_DRAG_TYPE);
    if (formulaRaw) {
      try {
        dropFormula(JSON.parse(formulaRaw) as MelodicFormula, bar, lane, snapBeat(beatAt(e), snapBeats));
      } catch {
        // A malformed payload landed here; ignore it rather than corrupting the timeline.
      }
      return;
    }

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
      {
        // The palette's key rather than the item's own: the block is written in
        // whatever the strip is currently offering, and carries that from here on.
        ...paletteItemToSegment(item, DROP_DURATION_BEATS, paletteScale),
        // The row it was dropped on, so a block can be stacked over one already
        // sounding rather than shoving it along.
        lane,
      },
      selectedTrackId
    );
    selectBar(bar.id);
  };

  /** Where a block sits, by id, across the whole project — the drag's starting point. */
  const originOf = (segmentId: string): DragOrigin | null => {
    const barIndex = bars.findIndex(bar =>
      barChords(bar, trackKey).some(c => c.id === segmentId)
    );
    if (barIndex < 0) return null;
    const segment = barChords(bars[barIndex], trackKey).find(c => c.id === segmentId)!;
    return {
      absoluteBeat: getBarStartBeat(bars, barIndex, projectTs) + (segment.startBeat ?? 0),
      lane: laneOf(segment),
    };
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
      const order = flattenSegments(bars, trackKey).map(s => s.id);
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
      const origin = originOf(id);
      if (origin) origins.set(id, origin);
    }
    if (!origins.has(segment.id)) return;

    const lane = (e.target as Element).closest(`[${LANE_ATTRIBUTE}]`);
    const pointerBeat = lane
      ? Math.max(0, (e.clientX - lane.getBoundingClientRect().left) / pixelsPerBeat)
      : startBeat;

    setDrag({
      segmentId: segment.id,
      grabOffset: pointerBeat - startBeat,
      origins,
      beatDelta: 0,
      laneDelta: 0,
      // Empty rather than a copy of the origins: a block with no preview entry is
      // drawn where it actually sits, which is exactly right until the pointer moves.
      preview: new Map<string, SegmentPlacement>(),
      moved: false,
    });
  };

  /**
   * Move a block by one grid step, the visible meaning of the arrow keys.
   *
   * Measured along the timeline rather than within the bar, so a block on the last
   * beat of a bar steps over the bar line instead of sticking to it — the same rule
   * dragging follows.
   */
  const nudge = (bar: Bar, segment: ChordSegment, startBeat: number, direction: -1 | 1) => {
    const from = getBarStartBeat(bars, bar.barIndex, projectTs) + startBeat;
    moveSegments([
      {
        segmentId: segment.id,
        absoluteBeat: Math.max(0, from + direction * snapBeats),
        lane: laneOf(segment),
      },
    ]);
  };

  /**
   * The blocks one sub-lane of one bar draws: its own, with any being dragged
   * re-drawn wherever the pointer currently puts them — which may be another bar,
   * another sub-lane, or both.
   *
   * A block that stays put keeps its position in the array. That is not cosmetic:
   * reordering here moves the DOM node, and a node that moves between a pointerdown
   * and a pointerup takes the click event with it. Blocks that lift above their
   * neighbours do so via z-index instead.
   */
  const laneSegments = (bar: Bar, barIndex: number, lane: number): ChordSegment[] => {
    const chords = barChords(bar, trackKey);
    if (!drag) return chords.filter(s => laneOf(s) === lane);

    /** Where a block would land right now, or undefined when it is not being dragged. */
    const at = (segmentId: string) => drag.preview.get(segmentId);
    const lands = (s: ChordSegment) => {
      const placement = at(s.id);
      return placement
        ? placement.barIndex === barIndex && placement.lane === lane
        : laneOf(s) === lane;
    };
    const moved = (s: ChordSegment) => {
      const placement = at(s.id);
      return placement ? { ...s, startBeat: placement.startBeat, lane: placement.lane } : s;
    };

    const own = chords.filter(lands).map(moved);

    // Blocks dragged in from another bar or another sub-lane, which this row has no
    // copy of yet.
    const incoming = bars
      .flatMap((other, index) =>
        barChords(other, trackKey).map(s => ({ segment: s, barIndex: index }))
      )
      .filter(
        ({ segment, barIndex: from }) =>
          (from !== barIndex || laneOf(segment) !== lane) &&
          at(segment.id)?.barIndex === barIndex &&
          at(segment.id)?.lane === lane
      )
      .map(({ segment }) => moved(segment));

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
      {/* Which phrase this is, and the way back to the arrangement it is played in.
          The timeline shows one phrase at a time and says nothing about where in the
          song it sits, so without this strip there is no telling which of several
          identical-looking four-bar blocks is open. */}
      <div
        data-testid="phrase-header"
        className="flex items-center gap-2 px-2 py-1 border-b border-gray-800 text-xs"
      >
        <button
          type="button"
          onClick={closePhrase}
          aria-label="Back to arrangement"
          className="px-1.5 rounded border bg-gray-700 border-gray-600 text-gray-300 hover:bg-gray-600"
        >
          ← Arrangement
        </button>
        <span
          style={{ backgroundColor: phrase.color ?? undefined }}
          className="w-2 h-2 rounded-sm"
        />
        <input
          data-testid="phrase-name"
          aria-label="Phrase name"
          value={phrase.name}
          onChange={e => renamePhrase(phrase.id, e.target.value)}
          className="bg-transparent text-gray-200 font-medium border border-transparent rounded px-1 hover:border-gray-600 focus:outline-none focus:border-indigo-500"
        />
        {selectedTrack && <span className="text-gray-500">· {selectedTrack.name}</span>}
        {/* An edit here reaches every placement, which is the whole point of a linked
            block and exactly the thing that would otherwise surprise someone. */}
        {placements > 1 && (
          <span data-testid="phrase-placements" className="text-amber-400" title="Editing this phrase changes every placement of it">
            · {placements} placements
          </span>
        )}

        {/* The coarse switch over how much of the band is heard and drawn under this
            phrase. Which instruments in particular is not repeated here — that is the
            eye and the mute already sitting beside each one in the panel — so this is
            one button rather than a list that would go stale the moment an instrument
            was added.

            Called "Context" rather than "Arrangement" only because the way back to the
            arrangement is already the first button in this strip, and two buttons a few
            centimetres apart under one word would read as one control drawn twice. */}
        <button
          type="button"
          data-testid="phrase-context-toggle"
          aria-pressed={phraseContext}
          onClick={() => setPhraseContext(!phraseContext)}
          title={
            phraseContext
              ? 'Showing and playing the rest of the arrangement over these bars — hide or mute an instrument in the panel to leave it out'
              : 'Show and play the rest of the arrangement over these bars'
          }
          className={`px-1.5 rounded border ${
            phraseContext
              ? 'bg-indigo-600 border-indigo-500 text-white'
              : 'bg-gray-700 border-gray-600 text-gray-400 hover:bg-gray-600'
          }`}
        >
          Context
        </button>

        {/* How many bars the phrase is, and the way to make it more.
            A phrase is not tied to the song grid — its bars are its own — so the
            song's own "add bar" says nothing about it, and without this the length a
            phrase was drawn at in the arrangement would be the length it is stuck
            with while it is being written. Every placement grows at once, which is
            what `placements` above is already warning about. */}
        <span
          data-testid="phrase-bar-count"
          className="ml-auto flex items-center gap-0.5 text-gray-500"
        >
          <button
            type="button"
            aria-label="Remove bar"
            title={
              canRemoveBar
                ? 'Shorten the phrase by a bar'
                : bars.length > 1
                  ? 'The last bar still holds blocks'
                  : 'A phrase is at least one bar'
            }
            disabled={!canRemoveBar}
            onClick={() => setPhraseLength(phrase.id, bars.length - 1)}
            className="px-1 rounded text-gray-400 hover:bg-gray-700 hover:text-gray-200 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            −
          </button>
          <span className="tabular-nums">
            {bars.length} {bars.length === 1 ? 'bar' : 'bars'}
          </span>
          <button
            type="button"
            aria-label="Add bar"
            title="Lengthen the phrase by a bar, everywhere it is played"
            onClick={() => setPhraseLength(phrase.id, bars.length + 1)}
            className="px-1 rounded text-gray-400 hover:bg-gray-700 hover:text-gray-200"
          >
            +
          </button>
        </span>
      </div>

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

        <label className="flex items-center gap-1">
          Zoom
          <select
            aria-label="Zoom"
            value={pixelsPerBeat}
            onChange={e => setPixelsPerBeat(Number(e.target.value))}
            className="bg-gray-700 border border-gray-600 rounded text-gray-200 px-1 focus:outline-none focus:border-indigo-500"
          >
            {ZOOM_LEVELS.map(level => (
              <option key={level} value={level}>
                {`${Math.round((level / PIXELS_PER_BEAT) * 100)}%`}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          aria-label="Automation lanes"
          aria-pressed={showAutomation}
          onClick={() => setShowAutomation(!showAutomation)}
          title="Show this phrase's curves — its volume, and any plugin parameters"
          className={`px-1.5 rounded border ${
            showAutomation
              ? 'bg-indigo-600 border-indigo-500 text-white'
              : 'bg-gray-700 border-gray-600 text-gray-300 hover:bg-gray-600'
          }`}
        >
          Automation
        </button>

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
        className="shrink-0 bg-gray-800 border-r border-gray-700 flex flex-col justify-end"
      >
        {/* One label per sub-lane row, aligned with the rows themselves, plus the
            buttons that add and remove one. A lane is only ever needed to hold
            something that must sound at the same time as something else, so most
            instruments show exactly one row and no numbering at all. */}
        <div className="flex-1 flex flex-col justify-end">
          {laneIndices.map(lane => (
            <div
              key={lane}
              data-testid={`lane-label-${lane}`}
              style={{ height: `${SUBLANE_HEIGHT}px` }}
              className={`flex items-center justify-between gap-1 px-2 text-[10px] text-gray-500 ${
                lane > 0 ? 'border-t border-gray-700' : ''
              }`}
            >
              {/* Just the number: the gutter is only as wide as the piano roll's
                  key column, and "Lane 2" alongside the buttons wraps in it. */}
              <span title={`Lane ${lane + 1}`}>{laneCount > 1 ? lane + 1 : ''}</span>

              {/* On the last row, so the pair sits next to the lane they act on. */}
              {lane === laneCount - 1 && selectedTrack && (
                <span className="flex gap-0.5">
                  <button
                    type="button"
                    aria-label="Remove lane"
                    title={
                      canRemoveLane
                        ? 'Remove the bottom lane'
                        : 'The bottom lane still holds blocks'
                    }
                    disabled={!canRemoveLane}
                    onClick={() => setTrackLaneCount(selectedTrack.id, laneCount - 1)}
                    className="px-1 rounded text-gray-400 hover:bg-gray-700 hover:text-gray-200 disabled:opacity-30 disabled:hover:bg-transparent"
                  >
                    −
                  </button>
                  <button
                    type="button"
                    aria-label="Add lane"
                    title="Add a lane, for blocks that sound at the same time as these"
                    onClick={() => setTrackLaneCount(selectedTrack.id, laneCount + 1)}
                    className="px-1 rounded text-gray-400 hover:bg-gray-700 hover:text-gray-200"
                  >
                    +
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Bottom-aligned so these line up with the curves across the two columns,
            both being the last rows of the same stretched flex row. */}
        {showAutomation && <AutomationGutter phrase={phrase} lanes={automationLanes} />}

      </div>

      {/* Still a scroll container, so wheel and trackpad work over the lanes, but
          it draws no bar of its own: the editor has one, under the piano roll. */}
      <div
        ref={scrollRef}
        data-testid="timeline-scroll"
        onScroll={e => setScrollX(e.currentTarget.scrollLeft)}
        className="flex-1 overflow-x-auto scrollbar-hidden"
      >
        <div className="min-w-max">
        {/* The arrangement's named spans, on the same beat axis as everything below.
            It overhangs the gutter as the ruler does — the gutter is bottom-aligned,
            so neither needs a row of its own over there. */}
        {/* The phrase's own ruler, and the stretch of it Play repeats.
            The same component the arrangement uses, handed this surface's beats: here
            they are local to a phrase that may be played in several places at once, so
            the range it draws is the audition's rather than the song's, and the bars
            its bar menu opens up and takes away are the phrase's own — the section
            band is the one thing that stays in the arrangement, being a label on the
            song.

            The wrapper carries the ref and the width because the paste anchor measures
            the pointer against the ruler's own box. */}
        <div ref={rulerRef} style={{ width: `${totalBeats * pixelsPerBeat}px` }}>
          <PlayRangeRuler
            bars={bars}
            timeSignature={projectTs}
            range={phraseLoop}
            onRangeChange={setPhraseLoop}
            onInsertBars={(barIndex, count) => insertPhraseBarsAt(phrase.id, barIndex, count)}
            onRemoveBars={(barIndex, count) => removePhraseBarsAt(phrase.id, barIndex, count)}
            removeBlockedReason={(barIndex, count) =>
              // The one run a phrase will not give up, and the same rule the header's
              // − follows: a phrase with no bars covers nothing, so every placement of
              // it would be dropped as zero-length.
              Math.min(Math.max(1, Math.trunc(count)), bars.length - barIndex) >= bars.length
                ? 'A phrase is at least one bar'
                : null
            }
          />
        </div>

        <div className="flex items-stretch">
        {bars.map((bar, barIndex) => {
          const beats = getBarBeats(bar, projectTs);
          const width = beats * pixelsPerBeat;
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
                {/* The metre is shown but not editable here. It belongs to the
                    *song's* bar, which every instrument shares, and a phrase may be
                    played over several bars in several metres — so there is no one bar
                    a change made in this view could honestly mean. It is edited in the
                    arrangement, where each bar is itself. */}
                <div className="flex items-center justify-between gap-1">
                  <span className="font-medium text-gray-200">Bar {barIndex + 1}</span>
                  <span
                    data-testid={`bar-time-signature-${barIndex + 1}`}
                    className="text-gray-400 text-[10px] px-1"
                  >
                    {formatTs(bar.timeSignature ?? projectTs)}
                  </span>
                </div>
                {/* Two bars of the same width may be in different metres, so say how
                    this one counts: 3/4 is three quarters, 6/8 two beats of three. */}
                <div className="text-[10px] text-gray-500 truncate" data-testid="bar-meter">
                  {describeMeter(bar.timeSignature ?? projectTs)}
                </div>
              </div>

              {/* Segment lanes: one row per sub-lane, stacked. Blocks may not
                  overlap within a row, so a second row is what lets two of them
                  sound at once. Most instruments have exactly one. */}
              {laneIndices.map(lane => (
                <div
                  key={lane}
                  data-testid={`timeline-lane-${bar.id}-${lane}`}
                  data-timeline-lane={bar.id}
                  data-timeline-sublane={lane}
                  // A press on empty lane space selects the bar and drops the block
                  // selection — the discoverable way out of a multi-selection. Blocks
                  // stop propagation, so this only ever hears the background.
                  onPointerDown={() => {
                    selectBar(bar.id);
                    clearSegmentSelection();
                  }}
                  onDragOver={e => handleDragOver(e, bar, lane)}
                  onDrop={e => handleDrop(e, bar, lane)}
                  style={{ height: `${SUBLANE_HEIGHT}px` }}
                  className={`relative bg-gray-900 ${
                    lane > 0 ? 'border-t border-gray-800' : ''
                  }`}
                >
                  {/* Beat gridlines, on the metre's pulse */}
                  {pulses.map((beat, i) => (
                    <div
                      key={beat}
                      data-testid="beat-line"
                      style={{ left: `${beat * pixelsPerBeat}px` }}
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
                      style={{ left: `${beat * pixelsPerBeat}px` }}
                      className="absolute top-0 bottom-0 w-px bg-gray-800"
                    />
                  ))}

                  {/* Insertion caret — a hairline for a single block, and the width
                      of the phrase when a formula is what is being dragged. */}
                  {dropIndicator?.barId === bar.id && dropIndicator.lane === lane && (
                    <div
                      data-testid="drop-indicator"
                      style={{
                        left: `${dropIndicator.beat * pixelsPerBeat}px`,
                        ...(draggedFormulaBeats !== null && {
                          width: `${draggedFormulaBeats * pixelsPerBeat}px`,
                        }),
                      }}
                      className={`absolute top-0 bottom-0 pointer-events-none ${
                        draggedFormulaBeats !== null
                          ? 'border-l-2 border-r-2 border-purple-400 bg-purple-500/20'
                          : 'w-0.5 bg-indigo-400'
                      }`}
                    />
                  )}

                  {laneSegments(bar, barIndex, lane).map(segment => {
                    const startBeat = segment.startBeat ?? 0;
                    // A block may grow through the bar line — a chord held over one is
                    // ordinary music — but not past the end of the phrase. Computed the
                    // same way `resizeSegmentDuration` does, so the drag previews the
                    // width the commit will actually give it.
                    const maxDuration =
                      totalBeats - (getBarStartBeat(bars, barIndex, projectTs) + startBeat);

                    return (
                      <ChordSegmentBlock
                        key={segment.id}
                        segment={segment}
                        isSelected={selectedSegmentIds.includes(segment.id)}
                        isDragging={drag?.preview.has(segment.id) ?? false}
                        startBeat={startBeat}
                        pixelsPerBeat={pixelsPerBeat}
                        snapBeats={snapBeats}
                        maxDuration={maxDuration}
                        onSelect={id => {
                          selectBar(bar.id);
                          selectSegment(id);
                        }}
                        onRemove={removeSegment}
                        onResize={(id, duration) =>
                          resizeSegmentDuration(id, duration, snapBeats)
                        }
                        onMoveStart={e => handleMoveStart(e, bar, segment, startBeat)}
                        onMoveLeft={() => nudge(bar, segment, startBeat, -1)}
                        onMoveRight={() => nudge(bar, segment, startBeat, 1)}
                      />
                    );
                  })}
                </div>
              ))}

              {/* The bar line, and on the last bar the closing one. An overlay
                  rather than a border on the bar: a border sits inside the box, so
                  it would push the lane — and every beat line, block and drop
                  position in it — two pixels right of the beat the piano roll
                  draws below. Last in the bar so it paints over the lane's own
                  background, which would otherwise hide it, and lifted above the
                  blocks so a chord held across it still shows where the bar ends. */}
              <div
                data-testid="bar-line"
                style={{ left: 0, width: `${BAR_LINE_WIDTH}px`, zIndex: 30 }}
                className="absolute top-0 bottom-0 bg-gray-400 pointer-events-none"
              />
              {barIndex === bars.length - 1 && (
                <div
                  data-testid="bar-line"
                  style={{ right: 0, width: `${BAR_LINE_WIDTH}px`, zIndex: 30 }}
                  className="absolute top-0 bottom-0 bg-gray-400 pointer-events-none"
                />
              )}
            </div>
          );
        })}
        </div>

        {/* The phrase's curves, inside the scroll container and after the lanes, so
            they ride the same beat axis, zoom and scroll offset as everything above
            them with no plumbing of their own — and each one continuous, so a ramp
            crosses a bar line in one piece. */}
        {showAutomation && (
          <AutomationLanes
            lanes={automationLanes}
            bars={bars}
            projectTs={projectTs}
            totalBeats={totalBeats}
          />
        )}

        </div>
      </div>
      </div>

      {/* Full width under both columns: the gutter is only as wide as the piano
          roll's key column, and the learn steps have to read across. */}
      {showAutomation && selectedTrack && <CcLaneStrip phrase={phrase} track={selectedTrack} />}

    </div>
  );
};
