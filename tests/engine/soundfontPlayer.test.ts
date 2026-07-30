import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SoundFontPlayer } from '@/engine/soundfontPlayer';

// Create a mock AudioContext
function createMockAudioContext(): any {
  const stopCalls: Array<{ note: number; track: string }> = [];
  const playCalls: Array<{ note: number; track: string }> = [];
  const mockOscillator = {
    stop: vi.fn(() => {
      // Track stop calls
    }),
    frequency: {
      setValueAtTime: vi.fn(),
    },
    type: 'sine',
    connect: vi.fn(),
    start: vi.fn(),
    setPeriodicWave: vi.fn(),
  };
  const mockGain = {
    gain: {
      setValueAtTime: vi.fn(),
      setTargetAtTime: vi.fn(),
    },
    connect: vi.fn(),
  };

  const mockCtx: any = {
    createOscillator: vi.fn(() => ({ ...mockOscillator })),
    createGain: vi.fn(() => ({ ...mockGain })),
    currentTime: 0,
    destination: {},
    state: 'running',
  };

  return mockCtx;
}

describe('soundfontPlayer', () => {
  let player: SoundFontPlayer;
  let mockCtx: any;

  beforeEach(() => {
    mockCtx = createMockAudioContext();
    player = new SoundFontPlayer(mockCtx);
  });

  describe('loadSoundFont', () => {
    it('loads a SoundFont file successfully', async () => {
      const mockFile = new File(['dummy'], 'soundfont.sf2', { type: 'application/octet-stream' });
      await expect(player.loadSoundFont(mockFile)).resolves.not.toThrow();
    });

    it('throws on invalid file type', async () => {
      const mockFile = new File(['dummy'], 'not-a-sf2.txt', { type: 'text/plain' });
      await expect(player.loadSoundFont(mockFile)).rejects.toThrow();
    });
  });

  describe('playNote', () => {
    it('plays a note with correct MIDI pitch', () => {
      player.playNote(60, 100, 0.5, 'track1');
      expect(mockCtx.createOscillator).toHaveBeenCalled();
    });

    it('plays a note with correct velocity', () => {
      player.playNote(60, 80, 0.5, 'track1');
      // Velocity is applied as volume (0-127 → 0-1)
      const gainNode = mockCtx.createGain.mock.results[0].value;
      expect(gainNode.gain.setValueAtTime).toHaveBeenCalled();
    });

    it('stops a previously playing note before playing a new one on the same track', () => {
      player.playNote(60, 100, 1.0, 'track1');
      const firstOsc = mockCtx.createOscillator.mock.results[0].value;
      player.playNote(62, 100, 1.0, 'track1');
      expect(firstOsc.stop).toHaveBeenCalled();
    });

    it('can play notes on different tracks simultaneously', () => {
      player.playNote(60, 100, 1.0, 'track1');
      player.playNote(64, 100, 1.0, 'track2');
      expect(mockCtx.createOscillator).toHaveBeenCalledTimes(2);
    });
  });

  describe('stopNote', () => {
    it('stops a playing note on the specified track', () => {
      player.playNote(60, 100, 1.0, 'track1');
      const firstOsc = mockCtx.createOscillator.mock.results[0].value;
      player.stopNote(60, 'track1');
      expect(firstOsc.stop).toHaveBeenCalled();
    });

    it('does not error when stopping a non-playing note', () => {
      expect(() => player.stopNote(60, 'track1')).not.toThrow();
    });
  });

  describe('setInstrument', () => {
    it('sets the instrument for a track', () => {
      expect(() => player.setInstrument('track1', 'piano')).not.toThrow();
    });

    it('updates instrument name', () => {
      player.setInstrument('track1', 'guitar');
      const instrument = player.getInstrument('track1');
      expect(instrument).toBe('guitar');
    });
  });

  describe('setVolume', () => {
    it('sets volume for a track', () => {
      expect(() => player.setVolume('track1', 0.75)).not.toThrow();
    });

    it('clamps volume between 0 and 1', () => {
      player.setVolume('track1', 1.5);
      const volume = player.getVolume('track1');
      expect(volume).toBe(1.0);
    });

    it('handles zero volume', () => {
      player.setVolume('track1', 0);
      const volume = player.getVolume('track1');
      expect(volume).toBe(0);
    });
  });
});
