import React from 'react';
import type { Track } from '@/types/music';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { gmInstrumentsByFamily } from '@/engine/instrumentCatalog';
import { vst3Option } from '@/engine/vst3Catalog';
import { isVst3Ref, parseInstrumentRef } from '@/engine/instrumentRef';
import { openVst3Editor } from '@/engine/vst3Editor';
import { useVst3Plugins, type Vst3PluginsState } from '@/hooks/useVst3Plugins';
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

  // Scanned once for the whole panel rather than per row: the scan is native and
  // expensive, and every row offers the same list.
  const vst3 = useVst3Plugins();

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
          vst3={vst3}
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
  /** Empty in a browser build, and until the native scan finishes. */
  vst3: Vst3PluginsState;
}

const InstrumentRow: React.FC<InstrumentRowProps> = ({
  track,
  index,
  isSelected,
  onSelect,
  vst3,
}) => {
  const removeTrack = projectStore(s => s.removeTrack);
  const setTrackInstrument = projectStore(s => s.setTrackInstrument);
  const toggleTrackMute = projectStore(s => s.toggleTrackMute);
  const toggleTrackVisible = projectStore(s => s.toggleTrackVisible);

  // Absent means visible, so that a track from an older file — which carries no
  // flag — shows its notes rather than silently disappearing from the roll.
  const isVisible = track.visible !== false;
  const color = track.color ?? trackColorAt(index);

  const vst3Options = vst3.plugins.map(vst3Option);

  /**
   * A plugin the picker cannot offer — the project names one that is not
   * installed here, or the scan has not finished yet. Without an option
   * carrying this value the `select` would silently display, and on the next
   * change submit, some *other* instrument.
   */
  const unresolved =
    isVst3Ref(track.instrument) && !vst3Options.some(o => o.value === track.instrument)
      ? {
          value: track.instrument,
          label: vst3.loading
            ? 'Loading plugins…'
            : `Missing plugin (${track.instrument.slice(5, 13)}…)`,
        }
      : null;

  const ref = parseInstrumentRef(track.instrument);
  // Offered only for a plugin the scan actually found: opening the editor of
  // something that is not installed can only fail.
  const editable = ref.kind === 'vst3' && !unresolved ? ref.classId : null;

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

      {editable && (
        <button
          onPointerDown={e => e.stopPropagation()}
          onClick={() => {
            openVst3Editor(track.id, editable, track.name).catch(err => {
              console.error('vst3: could not open the editor', err);
            });
          }}
          title="Open this plugin's own editor"
          aria-label={`Open ${track.name} plugin editor`}
          className="mt-1 w-full text-[11px] px-1 py-0.5 rounded bg-indigo-700 hover:bg-indigo-600 text-indigo-100 transition-colors"
        >
          Open plugin editor
        </button>
      )}

      <select
        aria-label={`Sound for ${track.name}`}
        value={track.instrument}
        onPointerDown={e => e.stopPropagation()}
        onChange={e => setTrackInstrument(track.id, e.target.value)}
        className="mt-1 w-full bg-gray-700 border border-gray-600 rounded text-gray-200 text-[11px] px-1 py-0.5 focus:outline-none focus:border-indigo-500"
      >
        {unresolved && (
          <option value={unresolved.value}>{unresolved.label}</option>
        )}

        {/* Above the GM families: on a desktop build these are the sounds the
            user actually reached for, and there are far fewer of them. */}
        {vst3Options.length > 0 && (
          <optgroup label="VST3">
            {vst3Options.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </optgroup>
        )}

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
