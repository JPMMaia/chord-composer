import { useEffect, useState, useCallback } from 'react';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { Transport } from '@/components/Transport';
import { FileMenu } from '@/components/FileMenu';
import { InstrumentsPanel } from '@/components/InstrumentsPanel';
import { ScalePalette } from '@/components/ScalePalette';
import { ChordTimeline } from '@/components/ChordTimeline';
import { PianoRoll } from '@/components/PianoRoll';
import { usePlayback } from '@/hooks/usePlayback';
import { getTotalBeats } from '@/engine/timeline';
import type { NoteName, ScaleType } from '@/types/music';
import { NOTE_NAMES, SCALE_TYPES } from '@/utils/constants';

function App() {
  const project = projectStore(s => s.project);
  const createProject = projectStore(s => s.createProject);
  const setBpm = projectStore(s => s.setBpm);
  const addBar = projectStore(s => s.addBar);
  const removeBar = projectStore(s => s.removeBar);
  const updateBarScale = projectStore(s => s.updateBarScale);

  const selectedBarId = selectionStore(s => s.selectedBarId);
  const selectedSegmentId = selectionStore(s => s.selectedSegmentId);
  const selectBar = selectionStore(s => s.selectBar);

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

  // Auto-select the first bar so the palette always has a scale to work from.
  useEffect(() => {
    if (project && project.bars.length > 0 && !selectedBarId) {
      selectBar(project.bars[0].id);
    }
  }, [project, selectedBarId, selectBar]);

  const selectedSegment = selectedBar?.chords.find(c => c.id === selectedSegmentId);

  // Playback config
  const playbackConfig = project
    ? {
        bpm: project.bpm,
        timeSignature: project.timeSignature,
        bars: project.bars,
        tracks: ['main'],
        loopStart: hasLoopRegion ? 0 : null,
        loopEnd: hasLoopRegion ? getTotalBeats(project.bars, project.timeSignature) : null,
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
        musicalKey={project.key}
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
        <InstrumentsPanel />

        {/* Center — palette strip, chord timeline, piano roll */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {selectedBar && <ScalePalette scale={selectedBar.scale} />}

          <ChordTimeline />

          <div className="flex-1 bg-gray-900 overflow-hidden">
            {selectedBar && (
              <PianoRoll
                bars={project.bars}
                selectedBarId={selectedBar.id}
                playheadBeat={playheadBeat}
                pixelsPerBeat={80}
                pixelsPerOctave={120}
                gridSize={0.25}
                timeSignature={project.timeSignature}
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
                <label className="block text-xs text-gray-400 mb-1" htmlFor="bar-root">
                  Root Note
                </label>
                <select
                  id="bar-root"
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
                <label className="block text-xs text-gray-400 mb-1" htmlFor="bar-scale-type">
                  Scale Type
                </label>
                <select
                  id="bar-scale-type"
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

              {/* Segment inspector */}
              <div className="pt-2 border-t border-gray-700">
                <h3 className="text-xs font-semibold text-gray-400 mb-1">Segment</h3>
                {selectedSegment ? (
                  <div className="text-sm text-gray-300 space-y-0.5">
                    <div>{selectedSegment.chordSymbol ?? selectedSegment.root}</div>
                    <div className="text-xs text-gray-500">
                      {selectedSegment.kind === 'note' ? 'Note' : 'Chord'}
                      {selectedSegment.romanNumeral ? ` · ${selectedSegment.romanNumeral}` : ''}
                    </div>
                    <div className="text-xs text-gray-500">
                      {selectedSegment.duration} beat{selectedSegment.duration !== 1 ? 's' : ''}
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-gray-500">No segment selected</p>
                )}
              </div>

              {/* Bar Info */}
              <div className="pt-2 border-t border-gray-700 space-y-2">
                <div className="text-xs text-gray-400">
                  {selectedBar.chords.length} segment
                  {selectedBar.chords.length !== 1 ? 's' : ''} · {selectedBar.notes.length} note
                  {selectedBar.notes.length !== 1 ? 's' : ''}
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
  );
}

export default App;
