import React, { useState } from 'react';
import { ChordBlock } from './ChordBlock';
import type { Bar, Scale, ChordSegment } from '@/types/music';
import { reorderChords } from '@/engine/chordOperations';

interface ChordEditorProps {
  bar: Bar;
  scale: Scale;
  onChordReorder: (chords: ChordSegment[]) => void;
  onChordAdd: (chord: ChordSegment) => void;
  onChordRemove: (chordId: string) => void;
  onBarSplit: (chordCount: number) => void;
  onAutoFillNotes: () => void;
  onCustomChordInput: (symbol: string) => void;
  selectedChordId?: string;
}

/**
 * ChordEditor component for managing chord segments within a bar.
 * Supports drag-and-drop reordering, bar splitting, and auto-fill.
 */
export const ChordEditor: React.FC<ChordEditorProps> = ({
  bar,
  onChordReorder,
  onChordAdd,
  onChordRemove,
  onBarSplit,
  onAutoFillNotes,
  onCustomChordInput,
  selectedChordId,
}) => {
  const [selectedId, setSelectedId] = useState<string | undefined>(selectedChordId);
  const [splitOption, setSplitOption] = useState<boolean>(false);
  const [customSymbol, setCustomSymbol] = useState<string>('');

  const handleSelect = (chordId: string) => {
    setSelectedId(chordId);
  };

  const handleRemove = (chordId: string) => {
    onChordRemove(chordId);
    if (selectedId === chordId) {
      setSelectedId(undefined);
    }
  };

  const handleSplit = (count: number) => {
    onBarSplit(count);
    setSplitOption(false);
  };

  const handleAddChord = () => {
    // Add a default chord (I) with duration of 1 beat
    const newChord: ChordSegment = {
      id: crypto.randomUUID(),
      romanNumeral: 'I',
      chordSymbol: 'C',
      duration: 1,
    };
    onChordAdd(newChord);
  };

  const handleCustomChordSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (customSymbol.trim()) {
      onCustomChordInput(customSymbol.trim());
      setCustomSymbol('');
    }
  };

  const handleDragStart = (e: React.DragEvent, fromIndex: number) => {
    e.dataTransfer.setData('text/plain', String(fromIndex));
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (!isNaN(fromIndex) && fromIndex !== toIndex) {
      onChordReorder(reorderChords(bar.chords, fromIndex, toIndex));
    }
  };

  return (
    <div className="w-full" data-testid="chord-editor">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-300">
          Chords
        </h3>
        {/* Split bar dropdown */}
        <div className="relative">
          <button
            onClick={() => setSplitOption(!splitOption)}
            className="px-2 py-1 text-xs bg-gray-600 hover:bg-gray-500 text-gray-200 rounded transition-colors"
            aria-label="Split bar"
          >
            Split Bar ▾
          </button>
          {splitOption && (
            <div className="absolute right-0 mt-1 bg-gray-700 rounded shadow-lg z-10 border border-gray-600">
              <button
                onClick={() => handleSplit(2)}
                className="block w-full px-3 py-1 text-sm text-gray-200 hover:bg-gray-600 text-left"
              >
                2 segments
              </button>
              <button
                onClick={() => handleSplit(3)}
                className="block w-full px-3 py-1 text-sm text-gray-200 hover:bg-gray-600 text-left"
              >
                3 segments
              </button>
              <button
                onClick={() => handleSplit(4)}
                className="block w-full px-3 py-1 text-sm text-gray-200 hover:bg-gray-600 text-left"
              >
                4 segments
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Chord blocks */}
      <div className="flex gap-2 mb-3" data-testid="chord-blocks">
        {bar.chords.length === 0 ? (
          <div className="text-sm text-gray-500 italic py-2">
            No chords — split the bar or add a chord
          </div>
        ) : (
          bar.chords.map((chord, index) => (
            <div
              key={chord.id}
              draggable
              onDragStart={(e) => handleDragStart(e, index)}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, index)}
              className="group flex-1"
            >
              <ChordBlock
                chord={chord}
                isSelected={selectedId === chord.id}
                onSelect={handleSelect}
                onRemove={handleRemove}
              />
            </div>
          ))
        )}
      </div>

      {/* Action buttons */}
      <div className="flex gap-2 mb-3">
        <button
          onClick={handleAddChord}
          className="flex-1 px-3 py-1.5 text-sm bg-emerald-600 hover:bg-emerald-500 text-white rounded transition-colors"
          aria-label="Add chord"
        >
          + Add Chord
        </button>
        <button
          onClick={onAutoFillNotes}
          className="flex-1 px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
          aria-label="Auto-fill notes"
        >
          Auto-Fill Notes
        </button>
      </div>

      {/* Custom chord input */}
      <form onSubmit={handleCustomChordSubmit} className="flex gap-2">
        <input
          type="text"
          value={customSymbol}
          onChange={(e) => setCustomSymbol(e.target.value)}
          placeholder="Chord symbol (e.g. Am7)"
          className="flex-1 px-2 py-1.5 text-sm bg-gray-700 border border-gray-600 rounded text-gray-200 placeholder-gray-500 focus:outline-none focus:border-indigo-500"
          aria-label="Custom chord symbol"
        />
        <button
          type="submit"
          className="px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded transition-colors"
        >
          Add
        </button>
      </form>
    </div>
  );
};
