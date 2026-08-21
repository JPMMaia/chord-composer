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
import { phraseById } from '@/engine/phrases';
import { openTestPhrase } from '../helpers/phrases';
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

/**
 * The phrase the timeline has open — the one a learned lane is added to.
 *
 * A CC curve is written on the phrase's own beats and heard at every placement of
 * it, so learning a controller adds the lane there rather than on the instrument;
 * the plugin the controller is *sent* to is still the selected instrument's.
 */
let phraseId = '';
const phrase = () => phraseById(projectStore.getState().project!.phrases, phraseId)!;
const lanes = () => phrase().parameterAutomation;

const ccField = () =>
  screen.queryByLabelText('Controller number to learn') as HTMLInputElement | null;
const sendButton = () => screen.getByRole('button', { name: /Send/ });

/** The number field that adds a lane outright, which is always there. */
const addField = () =>
  screen.queryByLabelText('Controller number to automate') as HTMLInputElement | null;
const addButton = () => screen.getByRole('button', { name: 'Add CC lane' });

/** Add a lane by number, the way an instrument with no MIDI learn takes one. */
function addLane(controller?: number) {
  if (controller !== undefined) {
    fireEvent.change(addField()!, { target: { value: String(controller) } });
  }
  fireEvent.click(addButton());
}

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
  // The stack draws the open phrase's curves against the selected instrument: the
  // phrase for the lanes, the instrument for the plugin they are learned from.
  selectionStore.getState().selectTrack(trackId());
  phraseId = openTestPhrase(trackId(), 2).phraseId;

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
    expect(lanes()).toEqual([
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
    expect(lanes()).toBeUndefined();
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

    expect(lanes()![0].name).toBe('Filter Cutoff');
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

    expect(lanes()![0].name).toBe('CC 20');
  });

  // The volume lane has a fader behind it and is not the user's to name.
  it('does not offer to rename the volume lane', () => {
    render(<ChordTimeline />);

    const gutter = screen.getByTestId('timeline-gutter');
    fireEvent.doubleClick(within(gutter).getByText('Volume'));
    expect(screen.queryByLabelText('Rename Volume lane')).toBeNull();
  });

  /**
   * Adding a lane by number, which is what most projects have to go on.
   *
   * MIDI learn is a shortcut only a plugin publishing an `IMidiMapping` can offer,
   * and for a long while it was the *only* way to a CC lane — so a General MIDI
   * sound, a plugin that publishes no mapping, and a browser build could not
   * automate a controller at all. The lane belongs to the phrase and reaches the
   * MIDI export whatever ends up playing it, so the number field is always there.
   */
  describe('adding a lane by number', () => {
    it('is there on a track that is not a plugin at all', () => {
      render(<ChordTimeline />);

      expect(addField()).toBeInTheDocument();
      expect(ccField()).toBeNull();
    });

    it('is there when the plugin maps no controllers', async () => {
      mapsCc = false;
      usePlugin();
      render(<ChordTimeline />);

      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith('vst3_list_cc', expect.anything())
      );
      expect(addField()).toBeInTheDocument();
    });

    it('opens on the first controller in the quiet block', () => {
      render(<ChordTimeline />);

      expect(addField()!.value).toBe('20');
    });

    // Nothing is sent anywhere: with no plugin to teach, the lane is simply made.
    it('adds the lane without asking the native side for anything', () => {
      render(<ChordTimeline />);
      addLane();

      expect(lanes()).toEqual([
        { target: { kind: 'cc', controller: 20 }, name: 'CC 20', points: [] },
      ]);
      expect(invoke).not.toHaveBeenCalledWith('vst3_learn_cc', expect.anything());
    });

    it('draws the new lane alongside the volume lane', () => {
      render(<ChordTimeline />);
      addLane(74);

      expect(screen.getByLabelText('CC 74 automation lane')).toBeInTheDocument();
      expect(screen.getAllByTestId('automation-lane')).toHaveLength(2);
    });

    it('moves the suggestion on once a controller has a lane', () => {
      render(<ChordTimeline />);
      addLane();

      expect(addField()!.value).toBe('21');
    });

    // A second lane for the same target would be a second answer to one question,
    // and `normalizeParameterAutomation` would only merge them back anyway.
    it('refuses a controller the phrase already automates', () => {
      render(<ChordTimeline />);
      addLane(20);

      fireEvent.change(addField()!, { target: { value: '20' } });
      expect(addButton()).toBeDisabled();
    });

    it('refuses a number no controller could be', () => {
      render(<ChordTimeline />);

      fireEvent.change(addField()!, { target: { value: '200' } });
      expect(addButton()).toBeDisabled();
    });

    // Offering a number the plugin maps is what learn is for; typing one it does
    // not is still allowed, because the lane is the phrase's and the export reads it.
    it('takes a controller the plugin does not map', async () => {
      usePlugin();
      render(<ChordTimeline />);
      await settle();

      addLane(74);

      expect(screen.getByLabelText('CC 74 automation lane')).toBeInTheDocument();
    });

    it('keeps it out of the gutter, like the learn panel', () => {
      render(<ChordTimeline />);

      expect(
        within(screen.getByTestId('timeline-gutter')).queryByLabelText(
          'Controller number to automate'
        )
      ).toBeNull();
    });

    it('goes with the rest of the stack when automation is toggled off', () => {
      render(<ChordTimeline />);

      fireEvent.click(screen.getByLabelText('Automation lanes'));

      expect(addField()).toBeNull();
    });
  });
});
