import { useEffect, useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
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
import { AudioSettings } from '@/components/AudioSettings';
import { InstrumentsPanel } from '@/components/InstrumentsPanel';
import { ScalePalette } from '@/components/ScalePalette';
import { FormulaPalette } from '@/components/FormulaPalette';
import { ChordTimeline } from '@/components/ChordTimeline';
import { PianoRoll } from '@/components/PianoRoll';
import { HorizontalScrollbar } from '@/components/HorizontalScrollbar';
import { SegmentInspector } from '@/components/SegmentInspector';
import { ArrangementView } from '@/components/ArrangementView';
import { PhraseInspector } from '@/components/PhraseInspector';
import { phraseBarsAsTrack, phraseById } from '@/engine/phrases';
import { usePlayback } from '@/hooks/usePlayback';
import { useSegmentShortcuts } from '@/hooks/useSegmentShortcuts';
import { usePhraseEditorGuard } from '@/hooks/usePhraseEditorGuard';
import { usePhraseAudition } from '@/hooks/usePhraseAudition';
import { useSegmentCopyPaste } from '@/hooks/useSegmentCopyPaste';
import { usePlaybackShortcuts } from '@/hooks/usePlaybackShortcuts';
import { useRecordShortcuts } from '@/hooks/useRecordShortcuts';
import { useMidiInput } from '@/hooks/useMidiInput';
import { useTouchpadExpression } from '@/hooks/useTouchpadExpression';
import { useRecordSession } from '@/hooks/useRecordSession';
import { useFollowPlayhead } from '@/hooks/useFollowPlayhead';
import { useFileIO } from '@/hooks/useFileIO';
import { useFileShortcuts } from '@/hooks/useFileShortcuts';
import { FileIOContext } from '@/context/fileIOContext';
import { useFormulaLibraries } from '@/hooks/useFormulaLibraries';
import { FormulaLibraryContext } from '@/context/formulaLibraryContext';
import { TouchpadContext } from '@/context/touchpadContext';
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
  const setPhraseLength = projectStore(s => s.setPhraseLength);
  const removePhraseBarAt = projectStore(s => s.removePhraseBarAt);

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

  const view = editorStore(s => s.view);
  const editingPhraseId = projectStore(s => s.editingPhraseId);

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

  /**
   * The phrase the timeline is editing, or null in the arrangement.
   *
   * Read here rather than only inside the timeline because the piano roll under it
   * has to draw the same surface: a bar the user clicks in the phrase editor is a
   * *phrase-local* bar, which `project.bars` does not contain.
   */
  const editingPhrase =
    project && editingPhraseId ? phraseById(project.phrases, editingPhraseId) : null;

  /**
   * The bars the piano roll and the bar panel show: the open phrase's, filed under
   * the instrument playing it, or the compiled song when the arrangement is up.
   */
  const surfaceBars = useMemo(
    () =>
      editingPhrase && selectedTrackId && project
        ? phraseBarsAsTrack(editingPhrase, project, selectedTrackId)
        : (project?.bars ?? []),
    [editingPhrase, project, selectedTrackId]
  );

  const selectedBar = surfaceBars.find(b => b.id === selectedBarId);

  /**
   * Add and Remove Bar act on whatever the timeline is showing.
   *
   * With a phrase open that is the *phrase's* bars, not the song's: the bar cursor is
   * on one of them, the panel above these buttons is counting blocks in one of them,
   * and the song grid underneath belongs to every other instrument playing at the same
   * time. Lengthening the song there would leave the phrase — the thing being written
   * into — exactly as short as it was.
   */
  const addSurfaceBar = () => {
    if (editingPhrase) setPhraseLength(editingPhrase.id, editingPhrase.bars.length + 1);
    else addBar();
  };

  const removeSurfaceBar = (barId: string) => {
    if (editingPhrase) removePhraseBarAt(editingPhrase.id, barId);
    else removeBar(barId);
  };

  // Auto-select the first bar so the piano roll and bar panel have one to show —
  // and re-home the cursor when the surface changes under it, which opening or
  // closing a phrase does: a phrase's bar ids are its own.
  useEffect(() => {
    if (surfaceBars.length === 0) return;
    if (selectedBarId && surfaceBars.some(b => b.id === selectedBarId)) return;
    selectBar(surfaceBars[0].id);
  }, [surfaceBars, selectedBarId, selectBar]);

  // Undo of a Make Unique, or a phrase deleted from under the editor, leaves it
  // pointed at nothing. Mirrors the instrument re-homing above.
  usePhraseEditorGuard();

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

  /**
   * What Play means while a phrase is open, or null in the arrangement.
   *
   * The song is still what is scheduled; this only narrows it. See the hook.
   */
  const audition = usePhraseAudition();

  // Playback config. An audition overrides the project's own range and repeat rather
  // than editing them: the song's settings are untouched and come back the moment the
  // arrangement does.
  const playbackConfig = project
    ? {
        bpm: project.bpm,
        timeSignature: project.timeSignature,
        bars: project.bars,
        tracks: project.tracks,
        groups: project.trackGroups,
        loopStart: audition ? audition.loopStart : (project.loopStart ?? null),
        loopEnd: audition ? audition.loopEnd : (project.loopEnd ?? null),
        loopEnabled: audition ? true : (project.loopEnabled ?? false),
        audibleTrackIds: audition ? audition.audibleTrackIds : null,
      }
    : null;

  // The range reads as bar numbers rather than beats: that is how it was drawn. An
  // audition's are the *phrase's* bar numbers, counted over the bars the editor is
  // showing, so the readout names what the user can see rather than where in the song
  // that phrase happens to sit.
  const loopRangeLabel = !project
    ? null
    : audition
      ? barRangeLabel(surfaceBars, project.timeSignature, audition.localStart, audition.localEnd)
      : project.loopStart !== undefined && project.loopEnd !== undefined
        ? barRangeLabel(project.bars, project.timeSignature, project.loopStart, project.loopEnd)
        : null;

  // Playback state lives in the hook, which is the only thing that knows when sound
  // actually starts — a local copy would claim "playing" during the sample load.
  const {
    play,
    pause,
    stop,
    isPlaying,
    isPaused,
    isLoading,
    currentTime,
    getSongTime,
    getPool,
    ensureAudio,
  } = usePlayback(playbackConfig!, metronomeEnabled);

  // Absolute song beats — except while auditioning, where everything drawn is
  // measured from the phrase's own bar 0 and the playhead has to be too.
  const playheadBeat =
    songTimeToBeat(currentTime, project?.bpm ?? 120) - (audition?.baseBeat ?? 0);

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
  // and `i` cycles a chord's inversion. The two pitch moves sound the block they
  // moved, so a step can be heard without pressing Play.
  useSegmentShortcuts({ getPool, ensureAudio });

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

  // The formula libraries, opened and saved on their own — they outlive the project.
  // Here for `useFileIO`'s reason: this owns the start-up restore, and a second
  // instance would reopen every remembered library file twice.
  const formulaLibraries = useFormulaLibraries();

  // ---------------------------------------------------------------------------
  // Undo / Redo — middleware instance survives across renders.
  //
  // Declared above the recording hooks because the record session below needs it.
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

  // Recording writes are gated so no single block becomes a history entry of its
  // own — the record pass below is what makes the take one undo step.
  const recordGated = useCallback(
    (trackId: string, startBeat: number, segment: ChordSegment) => {
      projectStore.getState().withRecording(() =>
        projectStore.getState().recordSegment(trackId, startBeat, segment)
      );
    },
    []
  );

  // 1–7 play the palette's degrees, and record them while armed. `r` arms.
  useRecordShortcuts({ isPlaying, getSongTime, getPool, record: recordGated });

  // A MIDI keyboard plays the selected instrument, and records one note block per
  // key while armed. Same gating as above.
  const midiStatus = useMidiInput({
    isPlaying,
    getSongTime,
    getPool,
    ensureAudio,
    record: recordGated,
  });

  // The touchpad performs the selected instrument's assigned controller, and records
  // the gesture into that controller's lane while armed. Mounted here rather than in
  // the strip that shows it because it listens on the document and owns a flush timer:
  // two of it would sample one gesture twice.
  const touchpad = useTouchpadExpression({ isPlaying, getSongTime, getPool, ensureAudio });

  // Armed and rolling is one take, and one undo step: Ctrl+Z during it scraps the
  // whole take rather than the last block of it.
  useRecordSession(recordArmed && isPlaying, urRef.current);

  // Page the view along during playback so the playhead never runs off screen.
  useFollowPlayhead(playheadBeat, isPlaying);

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
      const ur = urRef.current;
      // Mid-take, undo means "scrap that take" — the whole pass in one press.
      if (ur.hasPassChanges()) {
        projectStore.setState({ project: ur.abortPass() });
        return;
      }
      try {
        ur.undo();
        projectStore.setState({ project: ur.current() });
      } catch { /* at beginning */ }
    }, []),
    redo: useCallback(() => {
      const ur = urRef.current;
      // Stepping the pointer would overwrite material the user is still recording.
      if (ur.hasPassChanges()) return;
      try {
        ur.redo();
        projectStore.setState({ project: ur.current() });
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
    <FormulaLibraryContext.Provider value={formulaLibraries}>
    <TouchpadContext.Provider value={touchpad}>
    <div className="flex flex-col h-screen bg-gray-900 text-gray-100">
      {/* File Menu */}
      <div className="px-4 py-2 bg-gray-800 border-b border-gray-700 flex items-center gap-3">
        <FileMenu />
        {/* Beside the file menu rather than in the transport: which speakers the
            app uses is a property of the machine, set once, not a playback
            control reached for while working. */}
        <AudioSettings />
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
        canRecord={view === 'phrase'}
        recordQuantize={recordQuantize}
        midiStatus={midiStatus}
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
          {/* One surface at a time. The palettes go with the timeline rather than
              staying put: they offer material to drop into a phrase, and there is
              nowhere in the arrangement for a chord to land. */}
          {view === 'arrangement' ? (
            // Takes the height the piano roll gives up below, and scrolls when the
            // song has more instruments than fit — the arrangement grows downwards
            // with the band, which the timeline never did.
            <div className="flex-1 overflow-y-auto">
              <ArrangementView playheadBeat={playheadBeat} />
            </div>
          ) : (
            <>
              {/* Ungated by the bar cursor: the palette carries its own key, so it
                  has material to offer whether or not a bar is selected. */}
              <ScalePalette />

              {/* Under the palette because it composes with it: a formula is
                  realized in the key and register the strip above is set to. */}
              <FormulaPalette />

              <ChordTimeline />
            </>
          )}

          {/* Only under the phrase editor. The roll draws the notes of *one selected
              bar*, and the arrangement has no bar cursor to move — it would sit there
              showing bar 1 of the compiled song for as long as the view was up, taking
              half the height the rows need. Not tabs: the surface is already chosen by
              the arrangement/phrase switch, and a second switch over the same choice
              would only give the user two places to be lost in. */}
          {view === 'phrase' && (
          <div className="flex-1 bg-gray-900 overflow-hidden">
            {selectedBar && (
              <PianoRoll
                bars={surfaceBars}
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
          )}

          {/* The editor's one horizontal scrollbar. Its content spans the key
              column as well, so its range matches what the panes can scroll. */}
          <HorizontalScrollbar
            contentWidth={
              PIANO_KEYS_WIDTH +
              getTotalBeats(surfaceBars, project.timeSignature) * pixelsPerBeat
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
            {/* Exactly one of the two ever has something to show: picking a block in
                the arrangement clears the segment selection, and the other way
                round. */}
            <PhraseInspector />
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
                  onClick={addSurfaceBar}
                  title={
                    editingPhrase
                      ? 'Add a bar to this phrase, everywhere it is played'
                      : 'Add a bar to the end of the song'
                  }
                  className="w-full px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 text-gray-200 rounded transition-colors"
                >
                  Add Bar
                </button>
                <button
                  onClick={() => removeSurfaceBar(selectedBar.id)}
                  title={
                    editingPhrase
                      ? 'Take this bar out of the phrase'
                      : 'Take this bar out of the song'
                  }
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
    </TouchpadContext.Provider>
    </FormulaLibraryContext.Provider>
    </FileIOContext.Provider>
    </UndoRedoContext.Provider>
  );
}

export default App;
