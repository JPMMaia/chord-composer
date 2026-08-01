import { useRef, useCallback, useEffect } from 'react';
import type { Note } from '@/types/music';
import {
  snapToGrid,
  beatToPixel,
  pixelToBeat,
  pitchToPixel,
  pixelToPitch,
} from '@/engine/quantize';

export interface UsePianoRollOptions {
  pixelsPerBeat: number;
  pixelsPerOctave: number;
  gridSize: number;
  pianoRollWidth?: number;
  minMidiNote?: number;
  maxMidiNote?: number;
  onNoteClick?: (pitch: number, beat: number) => void;
  onNoteDrag?: (noteId: string, durationDelta: number) => void;
}

interface DragState {
  isDragging: boolean;
  startX: number;
  startY: number;
  initialBeat: number;
  initialPitch: number;
  noteId: string;
}

const DEFAULT_PIANO_ROLL_WIDTH = 80;

/**
 * Hook for handling piano roll canvas interactions.
 * Provides hit detection, drag handling, and coordinate conversion.
 */
export function usePianoRoll({
  pixelsPerBeat,
  pixelsPerOctave,
  gridSize,
  pianoRollWidth = DEFAULT_PIANO_ROLL_WIDTH,
  onNoteClick,
  onNoteDrag,
}: UsePianoRollOptions) {
  const dragStateRef = useRef<DragState>({
    isDragging: false,
    startX: 0,
    startY: 0,
    initialBeat: 0,
    initialPitch: 0,
    noteId: '',
  });

  const getCanvasCoords = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = e.currentTarget;
      const rect = canvas.getBoundingClientRect();
      return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
    },
    []
  );

  const hitTestNote = useCallback(
    (
      x: number,
      y: number,
      note: Note,
      barStartBeat: number
    ): boolean => {
      const noteX = pianoRollWidth + beatToPixel(note.startBeat + barStartBeat, pixelsPerBeat);
      const noteY = pitchToPixel(note.pitch, pixelsPerOctave);
      const noteWidth = beatToPixel(note.duration, pixelsPerBeat);
      const noteHeight = pixelsPerOctave / 12;

      return (
        x >= noteX &&
        x <= noteX + noteWidth &&
        y >= noteY &&
        y <= noteY + noteHeight
      );
    },
    [pixelsPerBeat, pixelsPerOctave, pianoRollWidth]
  );

  const handleCanvasClick = useCallback(
    (
      e: React.MouseEvent<HTMLCanvasElement>,
      notes: Note[],
      barStartBeat: number
    ) => {
      const { x, y } = getCanvasCoords(e);

      if (x < pianoRollWidth) return;

      const beat = pixelToBeat(x - pianoRollWidth, pixelsPerBeat);
      const snappedBeat = snapToGrid(beat, gridSize);
      // Ceil, not round: `pitchToPixel` anchors a row at its top edge and pitch
      // descends down the screen, so the row a pixel is inside is the ceiling.
      const pitch = Math.ceil(pixelToPitch(y, pixelsPerOctave));

      // Check if clicking on existing note
      for (const note of notes) {
        if (hitTestNote(x, y, note, barStartBeat)) {
          dragStateRef.current = {
            isDragging: true,
            startX: x,
            startY: y,
            initialBeat: note.startBeat,
            initialPitch: note.pitch,
            noteId: note.id,
          };
          return;
        }
      }

      // Place new note
      if (onNoteClick) {
        onNoteClick(pitch, snappedBeat);
      }
    },
    [getCanvasCoords, pixelsPerBeat, pixelsPerOctave, gridSize, pianoRollWidth, hitTestNote, onNoteClick]
  );

  const handleMouseDown = useCallback(
    (
      e: React.MouseEvent<HTMLCanvasElement>,
      notes: Note[],
      barStartBeat: number
    ) => {
      const { x, y } = getCanvasCoords(e);

      if (x < pianoRollWidth) return;

      for (const note of notes) {
        if (hitTestNote(x, y, note, barStartBeat)) {
          dragStateRef.current = {
            isDragging: true,
            startX: x,
            startY: y,
            initialBeat: note.startBeat,
            initialPitch: note.pitch,
            noteId: note.id,
          };
          return;
        }
      }
    },
    [getCanvasCoords, pixelsPerBeat, pixelsPerOctave, pianoRollWidth, hitTestNote]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const dragState = dragStateRef.current;
      if (!dragState.isDragging) return;

      const { x } = getCanvasCoords(e);

      dragStateRef.current = {
        ...dragState,
        startX: x,
      };
    },
    [getCanvasCoords, pixelsPerBeat, gridSize, pianoRollWidth]
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const dragState = dragStateRef.current;
      if (!dragState.isDragging) return;

      dragState.isDragging = false;

      const { x } = getCanvasCoords(e);

      const currentBeat = pixelToBeat(x - pianoRollWidth, pixelsPerBeat);
      const snappedBeat = snapToGrid(currentBeat, gridSize);

      const durationDelta = snappedBeat - dragState.initialBeat;

      if (onNoteDrag) {
        onNoteDrag(dragState.noteId, durationDelta);
      }
    },
    [getCanvasCoords, pixelsPerBeat, gridSize, pianoRollWidth, onNoteDrag]
  );

  // Reset drag state on cleanup
  useEffect(() => {
    return () => {
      dragStateRef.current.isDragging = false;
    };
  }, []);

  return {
    handleCanvasClick,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    hitTestNote,
    dragStateRef,
  };
}
