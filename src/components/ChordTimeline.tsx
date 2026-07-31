import React, { useState } from 'react';
import type { Bar, TimeSignature } from '@/types/music';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { beatToInsertIndex, getBarBeats } from '@/engine/timeline';
import { paletteItemToSegment, type PaletteItem } from '@/engine/palette';
import { PALETTE_DRAG_TYPE } from '@/components/ScalePalette';
import { ChordSegmentBlock } from '@/components/ChordSegmentBlock';
import { PIANO_KEYS_WIDTH } from '@/utils/constants';

/** Horizontal zoom of the timeline. A beat is this many pixels wide. */
export const PIXELS_PER_BEAT = 80;

/** Beats a freshly dropped block occupies before the user resizes it. */
const DROP_DURATION_BEATS = 1;

/** Meters offered per bar. */
const TIME_SIGNATURES: TimeSignature[] = [
  { beatsPerMeasure: 2, beatUnit: 4 },
  { beatsPerMeasure: 3, beatUnit: 4 },
  { beatsPerMeasure: 4, beatUnit: 4 },
  { beatsPerMeasure: 5, beatUnit: 4 },
  { beatsPerMeasure: 6, beatUnit: 8 },
  { beatsPerMeasure: 7, beatUnit: 8 },
  { beatsPerMeasure: 12, beatUnit: 8 },
];

function formatTs(ts: TimeSignature): string {
  return `${ts.beatsPerMeasure}/${ts.beatUnit}`;
}

function parseTs(value: string): TimeSignature {
  const [beatsPerMeasure, beatUnit] = value.split('/').map(Number);
  return { beatsPerMeasure, beatUnit };
}

/**
 * The chord area: every bar of the project laid out on one scrollable horizontal
 * timeline, with bar lines, beat gridlines and per-bar meters.
 *
 * Segments are positioned by accumulating durations within their bar; the store's
 * reflow guarantees they always fit, so nothing here has to handle overflow.
 */
