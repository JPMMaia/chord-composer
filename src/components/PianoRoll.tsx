import { useRef, useEffect, useCallback, useMemo } from 'react';
import type { Bar, Note, TimeSignature } from '@/types/music';
import {
  snapToGrid,
  beatToPixel,
  pixelToBeat,
  pitchToPixel,
  pixelToPitch,
  pitchRangeHeight,
} from '@/engine/quantize';
import { midiToNoteLabel } from '@/engine/chords';
import { isNoteInScale } from '@/engine/scales';
import { getBarBeats, getBarStartBeat, getTotalBeats } from '@/engine/timeline';
import {
  BAR_LINE_WIDTH,
  PIANO_KEYS_WIDTH,
  PIANO_ROLL_MAX_MIDI,
  PIANO_ROLL_MIN_MIDI,
} from '@/utils/constants';

export interface PianoRollProps {
  bars: Bar[];
  selectedBarId: string;
  playheadBeat: number;
  pixelsPerBeat: number;
  pixelsPerOctave: number;
  gridSize: number;
  /** Project meter, used for any bar that does not carry one of its own. */
  timeSignature: TimeSignature;
  /**
   * Shared horizontal scroll offset in pixels, from the editor's one scrollbar.
   *
   * The keyboard is painted into this canvas rather than being a DOM element, so
   * the roll cannot live in a DOM scroller without the keys sliding away. It draws
   * at an offset instead, which also keeps the canvas viewport-sized rather than
   * as wide as the whole project.
   */
  scrollLeft?: number;
  /** Called when a horizontal wheel gesture over the grid should move the shared offset. */
  onScrollLeftChange?: (scrollLeft: number) => void;
  /** Optional: the roll is a read-only view of the derived notes unless supplied. */
  onNoteClick?: (barId: string, pitch: number, beat: number) => void;
  onNoteDrag?: (noteId: string, durationDelta: number) => void;
}

/**
 * A note placed on the roll's timeline.
 *
 * `Note.startBeat` is measured from the start of its own bar, but the roll's x axis
 * is the whole project — the same absolute-beat space the grid, bar lines and
 * playhead use. Resolving that offset once here keeps drawing and hit-testing from
 * disagreeing about where a note is.
 */
interface PositionedNote {
  note: Note;
  barId: string;
  /** Beats from the start of the project. */
  absoluteBeat: number;
  isInSelectedBar: boolean;
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
  // Notes outside the selected bar stay visible for context but are muted, so it is
  // still obvious which bar an edit would land in.
  inactiveNoteFill: 'rgba(59, 130, 246, 0.3)',
  inactiveNoteStroke: 'rgba(37, 99, 235, 0.45)',
  playhead: '#ef4444',
  // Dark enough to read as a black key, and to carry a light label — the roll
  // names every key, so the two key faces need genuinely different contrast.
  blackKey: '#2b2b2b',
  blackKeyLabel: '#b0b0b0',
  whiteKey: '#fafafa',
  whiteKeyLabel: '#555555',
  /** C rows, drawn bold so octaves stay findable while scrolling. */
  octaveLabel: '#1a1a1a',
};

/** Below this row height a key name would overlap its neighbours, so it is dropped. */
const MIN_LABEL_ROW_HEIGHT = 8;

