import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@/engine/platform';

/**
 * Which speakers the app plays through.
 *
 * The app makes sound in two engines that share no notion of a device. Web Audio
 * — the built-in piano, the SFZ instruments, auditions, the metronome — comes out
 * of one `AudioContext`, and is aimed with `AudioContext.setSinkId`. Hosted VST3
 * plugins render on a cpal stream in the Rust process, and are aimed by
 * `vst3_set_output_device`. One choice therefore has to be applied twice.
 *
 * **Devices are identified by name**, not by id, because that is the only thing
 * the two engines can both say. Chromium's `deviceId`s are opaque and salted per
 * origin; cpal has nothing but names. The names very nearly agree — the one
 * systematic difference is that Chromium appends the USB `vid:pid` to endpoints
 * it can identify, so `Speakers (2- B2)` and `Speakers (2- B2) (0944:020f)` are
 * the same speakers. `normalizeDeviceName` is that one difference, and the
 * `Default -` / `Communications -` aliases, and nothing else.
 *
 * **The names are not free.** Until the user grants a media permission, Chromium
 * answers `enumerateDevices` with a single blank entry: no ids, no labels, so
 * nothing to aim at. That is a property of the browser, not a choice made here —
 * `navigator.mediaDevices.selectAudioOutput` would sidestep it, but WebView2 does
 * not implement it. Hence `requestDeviceNames`, which the settings panel calls
 * from an explicit click rather than at startup: a microphone prompt nobody asked
 * for is alarming, and one attached to a button labelled with what it is for is
 * not. Nothing is ever recorded — the stream is stopped the moment it opens.
 *
 * The choice is a property of the machine, not of the piece, so it lives in
 * `localStorage` beside the SFZ library list rather than in the project file.
 */

/** One output endpoint, as the picker shows it. */
export interface AudioOutputDevice {
  /** The endpoint's name, which is also its identity across the two engines. */
  name: string;
  /** Whether this is what the system would pick on its own. */
  isDefault: boolean;
}

/** What became of an attempt to move the sound. Null means it worked. */
export interface ApplyOutcome {
  /** Why the built-in instruments did not move, if they did not. */
  webAudio: string | null;
  /** Why the hosted plugins did not move, if they did not. */
  native: string | null;
}

/** Versioned so a future change of record shape can orphan the old value. */
export const OUTPUT_DEVICE_STORAGE_KEY = 'chord-composer-audio-output-v1';

/**
 * Chromium's "follow the system" sink. Distinct from the id of whatever is
 * default at this moment, which would stop following it.
 */
const SYSTEM_DEFAULT_SINK = '';

/** The `(vid:pid)` Chromium appends to a USB endpoint's label. */
const USB_ID_SUFFIX = /\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i;

/** The aliases Chromium lists beside the real endpoints. */
const ALIAS_PREFIX = /^(default|communications)\s+-\s+/i;
const ALIAS_IDS = new Set(['default', 'communications']);

/**
 * The same endpoint named by either engine, reduced to one string.
 *
 * Only the two known differences are removed. Anything cleverer — fuzzy matching,
 * dropping all brackets — would start joining devices that are genuinely
 * different, and sending the sound to the wrong speakers is precisely the
 * complaint this feature exists to answer.
 */
export function normalizeDeviceName(name: string): string {
  return name.replace(ALIAS_PREFIX, '').replace(USB_ID_SUFFIX, '').trim().toLowerCase();
}

/** Whether the browser has told us what the devices are called yet. */
export function deviceNamesKnown(devices: MediaDeviceInfo[]): boolean {
  return devices.some(device => device.kind === 'audiooutput' && device.label !== '');
}

/**
 * The `deviceId` for the endpoint called `name`, or null if it is not there.
 *
 * The aliases are skipped: they are a redirection to whatever is default, and a
 * user who picked this device by name asked for this device.
 */
export function matchDeviceId(name: string, devices: MediaDeviceInfo[]): string | null {
  const wanted = normalizeDeviceName(name);
  const match = devices.find(
    device =>
      device.kind === 'audiooutput' &&
      !ALIAS_IDS.has(device.deviceId) &&
      normalizeDeviceName(device.label) === wanted
  );
  return match ? match.deviceId : null;
}

/** The remembered endpoint's name, or null for the system default. */
export function loadOutputDevice(): string | null {
  try {
    const stored = localStorage.getItem(OUTPUT_DEVICE_STORAGE_KEY);
    return typeof stored === 'string' && stored !== '' && !stored.startsWith('{') ? stored : null;
  } catch {
    // No storage is the same as no choice: the system default.
    return null;
  }
}

