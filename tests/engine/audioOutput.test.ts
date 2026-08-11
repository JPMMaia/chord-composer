import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  OUTPUT_DEVICE_STORAGE_KEY,
  applyOutputDevice,
  deviceNamesKnown,
  listOutputDevices,
  loadOutputDevice,
  matchDeviceId,
  normalizeDeviceName,
  registerAudioContext,
  storeOutputDevice,
} from '@/engine/audioOutput';

/** An `enumerateDevices` entry, with only the fields the matcher reads. */
function device(deviceId: string, label: string, kind = 'audiooutput'): MediaDeviceInfo {
  return { deviceId, label, kind, groupId: 'g' } as MediaDeviceInfo;
}

/** The device list on the machine this was built against. */
const REAL_DEVICES = [
  device('default', 'Default - Speakers (2- B2) (0944:020f)'),
  device('communications', 'Communications - Speakers (2- B2) (0944:020f)'),
  device('aaa', 'Speakers (Realtek(R) Audio)'),
  device('bbb', 'LC27G7xT (NVIDIA High Definition Audio)'),
  device('ccc', 'Speakers (2- B2) (0944:020f)'),
];

describe('normalizeDeviceName', () => {
  it('leaves an ordinary endpoint name alone', () => {
    expect(normalizeDeviceName('Speakers (Realtek(R) Audio)')).toBe('speakers (realtek(r) audio)');
  });

  it('strips the USB id Chromium appends but cpal does not', () => {
    // The whole reason this function exists: the same endpoint is
    // "Speakers (2- B2)" natively and "Speakers (2- B2) (0944:020f)" in the webview.
    expect(normalizeDeviceName('Speakers (2- B2) (0944:020f)')).toBe(
      normalizeDeviceName('Speakers (2- B2)')
    );
  });

  it('strips the Default and Communications prefixes', () => {
    expect(normalizeDeviceName('Default - Speakers (2- B2) (0944:020f)')).toBe(
      normalizeDeviceName('Speakers (2- B2)')
    );
    expect(normalizeDeviceName('Communications - Headset')).toBe(normalizeDeviceName('Headset'));
  });

  it('keeps a trailing bracket that is not a USB id', () => {
    // Four hex digits either side of a colon is the shape being stripped; a
    // device that merely ends in brackets must survive.
    expect(normalizeDeviceName('Speakers (Rear)')).toBe('speakers (rear)');
    expect(normalizeDeviceName('Output (12345:0001)')).toBe('output (12345:0001)');
  });
});

describe('matchDeviceId', () => {
  it('finds the concrete endpoint, not the Default alias', () => {
    // Picking "Default -" would mean "follow Windows", which is the opposite of
    // what choosing this device by name asks for.
    expect(matchDeviceId('Speakers (2- B2)', REAL_DEVICES)).toBe('ccc');
  });

  it('matches a name that needs no normalizing', () => {
    expect(matchDeviceId('Speakers (Realtek(R) Audio)', REAL_DEVICES)).toBe('aaa');
  });

  it('answers null for a device the webview cannot see', () => {
    expect(matchDeviceId('Some Unplugged Thing', REAL_DEVICES)).toBeNull();
  });

  it('ignores inputs with the same name', () => {
    const withInput = [device('mic', 'Speakers (Realtek(R) Audio)', 'audioinput'), ...REAL_DEVICES];
    expect(matchDeviceId('Speakers (Realtek(R) Audio)', withInput)).toBe('aaa');
  });
});

describe('deviceNamesKnown', () => {
  it('is false before a media permission is granted', () => {
    // Unpermissioned Chromium answers with a single blank entry.
    expect(deviceNamesKnown([device('', '')])).toBe(false);
  });

  it('is true once labels come through', () => {
    expect(deviceNamesKnown(REAL_DEVICES)).toBe(true);
  });

  it('is false for an empty list', () => {
    expect(deviceNamesKnown([])).toBe(false);
  });
});

