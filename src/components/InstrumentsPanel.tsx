import React, { useRef, useState } from 'react';
import type { Track } from '@/types/music';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { gmInstrumentsByFamily } from '@/engine/instrumentCatalog';
import { vst3Option } from '@/engine/vst3Catalog';
import { sfzNameFor, sfzOption } from '@/engine/sfzCatalog';
import { isSfzRef, isVst3Ref, parseInstrumentRef } from '@/engine/instrumentRef';
import { openVst3Editor } from '@/engine/vst3Editor';
import { isTauri } from '@/engine/platform';
import { useVst3Plugins, type Vst3PluginsState } from '@/hooks/useVst3Plugins';
import { useSfzInstruments, type SfzInstrumentsState } from '@/hooks/useSfzInstruments';
import { trackColorAt } from '@/utils/constants';

/**
 * The picker value that means "open the file dialog" rather than "play this".
 *
 * A `<select>` can only offer sounds that already exist, and an SFZ on disk does not
 * exist as far as the app is concerned until someone points at it — so one entry in
 * the list is a verb rather than a noun.
 */
const LOAD_SFZ_VALUE = '__load-sfz__';

/**
 * The instruments sidebar.
 *
 * Selecting an instrument here is what the chord timeline edits — it shows only
 * the selected instrument's blocks. The toggles are deliberately separate
 * concerns: mute and solo are about what you *hear*, the eye is about what you
 * *see* on the piano roll, and a hidden instrument still sounds.
 */
