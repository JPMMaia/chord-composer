import { useEffect, useState, useCallback } from 'react';
import { projectStore } from '@/store/projectStore';
import { Transport } from '@/components/Transport';
import { FileMenu } from '@/components/FileMenu';
import { ChordEditor } from '@/components/ChordEditor';
import { PianoRoll } from '@/components/PianoRoll';
import { autoFillNotesFromChords, splitBarIntoChords } from '@/engine/chordOperations';
import { usePlayback } from '@/hooks/usePlayback';
import type { ChordSegment, NoteName, ScaleType } from '@/types/music';
import { NOTE_NAMES, SCALE_TYPES } from '@/utils/constants';

function App() {
  const project = projectStore(s => s.project);
  const createProject = projectStore(s => s.createProject);
  const setBpm = projectStore(s => s.setBpm);
  const addBar = projectStore(s => s.addBar);
  const removeBar = projectStore(s => s.removeBar);
  const updateBarScale = projectStore(s => s.updateBarScale);

  const [selectedBarId, setSelectedBarId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [, setMetronomeOn] = useState(false);
  const [hasLoopRegion, setHasLoopRegion] = useState(false);
  const [playheadBeat, setPlayheadBeat] = useState(0);

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

  const selectedBar = project?.bars.find(b => b.id === selectedBarId);

  // Auto-select first bar if none selected
  useEffect(() => {
    if (project && project.bars.length > 0 && !selectedBarId) {
      setSelectedBarId(project.bars[0].id);
    }
  }, [project, selectedBarId]);

  // Playback config
  const playbackConfig = project
    ? {
        bpm: project.bpm,
        timeSignature: project.timeSignature,
        bars: project.bars,
        tracks: ['main'],
        loopStart: hasLoopRegion ? 0 : null,
        loopEnd: hasLoopRegion ? project.bars.length * project.timeSignature.beatsPerMeasure : null,
      }
    : null;

  const { play, pause, stop } = usePlayback(playbackConfig!);

  // Handlers
  const handlePlay = useCallback(() => {
    play();
    setIsPlaying(true);
    setIsPaused(false);
  }, [play]);

  const handlePause = useCallback(() => {
    pause();
    setIsPaused(true);
    setIsPlaying(false);
  }, [pause]);

  const handleStop = useCallback(() => {
    stop();
    setIsPlaying(false);
    setIsPaused(false);
    setPlayheadBeat(0);
  }, [stop]);

  const handleBpmChange = useCallback((bpm: number) => {
    setBpm(bpm);
  }, [setBpm]);

  const handleMetronomeToggle = useCallback(() => {
    setMetronomeOn(prev => !prev);
  }, []);

  const handleLoopToggle = useCallback(() => {
    setHasLoopRegion(prev => !prev);
  }, []);

  const handleNoteClick = useCallback(
    (barId: string, pitch: number, beat: number) => {
      if (!project) return;
      // Note: In a real app, this would update the store
      console.log('Note clicked:', { barId, pitch, beat });
    },
    [project]
  );

  const handleNoteDrag = useCallback(
    (noteId: string, _durationDelta: number) => {
      console.log('Note dragged:', noteId);
    },
    []
  );

  // Chord editor handlers
  const handleChordReorder = useCallback(
    (chords: ChordSegment[]) => {
      if (!project || !selectedBarId) return;
      // Update bar chords in store
      const newBars = project.bars.map(b =>
        b.id === selectedBarId ? { ...b, chords } : b
      );
      projectStore.setState({
        project: { ...project, bars: newBars, updatedAt: new Date() },
      });
    },
    [project, selectedBarId]
  );

  const handleChordAdd = useCallback(
    (chord: ChordSegment) => {
      if (!project || !selectedBarId) return;
      const newBars = project.bars.map(b =>
        b.id === selectedBarId ? { ...b, chords: [...b.chords, chord] } : b
      );
      projectStore.setState({
        project: { ...project, bars: newBars, updatedAt: new Date() },
      });
    },
    [project, selectedBarId]
  );

  const handleChordRemove = useCallback(
    (chordId: string) => {
      if (!project || !selectedBarId) return;
      const newBars = project.bars.map(b =>
        b.id === selectedBarId
          ? { ...b, chords: b.chords.filter(c => c.id !== chordId) }
          : b
      );
      projectStore.setState({
        project: { ...project, bars: newBars, updatedAt: new Date() },
      });
    },
    [project, selectedBarId]
  );

  const handleBarSplit = useCallback(
    (chordCount: number) => {
      if (!project || !selectedBar) return;
      const newChords = splitBarIntoChords(selectedBar, chordCount);
      const newBars = project.bars.map(b =>
        b.id === selectedBarId ? { ...b, chords: newChords } : b
      );
      projectStore.setState({
        project: { ...project, bars: newBars, updatedAt: new Date() },
      });
    },
    [project, selectedBar, selectedBarId]
  );

  const handleAutoFillNotes = useCallback(() => {
    if (!project || !selectedBar || selectedBar.chords.length === 0) return;
    const notes = autoFillNotesFromChords(selectedBar, selectedBar.chords, 4);
    const newBars = project.bars.map(b =>
      b.id === selectedBarId ? { ...b, notes } : b
    );
    projectStore.setState({
      project: { ...project, bars: newBars, updatedAt: new Date() },
    });
  }, [project, selectedBar, selectedBarId]);

  const handleCustomChordInput = useCallback(
    (symbol: string) => {
      if (!project || !selectedBarId) return;
      const newChord: ChordSegment = {
        id: crypto.randomUUID(),
        chordSymbol: symbol,
        duration: 1,
      };
      const newBars = project.bars.map(b =>
        b.id === selectedBarId ? { ...b, chords: [...b.chords, newChord] } : b
      );
      projectStore.setState({
        project: { ...project, bars: newBars, updatedAt: new Date() },
      });
    },
    [project, selectedBarId]
  );

  if (!project) return null;

  return (
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
        key={project.key}
        keyMode={project.keyMode}
        hasLoopRegion={hasLoopRegion}
        onPlay={handlePlay}
        onPause={handlePause}
        onStop={handleStop}
        onBpmChange={handleBpmChange}
        onMetronomeToggle={handleMetronomeToggle}
        onLoopToggle={handleLoopToggle}
      />

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar - Bar List */}
        <div className="w-48 bg-gray-800 border-r border-gray-700 overflow-y-auto">
          <div className="p-3 border-b border-gray-700">
            <h2 className="text-sm font-semibold text-gray-300">Bars</h2>
          </div>
          {project.bars.map((bar, index) => (
            <button
              key={bar.id}
              onClick={() => setSelectedBarId(bar.id)}
              className={`w-full text-left px-3 py-2 text-sm border-b border-gray-700 transition-colors ${
                selectedBarId === bar.id
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
              }`}
            >
              <div className="font-medium">Bar {index + 1}</div>
              <div className="text-xs opacity-75">
                {bar.scale.root} {bar.scale.type.replace(/([A-Z])/g, ' $1').trim()}
              </div>
            </button>
          ))}
          <button
            onClick={addBar}
            className="w-full text-left px-3 py-2 text-sm text-indigo-400 hover:bg-gray-700 transition-colors"
          >
            + Add Bar
          </button>
        </div>

        {/* Center - Chord Editor + Piano Roll */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Chord Editor */}
          <div className="p-4 border-b border-gray-700 bg-gray-800">
            {selectedBar ? (
              <ChordEditor
                bar={selectedBar}
                scale={selectedBar.scale}
                onChordReorder={handleChordReorder}
                onChordAdd={handleChordAdd}
                onChordRemove={handleChordRemove}
                onBarSplit={handleBarSplit}
                onAutoFillNotes={handleAutoFillNotes}
                onCustomChordInput={handleCustomChordInput}
                selectedChordId={undefined}
              />
            ) : (
              <p className="text-sm text-gray-500">Select a bar to edit chords</p>
            )}
          </div>

          {/* Piano Roll */}
          <div className="flex-1 bg-gray-900">
            {selectedBar && (
              <PianoRoll
                bars={project.bars}
                selectedBarId={selectedBar.id}
                playheadBeat={playheadBeat}
                pixelsPerBeat={80}
                pixelsPerOctave={120}
                gridSize={0.25}
                onNoteClick={handleNoteClick}
                onNoteDrag={handleNoteDrag}
              />
            )}
          </div>
        </div>

        {/* Right Sidebar - Properties */}
        <div className="w-56 bg-gray-800 border-l border-gray-700 overflow-y-auto">
          <div className="p-3 border-b border-gray-700">
            <h2 className="text-sm font-semibold text-gray-300">Properties</h2>
          </div>

          {selectedBar && (
            <div className="p-3 space-y-4">
              {/* Scale Settings */}
              <div>
                <label className="block text-xs text-gray-400 mb-1">Root Note</label>
                <select
                  value={selectedBar.scale.root}
                  onChange={e =>
                    updateBarScale(selectedBar.id, {
                      root: e.target.value as NoteName,
                      type: selectedBar.scale.type,
                    })
                  }
                  className="w-full px-2 py-1.5 text-sm bg-gray-700 border border-gray-600 rounded text-gray-200 focus:outline-none focus:border-indigo-500"
                >
                  {NOTE_NAMES.map(note => (
                    <option key={note} value={note}>{note}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1">Scale Type</label>
                <select
                  value={selectedBar.scale.type}
                  onChange={e =>
                    updateBarScale(selectedBar.id, {
                      root: selectedBar.scale.root,
                      type: e.target.value as ScaleType,
                    })
                  }
                  className="w-full px-2 py-1.5 text-sm bg-gray-700 border border-gray-600 rounded text-gray-200 focus:outline-none focus:border-indigo-500"
                >
                  {SCALE_TYPES.map(type => (
                    <option key={type} value={type}>
                      {type.replace(/([A-Z])/g, ' $1').trim()}
                    </option>
                  ))}
                </select>
              </div>

              {/* Bar Info */}
              <div>
                <label className="block text-xs text-gray-400 mb-1">Chords</label>
                <div className="text-sm text-gray-300">
                  {selectedBar.chords.length} chord{selectedBar.chords.length !== 1 ? 's' : ''}
                </div>
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1">Notes</label>
                <div className="text-sm text-gray-300">
                  {selectedBar.notes.length} note{selectedBar.notes.length !== 1 ? 's' : ''}
                </div>
              </div>

              {/* Actions */}
              <div className="pt-2 border-t border-gray-700">
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
  );
}

export default App;
