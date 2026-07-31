import React, { useEffect, useRef } from 'react';
import type { ChordSegment } from '@/types/music';
import { MIN_SEGMENT_BEATS } from '@/engine/timeline';

interface ChordSegmentBlockProps {
  segment: ChordSegment;
  isSelected: boolean;
  /** Beats from the start of the containing bar. */
  startBeat: number;
  /** Horizontal scale: sizes the block, and reads a pointer delta back as beats. */
  pixelsPerBeat: number;
  onSelect: (segmentId: string) => void;
  onRemove: (segmentId: string) => void;
  onResize: (segmentId: string, durationBeats: number) => void;
  /**
   * Begins a drag. The gesture itself is run by the timeline, which is the only
   * thing that knows where the other lanes are and so where the pointer may land.
   */
  onMoveStart?: (e: React.PointerEvent) => void;
  onMoveLeft?: () => void;
  onMoveRight?: () => void;
  /** True while this block is being dragged, so it can lift above its neighbours. */
  isDragging?: boolean;
}

/** What the block leads with: a chord's symbol, a note's name. */
function primaryLabel(segment: ChordSegment): string {
  return segment.chordSymbol ?? segment.root ?? segment.romanNumeral ?? '?';
}

/**
 * One segment on the chord timeline: a chord or a single note, sized by its
 * duration and resizable from its right edge.
 *
 * Resizing uses pointer events rather than HTML5 drag-and-drop so that it does not
 * compete with the palette drag for the same gesture.
 */
export const ChordSegmentBlock: React.FC<ChordSegmentBlockProps> = ({
  segment,
  isSelected,
  startBeat,
  pixelsPerBeat,
  onSelect,
  onRemove,
  onResize,
  onMoveStart,
  onMoveLeft,
  onMoveRight,
  isDragging = false,
}) => {
  const isNote = segment.kind === 'note';

  // Captured once per gesture: reading the live duration on every move would
  // compound each delta against the previous result.
  const resizeRef = useRef<{ startX: number; startDuration: number } | null>(null);

  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      const state = resizeRef.current;
      if (!state) return;
      const deltaBeats = (e.clientX - state.startX) / pixelsPerBeat;
      onResize(segment.id, Math.max(MIN_SEGMENT_BEATS, state.startDuration + deltaBeats));
    };
    const handleUp = () => {
      resizeRef.current = null;
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [segment.id, pixelsPerBeat, onResize]);

  const handleResizeStart = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    resizeRef.current = { startX: e.clientX, startDuration: segment.duration };
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'Enter':
        onSelect(segment.id);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        onMoveLeft?.();
        break;
      case 'ArrowRight':
        e.preventDefault();
        onMoveRight?.();
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        onRemove(segment.id);
        break;
    }
  };

  return (
    <div
      data-chord-block={segment.id}
      data-testid={`chord-block-${segment.id}`}
      role="button"
      tabIndex={0}
      aria-label={`${isNote ? 'Note' : 'Chord'} ${primaryLabel(segment)}`}
      onClick={e => {
        e.stopPropagation();
        onSelect(segment.id);
      }}
      onKeyDown={handleKeyDown}
      onPointerDown={onMoveStart}
      // Spans exactly its own beats, so a block covers the same span as the notes
      // it generates in the piano roll below.
      style={{
        left: `${startBeat * pixelsPerBeat}px`,
        width: `${segment.duration * pixelsPerBeat}px`,
      }}
      className={`
        absolute top-0 bottom-0 flex flex-col items-center justify-center overflow-hidden
        rounded-md select-none border transition-colors
        ${isDragging ? 'cursor-grabbing z-20 opacity-80' : 'cursor-grab'}
        ${isSelected ? 'ring-2 ring-indigo-400 z-10' : ''}
        ${isNote
          ? 'bg-teal-800 border-teal-600 text-teal-50'
          : 'bg-indigo-800 border-indigo-600 text-indigo-50'}
      `}
    >
      <span className="text-sm font-semibold leading-tight truncate px-1">
        {primaryLabel(segment)}
      </span>
      {segment.romanNumeral && (
        <span className="text-[10px] opacity-70 leading-tight">{segment.romanNumeral}</span>
      )}

      <button
        // Stopped here as well as on click, so reaching for the × never reads as
        // the start of a drag.
        onPointerDown={e => e.stopPropagation()}
        onClick={e => {
          e.stopPropagation();
          onRemove(segment.id);
        }}
        aria-label="Remove segment"
        className="absolute top-0 right-0 w-4 h-4 flex items-center justify-center text-[10px] text-gray-300 hover:text-red-400"
      >
        ×
      </button>

      {/* Right-edge resize grip. */}
      <div
        data-testid={`resize-handle-${segment.id}`}
        onPointerDown={handleResizeStart}
        role="separator"
        aria-label="Resize segment"
        className="absolute top-0 bottom-0 right-0 w-1.5 cursor-ew-resize bg-white/20 hover:bg-white/50"
      />
    </div>
  );
};