export const ChordTimeline: React.FC = () => {
  const project = projectStore(s => s.project);
  const insertSegment = projectStore(s => s.insertSegment);
  const removeSegment = projectStore(s => s.removeSegment);
  const moveSegment = projectStore(s => s.moveSegment);
  const resizeSegmentDuration = projectStore(s => s.resizeSegmentDuration);
  const setBarTimeSignature = projectStore(s => s.setBarTimeSignature);

  const selectedBarId = selectionStore(s => s.selectedBarId);
  const selectedSegmentId = selectionStore(s => s.selectedSegmentId);
  const selectBar = selectionStore(s => s.selectBar);
  const selectSegment = selectionStore(s => s.selectSegment);

  /** Where the insertion caret sits while a palette block hovers, in flat index terms. */
  const [dropIndicator, setDropIndicator] = useState<{ barId: string; beat: number } | null>(null);

  if (!project) return null;

  const { bars, timeSignature: projectTs } = project;

  /** Index of a bar's first segment in the flat, cross-bar segment list. */
  const flatOffset = (barIndex: number): number =>
    bars.slice(0, barIndex).reduce((n, b) => n + b.chords.length, 0);

  /** Beats from the start of a lane to the pointer. */
  const beatAt = (e: React.DragEvent<HTMLDivElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    const beat = (e.clientX - rect.left) / PIXELS_PER_BEAT;
    // A drag with no usable coordinate lands at the bar's start rather than
    // poisoning the insert index with NaN.
    return Number.isFinite(beat) ? Math.max(0, beat) : 0;
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>, bar: Bar) => {
    // Without this the browser refuses the drop outright.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropIndicator({ barId: bar.id, beat: beatAt(e) });
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>, bar: Bar, barIndex: number) => {
    e.preventDefault();
    setDropIndicator(null);

    const raw = e.dataTransfer.getData(PALETTE_DRAG_TYPE);
    if (!raw) return;

    let item: PaletteItem;
    try {
      item = JSON.parse(raw) as PaletteItem;
    } catch {
      // A foreign drag landed here; ignore it rather than corrupting the timeline.
      return;
    }

    const index = flatOffset(barIndex) + beatToInsertIndex(bar.chords, beatAt(e));
    insertSegment(index, paletteItemToSegment(item, DROP_DURATION_BEATS));
    selectBar(bar.id);
  };

  return (
    <div
      data-testid="chord-timeline"
      // shrink-0 keeps the lanes at their natural height when the piano roll
      // below competes for space in the column.
      className="shrink-0 flex items-stretch bg-gray-900 border-b border-gray-700"
      onDragLeave={() => setDropIndicator(null)}
    >
      {/* Matches the piano roll's key column, so bar 1 starts where its grid
          does. It sits outside the scroll container for the same reason that
          column does: it must not slide away when the timeline scrolls. */}
      <div
        data-testid="timeline-gutter"
        style={{ width: `${PIANO_KEYS_WIDTH}px` }}
        className="shrink-0 bg-gray-800 border-r border-gray-700"
      />

      <div data-testid="timeline-scroll" className="flex-1 overflow-x-auto">
        <div className="flex items-stretch min-w-max">
        {bars.map((bar, barIndex) => {
          const beats = getBarBeats(bar, projectTs);
          const width = beats * PIXELS_PER_BEAT;
          const offset = flatOffset(barIndex);
          const isSelectedBar = selectedBarId === bar.id;

          let cursorBeat = 0;

          return (
            <div
              key={bar.id}
              data-testid={`timeline-bar-${bar.id}`}
              style={{ width: `${width}px` }}
              // The heavy left rule is the bar line; the last bar closes with a
              // second one on its right.
              className={`shrink-0 border-l-2 border-gray-400 ${
                barIndex === bars.length - 1 ? 'border-r-2' : ''
              }`}
            >
              {/* Bar header */}
              <div
                className={`px-2 py-1 text-xs border-b border-gray-700 ${
                  isSelectedBar ? 'bg-indigo-900/50' : 'bg-gray-800'
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="font-medium text-gray-200">Bar {barIndex + 1}</span>
                  <select
                    aria-label={`Time signature for bar ${barIndex + 1}`}
                    value={formatTs(bar.timeSignature ?? projectTs)}
                    onChange={e => setBarTimeSignature(bar.id, parseTs(e.target.value))}
                    className="bg-gray-700 border border-gray-600 rounded text-gray-200 text-[10px] px-1 focus:outline-none focus:border-indigo-500"
                  >
                    {TIME_SIGNATURES.map(ts => (
                      <option key={formatTs(ts)} value={formatTs(ts)}>
                        {formatTs(ts)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="text-[10px] text-gray-400 truncate">
                  {bar.scale.root} {bar.scale.type.replace(/([A-Z])/g, ' $1').trim()}
                </div>
              </div>

              {/* Segment lane */}
              <div
                data-testid={`timeline-lane-${bar.id}`}
                onClick={() => selectBar(bar.id)}
                onDragOver={e => handleDragOver(e, bar)}
                onDrop={e => handleDrop(e, bar, barIndex)}
                className="relative h-20 bg-gray-900"
              >
                {/* Beat gridlines */}
                {Array.from({ length: beats }, (_, i) => (
                  <div
                    key={i}
                    data-testid="beat-line"
                    style={{ left: `${i * PIXELS_PER_BEAT}px` }}
                    className={`absolute top-0 bottom-0 w-px ${
                      i === 0 ? 'bg-transparent' : 'bg-gray-700'
                    }`}
                  />
                ))}

                {/* Insertion caret */}
                {dropIndicator?.barId === bar.id && (
                  <div
                    data-testid="drop-indicator"
                    style={{ left: `${dropIndicator.beat * PIXELS_PER_BEAT}px` }}
                    className="absolute top-0 bottom-0 w-0.5 bg-indigo-400 pointer-events-none"
                  />
                )}

                {bar.chords.map((segment, i) => {
                  const left = cursorBeat * PIXELS_PER_BEAT;
                  cursorBeat += segment.duration;
                  const flatIndex = offset + i;

                  return (
                    <div
                      key={segment.id}
                      style={{
                        position: 'absolute',
                        left: `${left}px`,
                        width: `${segment.duration * PIXELS_PER_BEAT}px`,
                        top: 0,
                        bottom: 0,
                      }}
                      className="p-0.5"
                    >
                      <ChordSegmentBlock
                        segment={segment}
                        isSelected={selectedSegmentId === segment.id}
                        pixelsPerBeat={PIXELS_PER_BEAT}
                        onSelect={id => {
                          // Bar first: selecting a new bar drops the segment selection.
                          selectBar(bar.id);
                          selectSegment(id);
                        }}
                        onRemove={removeSegment}
                        onResize={resizeSegmentDuration}
                        onMoveLeft={() => moveSegment(flatIndex, flatIndex - 1)}
                        onMoveRight={() => moveSegment(flatIndex, flatIndex + 1)}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        </div>
      </div>
    </div>
  );
};
