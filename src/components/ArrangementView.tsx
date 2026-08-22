import React, { useEffect, useRef, useState } from 'react';
import { projectStore } from '@/store/projectStore';
import { editorStore, ZOOM_LEVELS } from '@/store/editorStore';
import { selectionStore } from '@/store/selectionStore';
import { panelLayout, type PanelRow } from '@/engine/trackGroups';
import {
  canPlaceClip,
  clipEndBar,
  freeBarAfter,
  phraseById,
  phraseColorAt,
  phraseLengthBars,
  placementCount,
  unplacedPhrases,
} from '@/engine/phrases';
import { getBarBeats, getBarIndexAtBeat, getBarStartBeat, getTotalBeats } from '@/engine/timeline';
import { formatTs, parseTs, TIME_SIGNATURES } from '@/engine/meterDisplay';
import { PlayRangeRuler } from '@/components/PlayRangeRuler';
import { SectionBand } from '@/components/SectionBand';
import { ARRANGEMENT_ROW_HEIGHT, PhraseClipBlock } from '@/components/PhraseClipBlock';
import { PIANO_KEYS_WIDTH, PIXELS_PER_BEAT } from '@/utils/constants';
import type { Phrase, PhraseClip } from '@/types/music';

/**
 * The song seen whole: one row per instrument, one block per placement of a phrase.
 *
 * The counterpart to the timeline, and the reason the timeline could shrink to a
 * single phrase. Everything here is measured in *bars*, not beats — a phrase is a run
 * of bars, so a placement that started mid-bar would have no bar to put its first
 * segment in — but it is *drawn* on the beat axis the whole editor shares, so that a
 * block sits directly above the notes it produces in the piano roll, and zoom moves
 * both together.
 *
 * Row order comes from `panelLayout`, the same function the instruments sidebar
 * renders from, so the two can never disagree about which row is which instrument.
 *
 * Every gesture lives here rather than on the blocks, because all of them can end on
 * a different row than they started on: a block that owned its own drag would have to
 * know about rows it cannot see. They preview locally and commit once on release, so
 * a drag is one entry on the undo stack rather than dozens.
 */

/** The attribute a row carries so a drag can hit-test which instrument it is over. */
const ROW_ATTRIBUTE = 'data-arrangement-row';

/** Height of the bar-number strip above the rows, in pixels. */
const BAR_HEADER_HEIGHT = 28;

/**
 * The playback position line. The same red the piano roll draws its playhead in, so
 * the two surfaces read as one marker seen from two distances rather than as two
 * unrelated lines.
 */
const PLAYHEAD_COLOR = '#ef4444';

/**
 * A gesture in flight, in whole bars.
 *
 * `create` draws a new phrase across empty row; `move` slides an existing block,
 * keeping the bar it was grabbed by under the pointer, and may land on another row;
 * `resize` drags a block's right edge, which changes the *phrase's* length and so
 * every other placement of it; `place` drags a phrase out of the library onto a row.
 */
/**
 * What a modified drop leaves behind: a block with music of its own, or a second
 * placement of the one music.
 */
type CopyMode = 'unique' | 'linked';