describe('the remembered choice', () => {
  beforeEach(() => localStorage.clear());

  it('is absent until something is chosen', () => {
    expect(loadOutputDevice()).toBeNull();
  });

  it('round-trips a device name', () => {
    storeOutputDevice('Speakers (Realtek(R) Audio)');
    expect(loadOutputDevice()).toBe('Speakers (Realtek(R) Audio)');
  });

  it('clears back to the system default', () => {
    storeOutputDevice('Speakers (Realtek(R) Audio)');
    storeOutputDevice(null);
    expect(loadOutputDevice()).toBeNull();
    expect(localStorage.getItem(OUTPUT_DEVICE_STORAGE_KEY)).toBeNull();
  });

  it('ignores a stored value that is not a name', () => {
    localStorage.setItem(OUTPUT_DEVICE_STORAGE_KEY, JSON.stringify({ nonsense: true }));
    expect(loadOutputDevice()).toBeNull();
  });
});

describe('applyOutputDevice', () => {
  let setSinkId: ReturnType<typeof vi.fn>;
  let context: AudioContext;

  beforeEach(() => {
    localStorage.clear();
    setSinkId = vi.fn().mockResolvedValue(undefined);
    context = { setSinkId } as unknown as AudioContext;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { enumerateDevices: vi.fn().mockResolvedValue(REAL_DEVICES) },
    });
  });

  afterEach(() => {
    registerAudioContext(null);
  });

  it('points a registered context at the chosen endpoint', async () => {
    registerAudioContext(context);
    const outcome = await applyOutputDevice('Speakers (Realtek(R) Audio)');

    expect(setSinkId).toHaveBeenCalledWith('aaa');
    expect(outcome.webAudio).toBeNull();
  });

  it('resets to the system default with an empty sink id', async () => {
    registerAudioContext(context);
    const outcome = await applyOutputDevice(null);

    // The empty string is Chromium's "follow the system", which is not the same
    // as the id of whatever happens to be default right now.
    expect(setSinkId).toHaveBeenCalledWith('');
    expect(outcome.webAudio).toBeNull();
  });

  it('reports a device the webview cannot see rather than silently doing nothing', async () => {
    registerAudioContext(context);
    // Registering aims the context at the remembered choice, which here is the
    // system default. That call is not what this test is about.
    await vi.waitFor(() => expect(setSinkId).toHaveBeenCalled());
    setSinkId.mockClear();

    const outcome = await applyOutputDevice('Some Unplugged Thing');

    expect(setSinkId).not.toHaveBeenCalled();
    expect(outcome.webAudio).toMatch(/could not/i);
  });

  it('reports the failure when the browser refuses the sink', async () => {
    setSinkId.mockRejectedValue(new Error('NotAllowedError'));
    registerAudioContext(context);

    const outcome = await applyOutputDevice('Speakers (Realtek(R) Audio)');
    expect(outcome.webAudio).toMatch(/NotAllowedError/);
  });

  it('succeeds with nothing to move when no context exists yet', async () => {
    // Choosing a device before the first Play is normal; the choice is applied
    // when the graph comes up.
    const outcome = await applyOutputDevice('Speakers (Realtek(R) Audio)');
    expect(outcome.webAudio).toBeNull();
  });

  it('remembers the choice', async () => {
    registerAudioContext(context);
    await applyOutputDevice('Speakers (Realtek(R) Audio)');
    expect(loadOutputDevice()).toBe('Speakers (Realtek(R) Audio)');
  });

  it('applies the remembered choice to a context registered later', async () => {
    storeOutputDevice('Speakers (Realtek(R) Audio)');
    registerAudioContext(context);

    // Registration is asynchronous: it has to enumerate before it can match.
    await vi.waitFor(() => expect(setSinkId).toHaveBeenCalledWith('aaa'));
  });
});

describe('listOutputDevices', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { enumerateDevices: vi.fn().mockResolvedValue(REAL_DEVICES) },
    });
  });

  it('lists each real endpoint once, dropping the aliases', async () => {
    const devices = await listOutputDevices();
    expect(devices.map(d => d.name)).toEqual([
      'Speakers (Realtek(R) Audio)',
      'LC27G7xT (NVIDIA High Definition Audio)',
      'Speakers (2- B2) (0944:020f)',
    ]);
  });

  it('marks the endpoint the Default alias points at', async () => {
    const devices = await listOutputDevices();
    expect(devices.find(d => d.isDefault)?.name).toBe('Speakers (2- B2) (0944:020f)');
  });

  it('answers empty when names are still locked behind the permission', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { enumerateDevices: vi.fn().mockResolvedValue([device('', '')]) },
    });
    expect(await listOutputDevices()).toEqual([]);
  });

  it('answers empty rather than throwing where there is no media API at all', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    expect(await listOutputDevices()).toEqual([]);
  });
});
