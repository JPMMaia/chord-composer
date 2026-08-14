import React, { useEffect, useRef, useState } from 'react';
import { projectStore } from '@/store/projectStore';
import { editorStore } from '@/store/editorStore';
import { selectionStore } from '@/store/selectionStore';
import { snapBeat } from '@/engine/timeline';
import { sectionColorAt } from '@/engine/sections';

/**
 * The arrangement's shape, written down: named spans drawn in a strip above the
 * timeline ruler.
 *
 * One continuous strip on the shared beat axis, like the ruler below it and the
 * automation lane beneath the timeline — so a section reads as a position in the
 * music rather than as material in a bar, and can cross a bar line without being
 * cut in two.
 *
 * A section labels; it never sounds. Clicking one sets the play range to its span,
 * which is what makes "play the chorus" a single gesture, but the blocks underneath
 * it never learn it is there.
 */

/** Height of the band in pixels. Matches the ruler below it. */
export const SECTION_BAND_HEIGHT = 20;

/** How far the pointer must travel before a press counts as a drag, not a click. */
const DRAG_THRESHOLD_PX = 3;

/** Width of the grab strips at a section's edges, in pixels. Matches the ruler's. */
const HANDLE_PX = 8;

/**
 * A gesture in flight, in absolute beats.
 *
 * `create` draws a new span from where the pointer went down; `resize` drags one
 * edge against the other as its anchor; `move` slides a whole span, keeping the
 * grab point under the pointer. All three preview locally and commit once on
 * release, so a drag is one entry on the undo stack rather than dozens.
 */
type BandDrag =
  | { kind: 'create'; anchorBeat: number; beat: number; originBeat: number; moved: boolean }
  | {
      kind: 'resize';
      id: string;
      anchorBeat: number;
      beat: number;
      originBeat: number;
      moved: boolean;
    }
  | {
      kind: 'move';
      id: string;
      /** Beats between the section's left edge and the point it was grabbed by. */
      grabOffset: number;
      span: number;
      startBeat: number;
      originBeat: number;
      moved: boolean;
    };

interface SectionBandProps {
  /** Width of the band in beats — the project's full length. */
  totalBeats: number;
}

