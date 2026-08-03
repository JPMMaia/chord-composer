import React, { useMemo, useState } from 'react';
import { getPaletteItems, type PaletteItem, type PaletteMode } from '@/engine/palette';
import { getScaleName } from '@/engine/scales';
import { ScaleSelect } from '@/components/ScaleSelect';
import { editorStore } from '@/store/editorStore';
import { MAX_SEGMENT_OCTAVE, MIN_SEGMENT_OCTAVE } from '@/utils/constants';

/** MIME type carrying the full palette item across a drag. */
export const PALETTE_DRAG_TYPE = 'application/x-palette-item';

const MODE_LABELS: Record<PaletteMode, string> = {
  notes: 'Notes',
  chords: 'Chords',
  sevenths: 'Seventh Chords',
};

/** Octaves offered for new blocks — the same registers a segment may be moved to. */
const OCTAVES = Array.from(
  { length: MAX_SEGMENT_OCTAVE - MIN_SEGMENT_OCTAVE + 1 },
  (_, i) => MIN_SEGMENT_OCTAVE + i
);
const DEFAULT_PALETTE_OCTAVE = 4;

/**
 * Horizontal strip of draggable blocks for the current scale.
 *
 * Every block reads `Label (Numeral)` — `C (I)`, `Dm (ii)`, `G7 (V7)` — so the
 * harmonic function stays visible while switching modes swaps only the material.
 *
 * The key is the strip's own, not the selected bar's: choosing what to compose
 * with is a different act from changing what an existing block is, so moving this
 * dropdown re-stocks the palette and touches nothing already on the timeline.
 */
export const ScalePalette: React.FC = () => {
  const scale = editorStore(s => s.paletteScale);
  const setPaletteScale = editorStore(s => s.setPaletteScale);
  const [mode, setMode] = useState<PaletteMode>('chords');
  // Held here, like `mode`: the chosen octave reaches the timeline inside the
  // dragged item, so nothing outside this strip needs to read it.
  const [octave, setOctave] = useState<number>(DEFAULT_PALETTE_OCTAVE);

  const items = useMemo(() => getPaletteItems(scale, mode, octave), [scale, mode, octave]);

  const handleDragStart = (e: React.DragEvent, item: PaletteItem) => {
    e.dataTransfer.setData(PALETTE_DRAG_TYPE, JSON.stringify(item));
    // jsdom — and a few browsers mid-drag — only expose text/plain reliably.
    e.dataTransfer.setData('text/plain', item.id);
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <div className="shrink-0 px-4 py-2 bg-gray-800 border-b border-gray-700">
      <div className="flex items-center gap-3 flex-wrap">
        <ScaleSelect
          idPrefix="palette"
          root={scale.root}
          type={scale.type}
          onChange={patch => setPaletteScale({ ...scale, ...patch })}
        />

        <label htmlFor="palette-mode" className="sr-only">
          Palette mode
        </label>
        <select
          id="palette-mode"
          aria-label="Palette mode"
          value={mode}
          onChange={e => setMode(e.target.value as PaletteMode)}
          className="px-2 py-1.5 text-sm bg-gray-700 border border-gray-600 rounded text-gray-200 focus:outline-none focus:border-indigo-500"
        >
          {(Object.keys(MODE_LABELS) as PaletteMode[]).map(m => (
            <option key={m} value={m}>
              {MODE_LABELS[m]}
            </option>
          ))}
        </select>

        <label htmlFor="palette-octave" className="sr-only">
          Octave
        </label>
        <select
          id="palette-octave"
          aria-label="Octave"
          value={octave}
          onChange={e => setOctave(Number(e.target.value))}
          className="px-2 py-1.5 text-sm bg-gray-700 border border-gray-600 rounded text-gray-200 focus:outline-none focus:border-indigo-500"
        >
          {OCTAVES.map(o => (
            <option key={o} value={o}>
              Octave {o}
            </option>
          ))}
        </select>

        {/* Chord blocks keep bare symbols, so the strip states their register once
            here rather than stamping the same badge on every block. */}
        <span className="text-xs text-gray-400" data-testid="palette-caption">
          {getScaleName(scale.root, scale.type)} · octave {octave}
        </span>

        <div className="flex flex-wrap gap-2">
          {items.map(item => (
            <div
              key={item.id}
              draggable
              data-testid={`palette-item-${item.id}`}
              onDragStart={e => handleDragStart(e, item)}
              className={`px-3 py-1.5 rounded-md text-sm cursor-grab active:cursor-grabbing select-none border transition-colors ${
                item.kind === 'note'
                  ? 'bg-teal-900/60 border-teal-700 text-teal-100 hover:bg-teal-800'
                  : 'bg-gray-700 border-gray-600 text-gray-100 hover:bg-gray-600'
              }`}
            >
              <span className="font-semibold">{item.label}</span>{' '}
              <span className="text-xs font-normal opacity-70">({item.degreeLabel})</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