/** Ctrl/Cmd asks for a copy of its own; Alt asks for another placement of the same phrase. */
const copyModeOf = (e: {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): CopyMode | null => (e.ctrlKey || e.metaKey ? 'unique' : e.altKey ? 'linked' : null);

type ClipDrag =
  | { kind: 'create'; trackId: string; anchorBar: number; bar: number; moved: boolean }
  | {
      kind: 'move';
      clipId: string;
      /** The row the pointer is over now, which is where a release would put it. */
      trackId: string;
      startBar: number;
      /** Bars between the block's left edge and the bar it was grabbed by. */
      grabOffset: number;
      /** Which kind of copy the drop should leave behind, or null for a plain move. */
      copy: CopyMode | null;
      moved: boolean;
    }
  | { kind: 'resize'; clipId: string; lengthBars: number; moved: boolean }
  | { kind: 'place'; phraseId: string; trackId: string | null; startBar: number; moved: boolean };

interface ArrangementViewProps {
  /**
   * Absolute song beat playback has reached.
   *
   * Absolute, not phrase-relative: this surface *is* the song. `App` measures its
   * playhead from the open phrase's bar 0 while one is being auditioned, but an
   * audition only exists while the phrase editor is up, so what arrives here is
   * always the song's own beat.
   */
  playheadBeat?: number;
}

export const ArrangementView: React.FC<ArrangementViewProps> = ({ playheadBeat = 0 }) => {
  const project = projectStore(s => s.project);
  const addPhraseClip = projectStore(s => s.addPhraseClip);
  const placePhrase = projectStore(s => s.placePhrase);
  const duplicateClip = projectStore(s => s.duplicateClip);
  const linkClip = projectStore(s => s.linkClip);
  const makeClipUnique = projectStore(s => s.makeClipUnique);
  const moveClip = projectStore(s => s.moveClip);
  const removeClip = projectStore(s => s.removeClip);
  const setPhraseLength = projectStore(s => s.setPhraseLength);
  const setBarTimeSignature = projectStore(s => s.setBarTimeSignature);
  const openClip = projectStore(s => s.openClip);
  const setLoopRegion = projectStore(s => s.setLoopRegion);
  const insertBar = projectStore(s => s.insertBar);
  const removeBars = projectStore(s => s.removeBars);

  const pixelsPerBeat = editorStore(s => s.pixelsPerBeat);
  const setPixelsPerBeat = editorStore(s => s.setPixelsPerBeat);
  const setScrollX = editorStore(s => s.setScrollX);
  const scrollX = editorStore(s => s.scrollX);

  const selectedClipId = selectionStore(s => s.selectedClipId);
  const selectClip = selectionStore(s => s.selectClip);
  const selectTrack = selectionStore(s => s.selectTrack);

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);

  /** The clip a right-click opened a menu on, and where on screen to draw it. */
  const [clipMenu, setClipMenu] = useState<{ clipId: string; x: number; y: number } | null>(null);

  const [drag, setDrag] = useState<ClipDrag | null>(null);
  /**
   * The live gesture, for the window listeners: they are installed once and would
   * otherwise go on reading whatever `drag` was when they were installed. Written
   * eagerly, since `setDrag` is asynchronous and a pointer event arriving before the
   * re-render would read a stale gesture and drop it.
   */
  const dragRef = useRef<ClipDrag | null>(null);

  const applyDrag = (next: ClipDrag | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  // The scroll offset is shared with the piano roll and the scrollbar, so this pane
  // follows when either of them moves rather than owning a position of its own.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (Math.abs(element.scrollLeft - scrollX) > 0.5) element.scrollLeft = scrollX;
  }, [scrollX]);

  /** The bar under a viewport x, clamped to the grid. Read live, not closed over. */
  const barAt = (clientX: number): number => {
    const current = projectStore.getState().project;
    if (!current) return 0;
    const left = rowsRef.current?.getBoundingClientRect().left ?? 0;
    const beat = Math.max(0, (clientX - left) / pixelsPerBeat);
    return getBarIndexAtBeat(current.bars, current.timeSignature, beat);
  };

  /** The instrument row under the pointer, or null when it is off the rows. */
  const rowAt = (clientX: number, clientY: number): string | null =>
    document
      .elementFromPoint?.(clientX, clientY)
      ?.closest(`[${ROW_ATTRIBUTE}]`)
      ?.getAttribute(ROW_ATTRIBUTE) ?? null;

  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      const state = dragRef.current;
      if (!state) return;

      const bar = barAt(e.clientX);

      if (state.kind === 'create') {
        applyDrag({ ...state, bar, moved: state.moved || bar !== state.anchorBar });
        return;
      }

      if (state.kind === 'resize') {
        const clip = projectStore.getState().project?.clips.find(c => c.id === state.clipId);
        if (!clip) return;
        const lengthBars = Math.max(1, bar - clip.startBar + 1);
        applyDrag({ ...state, lengthBars, moved: true });
        return;
      }

      if (state.kind === 'place') {
        applyDrag({
          ...state,
          trackId: rowAt(e.clientX, e.clientY),
          startBar: bar,
          moved: true,
        });
        return;
      }

      // A move may leave its row; when the pointer wanders off the rows entirely the
      // block stays on the one it was last over rather than snapping home, so a
      // gesture that dips into the gutter is not thrown away.
      const trackId = rowAt(e.clientX, e.clientY) ?? state.trackId;
      const startBar = Math.max(0, bar - state.grabOffset);
      applyDrag({
        ...state,
        trackId,
        startBar,
        moved: state.moved || startBar !== state.startBar || trackId !== state.trackId,
      });
    };

    const handleUp = (e: PointerEvent) => {
      const state = dragRef.current;
      applyDrag(null);
      if (!state) return;

      if (state.kind === 'create') {
        const startBar = Math.min(state.anchorBar, state.bar);
        const lengthBars = Math.abs(state.bar - state.anchorBar) + 1;
        const id = addPhraseClip(state.trackId, startBar, lengthBars);
        if (id) selectClip(id);
        return;
      }

      if (state.kind === 'resize') {
        if (!state.moved) return;
        const clip = projectStore.getState().project?.clips.find(c => c.id === state.clipId);
        if (clip) setPhraseLength(clip.phraseId, state.lengthBars);
        return;
      }

      if (state.kind === 'place') {
        if (!state.trackId) return;
        const id = placePhrase(state.phraseId, state.trackId, state.startBar);
        if (id) selectClip(id);
        return;
      }

      if (!state.moved) return;

      // The modifier at the *release* is what decides, not the one at the press: the
      // decision to leave a copy behind is usually made while looking at where the
      // block has landed.
      const mode = copyModeOf(e) ?? state.copy;
      if (mode) {
        const id =
          mode === 'unique'
            ? duplicateClip(state.clipId, state.trackId, state.startBar)
            : linkClip(state.clipId, state.trackId, state.startBar);
        if (id) selectClip(id);
        return;
      }
      moveClip(state.clipId, state.trackId, state.startBar);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
    // `barAt` and `rowAt` are rebuilt every render but read only the values below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pixelsPerBeat,
    addPhraseClip,
    placePhrase,
    duplicateClip,
    linkClip,
    moveClip,
    setPhraseLength,
    selectClip,
  ]);

  /**
   * A clip menu closes on Escape or on the next press outside it.
   *
   * The ruler's menu leans on an explicit Cancel button because it is a little form
   * with a number in it; this one is a list of commands, and a list of commands that
   * needed dismissing by hand would be in the way of the next gesture.
   */
  useEffect(() => {
    if (!clipMenu) return;

    const close = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-testid="clip-menu"]')) return;
      setClipMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setClipMenu(null);
    };

    // In the capture phase, or a press on another block would never arrive: `startMove`
    // stops the event so the row underneath does not also start drawing a phrase.
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [clipMenu]);

  /**
   * Delete removes the selected placement; Ctrl+D duplicates it, Ctrl+Shift+D links it.
   *
   * Handled here rather than in `useSegmentShortcuts` for the reason the section band
   * handles its own key: picking a block clears the block selection, so those
   * shortcuts bail and exactly one of the two ever acts on a press.
   */
  useEffect(() => {
    if (!selectedClipId) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      ) {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
        const current = projectStore.getState().project;
        const clip = current?.clips.find(c => c.id === selectedClipId);
        if (!current || !clip) return;
        const at = freeBarAfter(current.clips, current.phrases, clip);
        // Shift is what asks for the sharing; the bare shortcut copies the music too.
        const id = e.shiftKey
          ? linkClip(clip.id, clip.trackId, at)
          : duplicateClip(clip.id, clip.trackId, at);
        if (id) selectClip(id);
        e.preventDefault();
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        removeClip(selectedClipId);
        selectClip(null);
        e.preventDefault();
        return;
      }

      if (e.key === 'Escape') {
        selectClip(null);
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedClipId, removeClip, duplicateClip, linkClip, selectClip]);

  if (!project) return null;

  const { bars, timeSignature: projectTs } = project;
  const totalBeats = getTotalBeats(bars, projectTs);
  const width = Math.max(1, totalBeats * pixelsPerBeat);
  const rows = panelLayout(project.tracks, project.trackGroups ?? []);
  const library = unplacedPhrases(project.phrases, project.clips);

  /**
   * Why the ruler menu's Remove cannot take a run of song bars, or null when it can.
   *
   * The two rules `removeBars` enforces, said in words the user can read off a
   * disabled button rather than discovered by clicking one that does nothing.
   */
  const barMenuRemoveBlocked = (barIndex: number, count: number): string | null => {
    const span = Math.min(Math.max(1, Math.trunc(count)), bars.length - barIndex);
    if (span >= bars.length) return 'The song keeps at least one bar';
    const end = barIndex + span;
    return project.clips.some(c => c.startBar < end && clipEndBar(c, project.phrases) > barIndex)
      ? 'Something is playing over these bars — move or delete it first'
      : null;
  };

  /** A bar's length in beats, falling back to the project metre past the grid's end. */
  const beatsOfBar = (index: number): number => {
    const bar = bars[index];
    return bar
      ? getBarBeats(bar, projectTs)
      : getBarBeats({ id: '', barIndex: index, content: {} }, projectTs);
  };

  /** The pixel span of a run of bars, honouring each bar's own metre. */
  const spanOf = (startBar: number, lengthBars: number) => {
    let left = 0;
    for (let i = 0; i < startBar; i++) left += beatsOfBar(i);
    let beats = 0;
    for (let i = startBar; i < startBar + lengthBars; i++) beats += beatsOfBar(i);
    return { left: left * pixelsPerBeat, width: beats * pixelsPerBeat };
  };

  /** Where a clip sits right now, with any drag on it previewed in place. */
  const shownClip = (
    clip: PhraseClip
  ): { trackId: string; startBar: number; lengthBars: number } => {
    const base = {
      trackId: clip.trackId,
      startBar: clip.startBar,
      lengthBars: clipEndBar(clip, project.phrases) - clip.startBar,
    };
    if (!drag || !drag.moved) return base;
    if (drag.kind === 'move' && drag.clipId === clip.id && !drag.copy) {
      return { ...base, trackId: drag.trackId, startBar: drag.startBar };
    }
    if (drag.kind === 'resize' && drag.clipId === clip.id) {
      return { ...base, lengthBars: drag.lengthBars };
    }
    return base;
  };

  const colorOf = (phrase: Phrase): string =>
    phrase.color ?? phraseColorAt(project.phrases.findIndex(p => p.id === phrase.id));

  /** Whether the gesture in flight would be refused if it were released now. */
  const dragInvalid = (): boolean => {
    if (!drag || !drag.moved) return false;

    if (drag.kind === 'move') {
      const clip = project.clips.find(c => c.id === drag.clipId);
      if (!clip) return false;
      return !canPlaceClip(project.clips, project.phrases, {
        id: drag.copy ? undefined : clip.id,
        phraseId: clip.phraseId,
        trackId: drag.trackId,
        startBar: drag.startBar,
      });
    }

    if (drag.kind === 'place') {
      if (!drag.trackId) return true;
      return !canPlaceClip(project.clips, project.phrases, {
        phraseId: drag.phraseId,
        trackId: drag.trackId,
        startBar: drag.startBar,
      });
    }

    return false;
  };

  const invalid = dragInvalid();

  /** Whether the gesture's preview belongs on this row. */
  const ghostOnRow = (state: ClipDrag, trackId: string): boolean => {
    if (state.kind === 'create') return state.trackId === trackId;
    if (state.kind === 'place') return state.trackId === trackId;
    if (state.kind === 'move') return state.copy !== null && state.trackId === trackId;
    return false;
  };

  const ghostStyle = (state: ClipDrag): React.CSSProperties => {
    if (state.kind === 'create') {
      const span = spanOf(
        Math.min(state.anchorBar, state.bar),
        Math.abs(state.bar - state.anchorBar) + 1
      );
      return { left: `${span.left}px`, width: `${span.width}px` };
    }

    if (state.kind === 'place') {
      const phrase = phraseById(project.phrases, state.phraseId);
      const span = spanOf(state.startBar, phrase ? phraseLengthBars(phrase) : 1);
      return { left: `${span.left}px`, width: `${span.width}px` };
    }

    if (state.kind === 'move') {
      const clip = project.clips.find(c => c.id === state.clipId);
      const length = clip ? clipEndBar(clip, project.phrases) - clip.startBar : 1;
      const span = spanOf(state.startBar, length);
      return { left: `${span.left}px`, width: `${span.width}px` };
    }

    return {};
  };

  const startCreate = (e: React.PointerEvent, trackId: string) => {
    if (e.button !== 0) return;
    selectTrack(trackId);
    selectClip(null);
    const bar = barAt(e.clientX);
    applyDrag({ kind: 'create', trackId, anchorBar: bar, bar, moved: false });
  };

  const startMove = (e: React.PointerEvent, clip: PhraseClip) => {
    if (e.button !== 0) return;
    // Or the press would also start drawing a new phrase on the row underneath.
    e.stopPropagation();
    selectTrack(clip.trackId);
    selectClip(clip.id);
    applyDrag({
      kind: 'move',
      clipId: clip.id,
      trackId: clip.trackId,
      startBar: clip.startBar,
      grabOffset: barAt(e.clientX) - clip.startBar,
      copy: copyModeOf(e),
      moved: false,
    });
  };

  const startResize = (e: React.PointerEvent, clip: PhraseClip) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    selectClip(clip.id);
    applyDrag({
      kind: 'resize',
      clipId: clip.id,
      lengthBars: clipEndBar(clip, project.phrases) - clip.startBar,
      moved: false,
    });
  };

  /** One instrument's row: its blocks, and empty space to draw a new phrase on. */
  const renderRow = (trackId: string, indent: boolean) => (
    <div
      key={trackId}
      {...{ [ROW_ATTRIBUTE]: trackId }}
      data-testid={`arrangement-row-${trackId}`}
      onPointerDown={e => startCreate(e, trackId)}
      style={{ width: `${width}px`, height: `${ARRANGEMENT_ROW_HEIGHT}px` }}
      className={`relative border-b border-gray-800 cursor-crosshair select-none ${
        indent ? 'bg-gray-900/40' : ''
      }`}
    >
      {bars.map((bar, index) => (
        <div
          key={bar.id}
          style={{ left: `${getBarStartBeat(bars, index, projectTs) * pixelsPerBeat}px` }}
          className="absolute top-0 bottom-0 w-px bg-gray-800"
        />
      ))}

      {project.clips
        .filter(clip => shownClip(clip).trackId === trackId)
        .map(clip => {
          const phrase = phraseById(project.phrases, clip.phraseId);
          if (!phrase) return null;

          const shown = shownClip(clip);
          const span = spanOf(shown.startBar, shown.lengthBars);
          const isDragged = drag?.kind === 'move' && drag.moved && drag.clipId === clip.id;

          return (
            <PhraseClipBlock
              key={clip.id}
              clipId={clip.id}
              phrase={phrase}
              color={colorOf(phrase)}
              left={span.left}
              width={span.width}
              selected={selectedClipId === clip.id}
              placements={placementCount(project.clips, clip.phraseId)}
              invalid={isDragged && invalid}
              onPointerDown={e => startMove(e, clip)}
              onResizePointerDown={e => startResize(e, clip)}
              onDoubleClick={() => openClip(clip.id)}
              onContextMenu={e => {
                e.preventDefault();
                e.stopPropagation();
                // Pick it first, so the menu and the inspector are talking about the
                // same block.
                selectTrack(clip.trackId);
                selectClip(clip.id);
                setClipMenu({ clipId: clip.id, x: e.clientX, y: e.clientY });
              }}
            />
          );
        })}

      {/* The phrase being drawn, or the library chip being dropped, previewed where
          it would land — in red when it would be refused. */}
      {drag?.moved && ghostOnRow(drag, trackId) && (
        <div
          data-testid="clip-ghost"
          style={ghostStyle(drag)}
          className={`absolute top-0.5 bottom-0.5 rounded-sm border pointer-events-none ${
            invalid ? 'bg-red-500/20 border-red-400' : 'bg-indigo-400/30 border-indigo-300'
          }`}
        />
      )}
    </div>
  );

  /** The gutter entry facing a row, so the two columns stay in step. */
  const renderGutterRow = (
    name: string,
    color: string | undefined,
    trackId: string,
    indent: boolean
  ) => (
    <div
      key={trackId}
      data-testid={`arrangement-gutter-${trackId}`}
      onClick={() => selectTrack(trackId)}
      style={{ height: `${ARRANGEMENT_ROW_HEIGHT}px` }}
      className={`flex items-center gap-1.5 border-b border-gray-800 text-[11px] text-gray-300 cursor-pointer hover:bg-gray-700/50 ${
        indent ? 'pl-4 pr-2' : 'px-2'
      }`}
    >
      <span style={{ backgroundColor: color }} className="shrink-0 w-2 h-2 rounded-sm" />
      <span className="truncate">{name}</span>
    </div>
  );

  const gutterRows = (row: PanelRow): React.ReactNode =>
    row.kind === 'track'
      ? renderGutterRow(row.track.name, row.track.color, row.track.id, false)
      : [
          <div
            key={`group-${row.group.id}`}
            data-testid={`arrangement-group-${row.group.id}`}
            style={{ height: `${ARRANGEMENT_ROW_HEIGHT / 2}px` }}
            className="flex items-center px-2 text-[10px] uppercase tracking-wide text-gray-500 border-b border-gray-800"
          >
            <span className="truncate">{row.group.name}</span>
          </div>,
          ...(row.group.collapsed
            ? []
            : row.members.map(m => renderGutterRow(m.track.name, m.track.color, m.track.id, true))),
        ];

  const laneRows = (row: PanelRow): React.ReactNode =>
    row.kind === 'track'
      ? renderRow(row.track.id, false)
      : [
          // A group header owns no music, so its band is a spacer — but one that has
          // to exist, or every row below it would face the wrong instrument.
          <div
            key={`group-${row.group.id}`}
            style={{ width: `${width}px`, height: `${ARRANGEMENT_ROW_HEIGHT / 2}px` }}
            className="border-b border-gray-800 bg-gray-800/40"
          />,
          ...(row.group.collapsed ? [] : row.members.map(m => renderRow(m.track.id, true))),
        ];

  return (
    <div
      data-testid="arrangement-view"
      className="shrink-0 flex flex-col bg-gray-900 border-b border-gray-700"
    >
      {/* Toolbar. Snap is absent on purpose: this surface places in whole bars, so
          there is no finer grid for it to choose. */}
      <div className="flex items-center gap-2 px-2 py-1 border-b border-gray-800 text-xs text-gray-400">
        <span className="text-gray-300 font-medium">Arrangement</span>

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

        <span className="text-gray-500">
          Drag a row to make a phrase · double-click a block to edit it
        </span>
      </div>

      <div className="flex items-stretch">
        {/* Matches the piano roll's key column, so bar 1 starts where its grid does.
            Bottom-aligned, so the ruler and the bar strip overhang it rather than
            each needing a row of their own over here. */}
        <div
          data-testid="arrangement-gutter"
          style={{ width: `${PIANO_KEYS_WIDTH}px` }}
          className="shrink-0 bg-gray-800 border-r border-gray-700 flex flex-col justify-end"
        >
          {rows.map(gutterRows)}
        </div>

        <div
          ref={scrollRef}
          data-testid="arrangement-scroll"
          onScroll={e => setScrollX(e.currentTarget.scrollLeft)}
          className="flex-1 overflow-x-auto scrollbar-hidden"
        >
          <div className="min-w-max relative">
            {/* The arrangement's named spans, on the same beat axis as everything
                below. It overhangs the gutter as the ruler does — that column is
                bottom-aligned, so neither needs a row of its own over there. */}
            <SectionBand totalBeats={totalBeats} />

            {/* Absolute song beats: this is the surface where a beat is a beat in
                the song, so the range the ruler draws is the project's own. */}
            <PlayRangeRuler
              bars={bars}
              timeSignature={projectTs}
              range={
                project.loopStart !== undefined && project.loopEnd !== undefined
                  ? { start: project.loopStart, end: project.loopEnd }
                  : null
              }
              onRangeChange={setLoopRegion}
              onInsertBars={insertBar}
              onRemoveBars={removeBars}
              removeBlockedReason={barMenuRemoveBlocked}
            />

            {/* The bar grid, and the only place a bar's metre can be changed: metre
                belongs to the bar and so to the song, while the phrase editor shows
                bars that may be played in several places at once. */}
            <div
              style={{ width: `${width}px`, height: `${BAR_HEADER_HEIGHT}px` }}
              className="relative border-b border-gray-700 bg-gray-800/60"
            >
              {bars.map((bar, index) => (
                <div
                  key={bar.id}
                  data-testid={`arrangement-bar-${index}`}
                  style={{
                    left: `${getBarStartBeat(bars, index, projectTs) * pixelsPerBeat}px`,
                    width: `${beatsOfBar(index) * pixelsPerBeat}px`,
                  }}
                  className="absolute top-0 bottom-0 flex items-center gap-1 px-1 border-l border-gray-700 text-[10px] text-gray-400"
                >
                  <span>{index + 1}</span>
                  <select
                    data-testid={`bar-time-signature-${index}`}
                    aria-label={`Time signature for bar ${index + 1}`}
                    value={formatTs(bar.timeSignature ?? projectTs)}
                    onChange={e => setBarTimeSignature(bar.id, parseTs(e.target.value))}
                    className="bg-transparent border border-transparent rounded text-gray-400 hover:border-gray-600 focus:outline-none focus:border-indigo-500"
                  >
                    {TIME_SIGNATURES.map(ts => (
                      <option key={formatTs(ts)} value={formatTs(ts)}>
                        {formatTs(ts)}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            <div ref={rowsRef}>{rows.map(laneRows)}</div>

            {/* Where playback is, on the beat axis everything above is drawn on, and
                across the whole stack — band, ruler, bar strip and rows — because the
                point of it is to line the position up against the blocks it is
                sounding. Last child, so it paints over the blocks without the rest of
                the view needing to take a position in a z-order.

                Drawn while stopped too: that is where the next Play begins.

                No transition on `left`. A repeat carries the position backwards in one
                step, and a transition would answer that by sliding the line back across
                the screen — reading as a rewind that never happened. */}
            <div
              data-testid="arrangement-playhead"
              style={{
                // Clamped, or a playhead run past the last bar would stretch the
                // scrollable content out past the end of the song.
                left: `${Math.min(Math.max(playheadBeat, 0), totalBeats) * pixelsPerBeat}px`,
                backgroundColor: PLAYHEAD_COLOR,
              }}
              // `pointer-events-none` is load-bearing: drags hit-test through
              // `document.elementFromPoint`, and a line that answered it would swallow
              // every gesture that passed underneath.
              className="absolute top-0 bottom-0 w-0.5 pointer-events-none"
            />
          </div>
        </div>
      </div>

      {/* Right-clicking a block: the two ways to copy it, side by side, because which
          one is wanted is a decision about the music rather than about the gesture. */}
      {clipMenu &&
        (() => {
          const clip = project.clips.find(c => c.id === clipMenu.clipId);
          if (!clip) return null;
          const shared = placementCount(project.clips, clip.phraseId) > 1;
          const item =
            'text-left px-2 py-0.5 rounded text-gray-200 hover:bg-gray-700 transition-colors';

          const run = (act: () => void) => () => {
            act();
            setClipMenu(null);
          };
          const placeCopy = (make: (at: number) => string | null) =>
            run(() => {
              const current = projectStore.getState().project;
              if (!current) return;
              const id = make(freeBarAfter(current.clips, current.phrases, clip));
              if (id) selectClip(id);
            });

          return (
            <div
              data-testid="clip-menu"
              style={{ position: 'fixed', left: clipMenu.x, top: clipMenu.y, zIndex: 50 }}
              className="flex flex-col bg-gray-800 border border-gray-600 rounded p-1 shadow-lg text-xs"
            >
              <button
                type="button"
                data-testid="clip-menu-edit"
                title="Open this phrase in the editor"
                onClick={run(() => openClip(clip.id))}
                className={item}
              >
                Edit
              </button>
              <button
                type="button"
                data-testid="clip-menu-duplicate"
                title="Copy this block and its music, so editing the copy leaves this one alone"
                onClick={placeCopy(at => duplicateClip(clip.id, clip.trackId, at))}
                className={item}
              >
                Duplicate
              </button>
              <button
                type="button"
                data-testid="clip-menu-link"
                title="Play the same phrase again — editing either changes both"
                onClick={placeCopy(at => linkClip(clip.id, clip.trackId, at))}
                className={item}
              >
                Duplicate linked
              </button>
              {/* Only where there is sharing to break, as the inspector does. */}
              {shared && (
                <button
                  type="button"
                  data-testid="clip-menu-unique"
                  title="Give this block its own copy, so editing it leaves the others alone"
                  onClick={run(() => makeClipUnique(clip.id))}
                  className={item}
                >
                  Make unique
                </button>
              )}
              <button
                type="button"
                data-testid="clip-menu-remove"
                title="Take this placement away. The phrase stays, unplaced."
                onClick={run(() => {
                  removeClip(clip.id);
                  selectClip(null);
                })}
                className={`${item} hover:bg-red-600`}
              >
                Remove
              </button>
            </div>
          );
        })()}

      {/* Phrases nothing plays. Deleting a block takes away a placement, not the
          music, so this is where the music it left behind waits to be used again. */}
      <div
        data-testid="phrase-library"
        className="flex items-center gap-2 px-2 py-1 border-t border-gray-800 text-xs text-gray-400 overflow-x-auto"
      >
        <span className="shrink-0 text-gray-500">Unplaced</span>
        {library.length === 0 ? (
          <span className="text-gray-600 italic">nothing — every phrase is placed</span>
        ) : (
          library.map(phrase => (
            <button
              key={phrase.id}
              type="button"
              data-testid={`library-phrase-${phrase.id}`}
              title={`Drag onto an instrument to place ${phrase.name}`}
              onPointerDown={e => {
                if (e.button !== 0) return;
                applyDrag({
                  kind: 'place',
                  phraseId: phrase.id,
                  trackId: null,
                  startBar: 0,
                  moved: false,
                });
              }}
              style={{ borderColor: colorOf(phrase) }}
              className="shrink-0 px-1.5 rounded border bg-gray-800 text-gray-200 cursor-grab"
            >
              {phrase.name}
            </button>
          ))
        )}
      </div>
    </div>
  );
};
