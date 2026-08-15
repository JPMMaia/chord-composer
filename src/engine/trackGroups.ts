/**
 * Grouping and ordering for the instruments sidebar.
 *
 * The model here rests on one decision: `Project.tracks` is the single source of
 * instrument order, and a group is nothing more than a *contiguous run* of tracks
 * carrying the same `groupId`. The alternative — a list of member ids on each group —
 * would mean two arrays that can disagree about where an instrument is, and every
 * add, remove and duplicate would have to remember to update both.
 *
 * Contiguity is therefore an invariant, but it is enforced rather than assumed:
 * `normalizeTrackOrder` is run after every grouping mutation and on every file read,
 * so a hand-edited file, or a bug elsewhere, produces a slightly-reordered sidebar
 * instead of a group split into pieces.
 *
 * The one thing `tracks` cannot express is a group with no members yet — it has no
 * position in an array it appears in zero times. Those keep their place in
 * `Project.trackGroups` and render after everything else, which is where a group the
 * user just created would appear anyway. As soon as it has members it sits where its
 * members sit.
 *
 * Everything in this module is pure: it takes arrays and returns new ones, so the
 * store can call it inside a `set` and the tests can call it without a store at all.
 */
import type { Track, TrackGroup } from '@/types/music';

/**
 * The group an instrument sits in, or null when it is ungrouped.
 *
 * A `groupId` naming no group also reads as ungrouped rather than throwing: that is
 * what a project whose group was removed by an older build looks like, and an
 * instrument is never worth losing over a dangling label.
 */
export function groupOf(track: Track, groups: TrackGroup[]): TrackGroup | null {
  if (!track.groupId) return null;
  return groups.find(g => g.id === track.groupId) ?? null;
}

/** Every instrument in a group, in `tracks` order. */
export function tracksInGroup(tracks: Track[], groupId: string): Track[] {
  return tracks.filter(t => t.groupId === groupId);
}

/**
 * Reorder `tracks` so each group's members are contiguous, and drop `groupId`s
 * that name no group.
 *
 * A group's run lands where its *first* member was, and the order within a run —
 * and among the ungrouped tracks — is left exactly as it was. So normalizing an
 * already-normal array returns the same order, and normalizing a scattered one
 * moves as few instruments as it can.
 */
export function normalizeTrackOrder(tracks: Track[], groups: TrackGroup[]): Track[] {
  const known = new Set(groups.map(g => g.id));

  // A dangling groupId is cleared here rather than left to read as ungrouped
  // downstream, so the array that comes out is the one that gets saved.
  const cleaned = tracks.map(t =>
    t.groupId && !known.has(t.groupId) ? stripGroup(t) : t
  );

  const result: Track[] = [];
  const placed = new Set<string>();

  for (const track of cleaned) {
    if (placed.has(track.id)) continue;

    if (!track.groupId) {
      result.push(track);
      placed.add(track.id);
      continue;
    }

    // The first member of a group drags the whole run along with it, which is what
    // pins the run to this position.
    for (const member of cleaned.filter(t => t.groupId === track.groupId)) {
      result.push(member);
      placed.add(member.id);
    }
  }

  return result;
}

/** The same instrument, ungrouped. Written out because `groupId: undefined` would serialize. */
function stripGroup(track: Track): Track {
  const { groupId: _groupId, ...rest } = track;
  return rest;
}

/**
 * Move one instrument into a group and to a position within it.
 *
 * Position is stated as "before this instrument" rather than as an index because
 * the caller is a drop target, and a drop knows what it landed on but not what
 * number that row is once groups have folded the list up. `beforeTrackId` of null
 * means the end of the target group — or the end of the whole list when `groupId`
 * is null, which is what "dropped below everything" means.
 *
 * Unknown ids are a no-op rather than a throw: a drop can race a removal.
 */
export function moveTrack(
  tracks: Track[],
  groups: TrackGroup[],
  trackId: string,
  groupId: string | null,
  beforeTrackId: string | null
): Track[] {
  const moving = tracks.find(t => t.id === trackId);
  if (!moving) return tracks;
  if (beforeTrackId === trackId) return tracks;
  if (groupId !== null && !groups.some(g => g.id === groupId)) return tracks;

  const moved: Track = groupId === null ? stripGroup(moving) : { ...moving, groupId };
  const rest = tracks.filter(t => t.id !== trackId);

  const at = beforeTrackId === null ? -1 : rest.findIndex(t => t.id === beforeTrackId);
  const next =
    at === -1
      ? [...rest, moved]
      : [...rest.slice(0, at), moved, ...rest.slice(at)];

  // Dropping at the end of a group would otherwise land after the ungrouped tail;
  // normalizing pulls it back into its run.
  return normalizeTrackOrder(next, groups);
}

