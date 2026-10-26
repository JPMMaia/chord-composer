import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react';
import { SettingsDialog } from '@/components/SettingsDialog';
import {
  applyOutputDevice,
  canAimWebAudio,
  listOutputDevices,
  loadOutputDevice,
  requestDeviceNames,
} from '@/engine/audioOutput';
import {
  applyBufferSize,
  applyHeadroom,
  applyResetOnStop,
  loadAudioPrefs,
  readAudioHealth,
} from '@/engine/audioPrefs';
import {
  MIDI_PREFS_STORAGE_KEY,
  reportVelocity,
  resetMidiPrefsCache,
} from '@/engine/midiPrefs';
import { isTauri } from '@/engine/platform';

vi.mock('@/engine/audioOutput', () => ({
  listOutputDevices: vi.fn(),
  canAimWebAudio: vi.fn(),
  applyOutputDevice: vi.fn(),
  requestDeviceNames: vi.fn(),
  loadOutputDevice: vi.fn(),
}));

vi.mock('@/engine/audioPrefs', async importActual => ({
  // The pure arithmetic is worth keeping: a latency shown in the option labels
  // that disagreed with the real one would be a fault this test should catch.
  ...(await importActual<typeof import('@/engine/audioPrefs')>()),
  applyBufferSize: vi.fn(),
  applyHeadroom: vi.fn(),
  applyResetOnStop: vi.fn(),
  loadAudioPrefs: vi.fn(),
  readAudioHealth: vi.fn(),
}));

vi.mock('@/engine/platform', () => ({ isTauri: vi.fn() }));

const DEVICES = [
  { name: 'Speakers (2- B2)', isDefault: true },
  { name: 'Speakers (Realtek(R) Audio)', isDefault: false },
];

const HEALTH = {
  late: 0,
  worstUs: 1500,
  starved: 0,
  load: 0.2,
  block: 480,
  sampleRate: 48000,
};

function open() {
  render(<SettingsDialog onClose={() => {}} />);
}

/** Move to one of the other tabs, which is where everything but audio lives. */
function openTab(name: string) {
  fireEvent.click(screen.getByRole('tab', { name }));
}

/** The device select, once the machine's endpoints have arrived. */
async function deviceSelect(): Promise<HTMLSelectElement> {
  const select = await screen.findByLabelText<HTMLSelectElement>('Output device');
  await waitFor(() => expect(select.querySelectorAll('option')).toHaveLength(3));
  return select;
}