export function PianoRoll({
  bars,
  selectedBarId,
  playheadBeat,
  pixelsPerBeat,
  pixelsPerOctave,
  gridSize,
  timeSignature,
  scrollLeft = 0,
  onScrollLeftChange,
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
  const hasCentredRef = useRef(false);
  // The wheel listener is installed once, so it reads the live offset from a ref
  // rather than closing over a stale one.
  const scrollLeftRef = useRef(scrollLeft);
  scrollLeftRef.current = scrollLeft;

  /** Height of the full key bed — the canvas is this tall and the container scrolls it. */
  const contentHeight = useMemo(() => pitchRangeHeight(pixelsPerOctave), [pixelsPerOctave]);

  const selectedBar = useMemo(
    () => bars.find((b) => b.id === selectedBarId),
    [bars, selectedBarId]
  );

  /** Every note in the project, placed on the shared absolute-beat axis. */
  const positionedNotes = useMemo<PositionedNote[]>(
    () =>
      bars.flatMap((bar, index) => {
        const barStartBeat = getBarStartBeat(bars, index, timeSignature);
        return bar.notes.map((note) => ({
          note,
          barId: bar.id,
          absoluteBeat: barStartBeat + note.startBeat,
          isInSelectedBar: bar.id === selectedBarId,
        }));
      }),
    [bars, selectedBarId, timeSignature]
  );

  /** Only the selected bar's notes respond to clicks and drags. */
  const selectedBarNotes = useMemo(
    () => positionedNotes.filter((p) => p.isInSelectedBar),
    [positionedNotes]
  );

  const selectedBarStartBeat = useMemo(() => {
    if (!selectedBar) return 0;
    return getBarStartBeat(bars, bars.indexOf(selectedBar), timeSignature);
  }, [bars, selectedBar, timeSignature]);

  const scale = useMemo(() => {
    if (!selectedBar) return null;
    return selectedBar.scale;
  }, [selectedBar]);

  const render = useCallback(
    (ctx: CanvasRenderingContext2D, width: number, height: number) => {
      ctx.clearRect(0, 0, width, height);
      // Beat 0 sits just past the key column, pulled left by the shared scroll.
      const timelineStart = PIANO_KEYS_WIDTH - scrollLeft;

      const semitonesPerOctave = 12;
      const pixelsPerSemitone = pixelsPerOctave / semitonesPerOctave;
      const minMidiNote = PIANO_ROLL_MIN_MIDI;
      const maxMidiNote = PIANO_ROLL_MAX_MIDI;
      const showLabels = pixelsPerSemitone >= MIN_LABEL_ROW_HEIGHT;

      for (let midi = minMidiNote; midi <= maxMidiNote; midi++) {
        const y = pitchToPixel(midi, pixelsPerOctave);
        const noteHeight = pixelsPerSemitone;
        const isBlackKey = [1, 3, 6, 8, 10].includes(midi % 12);
        const isOctaveStart = midi % 12 === 0;

        ctx.fillStyle = isBlackKey ? DEFAULT_COLORS.blackKey : DEFAULT_COLORS.whiteKey;
        ctx.fillRect(0, y, PIANO_KEYS_WIDTH, noteHeight);

        ctx.strokeStyle = '#ccc';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(0, y, PIANO_KEYS_WIDTH, noteHeight);

        // Every key is named, not just the Cs — with 88 rows in view a bare
        // keyboard gives no way to tell which one you are aiming at.
        if (showLabels) {
          ctx.fillStyle = isBlackKey
            ? DEFAULT_COLORS.blackKeyLabel
            : isOctaveStart
              ? DEFAULT_COLORS.octaveLabel
              : DEFAULT_COLORS.whiteKeyLabel;
          ctx.font = isOctaveStart ? 'bold 9px monospace' : '8px monospace';
          ctx.fillText(midiToNoteLabel(midi), 4, y + pixelsPerSemitone - 2);
        }
      }

      // Everything from here on is drawn in the scrolled beat axis, so it is
      // clipped to the area right of the keys — otherwise a bar line scrolled
      // past beat 0 would paint straight over the keyboard.
      ctx.save();
      ctx.beginPath();
      ctx.rect(PIANO_KEYS_WIDTH, 0, Math.max(0, width - PIANO_KEYS_WIDTH), height);
      ctx.clip();

      ctx.strokeStyle = DEFAULT_COLORS.gridLine;
      ctx.lineWidth = 0.5;

      for (let midi = minMidiNote; midi <= maxMidiNote; midi++) {
        const y = pitchToPixel(midi, pixelsPerOctave);
        ctx.beginPath();
        ctx.moveTo(PIANO_KEYS_WIDTH, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      const totalBeats = getTotalBeats(bars, timeSignature);
      for (let beat = 0; beat <= totalBeats; beat++) {
        const x = timelineStart + beatToPixel(beat, pixelsPerBeat);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }

      // Bar lines sit at accumulated bar starts — bars need not share a metre —
      // plus a closing line at the end of the last bar. Filled rather than stroked
      // so they land on the same pixels as the timeline's, which draws its own as
      // `BAR_LINE_WIDTH` overlays starting at the bar: a centred stroke would
      // straddle the boundary and read as a pixel of misalignment between the panes.
      ctx.fillStyle = DEFAULT_COLORS.barLine;
      const lastX = timelineStart + beatToPixel(totalBeats, pixelsPerBeat) - BAR_LINE_WIDTH;
      for (let barIndex = 0; barIndex <= bars.length; barIndex++) {
        const barStartBeat = getBarStartBeat(bars, barIndex, timeSignature);
        const x = timelineStart + beatToPixel(barStartBeat, pixelsPerBeat);
        // The closing line is pulled inside the last bar, exactly as the timeline's
        // is, so the project still ends at `totalBeats * pixelsPerBeat`.
        ctx.fillRect(Math.min(x, lastX), 0, BAR_LINE_WIDTH, height);
      }

      if (selectedBar) {
        const selectedIndex = bars.indexOf(selectedBar);
        const barStartBeat = getBarStartBeat(bars, selectedIndex, timeSignature);
        const x = timelineStart + beatToPixel(barStartBeat, pixelsPerBeat);
        const barWidth = getBarBeats(selectedBar, timeSignature) * pixelsPerBeat;

        ctx.fillStyle = DEFAULT_COLORS.activeBar;
        ctx.fillRect(x, 0, barWidth, height);
      }

      // Every bar's notes are drawn, not just the selected one's. The selected bar
      // goes last so its notes sit above any that overlap them.
      const drawNote = ({ note, absoluteBeat, isInSelectedBar }: PositionedNote) => {
        const x = timelineStart + beatToPixel(absoluteBeat, pixelsPerBeat);
        const y = pitchToPixel(note.pitch, pixelsPerOctave);
        const noteWidth = Math.max(beatToPixel(note.duration, pixelsPerBeat), 2);
        const noteHeight = pixelsPerOctave / 12;

        ctx.fillStyle = isInSelectedBar
          ? DEFAULT_COLORS.noteFill
          : DEFAULT_COLORS.inactiveNoteFill;
        ctx.fillRect(x, y, noteWidth, noteHeight - 1);

        ctx.strokeStyle = isInSelectedBar
          ? DEFAULT_COLORS.noteStroke
          : DEFAULT_COLORS.inactiveNoteStroke;
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, noteWidth, noteHeight - 1);
      };

      for (const positioned of positionedNotes) {
        if (!positioned.isInSelectedBar) drawNote(positioned);
      }
      for (const positioned of positionedNotes) {
        if (positioned.isInSelectedBar) drawNote(positioned);
      }

      const playheadX = timelineStart + beatToPixel(playheadBeat, pixelsPerBeat);
      ctx.strokeStyle = DEFAULT_COLORS.playhead;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, height);
      ctx.stroke();

      ctx.restore();
    },
    [
      bars,
      selectedBar,
      positionedNotes,
      pixelsPerBeat,
      pixelsPerOctave,
      playheadBeat,
      timeSignature,
      scrollLeft,
    ]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const sizeAndRender = () => {
      canvas.width = container.clientWidth;
      // The canvas is as tall as the whole 88-key range and the container
      // scrolls over it, rather than the canvas being cropped to the viewport.
      canvas.height = contentHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        render(ctx, canvas.width, canvas.height);
      }
    };

    const resizeObserver = new ResizeObserver(sizeAndRender);
    resizeObserver.observe(container);
    sizeAndRender();

    return () => {
      resizeObserver.disconnect();
    };
  }, [render, contentHeight]);

  // Open on the register people actually write in. Runs once: after that the
  // scroll position is the user's, and re-centring would fight them.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || hasCentredRef.current) return;
    if (container.clientHeight === 0) return;

    hasCentredRef.current = true;
    const middleC = pitchToPixel(60, pixelsPerOctave);
    const maxScroll = Math.max(0, contentHeight - container.clientHeight);
    container.scrollTop = Math.min(
      maxScroll,
      Math.max(0, middleC - container.clientHeight / 2)
    );
  }, [contentHeight, pixelsPerOctave]);

  /**
   * Horizontal wheel and trackpad gestures move the shared offset; plain vertical
   * scrolling is left to the container, which owns the pitch axis.
   *
   * A native listener rather than React's `onWheel`, because React registers wheel
   * handlers passively at the root and `preventDefault` there is ignored — the page
   * would scroll sideways as well as the roll.
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !onScrollLeftChange) return;

    const handleWheel = (e: WheelEvent) => {
      const delta = e.deltaX !== 0 ? e.deltaX : e.shiftKey ? e.deltaY : 0;
      if (delta === 0) return;

      e.preventDefault();
      onScrollLeftChange(scrollLeftRef.current + delta);
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [onScrollLeftChange]);

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

  /** The selected bar's note under a canvas point, if any. */
  const noteAt = useCallback(
    (x: number, y: number): PositionedNote | undefined =>
      selectedBarNotes.find(({ note, absoluteBeat }) => {
        const noteX = PIANO_KEYS_WIDTH - scrollLeft + beatToPixel(absoluteBeat, pixelsPerBeat);
        const noteY = pitchToPixel(note.pitch, pixelsPerOctave);
        const noteWidth = beatToPixel(note.duration, pixelsPerBeat);
        const noteHeight = pixelsPerOctave / 12;

        return (
          x >= noteX && x <= noteX + noteWidth && y >= noteY && y <= noteY + noteHeight
        );
      }),
    [selectedBarNotes, pixelsPerBeat, pixelsPerOctave, scrollLeft]
  );

  const beginDrag = useCallback((hit: PositionedNote, x: number, y: number) => {
    dragStateRef.current = {
      isDragging: true,
      startX: x,
      startY: y,
      initialBeat: hit.note.startBeat,
      initialPitch: hit.note.pitch,
      noteId: hit.note.id,
    };
  }, []);

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (x < PIANO_KEYS_WIDTH) return;

      const beat = pixelToBeat(x - PIANO_KEYS_WIDTH + scrollLeft, pixelsPerBeat);
      const snappedBeat = snapToGrid(beat, gridSize);
      // Ceil, not round: a key row is anchored at its top edge and pitch
      // descends down the screen, so the row a click lands in is the ceiling.
      const pitch = Math.ceil(pixelToPitch(y, pixelsPerOctave));

      const hit = noteAt(x, y);
      if (hit) {
        beginDrag(hit, x, y);
        return;
      }

      if (scale) {
        const pitchClass = pitch % 12;
        if (!isNoteInScale(pitchClass, scale)) {
          return;
        }
      }

      if (!selectedBar || !selectedBarId) return;

      // The click arrives in absolute beats but a Note stores its position relative
      // to its own bar, so convert before handing it over. A click outside the
      // selected bar is dropped rather than folded into it as an out-of-range beat.
      const beatInBar = snappedBeat - selectedBarStartBeat;
      if (beatInBar < 0 || beatInBar >= getBarBeats(selectedBar, timeSignature)) return;

      onNoteClick?.(selectedBarId, pitch, beatInBar);
    },
    [
      pixelsPerBeat,
      pixelsPerOctave,
      gridSize,
      scrollLeft,
      scale,
      selectedBar,
      selectedBarId,
      selectedBarStartBeat,
      timeSignature,
      noteAt,
      beginDrag,
      onNoteClick,
    ]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (x < PIANO_KEYS_WIDTH) return;

      const hit = noteAt(x, y);
      if (hit) {
        beginDrag(hit, x, y);
      }
    },
    [noteAt, beginDrag]
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
    <div
      ref={containerRef}
      data-testid="piano-roll-scroll"
      className="w-full h-full relative overflow-y-auto"
    >
      <canvas
        ref={canvasRef}
        onClick={handleCanvasClick}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        style={{
          width: '100%',
          height: `${contentHeight}px`,
          display: 'block',
          cursor: 'crosshair',
        }}
      />
    </div>
  );
}