/**
 * Move a whole group before another group, or to the end when `beforeGroupId` is null.
 *
 * Both arrays move together: `trackGroups` decides the order of groups relative to
 * each other, and the members' run has to follow or the sidebar would show the group
 * in one place and its instruments in another.
 */
export function moveGroup(
  tracks: Track[],
  groups: TrackGroup[],
  groupId: string,
  beforeGroupId: string | null
): { tracks: Track[]; groups: TrackGroup[] } {
  const moving = groups.find(g => g.id === groupId);
  if (!moving || beforeGroupId === groupId) return { tracks, groups };

  const restGroups = groups.filter(g => g.id !== groupId);
  const at =
    beforeGroupId === null ? -1 : restGroups.findIndex(g => g.id === beforeGroupId);
  const nextGroups =
    at === -1
      ? [...restGroups, moving]
      : [...restGroups.slice(0, at), moving, ...restGroups.slice(at)];

  // Re-lay the tracks so the run sits where the group now is. Ungrouped instruments
  // keep their own positions; only the runs are shuffled.
  const members = tracksInGroup(tracks, groupId);
  const rest = tracks.filter(t => t.groupId !== groupId);

  if (members.length === 0) return { tracks, groups: nextGroups };

  const anchor =
    beforeGroupId === null ? -1 : rest.findIndex(t => t.groupId === beforeGroupId);
  const nextTracks =
    anchor === -1
      ? [...rest, ...members]
      : [...rest.slice(0, anchor), ...members, ...rest.slice(anchor)];

  return { tracks: normalizeTrackOrder(nextTracks, nextGroups), groups: nextGroups };
}

/**
 * An instrument and where it sits in `tracks`.
 *
 * The index travels with the track because a missing `Track.color` is resolved from
 * array position — the sidebar and the piano roll have to agree on which colour an
 * instrument owns, and once groups fold the list up the row's position on screen is
 * no longer its position in the array.
 */
export interface TrackRow {
  track: Track;
  index: number;
}

/** One entry in the sidebar, top to bottom. */
export type PanelRow =
  | { kind: 'group'; group: TrackGroup; members: TrackRow[] }
  | ({ kind: 'track' } & TrackRow);

/**
 * What the sidebar renders: ungrouped instruments and group headers interleaved in
 * `tracks` order, with each group's members hanging off its header.
 *
 * Groups with no members cannot be placed by `tracks`, so they come last.
 */
export function panelLayout(tracks: Track[], groups: TrackGroup[]): PanelRow[] {
  const rows: PanelRow[] = [];
  const emitted = new Set<string>();

  tracks.forEach((track, index) => {
    const group = groupOf(track, groups);
    if (!group) {
      rows.push({ kind: 'track', track, index });
      return;
    }
    if (emitted.has(group.id)) return;
    emitted.add(group.id);
    rows.push({ kind: 'group', group, members: memberRows(tracks, group.id) });
  });

  for (const group of groups) {
    if (!emitted.has(group.id)) rows.push({ kind: 'group', group, members: [] });
  }

  return rows;
}

/**
 * Turn "dropped on the top/bottom half of this row" into arguments for `moveTrack`.
 *
 * The drop target knows which row it landed on and which half; it does not know
 * which group that row is in or what follows it, and working that out at the drop
 * site would mean re-deriving the layout on every pointer move. Landing below the
 * last member of a group means the end of *that group*, not the row after it —
 * which is what makes dragging to the bottom of a group keep the instrument in it.
 */
export function dropPlacement(
  tracks: Track[],
  targetTrackId: string,
  edge: 'above' | 'below'
): { groupId: string | null; beforeTrackId: string | null } {
  const at = tracks.findIndex(t => t.id === targetTrackId);
  if (at === -1) return { groupId: null, beforeTrackId: null };

  const groupId = tracks[at].groupId ?? null;
  if (edge === 'above') return { groupId, beforeTrackId: targetTrackId };

  const after = tracks[at + 1];
  const staysInGroup = after && (after.groupId ?? null) === groupId;
  return { groupId, beforeTrackId: staysInGroup ? after.id : null };
}

/** A group's members paired with their positions in `tracks`. */
function memberRows(tracks: Track[], groupId: string): TrackRow[] {
  const rows: TrackRow[] = [];
  tracks.forEach((track, index) => {
    if (track.groupId === groupId) rows.push({ track, index });
  });
  return rows;
}
