import React, { useRef, useState } from 'react';
import type { Track, TrackGroup } from '@/types/music';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { dropPlacement, panelLayout, type TrackRow } from '@/engine/trackGroups';
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
 * What a drag is carrying.
 *
 * Two types rather than one payload with a discriminator inside it, because the
 * drop targets need to know *before* the drop what they are being offered: a group
 * header highlights differently for an instrument arriving than for another group
 * pushing past it, and `dragOver` can read the types but not the data.
 */
const INSTRUMENT_DRAG_TYPE = 'application/x-instrument';
const GROUP_DRAG_TYPE = 'application/x-instrument-group';

/**
 * Where the drop would land, for the insertion caret.
 *
 * Held at the panel rather than per row because only one can be showing at a time,
 * and a row that has just been dragged past must stop showing its own.
 */
type DropHint =
  | { kind: 'track'; trackId: string; edge: 'above' | 'below' }
  | { kind: 'group'; groupId: string }
  | { kind: 'end' };

/** Which half of an element the pointer is in. */
function edgeOf(e: React.DragEvent, element: HTMLElement): 'above' | 'below' {
  const box = element.getBoundingClientRect();
  return e.clientY < box.top + box.height / 2 ? 'above' : 'below';
}

/**
 * Read a drag's payload, or null when it is carrying something else.
 *
 * `text/plain` is set alongside the real type and read as the fallback because
 * jsdom exposes it far more reliably than a custom one, which is what the tests
 * for every other drag in this app already rely on.
 */
function dragPayload(e: React.DragEvent, type: string): string | null {
  const id = e.dataTransfer.getData(type) || e.dataTransfer.getData('text/plain');
  return id || null;
}

/** True when this drag is carrying the given kind of thing. */
function isDragging(e: React.DragEvent, type: string): boolean {
  // `types` is the only thing readable during dragover; the data itself is not.
  return e.dataTransfer.types.includes(type);
}

/**
 * The instruments sidebar.
 *
 * Selecting an instrument here is what the chord timeline edits — it shows only
 * the selected instrument's blocks. The toggles are deliberately separate
 * concerns: mute is about what you *hear*, the eye is about what you *see* on
 * the piano roll, and a hidden instrument still sounds.
 *
 * Instruments can be dragged to reorder, and into and out of groups. A group is a
 * label over a run of instruments: collapsing it folds its rows away, and its mute
 * and solo sit beside its members' own rather than overwriting them, so ungrouping
 * hands back the mix the user built.
 */
