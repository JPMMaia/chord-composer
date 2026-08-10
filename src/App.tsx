import { useEffect, useCallback, useRef, useSyncExternalStore } from 'react';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { createUndoRedoMiddleware } from '@/engine/undoRedo';
import {
  UndoRedoContext,
  type UndoRedoContextValue,
} from '@/context/undoRedoContext';
import { setRecordingGate } from '@/store/projectStore';
import { Transport } from '@/components/Transport';
import { FileMenu } from '@/components/FileMenu';
import { InstrumentsPanel } from '@/components/InstrumentsPanel';
import { ScalePalette } from '@/components/ScalePalette';
import { ChordTimeline } from '@/components/ChordTimeline';
import { PianoRoll } from '@/components/PianoRoll';
import { HorizontalScrollbar } from '@/components/HorizontalScrollbar';
import { SegmentInspector } from '@/components/SegmentInspector';
import { usePlayback } from '@/hooks/usePlayback';
import { useSegmentShortcuts } from '@/hooks/useSegmentShortcuts';
import { useSegmentCopyPaste } from '@/hooks/useSegmentCopyPaste';
import { usePlaybackShortcuts } from '@/hooks/usePlaybackShortcuts';
import { useRecordShortcuts } from '@/hooks/useRecordShortcuts';
import { useFollowPlayhead } from '@/hooks/useFollowPlayhead';
import { useFileIO } from '@/hooks/useFileIO';
import { useFileShortcuts } from '@/hooks/useFileShortcuts';
import { FileIOContext } from '@/context/fileIOContext';
import { editorStore } from '@/store/editorStore';
import { songTimeToBeat } from '@/engine/scheduler';
import {
  barContent,
  getBarIndexAtBeat,
  getTotalBeats,
  MIN_SEGMENT_BEATS,
} from '@/engine/timeline';
import { projectScale } from '@/engine/scales';
import type { Bar, ChordSegment, Project, TimeSignature } from '@/types/music';
import { PIANO_KEYS_WIDTH } from '@/utils/constants';

/**
 * The bars a play range covers, as "2–4" or just "2" for a range inside one bar.
 *
 * The end is nudged back before being resolved so a range ending exactly on a bar
 * line does not claim the bar it stops at the door of.
 */
function barRangeLabel(
  bars: Bar[],
  projectTs: TimeSignature,
  loopStart: number,
  loopEnd: number
): string {
  const first = getBarIndexAtBeat(bars, projectTs, loopStart) + 1;
  const last = getBarIndexAtBeat(bars, projectTs, Math.max(loopStart, loopEnd - MIN_SEGMENT_BEATS)) + 1;
  return first === last ? `${first}` : `${first}–${last}`;
}

