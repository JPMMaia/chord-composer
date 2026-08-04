import { useEffect, useCallback, useRef } from 'react';

/** True for elements that should keep their own key handling. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'SELECT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable
  );
}

interface UsePlaybackShortcutsProps {
  isPlaying: boolean;
  isLoading: boolean;
  onPlay: () => void;
  onStop: () => void;
}

/**
 * Spacebar toggles playback: starts when stopped, stops when playing.
 *
 * Bound to the window so it works regardless of which pane has focus.
 */
export function usePlaybackShortcuts({
  isPlaying,
  isLoading,
  onPlay,
  onStop,
}: UsePlaybackShortcutsProps): void {
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  const handleSpace = useCallback(
    (e: KeyboardEvent) => {
      if (isTextEntry(e.target)) return;

      // Allow Ctrl/Cmd+Space to pass through (desktop zoom on macOS).
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      e.preventDefault();

      if (isPlayingRef.current) {
        onStop();
      } else {
        onPlay();
      }
    },
    [onPlay, onStop],
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== ' ') return;
      if (isLoading) return; // Don't re-toggle while samples are loading.
      handleSpace(e);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSpace, isLoading]);
}
