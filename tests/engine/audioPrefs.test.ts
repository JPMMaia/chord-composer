import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  AUDIO_PREFS_STORAGE_KEY,
  BUFFER_SIZES,
  DEFAULT_AUDIO_PREFS,
  applyBufferSize,
  applyHeadroom,
  applyResetOnStop,
  bufferLatencyMs,
  loadAudioPrefs,
  primeAudioPrefs,
  readAudioHealth,
  storeAudioPrefs,
} from '@/engine/audioPrefs';
import { isTauri } from '@/engine/platform';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@/engine/platform', () => ({ isTauri: vi.fn() }));

describe('audio preferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(invoke).mockResolvedValue(null);
  });

  describe('what is remembered', () => {
    it('is the hardware default on a machine nobody has configured', () => {
      expect(loadAudioPrefs()).toEqual(DEFAULT_AUDIO_PREFS);
    });

    it('round-trips a choice', () => {
      storeAudioPrefs({ bufferFrames: 1024, headroomMs: 100, resetOnStop: true });
      expect(loadAudioPrefs()).toEqual({ bufferFrames: 1024, headroomMs: 100, resetOnStop: true });
    });

    // This is hand-editable storage that may have been written by an older
    // build, and a bad number here would be asked of an audio device.
    it('refuses a block size that is not one of the offered ones', () => {
      localStorage.setItem(AUDIO_PREFS_STORAGE_KEY, JSON.stringify({ bufferFrames: 999 }));
      expect(loadAudioPrefs().bufferFrames).toBeNull();
    });

    it('refuses a headroom that is not one of the offered ones', () => {
      localStorage.setItem(AUDIO_PREFS_STORAGE_KEY, JSON.stringify({ headroomMs: 5000 }));
      expect(loadAudioPrefs().headroomMs).toBe(0);
    });

    it('reads nonsense as the defaults rather than throwing', () => {
      localStorage.setItem(AUDIO_PREFS_STORAGE_KEY, 'not json');
      expect(loadAudioPrefs()).toEqual(DEFAULT_AUDIO_PREFS);

      localStorage.setItem(AUDIO_PREFS_STORAGE_KEY, '"a string"');
      expect(loadAudioPrefs()).toEqual(DEFAULT_AUDIO_PREFS);
    });
  });

  describe('applying a block size', () => {
    it('tells the engine and remembers the choice', async () => {
      const outcome = await applyBufferSize(2048);

      expect(invoke).toHaveBeenCalledWith('vst3_set_buffer_size', { frames: 2048 });
      expect(outcome).toEqual({ error: null, note: null });
      expect(loadAudioPrefs().bufferFrames).toBe(2048);
    });

    // A size the device refused still changed something, just not to what was
    // asked for, and the panel has to be able to say so.
    it('passes on a size the device would not take', async () => {
      vi.mocked(invoke).mockResolvedValue('That block size was refused.');

      expect(await applyBufferSize(256)).toEqual({
        error: null,
        note: 'That block size was refused.',
      });
    });

    it('reports a change that did not happen at all', async () => {
      vi.mocked(invoke).mockRejectedValue('the audio thread is not running');

      expect(await applyBufferSize(256)).toEqual({
        error: 'the audio thread is not running',
        note: null,
      });
    });

    // An unplugged device is still what the user wants once it is plugged back
    // in, and a driver that refuses a size today may not tomorrow.
    it('remembers the choice even when the engine refused it', async () => {
      vi.mocked(invoke).mockRejectedValue('nope');
      await applyBufferSize(4096);

      expect(loadAudioPrefs().bufferFrames).toBe(4096);
    });

    it('leaves the headroom alone', async () => {
      storeAudioPrefs({ bufferFrames: null, headroomMs: 50, resetOnStop: true });
      await applyBufferSize(512);

      expect(loadAudioPrefs()).toEqual({ bufferFrames: 512, headroomMs: 50, resetOnStop: true });
    });

    it('does nothing native in a browser', async () => {
      vi.mocked(isTauri).mockReturnValue(false);
      await applyBufferSize(512);

      expect(invoke).not.toHaveBeenCalled();
      expect(loadAudioPrefs().bufferFrames).toBe(512);
    });
  });

  describe('applying headroom', () => {
    it('tells the engine and remembers the choice', async () => {
      await applyHeadroom(100);

      expect(invoke).toHaveBeenCalledWith('vst3_set_headroom', { ms: 100 });
      expect(loadAudioPrefs().headroomMs).toBe(100);
    });

    it('leaves the block size alone', async () => {
      storeAudioPrefs({ bufferFrames: 1024, headroomMs: 0, resetOnStop: true });
      await applyHeadroom(20);

      expect(loadAudioPrefs()).toEqual({ bufferFrames: 1024, headroomMs: 20, resetOnStop: true });
    });
  });

  describe('putting instruments back on Stop', () => {
    // A machine configured before this existed should get it: an instrument
    // that gets slower is a fault, and the cure costs an idle moment.
    it('is on for a machine that has never been asked', () => {
      expect(loadAudioPrefs().resetOnStop).toBe(true);

      localStorage.setItem(AUDIO_PREFS_STORAGE_KEY, JSON.stringify({ headroomMs: 50 }));
      expect(loadAudioPrefs().resetOnStop).toBe(true);
    });

    it('is off only when it was explicitly turned off', async () => {
      await applyResetOnStop(false);
      expect(loadAudioPrefs().resetOnStop).toBe(false);

      await applyResetOnStop(true);
      expect(loadAudioPrefs().resetOnStop).toBe(true);
    });

    it('leaves the other settings alone', async () => {
      storeAudioPrefs({ bufferFrames: 512, headroomMs: 100, resetOnStop: true });
      await applyResetOnStop(false);

      expect(loadAudioPrefs()).toEqual({
        bufferFrames: 512,
        headroomMs: 100,
        resetOnStop: false,
      });
    });

    // Nothing to prime: the engine is told to reset when the moment comes, so
    // there is no state on the Rust side that could go stale.
    it('says nothing to the engine at start-up', async () => {
      await applyResetOnStop(false);
      vi.mocked(invoke).mockClear();
      await primeAudioPrefs();

      expect(invoke).not.toHaveBeenCalledWith('vst3_set_reset_on_stop', expect.anything());
    });
  });

  describe('priming the engine at start-up', () => {
    // Without this the settings would only reach the engine when the dialog was
    // opened, so a choice made last week would look applied and not be.
    it('hands over what the machine was last set to', async () => {
      storeAudioPrefs({ bufferFrames: 1024, headroomMs: 50 });
      await primeAudioPrefs();

      expect(invoke).toHaveBeenCalledWith('vst3_set_buffer_size', { frames: 1024 });
      expect(invoke).toHaveBeenCalledWith('vst3_set_headroom', { ms: 50 });
    });

    // The engine starts with none, so saying so again is a command for nothing.
    it('says nothing about a headroom nobody asked for', async () => {
      await primeAudioPrefs();

      expect(invoke).not.toHaveBeenCalledWith('vst3_set_headroom', expect.anything());
    });

    it('does nothing in a browser', async () => {
      vi.mocked(isTauri).mockReturnValue(false);
      await primeAudioPrefs();

      expect(invoke).not.toHaveBeenCalled();
    });
  });

  describe('reading how the engine is doing', () => {
    it('answers null where there is no engine to ask', async () => {
      vi.mocked(isTauri).mockReturnValue(false);
      expect(await readAudioHealth()).toBeNull();
    });

    it('answers null rather than throwing when the command fails', async () => {
      vi.mocked(invoke).mockRejectedValue('no engine');
      expect(await readAudioHealth()).toBeNull();
    });
  });

  describe('the latency a block size costs', () => {
    it('is the time that block takes to play', () => {
      expect(bufferLatencyMs(480, 48000)).toBeCloseTo(10, 10);
      expect(bufferLatencyMs(1024, 48000)).toBeCloseTo(21.333, 3);
      expect(bufferLatencyMs(1024, 44100)).toBeCloseTo(23.22, 2);
    });

    // Shown beside a choice, so a rate that has not been read yet must cost the
    // panel a number rather than the word NaN.
    it('is zero rather than nonsense without a sample rate', () => {
      expect(bufferLatencyMs(1024, 0)).toBe(0);
      expect(bufferLatencyMs(1024, NaN)).toBe(0);
    });

    it('grows with every size offered', () => {
      const latencies = BUFFER_SIZES.map(size => bufferLatencyMs(size, 48000));
      expect(latencies).toEqual([...latencies].sort((a, b) => a - b));
    });
  });
});