/** Remember an endpoint, or forget one and go back to the system default. */
export function storeOutputDevice(name: string | null): void {
  try {
    if (name === null) localStorage.removeItem(OUTPUT_DEVICE_STORAGE_KEY);
    else localStorage.setItem(OUTPUT_DEVICE_STORAGE_KEY, name);
  } catch {
    // The choice still applies to this session; it just will not be remembered.
  }
}

/** The audiooutput entries, or an empty list wherever the API is not there. */
async function enumerate(): Promise<MediaDeviceInfo[]> {
  try {
    const devices = await navigator.mediaDevices?.enumerateDevices();
    return devices ?? [];
  } catch {
    return [];
  }
}

/**
 * The endpoints this machine has, in the order the picker shows them.
 *
 * In the desktop build the list comes from cpal, which names every endpoint
 * without any permission at all; the webview's list is only needed to *aim* at
 * one. In a browser build there is no cpal and no VST3, so the webview's own
 * list is all there is — and it is empty until the permission is granted.
 */
export async function listOutputDevices(): Promise<AudioOutputDevice[]> {
  if (isTauri()) {
    try {
      return await invoke<AudioOutputDevice[]>('audio_output_devices');
    } catch {
      // An old build without the command, or a host that cannot enumerate.
      return [];
    }
  }

  const devices = await enumerate();
  if (!deviceNamesKnown(devices)) return [];

  const outputs = devices.filter(device => device.kind === 'audiooutput');
  // Which real endpoint the "Default -" alias stands for, so the picker can say
  // which one the system would have chosen.
  const defaultAlias = outputs.find(device => device.deviceId === 'default');
  const defaultName = defaultAlias ? normalizeDeviceName(defaultAlias.label) : null;

  return outputs
    .filter(device => !ALIAS_IDS.has(device.deviceId))
    .map(device => ({
      name: device.label,
      isDefault: normalizeDeviceName(device.label) === defaultName,
    }));
}

/**
 * Whether Web Audio can be aimed at a named device yet.
 *
 * False means the permission has not been granted, and any choice but the system
 * default will move the plugins alone. Worth asking *before* the user picks
 * something, so the panel can explain rather than report a failure afterwards.
 */
export async function canAimWebAudio(): Promise<boolean> {
  return deviceNamesKnown(await enumerate());
}

/**
 * Ask for the permission that unlocks device names.
 *
 * Answers whether names are now available. The microphone is opened and closed
 * in the same breath — the grant is the point, the stream is not.
 */
export async function requestDeviceNames(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return deviceNamesKnown(await enumerate());
  } catch {
    return false;
  }
}

/**
 * The context the app's Web Audio comes out of.
 *
 * Module-level, like the metronome's context reference, because the choice has
 * to reach a graph that is built later and from somewhere else entirely — the
 * settings panel cannot hold `usePlayback`'s ref.
 */
let registered: AudioContext | null = null;

/**
 * Adopt the app's audio context, and point it wherever the setting says.
 *
 * Called by `ensureAudio` as the context is created, which is what applies a
 * remembered choice to a session that has only just made a sound. Pass null to
 * forget it.
 */
export function registerAudioContext(context: AudioContext | null): void {
  registered = context;
  if (!context) return;

  const chosen = loadOutputDevice();
  void aimWebAudio(chosen, context);
}

/** Point one context at the endpoint called `name`. Answers why not, or null. */
async function aimWebAudio(name: string | null, context: AudioContext): Promise<string | null> {
  const withSink = context as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (typeof withSink.setSinkId !== 'function') {
    return 'this browser cannot choose an output device';
  }

  let sinkId = SYSTEM_DEFAULT_SINK;
  if (name !== null) {
    const matched = matchDeviceId(name, await enumerate());
    if (matched === null) {
      return `could not find “${name}” among the devices this window can see`;
    }
    sinkId = matched;
  }

  try {
    await withSink.setSinkId(sinkId);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'the browser refused that device';
  }
}

/**
 * Send everything the app plays to the endpoint called `name`, or to the system
 * default when it is null.
 *
 * Both engines are moved and both outcomes reported, because either can fail on
 * its own: a device the webview cannot name is still perfectly openable by cpal,
 * and a device that cannot run at the session's sample rate is refused natively
 * while Web Audio resamples happily. Telling the user "it worked" when half of it
 * did would leave them hunting a fault that is already known.
 *
 * The choice is remembered whatever happens — an unplugged device is still what
 * the user wants once it is plugged back in.
 */
export async function applyOutputDevice(name: string | null): Promise<ApplyOutcome> {
  storeOutputDevice(name);

  const webAudio = registered ? await aimWebAudio(name, registered) : null;

  let native: string | null = null;
  if (isTauri()) {
    try {
      await invoke('vst3_set_output_device', { name });
    } catch (error) {
      native = typeof error === 'string' ? error : 'the plugin engine refused that device';
    }
  }

  return { webAudio, native };
}
