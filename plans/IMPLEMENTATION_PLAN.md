# Chord Composer — TDD Implementation Plan

A test-driven development roadmap for building the Chord Composer web application. Each phase is structured as **Red → Green → Refactor**, with explicit test specifications, implementation tasks, and acceptance criteria. Agents should complete each phase in order before moving to the next.

---

## 0. Project Setup & Test Infrastructure

**Goal:** Establish the project scaffolding, testing framework, and CI pipeline.

### Tests to Write First (Red)

1. **`tests/engine/setup.test.ts`** — Verify the project structure compiles
   - TypeScript compiles with zero errors
   - Vite dev server starts without warnings
   - Test runner (Vitest) runs successfully

2. **`tests/engine/scales.test.ts`** — *Placeholder only* (tests will be written in Phase 1)
   - `describe("scales", () => { it("will be implemented in Phase 1", () => {}); })`

3. **`tests/engine/chords.test.ts`** — *Placeholder only*

4. **`tests/store/projectStore.test.ts`** — *Placeholder only*

5. **`tests/components/Transport.test.tsx`** — *Placeholder only*

### Implementation (Green)

1. Initialize project with Vite + React + TypeScript:
   ```bash
   npm create vite@latest chord-composer -- --template react-ts
   cd chord-composer
   ```

2. Install dependencies:
   ```bash
   npm install zustand @dnd-kit/core @dnd-kit/utilities
   npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom @types/node
   npm install -D tailwindcss postcss autoprefixer
   npx tailwindcss init -p
   ```

3. Configure `vite.config.ts` for Vitest:
   ```typescript
   /// <reference types="vitest" />
   import { defineConfig } from 'vite'
   import react from '@vitejs/plugin-react'

   export default defineConfig({
     plugins: [react()],
     test: {
       globals: true,
       environment: 'jsdom',
       setupFiles: './tests/setup.ts',
     },
   })
   ```

4. Create `tests/setup.ts`:
   ```typescript
   import '@testing-library/jest-dom/vitest'
   ```

5. Configure `tsconfig.json` with `paths` for `@/*`:
   ```json
   {
     "compilerOptions": {
       "baseUrl": ".",
       "paths": { "@/*": ["src/*"] }
     }
   }
   ```

6. Create `src/types/music.ts` with all interfaces from §1 below.

7. Create `src/utils/id.ts` — UUID generator utility.

8. Create `src/utils/constants.ts` — Note names, scale definitions, chord qualities.

### Refactor

- Ensure all placeholder tests pass
- Verify `npm test` runs cleanly
- Verify `npm run dev` starts the app

### Acceptance Criteria

- [ ] `npm test` runs and all tests pass (even placeholders)
- [ ] `npm run dev` starts the Vite dev server
- [ ] TypeScript compiles with zero errors
- [ ] Folder structure matches §7 below
- [ ] `tests/setup.ts` imports `@testing-library/jest-dom`

---

## Phase 1 — Core Data Model & Scale Engine

**Goal:** Implement the music theory engine (scales, chords) with full test coverage. This is the foundation — all other phases depend on it.

### Tests to Write First (Red)

#### 1.1 `tests/engine/scales.test.ts`

```typescript
describe("scales", () => {
  describe("getScaleIntervals", () => {
    it("returns major scale intervals [0,2,4,5,7,9,11]", () => {});
    it("returns natural minor scale intervals [0,2,3,5,7,8,10]", () => {});
    it("returns harmonic minor scale intervals [0,2,3,5,7,8,11]", () => {});
    it("returns dorian scale intervals [0,2,3,5,7,9,10]", () => {});
    it("returns pentatonic major intervals [0,2,4,7,9]", () => {});
    it("returns pentatonic minor intervals [0,3,5,7,10]", () => {});
    it("returns blues intervals [0,3,5,6,7,10]", () => {});
  });

  describe("getScalePitches", () => {
    it("returns C major pitches [0,2,4,5,7,9,11] for root 'C'", () => {});
    it("returns C# major pitches shifted by 1 semitone", () => {});
    it("returns Eb major pitches correctly (flat handling)", () => {});
    it("returns A minor pitches [9,11,0,2,4,5,7] for root 'A'", () => {});
    it("throws on invalid scale type", () => {});
    it("throws on invalid root note", () => {});
  });

  describe("isNoteInScale", () => {
    it("returns true for C in C major", () => {});
    it("returns false for C# in C major", () => {});
    it("returns true for A in C major", () => {});
    it("returns false for B in A minor", () => {});
  });

  describe("getNotesInOctave", () => {
    it("returns all C-major notes in octave 4 (MIDI 48-60)", () => {});
    it("returns all C-major notes in octaves 2-5", () => {});
    it("respects minOctave and maxOctave parameters", () => {});
  });

  describe("getScaleName", () => {
    it("returns 'C Major' for root 'C', type 'major'", () => {});
    it("returns 'Eb Minor' for root 'Eb', type 'minor'", () => {});
    it("handles 'C#' root correctly", () => {});
  });
});
```

#### 1.2 `tests/engine/chords.test.ts`