function App() {
  const project = projectStore(s => s.project);
  const createProject = projectStore(s => s.createProject);
  const setBpm = projectStore(s => s.setBpm);
  const addBar = projectStore(s => s.addBar);
  const removeBar = projectStore(s => s.removeBar);

  const selectedBarId = selectionStore(s => s.selectedBarId);
  const selectedTrackId = selectionStore(s => s.selectedTrackId);
  const selectTrack = selectionStore(s => s.selectTrack);
  const selectBar = selectionStore(s => s.selectBar);

  const toggleLoopEnabled = projectStore(s => s.toggleLoopEnabled);
  const toggleMetronome = projectStore(s => s.toggleMetronome);
  const metronomeEnabled = projectStore(s => s.project?.metronomeEnabled ?? false);

  // One offset for the chord timeline, the piano roll and the scrollbar under them.
  const scrollX = editorStore(s => s.scrollX);
  const setScrollX = editorStore(s => s.setScrollX);
  const pixelsPerBeat = editorStore(s => s.pixelsPerBeat);

  const recordArmed = editorStore(s => s.recordArmed);
  const setRecordArmed = editorStore(s => s.setRecordArmed);
  const recordQuantize = editorStore(s => s.recordQuantize);
  const setRecordQuantize = editorStore(s => s.setRecordQuantize);

  // Initialize project on mount
  useEffect(() => {
    if (!project) {
      createProject();
      // Add 4 bars by default
      addBar();
      addBar();
      addBar();
      addBar();
    }
  }, [project, createProject, addBar]);

  // Open a piece in its own key. Keyed on the project id rather than the key
  // itself, so this seeds on create and on load but never fights the palette
  // dropdown afterwards — moving the palette to another key is the point of it.
  const projectId = project?.id;
  useEffect(() => {
    if (!projectId) return;
    const opened = projectStore.getState().project;
    if (!opened) return;
    editorStore.getState().setPaletteScale(projectScale(opened.key, opened.keyMode));
  }, [projectId]);

  const selectedBar = project?.bars.find(b => b.id === selectedBarId);

  // Auto-select the first bar so the piano roll and bar panel have one to show.
  useEffect(() => {
    if (project && project.bars.length > 0 && !selectedBarId) {
      selectBar(project.bars[0].id);
    }
  }, [project, selectedBarId, selectBar]);

  // Likewise the first instrument, so the timeline always has somewhere to drop a
  // block. Also re-homes the selection when the selected instrument is removed.
  useEffect(() => {
    if (!project || project.tracks.length === 0) return;
    if (selectedTrackId && project.tracks.some(t => t.id === selectedTrackId)) return;
    selectTrack(project.tracks[0].id);
  }, [project, selectedTrackId, selectTrack]);

  const selectedBarContent =
    selectedBar && selectedTrackId ? barContent(selectedBar, selectedTrackId) : null;
  const selectedBarSegmentCount = selectedBarContent?.chords.length ?? 0;
  const selectedBarNoteCount = selectedBarContent?.notes.length ?? 0;

  // Playback config
  const playbackConfig = project
    ? {
        bpm: project.bpm,
        timeSignature: project.timeSignature,
        bars: project.bars,
        tracks: project.tracks,
        loopStart: project.loopStart ?? null,
        loopEnd: project.loopEnd ?? null,
        loopEnabled: project.loopEnabled ?? false,
      }
    : null;

  // The range reads as bar numbers rather than beats: that is how it was drawn.
  const loopRangeLabel =
    project && project.loopStart !== undefined && project.loopEnd !== undefined
      ? barRangeLabel(project.bars, project.timeSignature, project.loopStart, project.loopEnd)
      : null;

  // Playback state lives in the hook, which is the only thing that knows when sound
  // actually starts — a local copy would claim "playing" during the sample load.
  const { play, pause, stop, isPlaying, isPaused, isLoading, currentTime, getSongTime, getPool } =
    usePlayback(playbackConfig!, metronomeEnabled);

  const playheadBeat = songTimeToBeat(currentTime, project?.bpm ?? 120);

  // Handlers
  const handlePlay = useCallback(() => {
    void play();
  }, [play]);

  const handleBpmChange = useCallback((bpm: number) => {
    setBpm(bpm);
  }, [setBpm]);

  const handleMetronomeToggle = useCallback(() => {
    toggleMetronome();
  }, [toggleMetronome]);

  const handleRecordToggle = useCallback(() => {
    setRecordArmed(!recordArmed);
  }, [recordArmed, setRecordArmed]);

  const handleQuantizeToggle = useCallback(() => {
    setRecordQuantize(!recordQuantize);
  }, [recordQuantize, setRecordQuantize]);

  // ↑/↓ step the selected block through its bar's scale, +/- move it an octave,
  // and `i` cycles a chord's inversion.
  useSegmentShortcuts();

  // Ctrl+C / Ctrl+V to copy and paste selected segments.
  useSegmentCopyPaste();

  // Spacebar toggles play/stop.
  usePlaybackShortcuts({ isPlaying, isLoading, onPlay: handlePlay, onStop: stop });

  // File operations live here rather than in the File menu because the menu is not
  // the only thing that uses them — the shortcuts below do too, and the auto-save
  // timer inside has to be the only one in the app. `FileMenu` reads them back out
  // of the context.
  const fileIO = useFileIO();

  // Ctrl+S / Ctrl+Shift+S / Ctrl+O.
  useFileShortcuts(fileIO);

  // Gated recording: the key-down call is wrapped so it skips history;
  // the key-up call (in useRecordShortcuts) uses the plain recordSegment,
  // which is captured by the subscribe → one history entry per take.
  const recordGated = useCallback(
    (trackId: string, startBeat: number, segment: ChordSegment) => {
      projectStore.getState().withRecording(() =>
        projectStore.getState().recordSegment(trackId, startBeat, segment)
      );
    },
    []
  );

  // 1–7 play the palette's degrees, and record them while armed. `r` arms.
  useRecordShortcuts({ isPlaying, getSongTime, getPool, recordGated });

  // Page the view along during playback so the playhead never runs off screen.
  useFollowPlayhead(playheadBeat, isPlaying);

  // ---------------------------------------------------------------------------
  // Undo / Redo — middleware instance survives across renders.
  // ---------------------------------------------------------------------------
  const urRef = useRef(
    createUndoRedoMiddleware<Project | null>(null, 50)
  );

  // Bridge the middleware's recording gate into the store, so the recording
  // shortcuts can silence pushState for the key-down call.
  useEffect(() => {
    setRecordingGate(urRef.current.setRecording);
    // Only runs once on mount; urRef.current is stable.
  }, []);

  // Subscribe to project mutations: every set({ project }) pushes a snapshot.
  const pushSnapshot = useCallback(
    (state: { project: Project | null }) => urRef.current.pushState(state.project),
    []
  );

  useEffect(() => {
    if (!project) return;
    const unsubscribe = projectStore.subscribe(pushSnapshot);
    return unsubscribe;
  }, [project, pushSnapshot]);

  // Sync canUndo / canRedo with React via useSyncExternalStore.
  // The middleware caches the snapshot object so the SAME reference is
  // returned when canUndo/canRedo haven't changed — preventing infinite
  // React render loops (new object each render = React thinks state changed).
  const urSnapshot = useSyncExternalStore(
    (cb) => urRef.current.subscribe(cb),
    () => urRef.current.getSnapshot()
  );

  const undoRedoValue: UndoRedoContextValue = {
    // undo/redo must set the project store so React re-renders with the
    // undone/redone state.  Just moving the middleware pointer would leave
    // the store (and therefore React) showing the pre-undo project.
    undo: useCallback(() => {
      try {
        urRef.current.undo();
        projectStore.setState({ project: urRef.current.current() });
      } catch { /* at beginning */ }
    }, []),
    redo: useCallback(() => {
      try {
        urRef.current.redo();
        projectStore.setState({ project: urRef.current.current() });
      } catch { /* at end */ }
    }, []),
    canUndo: urSnapshot.canUndo,
    canRedo: urSnapshot.canRedo,
  };

  // ── Keyboard shortcuts: Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y (⌘ variants) ──
  // Using refs to avoid stale closures — the listener always reads the
  // latest values without needing to re-bind on every render.
  // Capture phase + keyup ensures we grab Ctrl+Shift+Z before the browser
  // intercepts it (browser default: "reopen closed tab").
  const urLatest = useRef(undoRedoValue);
  urLatest.current = undoRedoValue;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const { current } = urLatest;
      // Shift+Z reports e.key as 'Z', so compare case-insensitively.
      const key = e.key.toLowerCase();
      const isUndo = (e.ctrlKey || e.metaKey) && !e.shiftKey && key === 'z';
      const isRedo = (e.ctrlKey || e.metaKey) && e.shiftKey && key === 'z';
      const isRedoAlt = (e.ctrlKey || e.metaKey) && key === 'y';
      if (isUndo && current.canUndo) {
        e.preventDefault();
        e.stopPropagation();
        current.undo();
      } else if ((isRedo || isRedoAlt) && current.canRedo) {
        e.preventDefault();
        e.stopPropagation();
        current.redo();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  if (!project) return null;

  return (
    <UndoRedoContext.Provider value={undoRedoValue}>
    <FileIOContext.Provider value={fileIO}>
    <div className="flex flex-col h-screen bg-gray-900 text-gray-100">
      {/* File Menu */}
      <div className="px-4 py-2 bg-gray-800 border-b border-gray-700">
        <FileMenu />
      </div>

      {/* Transport Bar */}
      <Transport
        isPlaying={isPlaying}
        isPaused={isPaused}
        bpm={project.bpm}
        timeSignature={project.timeSignature}
        musicalKey={project.key}
        keyMode={project.keyMode}
        loopEnabled={project.loopEnabled ?? false}
        loopRangeLabel={loopRangeLabel}
        isLoading={isLoading}
        isMetronomeOn={metronomeEnabled}
        isRecordArmed={recordArmed}
        recordQuantize={recordQuantize}
        getSongTime={getSongTime}
        onPlay={handlePlay}
        onPause={pause}
        onStop={stop}
        onBpmChange={handleBpmChange}
        onMetronomeToggle={handleMetronomeToggle}
        onLoopToggle={toggleLoopEnabled}
        onRecordToggle={handleRecordToggle}
        onQuantizeToggle={handleQuantizeToggle}
        onUndo={undoRedoValue.undo}
        onRedo={undoRedoValue.redo}
        canUndo={undoRedoValue.canUndo}
        canRedo={undoRedoValue.canRedo}
      />

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        <InstrumentsPanel />

        {/* Center — palette strip, chord timeline, piano roll */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Ungated by the bar cursor: the palette carries its own key, so it has
              material to offer whether or not a bar is selected. */}
          <ScalePalette />

          <ChordTimeline />

          <div className="flex-1 bg-gray-900 overflow-hidden">
            {selectedBar && (
              <PianoRoll
                bars={project.bars}
                selectedBarId={selectedBar.id}
                tracks={project.tracks}
                selectedTrackId={selectedTrackId}
                playheadBeat={playheadBeat}
                pixelsPerBeat={pixelsPerBeat}
                pixelsPerOctave={120}
                gridSize={MIN_SEGMENT_BEATS}
                timeSignature={project.timeSignature}
                scrollLeft={scrollX}
                onScrollLeftChange={setScrollX}
              />
            )}
          </div>

          {/* The editor's one horizontal scrollbar. Its content spans the key
              column as well, so its range matches what the panes can scroll. */}
          <HorizontalScrollbar
            contentWidth={
              PIANO_KEYS_WIDTH +
              getTotalBeats(project.bars, project.timeSignature) * pixelsPerBeat
            }
          />
        </div>

        {/* Right Sidebar - Properties */}
        <div className="w-72 shrink-0 bg-gray-800 border-l border-gray-700 overflow-y-auto">
          <div className="p-3 border-b border-gray-700">
            <h2 className="text-sm font-semibold text-gray-300">Properties</h2>
          </div>

          {/* Outside the bar's own section: selection does not follow the bar
              cursor, so a chord stays selected — and editable — when the cursor
              moves to another bar. */}
          <div className="p-3">
            <SegmentInspector />
          </div>

          {selectedBar && (
            <div className="p-3 space-y-4">
              {/* Bar Info. No key here: it belongs to the blocks, and is edited in
                  the palette for new ones and the inspector for existing ones. */}
              <div className="pt-2 border-t border-gray-700 space-y-2">
                {/* Counts for the instrument being edited, not the whole bar —
                    this panel sits beside a timeline showing only that one. */}
                <div className="text-xs text-gray-400">
                  {selectedBarSegmentCount} segment
                  {selectedBarSegmentCount !== 1 ? 's' : ''} · {selectedBarNoteCount} note
                  {selectedBarNoteCount !== 1 ? 's' : ''}
                </div>
                <button
                  onClick={addBar}
                  className="w-full px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 text-gray-200 rounded transition-colors"
                >
                  Add Bar
                </button>
                <button
                  onClick={() => removeBar(selectedBar.id)}
                  className="w-full px-3 py-1.5 text-sm bg-red-600 hover:bg-red-500 text-white rounded transition-colors"
                >
                  Remove Bar
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
    </FileIOContext.Provider>
    </UndoRedoContext.Provider>
  );
}

export default App;
