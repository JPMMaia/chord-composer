import React, { useCallback, useEffect, useState } from 'react';
import {
  applyOutputDevice,
  canAimWebAudio,
  listOutputDevices,
  loadOutputDevice,
  requestDeviceNames,
  type AudioOutputDevice,
} from '@/engine/audioOutput';
import {
  BUFFER_SIZES,
  HEADROOM_CHOICES,
  applyBufferSize,
  applyHeadroom,
  applyResetOnStop,
  bufferLatencyMs,
  loadAudioPrefs,
  readAudioHealth,
  type AudioHealth,
} from '@/engine/audioPrefs';
import {
  MIN_VELOCITY_MAX,
  TOUCH_MAX,
  TOUCH_MIN,
  applyMidiPrefs,
  getMidiPrefs,
  shapeVelocity,
  subscribeLastVelocity,
  type MidiPrefs,
} from '@/engine/midiPrefs';
import { isTauri } from '@/engine/platform';

const BUTTON_CLASS =
  'px-2 py-1 text-xs bg-gray-700 border border-gray-600 rounded text-gray-200 hover:bg-gray-600 focus:outline-none focus:border-indigo-500';

const FIELD_CLASS =
  'w-full px-2 py-1.5 text-sm bg-gray-700 border border-gray-600 rounded text-gray-200 focus:outline-none focus:border-indigo-500';

/** The option standing for "whatever the operating system is set to". */
const SYSTEM_DEFAULT = '';

/** The option standing for "whatever block size the device prefers". */
const DEVICE_DEFAULT = 'device';

/** How often the diagnostics tab re-reads the counters, in milliseconds. */
const HEALTH_INTERVAL_MS = 1000;

const TABS = ['Audio', 'Performance', 'MIDI', 'Diagnostics'] as const;
type Tab = (typeof TABS)[number];

/**
 * Everything about the machine rather than about the piece being written.
 *
 * A dialog rather than the dropdown this grew out of, because the questions it
 * answers need room to be asked properly. Choosing speakers is one line; choosing
 * a block size is a trade against latency, and knowing whether the one you chose
 * is big enough means watching a counter while something plays.
 *
 * Nothing here is written to the project file. A buffer size is a fact about this
 * computer, and a piece carried to another one should arrive with that computer's
 * answer rather than this one's.
 */