```typescript
describe("chords", () => {
  describe("getDiatonicChords", () => {
    it("returns 7 chords for C major [C, Dm, Em, F, G, Am, Bdim]", () => {});
    it("returns 7 chords for A minor [Am, Bdim, C, Dm, Em, F, G]", () => {});
    it("returns correct qualities for major scale", () => {});
    it("returns correct qualities for minor scale", () => {});
  });

  describe("getRomanNumeral", () => {
    it("returns 'I' for C in C major", () => {});
    it("returns 'ii' for Dm in C major", () => {});
    it("returns 'V' for G in C major", () => {});
    it("returns 'vi' for Am in C major", () => {});
    it("returns 'i' for Am in A minor", () => {});
    it("returns 'III' for C in A minor", () => {});
  });

  describe("chordFromRomanNumeral", () => {
    it("returns {root: 'C', quality: 'major'} for 'I' in C major", () => {});
    it("returns {root: 'D', quality: 'minor'} for 'ii' in C major", () => {});
    it("returns {root: 'B', quality: 'diminished'} for 'vii°' in C major", () => {});
    it("throws for invalid roman numeral", () => {});
  });

  describe("chordFromSymbol", () => {
    it("parses 'Cmaj7' into {root: 'C', intervals: [0,4,7,11]}", () => {});
    it("parses 'Dm9' into {root: 'D', intervals: [0,3,7,10,14]}", () => {});
    it("parses 'G7' into {root: 'G', intervals: [0,4,7,10]}", () => {});
    it("parses 'Am' into {root: 'A', intervals: [0,3,7]}", () => {});
    it("parses 'C/E' (inversion) into {root: 'C', bass: 'E'}", () => {});
    it("throws for invalid chord symbol", () => {});
  });

  describe("chordToNotes", () => {
    it("returns MIDI notes for C major triad in octave 4: [60,64,67]", () => {});
    it("returns MIDI notes for Dm in octave 4: [62,65,69]", () => {});
    it("returns inverted chord notes when inversion > 0", () => {});
    it("throws for invalid quality", () => {});
  });
});
```

### Implementation (Green)

1. **Create `src/types/music.ts`** — All TypeScript interfaces:
   ```typescript
   export type NoteName = 'C' | 'C#' | 'D' | 'D#' | 'E' | 'F' | 'F#' | 'G' | 'G#' | 'A' | 'A#' | 'B';
   export type ScaleType = 'major' | 'naturalMinor' | 'harmonicMinor' | 'melodicMinor'
     | 'dorian' | 'phrygian' | 'lydian' | 'mixolydian' | 'locrian'
     | 'pentatonicMajor' | 'pentatonicMinor' | 'blues';
   export type ChordQuality = 'major' | 'minor' | 'diminished' | 'augmented' | 'sus2' | 'sus4' | 'dominant7' | 'maj7' | 'min7' | 'dim7';

   export interface TimeSignature { beatsPerMeasure: number; beatUnit: number; }
   export interface Scale { root: NoteName; type: ScaleType; }
   export interface ChordSegment {
     id: string; romanNumeral?: string; chordSymbol?: string;
     duration: number; root?: NoteName; inversion?: number; quality?: ChordQuality;
   }
   export interface Note {
     id: string; pitch: number; startBeat: number; duration: number; velocity: number;
   }
   export interface Track {
     id: string; name: string; instrument: string;
     volume: number; pan: number; muted: boolean; solo: boolean;
   }
   export interface Bar {
     id: string; barIndex: number; scale: Scale;
     chords: ChordSegment[]; notes: Note[];
   }
   export interface Project {
     id: string; name: string; bpm: number; timeSignature: TimeSignature;
     key: NoteName; keyMode: 'major' | 'minor';
     tracks: Track[]; bars: Bar[];
     createdAt: Date; updatedAt: Date;
   }
   ```

2. **Create `src/engine/scales.ts`**:
   ```typescript
   export const SCALE_INTERVALS: Record<ScaleType, number[]> = { /* ... */ };
   export const NOTE_TO_SEMITONE: Record<NoteName, number> = { /* ... */ };
   export const SEMITONE_TO_NOTE: Record<number, NoteName> = { /* ... */ };

   export function getScaleIntervals(type: ScaleType): number[];
   export function getScalePitches(root: NoteName, type: ScaleType): number[];
   export function isNoteInScale(pitchClass: number, scale: Scale): boolean;
   export function getNotesInOctave(scale: Scale, minOctave: number, maxOctave: number): number[];
   export function getScaleName(root: NoteName, type: ScaleType): string;
   ```

3. **Create `src/engine/chords.ts`**:
   ```typescript
   export const DIATONIC_CHORD_QUALITIES_MAJOR: ChordQuality[] = ['major','minor','minor','major','major','minor','diminished'];
   export const DIATONIC_CHORD_QUALITIES_MINOR: ChordQuality[] = ['minor','diminished','major','minor','minor','major','major'];

   export function getDiatonicChords(scale: Scale): ChordInfo[];
   export function getRomanNumeral(chordRoot: NoteName, chordQuality: ChordQuality, scale: Scale): string;
   export function chordFromRomanNumeral(roman: string, scale: Scale): ChordInfo;
   export function chordFromSymbol(symbol: string): ChordData;
   export function chordToNotes(chord: ChordData, octave: number, inversion?: number): number[];
   ```