export const SectionBand: React.FC<SectionBandProps> = ({ totalBeats }) => {
  const sections = projectStore(s => s.project?.sections) ?? [];
  const addSection = projectStore(s => s.addSection);
  const renameSection = projectStore(s => s.renameSection);
  const setSectionRange = projectStore(s => s.setSectionRange);
  const removeSection = projectStore(s => s.removeSection);
  const setLoopRegion = projectStore(s => s.setLoopRegion);

  const pixelsPerBeat = editorStore(s => s.pixelsPerBeat);
  const snapBeats = editorStore(s => s.snapBeats);

  const selectedId = selectionStore(s => s.selectedSectionId);
  const selectSection = selectionStore(s => s.selectSection);

  const bandRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<BandDrag | null>(null);

  /**
   * The live drag, for the window listeners, which are installed once and would
   * otherwise keep reading whatever the state was when they were installed. Written
   * eagerly by `applyDrag` for the reason `AutomationLane` spells out: `setDrag` is
   * asynchronous, and a pointer event arriving before the re-render would read a
   * stale gesture and drop it.
   */
  const dragRef = useRef<BandDrag | null>(null);

  const applyDrag = (next: BandDrag | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  /**
   * Set when a gesture actually travelled, so the click the browser fires after the
   * pointer comes up does not also read as "play this section" — dragging a band
   * somewhere else must not jump the play range to where it landed.
   */
  const draggedRef = useRef(false);

  /** The section whose name is open for editing, and the text being typed into it. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId) inputRef.current?.select();
  }, [editingId]);

  const width = Math.max(1, totalBeats * pixelsPerBeat);

  /** Absolute beat under a viewport x coordinate, unsnapped. */
  const rawBeatAt = (clientX: number): number => {
    const left = bandRef.current?.getBoundingClientRect().left ?? 0;
    const beat = (clientX - left) / pixelsPerBeat;
    return Number.isFinite(beat) ? Math.max(0, beat) : 0;
  };

  /** The same, on the grid the whole editor shares. */
  const beatAt = (clientX: number): number => snapBeat(rawBeatAt(clientX), snapBeats);

  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      const state = dragRef.current;
      if (!state) return;

      const raw = rawBeatAt(e.clientX);
      const moved =
        state.moved || Math.abs(raw - state.originBeat) * pixelsPerBeat > DRAG_THRESHOLD_PX;

      if (state.kind === 'move') {
        // Snap the section's *edge* rather than the pointer, so a span grabbed by its
        // middle still lands on the grid instead of carrying its grab offset along.
        const startBeat = Math.max(
          0,
          Math.min(snapBeat(raw - state.grabOffset, snapBeats), totalBeats - state.span)
        );
        applyDrag({ ...state, startBeat, moved });
        return;
      }

      applyDrag({ ...state, beat: beatAt(e.clientX), moved });
    };

    const handleUp = () => {
      const state = dragRef.current;
      applyDrag(null);
      if (!state) return;
      // Only a gesture that began on a section leaves a click behind on one; a
      // create-drag's trailing click lands on the band, where nothing is listening,
      // and would otherwise leave the flag set to swallow the next real click.
      draggedRef.current = state.kind !== 'create' && state.moved;
      if (!state.moved) return;

      if (state.kind === 'move') {
        setSectionRange(state.id, state.startBeat, state.startBeat + state.span);
        return;
      }

      const start = Math.min(state.anchorBeat, state.beat);
      const end = Math.max(state.anchorBeat, state.beat);

      if (state.kind === 'resize') {
        setSectionRange(state.id, start, end);
        return;
      }

      const id = addSection(start, end);
      if (!id) return;

      // A new section comes up selected with its name open: naming it is the point of
      // drawing it, and it would otherwise take a second aim at a strip of text.
      selectSection(id);
      const created = projectStore.getState().project?.sections?.find(s => s.id === id);
      setDraftName(created?.name ?? '');
      setEditingId(id);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
    // `rawBeatAt` and `beatAt` are rebuilt every render but read only the values below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pixelsPerBeat, snapBeats, totalBeats, addSection, setSectionRange, selectSection]);

  /**
   * Delete erases the selected section; Escape lets it go.
   *
   * Handled here rather than in `useSegmentShortcuts` for the reason the automation
   * lane handles its own point: selecting a section clears the block selection, so
   * those shortcuts bail and exactly one of the two ever acts on a press.
   */
  useEffect(() => {
    if (!selectedId) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // A section is not selected *into* a field, so a keystroke aimed at one — its
      // own rename box, say — is none of this band's business.
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        removeSection(selectedId);
        selectSection(null);
        e.preventDefault();
        return;
      }

      if (e.key === 'Escape') {
        selectSection(null);
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedId, removeSection, selectSection]);

  /** Begin drawing a new section on empty band. */
  const handleBandPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const beat = beatAt(e.clientX);
    applyDrag({
      kind: 'create',
      anchorBeat: beat,
      beat,
      originBeat: rawBeatAt(e.clientX),
      moved: false,
    });
  };

  const commitRename = (sectionId: string) => {
    renameSection(sectionId, draftName);
    setEditingId(null);
  };

  /** Where a section sits right now, with any drag on it previewed in place. */
  const shownRange = (id: string, startBeat: number, endBeat: number) => {
    if (!drag || !drag.moved || drag.kind === 'create' || drag.id !== id) {
      return { start: startBeat, end: endBeat };
    }
    if (drag.kind === 'move') {
      return { start: drag.startBeat, end: drag.startBeat + drag.span };
    }
    return {
      start: Math.min(drag.anchorBeat, drag.beat),
      end: Math.max(drag.anchorBeat, drag.beat),
    };
  };

  const ghost =
    drag && drag.kind === 'create' && drag.moved
      ? { start: Math.min(drag.anchorBeat, drag.beat), end: Math.max(drag.anchorBeat, drag.beat) }
      : null;

  return (
    <div
      ref={bandRef}
      data-testid="section-band"
      onPointerDown={handleBandPointerDown}
      style={{ width: `${width}px`, height: `${SECTION_BAND_HEIGHT}px` }}
      title="Drag to name a stretch of the arrangement"
      className="relative bg-gray-800/60 border-b border-gray-700 select-none cursor-crosshair"
    >
      {sections.map((section, index) => {
        const { start, end } = shownRange(section.id, section.startBeat, section.endBeat);
        const color = section.color ?? sectionColorAt(index);
        const isSelected = selectedId === section.id;

        return (
          <div
            key={section.id}
            data-testid={`section-${section.id}`}
            data-selected={isSelected || undefined}
            role="button"
            tabIndex={0}
            aria-label={`Section ${section.name}`}
            title={`${section.name} — click to play this range, double-click the name to rename`}
            onPointerDown={e => {
              if (e.button !== 0) return;
              // Or the press would also start drawing a new section underneath.
              e.stopPropagation();
              selectSection(section.id);
              applyDrag({
                kind: 'move',
                id: section.id,
                grabOffset: rawBeatAt(e.clientX) - start,
                span: end - start,
                startBeat: start,
                originBeat: rawBeatAt(e.clientX),
                moved: false,
              });
            }}
            onClick={() => {
              // A press that never travelled: the "play the chorus" gesture.
              if (draggedRef.current) {
                draggedRef.current = false;
                return;
              }
              selectSection(section.id);
              setLoopRegion(section.startBeat, section.endBeat);
            }}
            style={{
              left: `${start * pixelsPerBeat}px`,
              width: `${Math.max(0, end - start) * pixelsPerBeat}px`,
              backgroundColor: `${color}44`,
              borderColor: color,
            }}
            className={`absolute top-0 bottom-0 flex items-center gap-1 border-l-2 overflow-hidden cursor-grab ${
              isSelected ? 'ring-1 ring-inset ring-indigo-300' : ''
            }`}
          >
            {editingId === section.id ? (
              <input
                ref={inputRef}
                value={draftName}
                onChange={e => setDraftName(e.target.value)}
                onPointerDown={e => e.stopPropagation()}
                onClick={e => e.stopPropagation()}
                onBlur={() => commitRename(section.id)}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitRename(section.id);
                  if (e.key === 'Escape') setEditingId(null);
                  // The editor binds bare letters and digits; a name is not a shortcut.
                  e.stopPropagation();
                }}
                aria-label={`Rename ${section.name}`}
                className="min-w-0 flex-1 px-1 bg-gray-900 text-[10px] text-gray-100 outline-none"
              />
            ) : (
              <>
                <span
                  onDoubleClick={e => {
                    e.stopPropagation();
                    setDraftName(section.name);
                    setEditingId(section.id);
                  }}
                  className="min-w-0 flex-1 px-1 text-[10px] text-gray-100 truncate"
                >
                  {section.name}
                </span>

                {/* Mouse-only way out, for anyone who never finds Delete. */}
                <button
                  type="button"
                  aria-label={`Remove ${section.name}`}
                  onPointerDown={e => e.stopPropagation()}
                  onClick={e => {
                    e.stopPropagation();
                    removeSection(section.id);
                    if (isSelected) selectSection(null);
                  }}
                  className="shrink-0 px-1 text-[10px] leading-none text-gray-400 hover:text-red-400"
                >
                  ×
                </button>
              </>
            )}

            {/* Edge handles. Each drags against the opposite edge as its anchor. */}
            <div
              role="button"
              aria-label={`${section.name} start`}
              onPointerDown={e => {
                if (e.button !== 0) return;
                e.stopPropagation();
                selectSection(section.id);
                applyDrag({
                  kind: 'resize',
                  id: section.id,
                  anchorBeat: end,
                  beat: start,
                  originBeat: rawBeatAt(e.clientX),
                  moved: false,
                });
              }}
              style={{ width: `${HANDLE_PX}px`, left: 0 }}
              className="absolute top-0 bottom-0 cursor-ew-resize"
            />
            <div
              role="button"
              aria-label={`${section.name} end`}
              onPointerDown={e => {
                if (e.button !== 0) return;
                e.stopPropagation();
                selectSection(section.id);
                applyDrag({
                  kind: 'resize',
                  id: section.id,
                  anchorBeat: start,
                  beat: end,
                  originBeat: rawBeatAt(e.clientX),
                  moved: false,
                });
              }}
              style={{ width: `${HANDLE_PX}px`, right: 0 }}
              className="absolute top-0 bottom-0 cursor-ew-resize"
            />
          </div>
        );
      })}

      {/* The span being drawn, so a create-drag shows what it will produce. */}
      {ghost && (
        <div
          data-testid="section-ghost"
          style={{
            left: `${ghost.start * pixelsPerBeat}px`,
            width: `${(ghost.end - ghost.start) * pixelsPerBeat}px`,
          }}
          className="absolute top-0 bottom-0 bg-indigo-400/30 border-x border-indigo-300 pointer-events-none"
        />
      )}
    </div>
  );
};
