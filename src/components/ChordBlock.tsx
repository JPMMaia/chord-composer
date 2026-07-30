import React from 'react';
import type { ChordSegment } from '@/types/music';

interface ChordBlockProps {
  chord: ChordSegment;
  isSelected: boolean;
  onSelect: (chordId: string) => void;
  onRemove: (chordId: string) => void;
  onMoveLeft?: () => void;
  onMoveRight?: () => void;
}

/**
 * Renders a single draggable chord block with Roman numeral and chord symbol.
 * Supports keyboard navigation (Arrow keys to reorder, Enter to select, Delete to remove).
 */
export const ChordBlock: React.FC<ChordBlockProps> = ({
  chord,
  isSelected,
  onSelect,
  onRemove,
  onMoveLeft,
  onMoveRight,
}) => {
  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRemove(chord.id);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'Enter':
        onSelect(chord.id);
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
        onRemove(chord.id);
        break;
    }
  };

  return (
    <div
      data-chord-block={chord.id}
      data-testid={`chord-block-${chord.id}`}
      onClick={() => onSelect(chord.id)}
      className={`
        relative flex flex-col items-center justify-center
        px-3 py-2 rounded-lg cursor-pointer select-none
        transition-all duration-150
        ${isSelected
          ? 'bg-indigo-600 text-white shadow-lg ring-2 ring-indigo-400'
          : 'bg-gray-700 text-gray-100 hover:bg-gray-600 hover:shadow-md'}
      `}
      role="button"
      aria-label={`Chord ${chord.romanNumeral}`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* Roman numeral */}
      <span className="text-lg font-bold leading-tight">
        {chord.romanNumeral}
      </span>
      {/* Chord symbol */}
      {chord.chordSymbol && (
        <span className="text-xs text-gray-300 mt-0.5">
          {chord.chordSymbol}
        </span>
      )}
      {/* Duration indicator */}
      <span className="text-[10px] text-gray-400 mt-1">
        {chord.duration} beat{chord.duration !== 1 ? 's' : ''}
      </span>
      {/* Remove button */}
      <button
        onClick={handleRemove}
        className="absolute -top-1 -right-1 w-5 h-5 flex items-center justify-center
                   bg-red-500 text-white text-xs rounded-full
                   hover:bg-red-600 opacity-0 group-hover:opacity-100
                   transition-opacity"
        aria-label="Remove chord"
        style={{ opacity: 0.7 }}
      >
        ×
      </button>
    </div>
  );
};
