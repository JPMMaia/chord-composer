# Undo/Redo Timeline — Plan

## Goal

Add Ctrl+Z / Ctrl+Shift+Z (⌘+Z / ⌘+Shift+Z) undo/redo for every timeline mutation: adding, moving, resizing, deleting chord segments, editing track properties, adding/removing bars, changing time signatures, etc.

---

## Current State

| Item | Status |
|------|--------|
| `undoRedo.ts` — generic middleware | **Exists** — stores full snapshots, max 50 entries, trim-from-front strategy |
| `useUndoRedo.ts` — React hook with keyboard shortcuts | **Exists** — binds Ctrl+Z / Ctrl+Y / Cmd+Z / Cmd+Shift+Z |
| `projectStore` (Zustand) — holds `Project | null` | **Wiring needed** — no undo/redo integration |
| `editorStore` (Zustand) — holds UI settings | **Not undoable** — scroll, snap, palette settings are transient |
| `App.tsx` — uses stores | **Keyboard shortcuts not wired** — `useUndoRedo` is imported but not used |
| `ChordTimeline.tsx` — drag, drop, insert, move, resize, delete | **Changes are untracked** |

The undo/redo scaffold is complete but **not connected to anything**.

---

## Design Decisions

### 1. Snapshot granularity

Every **user-visible edit** gets one history entry. That means:

| User action | History entry |
|-------------|---------------|
| Drop a chord from palette | 1 push (the `insertSegment` call) |
| Drag a multi-selection to a new bar | 1 push (the `moveSegments` call) |
| Resize a chord by dragging its edge | 1 push (each `resizeSegmentDuration` call) |
| Press Delete on selected segments | 1 push (the `removeSegments` call) |
| Add a bar | 1 push (`addBar`) |
| Remove a bar | 1 push (`removeBar`) |
| Change BPM / key / time signature | 1 push each |
| Change track mute / volume / instrument | 1 push each (track props are part of the project) |
| Change voicing (inversion, spacing, arpeggio) | 1 push per batch (the store already groups multi-selection edits) |

**Rationale:** The store already batches multi-selection edits into a single `set(...)` call. The undo/redo middleware only sees the end result — one project object per store write. This is the simplest approach and matches what users expect (one undo = one user action, not ten internal mutations).

### 2. Scope: project state only

Undo only the **project** (`Project` object), not editor settings (scroll, snap, palette). Track settings are UI state — they should not be "undone" when the user deletes a chord.

### 3. Where the middleware lives

One middleware per project lifecycle. It is **created once when a project is created or loaded**, and **discarded when the project is reset**. This keeps memory bounded and avoids stale history across projects.

### 4. Snapshot size concern

A full `Project` snapshot can be large (many bars, tracks, segments). However:

- The app targets typical compositions (dozens of bars, a handful of tracks).
- 50 entries × ~50 KB = ~2.5 MB, which is fine for in-memory history.
- No persistence needed — undo/redo is session-only.

If the project grows very large, future work could use **structural sharing** (immer) or **delta compression**, but that is premature.

### 5. Redo invalidation

As in any stack-based undo system, any mutation **clears the redo stack**. This is handled automatically by `pushState` in the middleware.

---

## Architecture

```
App.tsx
  │
  ├── useUndoRedo({ initialState: null, maxHistory: 50 })
  │     │
  │     ├── pushState(nextProject)    ← via Zustand subscribe
  │     ├── undo() / redo()
  │     ├── canUndo / canRedo
  │     └── keyboard: Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y / Cmd+Z / Cmd+Shift+Z
  │
  ├── projectStore.subscribe(project → pushState)
  │     │
  │     ├── Every mutation calls set({ project: nextProject })
  │     │
  │     └── → Subscribe fires synchronously → pushState(nextProject)
  │
  ├── UndoRedoContext.Provider (undo, redo, canUndo, canRedo)
  │     │
  │     └── Transport bar (↩ / ↪ buttons, right end)
  │
  └── Selection, scroll, transport (editorStore, selectionStore)
        → NOT undoable (transient UI state)
```

### How it works — Zustand subscribe pattern

The undo/redo middleware lives in `App.tsx`. A `projectStore.subscribe()` listener fires **synchronously** after every `set({ project: … })` in the store. Zero store modifications needed.

```ts
// In App.tsx
const urRef = useRef(createUndoRedoMiddleware<Project | null>(null, 50));

useEffect(() => {
  if (!project) return;
  const unsub = projectStore.subscribe(
    (s) => s.project,
    (nextProject) => urRef.current.pushState(nextProject)
  );
  return unsub;
}, [project]);  // recreated when project changes
```

