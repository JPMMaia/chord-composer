import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Same treatment the other VST3 tests give it: Tauri's IPC needs a real native host.
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { ChordTimeline } from '@/components/ChordTimeline';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { editorStore } from '@/store/editorStore';
import { resetVst3Cc, type Vst3CcInfo } from '@/engine/vst3Cc';
import { vst3Ref } from '@/engine/instrumentRef';
import { DEFAULT_SNAP_BEATS } from '@/engine/timeline';
import { PIXELS_PER_BEAT } from '@/utils/constants';

const MARKER = '__TAURI_INTERNALS__';
const CLASS_ID = '565354416d736e6f53757267652058ab';

/** What the mocked plugin maps, deliberately not the whole 0-127 range. */
const MAPPED_CC: Vst3CcInfo[] = [20, 21, 22].map(controller => ({
  controller,
  paramId: 1000 + controller,
}));

/** Which of the mocked plugin's controllers are on offer, if any. */
let mapsCc = true;

/** The native side, standing in for a plugin that maps controllers. */
const answer = (command: string) => {
  if (command === 'vst3_list_cc') return Promise.resolve(mapsCc ? MAPPED_CC : []);
  return Promise.resolve(undefined);
};

const trackId = () => projectStore.getState().project!.tracks[0].id;

const ccField = () =>
  screen.queryByLabelText('Controller number to learn') as HTMLInputElement | null;
const sendButton = () => screen.getByRole('button', { name: /Send/ });

/** Let the memoised native call for the controller list settle. */
const settle = () => screen.findByLabelText('Controller number to learn');

/** Bind a controller, which is the only way to get a plugin lane. */
async function learn(controller?: number) {
  const field = await settle();
  if (controller !== undefined) fireEvent.change(field, { target: { value: String(controller) } });
  fireEvent.click(sendButton());
  return screen.findByLabelText(`CC ${controller ?? field.value} automation lane`);
}

beforeEach(() => {
  projectStore.getState().resetProject();
  selectionStore.getState().clearSelection();
  editorStore.setState({
    snapBeats: DEFAULT_SNAP_BEATS,
    pixelsPerBeat: PIXELS_PER_BEAT,
    scrollX: 0,
    maxScrollX: 0,
    viewportWidth: 0,
    showAutomation: true,
    paletteScale: { root: 'C', type: 'major' },
    paletteOctave: 4,
    formulaStartDegree: 0,
    draggingFormulaId: null,
  });
  mapsCc = true;
  projectStore.getState().createProject();
  selectionStore.getState().selectTrack(trackId());

  resetVst3Cc();
  invoke.mockReset();
  invoke.mockImplementation(answer);
  (window as unknown as Record<string, unknown>)[MARKER] = {};
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[MARKER];
});

/** Point the selected instrument at a plugin, so it has controllers at all. */
function usePlugin() {
  projectStore.getState().setTrackInstrument(trackId(), vst3Ref(CLASS_ID));
}

