import { useEffect, useRef, useCallback } from 'react';
import type { Bar, Note } from '@/types/music';
import {
  beatToPixel,
  pitchToPixel,
} from '@/engine/quantize';

export interface NoteCanvasConfig {
  width: number;
  height: number;
  pixelsPerBeat: number;
  pixelsPerOctave: number;
  gridSize: number;
  bars: Bar[];
  selectedBarId: string;
  notes: Note[];
  playheadBeat: number;
  colors: {
    gridLine: string;
    barLine: string;
    activeBar: string;
    noteFill: string;
    noteStroke: string;
    playhead: string;
    blackKey: string;
    whiteKey: string;
    pitchLabel: string;
  };
  minMidiNote: number;
  maxMidiNote: number;
  pianoRollWidth: number;
  timelineStart: number;
}

export function renderPianoRoll(
  ctx: CanvasRenderingContext2D,
  config: NoteCanvasConfig
): void {
  const {
    width,
    height,
  } = config;

  ctx.clearRect(0, 0, width, height);

  drawPianoKeys(ctx, config);
  drawGrid(ctx, config);
  drawBars(ctx, config);
  drawNotes(ctx, config);
  drawPlayhead(ctx, config);
}

function drawPianoKeys(
  ctx: CanvasRenderingContext2D,
  config: NoteCanvasConfig
): void {
  const {
    pianoRollWidth,
    pixelsPerOctave,
    minMidiNote,
    maxMidiNote,
    colors,
  } = config;

  const semitonesPerOctave = 12;
  const pixelsPerSemitone = pixelsPerOctave / semitonesPerOctave;

  for (let midi = minMidiNote; midi <= maxMidiNote; midi++) {
    const y = pitchToPixel(midi, pixelsPerOctave);
    const noteHeight = pixelsPerSemitone;
    const isBlackKey = [1, 3, 6, 8, 10].includes(midi % 12);

    ctx.fillStyle = isBlackKey ? colors.blackKey : colors.whiteKey;
    ctx.fillRect(0, y, pianoRollWidth, noteHeight);

    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(0, y, pianoRollWidth, noteHeight);
  }
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  config: NoteCanvasConfig
): void {
  const {
    width,
    height,
    pixelsPerBeat,
    pixelsPerOctave,
    bars,
    pianoRollWidth,
    timelineStart,
    colors,
  } = config;

  const semitonesPerOctave = 12;
  const pixelsPerSemitone = pixelsPerOctave / semitonesPerOctave;
  void semitonesPerOctave;
  void pixelsPerSemitone;

  ctx.strokeStyle = colors.gridLine;
  ctx.lineWidth = 0.5;

  for (let midi = Math.floor(config.minMidiNote); midi <= Math.ceil(config.maxMidiNote); midi++) {
    const y = pitchToPixel(midi, pixelsPerOctave);
    ctx.beginPath();
    ctx.moveTo(pianoRollWidth, y);
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

  ctx.strokeStyle = colors.barLine;
  ctx.lineWidth = 1;
  for (let barIndex = 0; barIndex <= bars.length; barIndex++) {
    const barStartBeat = barIndex * 4;
    const x = timelineStart + beatToPixel(barStartBeat, pixelsPerBeat);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
}

function drawBars(
  ctx: CanvasRenderingContext2D,
  config: NoteCanvasConfig
): void {
  const {
    bars,
    selectedBarId,
    pixelsPerBeat,
    height,
    timelineStart,
    colors,
  } = config;

  for (const bar of bars) {
    if (bar.id !== selectedBarId) continue;

    const barStartBeat = bar.barIndex * 4;
    const x = timelineStart + beatToPixel(barStartBeat, pixelsPerBeat);
    const barWidth = 4 * pixelsPerBeat;

    ctx.fillStyle = colors.activeBar;
    ctx.fillRect(x, 0, barWidth, height);
  }
}

function drawNotes(
  ctx: CanvasRenderingContext2D,
  config: NoteCanvasConfig
): void {
  const {
    notes,
    pixelsPerBeat,
    pixelsPerOctave,
    timelineStart,
    colors,
  } = config;

  for (const note of notes) {
    const x = timelineStart + beatToPixel(note.startBeat, pixelsPerBeat);
    const y = pitchToPixel(note.pitch, pixelsPerOctave);
    const noteWidth = beatToPixel(note.duration, pixelsPerBeat);
    const noteHeight = pixelsPerOctave / 12;

    ctx.fillStyle = colors.noteFill;
    ctx.fillRect(x, y, Math.max(noteWidth, 2), noteHeight - 1);

    ctx.strokeStyle = colors.noteStroke;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, Math.max(noteWidth, 2), noteHeight - 1);
  }
}

function drawPlayhead(
  ctx: CanvasRenderingContext2D,
  config: NoteCanvasConfig
): void {
  const {
    playheadBeat,
    pixelsPerBeat,
    height,
    timelineStart,
    colors,
  } = config;

  const x = timelineStart + beatToPixel(playheadBeat, pixelsPerBeat);

  ctx.strokeStyle = colors.playhead;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();
}

export function NoteCanvas({
  config,
}: {
  config: NoteCanvasConfig;
}): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    renderPianoRoll(ctx, config);
  }, [config]);

  useEffect(() => {
    render();
  }, [render]);

  return (
    <canvas
      ref={canvasRef}
      width={config.width}
      height={config.height}
      style={{
        width: '100%',
        height: '100%',
        display: 'block',
      }}
    />
  );
}