4. **Create `src/utils/id.ts`**:
   ```typescript
   export function generateId(): string;
   ```

5. **Create `src/utils/constants.ts`**:
   ```typescript
   export const NOTE_NAMES: NoteName[] = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
   export const SCALE_TYPES: ScaleType[] = /* ... */;
   export const DEFAULT_TIME_SIGNATURE = { beatsPerMeasure: 4, beatUnit: 4 };
   export const DEFAULT_BPM = 120;
   export const DEFAULT_KEY: NoteName = 'C';
   export const DEFAULT_KEY_MODE: 'major' | 'minor' = 'major';
   ```

### Refactor

- Ensure all tests pass with 100% branch coverage on `scales.ts` and `chords.ts`
- Extract magic numbers into named constants
- Add JSDoc comments to all exported functions

### Acceptance Criteria

- [ ] All `scales.test.ts` tests pass
- [ ] All `chords.test.ts` tests pass
- [ ] `getScalePitches('C', 'major')` returns `[0,2,4,5,7,9,11]`
- [ ] `getDiatonicChords({root:'C', type:'major'})` returns 7 chords with correct qualities
- [ ] `chordFromSymbol('Cmaj7')` parses correctly
- [ ] `chordToNotes` returns correct MIDI note numbers
- [ ] Invalid inputs throw descriptive errors
- [ ] No TypeScript errors

---

## Phase 2 — Project Store & State Management

**Goal:** Implement Zustand stores for project, track, and playback state with full test coverage. Auto-save to localStorage.

### Tests to Write First (Red)

#### 2.1 `tests/store/projectStore.test.ts`

```typescript
describe("projectStore", () => {
  beforeEach(() => { projectStore.getState().resetProject(); });

  describe("createProject", () => {
    it("creates a project with default values", () => {});
    it("sets bpm to 120 by default", () => {});
    it("sets timeSignature to 4/4 by default", () => {});
    it("sets key to C major by default", () => {});
    it("creates an empty bars array", () => {});
    it("creates an empty tracks array", () => {});
    it("generates a unique project id", () => {});
  });

  describe("setBpm", () => {
    it("updates bpm to 100", () => {});
    it("rejects bpm < 20", () => {});
    it("rejects bpm > 300", () => {});
  });

  describe("setTimeSignature", () => {
    it("sets 3/4 time signature", () => {});
    it("sets 6/8 time signature", () => {});
    it("rejects invalid numerator (< 2)", () => {});
    it("rejects invalid denominator (not 4 or 8)", () => {});
  });

  describe("setKey", () => {
    it("sets key to G major", () => {});
    it("sets key mode to minor", () => {});
    it("updates key and keyMode together", () => {});
  });

  describe("addBar", () => {
    it("adds a bar with the project's current key/scale", () => {});
    it("increments barIndex sequentially", () => {});
    it("generates a unique bar id", () => {});
    it("creates empty chords and notes arrays", () => {});
  });

  describe("removeBar", () => {});
  describe("updateBarScale", () => {});
  describe("resetProject", () => {});
});
```

#### 2.2 `tests/store/trackStore.test.ts`

```typescript
describe("trackStore", () => {
  beforeEach(() => { trackStore.getState().resetTracks(); });

  describe("addTrack", () => {
    it("adds a track with default name 'Track 1'", () => {});
    it("increments track names ('Track 1', 'Track 2')", () => {});
    it("sets volume to 1.0 by default", () => {});
    it("sets pan to 0 by default", () => {});
    it("sets muted and solo to false", () => {});
    it("generates a unique track id", () => {});
  });

  describe("removeTrack", () => {});
  describe("setTrackVolume", () => {});
  describe("setTrackPan", () => {});
  describe("toggleTrackMute", () => {});
  describe("toggleTrackSolo", () => {});
  describe("setTrackInstrument", () => {});
});
```

#### 2.3 `tests/store/playbackStore.test.ts`

```typescript
describe("playbackStore", () => {
  beforeEach(() => { playbackStore.getState().reset(); });

  describe("play", () => {});
  describe("pause", () => {});
  describe("stop", () => {});
  describe("setPlayheadPosition", () => {});
  describe("setLoopRegion", () => {});
});
```

#### 2.4 `tests/store/autoSaveStore.test.ts`

```typescript
describe("autoSaveStore", () => {
  it("saves project to localStorage after debounce", () => {});
  it("loads project from localStorage on init", () => {});
  it("clears localStorage on project reset", () => {});
  it("debounces saves (not every state change)", () => {});
});
```

### Implementation (Green)

