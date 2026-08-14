import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { MAX_CC } from '@/engine/parameterAutomation';
import type { Vst3CcInfo } from '@/engine/vst3Cc';

interface LearnCcPanelProps {
  trackId: string;
  /** What the plugin maps. The panel is not rendered when this is empty. */
  supported: Vst3CcInfo[];
  /** The controller to offer, or null when every mapped one already has a lane. */
  suggested: number | null;
  /** Add the lane once the plugin has been sent the controller. */
  onLearned: (controller: number) => void;
}

/**
 * Teach a plugin's own MIDI learn which controller to bind a control to.
 *
 * A sampler like Kontakt publishes its host-automation slots under a single
 * meaningless name, so picking one from a list is guesswork. Its answer is MIDI
 * learn: arm a control, move a controller, and the plugin binds the two. That
 * normally needs hardware — this panel is the app standing in for the knob.
 *
 * The order is the whole reason this is a panel and not a button. The plugin has
 * to be armed *before* anything is sent, so the step that comes first is stated
 * on screen rather than left to be guessed at.
 *
 * It reads across rather than down. Its first home was the timeline gutter,
 * which is only as wide as the piano roll's key column — every line wrapped to
 * one or two words, and the Send button spilled out under the lanes where the
 * scroll container swallowed its clicks.
 */
export function LearnCcPanel({
  trackId,
  supported,
  suggested,
  onLearned,
}: LearnCcPanelProps) {
  const [controller, setController] = useState<number | null>(suggested);
  const [error, setError] = useState<string | null>(null);

  // Follows the suggestion as lanes are added, but only while the user has not
  // typed a number of their own — a field that rewrote itself under the cursor
  // would be unusable.
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setController(suggested);
  }, [suggested, touched]);

  const mapped = controller !== null && supported.some(cc => cc.controller === controller);

  const send = () => {
    if (controller === null) return;
    setError(null);

    invoke('vst3_learn_cc', { trackId, controller })
      .then(() => onLearned(controller))
      .catch(err => {
        // Shown rather than logged: a silent failure here is indistinguishable
        // from a plugin that was never armed, which is the one thing the user
        // needs to be able to tell apart.
        setError(String(err));
      });
  };

  return (
    <div className="flex items-center gap-2 min-w-0 text-[11px]">
      <span className="text-gray-400 shrink-0">MIDI CC</span>

      {/* The arming step, stated once and briefly. It has to happen first, and
          it happens in the plugin's own window, not here. */}
      <span className="text-gray-500 truncate">
        Arm a control in the plugin, then send:
      </span>

      <label className="text-gray-500 shrink-0" htmlFor={`cc-${trackId}`}>
        CC
      </label>
      <input
        id={`cc-${trackId}`}
        type="number"
        min={0}
        max={MAX_CC}
        aria-label="Controller number to learn"
        value={controller ?? ''}
        onChange={e => {
          setTouched(true);
          const next = Number(e.target.value);
          setController(Number.isFinite(next) ? next : null);
        }}
        // Or the timeline's shortcuts would read the digits as commands.
        onKeyDown={e => e.stopPropagation()}
        className="w-14 shrink-0 bg-gray-700 border border-gray-600 rounded text-gray-300 px-1 py-0.5 focus:outline-none focus:border-indigo-500"
      />
      <button
        type="button"
        disabled={!mapped}
        title={
          mapped
            ? 'Wiggle this controller so the armed control binds to it'
            : 'This plugin does not accept that controller'
        }
        onClick={send}
        className="shrink-0 px-2 py-0.5 rounded bg-indigo-600 text-white hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 transition-colors"
      >
        Send
      </button>

      {error && <span className="text-red-400 truncate">{error}</span>}
    </div>
  );
}
