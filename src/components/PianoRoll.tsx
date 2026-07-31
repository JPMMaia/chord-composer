import { useRef, useEffect, useCallback, useMemo } from 'react';
import type { Bar } from '@/types/music';
import {
  snapToGrid,
  beatToPixel,
  pixelToBeat,
  pitchToPixel,
  pixelToPitch,
} from '@/engine/quantize';
import { isNoteInScale } from '@/engine/scales';

export interface PianoRollProps {
  bars: Bar[];
  selectedBarId: string;
  playheadBeat: number;
  pixelsPerBeat: number;
  pixelsPerOctave: number;
  gridSize: number;
  /** Optional: the roll is a read-only view of the derived notes unless supplied. */
  onNoteClick?: (barId: string, pitch: number, beat: number) => void;
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

const DEFAULT_COLORS = {
  gridLine: '#e5e5e5',
  barLine: '#cccccc',
  activeBar: 'rgba(59, 130, 246, 0.1)',
  noteFill: '#3b82f6',
  noteStroke: '#2563eb',
  playhead: '#ef4444',
  blackKey: '#f0f0f0',
  whiteKey: '#ffffff',
  pitchLabel: '#666666',
};

const PIANO_ROLL_WIDTH = 80;

export function PianoRoll({
  bars,
  selectedBarId,
  playheadBeat,
  pixelsPerBeat,
  pixelsPerOctave,
  gridSize,
  onNoteClick,
  onNoteDrag,
}: PianoRollProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<DragState>({
    isDragging: false,
    startX: 0,
    startY: 0,
    initialBeat: 0,
    initialPitch: 0,
    noteId: '',
  });
  const animationFrameRef = useRef<number>(0);

  const selectedBar = useMemo(
    () => bars.find((b) => b.id === selectedBarId),
    [bars, selectedBarId]
  );

  const selectedBarNotes = useMemo(() => {
    if (!selectedBar) return [];
    return selectedBar.notes;
  }, [selectedBar]);

  const scale = useMemo(() => {
    if (!selectedBar) return null;
    return selectedBar.scale;
  }, [selectedBar]);

  const render = useCallback(
    (ctx: CanvasRenderingContext2D, width: number, height: number) => {
      ctx.clearRect(0, 0, width, height);
      const timelineStart = PIANO_ROLL_WIDTH;

      const semitonesPerOctave = 12;
      const pixelsPerSemitone = pixelsPerOctave / semitonesPerOctave;
      const minMidiNote = 36;
      const maxMidiNote = 96;

      for (let midi = minMidiNote; midi <= maxMidiNote; midi++) {
        const y = pitchToPixel(midi, pixelsPerOctave);
        const noteHeight = pixelsPerSemitone;
        const isBlackKey = [1, 3, 6, 8, 10].includes(midi % 12);

        ctx.fillStyle = isBlackKey ? DEFAULT_COLORS.blackKey : DEFAULT_COLORS.whiteKey;
        ctx.fillRect(0, y, PIANO_ROLL_WIDTH, noteHeight);

        ctx.strokeStyle = '#ccc';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(0, y, PIANO_ROLL_WIDTH, noteHeight);

        if (midi % 12 === 0) {
          ctx.fillStyle = DEFAULT_COLORS.pitchLabel;
          ctx.font = '10px monospace';
          ctx.fillText(`C${Math.floor(midi / 12) - 1}`, 2, y + 10);
        }
      }

      ctx.strokeStyle = DEFAULT_COLORS.gridLine;
      ctx.lineWidth = 0.5;

      for (let midi = minMidiNote; midi <= maxMidiNote; midi++) {
        const y = pitchToPixel(midi, pixelsPerOctave);
        ctx.beginPath();
        ctx.moveTo(PIANO_ROLL_WIDTH, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      const totalBeats = bars.length * 4;
      for (let beat = 0; beat <= totalBeats; beat++) {
        const x = timelineStart + beatToPixel(beat, pixelsPerBeat);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }

      ctx.strokeStyle = DEFAULT_COLORS.barLine;
      ctx.lineWidth = 1;
      for (let barIndex = 0; barIndex <= bars.length; barIndex++) {
        const barStartBeat = barIndex * 4;
        const x = timelineStart + beatToPixel(barStartBeat, pixelsPerBeat);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }

      if (selectedBar) {
        const barStartBeat = selectedBar.barIndex * 4;
        const x = timelineStart + beatToPixel(barStartBeat, pixelsPerBeat);
        const barWidth = 4 * pixelsPerBeat;

        ctx.fillStyle = DEFAULT_COLORS.activeBar;
        ctx.fillRect(x, 0, barWidth, height);
      }

      for (const note of selectedBarNotes) {
        const x = timelineStart + beatToPixel(note.startBeat, pixelsPerBeat);
        const y = pitchToPixel(note.pitch, pixelsPerOctave);
        const noteWidth = beatToPixel(note.duration, pixelsPerBeat);
        const noteHeight = pixelsPerOctave / 12;

        ctx.fillStyle = DEFAULT_COLORS.noteFill;
        ctx.fillRect(x, y, Math.max(noteWidth, 2), noteHeight - 1);

        ctx.strokeStyle = DEFAULT_COLORS.noteStroke;
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, Math.max(noteWidth, 2), noteHeight - 1);
      }

      const playheadX = timelineStart + beatToPixel(playheadBeat, pixelsPerBeat);
      ctx.strokeStyle = DEFAULT_COLORS.playhead;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, height);
      ctx.stroke();
    },
    [bars, selectedBar, selectedBarNotes, pixelsPerBeat, pixelsPerOctave, playheadBeat]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const resizeObserver = new ResizeObserver(() => {
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        render(ctx, canvas.width, canvas.height);
      }
    });

    resizeObserver.observe(container);

    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      render(ctx, canvas.width, canvas.height);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, [render]);

