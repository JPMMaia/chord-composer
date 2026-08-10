import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ProjectFileRef } from '@/engine/projectFile';

// Hoisted, because `vi.mock` factories run before the module body does.
const { invoke, state } = vi.hoisted(() => ({
  invoke: vi.fn(),
  /** The remembered reference, as `refStorage` hands it back from IndexedDB. */
  state: { remembered: null as ProjectFileRef | null },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@/engine/refStorage', () => ({
  loadCurrentRef: async () => state.remembered,
  storeCurrentRef: async () => {},
}));

import { useFileIO } from '@/hooks/useFileIO';
import { projectStore } from '@/store/projectStore';
import { projectFileStore } from '@/store/projectFileStore';
import { serializeProject } from '@/engine/fileIO';

function asTauri(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

/** A saved project with something in it, so "empty timeline" is a visible failure. */
function savedProjectJson(): string {
  projectStore.getState().createProject();
  projectStore.getState().addBar();
  projectStore.getState().addBar();
  const json = serializeProject(projectStore.getState().project!);
  projectStore.getState().resetProject();
  return json;
}

/**
 * Answer the desktop file commands for one project file that exists on disk, with
 * no auto-save sidecar beside it.
 */
function serveFile(path: string, contents: string): void {
  invoke.mockImplementation(async (command: string, args: { path: string }) => {
    switch (command) {
      case 'project_read':
        if (args.path === path) return contents;
        throw new Error(`no such file: ${args.path}`);
      case 'project_exists':
        return args.path === path;
      case 'project_modified_ms':
        return args.path === path ? 1000 : null;
      default:
        return null;
    }
  });
}

describe('useFileIO start-up', () => {
  beforeEach(() => {
    asTauri();
    state.remembered = null;
    invoke.mockReset();
    projectStore.getState().resetProject();
    projectFileStore.setState({ ref: null, savedSnapshot: null });
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it('reads the remembered project back, not just its name', async () => {
    const json = savedProjectJson();
    const path = 'C:/songs/ballad.json';
    state.remembered = { kind: 'path', path };
    serveFile(path, json);

    const { result } = renderHook(() => useFileIO());

    await waitFor(() => expect(projectStore.getState().project).not.toBeNull());
    await waitFor(() => expect(result.current.currentFileName).toBe('ballad.json'));

    const loaded = projectStore.getState().project!;
    expect(loaded.bars.length).toBe(2);
    // Freshly read from disk, so nothing is pending — the save indicator must agree.
    expect(result.current.isDirty).toBe(false);
  });

  it('forgets a remembered file that is no longer on disk', async () => {
    state.remembered = { kind: 'path', path: 'C:/songs/gone.json' };
    serveFile('C:/songs/other.json', '{}');

    const { result } = renderHook(() => useFileIO());

    await waitFor(() => expect(result.current.recovery).toBeNull());
    await waitFor(() => expect(projectFileStore.getState().ref).toBeNull());
    expect(result.current.currentFileName).toBeNull();
  });
});
