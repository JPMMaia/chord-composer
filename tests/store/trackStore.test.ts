import { describe, it, expect, beforeEach } from 'vitest';
import { trackStore } from '@/store/trackStore';

describe('trackStore', () => {
  beforeEach(() => {
    trackStore.getState().resetTracks();
  });

  describe('addTrack', () => {
    it('adds a track with default name "Track 1"', () => {
      trackStore.getState().addTrack();
      const tracks = trackStore.getState().tracks;
      expect(tracks.length).toBe(1);
      expect(tracks[0].name).toBe('Track 1');
    });

    it('increments track names ("Track 1", "Track 2")', () => {
      trackStore.getState().addTrack();
      trackStore.getState().addTrack();
      trackStore.getState().addTrack();
      const tracks = trackStore.getState().tracks;
      expect(tracks[0].name).toBe('Track 1');
      expect(tracks[1].name).toBe('Track 2');
      expect(tracks[2].name).toBe('Track 3');
    });

    it('sets volume to 1.0 by default', () => {
      trackStore.getState().addTrack();
      expect(trackStore.getState().tracks[0].volume).toBe(1.0);
    });

    it('sets pan to 0 by default', () => {
      trackStore.getState().addTrack();
      expect(trackStore.getState().tracks[0].pan).toBe(0);
    });

    it('sets muted and solo to false', () => {
      trackStore.getState().addTrack();
      expect(trackStore.getState().tracks[0].muted).toBe(false);
      expect(trackStore.getState().tracks[0].solo).toBe(false);
    });

    it('generates a unique track id', () => {
      trackStore.getState().addTrack();
      trackStore.getState().addTrack();
      const tracks = trackStore.getState().tracks;
      expect(tracks[0].id).not.toBe(tracks[1].id);
    });

    it('sets default instrument to empty string', () => {
      trackStore.getState().addTrack();
      expect(trackStore.getState().tracks[0].instrument).toBe('');
    });

    it('accepts a custom name', () => {
      trackStore.getState().addTrack('Bass');
      expect(trackStore.getState().tracks[0].name).toBe('Bass');
    });

    it('continues naming after custom-named track', () => {
      trackStore.getState().addTrack('Bass');
      trackStore.getState().addTrack();
      expect(trackStore.getState().tracks[0].name).toBe('Bass');
      expect(trackStore.getState().tracks[1].name).toBe('Track 1');
    });

    it('creates multiple tracks correctly', () => {
      for (let i = 0; i < 16; i++) {
        trackStore.getState().addTrack();
      }
      expect(trackStore.getState().tracks.length).toBe(16);
    });
  });

  describe('removeTrack', () => {
    beforeEach(() => {
      trackStore.getState().addTrack();
      trackStore.getState().addTrack();
      trackStore.getState().addTrack();
    });

    it('removes a track by id', () => {
      const trackId = trackStore.getState().tracks[1].id;
      trackStore.getState().removeTrack(trackId);
      expect(trackStore.getState().tracks.length).toBe(2);
    });

    it('removes the correct track', () => {
      const middleTrack = trackStore.getState().tracks[1];
      trackStore.getState().removeTrack(middleTrack.id);
      const tracks = trackStore.getState().tracks;
      expect(tracks[0].id).not.toBe(middleTrack.id);
      expect(tracks[1].id).not.toBe(middleTrack.id);
    });

    it('throws when track id does not exist', () => {
      expect(() => trackStore.getState().removeTrack('nonexistent-id')).toThrow('Track not found');
    });

    it('allows removing the first track', () => {
      const firstTrack = trackStore.getState().tracks[0];
      trackStore.getState().removeTrack(firstTrack.id);
      expect(trackStore.getState().tracks.length).toBe(2);
    });

    it('allows removing the last track', () => {
      const lastTrack = trackStore.getState().tracks[2];
      trackStore.getState().removeTrack(lastTrack.id);
      expect(trackStore.getState().tracks.length).toBe(2);
    });

    it('allows removing all tracks', () => {
      const tracks = [...trackStore.getState().tracks];
      for (const track of tracks) {
        trackStore.getState().removeTrack(track.id);
      }
      expect(trackStore.getState().tracks.length).toBe(0);
    });
  });

  describe('setTrackVolume', () => {
    beforeEach(() => {
      trackStore.getState().addTrack();
    });

    it('updates volume to 0.5', () => {
      trackStore.getState().setTrackVolume(trackStore.getState().tracks[0].id, 0.5);
      expect(trackStore.getState().tracks[0].volume).toBe(0.5);
    });

    it('updates volume to 0.0 (mute)', () => {
      trackStore.getState().setTrackVolume(trackStore.getState().tracks[0].id, 0.0);
      expect(trackStore.getState().tracks[0].volume).toBe(0.0);
    });

    it('updates volume to 1.0 (max)', () => {
      trackStore.getState().setTrackVolume(trackStore.getState().tracks[0].id, 1.0);
      expect(trackStore.getState().tracks[0].volume).toBe(1.0);
    });

    it('rejects volume < 0', () => {
      expect(() => trackStore.getState().setTrackVolume(trackStore.getState().tracks[0].id, -0.1)).toThrow('Volume must be between 0 and 1');
    });

    it('rejects volume > 1', () => {
      expect(() => trackStore.getState().setTrackVolume(trackStore.getState().tracks[0].id, 1.1)).toThrow('Volume must be between 0 and 1');
    });

    it('throws when track id does not exist', () => {
      expect(() => trackStore.getState().setTrackVolume('nonexistent', 0.5)).toThrow('Track not found');
    });
  });

  describe('setTrackPan', () => {
    beforeEach(() => {
      trackStore.getState().addTrack();
    });

    it('sets pan to -1 (full left)', () => {
      trackStore.getState().setTrackPan(trackStore.getState().tracks[0].id, -1);
      expect(trackStore.getState().tracks[0].pan).toBe(-1);
    });

    it('sets pan to 1 (full right)', () => {
      trackStore.getState().setTrackPan(trackStore.getState().tracks[0].id, 1);
      expect(trackStore.getState().tracks[0].pan).toBe(1);
    });

    it('sets pan to 0 (center)', () => {
      trackStore.getState().setTrackPan(trackStore.getState().tracks[0].id, 0);
      expect(trackStore.getState().tracks[0].pan).toBe(0);
    });

    it('sets pan to -0.5 (left)', () => {
      trackStore.getState().setTrackPan(trackStore.getState().tracks[0].id, -0.5);
      expect(trackStore.getState().tracks[0].pan).toBe(-0.5);
    });

    it('sets pan to 0.5 (right)', () => {
      trackStore.getState().setTrackPan(trackStore.getState().tracks[0].id, 0.5);
      expect(trackStore.getState().tracks[0].pan).toBe(0.5);
    });

    it('rejects pan < -1', () => {
      expect(() => trackStore.getState().setTrackPan(trackStore.getState().tracks[0].id, -1.1)).toThrow('Pan must be between -1 and 1');
    });

    it('rejects pan > 1', () => {
      expect(() => trackStore.getState().setTrackPan(trackStore.getState().tracks[0].id, 1.1)).toThrow('Pan must be between -1 and 1');
    });

    it('throws when track id does not exist', () => {
      expect(() => trackStore.getState().setTrackPan('nonexistent', 0)).toThrow('Track not found');
    });
  });

  describe('toggleTrackMute', () => {
    beforeEach(() => {
      trackStore.getState().addTrack();
    });

    it('mutes the track', () => {
      trackStore.getState().toggleTrackMute(trackStore.getState().tracks[0].id);
      expect(trackStore.getState().tracks[0].muted).toBe(true);
    });

    it('unmutes the track when already muted', () => {
      trackStore.getState().toggleTrackMute(trackStore.getState().tracks[0].id);
      trackStore.getState().toggleTrackMute(trackStore.getState().tracks[0].id);
      expect(trackStore.getState().tracks[0].muted).toBe(false);
    });

    it('throws when track id does not exist', () => {
      expect(() => trackStore.getState().toggleTrackMute('nonexistent')).toThrow('Track not found');
    });
  });

  describe('toggleTrackSolo', () => {
    beforeEach(() => {
      trackStore.getState().addTrack();
      trackStore.getState().addTrack();
    });

    it('solos the track', () => {
      trackStore.getState().toggleTrackSolo(trackStore.getState().tracks[0].id);
      expect(trackStore.getState().tracks[0].solo).toBe(true);
    });

    it('unsolos the track when already soloed', () => {
      trackStore.getState().toggleTrackSolo(trackStore.getState().tracks[0].id);
      trackStore.getState().toggleTrackSolo(trackStore.getState().tracks[0].id);
      expect(trackStore.getState().tracks[0].solo).toBe(false);
    });

    it('allows multiple tracks to be soloed', () => {
      trackStore.getState().toggleTrackSolo(trackStore.getState().tracks[0].id);
      trackStore.getState().toggleTrackSolo(trackStore.getState().tracks[1].id);
      expect(trackStore.getState().tracks[0].solo).toBe(true);
      expect(trackStore.getState().tracks[1].solo).toBe(true);
    });

    it('throws when track id does not exist', () => {
      expect(() => trackStore.getState().toggleTrackSolo('nonexistent')).toThrow('Track not found');
    });
  });

  describe('setTrackInstrument', () => {
    beforeEach(() => {
      trackStore.getState().addTrack();
    });

    it('sets the instrument name', () => {
      trackStore.getState().setTrackInstrument(trackStore.getState().tracks[0].id, 'Grand Piano');
      expect(trackStore.getState().tracks[0].instrument).toBe('Grand Piano');
    });

    it('updates existing instrument', () => {
      trackStore.getState().setTrackInstrument(trackStore.getState().tracks[0].id, 'Grand Piano');
      trackStore.getState().setTrackInstrument(trackStore.getState().tracks[0].id, 'Electric Piano');
      expect(trackStore.getState().tracks[0].instrument).toBe('Electric Piano');
    });

    it('throws when track id does not exist', () => {
      expect(() => trackStore.getState().setTrackInstrument('nonexistent', 'Piano')).toThrow('Track not found');
    });
  });

  describe('resetTracks', () => {
    it('clears all tracks', () => {
      trackStore.getState().addTrack();
      trackStore.getState().addTrack();
      trackStore.getState().resetTracks();
      expect(trackStore.getState().tracks.length).toBe(0);
    });

    it('can be followed by addTrack', () => {
      trackStore.getState().addTrack();
      trackStore.getState().resetTracks();
      trackStore.getState().addTrack();
      expect(trackStore.getState().tracks.length).toBe(1);
    });
  });
});