  useEffect(() => {
    let running = true;

    const animate = () => {
      if (!running) return;

      const canvas = canvasRef.current;
      if (!canvas) {
        animationFrameRef.current = requestAnimationFrame(animate);
        return;
      }

      const ctx = canvas.getContext('2d');
      if (ctx && canvas.width > 0 && canvas.height > 0) {
        render(ctx, canvas.width, canvas.height);
      }

      animationFrameRef.current = requestAnimationFrame(animate);
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      running = false;
      cancelAnimationFrame(animationFrameRef.current);
    };
  }, [render]);

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (x < PIANO_ROLL_WIDTH) return;

      const beat = pixelToBeat(x - PIANO_ROLL_WIDTH, pixelsPerBeat);
      const snappedBeat = snapToGrid(beat, gridSize);
      const pitch = Math.round(pixelToPitch(y, pixelsPerOctave));

      for (const note of selectedBarNotes) {
        const noteX = PIANO_ROLL_WIDTH + beatToPixel(note.startBeat, pixelsPerBeat);
        const noteY = pitchToPixel(note.pitch, pixelsPerOctave);
        const noteWidth = beatToPixel(note.duration, pixelsPerBeat);
        const noteHeight = pixelsPerOctave / 12;

        if (
          x >= noteX &&
          x <= noteX + noteWidth &&
          y >= noteY &&
          y <= noteY + noteHeight
        ) {
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

      if (scale) {
        const pitchClass = pitch % 12;
        if (!isNoteInScale(pitchClass, scale)) {
          return;
        }
      }

      if (selectedBarId) {
        onNoteClick?.(selectedBarId, pitch, snappedBeat);
      }
    },
    [pixelsPerBeat, pixelsPerOctave, gridSize, scale, selectedBarId, selectedBarNotes, onNoteClick]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (x < PIANO_ROLL_WIDTH) return;

      for (const note of selectedBarNotes) {
        const noteX = PIANO_ROLL_WIDTH + beatToPixel(note.startBeat, pixelsPerBeat);
        const noteY = pitchToPixel(note.pitch, pixelsPerOctave);
        const noteWidth = beatToPixel(note.duration, pixelsPerBeat);
        const noteHeight = pixelsPerOctave / 12;

        if (
          x >= noteX &&
          x <= noteX + noteWidth &&
          y >= noteY &&
          y <= noteY + noteHeight
        ) {
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
    [pixelsPerBeat, pixelsPerOctave, selectedBarNotes]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const dragState = dragStateRef.current;
      if (!dragState.isDragging) return;

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;

      dragStateRef.current = {
        ...dragState,
        startX: x,
      };
    },
    []
  );

  const handleMouseUp = useCallback(
    (_e: React.MouseEvent<HTMLCanvasElement>) => {
      const dragState = dragStateRef.current;
      if (!dragState.isDragging) return;

      dragState.isDragging = false;
      onNoteDrag?.(dragState.noteId || '', 0);
    },
    [onNoteDrag]
  );

  return (
    <div ref={containerRef} className="w-full h-full relative">
      <canvas
        ref={canvasRef}
        onClick={handleCanvasClick}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          cursor: 'crosshair',
        }}
      />
    </div>
  );
}
