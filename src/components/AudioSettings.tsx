import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  applyOutputDevice,
  canAimWebAudio,
  listOutputDevices,
  loadOutputDevice,
  requestDeviceNames,
  type AudioOutputDevice,
} from '@/engine/audioOutput';
import { isTauri } from '@/engine/platform';

/** The option standing for "whatever the operating system is set to". */
const SYSTEM_DEFAULT = '';

/**
 * Where the app's sound comes out.
 *
 * A panel rather than a control in the transport bar: choosing speakers is done
 * once and then forgotten, and it needs room to explain the two things a user
 * cannot be expected to guess — that naming devices costs a permission, and that
 * hosted plugins are a second engine being moved along with the first.
 *
 * Opened from the top bar, beside the file menu, because it is a property of the
 * machine and not of the piece being written.
 */
export const AudioSettings: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<AudioOutputDevice[]>([]);
  const [chosen, setChosen] = useState<string>(() => loadOutputDevice() ?? SYSTEM_DEFAULT);
  const [namesKnown, setNamesKnown] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);

  /** Re-read what the machine has. Cheap enough to do on every open. */
  const refresh = useCallback(async () => {
    const [found, aimable] = await Promise.all([listOutputDevices(), canAimWebAudio()]);
    setDevices(found);
    setNamesKnown(aimable);
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  /** Close on a click outside, the way the file menu does. */
  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const choose = async (name: string) => {
    setChosen(name);
    setBusy(true);
    try {
      const outcome = await applyOutputDevice(name === SYSTEM_DEFAULT ? null : name);
      setProblems(
        [
          outcome.webAudio && `The built-in instruments did not move: ${outcome.webAudio}.`,
          outcome.native && `The plugins did not move: ${outcome.native}.`,
        ].filter((problem): problem is string => Boolean(problem))
      );
    } finally {
      setBusy(false);
    }
  };

  /** Grant the permission, then re-apply the choice now that it can be aimed. */
  const unlockNames = async () => {
    setBusy(true);
    try {
      const granted = await requestDeviceNames();
      setNamesKnown(granted);
      if (!granted) {
        setProblems(['Without that permission the built-in instruments cannot be moved.']);
        return;
      }
    } finally {
      setBusy(false);
    }
    await refresh();
    await choose(chosen);
  };

  return (
    <div className="relative" ref={panelRef} data-testid="audio-settings">
      <button
        onClick={() => setOpen(o => !o)}
        aria-label="Audio settings"
        aria-expanded={open}
        title="Choose which speakers the app plays through"
        className="px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 text-gray-200 rounded transition-colors"
      >
        🔊 Audio
      </button>

      {open && (
        <div className="absolute left-0 z-20 mt-1 w-80 p-3 space-y-3 bg-gray-800 border border-gray-700 rounded shadow-lg">
          <div>
            <label htmlFor="audio-output-device" className="block text-xs text-gray-400 mb-1">
              Output device
            </label>
            <select
              id="audio-output-device"
              value={chosen}
              disabled={busy}
              onChange={event => void choose(event.target.value)}
              className="w-full px-2 py-1.5 text-sm bg-gray-700 border border-gray-600 rounded text-gray-200 focus:outline-none focus:border-indigo-500"
            >
              <option value={SYSTEM_DEFAULT}>System default</option>
              {devices.map(device => (
                <option key={device.name} value={device.name}>
                  {device.name}
                  {device.isDefault ? ' (system default)' : ''}
                </option>
              ))}
            </select>
          </div>

          {/* The permission is only worth asking for once a device other than
              the system default is wanted — following the system needs no name. */}
          {!namesKnown && (
            <div className="text-xs text-gray-400 space-y-2">
              <p>
                This window cannot see what the devices are called until a microphone
                permission is granted. Nothing is recorded — the permission is the only
                way a browser will name your speakers.
              </p>
              <button
                onClick={() => void unlockNames()}
                disabled={busy}
                className="px-2 py-1 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded transition-colors disabled:opacity-50"
              >
                Show device names
              </button>
            </div>
          )}

          {problems.length > 0 && (
            <div className="text-xs text-amber-400 space-y-1" role="status">
              {problems.map(problem => (
                <p key={problem}>{problem}</p>
              ))}
            </div>
          )}

          <p className="text-xs text-gray-500">
            {isTauri()
              ? 'Moves the built-in instruments and any hosted VST3 plugins. A plugin engine already running keeps playing through the change.'
              : 'Moves everything this page plays.'}
          </p>
        </div>
      )}
    </div>
  );
};