The only store method that needs a callback is `recordSegment` (key-down skips history, key-up records). All other methods are automatically captured.

```ts
// projectStore.ts — only recordSegment gets the param
recordSegment: (trackId, startBeat, segment, onCommit?) => {
  // … existing logic …
  set({ project: nextProject });
  onCommit?.(nextProject);  // key-up passes the commit; key-down passes null
}
```

**Pros:** Zero store signature changes for 99% of methods. History is a top-level concern. Lifecycle tied to project. One callback for the recording edge case only.

---

## Phased Implementation (TDD)

Each phase follows the red-green-refactor loop:
1. **RED** — Write a failing test that defines the expected behavior
2. **GREEN** — Implement the minimal code to make the test pass
3. **REFACTOR** — Clean up; ensure tests still pass

### Phase 0 — Foundation: Context + Middleware Integration

**Goal:** Create the undo/redo context and verify the middleware subscription pattern works. No UI changes yet.

| # | Test (RED) | Implementation (GREEN) | File |
|---|-----------|----------------------|------|
| 0.1 | `undoRedoContext.test.tsx` — `UndoRedoContext.Provider` passes `undo`, `redo`, `canUndo`, `canRedo` to consumers | Create `src/context/undoRedoContext.tsx` | `src/context/undoRedoContext.tsx` |
| 0.2 | `undoRedoContext.test.tsx` — `useUndoRedoState` throws outside provider | (already covered by 0.1) | — |
| 0.3 | `undoRedo.test.ts` — middleware correctly handles `null` initial state, pushes first real project to `history[0]` | Verify `createUndoRedoMiddleware(null, 50)` — current returns `null`, first `pushState` sets history | `tests/engine/undoRedo.test.ts` |
| 0.4 | `useUndoRedoSubscription.test.tsx` — subscribe fires after `projectStore.set({ project })` and pushes to middleware | Wiring in `App.tsx` (see Phase 1) | — |
| 0.5 | `useUndoRedo.test.tsx` — keyboard shortcuts fire undo/redo via context | (already tested by existing `useUndoRedo.ts` hook in `tests/hooks/`) | — |

**Deliverable:** Context exists, middleware verified for `null` seed, tests pass. Undo/redo is wired but not visible yet.

### Phase 1 — Core: Subscribe Wiring + Recording Edge Case

**Goal:** Undo/redo actually captures project mutations. Recording takes one undo step.

| # | Test (RED) | Implementation (GREEN) | File |
|---|-----------|----------------------|------|
| 1.1 | `useUndoRedoApp.test.tsx` — inserting a segment creates a history entry | Wire `projectStore.subscribe()` in `App.tsx`, expose `UndoRedoContext.Provider` | `src/App.tsx` |
| 1.2 | `useUndoRedoApp.test.tsx` — undo restores the pre-insert state | Subscribe pattern captures `set()` call | `src/App.tsx` |
| 1.3 | `useUndoRedoApp.test.tsx` — redo restores the insert | Middleware stack works | `src/App.tsx` |
| 1.4 | `useUndoRedoApp.test.tsx` — nested undo: undo → edit → redo is invalid | Existing middleware `pushState` splice behavior | — |
| 1.5 | `useUndoRedoApp.test.tsx` — recording: key-down call skips history, key-up creates one entry | Add `onCommit?: (p: Project) => void` to `recordSegment` signature | `src/store/projectStore.ts` |
| 1.6 | `useUndoRedoApp.test.tsx` — switching projects clears history | `useEffect` dependency on `project` recreates subscription | `src/App.tsx` |
| 1.7 | `useUndoRedoApp.test.tsx` — `resetProject` clears history | (same as 1.6 — project becomes `null`) | — |
| 1.8 | `useUndoRedoApp.test.tsx` — bar removal, BPM change, track add/remove are all undoable | (automatic via subscribe — no extra code) | — |

**Deliverable:** Undo/redo works end-to-end. One Ctrl+Z undoes any operation. Recording is one step.

### Phase 2 — UI: Transport Bar Buttons

**Goal:** Visible undo/redo buttons in the Transport bar.

