import React, { useRef, useEffect, useCallback } from 'react';
import type { Bar, ChordSegment } from '@/types/music';

interface TimelineProps {
  bars: Bar[];
  selectedBarId: string | null;
  pixelsPerBeat: number;
  onBarSelect: (barId: string) => void;
  onBarRemove: (barId: string) => void;
  onBarAddAfter?: (barId: string) => void;
}

/**
 * Horizontal scrollable timeline showing bar headers with chord blocks.
 */
export const Timeline: React.FC<TimelineProps> = ({
  bars,
  selectedBarId,
  pixelsPerBeat,
  onBarSelect,
  onBarRemove,
  onBarAddAfter,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scroll to the selected bar when it changes
  useEffect(() => {
    if (selectedBarId && scrollRef.current) {
      const selectedEl = scrollRef.current.querySelector(
        `[data-bar-id="${selectedBarId}"]`
      ) as HTMLElement | null;
      selectedEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }, [selectedBarId]);

  const handleAddBar = useCallback(
    (barId: string) => {
      onBarAddAfter?.(barId);
    },
    [onBarAddAfter]
  );

  return (
    <div
      ref={scrollRef}
      className="h-28 bg-gray-800 border-b border-gray-700 overflow-x-auto overflow-y-hidden"
    >
      <div className="flex items-stretch h-full" style={{ minWidth: 'max-content' }}>
        {bars.map((bar, index) => {
          const barWidth = bar.chords.length > 0
            ? bar.chords.reduce((sum, c) => sum + c.duration, 0) * pixelsPerBeat
            : 4 * pixelsPerBeat;

          return (
            <div
              key={bar.id}
              data-bar-id={bar.id}
              className={`flex flex-col border-r border-gray-700 transition-colors ${
                selectedBarId === bar.id
                  ? 'bg-indigo-700'
                  : 'bg-gray-800 hover:bg-gray-700'
              }`}
              style={{ width: `${Math.max(barWidth, 80)}px` }}
            >
              {/* Bar header */}
              <div className="flex items-center justify-between px-2 py-1 border-b border-gray-600">
                <button
                  onClick={() => onBarSelect(bar.id)}
                  className="text-xs font-semibold text-gray-200 hover:text-white transition-colors"
                >
                  Bar {index + 1}
                </button>
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-gray-400">
                    {bar.scale.root} {bar.scale.type.includes('Minor') ? 'm' : bar.scale.type.includes('Major') ? 'M' : ''}
                  </span>
                  {onBarAddAfter && (
                    <button
                      onClick={() => handleAddBar(bar.id)}
                      className="text-gray-500 hover:text-indigo-400 transition-colors text-xs"
                      aria-label={`Add bar after Bar ${index + 1}`}
                      title="Add bar after"
                    >
                      +
                    </button>
                  )}
                  <button
                    onClick={() => onBarRemove(bar.id)}
                    className="text-gray-500 hover:text-red-400 transition-colors text-xs"
                    aria-label={`Remove Bar ${index + 1}`}
                    title="Remove bar"
                  >
                    ✕
                  </button>
                </div>
              </div>

              {/* Chord blocks */}
              <div className="flex-1 flex items-stretch p-1 gap-0.5">
                {bar.chords.length > 0 ? (
                  bar.chords.map(chord => (
                    <ChordBlock key={chord.id} chord={chord} pixelsPerBeat={pixelsPerBeat} />
                  ))
                ) : (
                  <div className="flex-1 flex items-center justify-center text-xs text-gray-600 italic">
                    No chords
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* Add bar button at end */}
        {onBarAddAfter && (
          <button
            onClick={() => onBarAddAfter(bars[bars.length - 1]?.id ?? '')}
            className="flex items-center justify-center px-3 py-2 text-indigo-400 hover:bg-gray-700 transition-colors border-l border-gray-700"
            aria-label="Add bar at end"
            title="Add bar at end"
          >
            +
          </button>
        )}
      </div>
    </div>
  );
};

interface ChordBlockProps {
  chord: ChordSegment;
  pixelsPerBeat: number;
}

/**
 * Individual chord block within the timeline.
 */
const ChordBlock: React.FC<ChordBlockProps> = ({ chord, pixelsPerBeat }) => {
  const width = chord.duration * pixelsPerBeat;
  const displayWidth = Math.max(width, 40);

  const label = chord.romanNumeral || chord.chordSymbol || '?';

  return (
    <div
      className="flex-shrink-0 bg-indigo-600 hover:bg-indigo-500 text-white text-xs rounded px-1 py-0.5 flex items-center justify-center overflow-hidden transition-colors cursor-pointer"
      style={{ width: `${displayWidth}px` }}
      title={`${label} (${chord.duration} beat${chord.duration !== 1 ? 's' : ''})`}
    >
      <span className="truncate">{label}</span>
    </div>
  );
};