export const SettingsDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [tab, setTab] = useState<Tab>('Audio');

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
      data-testid="settings-dialog"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="w-full max-w-lg max-h-full overflow-y-auto bg-gray-800 border border-gray-700 rounded-lg shadow-xl p-4 space-y-3"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-200">Settings</h2>
          <button type="button" className={BUTTON_CLASS} onClick={onClose} aria-label="Close">
            Done
          </button>
        </div>

        <div role="tablist" aria-label="Settings sections" className="flex gap-1 border-b border-gray-700">
          {TABS.map(name => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={tab === name}
              onClick={() => setTab(name)}
              className={`px-3 py-1.5 text-xs rounded-t transition-colors ${
                tab === name
                  ? 'bg-gray-700 text-gray-100 border border-b-0 border-gray-600'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {name}
            </button>
          ))}
        </div>

        <div role="tabpanel" aria-label={tab} className="space-y-3">
          {tab === 'Audio' && <AudioTab />}
          {tab === 'Performance' && <PerformanceTab />}
          {tab === 'MIDI' && <MidiTab />}
          {tab === 'Diagnostics' && <DiagnosticsTab />}
        </div>
      </div>
    </div>
  );
};

/**
 * Where the sound comes out, and how big a bite of it the machine takes at once.
 *
 * The device picker is the panel this dialog replaced, moved across whole: the
 * two things a user cannot be expected to guess are still that naming devices
 * costs a permission, and that hosted plugins are a second engine being moved
 * along with the first.
 */
const AudioTab: React.FC = () => {
  const [devices, setDevices] = useState<AudioOutputDevice[]>([]);
  const [chosen, setChosen] = useState<string>(() => loadOutputDevice() ?? SYSTEM_DEFAULT);
  const [namesKnown, setNamesKnown] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  const [frames, setFrames] = useState<number | null>(() => loadAudioPrefs().bufferFrames);
  const [sampleRate, setSampleRate] = useState<number | null>(null);

  /** Re-read what the machine has. Cheap enough to do on every open. */
  const refresh = useCallback(async () => {
    const [found, aimable] = await Promise.all([listOutputDevices(), canAimWebAudio()]);
    setDevices(found);
    setNamesKnown(aimable);
  }, []);

  useEffect(() => {
    void refresh();
    // The session's rate, which is the device's own and cannot be chosen — it is
    // read rather than set because the latency a block size costs is meaningless
    // without it. Only a running engine knows it.
    void readAudioHealth().then(health => setSampleRate(health?.sampleRate ?? null));
  }, [refresh]);

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

  const chooseBuffer = async (value: string) => {
    const wanted = value === DEVICE_DEFAULT ? null : Number(value);
    setFrames(wanted);
    setBusy(true);
    try {
      const outcome = await applyBufferSize(wanted);
      setProblems(
        [outcome.error && `The block size did not change: ${outcome.error}.`, outcome.note].filter(
          (problem): problem is string => Boolean(problem)
        )
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
    <>
      <div>
        <label htmlFor="audio-output-device" className="block text-xs text-gray-400 mb-1">
          Output device
        </label>
        <select
          id="audio-output-device"
          value={chosen}
          disabled={busy}
          onChange={event => void choose(event.target.value)}
          className={FIELD_CLASS}
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

      {/* The permission is only worth asking for once a device other than the
          system default is wanted — following the system needs no name. */}
      {!namesKnown && (
        <div className="text-xs text-gray-400 space-y-2">
          <p>
            This window cannot see what the devices are called until a microphone permission
            is granted. Nothing is recorded — the permission is the only way a browser will
            name your speakers.
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

      {isTauri() && (
        <div>
          <label htmlFor="audio-buffer-size" className="block text-xs text-gray-400 mb-1">
            Block size
          </label>
          <select
            id="audio-buffer-size"
            value={frames === null ? DEVICE_DEFAULT : String(frames)}
            disabled={busy}
            onChange={event => void chooseBuffer(event.target.value)}
            className={FIELD_CLASS}
          >
            <option value={DEVICE_DEFAULT}>Device default</option>
            {BUFFER_SIZES.map(size => (
              <option key={size} value={size}>
                {size} frames
                {sampleRate ? ` (${bufferLatencyMs(size, sampleRate).toFixed(1)} ms)` : ''}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-gray-500">
            How much audio the plugins render at once. A bigger block gives a heavy
            instrument longer to render and leaves more already-rendered sound in front of
            the device, which is what stops a slow moment being heard as a click. It costs
            exactly that much delay between pressing a key and hearing it.
            {sampleRate ? ` This session runs at ${Math.round(sampleRate)} Hz.` : ''}
          </p>
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
          ? 'The device moves the built-in instruments and any hosted VST3 plugins. A plugin engine already running keeps playing through the change.'
          : 'Moves everything this page plays. Block size belongs to the desktop build, which is where plugins are hosted.'}
      </p>
    </>
  );
};

/**
 * What the machine spends on rendering, beyond the block size.
 *
 * The headroom is the lever that actually breaks the link between a slow block
 * and a click. A block's deadline is the time it takes to play, so rendering
 * inside the audio callback means one slow block is one gap; rendering ahead of
 * the device means a slow block spends slack instead. What still has to hold is
 * the average, and on the library this was built for the average is about a
 * quarter of what it has.
 */
const PerformanceTab: React.FC = () => {
  const [headroom, setHeadroom] = useState(() => loadAudioPrefs().headroomMs);
  const [resetOnStop, setResetOnStop] = useState(() => loadAudioPrefs().resetOnStop);
  const [busy, setBusy] = useState(false);

  const choose = async (ms: number) => {
    setHeadroom(ms);
    setBusy(true);
    try {
      await applyHeadroom(ms);
    } finally {
      setBusy(false);
    }
  };

  if (!isTauri()) {
    return (
      <p className="text-xs text-gray-500">
        Rendering belongs to the desktop build, which is where plugins are hosted.
      </p>
    );
  }

  return (
    <>
      <div>
        <label htmlFor="render-headroom" className="block text-xs text-gray-400 mb-1">
          Render ahead
        </label>
        <select
          id="render-headroom"
          value={String(headroom)}
          disabled={busy}
          onChange={event => void choose(Number(event.target.value))}
          className={FIELD_CLASS}
        >
          {HEADROOM_CHOICES.map(ms => (
            <option key={ms} value={ms}>
              {ms === 0 ? 'Off — render in the audio callback' : `${ms} ms ahead`}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-gray-500">
          How much finished audio is kept waiting in front of the device. With none, a
          single slow block is a gap you hear as a click. With some, that block spends
          the waiting audio instead, and is only heard if the plugins fall behind for
          longer than this. It costs the same delay again between pressing a key and
          hearing it — an instrument’s Nudge in the sidebar is what puts that back.
        </p>
      </div>

      <div className="border-t border-gray-700 pt-3">
        <label className="flex items-start gap-2 text-xs text-gray-300">
          <input
            type="checkbox"
            checked={resetOnStop}
            onChange={event => {
              setResetOnStop(event.target.checked);
              void applyResetOnStop(event.target.checked);
            }}
            className="mt-0.5 accent-indigo-500"
          />
          <span>Put instruments back when the transport stops</span>
        </label>
        <p className="mt-1 text-xs text-gray-500">
          Some sampled instruments get slower the longer they play, and no amount of
          buffer cures that — it only puts off the moment you hear it. This asks each
          plugin to return to the state it loaded in, a moment after you stop, which is
          the same thing as reloading the instrument by hand but without re-reading its
          samples. Pressing Play again straight away skips it, so Play is never held up.
        </p>
      </div>

      <div className="text-xs text-gray-400 space-y-2 border-t border-gray-700 pt-3">
        <p>
          Instruments are rendered one after another, on one thread. Spreading them
          across cores would help several heavy instruments at once; it would not make a
          single heavy one faster. If one instrument is what stalls — a detailed sampled
          library usually is — the levers that help are the setting above, the block size
          on the Audio tab, and that instrument’s own Roll and Gap in the sidebar.
        </p>
      </div>
    </>
  );
};

/**
 * How the keyboard's touch is read.
 *
 * The readout is the point of the tab: a curve is chosen by feel, so pressing a
 * key and seeing what it arrived at and what it became is what makes the slider
 * something other than a guess.
 */
const MidiTab: React.FC = () => {
  const [prefs, setPrefs] = useState<MidiPrefs>(() => getMidiPrefs());
  const [lastIn, setLastIn] = useState<number | null>(null);

  useEffect(() => subscribeLastVelocity(setLastIn), []);

  const change = (next: Partial<MidiPrefs>) => setPrefs(applyMidiPrefs(next));

  return (
    <>
      <div>
        <div className="flex items-center justify-between mb-1">
          <label htmlFor="midi-touch" className="block text-xs text-gray-400">
            Touch sensitivity
          </label>
          <button
            type="button"
            className={BUTTON_CLASS}
            disabled={prefs.touch === 0}
            onClick={() => change({ touch: 0 })}
          >
            Reset
          </button>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span>Hard</span>
          <input
            id="midi-touch"
            type="range"
            min={TOUCH_MIN}
            max={TOUCH_MAX}
            step={5}
            value={prefs.touch}
            onChange={event => change({ touch: Number(event.target.value) })}
            className="flex-1 accent-indigo-500"
          />
          <span>Light</span>
        </div>
      </div>

      <div>
        <label htmlFor="midi-min-velocity" className="block text-xs text-gray-400 mb-1">
          Minimum velocity
        </label>
        <input
          id="midi-min-velocity"
          type="number"
          min={0}
          max={MIN_VELOCITY_MAX}
          value={prefs.minVelocity}
          onChange={event => change({ minVelocity: Number(event.target.value) })}
          className={FIELD_CLASS}
        />
      </div>

      <div className="flex items-center gap-3">
        <VelocityCurve prefs={prefs} lastIn={lastIn} />
        <p className="text-xs text-gray-300 tabular-nums" role="status" aria-label="Last key">
          {lastIn === null
            ? 'Press a key to see its velocity.'
            : `Last key: in ${lastIn} → out ${shapeVelocity(lastIn, prefs)}`}
        </p>
      </div>

      <p className="text-xs text-gray-500">
        A lighter touch makes soft presses sound louder, so a keyboard that needs a heavy
        hand reaches the loud end sooner. A full-force press is still 127. It shapes what
        you hear and what gets recorded alike.
      </p>
    </>
  );
};

/** Size of the curve drawing, in pixels. */
const CURVE_SIZE = 96;

/** The curve against the straight line it bends, with the last key marked on it. */
const VelocityCurve: React.FC<{ prefs: MidiPrefs; lastIn: number | null }> = ({ prefs, lastIn }) => {
  const at = (velocity: number) => CURVE_SIZE - (velocity / 127) * CURVE_SIZE;
  const points = Array.from({ length: 33 }, (_, i) => {
    const velocity = (i / 32) * 127;
    return `${(velocity / 127) * CURVE_SIZE},${at(shapeVelocity(velocity, prefs))}`;
  }).join(' ');

  return (
    <svg
      width={CURVE_SIZE}
      height={CURVE_SIZE}
      viewBox={`0 0 ${CURVE_SIZE} ${CURVE_SIZE}`}
      className="shrink-0 bg-gray-900 border border-gray-700 rounded"
      aria-hidden="true"
    >
      <line x1={0} y1={CURVE_SIZE} x2={CURVE_SIZE} y2={0} className="stroke-gray-600" strokeDasharray="3 3" />
      <polyline points={points} fill="none" className="stroke-indigo-400" strokeWidth={2} />
      {lastIn !== null && (
        <circle
          cx={(lastIn / 127) * CURVE_SIZE}
          cy={at(shapeVelocity(lastIn, prefs))}
          r={3}
          className="fill-amber-400"
        />
      )}
    </svg>
  );
};

/**
 * Whether the machine is keeping up, and what to do about it when it is not.
 *
 * The numbers are read on a timer and are destructive on the Rust side, so each
 * reading is the second just gone rather than a total since launch. That is the
 * reading that matters: the question is whether it is dropping out *now*, while
 * the part that crackles is playing.
 */
const DiagnosticsTab: React.FC = () => {
  const [health, setHealth] = useState<AudioHealth | null>(null);
  const [everRead, setEverRead] = useState(false);

  useEffect(() => {
    let live = true;
    const read = () => {
      void readAudioHealth().then(next => {
        if (!live) return;
        setHealth(next);
        setEverRead(true);
      });
    };

    read();
    const timer = window.setInterval(read, HEALTH_INTERVAL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="space-y-3">
      {health ? (
        <table className="w-full text-xs text-gray-300">
          <tbody>
            <Row
              label="Late blocks"
              value={String(health.late)}
              warn={health.late > 0}
              hint="Blocks that took longer to render than they take to play. Every one of these is a gap in the sound."
            />
            <Row
              label="Worst block"
              value={`${(health.worstUs / 1000).toFixed(1)} ms`}
              hint="The slowest single block in the last second."
            />
            <Row
              label="Load"
              value={`${Math.round(health.load * 100)}%`}
              warn={health.load > 0.7}
              hint="Render time against the time that audio plays for. Anything near 100% has no room left."
            />
            <Row
              label="Block"
              value={`${health.block} frames`}
              hint="What the device actually asked for, which may not be what was chosen."
            />
            <Row label="Sample rate" value={`${Math.round(health.sampleRate)} Hz`} />
          </tbody>
        </table>
      ) : (
        <p className="text-xs text-gray-500">
          {everRead
            ? 'No plugin engine is running. Load a VST3 instrument and these will fill in.'
            : 'Reading…'}
        </p>
      )}

      <div className="text-xs text-gray-400 space-y-2 border-t border-gray-700 pt-3">
        <p className="text-gray-300">If a sampled library crackles</p>
        <p>
          The click is almost never the sound itself. It is a block that took longer to
          render than it had, so the device ran dry — which is why it lands at the moment
          notes start and stop, where the work is.
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li>Raise the block size on the Audio tab, and watch Late blocks here.</li>
          <li>
            Give the instrument a few milliseconds of Roll and Gap in the sidebar, so a
            chord is not four attacks inside one block.
          </li>
          <li>
            In the plugin itself: purge microphone positions and extra layers you are not
            using, and turn off anything that doubles the notes per key — an octave
            doubler costs twice the voices.
          </li>
          <li>Keep the sample library on a fast SSD. Every one of these manuals says so first.</li>
        </ul>
      </div>
    </div>
  );
};

/** One reading, with the sentence that says what it means. */
const Row: React.FC<{ label: string; value: string; warn?: boolean; hint?: string }> = ({
  label,
  value,
  warn,
  hint,
}) => (
  <tr title={hint}>
    <th scope="row" className="text-left font-normal text-gray-400 py-0.5">
      {label}
    </th>
    <td className={`text-right tabular-nums py-0.5 ${warn ? 'text-amber-400' : 'text-gray-200'}`}>
      {value}
    </td>
  </tr>
);
