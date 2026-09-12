import { describe, it, expect } from 'vitest';
import {
  MAX_RELEASE_GAP_MS,
  MAX_VOICE_STAGGER_MS,
  createEventShaper,
  shapeTrackEvents,
  trackReleaseGapSeconds,
  trackVoiceStaggerSeconds,
} from '@/engine/scheduler';
import {
  SCHEMA_VERSION,
  deserializeProject,
  serializeProject,
  validateProject,
} from '@/engine/fileIO';
import type { NoteTiming } from '@/engine/playback';
import { projectStore } from '@/store/projectStore';
import type { Project, Track } from '@/types/music';

/**
 * Schema 1.22: an instrument may spread its chord and stop before its next attack.
 *
 * These exist so a sampled plugin does not pay for four attacks inside one audio
 * block, so the tests that matter are about where a note *sounds* and how long it
 * sounds for — and about both costing nothing at all when nobody has set them.
 */

function track(fields: Partial<Track> = {}): Track {
  return {
    id: 'trk-1',
    name: 'Harp',
    instrument: 'acoustic_grand_piano',
    volume: 1,
    pan: 0,
    muted: false,
    solo: false,
    ...fields,
  };
}

function note(startTime: number, midiNote: number, duration = 1): NoteTiming {
  return { midiNote, startTime, duration, velocity: 100, barIndex: 0, trackId: 'trk-1' };
}

describe('the two spreads, as the scheduler reads them', () => {
  it('is nothing at all for an instrument nobody has spread', () => {
    expect(trackVoiceStaggerSeconds(track())).toBe(0);
    expect(trackReleaseGapSeconds(track())).toBe(0);
    expect(trackVoiceStaggerSeconds(track({ voiceStaggerMs: 0 }))).toBe(0);
    expect(trackReleaseGapSeconds(track({ releaseGapMs: 0 }))).toBe(0);
  });

  it('converts to seconds', () => {
    expect(trackVoiceStaggerSeconds(track({ voiceStaggerMs: 10 }))).toBeCloseTo(0.01, 10);
    expect(trackReleaseGapSeconds(track({ releaseGapMs: 20 }))).toBeCloseTo(0.02, 10);
  });

  // Read on every scheduling pass, so a bad number out of a hand-edited file has to
  // cost the instrument its spread and never its notes.
  it('reads a broken or negative number as no spread rather than throwing', () => {
    expect(trackVoiceStaggerSeconds(track({ voiceStaggerMs: NaN }))).toBe(0);
    expect(trackVoiceStaggerSeconds(track({ voiceStaggerMs: -10 }))).toBe(0);
    expect(trackReleaseGapSeconds(track({ releaseGapMs: Infinity }))).toBe(0);
    expect(trackReleaseGapSeconds(track({ releaseGapMs: -1 }))).toBe(0);
  });

  it('clamps past the range instead of honouring it', () => {
    expect(trackVoiceStaggerSeconds(track({ voiceStaggerMs: 5000 }))).toBeCloseTo(
      MAX_VOICE_STAGGER_MS / 1000,
      10
    );
    expect(trackReleaseGapSeconds(track({ releaseGapMs: 9999 }))).toBeCloseTo(
      MAX_RELEASE_GAP_MS / 1000,
      10
    );
  });
});

describe('shaping a chord', () => {
  const chord = [note(0, 60), note(0, 64), note(0, 67), note(0, 72)];

  it('shapes nothing when the instrument asked for nothing', () => {
    expect(shapeTrackEvents(chord, [track()]).size).toBe(0);
  });

  it('rolls a chord upwards, one step per voice', () => {
    const shaped = shapeTrackEvents(chord, [track({ voiceStaggerMs: 10 })]);

    // The lowest voice stays where it was written; the roll is built on it.
    expect(shaped.get(chord[0])).toBeUndefined();
    expect(shaped.get(chord[1])?.delay).toBeCloseTo(0.01, 10);
    expect(shaped.get(chord[2])?.delay).toBeCloseTo(0.02, 10);
    expect(shaped.get(chord[3])?.delay).toBeCloseTo(0.03, 10);
  });

  // The order has to come from the notes, not from the array: a chord that arrived
  // in a different order would otherwise roll differently, and the same loop would
  // sound different the second time round.
  it('rolls by pitch whatever order the notes arrive in', () => {
    const jumbled = [chord[2], chord[0], chord[3], chord[1]];
    const shaped = shapeTrackEvents(jumbled, [track({ voiceStaggerMs: 10 })]);

    expect(shaped.get(chord[1])?.delay).toBeCloseTo(0.01, 10);
    expect(shaped.get(chord[2])?.delay).toBeCloseTo(0.02, 10);
  });

  it('starts the roll again on the next chord', () => {
    const two = [note(0, 60), note(0, 64), note(2, 62), note(2, 65)];
    const shaped = shapeTrackEvents(two, [track({ voiceStaggerMs: 10 })]);

    expect(shaped.get(two[1])?.delay).toBeCloseTo(0.01, 10);
    expect(shaped.get(two[2])).toBeUndefined();
    expect(shaped.get(two[3])?.delay).toBeCloseTo(0.01, 10);
  });
});

