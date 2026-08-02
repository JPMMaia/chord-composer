import { describe, it, expect } from 'vitest';
import { serializeProject, deserializeProject, validateProject } from '@/engine/fileIO';
import { projectStore } from '@/store/projectStore';
import type { Project } from '@/types/music';

/**
 * Schema 1.7: a track may name a VST3 plugin and carry its preset.
 *
 * The compatibility claim being tested is that 1.7 needed no migration — a bare
 * instrument id still means General MIDI, and `vst3State` is simply absent from
 * every file written before it.
 */

const CLASS_ID = '565354416d736e6f53757267652058ab';
const STATE = 'AQIDBA==';

function project(): Project {
  projectStore.getState().resetProject();
  projectStore.getState().createProject();
  return projectStore.getState().project!;
}

/** Serialize and read back, as saving and reopening does. */
function roundTrip(p: Project): Project {
  return deserializeProject(serializeProject(p));
}

function withTrack(over: Partial<Project['tracks'][number]>): Project {
  const base = project();
  return { ...base, tracks: [{ ...base.tracks[0], ...over }] };
}

describe('VST3 tracks in the project file', () => {
  it('round-trips a plugin instrument id', () => {
    const saved = roundTrip(withTrack({ instrument: `vst3:${CLASS_ID}` }));
    expect(saved.tracks[0].instrument).toBe(`vst3:${CLASS_ID}`);
  });

  it('round-trips the plugin state', () => {
    const saved = roundTrip(withTrack({ instrument: `vst3:${CLASS_ID}`, vst3State: STATE }));
    expect(saved.tracks[0].vst3State).toBe(STATE);
  });

  // Only plugins have one, and only once they have been asked.
  it('writes no state field for a General MIDI track', () => {
    const json = JSON.parse(serializeProject(withTrack({ instrument: 'violin' })));
    expect(json.tracks[0]).not.toHaveProperty('vst3State');
  });

  it('reads a track with no state as having none', () => {
    const saved = roundTrip(withTrack({ instrument: `vst3:${CLASS_ID}` }));
    expect(saved.tracks[0].vst3State).toBeUndefined();
  });

  // The plugin would reject anything that is not the base64 it produced.
  it('drops a state field that is not a string', () => {
    const json = JSON.parse(serializeProject(withTrack({ instrument: `vst3:${CLASS_ID}` })));
    json.tracks[0].vst3State = { nonsense: true };

    const loaded = deserializeProject(JSON.stringify(json));
    expect(loaded.tracks[0].vst3State).toBeUndefined();
  });

  it('accepts a project with a plugin track as valid', () => {
    const result = validateProject(
      withTrack({ instrument: `vst3:${CLASS_ID}`, vst3State: STATE })
    );
    expect(result).toEqual({ valid: true, errors: [] });
  });
});

describe('files written before 1.7', () => {
  // The whole reason the id needed no migration: a bare id has always meant,
  // and still means, a General MIDI sound.
  it('still read a bare instrument id as General MIDI', () => {
    const json = JSON.parse(serializeProject(withTrack({ instrument: 'string_ensemble_1' })));
    json.version = '1.6';
    delete json.tracks[0].vst3State;

    const loaded = deserializeProject(JSON.stringify(json));
    expect(loaded.tracks[0].instrument).toBe('string_ensemble_1');
    expect(loaded.tracks[0].vst3State).toBeUndefined();
  });

  it('open without error', () => {
    const json = JSON.parse(serializeProject(project()));
    json.version = '1.6';

    expect(() => deserializeProject(JSON.stringify(json))).not.toThrow();
  });
});
