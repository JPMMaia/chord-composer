import React, { useMemo } from 'react';
import { getPaletteItems, PALETTE_SIZES, SIZE_LABELS, type PaletteItem } from '@/engine/palette';
import { getScaleName } from '@/engine/scales';
import { ScaleSelect } from '@/components/ScaleSelect';
import { editorStore } from '@/store/editorStore';
import { MAX_SEGMENT_OCTAVE, MIN_SEGMENT_OCTAVE } from '@/utils/constants';

/** MIME type carrying the full palette item across a drag. */
export const PALETTE_DRAG_TYPE = 'application/x-palette-item';

/** Octaves offered for new blocks — the same registers a segment may be moved to. */
const OCTAVES = Array.from(
  { length: MAX_SEGMENT_OCTAVE - MIN_SEGMENT_OCTAVE + 1 },
  (_, i) => MIN_SEGMENT_OCTAVE + i
);

/**
 * Horizontal strip of draggable blocks for the current scale.
 *
 * Every block reads `Label (Numeral)` — `C (I)`, `Dm (ii)`, `G7 (V7)` — so the
 * harmonic function stays visible while changing the size swaps only the material.
 *
 * The size control is one dimension where three named families used to be: a degree
 * is the same degree however thickly it is played, so the strip lists the degrees
 * once and the dropdown says how much of each to take.
 *
 * The key is the strip's own, not the selected bar's: choosing what to compose
 * with is a different act from changing what an existing block is, so moving this
 * dropdown re-stocks the palette and touches nothing already on the timeline.
 *
 * Size and octave live in `editorStore` rather than here, because the strip is no
 * longer their only reader: the number keys play this same palette.
 */
export const ScalePalette: React.FC = () => {
  const scale = editorStore(s => s.paletteScale);
  const setPaletteScale = editorStore(s => s.setPaletteScale);
  const size = editorStore(s => s.paletteSize);
  const setSize = editorStore(s => s.setPaletteSize);
  const octave = editorStore(s => s.paletteOctave);
  const setOctave = editorStore(s => s.setPaletteOctave);

  const items = useMemo(() => getPaletteItems(scale, size, octave), [scale, size, octave]);

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

        <label htmlFor="palette-size" className="sr-only">
          Palette size
        </label>
        <select
          id="palette-size"
          aria-label="Palette size"
          value={size}
          onChange={e => setSize(Number(e.target.value))}
          className="px-2 py-1.5 text-sm bg-gray-700 border border-gray-600 rounded text-gray-200 focus:outline-none focus:border-indigo-500"
        >
          {PALETTE_SIZES.map(n => (
            <option key={n} value={n}>
              {SIZE_LABELS[n]}
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
                item.tones.length === 1
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
