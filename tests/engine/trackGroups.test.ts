import { describe, it, expect } from 'vitest';
import type { Track, TrackGroup } from '@/types/music';
import {
  dropPlacement,
  groupOf,
  moveGroup,
  moveTrack,
  normalizeTrackOrder,
  panelLayout,
  tracksInGroup,
} from '@/engine/trackGroups';

/** An instrument, named after itself so assertions read as the sidebar does. */
const track = (name: string, groupId?: string): Track => ({
  id: name,
  name,
  groupId,
  instrument: 'acoustic_grand_piano',
  volume: 1,
  pan: 0,
  muted: false,
  solo: false,
});

const group = (id: string, overrides: Partial<TrackGroup> = {}): TrackGroup => ({
  id,
  name: id,
  ...overrides,
});

/** The order of instruments, as `name` or `group/name`. */
const order = (tracks: Track[]) =>
  tracks.map(t => (t.groupId ? `${t.groupId}/${t.name}` : t.name));

/** The sidebar top to bottom, one string per row, members indented under a group. */
const layout = (tracks: Track[], groups: TrackGroup[]) =>
  panelLayout(tracks, groups).flatMap(row =>
    row.kind === 'group'
      ? [`[${row.group.name}]`, ...row.members.map(m => `  ${m.track.name}`)]
      : [row.track.name]
  );

describe('groupOf', () => {
  it('finds the group an instrument names', () => {
    expect(groupOf(track('Piano', 'rhythm'), [group('rhythm')])?.id).toBe('rhythm');
  });

  it('reads an ungrouped instrument as ungrouped', () => {
    expect(groupOf(track('Piano'), [group('rhythm')])).toBeNull();
  });

  // A group removed by an older build leaves its label behind. Losing the label is
  // the right outcome; losing the instrument would not be.
  it('reads a groupId naming no group as ungrouped', () => {
    expect(groupOf(track('Piano', 'gone'), [group('rhythm')])).toBeNull();
  });
});

describe('normalizeTrackOrder', () => {
  it('leaves an already-contiguous list exactly as it was', () => {
    const groups = [group('rhythm')];
    const tracks = [track('Piano', 'rhythm'), track('Bass', 'rhythm'), track('Lead')];

    expect(order(normalizeTrackOrder(tracks, groups))).toEqual([
      'rhythm/Piano',
      'rhythm/Bass',
      'Lead',
    ]);
  });

  // The run lands where its *first* member was, so normalizing moves as few
  // instruments as it can rather than herding every group to the top.
  it('gathers a scattered group at its first member', () => {
    const groups = [group('rhythm')];
    const tracks = [
      track('Lead'),
      track('Piano', 'rhythm'),
      track('Strings'),
      track('Bass', 'rhythm'),
    ];

    expect(order(normalizeTrackOrder(tracks, groups))).toEqual([
      'Lead',
      'rhythm/Piano',
      'rhythm/Bass',
      'Strings',
    ]);
  });

  it('keeps the order within a run', () => {
    const groups = [group('rhythm')];
    const tracks = [track('Bass', 'rhythm'), track('Lead'), track('Piano', 'rhythm')];

    expect(order(normalizeTrackOrder(tracks, groups))).toEqual([
      'rhythm/Bass',
      'rhythm/Piano',
      'Lead',
    ]);
  });

  it('clears a groupId that names no group', () => {
    const result = normalizeTrackOrder([track('Piano', 'gone')], []);
    expect(result[0].groupId).toBeUndefined();
    expect('groupId' in result[0]).toBe(false);
  });

  it('keeps two groups apart', () => {
    const groups = [group('rhythm'), group('horns')];
    const tracks = [
      track('Piano', 'rhythm'),
      track('Trumpet', 'horns'),
      track('Bass', 'rhythm'),
    ];

    expect(order(normalizeTrackOrder(tracks, groups))).toEqual([
      'rhythm/Piano',
      'rhythm/Bass',
      'horns/Trumpet',
    ]);
  });
});

describe('moveTrack', () => {
  const groups = [group('rhythm'), group('horns')];
  const tracks = [
    track('Piano', 'rhythm'),
    track('Bass', 'rhythm'),
    track('Trumpet', 'horns'),
    track('Lead'),
  ];

  it('reorders within a group', () => {
    expect(order(moveTrack(tracks, groups, 'Bass', 'rhythm', 'Piano'))).toEqual([
      'rhythm/Bass',
      'rhythm/Piano',
      'horns/Trumpet',
      'Lead',
    ]);
  });

  it('moves an instrument into another group', () => {
    expect(order(moveTrack(tracks, groups, 'Lead', 'horns', null))).toEqual([
      'rhythm/Piano',
      'rhythm/Bass',
      'horns/Trumpet',
      'horns/Lead',
    ]);
  });

  it('moves an instrument out of its group', () => {
    expect(order(moveTrack(tracks, groups, 'Piano', null, null))).toEqual([
      'rhythm/Bass',
      'horns/Trumpet',
      'Lead',
      'Piano',
    ]);
  });

  // Dropping at the end of a group would otherwise land after the ungrouped tail.
  it('pulls a drop at the end of a group back into its run', () => {
    expect(order(moveTrack(tracks, groups, 'Lead', 'rhythm', null))).toEqual([
      'rhythm/Piano',
      'rhythm/Bass',
      'rhythm/Lead',
      'horns/Trumpet',
    ]);
  });

  it('drops the groupId when moving to no group', () => {
    const moved = moveTrack(tracks, groups, 'Piano', null, null);
    expect(moved.find(t => t.id === 'Piano')!.groupId).toBeUndefined();
  });

  // A drop can race a removal; it must not throw or invent an instrument.
  it('does nothing for an unknown instrument', () => {
    expect(moveTrack(tracks, groups, 'nope', null, null)).toBe(tracks);
  });

  it('does nothing for an unknown group', () => {
    expect(moveTrack(tracks, groups, 'Lead', 'nope', null)).toBe(tracks);
  });

  it('does nothing when dropped on itself', () => {
    expect(moveTrack(tracks, groups, 'Lead', null, 'Lead')).toBe(tracks);
  });
});

