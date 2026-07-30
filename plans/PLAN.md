# Chord Composer — Project Plan

## 1. Vision

A browser-based music composition application that lets users compose music track-by-track, constrained by musical scales and built with a drag-and-drop chord editor. The app saves and loads compositions to/from standard music files (MusicXML, MIDI).

---

## 2. Core Concepts

| Concept | Description |
|---------|-------------|
| **Project** | A composition containing one or more tracks, a tempo (BPM), a time signature, and a global key. |
| **Track** | A single instrument line (e.g. Piano, Bass, Guitar). Each track has its own instrument preset, volume, and pan. |
| **Bar / Measure** | A segment of the timeline defined by the project's time signature. |
| **Scale Constraint** | Per-bar scale selection (e.g. "C Major", "A Minor", "D Dorian") that limits which pitch classes are available for note input on that bar. |
| **Chord Block** | A draggable building block representing a Roman-numeral chord (I, ii, iii, IV, V, vi, vii°) or a custom chord symbol (e.g. "Cmaj7", "G/B"). |
| **Grid / Piano Roll** | The per-bar note editor where only scale-valid notes are selectable. |

---

## 3. Feature Breakdown

### 3.1 Project Settings
- Set **BPM** (tempo slider + numeric input)
- Set **Time Signature** (dropdown: 2/4, 3/4, 4/4, 6/8, 7/8, custom)
- Set **Key** (C, C#, D, …, B — major or minor)
- Set **number of bars** (or infinite scroll)

### 3.2 Track Management
- **Add / Remove tracks**
- Assign an **instrument preset** (SoundFont-based: piano, strings, guitar, bass, etc.)
- Per-track **volume** and **pan** sliders
- **Mute / Solo** toggle per track
- Visual track list / sidebar

### 3.3 Scale Editor (per bar)
- Select a **root note** (C, C#, D, …)
- Select a **scale type** (Major, Natural Minor, Harmonic Minor, Melodic Minor, Dorian, Phrygian, Lydian, Mixolydian, Locrian, Pentatonic Major, Pentatonic Minor, Blues)
- Visual display of which **pitches are active** for that bar
- The piano roll / note grid automatically filters to show only valid notes

### 3.4 Chord Editor
- **Roman numeral blocks** for diatonic chords in the selected scale:
  - Major scale: I, ii, iii, IV, V, vi, vii°
  - Minor scale: i, ii°, III, iv, v, VI, VII
- Each block shows the chord symbol (e.g. "I → Cmaj")
- **Drag and drop** to reorder chords within a bar (mouse + touch)
- **Split a bar** into multiple chord segments (e.g. bar split 50/50 or custom ratios)
- Click a chord block to **auto-fill notes** on the piano roll (root position, inversions)
- **Custom chord symbols** can be typed as alternatives (e.g. "Cmaj7", "Dm9", "G7#11")
- **Chord duration** control (whole bar, half bar, quarter bar, etc.)

### 3.5 Piano Roll / Note Editor
- Grid view: X-axis = time (beats/sub-beats), Y-axis = pitch
- Only notes belonging to the current bar's scale are **clickable / draggable**
- **Click to place** a note; click again to remove
- **Drag to resize** note duration
- **Pinch-to-zoom** and **two-finger pan** on touch devices
- **Velocity** control per note
- **Copy / Paste / Cut** notes
- **Snap to grid** (1/1, 1/2, 1/4, 1/8, 1/16)

### 3.6 Playback
- Play / Pause / Stop
- **Click-to-seek** on the timeline
- Per-bar **playhead preview**
- Metronome click option
- **Loop** selection
- Web Audio API–based real-time playback with SoundFont instruments (no server needed)

### 3.7 File I/O
- **Save** project to JSON (native format)
- **Load** project from JSON
- **Auto-save** to localStorage every 5 seconds (debounced on user activity)
- **Export** to MIDI (.mid)
- **Export** to MusicXML (.xml)
- **Import** MIDI (basic reconstruction into tracks)

---

## 4. Data Model

```typescript
interface Project {
  id: string;
  name: string;
  bpm: number;
  timeSignature: TimeSignature;
  key: string;          // e.g. "C", "G#", "Eb"
  keyMode: "major" | "minor";
  tracks: Track[];
  bars: Bar[];
  createdAt: Date;
  updatedAt: Date;
}

interface TimeSignature {
  beatsPerMeasure: number;   // numerator
  beatUnit: number;          // denominator (4 = quarter, 8 = eighth)
}

interface Track {
  id: string;
  name: string;
  instrument: InstrumentPreset;
  volume: number;             // 0–1
  pan: number;                // -1 to 1
  muted: boolean;
  solo: boolean;
}

interface Bar {
  id: string;
  barIndex: number;
  scale: Scale;
  chords: ChordSegment[];
  notes: Note[];              // piano-roll notes for this bar
}

interface Scale {
  root: string;               // e.g. "C"
  type: ScaleType;            // "major" | "minor" | "dorian" | ...
  // computed: pitchClasses: number[]  (0–11)
}

interface ChordSegment {
  id: string;
  romanNumeral?: string;      // "I", "ii", "V7", etc.
  chordSymbol?: string;       // "Cmaj7", "G/B", etc. (alternative)
  duration: number;           // in beats
  root?: string;              // if custom, the actual root
  inversion?: number;         // 0 = root position
}

interface Note {
  id: string;
  pitch: number;              // MIDI note number (60 = C4)
  startBeat: number;          // within the bar
  duration: number;           // in beats
  velocity: number;           // 0–127
}
```

---

## 5. Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Frontend (SPA)                    │
│                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │  UI Layer   │  │  State Layer │  │  Audio API │ │
│  │  (React)    │  │  (Zustand)   │  │  (Web Audio)│ │
│  └──────┬──────┘  └──────┬───────┘  └─────┬──────┘ │
│         │                │                 │        │
│  ┌──────▼────────────────▼─────────────────▼──────┐ │
│  │           Core Music Engine                     │ │
│  │  (scale math, chord theory, MIDI export,       │ │
│  │   MusicXML export, note quantization)           │ │
│  └────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
         │                         │
         ▼                         ▼
   ┌──────────┐            ┌──────────────┐
   │ JSON     │            │  MIDI /      │
   │ File I/O │            │  MusicXML    │
   └──────────┘            │  File I/O    │
                           └──────────────┘
```

### Key Design Decisions
- **No backend** — everything runs in the browser. Files are saved/loaded via the browser's File System Access API (with fallback to download/upload dialogs).
- **Single-page app** — no server rendering needed.
- **Web Audio API + SoundFont player** for sample-based instrument playback.
- **Zustand** for state management — lightweight, with `persist` middleware for localStorage auto-save.

---

## 6. Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| Framework | **React 18** + **Vite** | Fast dev server, large ecosystem |
| Language | **TypeScript** | Type safety for complex music math |
| State | **Zustand** | Minimal boilerplate, easy persistence |
| Drag & Drop | **@dnd-kit/core** | Modern, accessible, React-friendly |
| Audio | **Web Audio API** (native) | No dependencies for playback |
| MIDI | **@tonejs/midi** (parse) + **tinyMIDIWriter** (write) | Lightweight libraries |
| MusicXML | **musicxml-builder** or custom serializer | Standard export format |
| UI Components | **Radix UI** + **Tailwind CSS** | Accessible primitives, utility-first styling |
| Piano Roll | **Canvas** (raw, custom renderer) | Performant rendering for dense note grids |
| Persistence | **File System Access API** + localStorage fallback | Native file save/load |

---

## 7. Folder Structure

```
chord-composer/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.js
├── public/
│   └── favicon.ico
├── src/
│   ├── main.tsx                  # Entry point
│   ├── App.tsx                   # Root component + router
│   ├── index.css                 # Tailwind imports + global styles
│   │
│   ├── components/               # React UI components
│   │   ├── ProjectSettings.tsx   # BPM, time signature, key
│   │   ├── TrackList.tsx         # Track sidebar
│   │   ├── TrackHeader.tsx       # Per-track controls
│   │   ├── Timeline.tsx          # Main timeline / ruler
│   │   ├── Bar.tsx               # Single bar container
│   │   ├── ScaleEditor.tsx       # Scale picker + active-note display
│   │   ├── ChordEditor.tsx       # Drag-and-drop chord blocks
│   │   ├── ChordBlock.tsx        # Individual chord block component
│   │   ├── PianoRoll.tsx         # Note grid canvas
│   │   ├── Note.tsx              # Individual note rendering
│   │   ├── Playhead.tsx          # Animated playhead line
│   │   ├── Transport.tsx         # Play/Pause/Stop/Loop controls
│   │   └── FileMenu.tsx          # Save/Load/Export buttons
│   │
│   ├── store/                    # Zustand stores
│   │   ├── projectStore.ts       # Project-level state
│   │   ├── trackStore.ts         # Track management state
│   │   ├── playbackStore.ts      # Playback state (playing, position)
│   │   └── uiStore.ts            # UI state (selected bar, zoom, etc.)
│   │
│   ├── engine/                   # Pure music logic
│   │   ├── scales.ts             # Scale definitions & pitch-class math
│   │   ├── chords.ts             # Chord theory, Roman numeral mapping
│   │   ├── midiExporter.ts       # Project → MIDI bytes
│   │   ├── musicxmlExporter.ts   # Project → MusicXML string
│   │   ├── midiImporter.ts       # MIDI bytes → Project
│   │   ├── quantize.ts           # Snap notes to grid
│   │   └── synth.ts              # Web Audio API synthesizer
│   │
│   ├── types/                    # Shared TypeScript types
│   │   └── music.ts              # All interfaces from §4
│   │
│   ├── hooks/                    # Custom React hooks
│   │   ├── useAudioContext.ts    # Manage AudioContext lifecycle
│   │   ├── usePlayback.ts        # Playhead position, scheduling
│   │   ├── useDragDrop.ts        # DnD helpers for chord blocks
│   │   └── useFileIO.ts          # Save/Load/Export handlers
│   │
│   └── utils/                    # Helpers
│       ├── noteNames.ts          # MIDI number ↔ note name
│       ├── formatTime.ts         # Beats → MM:SS.ms
│       └── deepClone.ts          # Immutable state helpers
│
├── tests/
│   ├── engine/
│   │   ├── scales.test.ts
│   │   └── chords.test.ts
│   └── store/
│       └── projectStore.test.ts
│
└── PLAN.md                       # This file
```

---

## 8. UI Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  [File] [Edit] [View] [Export]          [Save] [Load] [MIDI]   │  ← Top Bar
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────┐  ┌───────────────────────────────────────────┐    │
│  │  Track   │  │              Timeline                       │    │
│  │  List    │  │                                           │    │
│  │          │  │  ┌─────┬─────┬─────┬─────┬─────┐          │    │
│  │  Piano   │  │  │ Bar 1 │ Bar 2 │ Bar 3 │ Bar 4 │ ...     │    │    │  ← Bar Headers
│  │  (Muted/ │  │  │ [I][V][vi][IV]│ ...          │          │    │    │  ← Chord Blocks
│  │  Solo/Vol)│ │  └─────┴─────┴─────┴─────┴─────┘          │    │    │
│  │          │  │                                           │    │    │
│  │ Guitar   │  │  ┌─────┬─────┬─────┬─────┬─────┐          │    │    │
│  │ ♪  M S ▮ │  │  │ Bar 5 │ Bar 6 │ Bar 7 │ Bar 8 │ ...     │    │    │
│  │          │  │  │ [ii][V][I][IV]│ ...          │          │    │    │
│  │ Bass     │  │  └─────┴─────┴─────┴─────┴─────┘          │    │    │
│  │ ♪  M S ▮ │  │                                           │    │    │
│  │          │  │  ┌───────────────────────────────────┐     │    │    │  ← Piano Roll
│  │ Drums    │  │  │   ▐▌          ▐▌   ▐▌              │     │    │    │
│  │ ♪  M S ▮ │  │  │   ▐  ▐▌▐          ▐▌   ▐▌         │     │    │    │
│  │          │  │  │   ▐  ▐  ▐▌    ▐▌    ▐  ▐  ▐▌      │     │    │    │
│  └──────────┘  │  │   ▐  ▐  ▐  ▐▌  ▐  ▐  ▐  ▐  ▐     │     │    │    │
│                │  │   └─────────────────────────────────┘     │    │    │
│  ┌──────────┐  └───────────────────────────────────────────┘    │
│  │ Scale    │                                                   │
│  │ Editor   │  ┌───────────────────────────────────────────┐    │
│  │          │  │  [◀◀] [▶] [■] [▶▶]  Tempo: 120  4/4  Key: C│    │  ← Transport
│  │ Root: C  │  └───────────────────────────────────────────┘    │
│  │ Type:    │                                                   │
│  │ Major ▼  │  ┌───────────────────────────────────────────┐    │
│  │          │  │  Active Notes: C D E F G A B              │    │
│  │ Notes:   │  │            [●] [●] [●] [●] [●] [●] [●]   │    │
│  │ C D E    │  └───────────────────────────────────────────┘    │
│  │ F G A B  │                                                   │
│  └──────────┘  └───────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 9. Implementation Phases

### Phase 1 — Foundation (MVP)
- [ ] Project scaffolding (Vite + React + TypeScript + Tailwind)
- [ ] Data model + Zustand stores
- [ ] Project settings (BPM, time signature, key)
- [ ] Track list with add/remove
- [ ] Basic piano roll on Canvas (click to place notes, grid snapping)
- [ ] Scale filtering (only show scale-valid notes)
- [ ] Web Audio playback with SoundFont-based instruments
- [ ] Save/Load JSON via File System Access API
- [ ] Auto-save to localStorage (every 5s, debounced)

### Phase 2 — Chord Editor
- [ ] Roman numeral chord blocks
- [ ] Drag-and-drop reordering (touch + mouse)
- [ ] Bar splitting (multiple chords per bar)
- [ ] Auto-fill notes from chord blocks
- [ ] Custom chord symbol input
- [ ] Touch-friendly chord block gestures (long-press, swipe)

### Phase 3 — Polish & Export
- [ ] Per-track volume/pan/mute/solo
- [ ] Metronome + loop region
- [ ] MIDI export
- [ ] MusicXML export
- [ ] MIDI import
- [ ] Undo/Redo (Zustand middleware)
- [ ] Responsive layout refinements
- [ ] Touch-friendly piano roll (pinch-zoom, two-finger pan)
- [ ] Adaptive UI for tablet viewports

### Phase 4 — Advanced Features
- [ ] Note velocity editing
- [ ] Copy/paste/cut notes across bars
- [ ] Copy/paste bars
- [ ] Zoom in/out on timeline
- [ ] Key/scale change per bar (already supported)
- [ ] Export to WAV
- [ ] Collaboration / cloud sync (optional, later)
- [ ] Additional instrument presets (expand SoundFont library)

---

## 10. Music Theory Reference

### 10.1 Scale Definitions (semitone intervals from root)

| Scale | Intervals |
|-------|-----------|
| Major | 0 2 4 5 7 9 11 |
| Natural Minor | 0 2 3 5 7 8 10 |
| Harmonic Minor | 0 2 3 5 7 8 11 |
| Melodic Minor | 0 2 3 5 7 9 11 |
| Dorian | 0 2 3 5 7 9 10 |
| Phrygian | 0 1 3 5 7 8 10 |
| Lydian | 0 2 4 6 7 9 11 |
| Mixolydian | 0 2 4 5 7 9 10 |
| Locrian | 0 1 3 5 6 8 10 |
| Pentatonic Major | 0 2 4 7 9 |
| Pentatonic Minor | 0 3 5 7 10 |
| Blues | 0 3 5 6 7 10 |

### 10.2 Diatonic Chords (Major Scale)

| Degree | Roman | Quality | Example in C |
|--------|-------|---------|--------------|
| I | I | Major | C |
| ii | ii | Minor | Dm |
| iii | iii | Minor | Em |
| IV | IV | Major | F |
| V | V | Major | G |
| vi | vi | Minor | Am |
| vii° | vii° | Diminished | Bdim |

### 10.3 Diatonic Chords (Natural Minor Scale)

| Degree | Roman | Quality | Example in Am |
|--------|-------|---------|---------------|
| i | i | Minor | Am |
| ii° | ii° | Diminished | Bdim |
| III | III | Major | C |
| iv | iv | Minor | Dm |
| v | v | Minor | Em |
| VI | VI | Major | F |
| VII | VII | Major | G |

---

## 11. File Formats

### 11.1 Native JSON Schema (Save/Load)
```json
{
  "version": 1,
  "project": {
    "id": "proj_abc123",
    "name": "My Song",
    "bpm": 120,
    "timeSignature": { "beatsPerMeasure": 4, "beatUnit": 4 },
    "key": "C",
    "keyMode": "major",
    "tracks": [ ... ],
    "bars": [ ... ],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2025-01-01T00:00:00.000Z"
  }
}
```

### 11.2 MIDI Export
- Use one MIDI track per project track
- Quarter-note resolution
- Channel 1–16 mapped to project tracks
- Velocity mapped from note data

### 11.3 MusicXML Export
- One part per track
- Each bar rendered with chord symbols as harmony tags
- Notes rendered as standard notation

---

## 12. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Web Audio scheduling drift | Playback timing inaccuracy | Use Web Audio's built-in scheduling (not `setInterval`); schedule notes ahead of time |
| Large projects slow down canvas | UI lag with 100+ bars | Virtualize the piano roll canvas; only render visible bars |
| MIDI import complexity | Broken files or data loss | Graceful degradation — import what we can, log warnings |
| MusicXML is complex | Export may be incomplete | Start with basic export; iterate on notation quality |
| Browser compatibility | Some users on older browsers | Target modern browsers (Chrome, Firefox, Safari, Edge); polyfill if needed |

---

## 13. Open Questions

1. **SoundFont file management**: User-provided. Users load their own `.sf2` files via a file picker. Ships with a default piano preset (bundled minimal SF2 or Web Audio fallback).
2. **Instrument presets**: Piano by default. Additional SF2 instruments loaded on demand by the user.
3. **Collaboration**: No real-time collaboration. Fully offline, single-user experience.
4. **Plugin architecture**: Not for now. Fixed instrument set via user-provided SoundFont files.
5. **Naming**: **Chord Composer** is the final name.

---

*Plan v2.0 — updated for SoundFont audio, Canvas piano roll, touch support, and auto-save.*
