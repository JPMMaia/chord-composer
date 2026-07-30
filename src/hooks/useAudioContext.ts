import { useRef, useEffect, useCallback, useState } from 'react';

/**
 * Hook to manage AudioContext lifecycle.
 * Handles autoplay policies by resuming on user gesture.
 */
export function useAudioContext(): {
  audioContext: AudioContext | null;
  resumeAudio: () => Promise<void>;
  isReady: boolean;
} {
  const audioContextRef = useRef<AudioContext | null>(null);
  const [isReady, setIsReady] = useState(false);

  // Initialize AudioContext on first use
  const getAudioContext = useCallback((): AudioContext => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    return audioContextRef.current;
  }, []);

  // Resume AudioContext (required by autoplay policies)
  const resumeAudio = useCallback(async () => {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    setIsReady(true);
  }, [getAudioContext]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
    };
  }, []);

  return {
    audioContext: audioContextRef.current,
    resumeAudio,
    isReady,
  };
}