| # | Test (RED) | Implementation (GREEN) | File |
|---|-----------|----------------------|------|
| 2.1 | `Transport.test.tsx` — undo button is present, calls `undo` on click | Add button to `Transport.tsx` props interface | `src/components/Transport.tsx` |
| 2.2 | `Transport.test.tsx` — undo button is dimmed when `canUndo` is false | Button uses `disabled={!canUndo}` + `opacity-40` | `src/components/Transport.tsx` |
| 2.3 | `Transport.test.tsx` — redo button is present, calls `redo` on click | Same pattern as undo | `src/components/Transport.tsx` |
| 2.4 | `Transport.test.tsx` — redo button is dimmed when `canRedo` is false | Same pattern | `src/components/Transport.tsx` |
| 2.5 | `Transport.test.tsx` — buttons show `Ctrl+Z` / `Ctrl+Y` in tooltip | `title` prop | `src/components/Transport.tsx` |
| 2.6 | `Transport.test.tsx` — buttons are at the right end (after loop readout) | JSX order in component | `src/components/Transport.tsx` |
| 2.7 | E2E test — pressing undo button reverts the last operation | Full integration test with project + context | `tests/e2e/undoRedo.test.tsx` |

**Deliverable:** Visible undo/redo buttons in Transport bar. Click = undo/redo.

### Phase 3 — Keyboard Shortcuts Integration

**Goal:** Verify Ctrl+Z / Ctrl+Y work from any context, no conflicts.

| # | Test (RED) | Implementation (GREEN) | File |
|---|-----------|----------------------|------|
| 3.1 | `useUndoRedo.test.tsx` — Ctrl+Z fires undo when available | Hook already binds this in `useUndoRedo.ts` | — |
| 3.2 | `useUndoRedo.test.tsx` — Ctrl+Shift+Z fires redo when available | Hook already binds this | — |
| 3.3 | `useUndoRedo.test.tsx` — Ctrl+Y fires redo when available | Hook already binds this | — |
| 3.4 | `useSegmentShortcuts.test.tsx` — Ctrl+Z is NOT intercepted by segment shortcuts | Verify hook returns early on `e.ctrlKey` | `tests/hooks/useSegmentShortcuts.test.tsx` |
| 3.5 | `useSegmentCopyPaste.test.tsx` — Ctrl+V paste is undoable | (automatic via subscribe — no extra code) | — |

**Deliverable:** Keyboard shortcuts work globally, no conflicts.

---

## Implementation Steps

### Step 0 — Review existing middleware (no fixes needed)

**Read:** `src/engine/undoRedo.ts` and `src/hooks/useUndoRedo.ts`.

**Verdict: no bugs.** The `trimHistory()` logic is correct for all `maxHistory >= 2` (our case at 50). It only trims entries already before the pointer, so the `pointer--` decrement is always valid. The clamp is a safety net, not a fix.

### Step 1 — Create UndoRedoContext

A small React context to expose undo/redo to the Transport bar buttons.

```tsx
// src/context/undoRedoContext.tsx
import { createContext, useContext, type ReactNode } from 'react';

export interface UndoRedoContextValue {
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export const UndoRedoContext = createContext<UndoRedoContextValue | null>(null);

export const useUndoRedoState = () => {
  const ctx = useContext(UndoRedoContext);
  if (!ctx) throw new Error('useUndoRedoState must be inside UndoRedoProvider');
  return ctx;
};
```

### Step 2 — Wire the middleware in App.tsx (Zustand subscribe)

```tsx
// In App.tsx
import { createUndoRedoMiddleware } from '@/engine/undoRedo';
import { UndoRedoContext } from '@/context/undoRedoContext';

function App() {
  // …existing code…

  const urRef = useRef(createUndoRedoMiddleware<Project | null>(null, 50));
  const project = projectStore(s => s.project);

  // Subscribe: fires synchronously after every store write that changes project
  useEffect(() => {
    if (!project) return;
    const unsubscribe = projectStore.subscribe(
      (state) => state.project,
      (nextProject) => urRef.current.pushState(nextProject)
    );
    return unsubscribe;
  }, [project]);  // recreated when project changes (new session)

  const canUndo = urRef.current.canUndo();
  const canRedo = urRef.current.canRedo();
  const undo = useCallback(() => { try { urRef.current.undo(); } catch {} }, []);
  const redo = useCallback(() => { try { urRef.current.redo(); } catch {} }, []);

  return (
    <UndoRedoContext.Provider value={{ undo, redo, canUndo, canRedo }}>
      {/* existing JSX */}
    </UndoRedoContext.Provider>
  );
}
```

**Key points:**
- `projectStore.subscribe()` fires after every `set({ project: … })`. Zero store changes.
- `useRef` keeps the middleware stable across re-renders.
- `useEffect` re-subscribes when `project` changes (new project = re-seeded history).
- `null` initial state means the first real project becomes history[0].

### Step 3 — Add Transport bar undo/redo buttons

Place two icon-only buttons (↩ / ↪) at the **right end** of the Transport bar, after the loop range readout. Buttons are dimmed (`opacity-40`, `cursor-not-allowed`) when `canUndo`/`canRedo` is false. Tooltips show `Ctrl+Z` / `Ctrl+Y`.

