import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ProjectFileRef } from '@/engine/projectFile';

// Hoisted, because `vi.mock` factories run before the module body does.
const { invoke, save, open, state } = vi.hoisted(() => ({
  invoke: vi.fn(),
  save: vi.fn(),
  open: vi.fn(),
  /** The remembered reference, as `refStorage` hands it back from IndexedDB. */
  state: { remembered: null as ProjectFileRef | null },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save, open }));
vi.mock('@/engine/refStorage', () => ({
  loadCurrentRef: async () => state.remembered,
  storeCurrentRef: async () => {},
}));

import { useFileIO } from '@/hooks/useFileIO';
import { projectStore } from '@/store/projectStore';
import { projectFileStore } from '@/store/projectFileStore';
import { serializeProject } from '@/engine/fileIO';
import { selectionStore } from '@/store/selectionStore';

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

describe('instrument templates', () => {
  const TEMPLATE_PATH = 'C:/sets/orchestra.cctemplate';
  /** Everything written through `project_write`, keyed by path. */
  let written: Map<string, string>;

  beforeEach(() => {
    asTauri();
    state.remembered = null;
    invoke.mockReset();
    save.mockReset();
    open.mockReset();
    written = new Map();
    invoke.mockImplementation(
      async (command: string, args: { path?: string; contents?: string; trackId?: string }) => {
        switch (command) {
          case 'project_write':
            written.set(args.path!, args.contents!);
            return null;
          case 'project_read':
            if (written.has(args.path!)) return written.get(args.path!);
            throw new Error(`no such file: ${args.path}`);
          case 'project_exists':
            return written.has(args.path!);
          default:
            return null;
        }
      }
    );
    projectStore.getState().resetProject();
    projectStore.getState().createProject();
    projectFileStore.setState({ ref: null, savedSnapshot: null });
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it('writes the instruments and nothing else', async () => {
    projectStore.getState().addBar();
    projectStore.getState().addTrack('Strings');
    save.mockResolvedValue(TEMPLATE_PATH);

    const { result } = renderHook(() => useFileIO());
    await result.current.handleSaveInstruments();

    const contents = JSON.parse(written.get(TEMPLATE_PATH)!);
    expect(contents.instruments.map((i: { name: string }) => i.name)).toEqual([
      'Piano',
      'Strings',
    ]);
    expect(contents.bars).toBeUndefined();
    // The dialog was offered the template's own filter, not the project's.
    expect(save.mock.calls[0][0].filters[0].extensions).toEqual(['cctemplate']);
  });

  // A template is not the project's file: writing one says nothing about whether the
  // project itself has been saved.
  it('leaves the project as dirty as it was', async () => {
    save.mockResolvedValue(TEMPLATE_PATH);
    const { result } = renderHook(() => useFileIO());

    const dirtyBefore = result.current.isDirty;
    await result.current.handleSaveInstruments();

    await waitFor(() => expect(written.has(TEMPLATE_PATH)).toBe(true));
    expect(result.current.isDirty).toBe(dirtyBefore);
    expect(result.current.currentFileName).toBeNull();
    expect(projectFileStore.getState().ref).toBeNull();
  });

  it('writes nothing when the save dialog is cancelled', async () => {
    save.mockResolvedValue(null);
    const { result } = renderHook(() => useFileIO());

    await result.current.handleSaveInstruments();

    expect(written.size).toBe(0);
    expect(result.current.error).toBeNull();
  });

  it('appends a loaded template alongside the existing instruments', async () => {
    save.mockResolvedValue(TEMPLATE_PATH);
    projectStore.getState().addTrack('Strings');

    const { result } = renderHook(() => useFileIO());
    await result.current.handleSaveInstruments();

    // A different project, so the append is visible.
    projectStore.getState().createProject();
    open.mockResolvedValue(TEMPLATE_PATH);
    await result.current.handleLoadInstruments();

    const tracks = projectStore.getState().project!.tracks;
    expect(tracks.map(t => t.name)).toEqual(['Piano', 'Piano', 'Strings']);
    // The first appended instrument becomes the one the timeline edits.
    expect(selectionStore.getState().selectedTrackId).toBe(tracks[1].id);
  });

  it('reports a project file picked by mistake', async () => {
    written.set(TEMPLATE_PATH, serializeProject(projectStore.getState().project!));
    open.mockResolvedValue(TEMPLATE_PATH);

    const { result } = renderHook(() => useFileIO());
    await result.current.handleLoadInstruments();

    await waitFor(() => expect(result.current.error).toMatch(/instruments/i));
    expect(projectStore.getState().project!.tracks).toHaveLength(1);
  });
});
