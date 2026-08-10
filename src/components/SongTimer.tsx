import React from 'react';
import { projectStore } from '@/store/projectStore';
import { useSongTimer } from '@/hooks/useSongTimer';
import {
  formatBarOffset,
  formatElapsed,
  formatPosition,
  getTimerReadout,
} from '@/engine/songTimer';

interface SongTimerProps {
  /** Live song position in seconds. From `usePlayback`. */
  getSongTime: () => number;
  isPlaying: boolean;
  /** Pause freezes the readout where it stopped; only Stop releases it. */
  isPaused: boolean;
}

/**
 * Wall-clock readout for the transport: time since the start of the song, the bar and
 * beat that lands on, and time since that bar's downbeat.
 *
 * Reads the project itself rather than taking it as props — only the clock has to be
 * handed down, and the transport above is otherwise free of store access.
 */
export const SongTimer: React.FC<SongTimerProps> = ({ getSongTime, isPlaying, isPaused }) => {
  const project = projectStore(s => s.project);
  const songTime = useSongTimer(getSongTime, isPlaying, isPaused);

  const readout = getTimerReadout(
    songTime,
    project?.bars ?? [],
    project?.timeSignature ?? { beatsPerMeasure: 4, beatUnit: 4 },
    project?.bpm ?? 120
  );

  return (
    // `tabular-nums` so the digits keep their columns instead of jittering as they run.
    <div
      className="flex items-center gap-2 text-xs text-gray-400 font-mono tabular-nums"
      data-testid="song-timer"
      title="Elapsed time · bar.beat · time since the bar line"
    >
      <span data-testid="song-elapsed">⏱ {formatElapsed(readout.songElapsed)}</span>
      <span data-testid="song-position">Bar {formatPosition(readout)}</span>
      <span data-testid="bar-elapsed">{formatBarOffset(readout.barElapsed)}</span>
    </div>
  );
};
