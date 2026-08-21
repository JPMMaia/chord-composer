import React from 'react';
import type { Phrase } from '@/types/music';

/**
 * One placement of a phrase, drawn on an instrument's row in the arrangement.
 *
 * Deliberately dumb: it draws, and it reports presses. Every gesture that acts on a
 * clip — move, duplicate, resize, open — is owned by `ArrangementView`, because all
 * of them can end on a *different* row than they started on, and a block that handled
 * its own drag would have to know about rows it cannot see.
 *
 * The link glyph is the one thing here that is not decoration: a block sharing its
 * phrase with others changes them all when it is edited, and there is nothing else on
 * screen that says so before the edit is made.
 */

/** Height of one instrument row in the arrangement, in pixels. */
export const ARRANGEMENT_ROW_HEIGHT = 40;

/** Width of the grab strip at a block's right edge, in pixels. Matches the band's. */
export const CLIP_HANDLE_PX = 8;

export interface PhraseClipBlockProps {
  clipId: string;
  phrase: Phrase;
  color: string;
  left: number;
  width: number;
  selected: boolean;
  /** How many placements the phrase has in all, this one included. */
  placements: number;
  /** True while a drag holds it somewhere it cannot be dropped. */
  invalid?: boolean;
  /** True while it is the ghost of a drag rather than the block itself. */
  ghost?: boolean;
  onPointerDown?: (e: React.PointerEvent) => void;
  onResizePointerDown?: (e: React.PointerEvent) => void;
  onDoubleClick?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

export const PhraseClipBlock: React.FC<PhraseClipBlockProps> = ({
  clipId,
  phrase,
  color,
  left,
  width,
  selected,
  placements,
  invalid = false,
  ghost = false,
  onPointerDown,
  onResizePointerDown,
  onDoubleClick,
  onContextMenu,
}) => (
  <div
    data-testid={ghost ? 'clip-ghost' : `clip-${clipId}`}
    data-clip-id={ghost ? undefined : clipId}
    data-selected={selected || undefined}
    data-invalid={invalid || undefined}
    role={ghost ? undefined : 'button'}
    tabIndex={ghost ? undefined : 0}
    aria-label={ghost ? undefined : `${phrase.name} clip`}
    title={
      placements > 1
        ? `${phrase.name} — played in ${placements} places; editing it changes them all`
        : `${phrase.name} — double-click to edit`
    }
    onPointerDown={onPointerDown}
    onDoubleClick={onDoubleClick}
    onContextMenu={onContextMenu}
    style={{
      left: `${left}px`,
      width: `${Math.max(2, width)}px`,
      backgroundColor: `${color}55`,
      borderColor: invalid ? '#f87171' : color,
    }}
    className={`absolute top-0.5 bottom-0.5 rounded-sm border overflow-hidden select-none ${
      ghost ? 'pointer-events-none opacity-70' : 'cursor-grab'
    } ${selected ? 'ring-1 ring-inset ring-indigo-300' : ''}`}
  >
    <div className="flex items-center gap-1 px-1 pt-0.5 text-[10px] text-gray-100">
      {placements > 1 && (
        <span data-testid={`clip-linked-${clipId}`} aria-hidden className="text-amber-300">
          ∞
        </span>
      )}
      <span className="truncate">{phrase.name}</span>
    </div>

    {/* The right edge only: a phrase starts where it starts, and dragging the left
        edge would have to mean either moving it or dropping its first bar, neither
        of which is what a resize grip promises. */}
    {!ghost && onResizePointerDown && (
      <div
        role="button"
        aria-label={`Resize ${phrase.name}`}
        onPointerDown={onResizePointerDown}
        style={{ width: `${CLIP_HANDLE_PX}px` }}
        className="absolute top-0 bottom-0 right-0 cursor-ew-resize"
      />
    )}
  </div>
);
