import React, { useEffect, useRef } from 'react';
import type { ChordSegment } from '@/types/music';
import { MIN_SEGMENT_BEATS } from '@/engine/timeline';
import { midiToNoteLabel } from '@/engine/chords';

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
   * Begins a press: resolves the selection, then a drag. The gesture itself is run
   * by the timeline, which is the only thing that knows where the other lanes are
   * and so where the pointer may land — and which blocks travel along with this one.
   */
  onMoveStart?: (e: React.PointerEvent) => void;
  onMoveLeft?: () => void;
  onMoveRight?: () => void;
  /** True while this block is being dragged, so it can lift above its neighbours. */
  isDragging?: boolean;
}

/** How many of a recorded block's pitches are named before the label gives up counting. */
const CUSTOM_LABEL_PITCHES = 3;

/**
 * What a recorded block reads: the pitches it holds, lowest first.
 *
 * Named rather than counted because the pitches are the only thing that
 * distinguishes one take from another at a glance — a block reading "5 notes" is
 * indistinguishable from every other one. Each pitch appears once however often it
 * was played, so a repeated note does not crowd out the rest of the chord, and a
 * long run is cut off with a count so the label still fits a short block.
 */
function customLabel(segment: ChordSegment): string {
  const pitches = [...new Set((segment.customNotes ?? []).map(n => n.pitch))].sort(
    (a, b) => a - b
  );
  if (pitches.length === 0) return '(empty)';

  const named = pitches.slice(0, CUSTOM_LABEL_PITCHES).map(midiToNoteLabel).join(' ');
  const rest = pitches.length - CUSTOM_LABEL_PITCHES;
  return rest > 0 ? `${named} +${rest}` : named;
}

/**
 * What the block leads with: a chord's symbol, a note's name with its octave, a
 * recorded block's pitches.
 *
 * A note's name is derived from its live pitch rather than the symbol it was
 * dropped with, so it stays honest after a key change retunes the segment.
 */
function primaryLabel(segment: ChordSegment): string {
  if (segment.kind === 'note' && segment.pitch !== undefined) {
    return midiToNoteLabel(segment.pitch);
  }
  if (segment.kind === 'custom') {
    return customLabel(segment);
  }
  return segment.chordSymbol ?? segment.root ?? segment.romanNumeral ?? '?';
}

/** Register a chord segment is voiced in; segments predating octave selection read as 4. */
function chordOctave(segment: ChordSegment): number {
  return segment.octave ?? 4;
}

/** Inversion names by index; root position is unnamed because it is the default. */
const INVERSION_LABELS = ['', '1st', '2nd', '3rd'];

/** What the badge says about a chord's voicing, or '' in root position. */
function inversionLabel(segment: ChordSegment): string {
  return INVERSION_LABELS[segment.inversion ?? 0] ?? '';
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
  const isCustom = segment.kind === 'custom';

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
      // Delete is deliberately absent: it follows the selection, not focus, and is
      // handled once for the whole selection in `useSegmentShortcuts`.
    }
  };

  return (
    <div
      data-chord-block={segment.id}
      data-testid={`chord-block-${segment.id}`}
      role="button"
      tabIndex={0}
      aria-label={
        isNote
          ? `Note ${primaryLabel(segment)}`
          : isCustom
            ? `Recorded ${primaryLabel(segment)}`
            : `Chord ${primaryLabel(segment)} octave ${chordOctave(segment)}${
                inversionLabel(segment) ? ` ${inversionLabel(segment)} inversion` : ''
              }`
      }
      onKeyDown={handleKeyDown}
      // Selection happens here rather than on click. A click is dispatched on the
      // nearest common ancestor of the press and the release, so any re-render that
      // moves this node between the two — a drag preview reordering the lane, say —
      // retargets the click to the lane and the block never hears it.
      onPointerDown={e => {
        e.stopPropagation();
        onMoveStart?.(e);
      }}
      // Spans exactly its own beats, so a block covers the same span as the notes
      // it generates in the piano roll below. A block may be longer than the bar
      // that holds it, in which case it simply reaches past the bar line — which is
      // why it carries a z-index even when idle: the next bar is a later sibling,
      // and would otherwise paint its lane straight over the overhanging tail.
      style={{
        left: `${startBeat * pixelsPerBeat}px`,
        width: `${segment.duration * pixelsPerBeat}px`,
        // One declaration rather than three utility classes, so the three states
        // cannot depend on the order Tailwind happens to emit them in.
        zIndex: isDragging ? 20 : isSelected ? 10 : 1,
      }}
      className={`
        absolute top-0 bottom-0 flex flex-col items-center justify-center overflow-hidden
        rounded-md select-none border transition-colors
        ${isDragging ? 'cursor-grabbing opacity-80' : 'cursor-grab'}
        ${isSelected ? 'ring-2 ring-indigo-400' : ''}
        ${isNote
          ? 'bg-teal-800 border-teal-600 text-teal-50'
          : isCustom
            ? 'bg-amber-800 border-amber-600 text-amber-50'
            : 'bg-indigo-800 border-indigo-600 text-indigo-50'}
      `}
    >
      <span className="text-sm font-semibold leading-tight truncate px-1">
        {primaryLabel(segment)}
      </span>
      {segment.romanNumeral && (
        <span className="text-[10px] opacity-70 leading-tight">{segment.romanNumeral}</span>
      )}

      {/* One bar can hold blocks from several registers and voicings, so a chord
          states its own. A note needs no badge — its label already ends in the
          octave, and a single pitch has no inversion. Nor does a recorded block:
          every pitch in it is absolute, so there is no one register to name. */}
      {!isNote && !isCustom && (
        <span
          data-testid={`octave-badge-${segment.id}`}
          className="absolute bottom-0 left-1 text-[9px] opacity-60 leading-none pb-0.5"
        >
          oct {chordOctave(segment)}
          {inversionLabel(segment) && ` · ${inversionLabel(segment)}`}
        </span>
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
