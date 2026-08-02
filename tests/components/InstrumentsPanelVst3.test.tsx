import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Same treatment the engine tests give it: Tauri's IPC needs a real native host.
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { InstrumentsPanel } from '@/components/InstrumentsPanel';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { resetVst3Catalog, type Vst3PluginInfo } from '@/engine/vst3Catalog';

const MARKER = '__TAURI_INTERNALS__';
const CLASS_ID = '565354416d736e6f53757267652058ab';

const plugin: Vst3PluginInfo = {
  classId: CLASS_ID,
  name: 'Surge XT',
  vendor: 'Surge Synth Team',
  version: '1.3',
  subCategories: 'Instrument|Synth',
  path: 'C:\\VST3\\Surge XT.vst3',
};

const firstTrack = () => projectStore.getState().project!.tracks[0];
const soundPicker = () => screen.getByLabelText('Sound for Piano') as HTMLSelectElement;

beforeEach(() => {
  projectStore.getState().resetProject();
  selectionStore.getState().clearSelection();
  projectStore.getState().createProject();
  resetVst3Catalog();
  invoke.mockReset();
  (window as unknown as Record<string, unknown>)[MARKER] = {};
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[MARKER];
});

describe('InstrumentsPanel VST3 sounds', () => {
  it('offers the scanned plugins in their own group', async () => {
    invoke.mockResolvedValue([plugin]);
    render(<InstrumentsPanel />);

    const group = await screen.findByRole('group', { name: 'VST3' });
    expect(within(group).getByRole('option', { name: 'Surge XT — Surge Synth Team' }))
      .toBeInTheDocument();
  });

  it('still offers every General MIDI sound alongside them', async () => {
    invoke.mockResolvedValue([plugin]);
    render(<InstrumentsPanel />);

    await screen.findByRole('group', { name: 'VST3' });
    expect(screen.getByRole('option', { name: 'Acoustic Grand Piano' })).toBeInTheDocument();
  });

  it('sets the namespaced id when a plugin is picked', async () => {
    invoke.mockResolvedValue([plugin]);
    render(<InstrumentsPanel />);
    await screen.findByRole('group', { name: 'VST3' });

    fireEvent.change(soundPicker(), { target: { value: `vst3:${CLASS_ID}` } });

    expect(firstTrack().instrument).toBe(`vst3:${CLASS_ID}`);
  });

  // A browser build has no plugins, and the group would be an empty affordance.
  it('omits the group entirely when nothing is installed', async () => {
    invoke.mockResolvedValue([]);
    render(<InstrumentsPanel />);

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(screen.queryByRole('group', { name: 'VST3' })).not.toBeInTheDocument();
  });

  describe('a project naming a plugin that is not installed here', () => {
    beforeEach(() => {
      projectStore.getState().setTrackInstrument(firstTrack().id, `vst3:${CLASS_ID}`);
    });

    // Without an option carrying this value the select would silently display,
    // and on the next change submit, some other instrument.
    it('keeps the picker on the stored value rather than drifting', async () => {
      invoke.mockResolvedValue([]);
      render(<InstrumentsPanel />);

      await waitFor(() => expect(invoke).toHaveBeenCalled());
      expect(soundPicker().value).toBe(`vst3:${CLASS_ID}`);
    });

    it('says the plugin is missing once the scan has finished', async () => {
      invoke.mockResolvedValue([]);
      render(<InstrumentsPanel />);

      expect(await screen.findByRole('option', { name: /Missing plugin/ })).toBeInTheDocument();
    });

    // The scan takes seconds. Calling a plugin missing before we have looked
    // would be wrong, and would flicker to correct.
    it('says it is still loading while the scan is running', () => {
      invoke.mockReturnValue(new Promise(() => {}));
      render(<InstrumentsPanel />);

      expect(screen.getByRole('option', { name: 'Loading plugins…' })).toBeInTheDocument();
      expect(screen.queryByRole('option', { name: /Missing plugin/ })).not.toBeInTheDocument();
    });

    it('resolves to the real plugin once the scan finds it', async () => {
      invoke.mockResolvedValue([plugin]);
      render(<InstrumentsPanel />);

      expect(await screen.findByRole('option', { name: 'Surge XT — Surge Synth Team' }))
        .toBeInTheDocument();
      expect(screen.queryByRole('option', { name: /Missing plugin/ })).not.toBeInTheDocument();
    });
  });
});
