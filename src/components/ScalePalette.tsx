import React, { useMemo, useState } from 'react';
import type { Scale } from '@/types/music';
import { getPaletteItems, type PaletteItem, type PaletteMode } from '@/engine/palette';
import { getScaleName } from '@/engine/scales';

/** MIME type carrying the full palette item across a drag. */
export const PALETTE_DRAG_TYPE = 'application/x-palette-item';

interface ScalePaletteProps {
  /** Scale to derive blocks from — the selected bar's scale. */
  scale: Scale;
}

const MODE_LABELS: Record<PaletteMode, string> = {
  notes: 'Notes',
  chords: 'Chords',
  sevenths: 'Seventh Chords',
};

/**
 * Horizontal strip of draggable blocks for the current scale.
 *
 * Every block reads `Label (Numeral)` — `C (I)`, `Dm (ii)`, `G7 (V7)` — so the
 * harmonic function stays visible while switching modes swaps only the material.
 */
export const ScalePalette: React.FC<ScalePaletteProps> = ({ scale }) => {
  const [mode, setMode] = useState<PaletteMode>('chords');

  const items = useMemo(() => getPaletteItems(scale, mode), [scale, mode]);

  const handleDragStart = (e: React.DragEvent, item: PaletteItem) => {
    e.dataTransfer.setData(PALETTE_DRAG_TYPE, JSON.stringify(item));
    // jsdom — and a few browsers mid-drag — only expose text/plain reliably.
    e.dataTransfer.setData('text/plain', item.id);
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <div className="shrink-0 px-4 py-2 bg-gray-800 border-b border-gray-700">
      <div className="flex items-center gap-3 flex-wrap">
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

        <span className="text-xs text-gray-400">{getScaleName(scale.root, scale.type)}</span>

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
