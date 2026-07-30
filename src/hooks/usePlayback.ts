import { useRef, useCallback, useEffect, useState } from 'react';
import { SoundFontPlayer } from '@/engine/soundfontPlayer';
import { calculateNoteTiming, getLoopDuration } from '@/engine/playback';
import type { PlaybackConfig } from '@/engine/playback';

/**
 * Hook to manage playback scheduling with Web Audio API.
 * Schedules notes ahead of time using AudioContext.currentTime.
 */
export function usePlayback(config: PlaybackConfig) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const playerRef = useRef<SoundFontPlayer | null>(null);
  const scheduledNotesRef = useRef<Set<string>>(new Set());
  const startTimeRef = useRef<number>(0);
  const pauseTimeRef = useRef<number>(0);

  // Initialize SoundFontPlayer when config changes
  useEffect(() => {
    if (!playerRef.current) {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      playerRef.current = new SoundFontPlayer(audioCtx);
    }
    return () => {
      playerRef.current?.stopAllTracks();
    };
  }, []);

  /**
   * Schedule all notes for playback.
   */
  const scheduleAllNotes = useCallback(() => {
    if (!playerRef.current) return;

    const timings = calculateNoteTiming(config);

    // Clear previous scheduling
    scheduledNotesRef.current.clear();

    for (const timing of timings) {
      const noteKey = `${timing.midiNote}-${timing.barIndex}`;
      scheduledNotesRef.current.add(noteKey);

      const noteDuration = timing.duration;
      const velocity = timing.velocity;

      // Schedule note playback
      playerRef.current.playNote(
        timing.midiNote,
        velocity,
        noteDuration,
        'main'
      );
    }
  }, [config]);

  /**
   * Start playback.
   */
  const play = useCallback(() => {
    if (!playerRef.current) return;

    // Resume AudioContext (autoplay policy)
    const ctx = playerRef.current.getAudioContext();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    setIsPlaying(true);
    setIsPaused(false);

    // Start scheduling notes
    scheduleAllNotes();

    // Start playhead tracking
    startTimeRef.current = ctx.currentTime;
  }, [scheduleAllNotes]);

  /**
   * Pause playback.
   */
  const pause = useCallback(() => {
    if (!playerRef.current) return;

    setIsPaused(true);
    setIsPlaying(false);

    // Record pause time
    pauseTimeRef.current = currentTime;

    // Stop all playing notes
    playerRef.current.stopAllTracks();
  }, [currentTime]);

  /**
   * Stop playback and reset.
   */
  const stop = useCallback(() => {
    if (!playerRef.current) return;

    setIsPlaying(false);
    setIsPaused(false);
    setCurrentTime(0);

    playerRef.current.stopAllTracks();
    scheduledNotesRef.current.clear();
  }, []);

  /**
   * Update playhead position based on elapsed time.
   */
  useEffect(() => {
    if (!isPlaying || isPaused) return;

    let animationFrame: number;
    const updatePlayhead = () => {
      if (!playerRef.current) return;

      const ctx = playerRef.current.getAudioContext();
      const elapsed = ctx.currentTime - startTimeRef.current;
      const loopDur = getLoopDuration(config);

      if (elapsed >= loopDur) {
        // Loop reached end
        if (config.loopStart !== null && config.loopEnd !== null) {
          // Restart from loop start
          startTimeRef.current = ctx.currentTime;
        } else {
          // Stop at end
          setIsPlaying(false);
          return;
        }
      }

      setCurrentTime(Math.min(elapsed, loopDur));
      animationFrame = requestAnimationFrame(updatePlayhead);
    };

    animationFrame = requestAnimationFrame(updatePlayhead);
    return () => cancelAnimationFrame(animationFrame);
  }, [isPlaying, isPaused, config]);

  return {
    isPlaying,
    isPaused,
    currentTime,
    play,
    pause,
    stop,
    player: playerRef.current,
  };
}