1. **Create `src/store/projectStore.ts`**:
   ```typescript
   import { create } from 'zustand';
   import { Project, Bar, NoteName, ScaleType, TimeSignature } from '@/types/music';
   import { generateId } from '@/utils/id';
   import { DEFAULT_BPM, DEFAULT_TIME_SIGNATURE, DEFAULT_KEY, DEFAULT_KEY_MODE } from '@/utils/constants';

   interface ProjectState {
     project: Project | null;
     createProject: () => void;
     setBpm: (bpm: number) => void;
     setTimeSignature: (ts: TimeSignature) => void;
     setKey: (key: NoteName, mode?: 'major' | 'minor') => void;
     addBar: () => void;
     removeBar: (barId: string) => void;
     updateBarScale: (barId: string, scale: { root: NoteName; type: ScaleType }) => void;
     resetProject: () => void;
   }
   ```

2. **Create `src/store/trackStore.ts`**:
   ```typescript
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
   ```

3. **Create `src/store/playbackStore.ts`**:
   ```typescript
   interface PlaybackState {
     isPlaying: boolean;
     playheadBeat: number;       // global beat position
     loopStart: number | null;
     loopEnd: number | null;
     play: () => void;
     pause: () => void;
     stop: () => void;
     setPlayheadPosition: (beat: number) => void;
     setLoopRegion: (start: number, end: number) => void;
     reset: () => void;
   }
   ```

4. **Create `src/store/autoSaveStore.ts`** — Zustand middleware pattern for localStorage:
   ```typescript
   import { create } from 'zustand';
   import { persist, createJSONStorage } from 'zustand/middleware';

   // Wrap localStorage with debounce
   function createDebouncedStorage(delay = 5000) { /* ... */ }

   export const autoSaveStore = create(
     persist(
       (set, get) => ({ /* ... */ }),
       { name: 'chord-composer-autosave', storage: createDebouncedStorage() }
     )
   );
   ```

5. **Create `src/store/index.ts`** — Barrel export.

### Refactor

- Extract store selectors into custom hooks (`useProject`, `useTracks`, `usePlayback`)
- Ensure stores are immutable (no direct mutation)
- Add error boundaries for localStorage read/write failures

### Acceptance Criteria

- [ ] All store tests pass
- [ ] `createProject()` produces a valid Project with defaults
- [ ] `setBpm(100)` updates state; `setBpm(10)` throws
- [ ] `addBar()` creates a bar with correct barIndex
- [ ] Auto-save persists to localStorage after 5s debounce
- [ ] Auto-load restores project from localStorage on init
- [ ] `resetProject()` clears all state and localStorage
- [ ] No Zustand middleware warnings

---

## Phase 3 — Piano Roll Component (Canvas)

**Goal:** Implement the Canvas-based piano roll with note placement, scale filtering, and grid snapping.

### Tests to Write First (Red)

#### 3.1 `tests/engine/quantize.test.ts`

```typescript
describe("quantize", () => {
  describe("snapToGrid", () => {
    it("snaps 0.3 to 0.25 (1/4 grid)", () => {});
    it("snaps 0.6 to 0.5 (1/2 grid)", () => {});
    it("snaps 0.125 to 0.125 (1/8 grid)", () => {});
    it("snaps 0.0625 to 0.0625 (1/16 grid)", () => {});
    it("snaps to nearest beat for 1/1 grid", () => {});
  });

  describe("beatToPixel", () => {});
  describe("pixelToBeat", () => {});
  describe("pitchToPixel", () => {});
  describe("pixelToPitch", () => {});
  describe("getVisibleBars", () => {});
});
```

#### 3.2 `tests/components/PianoRoll.test.tsx`

```typescript
describe("PianoRoll", () => {
  it("renders a canvas element", () => {});
  it("renders grid lines for beats", () => {});
  it("renders pitch labels on Y-axis", () => {});
  it("renders note rectangles for placed notes", () => {});
  it("filters notes by current bar's scale", () => {});
  it("disables click on notes outside the scale", () => {});
  it("snaps placed notes to grid", () => {});
  it("shows playhead line at current position", () => {});
  it("highlights the active bar", () => {});
});
```

### Implementation (Green)

1. **Create `src/engine/quantize.ts`**:
   ```typescript
   export function snapToGrid(beat: number, gridSize: number): number;
   export function beatToPixel(beat: number, pixelsPerBeat: number): number;
   export function pixelToBeat(pixel: number, pixelsPerBeat: number): number;
   export function pitchToPixel(midiNote: number, pixelsPerOctave: number): number;
   export function pixelToPitch(pixel: number, pixelsPerOctave: number): number;
   export function getVisibleBars(viewport: { start: number; end: number }, bars: Bar[]): Bar[];
   ```

2. **Create `src/components/PianoRoll.tsx`** — Canvas-based component:
   ```typescript
   interface PianoRollProps {
     bars: Bar[];
     selectedBarId: string;
     playheadBeat: number;
     pixelsPerBeat: number;
     pixelsPerOctave: number;
     gridSize: number;
     onNoteClick: (barId: string, pitch: number, beat: number) => void;
     onNoteDrag: (noteId: string, durationDelta: number) => void;
   }
   ```
   - Use `useRef<HTMLCanvasElement>` for canvas
   - Use `requestAnimationFrame` for playhead animation
   - Implement hit detection for note placement/removal
   - Scale filtering: only draw clickable areas for scale-valid notes