### Step 4 — Keyboard shortcuts

The `useUndoRedo` hook (from `src/hooks/useUndoRedo.ts`) already binds Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y. **No conflicts** with existing shortcuts:
- `useSegmentShortcuts` — skips Ctrl/Cmd/Alt combinations
- `useSegmentCopyPaste` — uses Ctrl+C / Ctrl+V only
- `useRecordShortcuts` — uses number keys + 'r', skips Ctrl/Cmd/Alt
- `usePlaybackShortcuts` — uses spacebar only

**Special case — recording:** In `useRecordShortcuts.ts`, `recordSegment` is called twice per take (key-down and key-up). The key-down call should **skip history** so the take becomes one entry. Two approaches:
1. Pass `null` as `onCommit` param to the key-down call
2. Filter in the subscribe callback: only push if the new project differs from `current()` by more than just the segment duration

**Recommendation:** Approach 1 — add `onCommit?: (p: Project) => void` as the last optional param of `recordSegment` only. This avoids touching every store method while handling the recording edge case cleanly.

### Step 5 — Handle project load / reset

When a project is **loaded** from file or **reset**:
- The history is **discarded** and re-seeded with the loaded project.
- This is handled by the `useEffect` in App.tsx: the `project` dependency changes, the old subscription is cleaned up, and a new one is created with the new project as the initial state.

**Implementation note:** The middleware is created with `null` as initial state. The first `set({ project: … })` after create/load pushes the real project to history[0]. Old history is gone.

### Step 6 — Visual feedback

- **Transport bar:** Two icon-only buttons (↩ / ↪) at the right end.
- **Disabled state:** Buttons are dimmed (`opacity-40`, `cursor-not-allowed`) when `canUndo`/`canRedo` is false.
- **Tooltips:** Show `Ctrl+Z` / `Ctrl+Y` on hover.

---

## Files to Create / Modify

### Source files

| File | Action |
|------|--------|
| `src/engine/undoRedo.ts` | **Review only** — no changes needed. |
| `src/context/undoRedoContext.tsx` | **Create** — undo/redo React context |
| `src/store/projectStore.ts` | **Modify** — add `onCommit` param to `recordSegment` only |
| `src/App.tsx` | **Modify** — subscribe to project changes, expose context |
| `src/components/Transport.tsx` | **Modify** — add undo/redo buttons (right end) |

### Test files

| File | Action |
|------|--------|
| `tests/engine/undoRedo.test.ts` | **Extend** — add `null` initial state test |
| `tests/context/undoRedoContext.test.tsx` | **Create** — context provider + hook tests |
| `tests/hooks/useUndoRedoApp.test.tsx` | **Create** — integration tests (insert→undo→redo, record, project switch, reset) |
| `tests/components/Transport.test.tsx` | **Extend** — add undo/redo button tests |
| `tests/hooks/useSegmentShortcuts.test.tsx` | **Extend** — verify Ctrl+Z not intercepted |
| `tests/e2e/undoRedo.test.tsx` | **Create** — E2E integration test |

### Existing files — review only (no changes)

| File | Check |
|------|-------|
| `src/hooks/useSegmentShortcuts.ts` | Confirms `if (e.ctrlKey || e.metaKey)` early return |
| `src/hooks/useSegmentCopyPaste.ts` | Confirms paste flows through store (undoable via subscribe) |
| `src/hooks/useUndoRedo.ts` | Already has keyboard binding — just needs to be used |

---

## Edge Cases & Considerations

### 1. Recording — two calls per take
In `useRecordShortcuts.ts`, `recordSegment` fires exactly **twice** per key press: once on key-down (minimum length), once on key-up (actual duration). The key-down push would be wasted since key-up replaces the block.

**Solution:** `recordSegment` accepts `onCommit?: (p: Project) => void` as the last param. Key-down passes `null` (skip history), key-up passes the commit callback. One history entry per take.

### 2. Nested undo (undo → edit → undo should NOT redo)
Standard stack behavior. The existing middleware handles this via `pushState`'s `history.splice(pointer)`.

### 3. Project reset while undo is available
The `resetProject` method sets `project: null`. The `useUndoRedo` middleware is recreated, history is lost. This is correct.

### 4. `shouldRecord` deduplication
If two consecutive mutations produce the same project object (e.g., a no-op move), `shouldRecord` prevents duplicating history. Default `prev !== next` handles this for reference equality. For deep equality, a custom comparator could be added but is likely unnecessary.

