/**
 * SoundFontPlayer — Web Audio API-based note playback.
 *
 * Uses oscillators as fallback when no SoundFont is loaded.
 * Supports basic instrument/volume per track.
 */

export interface TrackState {
  instrument: string;
  volume: number;
  activeNotes: Map<number, { oscillator: OscillatorNode; gain: GainNode }>;
}

export class SoundFontPlayer {
  private ctx: AudioContext;
  private tracks: Map<string, TrackState>;
  private masterGain: GainNode;
  private loadedSoundFont: boolean;

  constructor(audioContext: AudioContext) {
    this.ctx = audioContext;
    this.tracks = new Map();
    this.masterGain = this.ctx.createGain();
    this.masterGain.connect(this.ctx.destination);
    this.loadedSoundFont = false;
  }

  /**
   * Load a SoundFont file (SF2).
   * In this implementation, we validate the file and mark as loaded.
   * Actual SF2 parsing would require a library like soundfont-player.
   */
  async loadSoundFont(file: File): Promise<void> {
    if (!file.name.toLowerCase().endsWith('.sf2')) {
      throw new Error('Only SF2 SoundFont files are supported');
    }
    // In a full implementation, we would parse the SF2 file here
    this.loadedSoundFont = true;
  }

  /**
   * Get or create track state.
   */
  private getOrCreateTrack(trackId: string): TrackState {
    if (!this.tracks.has(trackId)) {
      this.tracks.set(trackId, {
        instrument: 'piano',
        volume: 0.8,
        activeNotes: new Map(),
      });
    }
    return this.tracks.get(trackId)!;
  }

  /**
   * Play a MIDI note on the specified track.
   */
  playNote(midiNote: number, velocity: number, duration: number, trackId: string): void {
    const track = this.getOrCreateTrack(trackId);

    // Stop any existing note on this track for the same pitch
    const existing = track.activeNotes.get(midiNote);
    if (existing) {
      try {
        existing.oscillator.stop();
      } catch {
        // Already stopped
      }
      track.activeNotes.delete(midiNote);
    }

    // Create oscillator for the note
    const oscillator = this.ctx.createOscillator();
    const gainNode = this.ctx.createGain();

    // Convert MIDI note to frequency
    const frequency = 440 * Math.pow(2, (midiNote - 69) / 12);
    oscillator.frequency.setValueAtTime(frequency, this.ctx.currentTime);
    oscillator.type = 'sine';

    // Apply velocity as volume (0-127 → 0-1)
    const velocityGain = velocity / 127;
    gainNode.gain.setValueAtTime(velocityGain * track.volume, this.ctx.currentTime);

    oscillator.connect(gainNode);
    gainNode.connect(this.masterGain);

    oscillator.start(this.ctx.currentTime);

    // Schedule stop after duration
    oscillator.stop(this.ctx.currentTime + duration);

    track.activeNotes.set(midiNote, { oscillator, gain: gainNode });
  }

  /**
   * Stop a specific note on a track.
   */
  stopNote(midiNote: number, trackId: string): void {
    const track = this.tracks.get(trackId);
    if (!track) return;

    const note = track.activeNotes.get(midiNote);
    if (note) {
      try {
        note.oscillator.stop();
      } catch {
        // Already stopped
      }
      track.activeNotes.delete(midiNote);
    }
  }

  /**
   * Set the instrument for a track.
   */
  setInstrument(trackId: string, instrumentName: string): void {
    const track = this.getOrCreateTrack(trackId);
    track.instrument = instrumentName;
  }

  /**
   * Set the volume for a track (0-1).
   */
  setVolume(trackId: string, volume: number): void {
    const track = this.getOrCreateTrack(trackId);
    track.volume = Math.max(0, Math.min(1, volume));
  }

  /**
   * Get the current instrument for a track.
   */
  getInstrument(trackId: string): string {
    const track = this.tracks.get(trackId);
    return track?.instrument ?? 'piano';
  }

  /**
   * Get the current volume for a track.
   */
  getVolume(trackId: string): number {
    const track = this.tracks.get(trackId);
    return track?.volume ?? 0.8;
  }

  /**
   * Stop all notes on a track.
   */
  stopAll(trackId: string): void {
    const track = this.tracks.get(trackId);
    if (!track) return;

    for (const [, note] of track.activeNotes) {
      try {
        note.oscillator.stop();
      } catch {
        // Already stopped
      }
    }
    track.activeNotes.clear();
  }

  /**
   * Stop all notes on all tracks.
   */
  stopAllTracks(): void {
    for (const trackId of this.tracks.keys()) {
      this.stopAll(trackId);
    }
  }

  /**
   * Check if a SoundFont has been loaded.
   */
  isSoundFontLoaded(): boolean {
    return this.loadedSoundFont;
  }

  /**
   * Get the underlying AudioContext.
   */
  getAudioContext(): AudioContext {
    return this.ctx;
  }
}