export const InstrumentsPanel: React.FC = () => {
  const tracks = projectStore(s => s.project?.tracks);
  const groups = projectStore(s => s.project?.trackGroups);
  const addTrack = projectStore(s => s.addTrack);
  const addTrackGroup = projectStore(s => s.addTrackGroup);
  const moveTrack = projectStore(s => s.moveTrack);
  const moveTrackGroup = projectStore(s => s.moveTrackGroup);

  const selectedTrackId = selectionStore(s => s.selectedTrackId);
  const selectTrack = selectionStore(s => s.selectTrack);

  const [hint, setHint] = useState<DropHint | null>(null);

  // Scanned once for the whole panel rather than per row: the scan is native and
  // expensive, and every row offers the same list.
  const vst3 = useVst3Plugins();

  // Held at the panel for a different reason: loading a file in one row has to appear
  // in every other row's picker, and one piece of state is what makes that automatic.
  const sfz = useSfzInstruments();

  if (!tracks) return null;

  const rows = panelLayout(tracks, groups ?? []);

  const drag: DragContext = {
    hint,
    setHint,
    onDropTrack: (trackId, groupId, beforeTrackId) => {
      setHint(null);
      moveTrack(trackId, groupId, beforeTrackId);
    },
    onDropGroup: (groupId, beforeGroupId) => {
      setHint(null);
      moveTrackGroup(groupId, beforeGroupId);
    },
  };

  return (
    <div
      data-testid="instruments-panel"
      className="w-60 shrink-0 bg-gray-800 border-r border-gray-700 overflow-y-auto flex flex-col"
    >
      <div className="flex items-center justify-between p-3 border-b border-gray-700">
        <h2 className="text-sm font-semibold text-gray-300">Instruments</h2>
        <div className="flex items-center gap-1">
          <button
            onClick={() => addTrackGroup()}
            title="Add a group to organise instruments into"
            aria-label="Add group"
            className="px-2 py-0.5 text-[11px] bg-gray-700 hover:bg-gray-600 text-gray-200 rounded transition-colors"
          >
            + Group
          </button>
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
      </div>

      {rows.map(row =>
        row.kind === 'group' ? (
          <InstrumentGroup
            key={row.group.id}
            group={row.group}
            members={row.members}
            selectedTrackId={selectedTrackId}
            onSelect={selectTrack}
            drag={drag}
            vst3={vst3}
            sfz={sfz}
          />
        ) : (
          <InstrumentRow
            key={row.track.id}
            track={row.track}
            index={row.index}
            isSelected={row.track.id === selectedTrackId}
            onSelect={(id?: string) => selectTrack(id ?? row.track.id)}
            drag={drag}
            vst3={vst3}
            sfz={sfz}
          />
        )
      )}

      {tracks.length === 0 && (groups?.length ?? 0) === 0 && (
        <p className="p-3 text-xs text-gray-500 italic">
          No instruments. Add one to start writing.
        </p>
      )}

      {/* The tail. Dropping here means "ungrouped, at the end" — without it there
          would be no way to pull the last instrument out of the last group, since
          every row above it belongs to one. Grows to fill the panel so the target
          is the whole empty space rather than a sliver. */}
      <div
        data-testid="instruments-drop-end"
        onDragOver={e => {
          if (!isDragging(e, INSTRUMENT_DRAG_TYPE) && !isDragging(e, GROUP_DRAG_TYPE)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setHint({ kind: 'end' });
        }}
        onDragLeave={() => setHint(null)}
        onDrop={e => {
          e.preventDefault();
          const groupId = dragPayload(e, GROUP_DRAG_TYPE);
          if (isDragging(e, GROUP_DRAG_TYPE) && groupId) {
            drag.onDropGroup(groupId, null);
            return;
          }
          const trackId = dragPayload(e, INSTRUMENT_DRAG_TYPE);
          if (trackId) drag.onDropTrack(trackId, null, null);
        }}
        className="min-h-8 grow"
      >
        {hint?.kind === 'end' && <div className="h-0.5 bg-indigo-500" />}
      </div>
    </div>
  );
};

/** What every row needs to take part in a drag, threaded down from the panel. */
interface DragContext {
  hint: DropHint | null;
  setHint: (hint: DropHint | null) => void;
  onDropTrack: (
    trackId: string,
    groupId: string | null,
    beforeTrackId: string | null
  ) => void;
  onDropGroup: (groupId: string, beforeGroupId: string | null) => void;
}

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

interface InstrumentGroupProps {
  group: TrackGroup;
  members: TrackRow[];
  selectedTrackId: string | null;
  onSelect: (trackId: string | null) => void;
  drag: DragContext;
  vst3: Vst3PluginsState;
  sfz: SfzInstrumentsState;
}

/**
 * A group's header and, unless it is folded away, its instruments.
 *
 * The header is a drop target in its own right: dropping an instrument on it means
 * "join this group, at the end", which is the only way to get into a group that is
 * collapsed or has nothing in it yet.
 */
const InstrumentGroup: React.FC<InstrumentGroupProps> = ({
  group,
  members,
  selectedTrackId,
  onSelect,
  drag,
  vst3,
  sfz,
}) => {
  const addTrack = projectStore(s => s.addTrack);
  const moveTrack = projectStore(s => s.moveTrack);
  const removeTrackGroup = projectStore(s => s.removeTrackGroup);
  const renameTrackGroup = projectStore(s => s.renameTrackGroup);
  const toggleCollapsed = projectStore(s => s.toggleTrackGroupCollapsed);
  const toggleMute = projectStore(s => s.toggleTrackGroupMute);
  const toggleSolo = projectStore(s => s.toggleTrackGroupSolo);

  const [isEditing, setIsEditing] = useState(false);
  const [draftName, setDraftName] = useState(group.name);
  const inputRef = useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (isEditing) inputRef.current?.focus();
  }, [isEditing]);

  const commitRename = () => {
    if (draftName !== group.name) renameTrackGroup(group.id, draftName);
    setIsEditing(false);
  };

  const collapsed = group.collapsed === true;
  const isDropTarget = drag.hint?.kind === 'group' && drag.hint.groupId === group.id;

  return (
    <div data-testid={`instrument-group-${group.id}`}>
      <div
        onDragOver={e => {
          if (!isDragging(e, INSTRUMENT_DRAG_TYPE) && !isDragging(e, GROUP_DRAG_TYPE)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          drag.setHint({ kind: 'group', groupId: group.id });
        }}
        onDragLeave={() => drag.setHint(null)}
        onDrop={e => {
          e.preventDefault();
          if (isDragging(e, GROUP_DRAG_TYPE)) {
            const draggedGroup = dragPayload(e, GROUP_DRAG_TYPE);
            if (draggedGroup) drag.onDropGroup(draggedGroup, group.id);
            return;
          }
          const trackId = dragPayload(e, INSTRUMENT_DRAG_TYPE);
          if (trackId) drag.onDropTrack(trackId, group.id, null);
        }}
        className={`flex items-center gap-1 px-2 py-1.5 bg-gray-900/60 border-b border-gray-700 ${
          isDropTarget ? 'ring-1 ring-inset ring-indigo-500' : ''
        }`}
      >
        <span
          draggable
          onDragStart={e => {
            e.dataTransfer.setData(GROUP_DRAG_TYPE, group.id);
            e.dataTransfer.setData('text/plain', group.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragEnd={() => drag.setHint(null)}
          title={`Drag to move ${group.name}`}
          aria-label={`Reorder ${group.name}`}
          className="cursor-grab text-gray-600 hover:text-gray-400 text-xs select-none"
        >
          ⠿
        </span>

        <button
          onClick={() => toggleCollapsed(group.id)}
          title={collapsed ? 'Expand' : 'Collapse'}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${group.name}`}
          aria-expanded={!collapsed}
          className="px-0.5 text-[10px] text-gray-400 hover:text-gray-200 transition-colors"
        >
          {collapsed ? '▸' : '▾'}
        </button>

        <span
          data-testid="group-swatch"
          style={{ backgroundColor: group.color }}
          className="w-2 h-2 rounded-full shrink-0"
        />

        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={draftName}
            autoFocus
            aria-label={`Rename ${group.name}`}
            onKeyDown={e => {
              e.stopPropagation();
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') {
                setDraftName(group.name);
                setIsEditing(false);
              }
            }}
            onBlur={commitRename}
            onChange={e => setDraftName(e.target.value)}
            className="flex-1 min-w-0 text-xs bg-gray-700 border border-indigo-500 rounded px-1 text-gray-200 focus:outline-none"
          />
        ) : (
          <span
            onDoubleClick={() => {
              setDraftName(group.name);
              setIsEditing(true);
            }}
            title="Double-click to rename"
            className="flex-1 min-w-0 text-xs font-semibold text-gray-300 truncate cursor-text"
          >
            {group.name}
          </span>
        )}

        {/* Only when folded: expanded, the rows below say how many there are. */}
        {collapsed && (
          <span className="text-[10px] text-gray-500 tabular-nums">{members.length}</span>
        )}

        <button
          onClick={() => toggleMute(group.id)}
          title={group.muted ? 'Unmute this group' : 'Silence every instrument in this group'}
          aria-label={`${group.muted ? 'Unmute' : 'Mute'} group ${group.name}`}
          aria-pressed={group.muted === true}
          className={`px-1 text-[10px] font-semibold rounded transition-colors ${
            group.muted ? 'bg-red-600 text-white' : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          M
        </button>

        <button
          onClick={() => toggleSolo(group.id)}
          title={group.solo ? 'Unsolo this group' : 'Hear only this group'}
          aria-label={`${group.solo ? 'Unsolo' : 'Solo'} group ${group.name}`}
          aria-pressed={group.solo === true}
          className={`px-1 text-[10px] font-semibold rounded transition-colors ${
            group.solo ? 'bg-amber-500 text-gray-900' : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          S
        </button>

        <button
          onClick={() => {
            const id = addTrack();
            if (!id) return;
            moveTrack(id, group.id, null);
            onSelect(id);
          }}
          title={`Add an instrument to ${group.name}`}
          aria-label={`Add instrument to ${group.name}`}
          className="px-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
        >
          +
        </button>

        <button
          onClick={() => removeTrackGroup(group.id)}
          title="Remove this group (its instruments stay)"
          aria-label={`Remove group ${group.name}`}
          className="px-1 text-xs text-gray-500 hover:text-red-400 transition-colors"
        >
          ✕
        </button>
      </div>

      {isDropTarget && <div className="h-0.5 bg-indigo-500" />}

      {!collapsed &&
        members.map(({ track, index }) => (
          <InstrumentRow
            key={track.id}
            track={track}
            index={index}
            isSelected={track.id === selectedTrackId}
            onSelect={(id?: string) => onSelect(id ?? track.id)}
            drag={drag}
            groupMuted={group.muted === true}
            indented
            vst3={vst3}
            sfz={sfz}
          />
        ))}

      {!collapsed && members.length === 0 && (
        <p className="px-3 py-2 text-[11px] text-gray-600 italic border-b border-gray-700">
          Empty — drag instruments onto this header.
        </p>
      )}
    </div>
  );
};

interface InstrumentRowProps {
  track: Track;
  index: number;
  isSelected: boolean;
  onSelect: (trackId?: string) => void;
  drag: DragContext;
  /** Whether this instrument's group is silencing it, whatever its own mute says. */
  groupMuted?: boolean;
  /** Set on a row inside a group, to sit it under the header. */
  indented?: boolean;
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
  drag,
  groupMuted = false,
  indented = false,
  vst3,
  sfz,
}) => {
  const tracks = projectStore(s => s.project?.tracks);
  const duplicateTrack = projectStore(s => s.duplicateTrack);
  const removeTrack = projectStore(s => s.removeTrack);
  const renameTrack = projectStore(s => s.renameTrack);
  const setTrackInstrument = projectStore(s => s.setTrackInstrument);
  const setTrackVolume = projectStore(s => s.setTrackVolume);
  const toggleTrackMute = projectStore(s => s.toggleTrackMute);
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
  /** Whether a volume curve is driving this instrument instead of the fader. */
  const automated = (track.volumeAutomation?.length ?? 0) > 0;

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

  /** The caret showing where a drop on this row would put the dragged instrument. */
  const hintEdge =
    drag.hint?.kind === 'track' && drag.hint.trackId === track.id ? drag.hint.edge : null;

  /** Move this instrument one position, for the keyboard. */
  const nudge = (delta: -1 | 1) => {
    if (!tracks) return;
    const at = tracks.findIndex(t => t.id === track.id);
    const neighbour = tracks[at + delta];
    // Off the end in either direction: nothing above the first row, and below the
    // last one there is only the ungrouped tail, which is where it already is.
    if (!neighbour) {
      if (delta === 1 && track.groupId) drag.onDropTrack(track.id, null, null);
      return;
    }
    const { groupId, beforeTrackId } = dropPlacement(
      tracks,
      neighbour.id,
      delta === -1 ? 'above' : 'below'
    );
    drag.onDropTrack(track.id, groupId, beforeTrackId);
  };

  return (
    <div
      data-testid={`instrument-row-${track.id}`}
      onPointerDown={() => onSelect()}
      onDragOver={e => {
        if (!isDragging(e, INSTRUMENT_DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        drag.setHint({
          kind: 'track',
          trackId: track.id,
          edge: edgeOf(e, e.currentTarget),
        });
      }}
      onDragLeave={() => drag.setHint(null)}
      onDrop={e => {
        e.preventDefault();
        const dragged = dragPayload(e, INSTRUMENT_DRAG_TYPE);
        if (!dragged || !tracks) return;
        const { groupId, beforeTrackId } = dropPlacement(
          tracks,
          track.id,
          edgeOf(e, e.currentTarget)
        );
        drag.onDropTrack(dragged, groupId, beforeTrackId);
      }}
      // Matches the selected-bar treatment in the chord timeline, so "what is
      // selected" reads the same way in both panes.
      className={`relative px-3 py-2 border-b border-gray-700 cursor-pointer transition-colors ${
        indented ? 'pl-5' : ''
      } ${isSelected ? 'bg-indigo-900/50' : 'hover:bg-gray-750'} ${
        // Its group is silencing it. Dimmed rather than shown as muted, because its
        // own M button is still off and flipping it would be a lie about the state.
        groupMuted ? 'opacity-50' : ''
      }`}
    >
      {hintEdge && (
        <div
          className={`absolute left-0 right-0 h-0.5 bg-indigo-500 ${
            hintEdge === 'above' ? 'top-0' : 'bottom-0'
          }`}
        />
      )}
      {/* Tighter than the rest of the app's rows: the handle costs width the name
          was using, and an instrument's name is the thing this row exists to show. */}
      <div className="flex items-center gap-1.5">
        <span
          draggable
          onPointerDown={e => e.stopPropagation()}
          onDragStart={e => {
            e.dataTransfer.setData(INSTRUMENT_DRAG_TYPE, track.id);
            e.dataTransfer.setData('text/plain', track.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragEnd={() => drag.setHint(null)}
          // The handle is also the keyboard route: a drag-only reorder would be
          // unreachable without a pointer.
          tabIndex={0}
          role="button"
          onKeyDown={e => {
            if (!e.altKey) return;
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              nudge(-1);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              nudge(1);
            }
          }}
          title={`Drag to move ${track.name}, or Alt+↑/↓`}
          aria-label={`Reorder ${track.name}`}
          className="cursor-grab text-gray-600 hover:text-gray-400 text-xs select-none focus:outline-none focus:text-indigo-400"
        >
          ⠿
        </span>
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

      {/* The instrument's level. Disabled once a curve exists, because the curve
          overrides it outright — leaving a live fader that changed nothing would be
          the more confusing of the two. */}
      <div className="mt-1 flex items-center gap-1.5">
        <span className="text-[10px] text-gray-500 w-6 shrink-0">Vol</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={track.volume}
          disabled={automated}
          aria-label={`Volume ${track.name}`}
          title={
            automated
              ? 'This instrument follows its volume curve; clear the curve to use this'
              : 'Instrument volume'
          }
          onPointerDown={e => e.stopPropagation()}
          onChange={e => setTrackVolume(track.id, Number(e.target.value))}
          className="flex-1 h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed"
        />
        <span className="text-[10px] text-gray-500 w-7 text-right shrink-0 tabular-nums">
          {Math.round(track.volume * 100)}
        </span>
      </div>
    </div>
  );
};
