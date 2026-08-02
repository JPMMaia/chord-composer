import React from 'react';
import type { Track } from '@/types/music';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { gmInstrumentsByFamily } from '@/engine/instrumentCatalog';
import { trackColorAt } from '@/utils/constants';

/**
 * The instruments sidebar.
 *
 * Selecting an instrument here is what the chord timeline edits — it shows only
 * the selected instrument's blocks. The two toggles are deliberately separate
 * concerns: mute is about what you *hear*, the eye is about what you *see* on the
 * piano roll, and a hidden instrument still sounds.
 */
export const InstrumentsPanel: React.FC = () => {
  const tracks = projectStore(s => s.project?.tracks);
  const addTrack = projectStore(s => s.addTrack);

  const selectedTrackId = selectionStore(s => s.selectedTrackId);
  const selectTrack = selectionStore(s => s.selectTrack);

  if (!tracks) return null;

  return (
    <div
      data-testid="instruments-panel"
      className="w-60 shrink-0 bg-gray-800 border-r border-gray-700 overflow-y-auto"
    >
      <div className="flex items-center justify-between p-3 border-b border-gray-700">
        <h2 className="text-sm font-semibold text-gray-300">Instruments</h2>
        <button
          // Select the new instrument too: adding one is how you start writing
          // for it, and the timeline shows only what is selected.
          onClick={() => {
            const id = addTrack();
            if (id) selectTrack(id);
          }}
          title="Add an instrument"
          aria-label="Add instrument"
          className="px-2 py-0.5 text-sm bg-gray-700 hover:bg-gray-600 text-gray-200 rounded transition-colors"
        >
          +
        </button>
      </div>

      {tracks.map((track, index) => (
        <InstrumentRow
          key={track.id}
          track={track}
          index={index}
          isSelected={track.id === selectedTrackId}
          onSelect={() => selectTrack(track.id)}
        />
      ))}

      {tracks.length === 0 && (
        <p className="p-3 text-xs text-gray-500 italic">
          No instruments. Add one to start writing.
        </p>
      )}
    </div>
  );
};

interface InstrumentRowProps {
  track: Track;
  index: number;
  isSelected: boolean;
  onSelect: () => void;
}

const InstrumentRow: React.FC<InstrumentRowProps> = ({
  track,
  index,
  isSelected,
  onSelect,
}) => {
  const removeTrack = projectStore(s => s.removeTrack);
  const setTrackInstrument = projectStore(s => s.setTrackInstrument);
  const toggleTrackMute = projectStore(s => s.toggleTrackMute);
  const toggleTrackVisible = projectStore(s => s.toggleTrackVisible);

  // Absent means visible, so that a track from an older file — which carries no
  // flag — shows its notes rather than silently disappearing from the roll.
  const isVisible = track.visible !== false;
  const color = track.color ?? trackColorAt(index);

  return (
    <div
      data-testid={`instrument-row-${track.id}`}
      onPointerDown={onSelect}
      // Matches the selected-bar treatment in the chord timeline, so "what is
      // selected" reads the same way in both panes.
      className={`px-3 py-2 border-b border-gray-700 cursor-pointer transition-colors ${
        isSelected ? 'bg-indigo-900/50' : 'hover:bg-gray-750'
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          data-testid="instrument-swatch"
          style={{ backgroundColor: color }}
          // Dimmed rather than hidden when the notes are: the row still needs to
          // say which colour this instrument owns.
          className={`w-2.5 h-2.5 rounded-sm shrink-0 ${isVisible ? '' : 'opacity-30'}`}
        />
        <span className="flex-1 text-sm text-gray-200 truncate">{track.name}</span>

        <button
          onPointerDown={e => e.stopPropagation()}
          onClick={() => toggleTrackVisible(track.id)}
          title={isVisible ? 'Hide notes from the piano roll' : 'Show notes on the piano roll'}
          aria-label={`${isVisible ? 'Hide' : 'Show'} ${track.name} notes`}
          aria-pressed={!isVisible}
          className={`px-1 text-xs rounded transition-colors ${
            isVisible ? 'text-gray-300 hover:text-white' : 'text-gray-600 hover:text-gray-400'
          }`}
        >
          {isVisible ? '👁' : '🚫'}
        </button>

        <button
          onPointerDown={e => e.stopPropagation()}
          onClick={() => toggleTrackMute(track.id)}
          title={track.muted ? 'Unmute' : 'Mute'}
          aria-label={`${track.muted ? 'Unmute' : 'Mute'} ${track.name}`}
          aria-pressed={track.muted}
          className={`px-1.5 text-xs font-semibold rounded transition-colors ${
            track.muted
              ? 'bg-red-600 text-white'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          M
        </button>

        <button
          onPointerDown={e => e.stopPropagation()}
          onClick={() => removeTrack(track.id)}
          title="Remove this instrument and everything it plays"
          aria-label={`Remove ${track.name}`}
          className="px-1 text-xs text-gray-500 hover:text-red-400 transition-colors"
        >
          ✕
        </button>
      </div>

      <select
        aria-label={`Sound for ${track.name}`}
        value={track.instrument}
        onPointerDown={e => e.stopPropagation()}
        onChange={e => setTrackInstrument(track.id, e.target.value)}
        className="mt-1 w-full bg-gray-700 border border-gray-600 rounded text-gray-200 text-[11px] px-1 py-0.5 focus:outline-none focus:border-indigo-500"
      >
        {/* Grouped by GM family — 128 flat entries is not a navigable list. */}
        {gmInstrumentsByFamily().map(({ family, instruments }) => (
          <optgroup key={family} label={family}>
            {instruments.map(instrument => (
              <option key={instrument.id} value={instrument.id}>
                {instrument.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
};
