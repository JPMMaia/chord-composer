import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Same treatment the engine tests give them: the dialog and the file read are both
// native. What is under test is the wiring — that the picker offers what is
// remembered, that choosing the verb opens the dialog, and that a cancelled dialog
// leaves the track exactly as it was.
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const open = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/plugin-dialog', () => ({ open }));

import { InstrumentsPanel } from '@/components/InstrumentsPanel';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { rememberSfzInstrument, resetSfzCatalog } from '@/engine/sfzCatalog';
import { resetVst3Catalog } from '@/engine/vst3Catalog';

const MARKER = '__TAURI_INTERNALS__';
const OCARINA = 'C:\\lib\\Ocarina\\Ocarina 20241002.sfz';
const OCARINA_REF = `sfz:${OCARINA}`;

const firstTrack = () => projectStore.getState().project!.tracks[0];
const soundPicker = () => screen.getByLabelText('Sound for Piano') as HTMLSelectElement;
const sfzGroup = () => soundPicker().querySelector('optgroup[label="SFZ"]') as HTMLElement;

beforeEach(() => {
  projectStore.getState().resetProject();
  selectionStore.getState().clearSelection();
  projectStore.getState().createProject();
  resetSfzCatalog();
  resetVst3Catalog();
  invoke.mockReset();
  invoke.mockResolvedValue([]);
  open.mockReset();
  (window as unknown as Record<string, unknown>)[MARKER] = {};
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[MARKER];
});

describe('InstrumentsPanel SFZ sounds', () => {
  it('offers a way to load a file even before any is remembered', () => {
    render(<InstrumentsPanel />);

    expect(within(sfzGroup()).getByRole('option', { name: 'Load SFZ file…' })).toBeTruthy();
  });

  it('lists the instruments this machine has been shown', () => {
    rememberSfzInstrument({ path: OCARINA, name: 'Ocarina' });
    render(<InstrumentsPanel />);

    const option = within(sfzGroup()).getByRole('option', {
      name: 'Ocarina',
    }) as HTMLOptionElement;
    expect(option.value).toBe(OCARINA_REF);
  });

  it('sets the track to a file the user picks', async () => {
    open.mockResolvedValue(OCARINA);
    invoke.mockImplementation((command: string) =>
      command === 'file_read_text'
        ? Promise.resolve('//+ Name: Ocarina\n<region> sample=a.wav')
        : Promise.resolve([])
    );
    render(<InstrumentsPanel />);

    fireEvent.change(soundPicker(), { target: { value: '__load-sfz__' } });

    await waitFor(() => expect(firstTrack().instrument).toBe(OCARINA_REF));
    // And it is offered from now on, without a second trip through the dialog.
    expect(within(sfzGroup()).getByRole('option', { name: 'Ocarina' })).toBeTruthy();
  });

  it('leaves the track alone when the dialog is cancelled', async () => {
    open.mockResolvedValue(null);
    render(<InstrumentsPanel />);
    const before = firstTrack().instrument;

    fireEvent.change(soundPicker(), { target: { value: '__load-sfz__' } });

    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(firstTrack().instrument).toBe(before);
    // The picker must not sit on the verb, claiming a sound the track has not got.
    expect(soundPicker().value).toBe(before);
  });

  it('still selects a General MIDI sound normally', () => {
    render(<InstrumentsPanel />);

    fireEvent.change(soundPicker(), { target: { value: 'violin' } });

    expect(firstTrack().instrument).toBe('violin');
    expect(open).not.toHaveBeenCalled();
  });

  /**
   * A project written on another machine, or a list this build forgot. Without an
   * option carrying the value the `select` would display, and on the next change
   * submit, some other instrument entirely.
   */
  it('keeps offering a file it has never been shown', () => {
    projectStore.getState().setTrackInstrument(firstTrack().id, OCARINA_REF);
    render(<InstrumentsPanel />);

    expect(soundPicker().value).toBe(OCARINA_REF);
    expect(screen.getByRole('option', { name: 'SFZ Ocarina 20241002' })).toBeTruthy();
  });

  it('offers nothing SFZ-related in a browser build', () => {
    delete (window as unknown as Record<string, unknown>)[MARKER];
    render(<InstrumentsPanel />);

    expect(soundPicker().querySelector('optgroup[label="SFZ"]')).toBeNull();
    expect(screen.queryByRole('option', { name: 'Load SFZ file…' })).toBeNull();
  });
});
