import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { AudioSettings } from '@/components/AudioSettings';
import {
  applyOutputDevice,
  canAimWebAudio,
  listOutputDevices,
  loadOutputDevice,
  requestDeviceNames,
} from '@/engine/audioOutput';

vi.mock('@/engine/audioOutput', () => ({
  listOutputDevices: vi.fn(),
  canAimWebAudio: vi.fn(),
  applyOutputDevice: vi.fn(),
  requestDeviceNames: vi.fn(),
  loadOutputDevice: vi.fn(),
}));

const DEVICES = [
  { name: 'Speakers (2- B2)', isDefault: true },
  { name: 'Speakers (Realtek(R) Audio)', isDefault: false },
];

/** Open the panel, which is where everything but the button lives. */
function openPanel() {
  render(<AudioSettings />);
  fireEvent.click(screen.getByLabelText('Audio settings'));
}

/** The device select, once the machine's endpoints have arrived. */
async function deviceSelect(): Promise<HTMLSelectElement> {
  const select = await screen.findByLabelText<HTMLSelectElement>('Output device');
  await waitFor(() => expect(select.querySelectorAll('option')).toHaveLength(3));
  return select;
}

describe('AudioSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listOutputDevices).mockResolvedValue(DEVICES);
    vi.mocked(canAimWebAudio).mockResolvedValue(true);
    vi.mocked(applyOutputDevice).mockResolvedValue({ webAudio: null, native: null });
    vi.mocked(requestDeviceNames).mockResolvedValue(true);
    vi.mocked(loadOutputDevice).mockReturnValue(null);
  });

  afterEach(cleanup);

  it('shows nothing until it is opened', () => {
    render(<AudioSettings />);
    expect(screen.queryByLabelText('Output device')).not.toBeInTheDocument();
  });

  it('offers the system default and every endpoint', async () => {
    openPanel();

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
    openPanel();

    const select = await screen.findByLabelText<HTMLSelectElement>('Output device');
    await waitFor(() => expect(select.value).toBe('Speakers (Realtek(R) Audio)'));
  });

  it('moves the sound when a device is picked', async () => {
    openPanel();
    const select = await deviceSelect();
    fireEvent.change(select, { target: { value: 'Speakers (Realtek(R) Audio)' } });
    expect(applyOutputDevice).toHaveBeenCalledWith('Speakers (Realtek(R) Audio)');
  });

  it('sends null rather than a name for the system default', async () => {
    vi.mocked(loadOutputDevice).mockReturnValue('Speakers (Realtek(R) Audio)');
    openPanel();
    const select = await deviceSelect();
    fireEvent.change(select, { target: { value: '' } });
    // Null means "follow the system", which is not the same as naming whichever
    // device happens to be default today.
    expect(applyOutputDevice).toHaveBeenCalledWith(null);
  });

  it('reports each engine that did not move', async () => {
    vi.mocked(applyOutputDevice).mockResolvedValue({
      webAudio: 'could not find “X”',
      native: 'cannot run at 48000 Hz',
    });
    openPanel();
    const select = await deviceSelect();
    fireEvent.change(select, { target: { value: 'Speakers (Realtek(R) Audio)' } });

    expect(await screen.findByText(/built-in instruments did not move/i)).toBeInTheDocument();
    expect(await screen.findByText(/plugins did not move/i)).toBeInTheDocument();
  });

  it('offers the permission when the window cannot name devices', async () => {
    vi.mocked(canAimWebAudio).mockResolvedValue(false);
    openPanel();

    expect(await screen.findByRole('button', { name: /show device names/i })).toBeInTheDocument();
  });

  it('hides the permission prompt once names are available', async () => {
    openPanel();

    await screen.findByLabelText('Output device');
    expect(screen.queryByRole('button', { name: /show device names/i })).not.toBeInTheDocument();
  });

  it('re-applies the choice after the permission is granted', async () => {
    vi.mocked(canAimWebAudio).mockResolvedValue(false);
    vi.mocked(loadOutputDevice).mockReturnValue('Speakers (Realtek(R) Audio)');
    openPanel();

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
    openPanel();

    fireEvent.click(await screen.findByRole('button', { name: /show device names/i }));

    expect(await screen.findByText(/cannot be moved/i)).toBeInTheDocument();
    expect(applyOutputDevice).not.toHaveBeenCalled();
  });
});