describe('SettingsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listOutputDevices).mockResolvedValue(DEVICES);
    vi.mocked(canAimWebAudio).mockResolvedValue(true);
    vi.mocked(applyOutputDevice).mockResolvedValue({ webAudio: null, native: null });
    vi.mocked(requestDeviceNames).mockResolvedValue(true);
    vi.mocked(loadOutputDevice).mockReturnValue(null);
    vi.mocked(applyBufferSize).mockResolvedValue({ error: null, note: null });
    vi.mocked(applyHeadroom).mockResolvedValue(undefined);
    vi.mocked(applyResetOnStop).mockResolvedValue(undefined);
    vi.mocked(loadAudioPrefs).mockReturnValue({ bufferFrames: null, headroomMs: 0, resetOnStop: true });
    vi.mocked(readAudioHealth).mockResolvedValue(HEALTH);
    vi.mocked(isTauri).mockReturnValue(true);
    localStorage.removeItem(MIDI_PREFS_STORAGE_KEY);
    resetMidiPrefsCache();
  });

  afterEach(cleanup);

  describe('the MIDI tab', () => {
    it('starts with velocity passed through untouched', () => {
      open();
      openTab('MIDI');

      expect(screen.getByLabelText<HTMLInputElement>('Touch sensitivity').value).toBe('0');
      expect(screen.getByLabelText<HTMLInputElement>('Minimum velocity').value).toBe('0');
    });

    it('remembers a lighter touch', () => {
      open();
      openTab('MIDI');
      fireEvent.change(screen.getByLabelText('Touch sensitivity'), { target: { value: '50' } });

      expect(JSON.parse(localStorage.getItem(MIDI_PREFS_STORAGE_KEY)!)).toEqual({
        touch: 50,
        minVelocity: 0,
      });
    });

    it('shows what the last key arrived at and what it became', () => {
      open();
      openTab('MIDI');
      fireEvent.change(screen.getByLabelText('Touch sensitivity'), { target: { value: '50' } });
      act(() => reportVelocity(54));

      // γ = 0.5: 127 * sqrt(54 / 127) ≈ 82.8.
      expect(screen.getByRole('status', { name: 'Last key' })).toHaveTextContent(
        'Last key: in 54 → out 83'
      );
    });
  });

  it('opens on the audio tab', async () => {
    open();
    expect(await screen.findByLabelText('Output device')).toBeInTheDocument();
  });

  describe('the output device', () => {
    it('offers the system default and every endpoint', async () => {
      open();

      const select = await screen.findByLabelText('Output device');
      await waitFor(() =>
        expect(Array.from(select.querySelectorAll('option')).map(o => o.textContent)).toEqual([
          'System default',
          'Speakers (2- B2) (system default)',
          'Speakers (Realtek(R) Audio)',
        ])
      );
    });

    it('starts on the remembered device', async () => {
      vi.mocked(loadOutputDevice).mockReturnValue('Speakers (Realtek(R) Audio)');
      open();

      const select = await screen.findByLabelText<HTMLSelectElement>('Output device');
      await waitFor(() => expect(select.value).toBe('Speakers (Realtek(R) Audio)'));
    });

    it('moves the sound when a device is picked', async () => {
      open();
      fireEvent.change(await deviceSelect(), {
        target: { value: 'Speakers (Realtek(R) Audio)' },
      });
      expect(applyOutputDevice).toHaveBeenCalledWith('Speakers (Realtek(R) Audio)');
    });

    it('sends null rather than a name for the system default', async () => {
      vi.mocked(loadOutputDevice).mockReturnValue('Speakers (Realtek(R) Audio)');
      open();
      // Null means "follow the system", which is not the same as naming whichever
      // device happens to be default today.
      fireEvent.change(await deviceSelect(), { target: { value: '' } });
      expect(applyOutputDevice).toHaveBeenCalledWith(null);
    });

    it('reports each engine that did not move', async () => {
      vi.mocked(applyOutputDevice).mockResolvedValue({
        webAudio: 'could not find “X”',
        native: 'cannot run at 48000 Hz',
      });
      open();
      fireEvent.change(await deviceSelect(), {
        target: { value: 'Speakers (Realtek(R) Audio)' },
      });

      expect(await screen.findByText(/built-in instruments did not move/i)).toBeInTheDocument();
      expect(await screen.findByText(/plugins did not move/i)).toBeInTheDocument();
    });

    it('offers the permission when the window cannot name devices', async () => {
      vi.mocked(canAimWebAudio).mockResolvedValue(false);
      open();

      expect(await screen.findByRole('button', { name: /show device names/i })).toBeInTheDocument();
    });

    it('hides the permission prompt once names are available', async () => {
      open();

      await screen.findByLabelText('Output device');
      expect(screen.queryByRole('button', { name: /show device names/i })).not.toBeInTheDocument();
    });

    it('re-applies the choice after the permission is granted', async () => {
      vi.mocked(canAimWebAudio).mockResolvedValue(false);
      vi.mocked(loadOutputDevice).mockReturnValue('Speakers (Realtek(R) Audio)');
      open();

      fireEvent.click(await screen.findByRole('button', { name: /show device names/i }));

      // The point of granting it: the device that could not be aimed at before now
      // can be, without the user having to pick it a second time.
      await waitFor(() =>
        expect(applyOutputDevice).toHaveBeenCalledWith('Speakers (Realtek(R) Audio)')
      );
    });

    it('says so when the permission is refused', async () => {
      vi.mocked(canAimWebAudio).mockResolvedValue(false);
      vi.mocked(requestDeviceNames).mockResolvedValue(false);
      open();

      fireEvent.click(await screen.findByRole('button', { name: /show device names/i }));

      expect(await screen.findByText(/cannot be moved/i)).toBeInTheDocument();
      expect(applyOutputDevice).not.toHaveBeenCalled();
    });
  });

  describe('the block size', () => {
    it('starts on the device default when nobody has chosen one', async () => {
      open();

      const select = await screen.findByLabelText<HTMLSelectElement>('Block size');
      expect(select.value).toBe('device');
    });

    it('starts on the remembered size', async () => {
      vi.mocked(loadAudioPrefs).mockReturnValue({ bufferFrames: 1024, headroomMs: 0, resetOnStop: true });
      open();

      const select = await screen.findByLabelText<HTMLSelectElement>('Block size');
      expect(select.value).toBe('1024');
    });

    // The trade this setting makes is latency, so the latency has to be on the
    // choice itself rather than somewhere the user has to go and work it out.
    it('shows what each size costs at the session rate', async () => {
      open();

      const select = await screen.findByLabelText('Block size');
      await waitFor(() =>
        expect(Array.from(select.querySelectorAll('option')).map(o => o.textContent)).toContain(
          '1024 frames (21.3 ms)'
        )
      );
    });

    it('asks the engine for the size that was picked', async () => {
      open();

      fireEvent.change(await screen.findByLabelText('Block size'), { target: { value: '2048' } });
      expect(applyBufferSize).toHaveBeenCalledWith(2048);
    });

    it('sends null rather than a number for the device default', async () => {
      vi.mocked(loadAudioPrefs).mockReturnValue({ bufferFrames: 2048, headroomMs: 0, resetOnStop: true });
      open();

      fireEvent.change(await screen.findByLabelText('Block size'), { target: { value: 'device' } });
      expect(applyBufferSize).toHaveBeenCalledWith(null);
    });

    // A size the device refused still changed something — just not to what was
    // asked for. Saying nothing would leave the panel showing a number that is
    // not the one running.
    it('reports a size the device would not take', async () => {
      vi.mocked(applyBufferSize).mockResolvedValue({
        error: null,
        note: 'That block size was refused (nope), so the device’s own is being used.',
      });
      open();

      fireEvent.change(await screen.findByLabelText('Block size'), { target: { value: '256' } });
      expect(await screen.findByText(/was refused/i)).toBeInTheDocument();
    });

    it('reports a change that did not happen at all', async () => {
      vi.mocked(applyBufferSize).mockResolvedValue({ error: 'no audio thread', note: null });
      open();

      fireEvent.change(await screen.findByLabelText('Block size'), { target: { value: '256' } });
      expect(await screen.findByText(/block size did not change/i)).toBeInTheDocument();
    });

    // There is no plugin engine in a browser, so there is nothing to size.
    it('is not offered outside the desktop build', async () => {
      vi.mocked(isTauri).mockReturnValue(false);
      open();

      await screen.findByLabelText('Output device');
      expect(screen.queryByLabelText('Block size')).not.toBeInTheDocument();
    });
  });

  describe('the render headroom', () => {
    it('starts off, which is how every session rendered before it existed', async () => {
      open();
      openTab('Performance');

      const select = await screen.findByLabelText<HTMLSelectElement>('Render ahead');
      expect(select.value).toBe('0');
    });

    it('starts on the remembered headroom', async () => {
      vi.mocked(loadAudioPrefs).mockReturnValue({ bufferFrames: null, headroomMs: 100, resetOnStop: true });
      open();
      openTab('Performance');

      const select = await screen.findByLabelText<HTMLSelectElement>('Render ahead');
      expect(select.value).toBe('100');
    });

    it('tells the engine what was picked', async () => {
      open();
      openTab('Performance');

      fireEvent.change(await screen.findByLabelText('Render ahead'), { target: { value: '50' } });
      expect(applyHeadroom).toHaveBeenCalledWith(50);
    });

    // Off has to read as a choice rather than as a broken control: it is the
    // path this is being compared against.
    it('names the off choice for what it does', async () => {
      open();
      openTab('Performance');

      const select = await screen.findByLabelText('Render ahead');
      expect(
        Array.from(select.querySelectorAll('option')).map(o => o.textContent)
      ).toContain('Off — render in the audio callback');
    });
  });

  describe('putting instruments back on Stop', () => {
    it('is on for a machine nobody has configured', async () => {
      open();
      openTab('Performance');

      const box = await screen.findByRole<HTMLInputElement>('checkbox', {
        name: /put instruments back/i,
      });
      expect(box.checked).toBe(true);
    });

    it('starts off when the machine has asked it to be', async () => {
      vi.mocked(loadAudioPrefs).mockReturnValue({
        bufferFrames: null,
        headroomMs: 0,
        resetOnStop: false,
      });
      open();
      openTab('Performance');

      const box = await screen.findByRole<HTMLInputElement>('checkbox', {
        name: /put instruments back/i,
      });
      expect(box.checked).toBe(false);
    });

    it('remembers being turned off', async () => {
      open();
      openTab('Performance');

      fireEvent.click(
        await screen.findByRole('checkbox', { name: /put instruments back/i })
      );
      expect(applyResetOnStop).toHaveBeenCalledWith(false);
    });

    // The control has to say what it costs and what it buys, because neither is
    // guessable from four words on a checkbox.
    it('explains why an instrument would need putting back', async () => {
      open();
      openTab('Performance');

      expect(
        await screen.findByText(/get slower the longer they play/i)
      ).toBeInTheDocument();
    });
  });

  describe('diagnostics', () => {
    it('shows what the audio thread is costing', async () => {
      vi.mocked(readAudioHealth).mockResolvedValue({ ...HEALTH, late: 3, worstUs: 28000 });
      open();
      openTab('Diagnostics');

      expect(await screen.findByText('3')).toBeInTheDocument();
      expect(await screen.findByText('28.0 ms')).toBeInTheDocument();
    });

    // A row of zeroes would read as "nothing is dropping out" rather than as
    // "nothing is playing", which is the opposite of reassuring.
    it('says there is no engine rather than showing zeroes', async () => {
      vi.mocked(readAudioHealth).mockResolvedValue(null);
      open();
      openTab('Diagnostics');

      expect(await screen.findByText(/no plugin engine is running/i)).toBeInTheDocument();
    });

    it('explains what a crackle actually is', async () => {
      open();
      openTab('Diagnostics');

      expect(await screen.findByText(/took longer to render than it had/i)).toBeInTheDocument();
    });
  });
});