3. **Create `src/components/NoteCanvas.tsx`** — Low-level canvas renderer:
   - Grid lines (beats, bars)
   - Note rectangles (colored by track)
   - Playhead line
   - Active bar highlight

4. **Create `src/hooks/usePianoRoll.ts`** — Canvas interaction hook:
   - Mouse/touch event handlers
   - Hit detection logic
   - Drag-to-resize logic

### Refactor

- Extract canvas drawing into a pure function `renderPianoRoll(ctx, config)` for testability
- Memoize canvas rendering with `useMemo`
- Ensure canvas resizes correctly on window resize

### Acceptance Criteria

- [ ] All quantize tests pass
- [ ] All PianoRoll tests pass
- [ ] Clicking on a scale-valid note places it on the grid
- [ ] Clicking on a scale-invalid note does nothing
- [ ] Notes snap to the configured grid size
- [ ] Playhead animates smoothly during playback
- [ ] Canvas renders 60fps during idle
- [ ] Touch events work on mobile

---

## Phase 4 — Chord Editor

**Goal:** Implement drag-and-drop chord blocks with Roman numeral support and bar splitting.

### Tests to Write First (Red)

#### 4.1 `tests/engine/chordOperations.test.ts`

```typescript
describe("chordOperations", () => {
  describe("splitBarIntoChords", () => {
    it("splits a 4/4 bar into 4 quarter-note chords", () => {});
    it("splits a 4/4 bar into 2 half-note chords", () => {});
    it("preserves total duration equals bar length", () => {});
    it("throws if chord durations exceed bar length", () => {});
  });

  describe("reorderChords", () => {});
  describe("autoFillNotesFromChords", () => {});
  describe("mergeAdjacentChords", () => {});
  describe("getChordDuration", () => {});
});
```

#### 4.2 `tests/components/ChordEditor.test.tsx`

```typescript
describe("ChordEditor", () => {
  it("renders chord blocks for diatonic chords", () => {});
  it("renders Roman numeral labels", () => {});
  it("renders chord symbols (e.g. 'I → Cmaj')", () => {});
  it("allows dragging chord blocks to reorder", () => {});
  it("updates bar chords on reorder", () => {});
  it("allows adding custom chord symbols", () => {});
  it("splits bar when dragging between blocks", () => {});
  it("highlights the selected chord", () => {});
  it("auto-fills piano roll notes when clicking a chord", () => {});
});
```

### Implementation (Green)

1. **Create `src/engine/chordOperations.ts`**:
   ```typescript
   export function splitBarIntoChords(
     bar: Bar,
     chordCount: number
   ): ChordSegment[];

   export function reorderChords(
     chords: ChordSegment[],
     fromIndex: number,
     toIndex: number
   ): ChordSegment[];

   export function autoFillNotesFromChords(
     bar: Bar,
     chords: ChordSegment[],
     octave: number
   ): Note[];

   export function mergeAdjacentChords(
     chords: ChordSegment[]
   ): ChordSegment[];

   export function getChordDuration(chord: ChordSegment, beatsPerMeasure: number): number;
   ```

2. **Create `src/components/ChordEditor.tsx`**:
   ```typescript
   interface ChordEditorProps {
     bar: Bar;
     scale: Scale;
     onChordReorder: (chords: ChordSegment[]) => void;
     onChordAdd: (chord: ChordSegment) => void;
     onChordRemove: (chordId: string) => void;
     onBarSplit: (chordCount: number) => void;
     onAutoFillNotes: () => void;
     onCustomChordInput: (symbol: string) => void;
   }
   ```
   - Use `@dnd-kit/core` for drag-and-drop
   - Render chord blocks as draggable items
   - Show "Add Chord" button for custom input
   - Show "Split Bar" dropdown (2, 3, 4 segments)

3. **Create `src/components/ChordBlock.tsx`**:
   - Display: Roman numeral + chord symbol
   - Draggable handle
   - Click to select
   - Hover to show chord preview

4. **Create `src/hooks/useChordDragDrop.ts`**:
   - `onDragEnd` handler for reordering
   - `onDragOver` handler for split detection
   - Touch-compatible drag logic

### Refactor

- Extract chord block rendering into a separate component
- Ensure drag-and-drop works on both mouse and touch
- Add keyboard navigation (arrow keys to reorder, Enter to select)

### Acceptance Criteria

- [ ] All chordOperations tests pass
- [ ] All ChordEditor tests pass
- [ ] Roman numeral blocks render correctly for the current scale
- [ ] Dragging a block reorders chords in the bar
- [ ] Splitting a bar creates equal-duration chord segments
- [ ] Auto-fill places correct notes on the piano roll
- [ ] Custom chord symbols are accepted and rendered
- [ ] Touch drag works on mobile

---

## Phase 5 — Playback Engine

**Goal:** Implement Web Audio API playback with SoundFont instrument support, metronome, and loop region.

### Tests to Write First (Red)

#### 5.1 `tests/engine/playback.test.ts`

```typescript
describe("playback", () => {
  describe("calculateNoteTiming", () => {
    it("calculates correct start time for each note", () => {});
    it("handles different time signatures", () => {});
    it("handles notes spanning bar boundaries", () => {});
    it("respects BPM for timing", () => {});
  });

  describe("scheduleNotes", () => {});
  describe("getLoopDuration", () => {});
  describe("calculateMetronomeBeats", () => {});
});
```

