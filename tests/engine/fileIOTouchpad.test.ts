import { describe, it, expect } from 'vitest';
import {
  SCHEMA_VERSION,
  deserializeProject,
  serializeProject,
  validateProject,
} from '@/engine/fileIO';
import { projectStore } from '@/store/projectStore';
import type { AutomationTarget, Project } from '@/types/music';

/**
 * Schema 1.19: an instrument may say which target the touchpad performs on it.
 *
 * The compatibility claim being tested is that 1.19 needed no migration — an
 * instrument with no assignment writes no key, which is exactly what every file
 * written before it says.
 */

function project(): Project {
  projectStore.getState().resetProject();
  projectStore.getState().createProject();
  return projectStore.getState().project!;
}

/** Serialize and read back, as saving and reopening does. */
function roundTrip(p: Project): Project {
  return deserializeProject(serializeProject(p));
}

function withTouchpad(target: AutomationTarget | undefined): Project {
  const base = project();
  return { ...base, tracks: [{ ...base.tracks[0], touchpadTarget: target }] };
}

/** A file as a hand-edited or older one arrives: parsed JSON with a track patched. */
function fileWithTrackField(value: unknown): string {
  const raw = JSON.parse(serializeProject(project()));
  raw.tracks[0].touchpadTarget = value;
  return JSON.stringify(raw);
}

describe('the touchpad assignment in the project file', () => {
  // What version introduced the touchpad is history, and pinning `SCHEMA_VERSION`
  // to it here only broke the moment the schema moved on for an unrelated reason.
  // The current version is asserted once, in `fileIO.test.ts`; what matters here is
  // that the assignment still survives a round trip.

  it('round-trips a controller assignment', () => {
    const saved = roundTrip(withTouchpad({ kind: 'cc', controller: 11 }));
    expect(saved.tracks[0].touchpadTarget).toEqual({ kind: 'cc', controller: 11 });
  });

  it('round-trips a parameter assignment', () => {
    const saved = roundTrip(withTouchpad({ kind: 'param', paramId: 42 }));
    expect(saved.tracks[0].touchpadTarget).toEqual({ kind: 'param', paramId: 42 });
  });

  it('writes no key for an instrument nobody has assigned one on', () => {
    // What makes a pre-1.19 project serialise byte for byte as it did under 1.18.
    const raw = JSON.parse(serializeProject(project()));
    expect('touchpadTarget' in raw.tracks[0]).toBe(false);
  });

  it('reads a pre-1.19 file back with nothing assigned', () => {
    const raw = JSON.parse(serializeProject(project()));
    delete raw.tracks[0].touchpadTarget;
    raw.version = '1.18';

    const loaded = deserializeProject(JSON.stringify(raw));
    expect(loaded.tracks[0].touchpadTarget).toBeUndefined();
  });

  it('drops an assignment naming a controller that is out of range', () => {
    // Costs an assignment rather than the whole load: an unassigned instrument is an
    // ordinary state, so there is nothing here to fail a file over.
    const loaded = deserializeProject(fileWithTrackField({ kind: 'cc', controller: 200 }));
    expect(loaded.tracks[0].touchpadTarget).toBeUndefined();
  });

  it('drops one that names nothing at all', () => {
    expect(
      deserializeProject(fileWithTrackField({ kind: 'wobble' })).tracks[0].touchpadTarget
    ).toBeUndefined();
    expect(
      deserializeProject(fileWithTrackField('cc 11')).tracks[0].touchpadTarget
    ).toBeUndefined();
  });

  it('rebuilds the target rather than passing a hand-edited one through', () => {
    const loaded = deserializeProject(
      fileWithTrackField({ kind: 'cc', controller: 11, nonsense: true })
    );
    expect(loaded.tracks[0].touchpadTarget).toEqual({ kind: 'cc', controller: 11 });
  });
});

describe('validateProject', () => {
  it('accepts an instrument with no assignment', () => {
    expect(validateProject(withTouchpad(undefined)).valid).toBe(true);
  });

  it('accepts a well-formed one', () => {
    expect(validateProject(withTouchpad({ kind: 'cc', controller: 11 })).valid).toBe(true);
  });

  it('reports one that names nothing sendable', () => {
    const result = validateProject(
      withTouchpad({ kind: 'cc', controller: 200 } as AutomationTarget)
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/touchpad/i);
  });
});