describe('the release gap', () => {
  // A note ending exactly where the next begins is the case this exists for: the
  // plugin pays for a release and an attack inside the same block.
  it('stops an abutting note short of the next attack', () => {
    const notes = [note(0, 60, 1), note(1, 62, 1)];
    const shaped = shapeTrackEvents(notes, [track({ releaseGapMs: 20 })]);

    expect(shaped.get(notes[0])?.shorten).toBeCloseTo(0.02, 10);
  });

  it('leaves a note that already stops in time alone', () => {
    const notes = [note(0, 60, 0.5), note(1, 62, 1)];
    expect(shapeTrackEvents(notes, [track({ releaseGapMs: 20 })]).size).toBe(0);
  });

  it('leaves the last note of an instrument alone', () => {
    const notes = [note(0, 60, 1)];
    expect(shapeTrackEvents(notes, [track({ releaseGapMs: 200 })]).size).toBe(0);
  });

  // The roll pushes a voice later, so it pushes where that voice would end too.
  it('takes the roll out of the note as well as the gap', () => {
    const notes = [note(0, 60, 1), note(0, 64, 1), note(1, 62, 1)];
    const shaped = shapeTrackEvents(notes, [
      track({ voiceStaggerMs: 10, releaseGapMs: 20 }),
    ]);

    expect(shaped.get(notes[0])?.shorten).toBeCloseTo(0.02, 10);
    expect(shaped.get(notes[1])?.shorten).toBeCloseTo(0.03, 10);
  });

  // A gap wider than the note would otherwise silence it, which is a worse fault
  // than the click it was set to cure.
  it('never cuts a note past the point where it can be heard', () => {
    const notes = [note(0, 60, 0.05), note(0.05, 62, 1)];
    const shaped = shapeTrackEvents(notes, [track({ releaseGapMs: 200 })]);

    expect(notes[0].duration - (shaped.get(notes[0])?.shorten ?? 0)).toBeCloseTo(0.02, 10);
  });
});

describe('shaping across instruments', () => {
  it('leaves an instrument that asked for nothing untouched', () => {
    const mine = note(0, 60);
    const theirs: NoteTiming = { ...note(0, 64), trackId: 'trk-2' };
    const shaped = shapeTrackEvents(
      [mine, theirs],
      [track({ voiceStaggerMs: 10 }), track({ id: 'trk-2', name: 'Pad' })]
    );

    expect(shaped.get(theirs)).toBeUndefined();
  });

  // Two instruments playing the same chord are two plugins, each with its own block
  // to fill, so neither one's roll may be counted into the other's.
  it('rolls each instrument from its own lowest voice', () => {
    const a = [note(0, 60), note(0, 64)];
    const b = [
      { ...note(0, 60), trackId: 'trk-2' },
      { ...note(0, 64), trackId: 'trk-2' },
    ];
    const shaped = shapeTrackEvents(
      [...a, ...b],
      [track({ voiceStaggerMs: 10 }), track({ id: 'trk-2', name: 'Pad', voiceStaggerMs: 10 })]
    );

    expect(shaped.get(b[0])).toBeUndefined();
    expect(shaped.get(b[1])?.delay).toBeCloseTo(0.01, 10);
  });
});

describe('the memoised shaper', () => {
  it('hands back the same map until something it reads changes', () => {
    const shaper = createEventShaper();
    const notes = [note(0, 60), note(0, 64)];
    const tracks = [track({ voiceStaggerMs: 10 })];

    const first = shaper(notes, tracks);
    expect(shaper(notes, tracks)).toBe(first);

    // A different instrument object saying the same thing is not a change: editing
    // a volume must not cost a pass over every note in the project.
    expect(shaper(notes, [track({ voiceStaggerMs: 10, volume: 0.5 })])).toBe(first);

    expect(shaper(notes, [track({ voiceStaggerMs: 20 })])).not.toBe(first);
  });

  it('rebuilds when the notes themselves change', () => {
    const shaper = createEventShaper();
    const tracks = [track({ voiceStaggerMs: 10 })];

    const first = shaper([note(0, 60)], tracks);
    expect(shaper([note(0, 60)], tracks)).not.toBe(first);
  });
});

describe('the two spreads in the project file', () => {
  it('states the current schema version', () => {
    expect(SCHEMA_VERSION).toBe('1.22');
  });

  /** A real project from the store, with its first instrument spread. */
  function project(fields: Partial<Track>): Project {
    projectStore.getState().resetProject();
    projectStore.getState().createProject();
    const base = projectStore.getState().project!;
    return { ...base, tracks: [{ ...base.tracks[0], ...fields }] };
  }

  it('writes nothing for an instrument nobody has spread', () => {
    const written = JSON.parse(serializeProject(project({})));

    expect(written.tracks[0].voiceStaggerMs).toBeUndefined();
    expect(written.tracks[0].releaseGapMs).toBeUndefined();
  });

  it('round-trips both', () => {
    const written = serializeProject(project({ voiceStaggerMs: 12, releaseGapMs: 25 }));
    const read = deserializeProject(written);

    expect(read.tracks[0].voiceStaggerMs).toBe(12);
    expect(read.tracks[0].releaseGapMs).toBe(25);
  });

  it('clamps a number past the range on the way in', () => {
    const raw = JSON.parse(serializeProject(project({})));
    raw.tracks[0].voiceStaggerMs = 9999;
    const read = deserializeProject(JSON.stringify(raw));

    expect(read.tracks[0].voiceStaggerMs).toBe(MAX_VOICE_STAGGER_MS);
  });

  it('refuses a file stating one out of range', () => {
    const raw = JSON.parse(serializeProject(project({})));
    raw.tracks[0].releaseGapMs = -5;

    expect(validateProject(raw).valid).toBe(false);
  });
});
