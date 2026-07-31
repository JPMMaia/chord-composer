import React, { useState } from 'react';
import type { TimeSignature } from '@/types/music';

interface TransportProps {
  isPlaying: boolean;
  isPaused: boolean;
  bpm: number;
  timeSignature: TimeSignature;
  /** Musical key readout. Named around React's reserved `key` prop. */
  musicalKey: string;
  keyMode: 'major' | 'minor';
  hasLoopRegion: boolean;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onBpmChange: (bpm: number) => void;
  onMetronomeToggle: () => void;
  onLoopToggle: () => void;
}

/**
 * Transport controls for playback: play, pause, stop, BPM, metronome, loop.
 */
export const Transport: React.FC<TransportProps> = ({
  isPlaying,
  isPaused,
  bpm,
  timeSignature,
  musicalKey,
  keyMode,
  hasLoopRegion,
  onPlay,
  onPause,
  onStop,
  onBpmChange,
  onMetronomeToggle,
  onLoopToggle,
}) => {
  const [bpmInput, setBpmInput] = useState<string>(String(bpm));

  const handleBpmChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setBpmInput(value);
    const parsed = parseInt(value, 10);
    if (!isNaN(parsed) && parsed >= 20 && parsed <= 999) {
      onBpmChange(parsed);
    }
  };

  const handleBpmBlur = () => {
    // Reset to valid BPM on blur
    const parsed = parseInt(bpmInput, 10);
    if (isNaN(parsed) || parsed < 20 || parsed > 999) {
      setBpmInput(String(bpm));
    }
  };

  return (
    <div
      className="flex items-center gap-3 px-4 py-2 bg-gray-800 border-b border-gray-700"
      data-testid="transport"
    >
      {/* Playback buttons */}
      <div className="flex items-center gap-1">
        <button
          onClick={onPlay}
          className={`px-3 py-1.5 text-sm rounded transition-colors ${
            isPlaying
              ? 'bg-green-600 text-white'
              : 'bg-gray-600 text-gray-200 hover:bg-gray-500'
          }`}
          aria-label="Play"
        >
          ▶ Play
        </button>
        <button
          onClick={onPause}
          className={`px-3 py-1.5 text-sm rounded transition-colors ${
            isPaused
              ? 'bg-yellow-600 text-white'
              : 'bg-gray-600 text-gray-200 hover:bg-gray-500'
          }`}
          aria-label="Pause"
        >
          ⏸ Pause
        </button>
        <button
          onClick={onStop}
          className="px-3 py-1.5 text-sm bg-gray-600 text-gray-200 rounded hover:bg-gray-500 transition-colors"
          aria-label="Stop"
        >
          ⏹ Stop
        </button>
      </div>

      {/* BPM control */}
      <div className="flex items-center gap-2">
        <label htmlFor="bpm-input" className="text-xs text-gray-400">
          BPM
        </label>
        <input
          id="bpm-input"
          type="number"
          value={bpmInput}
          onChange={handleBpmChange}
          onBlur={handleBpmBlur}
          className="w-16 px-2 py-1 text-sm bg-gray-700 border border-gray-600 rounded text-gray-200 text-center focus:outline-none focus:border-indigo-500"
          aria-label="BPM"
          min={20}
          max={999}
        />
      </div>

      {/* Time signature */}
      <div className="text-xs text-gray-400">
        {timeSignature.beatsPerMeasure}/{timeSignature.beatUnit}
      </div>

      {/* Key */}
      <div className="text-xs text-gray-400">
        {musicalKey} {keyMode === 'major' ? 'Major' : 'Minor'}
      </div>

      {/* Metronome toggle */}
      <button
        onClick={onMetronomeToggle}
        className="px-3 py-1.5 text-sm bg-gray-600 text-gray-200 rounded hover:bg-gray-500 transition-colors"
        aria-label="Metronome"
      >
        🎵 Metro
      </button>

      {/* Loop toggle */}
      {hasLoopRegion && (
        <button
          onClick={onLoopToggle}
          className="px-3 py-1.5 text-sm bg-gray-600 text-gray-200 rounded hover:bg-gray-500 transition-colors"
          aria-label="Loop"
        >
          🔁 Loop
        </button>
      )}
    </div>
  );
};