export const InstrumentsPanel: React.FC = () => {
  const tracks = projectStore(s => s.project?.tracks);
  const addTrack = projectStore(s => s.addTrack);

  const selectedTrackId = selectionStore(s => s.selectedTrackId);
  const selectTrack = selectionStore(s => s.selectTrack);

  // Scanned once for the whole panel rather than per row: the scan is native and
  // expensive, and every row offers the same list.
  const vst3 = useVst3Plugins();

  // Held at the panel for a different reason: loading a file in one row has to appear
  // in every other row's picker, and one piece of state is what makes that automatic.
  const sfz = useSfzInstruments();

  // Solo is a project-wide mode, not a per-row one — see `isTrackAudible` — so
  // whether anything is soloed has to be decided here, where every row is known.
  const anySoloed = tracks?.some(t => t.solo) ?? false;

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
          onSelect={(id?: string) => selectTrack(id ?? track.id)}
          silencedBySolo={anySoloed && !track.solo}
          vst3={vst3}
          sfz={sfz}
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

/**
 * Whether a track's sound is one the picker has no option for.
 *
 * Only ever true of a prefixed ref: a General MIDI id is always in the list, and an
 * unrecognised one already resolves to the acoustic grand further down.
 */
function unlistedRef(
  instrument: string,
  vst3Options: { value: string }[],
  sfzOptions: { value: string }[]
): boolean {
  if (isVst3Ref(instrument)) return !vst3Options.some(o => o.value === instrument);
  if (isSfzRef(instrument)) return !sfzOptions.some(o => o.value === instrument);
  return false;
}

interface InstrumentRowProps {
  track: Track;
  index: number;
  isSelected: boolean;
  onSelect: (trackId?: string) => void;
  /** Another instrument is soloed, so this one — though unmuted — is not heard. */
  silencedBySolo: boolean;
  /** Empty in a browser build, and until the native scan finishes. */
  vst3: Vst3PluginsState;
  /** The sample sets this machine has been shown. Empty in a browser build. */
  sfz: SfzInstrumentsState;
}

const InstrumentRow: React.FC<InstrumentRowProps> = ({
  track,
  index,
  isSelected,
  onSelect,
  silencedBySolo,
  vst3,
  sfz,
}) => {
  const duplicateTrack = projectStore(s => s.duplicateTrack);
  const removeTrack = projectStore(s => s.removeTrack);
  const renameTrack = projectStore(s => s.renameTrack);
  const setTrackInstrument = projectStore(s => s.setTrackInstrument);
  const toggleTrackMute = projectStore(s => s.toggleTrackMute);
  const toggleTrackSolo = projectStore(s => s.toggleTrackSolo);
  const toggleTrackVisible = projectStore(s => s.toggleTrackVisible);

  const [isEditing, setIsEditing] = useState(false);
  const [draftName, setDraftName] = useState(track.name);
  const inputRef = useRef<HTMLInputElement>(null);

  /** Commit the draft and exit edit mode. */
  const commitRename = () => {
    if (draftName !== track.name) {
      renameTrack(track.id, draftName);
    }
    setIsEditing(false);
  };

  /** Exit edit mode without saving. */
  const cancelRename = () => {
    setDraftName(track.name);
    setIsEditing(false);
  };

  /** Enter edit mode seeded with the current name. */
  const startRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraftName(track.name);
    setIsEditing(true);
  };

  // Focus the input when editing starts so the user can type immediately.
  React.useEffect(() => {
    if (isEditing) inputRef.current?.focus();
  }, [isEditing]);

  // Absent means visible, so that a track from an older file — which carries no
  // flag — shows its notes rather than silently disappearing from the roll.
  const isVisible = track.visible !== false;
  const color = track.color ?? trackColorAt(index);

  const vst3Options = vst3.plugins.map(vst3Option);
  const sfzOptions = sfz.instruments.map(sfzOption);
  const ref = parseInstrumentRef(track.instrument);

  /**
   * A sound the picker cannot offer — the project names a plugin that is not
   * installed here or a sample set this machine has not been shown, or the scan
   * has not finished yet. Without an option carrying this value the `select`
   * would silently display, and on the next change submit, some *other*
   * instrument.
   */
  const unresolved = !unlistedRef(track.instrument, vst3Options, sfzOptions)
    ? null
    : isVst3Ref(track.instrument)
      ? {
          value: track.instrument,
          label: vst3.loading
            ? 'Loading plugins…'
            : `Missing plugin (${track.instrument.slice(5, 13)}…)`,
        }
      : {
          // Not "missing": unlike a plugin there was no scan, so all this says is
          // that the list has not seen the file — usually a project from another
          // machine. The instrument still loads if the path is good.
          value: track.instrument,
          label: `SFZ ${ref.kind === 'sfz' ? sfzNameFor(ref.path) : track.instrument}`,
        };

  /**
   * Ask for a file, and set the sound only once one comes back.
   *
   * The dialog is asynchronous, so the `select` is put back to what the track really
   * plays first: until the user has chosen, the row must not claim a sound it has not
   * got, and a cancelled dialog must leave it exactly as it was.
   */
  const loadSfz = (picker: HTMLSelectElement) => {
    picker.value = track.instrument;
    sfz
      .add()
      .then(instrument => {
        if (instrument) setTrackInstrument(track.id, instrument);
      })
      .catch(err => {
        console.error('sfz: could not load the instrument', err);
      });
  };

  // Offered only for a plugin the scan actually found: opening the editor of
  // something that is not installed can only fail.
  const editable = ref.kind === 'vst3' && !unresolved ? ref.classId : null;

  return (
    <div
      data-testid={`instrument-row-${track.id}`}
      onPointerDown={() => onSelect()}
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
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={draftName}
            autoFocus
            onPointerDown={e => e.stopPropagation()}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                commitRename();
              } else if (e.key === 'Escape') {
                cancelRename();
              }
            }}
            onBlur={commitRename}
            onChange={e => setDraftName(e.target.value)}
            className="flex-1 text-sm bg-gray-700 border border-indigo-500 rounded px-1 text-gray-200 focus:outline-none"
          />
        ) : (
          <span
            onDoubleClick={startRename}
            title="Double-click to rename"
            className="flex-1 text-sm text-gray-200 truncate cursor-text"
          >
            {track.name}
          </span>
        )}

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
          onClick={() => toggleTrackSolo(track.id)}
          title={
            track.solo
              ? 'Unsolo'
              : 'Solo — silence every instrument that is not soloed'
          }
          aria-label={`${track.solo ? 'Unsolo' : 'Solo'} ${track.name}`}
          aria-pressed={track.solo}
          className={`px-1.5 text-xs font-semibold rounded transition-colors ${
            track.solo
              ? 'bg-yellow-500 text-gray-900'
              // Dimmed to say *why* it is silent: something else is soloed, so
              // this instrument is not being heard even though it is unmuted.
              : silencedBySolo
                ? 'text-yellow-600/70 hover:text-yellow-400'
                : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          S
        </button>

        <button
          onPointerDown={e => e.stopPropagation()}
          onClick={() => {
            const newId = duplicateTrack(track.id);
            if (newId) onSelect(newId);
          }}
          title={`Duplicate ${track.name}`}
          aria-label={`Duplicate ${track.name}`}
          className="px-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
        >
          ⧉
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
        onChange={e => {
          if (e.target.value === LOAD_SFZ_VALUE) {
            loadSfz(e.target);
            return;
          }
          setTrackInstrument(track.id, e.target.value);
        }}
        className="mt-1 w-full bg-gray-700 border border-gray-600 rounded text-gray-200 text-[11px] px-1 py-0.5 focus:outline-none focus:border-indigo-500"
      >
        {unresolved && (
          <option value={unresolved.value}>{unresolved.label}</option>
        )}

        {/* Desktop only: there is no way to read a file by path in a browser, so
            offering to load one there could only ever fail. */}
        {isTauri() && (
          <optgroup label="SFZ">
            {sfzOptions.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            <option value={LOAD_SFZ_VALUE}>Load SFZ file…</option>
          </optgroup>
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
