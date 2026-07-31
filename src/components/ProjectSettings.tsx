import React from 'react';
import type { NoteName, TimeSignature } from '@/types/music';
import { NOTE_NAMES } from '@/utils/constants';

interface ProjectSettingsProps {
  bpm: number;
  timeSignature: TimeSignature;
  key: NoteName;
  keyMode: 'major' | 'minor';
  barCount: number;
  onBpmChange: (bpm: number) => void;
  onTimeSignatureChange: (ts: TimeSignature) => void;
  onKeyChange: (key: NoteName, mode: 'major' | 'minor') => void;
  onBarCountChange: (count: number) => void;
}

/**
 * Project settings panel: BPM, time signature, key, and bar count.
 */
export const ProjectSettings: React.FC<ProjectSettingsProps> = ({
  bpm,
  timeSignature,
  key,
  keyMode,
  barCount,
  onBpmChange,
  onTimeSignatureChange,
  onKeyChange,
  onBarCountChange,
}) => {
  const handleBpmInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value, 10);
    if (!isNaN(value) && value >= 20 && value <= 300) {
      onBpmChange(value);
    }
  };

  const handleBarCountInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value, 10);
    if (!isNaN(value) && value >= 1 && value <= 128) {
      onBarCountChange(value);
    }
  };

  return (
    <div className="space-y-4">
      {/* BPM */}
      <div>
        <label htmlFor="project-bpm" className="block text-xs text-gray-400 mb-1">
          BPM
        </label>
        <div className="flex items-center gap-2">
          <input
            id="project-bpm"
            type="range"
            min={20}
            max={300}
            value={bpm}
            onChange={e => onBpmChange(parseInt(e.target.value, 10))}
            className="flex-1 h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-indigo-500"
            aria-label="BPM Slider"
          />
          <input
            type="number"
            value={bpm}
            onChange={handleBpmInput}
            className="w-16 px-2 py-1.5 text-sm bg-gray-700 border border-gray-600 rounded text-gray-200 text-center focus:outline-none focus:border-indigo-500"
            aria-label="BPM"
            min={20}
            max={300}
          />
        </div>
      </div>

      {/* Time Signature */}
      <div>
        <label htmlFor="time-sig" className="block text-xs text-gray-400 mb-1">
          Time Signature
        </label>
        <select
          id="time-sig"
          value={`${timeSignature.beatsPerMeasure}/${timeSignature.beatUnit}`}
          onChange={e => {
            const [beats, unit] = e.target.value.split('/').map(Number);
            onTimeSignatureChange({ beatsPerMeasure: beats, beatUnit: unit });
          }}
          className="w-full px-2 py-1.5 text-sm bg-gray-700 border border-gray-600 rounded text-gray-200 focus:outline-none focus:border-indigo-500"
          aria-label="Time Signature"
        >
          <option value="2/4">2/4</option>
          <option value="3/4">3/4</option>
          <option value="4/4">4/4</option>
          <option value="5/4">5/4</option>
          <option value="6/8">6/8</option>
          <option value="7/4">7/4</option>
          <option value="7/8">7/8</option>
          <option value="9/8">9/8</option>
          <option value="12/8">12/8</option>
        </select>
      </div>

      {/* Key */}
      <div>
        <label htmlFor="project-key" className="block text-xs text-gray-400 mb-1">
          Key
        </label>
        <div className="flex gap-2">
          <select
            id="project-key"
            value={key}
            onChange={e => onKeyChange(e.target.value as NoteName, keyMode)}
            className="flex-1 px-2 py-1.5 text-sm bg-gray-700 border border-gray-600 rounded text-gray-200 focus:outline-none focus:border-indigo-500"
            aria-label="Key Root"
          >
            {NOTE_NAMES.map(note => (
              <option key={note} value={note}>
                {note}
              </option>
            ))}
          </select>
          <select
            value={keyMode}
            onChange={e => onKeyChange(key, e.target.value as 'major' | 'minor')}
            className="flex-1 px-2 py-1.5 text-sm bg-gray-700 border border-gray-600 rounded text-gray-200 focus:outline-none focus:border-indigo-500"
            aria-label="Key Mode"
          >
            <option value="major">Major</option>
            <option value="minor">Minor</option>
          </select>
        </div>
      </div>

      {/* Key Mode */}
      <div>
        <label htmlFor="key-mode" className="block text-xs text-gray-400 mb-1">
          Key Mode
        </label>
        <select
          id="key-mode"
          value={keyMode}
          onChange={e => onKeyChange(key, e.target.value as 'major' | 'minor')}
          className="w-full px-2 py-1.5 text-sm bg-gray-700 border border-gray-600 rounded text-gray-200 focus:outline-none focus:border-indigo-500"
          aria-label="Key Mode"
        >
          <option value="major">Major</option>
          <option value="minor">Minor</option>
        </select>
      </div>

      {/* Bar Count */}
      <div>
        <label htmlFor="bar-count" className="block text-xs text-gray-400 mb-1">
          Number of Bars
        </label>
        <div className="flex items-center gap-2">
          <input
            id="bar-count"
            type="range"
            min={1}
            max={128}
            value={barCount}
            onChange={e => onBarCountChange(parseInt(e.target.value, 10))}
            className="flex-1 h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-indigo-500"
            aria-label="Bar Count Slider"
          />
          <input
            type="number"
            value={barCount}
            onChange={handleBarCountInput}
            className="w-16 px-2 py-1.5 text-sm bg-gray-700 border border-gray-600 rounded text-gray-200 text-center focus:outline-none focus:border-indigo-500"
            aria-label="Bar Count"
            min={1}
            max={128}
          />
        </div>
      </div>
    </div>
  );
};
