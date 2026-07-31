import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FileMenu } from '@/components/FileMenu';
import { projectStore } from '@/store/projectStore';
import { trackStore } from '@/store/trackStore';
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

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'File' }));
}

describe('FileMenu', () => {
  beforeEach(() => {
    stubDownloads();
    projectStore.getState().createProject();
    projectStore.getState().addBar();
    trackStore.getState().resetTracks();
    trackStore.getState().addTrack();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    projectStore.getState().resetProject();
    trackStore.getState().resetTracks();
  });

  it('renders a File button with the menu closed', () => {
    render(<FileMenu />);
    expect(screen.getByRole('button', { name: 'File' })).toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens the menu with all file actions', () => {
    render(<FileMenu />);
    openMenu();

    expect(screen.getByRole('menuitem', { name: /save project/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /load project/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /export midi/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /export musicxml/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /import midi/i })).toBeInTheDocument();
  });

  it('shows the auto-save status indicator', () => {
    render(<FileMenu />);
    expect(screen.getByTestId('autosave-status')).toBeInTheDocument();
  });

  it('downloads a .mid file on Export MIDI', async () => {
    render(<FileMenu />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /export midi/i }));

    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(clicked[0].download).toMatch(/\.mid$/);
  });

  it('downloads a .musicxml file on Export MusicXML', async () => {
    render(<FileMenu />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /export musicxml/i }));

    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(clicked[0].download).toMatch(/\.musicxml$/);
  });

  it('loads a project from a picked JSON file', async () => {
    const original = projectStore.getState().project!;
    const json = serializeProject({ ...original, name: 'Loaded Song' });

    render(<FileMenu />);
    const input = screen.getByTestId('project-file-input');
    const file = new File([json], 'song.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(projectStore.getState().project?.name).toBe('Loaded Song');
    });
  });

  it('imports notes from a picked MIDI file', async () => {
    const exported = projectToMidi(projectStore.getState().project!);

    render(<FileMenu />);
    const input = screen.getByTestId('midi-file-input');
    const file = new File([exported], 'song.mid', { type: 'audio/midi' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(projectStore.getState().project?.name).not.toBe('Untitled');
    });
    expect(projectStore.getState().project?.bars.length).toBeGreaterThanOrEqual(1);
  });

  it('shows an error when the picked project file is invalid', async () => {
    render(<FileMenu />);
    const input = screen.getByTestId('project-file-input');
    const file = new File(['not json at all'], 'broken.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid json/i);
  });
});
