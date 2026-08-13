import { describe, it, expect } from 'vitest';
import {
  deserializeTemplate,
  serializeTemplate,
  templateFromProject,
  TEMPLATE_SCHEMA_VERSION,
} from '@/engine/instrumentTemplate';
import { serializeProject } from '@/engine/fileIO';
import { projectStore } from '@/store/projectStore';
import type { Project, Track } from '@/types/music';

const CLASS_ID = '565354416d736e6f53757267652058ab';
const STATE = 'AQIDBA==';

function project(): Project {
  projectStore.getState().resetProject();
  projectStore.getState().createProject();
  return projectStore.getState().project!;
}

function withTracks(...over: Partial<Track>[]): Project {
  const base = project();
  return { ...base, tracks: over.map(o => ({ ...base.tracks[0], ...o })) };
}

/** Save and read back, as writing a template and loading it does. */
function roundTrip(p: Project) {
  return deserializeTemplate(serializeTemplate(templateFromProject(p, p.name)));
}

describe('instrument templates', () => {
  it('captures every instrument with its sound and mix settings', () => {
    const read = roundTrip(
      withTracks(
        { name: 'Lead', instrument: 'acoustic_grand_piano', volume: 0.4, pan: -0.5, color: '#abc' },
        { name: 'Bass', instrument: 'electric_bass_finger', volume: 0.9, pan: 0.25 }
      )
    );

    expect(read.version).toBe(TEMPLATE_SCHEMA_VERSION);
    expect(read.instruments).toHaveLength(2);
    expect(read.instruments[0]).toMatchObject({
      name: 'Lead',
      instrument: 'acoustic_grand_piano',
      volume: 0.4,
      pan: -0.5,
      color: '#abc',
    });
    expect(read.instruments[1]).toMatchObject({ name: 'Bass', volume: 0.9, pan: 0.25 });
  });

  it('round-trips a plugin instrument and its state', () => {
    const read = roundTrip(withTracks({ instrument: `vst3:${CLASS_ID}`, vst3State: STATE }));

    expect(read.instruments[0].instrument).toBe(`vst3:${CLASS_ID}`);
    expect(read.instruments[0].vst3State).toBe(STATE);
  });

  // The template is about the ensemble, not the piece it was captured from.
  it('drops everything that belongs to one song or one session', () => {
    const captured = templateFromProject(
      withTracks({
        id: 'track-1',
        muted: true,
        solo: true,
        visible: false,
        volumeAutomation: [{ beat: 0, value: 0.2 }],
      }),
      'Song'
    );

    const entry = captured.instruments[0] as Record<string, unknown>;
    expect(entry.id).toBeUndefined();
    expect(entry.muted).toBeUndefined();
    expect(entry.solo).toBeUndefined();
    expect(entry.visible).toBeUndefined();
    expect(entry.volumeAutomation).toBeUndefined();
    expect(serializeTemplate(captured)).not.toContain('track-1');
  });

  // A plugin that is not installed here, or samples that have moved, must come back
  // intact once they are found again — so the ref is never rewritten.
  it('keeps an unrecognised instrument ref verbatim', () => {
    const read = deserializeTemplate(
      JSON.stringify({
        instruments: [
          { name: 'Missing', instrument: 'vst3:ffffffffffffffffffffffffffffffff' },
          { name: 'Samples', instrument: 'sfz:D:/gone/strings.sfz' },
        ],
      })
    );

    expect(read.instruments[0].instrument).toBe('vst3:ffffffffffffffffffffffffffffffff');
    expect(read.instruments[1].instrument).toBe('sfz:D:/gone/strings.sfz');
  });

  it('drops a malformed entry rather than failing the whole load', () => {
    const read = deserializeTemplate(
      JSON.stringify({
        instruments: [
          null,
          { name: 'No sound' },
          { instrument: '' },
          { name: 'Fine', instrument: 'acoustic_grand_piano' },
        ],
      })
    );

    expect(read.instruments).toHaveLength(1);
    expect(read.instruments[0].name).toBe('Fine');
  });

  it('clamps mix settings that are out of range or missing', () => {
    const read = deserializeTemplate(
      JSON.stringify({
        instruments: [
          { instrument: 'a', volume: 9, pan: -4 },
          { instrument: 'b', volume: 'loud', pan: null },
        ],
      })
    );

    expect(read.instruments[0]).toMatchObject({ volume: 1, pan: -1 });
    expect(read.instruments[1]).toMatchObject({ volume: 1, pan: 0 });
  });

  it('drops a vst3State that is not a string', () => {
    const read = deserializeTemplate(
      JSON.stringify({ instruments: [{ instrument: `vst3:${CLASS_ID}`, vst3State: 42 }] })
    );

    expect(read.instruments[0].vst3State).toBeUndefined();
  });

  // The two file kinds are both JSON, so this is the guard that catches the mix-up.
  it('rejects a project file with a message that names the problem', () => {
    expect(() => deserializeTemplate(serializeProject(project()))).toThrow(/instruments/i);
  });

  it('rejects contents that are not JSON at all', () => {
    expect(() => deserializeTemplate('not json')).toThrow(/not a valid/i);
  });
});
