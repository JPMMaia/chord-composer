import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FileMenu } from '@/components/FileMenu';
import { FileIOContext } from '@/context/fileIOContext';
import { useFileIO } from '@/hooks/useFileIO';
import { projectStore } from '@/store/projectStore';
import { projectFileStore } from '@/store/projectFileStore';
import { serializeProject } from '@/engine/fileIO';
import { projectToMidi } from '@/engine/midiExporter';

// jsdom has no object-URL or download support, so both are stubbed.
let createObjectURL: ReturnType<typeof vi.fn>;
let clicked: { href: string; download: string }[];

function stubDownloads() {
  clicked = [];
  createObjectURL = vi.fn().mockReturnValue('blob:mock');
  global.URL.createObjectURL = createObjectURL as never;
  global.URL.revokeObjectURL = vi.fn() as never;

  const realCreateElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const element = realCreateElement(tag);
    if (tag === 'a') {
      const anchor = element as HTMLAnchorElement;
      anchor.click = () => clicked.push({ href: anchor.href, download: anchor.download });
    }
    return element;
  });
}

/**
 * A writable file the save picker can hand back, standing in for one the user
 * chose. jsdom has no File System Access API at all, so the whole thing —
 * picker, handle and writable — is built here.
 */
function stubSavePicker(name = 'song.json') {
  const written: string[] = [];
  const handle = {
    name,
    createWritable: async () => ({
      write: async (blob: Blob) => {
        written.push(await blob.text());
      },
      close: async () => {},
    }),
    queryPermission: async () => 'granted' as PermissionState,
    requestPermission: async () => 'granted' as PermissionState,
  };
  const showSaveFilePicker = vi.fn().mockResolvedValue(handle);
  (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = showSaveFilePicker;
  return { showSaveFilePicker, written };
}

function clearSavePicker() {
  delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
}

/**
 * `useFileIO` is called once at the top of the app and shared, so the menu on its
 * own is not renderable — this is the smallest thing that provides it.
 */
function Harness() {
  const fileIO = useFileIO();
  return (
    <FileIOContext.Provider value={fileIO}>
      <FileMenu />
    </FileIOContext.Provider>
  );
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'File' }));
}

describe('FileMenu', () => {
  beforeEach(() => {
    stubDownloads();
    localStorage.clear();
    projectFileStore.getState().clear();
    projectStore.getState().createProject();
    projectStore.getState().addBar();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearSavePicker();
    projectStore.getState().resetProject();
    projectFileStore.getState().clear();
  });

  it('renders a File button with the menu closed', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'File' })).toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens the menu with all file actions', () => {
    render(<Harness />);
    openMenu();

    expect(screen.getByRole('menuitem', { name: /new project/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Open Project' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Save' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Save As' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /export midi/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /export musicxml/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /import midi/i })).toBeInTheDocument();
  });

  it('shows the auto-save status indicator', () => {
    render(<Harness />);
    expect(screen.getByTestId('autosave-status')).toBeInTheDocument();
  });

  it('calls a project Untitled until it has been saved', () => {
    render(<Harness />);
    expect(screen.getByTestId('current-file')).toHaveTextContent('Untitled');
  });

  it('downloads a .mid file on Export MIDI', async () => {
    render(<Harness />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /export midi/i }));

    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(clicked[0].download).toMatch(/\.mid$/);
  });

  it('downloads a .musicxml file on Export MusicXML', async () => {
    render(<Harness />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /export musicxml/i }));

    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(clicked[0].download).toMatch(/\.musicxml$/);
  });

  it('loads a project from a picked JSON file', async () => {
    const original = projectStore.getState().project!;
    const json = serializeProject({ ...original, name: 'Loaded Song' });

    render(<Harness />);
    const input = screen.getByTestId('project-file-input');
    const file = new File([json], 'song.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(projectStore.getState().project?.name).toBe('Loaded Song');
    });
  });

  it('imports notes from a picked MIDI file', async () => {
    const exported = projectToMidi(projectStore.getState().project!);

    render(<Harness />);
    const input = screen.getByTestId('midi-file-input');
    const file = new File([exported], 'song.mid', { type: 'audio/midi' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(projectStore.getState().project?.name).not.toBe('Untitled');
    });
    expect(projectStore.getState().project?.bars.length).toBeGreaterThanOrEqual(1);
  });

  it('shows an error when the picked project file is invalid', async () => {
    render(<Harness />);
    const input = screen.getByTestId('project-file-input');
    const file = new File(['not json at all'], 'broken.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid json/i);
  });

  describe('saving', () => {
    it('asks for a file the first time and then writes to it silently', async () => {
      const { showSaveFilePicker, written } = stubSavePicker('song.json');
      render(<Harness />);

      openMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Save' }));
      await waitFor(() => expect(written).toHaveLength(1));
      expect(showSaveFilePicker).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(screen.getByTestId('current-file')).toHaveTextContent('song.json')
      );

      // A change to save, then a second Save — the picker must stay shut.
      projectStore.getState().setBpm(100);
      openMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Save' }));
      await waitFor(() => expect(written).toHaveLength(2));
      expect(showSaveFilePicker).toHaveBeenCalledTimes(1);
      expect(JSON.parse(written[1]).bpm).toBe(100);
    });

    it('asks every time for Save As', async () => {
      const { showSaveFilePicker, written } = stubSavePicker();
      render(<Harness />);

      openMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Save' }));
      await waitFor(() => expect(written).toHaveLength(1));

      openMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Save As' }));
      await waitFor(() => expect(showSaveFilePicker).toHaveBeenCalledTimes(2));
    });

    it('writes nothing when the user cancels the picker', async () => {
      const showSaveFilePicker = vi
        .fn()
        .mockRejectedValue(new DOMException('cancelled', 'AbortError'));
      (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker =
        showSaveFilePicker;

      render(<Harness />);
      openMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Save' }));

      await waitFor(() => expect(showSaveFilePicker).toHaveBeenCalled());
      // The old code fell through to a download here, so cancelling Save still
      // dropped a file in the Downloads folder.
      expect(clicked).toHaveLength(0);
      expect(screen.getByTestId('current-file')).toHaveTextContent('Untitled');
    });

    it('marks the project dirty again after an edit', async () => {
      const { written } = stubSavePicker();
      render(<Harness />);

      openMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Save' }));
      await waitFor(() => expect(written).toHaveLength(1));
      await waitFor(() =>
        expect(screen.queryByLabelText('Unsaved changes')).not.toBeInTheDocument()
      );

      projectStore.getState().setBpm(140);
      await waitFor(() => expect(screen.getByLabelText('Unsaved changes')).toBeInTheDocument());
    });
  });
});
