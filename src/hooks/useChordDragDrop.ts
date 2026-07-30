import { useCallback, useRef } from 'react';
import type { ChordSegment } from '@/types/music';
import { reorderChords } from '@/engine/chordOperations';

interface UseChordDragDropOptions {
  chords: ChordSegment[];
  onReorder: (chords: ChordSegment[]) => void;
  onSplit?: (chordCount: number) => void;
}

interface UseChordDragDropReturn {
  handleDragStart: (e: React.DragEvent, fromIndex: number) => void;
  handleDragOver: (e: React.DragEvent) => void;
  handleDrop: (e: React.DragEvent, toIndex: number) => void;
  handleTouchStart: (e: React.TouchEvent, index: number) => void;
  handleTouchMove: (e: React.TouchEvent) => void;
  handleTouchEnd: (e: React.TouchEvent, toIndex: number) => void;
}

/**
 * Hook for handling drag-and-drop reordering of chord blocks.
 * Supports both mouse and touch events.
 */
export function useChordDragDrop({
  chords,
  onReorder,
}: UseChordDragDropOptions): UseChordDragDropReturn {
  const dragIndex = useRef<number | null>(null);
  const touchStartY = useRef<number>(0);

  const handleDragStart = useCallback((e: React.DragEvent, fromIndex: number) => {
    dragIndex.current = fromIndex;
    e.dataTransfer.setData('text/plain', String(fromIndex));
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    const fromIndexStr = e.dataTransfer.getData('text/plain');
    const fromIndex = parseInt(fromIndexStr, 10);

    if (!isNaN(fromIndex) && fromIndex !== toIndex && fromIndex >= 0 && fromIndex < chords.length) {
      onReorder(reorderChords(chords, fromIndex, toIndex));
    }
    dragIndex.current = null;
  }, [chords, onReorder]);

  const handleTouchStart = useCallback((e: React.TouchEvent, index: number) => {
    dragIndex.current = index;
    touchStartY.current = e.touches[0].clientY;
  }, []);

  const handleTouchMove = useCallback((_e: React.TouchEvent) => {
    // Visual feedback could be added here
  }, []);

  const handleTouchEnd = useCallback((_e: React.TouchEvent, toIndex: number) => {
    const fromIndex = dragIndex.current;
    if (fromIndex !== null && fromIndex !== toIndex && fromIndex >= 0 && fromIndex < chords.length) {
      onReorder(reorderChords(chords, fromIndex, toIndex));
    }
    dragIndex.current = null;
  }, [chords, onReorder]);

  return {
    handleDragStart,
    handleDragOver,
    handleDrop,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  };
}
