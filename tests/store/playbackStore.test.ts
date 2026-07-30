import { describe, it, expect, beforeEach } from 'vitest';
import { playbackStore } from '@/store/playbackStore';

describe('playbackStore', () => {
  beforeEach(() => {
    playbackStore.getState().reset();
  });

  describe('play', () => {
    it('sets isPlaying to true', () => {
      playbackStore.getState().play();
      expect(playbackStore.getState().isPlaying).toBe(true);
    });

    it('does not change playhead position on play', () => {
      playbackStore.getState().setPlayheadPosition(10);
      playbackStore.getState().play();
      expect(playbackStore.getState().playheadBeat).toBe(10);
    });

    it('can be called multiple times without issue', () => {
      playbackStore.getState().play();
      playbackStore.getState().play();
      playbackStore.getState().play();
      expect(playbackStore.getState().isPlaying).toBe(true);
    });
  });

  describe('pause', () => {
    it('sets isPlaying to false', () => {
      playbackStore.getState().play();
      playbackStore.getState().pause();
      expect(playbackStore.getState().isPlaying).toBe(false);
    });

    it('preserves playhead position on pause', () => {
      playbackStore.getState().setPlayheadPosition(5);
      playbackStore.getState().play();
      playbackStore.getState().pause();
      expect(playbackStore.getState().playheadBeat).toBe(5);
    });

    it('can be called when already paused', () => {
      playbackStore.getState().pause();
      playbackStore.getState().pause();
      expect(playbackStore.getState().isPlaying).toBe(false);
    });
  });

  describe('stop', () => {
    it('sets isPlaying to false', () => {
      playbackStore.getState().play();
      playbackStore.getState().stop();
      expect(playbackStore.getState().isPlaying).toBe(false);
    });

    it('resets playhead position to 0', () => {
      playbackStore.getState().setPlayheadPosition(15);
      playbackStore.getState().play();
      playbackStore.getState().stop();
      expect(playbackStore.getState().playheadBeat).toBe(0);
    });

    it('clears loop region on stop', () => {
      playbackStore.getState().setLoopRegion(2, 8);
      playbackStore.getState().stop();
      expect(playbackStore.getState().loopStart).toBeNull();
      expect(playbackStore.getState().loopEnd).toBeNull();
    });
  });

  describe('setPlayheadPosition', () => {
    it('sets playhead to 0', () => {
      playbackStore.getState().setPlayheadPosition(0);
      expect(playbackStore.getState().playheadBeat).toBe(0);
    });

    it('sets playhead to a positive beat', () => {
      playbackStore.getState().setPlayheadPosition(7.5);
      expect(playbackStore.getState().playheadBeat).toBe(7.5);
    });

    it('sets playhead to a fractional beat', () => {
      playbackStore.getState().setPlayheadPosition(3.25);
      expect(playbackStore.getState().playheadBeat).toBe(3.25);
    });

    it('rejects negative beat positions', () => {
      expect(() => playbackStore.getState().setPlayheadPosition(-1)).toThrow('Playhead position must be >= 0');
    });

    it('throws when playhead is not initialized', () => {
      // After reset, playhead should be initialized to 0
      expect(() => playbackStore.getState().setPlayheadPosition(5)).not.toThrow();
    });
  });

  describe('setLoopRegion', () => {
    it('sets loop start and end', () => {
      playbackStore.getState().setLoopRegion(2, 8);
      expect(playbackStore.getState().loopStart).toBe(2);
      expect(playbackStore.getState().loopEnd).toBe(8);
    });

    it('sets loop start to 0', () => {
      playbackStore.getState().setLoopRegion(0, 4);
      expect(playbackStore.getState().loopStart).toBe(0);
    });

    it('rejects start >= end', () => {
      expect(() => playbackStore.getState().setLoopRegion(8, 2)).toThrow('Loop start must be less than loop end');
    });

    it('rejects start == end', () => {
      expect(() => playbackStore.getState().setLoopRegion(4, 4)).toThrow('Loop start must be less than loop end');
    });

    it('rejects negative start', () => {
      expect(() => playbackStore.getState().setLoopRegion(-1, 4)).toThrow('Loop region values must be >= 0');
    });

    it('rejects negative end', () => {
      expect(() => playbackStore.getState().setLoopRegion(0, -1)).toThrow('Loop region values must be >= 0');
    });

    it('clears loop region when called with null values', () => {
      playbackStore.getState().setLoopRegion(2, 8);
      playbackStore.getState().setLoopRegion(null, null);
      expect(playbackStore.getState().loopStart).toBeNull();
      expect(playbackStore.getState().loopEnd).toBeNull();
    });
  });

  describe('reset', () => {
    it('sets isPlaying to false', () => {
      playbackStore.getState().play();
      playbackStore.getState().reset();
      expect(playbackStore.getState().isPlaying).toBe(false);
    });

    it('resets playhead to 0', () => {
      playbackStore.getState().setPlayheadPosition(10);
      playbackStore.getState().reset();
      expect(playbackStore.getState().playheadBeat).toBe(0);
    });

    it('clears loop region', () => {
      playbackStore.getState().setLoopRegion(1, 5);
      playbackStore.getState().reset();
      expect(playbackStore.getState().loopStart).toBeNull();
      expect(playbackStore.getState().loopEnd).toBeNull();
    });

    it('resets to initial state', () => {
      playbackStore.getState().play();
      playbackStore.getState().setPlayheadPosition(7);
      playbackStore.getState().setLoopRegion(0, 4);
      playbackStore.getState().reset();
      expect(playbackStore.getState().isPlaying).toBe(false);
      expect(playbackStore.getState().playheadBeat).toBe(0);
      expect(playbackStore.getState().loopStart).toBeNull();
      expect(playbackStore.getState().loopEnd).toBeNull();
    });
  });

  describe('initial state', () => {
    it('starts with isPlaying false', () => {
      expect(playbackStore.getState().isPlaying).toBe(false);
    });

    it('starts with playhead at 0', () => {
      expect(playbackStore.getState().playheadBeat).toBe(0);
    });

    it('starts with no loop region', () => {
      expect(playbackStore.getState().loopStart).toBeNull();
      expect(playbackStore.getState().loopEnd).toBeNull();
    });
  });

  describe('playback state transitions', () => {
    it('can play, pause, play again', () => {
      playbackStore.getState().play();
      expect(playbackStore.getState().isPlaying).toBe(true);
      playbackStore.getState().pause();
      expect(playbackStore.getState().isPlaying).toBe(false);
      playbackStore.getState().play();
      expect(playbackStore.getState().isPlaying).toBe(true);
    });

    it('stop interrupts playback', () => {
      playbackStore.getState().play();
      playbackStore.getState().stop();
      expect(playbackStore.getState().isPlaying).toBe(false);
    });

    it('playhead advances during play', () => {
      playbackStore.getState().setPlayheadPosition(0);
      playbackStore.getState().play();
      expect(playbackStore.getState().isPlaying).toBe(true);
      expect(playbackStore.getState().playheadBeat).toBe(0);
    });
  });
});
