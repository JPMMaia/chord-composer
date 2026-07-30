import { create } from 'zustand';

interface PlaybackState {
  isPlaying: boolean;
  playheadBeat: number;
  loopStart: number | null;
  loopEnd: number | null;
  play: () => void;
  pause: () => void;
  stop: () => void;
  setPlayheadPosition: (beat: number) => void;
  setLoopRegion: (start: number | null, end: number | null) => void;
  reset: () => void;
}

export const playbackStore = create<PlaybackState>((set) => ({
  isPlaying: false,
  playheadBeat: 0,
  loopStart: null,
  loopEnd: null,

  play: () => {
    set({ isPlaying: true });
  },

  pause: () => {
    set({ isPlaying: false });
  },

  stop: () => {
    set({
      isPlaying: false,
      playheadBeat: 0,
      loopStart: null,
      loopEnd: null,
    });
  },

  setPlayheadPosition: (beat: number) => {
    if (beat < 0) {
      throw new Error('Playhead position must be >= 0');
    }
    set({ playheadBeat: beat });
  },

  setLoopRegion: (start: number | null, end: number | null) => {
    if (start === null && end === null) {
      set({ loopStart: null, loopEnd: null });
      return;
    }
    if (start === null || end === null) {
      throw new Error('Both start and end must be provided together');
    }
    if (start < 0 || end < 0) {
      throw new Error('Loop region values must be >= 0');
    }
    if (start >= end) {
      throw new Error('Loop start must be less than loop end');
    }
    set({ loopStart: start, loopEnd: end });
  },

  reset: () => {
    set({
      isPlaying: false,
      playheadBeat: 0,
      loopStart: null,
      loopEnd: null,
    });
  },
}));