describe('moveGroup', () => {
  const groups = [group('rhythm'), group('horns')];
  const tracks = [
    track('Piano', 'rhythm'),
    track('Bass', 'rhythm'),
    track('Trumpet', 'horns'),
    track('Lead'),
  ];

  it('moves a group before another, taking its instruments with it', () => {
    const moved = moveGroup(tracks, groups, 'horns', 'rhythm');

    expect(moved.groups.map(g => g.id)).toEqual(['horns', 'rhythm']);
    expect(order(moved.tracks)).toEqual([
      'horns/Trumpet',
      'rhythm/Piano',
      'rhythm/Bass',
      'Lead',
    ]);
  });

  it('moves a group to the end', () => {
    const moved = moveGroup(tracks, groups, 'rhythm', null);

    expect(moved.groups.map(g => g.id)).toEqual(['horns', 'rhythm']);
    expect(order(moved.tracks)).toEqual([
      'horns/Trumpet',
      'Lead',
      'rhythm/Piano',
      'rhythm/Bass',
    ]);
  });

  it('reorders an empty group without touching the instruments', () => {
    const withEmpty = [...groups, group('empty')];
    const moved = moveGroup(tracks, withEmpty, 'empty', 'rhythm');

    expect(moved.groups.map(g => g.id)).toEqual(['empty', 'rhythm', 'horns']);
    expect(order(moved.tracks)).toEqual(order(tracks));
  });

  it('does nothing for an unknown group', () => {
    expect(moveGroup(tracks, groups, 'nope', null).tracks).toBe(tracks);
  });
});

describe('panelLayout', () => {
  it('interleaves group headers with ungrouped instruments in track order', () => {
    const groups = [group('rhythm')];
    const tracks = [track('Lead'), track('Piano', 'rhythm'), track('Bass', 'rhythm')];

    expect(layout(tracks, groups)).toEqual(['Lead', '[rhythm]', '  Piano', '  Bass']);
  });

  // A group with no members appears nowhere in `tracks`, so there is no position to
  // read off. The end is where a group the user just made would appear anyway.
  it('puts a group with no members last', () => {
    const groups = [group('empty'), group('rhythm')];
    const tracks = [track('Piano', 'rhythm'), track('Lead')];

    expect(layout(tracks, groups)).toEqual(['[rhythm]', '  Piano', 'Lead', '[empty]']);
  });

  it('carries each member its position in tracks, for the colour fallback', () => {
    const groups = [group('rhythm')];
    const tracks = [track('Lead'), track('Piano', 'rhythm')];
    const rows = panelLayout(tracks, groups);

    expect(rows[0]).toMatchObject({ kind: 'track', index: 0 });
    expect(rows[1]).toMatchObject({ kind: 'group' });
    expect(rows[1].kind === 'group' && rows[1].members[0].index).toBe(1);
  });
});

describe('tracksInGroup', () => {
  it('lists the members of a group in track order', () => {
    const tracks = [track('Bass', 'rhythm'), track('Lead'), track('Piano', 'rhythm')];
    expect(tracksInGroup(tracks, 'rhythm').map(t => t.name)).toEqual(['Bass', 'Piano']);
  });
});

describe('dropPlacement', () => {
  const tracks = [
    track('Piano', 'rhythm'),
    track('Bass', 'rhythm'),
    track('Lead'),
  ];

  it('reads the top half of a row as "before it"', () => {
    expect(dropPlacement(tracks, 'Bass', 'above')).toEqual({
      groupId: 'rhythm',
      beforeTrackId: 'Bass',
    });
  });

  it('reads the bottom half as "before whatever follows"', () => {
    expect(dropPlacement(tracks, 'Piano', 'below')).toEqual({
      groupId: 'rhythm',
      beforeTrackId: 'Bass',
    });
  });

  // Below the last member means the end of *that group*, not the row after it —
  // which is what keeps a drag to the bottom of a group inside the group.
  it('reads the bottom of a group as the end of that group', () => {
    expect(dropPlacement(tracks, 'Bass', 'below')).toEqual({
      groupId: 'rhythm',
      beforeTrackId: null,
    });
  });

  it('reads the bottom of the list as ungrouped and last', () => {
    expect(dropPlacement(tracks, 'Lead', 'below')).toEqual({
      groupId: null,
      beforeTrackId: null,
    });
  });

  it('falls back to the ungrouped end for an unknown row', () => {
    expect(dropPlacement(tracks, 'nope', 'above')).toEqual({
      groupId: null,
      beforeTrackId: null,
    });
  });
});
