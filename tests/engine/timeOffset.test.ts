import { describe, it, expect } from 'vitest';
import {
  LOOKAHEAD_SECONDS,
  MAX_TIME_OFFSET_MS,
  preRollSeconds,
  trackOffsetSeconds,
  trackOffsets,
} from '@/engine/scheduler';
import {
  SCHEMA_VERSION,
  deserializeProject,
  serializeProject,
  validateProject,
} from '@/engine/fileIO';
import { projectStore } from '@/store/projectStore';
import type { Project, Track } from '@/types/music';

/**
 * Schema 1.20: an instrument may be nudged off the beat.
 *
 * The nudge exists for latency an instrument never declares, so the tests that
 * matter are about what it does to a note's *sounding* time and about it costing
 * nothing at all when nobody has set one.
 */

function track(fields: Partial<Track> = {}): Track {
  return {
    id: 'trk-1',
    name: 'Piano',
    instrument: 'acoustic_grand_piano',
    volume: 1,
    pan: 0,
    muted: false,
    solo: false,
    ...fields,
  };
}

describe('an instrument nudge, as the scheduler reads it', () => {
  it('is nothing at all for an instrument nobody has nudged', () => {
    expect(trackOffsetSeconds(track())).toBe(0);
    expect(trackOffsetSeconds(track({ timeOffsetMs: 0 }))).toBe(0);
  });

  it('converts to seconds, keeping the sign that says which way', () => {
    expect(trackOffsetSeconds(track({ timeOffsetMs: -150 }))).toBeCloseTo(-0.15, 10);
    expect(trackOffsetSeconds(track({ timeOffsetMs: 40 }))).toBeCloseTo(0.04, 10);
  });

  // Applied on every scheduling pass, so a bad number out of an old or hand-edited
  // file must cost the instrument its nudge and never its notes.
  it('reads a broken number as no nudge rather than throwing', () => {
    expect(trackOffsetSeconds(track({ timeOffsetMs: NaN }))).toBe(0);
    expect(trackOffsetSeconds(track({ timeOffsetMs: Infinity }))).toBe(0);
    expect(trackOffsetSeconds(track({ timeOffsetMs: undefined }))).toBe(0);
  });

  it('clamps a nudge past the range instead of honouring it', () => {
    expect(trackOffsetSeconds(track({ timeOffsetMs: -5000 }))).toBeCloseTo(
      -MAX_TIME_OFFSET_MS / 1000,
      10
    );
  });

  it('indexes every instrument by id for a pass to look up per note', () => {
    const offsets = trackOffsets([
      track({ id: 'a', timeOffsetMs: -150 }),
      track({ id: 'b' }),
    ]);

    expect(offsets.get('a')).toBeCloseTo(-0.15, 10);
    expect(offsets.get('b')).toBe(0);
    expect(offsets.get('missing')).toBeUndefined();
  });
});

describe('the pre-roll a nudge forces on Play', () => {
  // The whole point: without it, a note at the top of the range asked to sound
  // 150ms before Play was pressed lands late — precisely the fault being corrected,
  // and only in the first bar, where it reads as the setting not working.
  it('is the deepest early nudge in the project', () => {
    expect(
      preRollSeconds([
        track({ id: 'a', timeOffsetMs: -150 }),
        track({ id: 'b', timeOffsetMs: -40 }),
      ])
    ).toBeCloseTo(0.15, 10);
  });

  it('is nothing when no instrument is early, so Play stays immediate', () => {
    expect(preRollSeconds([track({ id: 'a' }), track({ id: 'b', timeOffsetMs: 120 })])).toBe(0);
    expect(preRollSeconds([])).toBe(0);
  });

  // A late nudge needs no room bought for it — it is already in the future.
  it('ignores instruments nudged late', () => {
    expect(
      preRollSeconds([
        track({ id: 'a', timeOffsetMs: 400 }),
        track({ id: 'b', timeOffsetMs: -50 }),
      ])
    ).toBeCloseTo(0.05, 10);
  });

  // The arithmetic playback performs, stated once here: with the transport anchored
  // a pre-roll ahead of `now`, the earliest note in the project lands exactly on
  // Play rather than in the past, and no instrument is asked for a time already gone.
  it('leaves the earliest note in the project exactly on Play', () => {
    const tracks = [track({ id: 'a', timeOffsetMs: -150 }), track({ id: 'b' })];
    const now = 100;
    const songStart = now + preRollSeconds(tracks);
    const offsets = trackOffsets(tracks);

    // Both instruments' first note is at song position 0.
    expect(songStart + 0 + offsets.get('a')!).toBeCloseTo(now, 10);
    expect(songStart + 0 + offsets.get('b')!).toBeCloseTo(now + 0.15, 10);
  });
});

