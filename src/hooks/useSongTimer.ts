import { useEffect, useRef, useState } from 'react';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { beatToSongTime } from '@/engine/scheduler';
import { getBarStartBeat } from '@/engine/timeline';

/**
 * The song position to display, in seconds.
 *
 * While playing this samples the audio clock on every frame rather than reading
 * `usePlayback`'s `currentTime`, which is only republished once per 50 ms scheduling
 * pass — visibly steppy next to a millisecond readout. The loop lives here, in a hook
 * used by the readout alone, so the per-frame updates re-render that one component
 * instead of the whole app.
 *
 * Pause holds the last sampled position — that is where Play will pick up again, so
 * the readout has to agree with it. Only a full Stop hands the readout back to the
 * *selected bar*, where stepping through bars tells you where each one falls in time.
 */
export function useSongTimer(
  getSongTime: () => number,
  isPlaying: boolean,
  isPaused: boolean
): number {
  const project = projectStore(s => s.project);
  const selectedBarId = selectionStore(s => s.selectedBarId);

  const [sampled, setSampled] = useState(0);

  /**
   * Read through a ref so a caller that rebuilds the getter on every render does not
   * restart the loop — which would leave the readout updating only as often as the
   * app re-renders.
   */
  const getSongTimeRef = useRef(getSongTime);
  getSongTimeRef.current = getSongTime;

  useEffect(() => {
    if (!isPlaying) return;

    let frame = 0;
    const sample = () => {
      setSampled(getSongTimeRef.current());
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);

    return () => cancelAnimationFrame(frame);
  }, [isPlaying]);

  // The last frame sampled before the loop was cancelled is the paused position, to
  // within a frame. Deliberately not re-read from `getSongTime` here: with no clock
  // running it falls back to the 50 ms-stale scheduling value, which is coarser.
  if (isPlaying || isPaused) return sampled;

  if (!project || !selectedBarId) return 0;
  const barIndex = project.bars.findIndex(bar => bar.id === selectedBarId);
  if (barIndex < 0) return 0;

  return beatToSongTime(
    getBarStartBeat(project.bars, barIndex, project.timeSignature),
    project.bpm
  );
}
