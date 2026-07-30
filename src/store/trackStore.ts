import { create } from 'zustand';
import { Track } from '@/types/music';
import { generateId } from '@/utils/id';

interface TrackState {
  tracks: Track[];
  addTrack: (name?: string) => void;
  removeTrack: (trackId: string) => void;
  setTrackVolume: (trackId: string, volume: number) => void;
  setTrackPan: (trackId: string, pan: number) => void;
  toggleTrackMute: (trackId: string) => void;
  toggleTrackSolo: (trackId: string) => void;
  setTrackInstrument: (trackId: string, instrument: string) => void;
  resetTracks: () => void;
}

let trackCounter = 0;

export const trackStore = create<TrackState>((set, get) => ({
  tracks: [],

  addTrack: (name?: string) => {
    const tracks = get().tracks;
    const nextNum = trackCounter + 1;
    const trackName = name || `Track ${nextNum}`;
    if (!name) {
      trackCounter++;
    }
    const newTrack: Track = {
      id: generateId(),
      name: trackName,
      instrument: '',
      volume: 1.0,
      pan: 0,
      muted: false,
      solo: false,
    };
    set({ tracks: [...tracks, newTrack] });
  },

  removeTrack: (trackId: string) => {
    const tracks = get().tracks;
    const index = tracks.findIndex(t => t.id === trackId);
    if (index === -1) {
      throw new Error('Track not found');
    }
    set({ tracks: tracks.filter(t => t.id !== trackId) });
  },

  setTrackVolume: (trackId: string, volume: number) => {
    if (volume < 0 || volume > 1) {
      throw new Error('Volume must be between 0 and 1');
    }
    const tracks = get().tracks;
    const index = tracks.findIndex(t => t.id === trackId);
    if (index === -1) {
      throw new Error('Track not found');
    }
    const newTracks = tracks.map((t, i) =>
      i === index ? { ...t, volume } : t
    );
    set({ tracks: newTracks });
  },

  setTrackPan: (trackId: string, pan: number) => {
    if (pan < -1 || pan > 1) {
      throw new Error('Pan must be between -1 and 1');
    }
    const tracks = get().tracks;
    const index = tracks.findIndex(t => t.id === trackId);
    if (index === -1) {
      throw new Error('Track not found');
    }
    const newTracks = tracks.map((t, i) =>
      i === index ? { ...t, pan } : t
    );
    set({ tracks: newTracks });
  },

  toggleTrackMute: (trackId: string) => {
    const tracks = get().tracks;
    const index = tracks.findIndex(t => t.id === trackId);
    if (index === -1) {
      throw new Error('Track not found');
    }
    const newTracks = tracks.map((t, i) =>
      i === index ? { ...t, muted: !t.muted } : t
    );
    set({ tracks: newTracks });
  },

  toggleTrackSolo: (trackId: string) => {
    const tracks = get().tracks;
    const index = tracks.findIndex(t => t.id === trackId);
    if (index === -1) {
      throw new Error('Track not found');
    }
    const newTracks = tracks.map((t, i) =>
      i === index ? { ...t, solo: !t.solo } : t
    );
    set({ tracks: newTracks });
  },

  setTrackInstrument: (trackId: string, instrument: string) => {
    const tracks = get().tracks;
    const index = tracks.findIndex(t => t.id === trackId);
    if (index === -1) {
      throw new Error('Track not found');
    }
    const newTracks = tracks.map((t, i) =>
      i === index ? { ...t, instrument } : t
    );
    set({ tracks: newTracks });
  },

  resetTracks: () => {
    set({ tracks: [] });
    trackCounter = 0;
  },
}));
