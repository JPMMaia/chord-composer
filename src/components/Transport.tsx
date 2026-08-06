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
  /** Whether reaching the end of the play range wraps back to its start. */
  loopEnabled: boolean;
  /** Human-readable play range, e.g. "2–4". Null when the whole project plays. */
  loopRangeLabel: string | null;
  /** True while the instrument's samples are still downloading. */
  isLoading?: boolean;
  isMetronomeOn: boolean;
  /** Whether the number keys write to the timeline once playback is running. */
  isRecordArmed: boolean;
  /** Whether a recorded take snaps to the timeline's grid. */
  recordQuantize: boolean;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onBpmChange: (bpm: number) => void;
  onMetronomeToggle: () => void;
  onLoopToggle: () => void;
  onRecordToggle: () => void;
  onQuantizeToggle: () => void;
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
  loopEnabled,
  loopRangeLabel,
  isLoading = false,
  isMetronomeOn,
  isRecordArmed,
  recordQuantize,
  onPlay,
  onPause,
  onStop,
  onBpmChange,
  onMetronomeToggle,
  onLoopToggle,
  onRecordToggle,
  onQuantizeToggle,
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
          disabled={isLoading}
          className={`px-3 py-1.5 text-sm rounded transition-colors ${
            isLoading
              ? 'bg-gray-700 text-gray-400 cursor-wait'
              : isPlaying
                ? 'bg-green-600 text-white'
                : 'bg-gray-600 text-gray-200 hover:bg-gray-500'
          }`}
          aria-label="Play"
        >
          {isLoading ? '⏳ Loading…' : '▶ Play'}
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
        {/* Arms the number keys; it takes Play as well before anything is written,
            so the button pulses only once recording is actually happening. */}
        <button
          onClick={onRecordToggle}
          aria-label="Record"
          aria-pressed={isRecordArmed}
          title="Arm recording (R) — hold 1–7 while playing to lay down chords"
          className={`px-3 py-1.5 text-sm rounded transition-colors ${
            isRecordArmed
              ? `bg-red-600 text-white${isPlaying ? ' animate-pulse' : ''}`
              : 'bg-gray-600 text-gray-200 hover:bg-gray-500'
          }`}
        >
          ⏺ Record
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
        className={`px-3 py-1.5 text-sm rounded transition-colors ${
          isMetronomeOn
            ? 'bg-cyan-600 text-white'
            : 'bg-gray-600 text-gray-200 hover:bg-gray-500'
        }`}
        aria-label="Metronome"
        aria-pressed={isMetronomeOn}
      >
        🎵 Metro
      </button>

      {/* Whether a recorded take is pulled onto the timeline's snap grid or keeps
          the timing it was played with. Beside the metronome, which is the other
          control that only matters while something is being played in. */}
      <button
        onClick={onQuantizeToggle}
        aria-label="Quantize recording"
        aria-pressed={recordQuantize}
        title="Snap recorded blocks to the timeline's Snap grid"
        className={`px-3 py-1.5 text-sm rounded transition-colors ${
          recordQuantize
            ? 'bg-cyan-600 text-white'
            : 'bg-gray-600 text-gray-200 hover:bg-gray-500'
        }`}
      >
        ⊞ Quantize
      </button>

      {/* Repeat toggle. Always shown: gating it on a range being set would hide the
          only control that can turn it back on. */}
      <button
        onClick={onLoopToggle}
        aria-label="Loop"
        aria-pressed={loopEnabled}
        className={`px-3 py-1.5 text-sm rounded transition-colors ${
          loopEnabled
            ? 'bg-indigo-600 text-white'
            : 'bg-gray-600 text-gray-200 hover:bg-gray-500'
        }`}
      >
        🔁 Repeat
      </button>

      {/* Play range readout */}
      <div className="text-xs text-gray-400" data-testid="loop-range-readout">
        Range {loopRangeLabel ?? '—'}
      </div>
    </div>
  );
};