#### 5.2 `tests/engine/soundfontPlayer.test.ts`

```typescript
describe("soundfontPlayer", () => {
  describe("loadSoundFont", () => {});
  describe("playNote", () => {});
  describe("stopNote", () => {});
  describe("setInstrument", () => {});
  describe("setVolume", () => {});
});
```

#### 5.3 `tests/components/Transport.test.tsx`

```typescript
describe("Transport", () => {
  it("renders play/pause/stop buttons", () => {});
  it("shows current BPM", () => {});
  it("shows current time signature", () => {});
  it("shows current key", () => {});
  it("toggles play on play button click", () => {});
  it("toggles pause on pause button click", () => {});
  it("resets position on stop button click", () => {});
  it("shows loop region controls", () => {});
  it("toggles metronome on click", () => {});
});
```

### Implementation (Green)

1. **Create `src/engine/playback.ts`**:
   ```typescript
   export interface PlaybackConfig {
     bpm: number;
     timeSignature: TimeSignature;
     bars: Bar[];
     tracks: Track[];
     loopStart: number | null;
     loopEnd: number | null;
   }

   export function calculateNoteTiming(config: PlaybackConfig): NoteTiming[];
   export function scheduleNotes(
     audioContext: AudioContext,
     notes: NoteTiming[],
     startOffset: number
   ): void;
   export function getLoopDuration(config: PlaybackConfig): number;
   export function calculateMetronomeBeats(
     timeSignature: TimeSignature,
     totalBars: number
   ): number[];
   ```

2. **Create `src/engine/soundfontPlayer.ts`**:
   ```typescript
   export class SoundFontPlayer {
     constructor(audioContext: AudioContext);
     loadSoundFont(sf2File: File): Promise<void>;
     playNote(midiNote: number, velocity: number, duration: number, trackId: string): void;
     stopNote(midiNote: number, trackId: string): void;
     setInstrument(trackId: string, instrumentName: string): void;
     setVolume(trackId: string, volume: number): void;
   }
   ```
   - Use `soundfont-player` or `sf2-player` library
   - Parse SF2 files into playable samples
   - Fallback to Web Audio oscillators if no SF2 loaded

3. **Create `src/hooks/useAudioContext.ts`**:
   - Manage AudioContext lifecycle (resume on user gesture)
   - Handle autoplay policies

4. **Create `src/hooks/usePlayback.ts`**:
   - Schedule notes ahead of time using Web Audio scheduling
   - Update playhead position
   - Handle loop region

5. **Create `src/components/Transport.tsx`**:
   - Play/Pause/Stop buttons
   - BPM display and control
   - Time signature display
   - Key display
   - Loop region toggles
   - Metronome toggle

### Refactor

- Ensure audio scheduling uses Web Audio's `currentTime` (not `setInterval`)
- Add error handling for missing SF2 files
- Optimize note scheduling to avoid GC pressure

### Acceptance Criteria

- [ ] All playback tests pass
- [ ] All soundfontPlayer tests pass
- [ ] All Transport tests pass
- [ ] Playback starts on user gesture
- [ ] Notes play with correct timing
- [ ] Loop region repeats correctly
- [ ] Metronome clicks on beat
- [ ] SoundFont instruments load and play
- [ ] Fallback to oscillator if no SF2
- [ ] No audio glitches or drift

---

## Phase 6 — File I/O & Persistence

**Goal:** Implement save/load JSON, auto-save, and MIDI/MusicXML export/import.

### Tests to Write First (Red)

#### 6.1 `tests/engine/fileIO.test.ts`

```typescript
describe("fileIO", () => {
  describe("serializeProject", () => {
    it("serializes a project to JSON", () => {});
    it("includes all project fields", () => {});
    it("excludes computed fields", () => {});
  });

  describe("deserializeProject", () => {});
  describe("validateProject", () => {});
  describe("saveToFile", () => {});
  describe("loadFromFile", () => {});
  describe("autoSaveToLocalStorage", () => {});
  describe("loadFromLocalStorage", () => {});
});
```

#### 6.2 `tests/engine/midiExporter.test.ts`

```typescript
describe("midiExporter", () => {
  describe("projectToMidi", () => {
    it("exports a project to MIDI bytes", () => {});
    it("creates one track per project track", () => {});
    it("maps channel 1-16 to tracks", () => {});
    it("writes note on/off events with correct timing", () => {});
    it("writes tempo meta event", () => {});
    it("writes time signature meta event", () => {});
  });

  describe("midiToProject", () => {});
});
```

#### 6.3 `tests/engine/musicxmlExporter.test.ts`

```typescript
describe("musicxmlExporter", () => {
  describe("projectToMusicXML", () => {
    it("exports a project to MusicXML string", () => {});
    it("creates one part per track", () => {});
    it("writes chord symbols as harmony tags", () => {});
    it("writes notes as standard notation", () => {});
    it("includes time signature", () => {});
    it("includes key signature", () => {});
  });
});
```