### 5. Large projects
If a project has 100+ bars with many segments, each snapshot could be 100+ KB. 50 entries = 5 MB. Acceptable for in-memory use. If this becomes an issue, consider:
- Reducing `maxHistory` dynamically based on project size
- Implementing delta compression
- Using `immer` for structural sharing between snapshots

### 6. `refitBars` side effects
When a segment is moved past a bar line, `refitBars` may append new bars. This is one mutation from the user's perspective (one drag), so it gets one history entry. Correct.

### 7. Track operations
Adding/removing tracks, changing instruments, volumes, mute/solo — all mutate `project.tracks` and are part of the `Project` snapshot. They are undoable. Correct.

### 8. Bar time signature changes
Changing a bar's time signature modifies `bar.timeSignature` and triggers `refitBars` (segments may need re-homing). This is one user action, one history entry. Correct.

### 9. Loop region drag
The loop region is stored in `project.loopStart` and `project.loopEnd`. The `setLoopRegion` store method handles this and is undoable. Correct.

---

## Testing Checklist

- [ ] Drop a chord → undo removes it → redo restores it
- [ ] Delete selected chords → undo restores → redo removes again
- [ ] Drag multi-selection → undo reverts → redo re-applies
- [ ] Resize chord → undo reverts to original duration
- [ ] Add bar → undo removes it
- [ ] Remove bar → undo restores it
- [ ] Change BPM → undo reverts
- [ ] Change time signature → undo reverts
- [ ] Change track mute/solo → undo reverts
- [ ] Duplicate track → undo removes duplicate
- [ ] Paste segments → undo removes pasted segments
- [ ] Set loop region → undo clears loop
- [ ] Change chord voicing (inversion, spacing, arpeggio) → undo reverts
- [ ] Record chords → undo removes recording
- [ ] Ctrl+Z when at beginning → no crash, no visible change
- [ ] Ctrl+Y (redo) when at end → no crash, no visible change
- [ ] Switch projects → history cleared, no stale entries from old project
- [ ] Save file → history is NOT persisted (session only)
- [ ] 50+ undos → oldest entries trimmed without error
- [ ] Keyboard shortcut conflict → none with existing shortcuts

---

## Timeline Estimation (with TDD)

### Phase 0 — Foundation (~1.5 hrs)
| Task | Time |
|------|------|
| Write context tests (RED) | 20 min |
| Create `UndoRedoContext.tsx` (GREEN) | 15 min |
| Add middleware `null`-seed test (RED) | 15 min |
| Run tests, verify (GREEN) | 10 min |

### Phase 1 — Core Wiring (~3 hrs)
| Task | Time |
|------|------|
| Write integration tests for insert→undo→redo (RED) | 30 min |
| Wire `subscribe` + context in `App.tsx` (GREEN) | 30 min |
| Write recording edge-case test (RED) | 20 min |
| Add `onCommit` to `recordSegment` (GREEN) | 15 min |
| Write project-switch / reset tests (RED+GREEN) | 20 min |
| Refactor, verify all pass | 25 min |

### Phase 2 — UI Buttons (~1.5 hrs)
| Task | Time |
|------|------|
| Write Transport button tests (RED) | 20 min |
| Add buttons to `Transport.tsx` (GREEN) | 25 min |
| Wire buttons in `App.tsx` (GREEN) | 15 min |
| Add E2E integration test | 20 min |

### Phase 3 — Keyboard Shortcuts (~30 min)
| Task | Time |
|------|------|
| Write conflict-verification tests (RED) | 15 min |
| Verify no changes needed (GREEN) | 10 min |
| Final cleanup | 5 min |

| **Total** | **~6–8 hrs** |

---

## Open Questions

1. **Should editor state (scroll position, snap, palette) be undoable?** ✅ Decision: **no**. Transient UI settings, not composition changes.

2. **Should the history be persistent (localStorage)?** ✅ Decision: **no**. Session-only. Persistence belongs to the save/load file system.

3. **Action labels for undo menu?** ✅ Decision: **out of scope**. Icon-only buttons (↩ / ↪) with tooltips showing keyboard shortcuts.

4. **Should Ctrl+Z cycle through multiple undos on hold?** ✅ Decision: **no**. One press = one step. Standard DAW behavior.

5. **Should the scroll position be restored by undo?** ✅ Decision: **no** (sticky). After undo, scroll stays where the user is — the standard pattern (VS Code, Figma).

6. **Recording: silent key-down?** ✅ Decision: `recordSegment` accepts `onCommit?: (p: Project) => void` as its last optional param. Key-down passes `null`, key-up passes the commit callback. One history entry per take.