describe('ChordTimeline MIDI CC lanes', () => {
  it('offers the first controller in the quiet block, pre-filled', async () => {
    usePlugin();
    render(<ChordTimeline />);

    expect((await settle()).value).toBe('20');
  });

  // A plugin with no `IMidiMapping` cannot be sent a controller at all, so a
  // panel promising to teach one could only mislead.
  it('is absent when the plugin maps no controllers', async () => {
    mapsCc = false;
    usePlugin();
    render(<ChordTimeline />);

    // Waited out properly: the panel is absent because the plugin answered with
    // nothing, not because the answer had yet to arrive.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('vst3_list_cc', expect.anything())
    );
    await waitFor(() => expect(ccField()).toBeNull());
  });

  it('is absent on a track that is not a plugin', () => {
    render(<ChordTimeline />);
    expect(ccField()).toBeNull();
  });

  it('sends the shown controller, then adds a lane for it', async () => {
    usePlugin();
    render(<ChordTimeline />);

    // The lane is added only once the plugin has actually been sent the
    // controller, so a failed send leaves no lane driving nothing.
    await learn();

    expect(invoke).toHaveBeenCalledWith('vst3_learn_cc', {
      trackId: trackId(),
      controller: 20,
    });
    expect(projectStore.getState().project!.tracks[0].parameterAutomation).toEqual([
      { target: { kind: 'cc', controller: 20 }, name: 'CC 20', points: [] },
    ]);
  });

  it('draws the new lane alongside the volume lane rather than instead of it', async () => {
    usePlugin();
    render(<ChordTimeline />);
    await learn();

    expect(screen.getByLabelText('Volume automation lane')).toBeInTheDocument();
    expect(screen.getAllByTestId('automation-lane')).toHaveLength(2);
  });

  it('moves the suggestion on once a controller has a lane', async () => {
    usePlugin();
    render(<ChordTimeline />);
    await learn();

    expect(ccField()!.value).toBe('21');
  });

  it('sends whatever number was typed instead of the suggestion', async () => {
    usePlugin();
    render(<ChordTimeline />);
    await learn(22);

    expect(invoke).toHaveBeenCalledWith('vst3_learn_cc', {
      trackId: trackId(),
      controller: 22,
    });
  });

  // Sending a controller the plugin does not map would go nowhere, and look
  // exactly like a plugin that was never armed.
  it('refuses to send a controller the plugin does not map', async () => {
    usePlugin();
    render(<ChordTimeline />);

    fireEvent.change(await settle(), { target: { value: '74' } });

    expect(sendButton()).toBeDisabled();
  });

  // Every mapped controller has a lane, so there is nothing left to suggest and
  // nothing a send could bind.
  it('has nothing to send once every controller it maps has a lane', async () => {
    usePlugin();
    render(<ChordTimeline />);

    await learn(20);
    await learn(21);
    await learn(22);

    expect(ccField()!.value).toBe('');
    expect(sendButton()).toBeDisabled();
  });

  it('removes a lane, and puts its controller back on offer', async () => {
    usePlugin();
    render(<ChordTimeline />);
    await learn();

    fireEvent.click(screen.getByLabelText('Remove CC 20 automation'));

    expect(screen.queryByLabelText('CC 20 automation lane')).not.toBeInTheDocument();
    expect(projectStore.getState().project!.tracks[0].parameterAutomation).toBeUndefined();
    expect(ccField()!.value).toBe('20');
  });

  it('labels the lane in the gutter, beside the volume label', async () => {
    usePlugin();
    render(<ChordTimeline />);
    await learn();

    const gutter = screen.getByTestId('timeline-gutter');
    expect(within(gutter).getByText('Volume')).toBeInTheDocument();
    expect(within(gutter).getByText('CC 20')).toBeInTheDocument();
  });

  // The gutter is bottom-aligned against the curves, so its rows only stay in
  // step with them while it holds nothing but rows of a lane's height. Anything
  // taller pushes every label up out of line with the lane it names — and, at
  // the width of the piano roll's key column, wraps to one word a line besides.
  it('keeps what adds a lane out of the gutter', async () => {
    usePlugin();
    render(<ChordTimeline />);
    await settle();

    expect(
      within(screen.getByTestId('timeline-gutter')).queryByLabelText(
        'Controller number to learn'
      )
    ).toBeNull();
  });

  it('hides the whole stack, panel and all, when automation is toggled off', async () => {
    usePlugin();
    render(<ChordTimeline />);
    await learn();

    fireEvent.click(screen.getByLabelText('Automation lanes'));

    expect(screen.queryAllByTestId('automation-lane')).toHaveLength(0);
    expect(ccField()).toBeNull();
  });

  // The lane names itself from what was stored when it was made, so a project
  // opened where the plugin is missing still says what its curves drive.
  it('names a lane from the stored name when the plugin cannot be asked', async () => {
    usePlugin();
    render(<ChordTimeline />);
    await learn();

    // The plugin goes away: no scan, no controller list.
    resetVst3Cc();
    invoke.mockRejectedValue(new Error('no such plugin'));
    delete (window as unknown as Record<string, unknown>)[MARKER];
    render(<ChordTimeline />);

    expect(screen.getAllByLabelText('CC 20 automation lane').length).toBeGreaterThan(0);
  });

  // "CC 20" says nothing about what it drives, which is the whole problem MIDI
  // learn leaves behind.
  it('renames a lane in place', async () => {
    usePlugin();
    render(<ChordTimeline />);
    await learn();

    fireEvent.doubleClick(screen.getByText('CC 20'));
    const input = screen.getByLabelText('Rename CC 20 lane');
    fireEvent.change(input, { target: { value: 'Filter Cutoff' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(projectStore.getState().project!.tracks[0].parameterAutomation![0].name).toBe(
      'Filter Cutoff'
    );
    expect(screen.getByLabelText('Filter Cutoff automation lane')).toBeInTheDocument();
  });

  it('reverts a rename on Escape', async () => {
    usePlugin();
    render(<ChordTimeline />);
    await learn();

    fireEvent.doubleClick(screen.getByText('CC 20'));
    const input = screen.getByLabelText('Rename CC 20 lane');
    fireEvent.change(input, { target: { value: 'Discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(projectStore.getState().project!.tracks[0].parameterAutomation![0].name).toBe(
      'CC 20'
    );
  });

  // The volume lane has a fader behind it and is not the user's to name.
  it('does not offer to rename the volume lane', () => {
    render(<ChordTimeline />);

    const gutter = screen.getByTestId('timeline-gutter');
    fireEvent.doubleClick(within(gutter).getByText('Volume'));
    expect(screen.queryByLabelText('Rename Volume lane')).toBeNull();
  });
});