### Implementation (Green)

1. **Create `src/engine/fileIO.ts`**:
   ```typescript
   export function serializeProject(project: Project): string;
   export function deserializeProject(json: string): Project;
   export function validateProject(project: Project): ValidationResult;
   export function saveToFile(project: Project, filename: string): Promise<void>;
   export function loadFromFile(file: File): Promise<Project>;
   export function autoSaveToLocalStorage(project: Project): void;
   export function loadFromLocalStorage(): Project | null;
   ```

2. **Create `src/engine/midiExporter.ts`**:
   ```typescript
   export function projectToMidi(project: Project): Uint8Array;
   export function midiToProject(midiBytes: Uint8Array): Project;
   ```
   - Use `tinyMIDIWriter` or custom MIDI writer
   - One track per project track
   - Quarter-note resolution

3. **Create `src/engine/musicxmlExporter.ts`**:
   ```typescript
   export function projectToMusicXML(project: Project): string;
   ```
   - Custom serializer (or use `musicxml-builder`)
   - One part per track
   - Chord symbols as `<harmony>` tags
   - Notes as `<note>` elements

4. **Create `src/hooks/useFileIO.ts`**:
   - `handleSave` — triggers File System Access API or download
   - `handleLoad` — file picker → parse → update store
   - `handleExportMidi` — generate MIDI → download
   - `handleExportMusicXML` — generate XML → download
   - `handleImportMidi` — file picker → parse → update store

5. **Create `src/components/FileMenu.tsx`**:
   - File menu with Save, Load, Export MIDI, Export MusicXML, Import MIDI
   - Auto-save status indicator

### Refactor

- Add version field to JSON schema for future compatibility
- Graceful error handling for invalid files
- Fallback from File System Access API to download/upload for older browsers

### Acceptance Criteria

- [ ] All fileIO tests pass
- [ ] All midiExporter tests pass
- [ ] All musicxmlExporter tests pass
- [ ] Save produces valid JSON file
- [ ] Load restores project state correctly
- [ ] Auto-save persists to localStorage
- [ ] Export MIDI produces playable .mid file
- [ ] Export MusicXML produces valid .xml file
- [ ] Import MIDI reconstructs project
- [ ] Invalid files show error messages

---

## Phase 7 — Polish & Responsive UI

**Goal:** Add remaining UI features, responsive layout, touch support, and undo/redo.

### Tests to Write First (Red)

#### 7.1 `tests/engine/undoRedo.test.ts`

```typescript
describe("undoRedo", () => {
  describe("pushState", () => {});
  describe("undo", () => {});
  describe("redo", () => {});
  describe("clearHistory", () => {});
  describe("maxHistorySize", () => {});
});
```

#### 7.2 `tests/components/TrackList.test.tsx`

```typescript
describe("TrackList", () => {
  it("renders all tracks", () => {});
  it("shows track name", () => {});
  it("shows mute/solo/volume/pan controls", () => {});
  it("allows adding a new track", () => {});
  it("allows removing a track", () => {});
  it("highlights the selected track", () => {});
  it("toggles mute on button click", () => {});
  it("toggles solo on button click", () => {});
  it("updates volume on slider change", () => {});
  it("updates pan on slider change", () => {});
});
```

#### 7.3 `tests/components/ScaleEditor.test.tsx`

```typescript
describe("ScaleEditor", () => {
  it("renders root note selector", () => {});
  it("renders scale type selector", () => {});
  it("shows active notes visually", () => {});
  it("updates scale when root changes", () => {});
  it("updates scale when type changes", () => {});
  it("highlights active notes on piano keyboard", () => {});
});
```

### Implementation (Green)

1. **Create `src/engine/undoRedo.ts`**:
   ```typescript
   export function createUndoRedoMiddleware<T>(
     initialState: T,
     maxHistory: number
   ): {
     pushState: (state: T) => void;
     undo: () => T | null;
     redo: () => T | null;
     clearHistory: () => void;
   };
   ```

2. **Create `src/components/TrackList.tsx`**:
   - List of track headers
   - Mute/Solo/Vol/Pan controls per track
   - Add/Remove track buttons

3. **Create `src/components/ScaleEditor.tsx`**:
   - Root note dropdown
   - Scale type dropdown
   - Visual active note display (piano keyboard or dot grid)

4. **Create `src/components/ProjectSettings.tsx`**:
   - BPM slider + numeric input
   - Time signature dropdown
   - Key selector
   - Number of bars control

5. **Create `src/components/Timeline.tsx`**:
   - Bar headers with chord blocks
   - Chord block rendering
   - Click-to-select bar
   - Scrollable timeline

6. **Create `src/hooks/useUndoRedo.ts`**:
   - Keyboard shortcuts (Ctrl+Z, Ctrl+Shift+Z)
   - Undo/redo actions bound to store updates

7. **Responsive CSS** — Tailwind breakpoints:
   - Desktop: full layout (sidebar + timeline + piano roll)
   - Tablet: collapsed sidebar, wider timeline
   - Mobile: stacked layout, touch-optimized controls

### Refactor