function project(): Project {
  projectStore.getState().resetProject();
  projectStore.getState().createProject();
  return projectStore.getState().project!;
}

function roundTrip(p: Project): Project {
  return deserializeProject(serializeProject(p));
}

function withOffset(timeOffsetMs: number | undefined): Project {
  const base = project();
  return { ...base, tracks: [{ ...base.tracks[0], timeOffsetMs }] };
}

/** A file as a hand-edited or older one arrives: parsed JSON with a track patched. */
function fileWithOffset(value: unknown): string {
  const raw = JSON.parse(serializeProject(project()));
  raw.tracks[0].timeOffsetMs = value;
  return JSON.stringify(raw);
}

describe('a nudge in the project file', () => {
  it('states the current schema version', () => {
    expect(SCHEMA_VERSION).toBe('1.20');
  });

  it('round-trips a nudge in either direction', () => {
    expect(roundTrip(withOffset(-150)).tracks[0].timeOffsetMs).toBe(-150);
    expect(roundTrip(withOffset(80)).tracks[0].timeOffsetMs).toBe(80);
  });

  // The 1.20 compatibility claim: no migration was needed, because an un-nudged
  // instrument writes no key — which is exactly what every pre-1.20 file says.
  it('writes no key for an instrument nobody has nudged', () => {
    const raw = JSON.parse(serializeProject(withOffset(undefined)));
    expect('timeOffsetMs' in raw.tracks[0]).toBe(false);

    const zeroed = JSON.parse(serializeProject(withOffset(0)));
    expect('timeOffsetMs' in zeroed.tracks[0]).toBe(false);
  });

  it('reads a pre-1.20 file back unnudged', () => {
    const raw = JSON.parse(serializeProject(project()));
    delete raw.tracks[0].timeOffsetMs;

    expect(deserializeProject(JSON.stringify(raw)).tracks[0].timeOffsetMs).toBeUndefined();
  });

  // Which way and roughly how far is still what the author meant, and playback
  // would have clamped it identically anyway.
  it('clamps a nudge past the range rather than dropping it', () => {
    expect(deserializeProject(fileWithOffset(-9000)).tracks[0].timeOffsetMs).toBe(
      -MAX_TIME_OFFSET_MS
    );
  });

  it('drops a nudge that is not a usable number', () => {
    for (const junk of ['-150', null, {}, NaN]) {
      expect(deserializeProject(fileWithOffset(junk)).tracks[0].timeOffsetMs).toBeUndefined();
    }
  });

  it('refuses a project carrying a nudge out of range', () => {
    const bad = { ...project() };
    bad.tracks = [{ ...bad.tracks[0], timeOffsetMs: MAX_TIME_OFFSET_MS + 1 }];

    const result = validateProject(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('time offset');
  });

  it('accepts a project with no nudge on it', () => {
    expect(validateProject(project()).valid).toBe(true);
  });
});

describe('setting a nudge through the store', () => {
  it('records it on the instrument', () => {
    project();
    const id = projectStore.getState().project!.tracks[0].id;

    projectStore.getState().setTrackTimeOffset(id, -150);
    expect(projectStore.getState().project!.tracks[0].timeOffsetMs).toBe(-150);
  });

  // It comes from a slider, where running into the end is the gesture rather than
  // a bad argument — so it clamps where `setTrackPan` would throw.
  it('clamps rather than throwing', () => {
    project();
    const id = projectStore.getState().project!.tracks[0].id;

    expect(() => projectStore.getState().setTrackTimeOffset(id, -9000)).not.toThrow();
    expect(projectStore.getState().project!.tracks[0].timeOffsetMs).toBe(-MAX_TIME_OFFSET_MS);
  });

  // Guarded by the shared `updateTrack`, like every other instrument setting: an id
  // naming nothing leaves the project alone rather than inventing an instrument.
  it('leaves the project untouched for an instrument that is not there', () => {
    const before = project();

    projectStore.getState().setTrackTimeOffset('no-such-track', -150);
    expect(projectStore.getState().project).toBe(before);
  });
});

/**
 * The look-ahead has to cover the nudge as well as the window.
 *
 * A note is *selected* by its song time but *sounds* its instrument's nudge
 * earlier, so on an early instrument those are two different instants. The
 * scheduling pass therefore widens its horizon by the deepest early nudge; without
 * that, an early note is picked up only once its sounding moment has gone by — and
 * a nudge deeper than the look-ahead arrives later than it would with no nudge at
 * all, which is the exact opposite of what it is for.
 */
describe('the look-ahead a nudged instrument needs', () => {
  /**
   * How long before it sounds a note is handed to its instrument, in seconds.
   *
   * The arithmetic `tick` performs: a note is dispatched on the first pass whose
   * horizon reaches its song time, and it sounds at its song time plus the nudge.
   */
  function lead(offsetMs: number, deepestMs: number, songTime = 8): number {
    const tracks = [track({ id: 'a', timeOffsetMs: offsetMs }), track({ id: 'b', timeOffsetMs: deepestMs })];
    const songStart = 0;
    const horizonRoom = LOOKAHEAD_SECONDS + preRollSeconds(tracks);

    // The moment `now + horizonRoom` first reaches this note's song time.
    const dispatchedAt = songStart + songTime - horizonRoom;
    const soundsAt = songStart + songTime + trackOffsetSeconds(tracks[0]);

    return soundsAt - dispatchedAt;
  }

  it('gives an un-nudged instrument the plain look-ahead', () => {
    expect(lead(0, 0)).toBeCloseTo(LOOKAHEAD_SECONDS, 10);
  });

  // The regression this guards: at the bare look-ahead the lead here would be
  // 0.2 - 0.15 = 0.05s, and a 250ms nudge would go negative — dispatched after it
  // should already have sounded.
  it('gives an early instrument the same lead, not the look-ahead minus its nudge', () => {
    expect(lead(-150, -150)).toBeCloseTo(LOOKAHEAD_SECONDS, 10);
    expect(lead(-450, -450)).toBeCloseTo(LOOKAHEAD_SECONDS, 10);
  });

  it('never dispatches an early note after its moment, however deep the nudge', () => {
    for (const ms of [-1, -50, -150, -300, -MAX_TIME_OFFSET_MS]) {
      expect(lead(ms, ms)).toBeGreaterThan(0);
    }
  });

  // An un-nudged instrument sharing the project with a nudged one simply gets more
  // lead than it needs, which costs nothing: a note further in the future is still
  // placed at the time it names.
  it('gives an un-nudged instrument extra lead when another is nudged early', () => {
    expect(lead(0, -150)).toBeCloseTo(LOOKAHEAD_SECONDS + 0.15, 10);
  });

  // A late nudge is already in the future and needs no room bought for it.
  it('does not widen the horizon for an instrument nudged late', () => {
    expect(lead(120, 120)).toBeCloseTo(LOOKAHEAD_SECONDS + 0.12, 10);
  });
});
