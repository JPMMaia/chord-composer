import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { FileMenu } from '@/components/FileMenu';
import { FileIOContext } from '@/context/fileIOContext';
import { useFileIO } from '@/hooks/useFileIO';
import { useFileShortcuts } from '@/hooks/useFileShortcuts';
import { projectStore } from '@/store/projectStore';
import { projectFileStore } from '@/store/projectFileStore';
import { serializeProject } from '@/engine/fileIO';

/**
 * What `App` does: one `useFileIO`, shared through the context, with the file keys
 * bound on top of it. The shortcuts are the whole point of this feature, so they
 * are exercised through the same wiring the app uses rather than by calling the
 * handlers directly.
 */
function Harness() {
  const fileIO = useFileIO();
  useFileShortcuts(fileIO);
  return (
    <FileIOContext.Provider value={fileIO}>
      <FileMenu />
    </FileIOContext.Provider>
  );
}

function stubSavePicker(name = 'song.json') {
  const written: string[] = [];
  const handle = {
    name,
    createWritable: async () => ({
      write: async (blob: Blob) => void written.push(await blob.text()),
      close: async () => {},
    }),
    queryPermission: async () => 'granted' as PermissionState,
    requestPermission: async () => 'granted' as PermissionState,
  };
  const showSaveFilePicker = vi.fn().mockResolvedValue(handle);
  (window as unknown as Record<string, unknown>).showSaveFilePicker = showSaveFilePicker;
  return { showSaveFilePicker, written };
}

const press = (key: string, modifiers: { shiftKey?: boolean } = {}) =>
  fireEvent.keyDown(window, { key, ctrlKey: true, ...modifiers });

describe('quick save', () => {
  beforeEach(() => {
    localStorage.clear();
    projectFileStore.getState().clear();
    projectStore.getState().createProject();
    projectStore.getState().addBar();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
    projectStore.getState().resetProject();
    projectFileStore.getState().clear();
  });

  it('asks once on Ctrl+S and never again', async () => {
    const { showSaveFilePicker, written } = stubSavePicker('ballad.json');
    render(<Harness />);

    press('s');
    await waitFor(() => expect(written).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByTestId('current-file')).toHaveTextContent('ballad.json')
    );

    projectStore.getState().setBpm(96);
    press('s');
    await waitFor(() => expect(written).toHaveLength(2));
    expect(showSaveFilePicker).toHaveBeenCalledTimes(1);
    expect(JSON.parse(written[1]).bpm).toBe(96);
  });

  it('always asks on Ctrl+Shift+S', async () => {
    const { showSaveFilePicker, written } = stubSavePicker();
    render(<Harness />);

    press('s');
    await waitFor(() => expect(written).toHaveLength(1));

    // Shift+S arrives as an upper-case key, which the handler has to fold.
    press('S', { shiftKey: true });
    await waitFor(() => expect(showSaveFilePicker).toHaveBeenCalledTimes(2));
  });

  it('leaves Ctrl+S alone while a text field has focus', async () => {
    const { showSaveFilePicker } = stubSavePicker();
    render(
      <>
        <Harness />
        <input data-testid="name-field" />
      </>
    );

    fireEvent.keyDown(screen.getByTestId('name-field'), { key: 's', ctrlKey: true });
    await Promise.resolve();
    expect(showSaveFilePicker).not.toHaveBeenCalled();
  });

  it('offers unsaved work found on start-up, and restores it on request', async () => {
    // Stand in for a previous session that ended without an explicit save.
    const previous = { ...projectStore.getState().project!, name: 'Recovered Take' };
    localStorage.setItem('chord-composer-autosave', serializeProject(previous));

    render(<Harness />);

    const offer = await screen.findByTestId('recovery-offer');
    expect(offer).toHaveTextContent(/unsaved work/i);

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() =>
      expect(projectStore.getState().project?.name).toBe('Recovered Take')
    );
    expect(screen.queryByTestId('recovery-offer')).not.toBeInTheDocument();
  });

  it('throws the auto-save away when it is discarded', async () => {
    const previous = { ...projectStore.getState().project!, name: 'Recovered Take' };
    localStorage.setItem('chord-composer-autosave', serializeProject(previous));

    render(<Harness />);
    await screen.findByTestId('recovery-offer');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    await waitFor(() =>
      expect(localStorage.getItem('chord-composer-autosave')).toBeNull()
    );
    expect(projectStore.getState().project?.name).not.toBe('Recovered Take');
  });

  it('clears the auto-save on an explicit save, so nothing is offered next time', async () => {
    localStorage.setItem('chord-composer-autosave', serializeProject(projectStore.getState().project!));
    const { written } = stubSavePicker();
    render(<Harness />);
    await screen.findByTestId('recovery-offer');

    press('s');
    await waitFor(() => expect(written).toHaveLength(1));

    expect(localStorage.getItem('chord-composer-autosave')).toBeNull();
    expect(screen.queryByTestId('recovery-offer')).not.toBeInTheDocument();
  });
});