- Ensure all components are responsive
- Add keyboard shortcuts for common actions
- Optimize canvas rendering for smooth scrolling
- Add loading states for SF2 file loading

### Acceptance Criteria

- [ ] All component tests pass
- [ ] Undo/redo works for all state changes
- [ ] Track controls update state correctly
- [ ] Scale editor updates bar scale
- [ ] Layout is responsive on tablet and mobile
- [ ] Touch gestures work on piano roll
- [ ] Keyboard shortcuts function correctly
- [ ] No layout shifts on resize

---

## Phase 8 — Advanced Features

**Goal:** Velocity editing, copy/paste, zoom, WAV export, and instrument management.

### Tests to Write First (Red)

#### 8.1 `tests/engine/clipboard.test.ts`

```typescript
describe("clipboard", () => {
  describe("copyNotes", () => {});
  describe("pasteNotes", () => {});
  describe("cutNotes", () => {});
  describe("copyBar", () => {});
  describe("pasteBar", () => {});
  describe("clearClipboard", () => {});
});
```

#### 8.2 `tests/engine/wavExporter.test.ts`

```typescript
describe("wavExporter", () => {
  describe("projectToWav", () => {
    it("renders a project to WAV bytes", () => {});
    it("uses correct sample rate", () => {});
    bit("handles multiple tracks", () => {});
    it("handles loop region", () => {});
  });
});
```

#### 8.3 `tests/engine/zoom.test.ts`

```typescript
describe("zoom", () => {
  describe("calculateZoomLevel", () => {});
  describe("applyZoom", () => {});
  describe("getZoomedPixelsPerBeat", () => {});
});
```

### Implementation (Green)

1. **Create `src/engine/clipboard.ts`**:
   ```typescript
   export interface ClipboardData {
     type: 'notes' | 'bar';
     data: Note[] | Bar;
   }

   export function copyNotes(notes: Note[]): ClipboardData;
   export function pasteNotes(clipboard: ClipboardData, targetBarId: string, offset: number): Note[];
   export function cutNotes(notes: Note[]): { clipboard: ClipboardData; remaining: Note[] };
   export function copyBar(bar: Bar): ClipboardData;
   export function pasteBar(clipboard: ClipboardData, afterBarIndex: number): Bar;
   ```

2. **Create `src/engine/wavExporter.ts`**:
   ```typescript
   export function projectToWav(project: Project): Promise<Uint8Array>;
   ```
   - Render audio to buffer using ScriptProcessorNode or OfflineAudioContext
   - Encode as WAV

3. **Create `src/hooks/useZoom.ts`**:
   - Mouse wheel zoom on piano roll
   - Zoom level state (0.5x to 4x)
   - Update pixelsPerBeat based on zoom

4. **Create `src/components/InstrumentManager.tsx`**:
   - File picker for SF2 files
   - List of loaded instruments
   - Assign instrument to track

5. **Create `src/components/NoteVelocityEditor.tsx`**:
   - Velocity display per note
   - Click to adjust velocity
   - Visual velocity bar

### Refactor

- Extract zoom logic into reusable hook
- Ensure clipboard works across tracks
- Optimize WAV export for large projects

### Acceptance Criteria

- [ ] All tests pass
- [ ] Copy/paste notes works correctly
- [ ] Copy/paste bars works correctly
- [ ] WAV export produces playable file
- [ ] Zoom changes grid density
- [ ] SF2 file loading works
- [ ] Velocity is editable per note

---

## Appendix A: Test Runner Commands

```bash
# Run all tests
npm test

# Run tests in watch mode
npm test -- --watch

# Run tests with coverage
npm test -- --coverage

# Run a specific test file
npm test -- scales.test.ts

# Run tests matching a pattern
npm test -- --testNamePattern="getScalePitches"
```

## Appendix B: Project Scripts

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "test": "vitest",
    "test:run": "vitest run",
    "test:coverage": "vitest run --coverage",
    "lint": "eslint src --ext .ts,.tsx",
    "lint:fix": "eslint src --ext .ts,.tsx --fix"
  }
}
```

## Appendix C: Agent Implementation Guidelines

### For Each Phase, Follow This Order:

1. **Read the test specifications** in the "Tests to Write First (Red)" section
2. **Write the tests** — they should fail (Red)
3. **Implement the code** to make tests pass (Green)
4. **Refactor** — clean up code, improve readability, add docs (Refactor)
5. **Verify** — run `npm test` and ensure all tests pass
6. **Commit** — commit the phase before starting the next

### Testing Principles:

- **Unit tests first** — test pure functions before components
- **Component tests** — use `@testing-library/react` for React components
- **No integration tests needed** — unit + component tests are sufficient
- **Mock external dependencies** — AudioContext, File System Access API
- **Aim for 80%+ coverage** on engine code, 60%+ on components

### Common Patterns:

- Use `generateId()` for all IDs
- Use Zustand stores for all state
- Use Canvas for piano roll rendering
- Use `@dnd-kit` for drag-and-drop
- Use Web Audio API for playback
- Use SoundFont for instrument playback

---

*Implementation Plan v1.0 — TDD-focused, agent-ready.*
