import { create } from 'zustand';
import type { Project, Track } from '@/types/music';

export interface AutoSaveData {
  project: Project;
  tracks: Track[];
}

interface AutoSaveState {
  save: (data: AutoSaveData) => void;
  load: () => AutoSaveData | null;
  clear: () => void;
  setDebounceDelay: (delay: number) => void;
}

const STORAGE_KEY = 'chord-composer-autosave';
let debounceDelay = 5000; // 5 seconds default
let saveTimeout: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(data: AutoSaveData): void {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }
  saveTimeout = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Ignore localStorage errors (quota exceeded, private mode, etc.)
    }
    saveTimeout = null;
  }, debounceDelay);
}

export const autoSaveStore = create<AutoSaveState>(() => ({
  save: (data: AutoSaveData) => {
    scheduleSave(data);
  },

  load: (): AutoSaveData | null => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return null;
      const parsed = JSON.parse(saved) as AutoSaveData;
      if (!parsed.project) return null;
      return parsed;
    } catch {
      return null;
    }
  },

  clear: () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore localStorage errors
    }
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
  },

  setDebounceDelay: (delay: number) => {
    debounceDelay = delay;
  },
}));
