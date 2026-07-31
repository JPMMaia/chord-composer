import React from 'react';
import { getScalePitches } from '@/engine/scales';
import { NOTE_NAMES, SCALE_TYPES } from '@/utils/constants';
import type { NoteName, ScaleType } from '@/types/music';

interface ScaleEditorProps {
  root: NoteName;
  type: ScaleType;
  onRootChange: (root: NoteName) => void;
  onTypeChange: (type: ScaleType) => void;
}

/**
 * Scale editor with root note selector, scale type selector,
 * and a visual piano keyboard showing active notes.
 */
export const ScaleEditor: React.FC<ScaleEditorProps> = ({
  root,
  type,
  onRootChange,
  onTypeChange,
}) => {
  // Get active pitch classes for the scale
  const activePitches = getScalePitches(root, type);

  // Piano key layout: white keys = C, D, E, F, G, A, B
  const whiteKeys: NoteName[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

  return (
    <div className="space-y-4">
      {/* Root Note Selector */}
      <div>
        <label htmlFor="scale-root" className="block text-xs text-gray-400 mb-1">
          Root Note
        </label>
        <select
          id="scale-root"
          value={root}
          onChange={e => onRootChange(e.target.value as NoteName)}
          className="w-full px-2 py-1.5 text-sm bg-gray-700 border border-gray-600 rounded text-gray-200 focus:outline-none focus:border-indigo-500"
          aria-label="Root Note"
        >
          {NOTE_NAMES.map(note => (
            <option key={note} value={note}>
              {note}
            </option>
          ))}
        </select>
      </div>

      {/* Scale Type Selector */}
      <div>
        <label htmlFor="scale-type" className="block text-xs text-gray-400 mb-1">
          Scale Type
        </label>
        <select
          id="scale-type"
          value={type}
          onChange={e => onTypeChange(e.target.value as ScaleType)}
          className="w-full px-2 py-1.5 text-sm bg-gray-700 border border-gray-600 rounded text-gray-200 focus:outline-none focus:border-indigo-500"
          aria-label="Scale Type"
        >
          {SCALE_TYPES.map(scaleType => (
            <option key={scaleType} value={scaleType}>
              {scaleType.replace(/([A-Z])/g, ' $1').trim()}
            </option>
          ))}
        </select>
      </div>

      {/* Active Notes Count */}
      <div className="text-xs text-gray-400">
        Active notes: {activePitches.length}
      </div>

      {/* Piano Keyboard Visualization */}
      <div
        data-testid="piano-keyboard"
        className="relative h-16 bg-gray-900 rounded-lg overflow-hidden"
      >
        {/* White keys */}
        <div className="flex h-full">
          {whiteKeys.map(note => {
            const noteIndex = NOTE_NAMES.indexOf(note);
            const isActive = activePitches.includes(noteIndex);
            return (
              <div
                key={note}
                data-note={note}
                data-note-active={isActive}
                className={`flex-1 border-r border-gray-700 last:border-r-0 flex items-end justify-center pb-1 text-xs transition-colors ${
                  isActive
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-200 text-gray-600 hover:bg-gray-100'
                }`}
              >
                {note}
              </div>
            );
          })}
        </div>

        {/* Black keys overlay */}
        <div className="absolute top-0 left-0 right-0 h-10 flex pointer-events-none">
          {/* Spacer for C */}
          <div className="flex-1" />
          {/* C# */}
          <div
            data-note="C#"
            data-note-active={activePitches.includes(1)}
            className={`w-0 border-l-2 border-r-2 border-gray-900 flex items-end justify-center pb-0.5 text-[8px] transition-colors ${
              activePitches.includes(1)
                ? 'bg-indigo-500 text-white'
                : 'bg-gray-800 text-gray-500'
            }`}
            style={{ marginLeft: '-6px', width: '12px' }}
          >
            #
          </div>
          {/* D# */}
          <div
            data-note="D#"
            data-note-active={activePitches.includes(3)}
            className={`w-0 border-l-2 border-r-2 border-gray-900 flex items-end justify-center pb-0.5 text-[8px] transition-colors ${
              activePitches.includes(3)
                ? 'bg-indigo-500 text-white'
                : 'bg-gray-800 text-gray-500'
            }`}
            style={{ marginLeft: '-6px', width: '12px' }}
          >
            #
          </div>
          {/* Spacer for E-F */}
          <div className="flex-1" />
          {/* F# */}
          <div
            data-note="F#"
            data-note-active={activePitches.includes(6)}
            className={`w-0 border-l-2 border-r-2 border-gray-900 flex items-end justify-center pb-0.5 text-[8px] transition-colors ${
              activePitches.includes(6)
                ? 'bg-indigo-500 text-white'
                : 'bg-gray-800 text-gray-500'
            }`}
            style={{ marginLeft: '-6px', width: '12px' }}
          >
            #
          </div>
          {/* G# */}
          <div
            data-note="G#"
            data-note-active={activePitches.includes(8)}
            className={`w-0 border-l-2 border-r-2 border-gray-900 flex items-end justify-center pb-0.5 text-[8px] transition-colors ${
              activePitches.includes(8)
                ? 'bg-indigo-500 text-white'
                : 'bg-gray-800 text-gray-500'
            }`}
            style={{ marginLeft: '-6px', width: '12px' }}
          >
            #
          </div>
          {/* A# */}
          <div
            data-note="A#"
            data-note-active={activePitches.includes(10)}
            className={`w-0 border-l-2 border-r-2 border-gray-900 flex items-end justify-center pb-0.5 text-[8px] transition-colors ${
              activePitches.includes(10)
                ? 'bg-indigo-500 text-white'
                : 'bg-gray-800 text-gray-500'
            }`}
            style={{ marginLeft: '-6px', width: '12px' }}
          >
            #
          </div>
          {/* Spacer for B-C */}
          <div className="flex-1" />
        </div>
      </div>
    </div>
  );
};
