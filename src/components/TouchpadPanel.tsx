import React from 'react';
import { projectStore } from '@/store/projectStore';
import { useTouchpad } from '@/context/touchpadContext';
import { MAX_CC } from '@/engine/parameterAutomation';
import type { Vst3CcInfo } from '@/engine/vst3Cc';
import type { Track } from '@/types/music';

interface TouchpadPanelProps {
  /** The instrument the touchpad performs on. The assignment is stored on it. */
  track: Track;
  /** What the plugin maps, from `useVst3Cc`. Empty where there is no plugin to ask. */
  supported: Vst3CcInfo[];
  /** The controller the strip is offering, used as the field's starting number. */
  suggested: number | null;
}

/**
 * Point the touchpad at a controller, and perform it.
 *
 * The third way to get a curve, beside the two beside it: played rather than drawn. A
 * glissando is a gesture — a finger sweeping up and down — and drawing one breakpoint
 * at a time is a poor imitation of making it, however good it is at correcting it
 * afterwards.
 *
 * The assignment is per instrument, and is why this is a field rather than a button:
 * a harp's glissando is CC 11, a string library's dynamics are CC 1, and the finger
 * should follow whichever instrument is selected without anything being rebound.
 *
 * **CC 11 has to be typeable here.** `nextFreeCc` will never *offer* expression — 11
 * is in `vst3Cc`'s reserved list, deliberately, because the MIDI exporter already
 * writes volume and the spec has spoken for it — but a library whose control is bound
 * to 11 is exactly the case this panel exists for, and the field takes any number the
 * plugin will answer to.
 */
export const TouchpadPanel: React.FC<TouchpadPanelProps> = ({
  track,
  supported,
  suggested,
}) => {
  const setTouchpadTarget = projectStore(s => s.setTrackTouchpadTarget);
  const touchpad = useTouchpad();

  const assigned = track.touchpadTarget;

  /**
   * The number in the field.
   *
   * Seeded from what is already assigned, and from the strip's suggestion only when
   * nothing is — an assignment is a decision the user made, and must not be quietly
   * moved on as lanes are added the way `AddCcLane`'s suggestion is.
   */
  const [controller, setController] = React.useState<number | null>(
    assigned?.kind === 'cc' ? assigned.controller : suggested
  );

  // Follow the assignment when it changes underneath — selecting another instrument
  // re-renders this same panel with a different track's target.
  const assignedCc = assigned?.kind === 'cc' ? assigned.controller : null;
  React.useEffect(() => {
    if (assignedCc !== null) setController(assignedCc);
  }, [assignedCc, track.id]);

  const valid = controller !== null && controller >= 0 && controller <= MAX_CC;
  const active = valid && assignedCc === controller;

  /**
   * Whether the plugin will actually answer to this controller.
   *
   * Worth saying out loud: an unmapped controller resolves to no `ParamID` natively,
   * and every send is then dropped in silence — which looks exactly like a broken
   * touchpad. Only checked where there is a mapping to check against; a plugin with no
   * `IMidiMapping`, and a General MIDI sound, report nothing either way.
   */
  const unmapped =
    valid && supported.length > 0 && !supported.some(cc => cc.controller === controller);

  const performing = touchpad?.performing === true;

  return (
    <div className="flex items-center gap-2 min-w-0 text-[11px]">
      <span className="text-gray-400 shrink-0">Touchpad</span>

      <label className="text-gray-500 shrink-0" htmlFor={`touchpad-cc-${track.id}`}>
        CC
      </label>
      <input
        id={`touchpad-cc-${track.id}`}
        type="number"
        min={0}
        max={MAX_CC}
        aria-label="Controller the touchpad performs"
        value={controller ?? ''}
        onChange={e => {
          const next = Number(e.target.value);
          setController(e.target.value === '' || !Number.isFinite(next) ? null : next);
        }}
        // Or the timeline's shortcuts would read the digits as commands — and `g`
        // would start a gesture instead of being typed.
        onKeyDown={e => e.stopPropagation()}
        className="w-14 shrink-0 bg-gray-700 border border-gray-600 rounded text-gray-300 px-1 py-0.5 focus:outline-none focus:border-indigo-500"
      />

      <button
        type="button"
        disabled={!valid}
        title={
          active
            ? 'Stop the touchpad driving this instrument'
            : 'Let the touchpad drive this controller on this instrument'
        }
        onClick={() =>
          setTouchpadTarget(
            track.id,
            active || !valid ? null : { kind: 'cc', controller }
          )
        }
        className={`shrink-0 px-2 py-0.5 rounded transition-colors disabled:bg-gray-800 disabled:text-gray-600 ${
          active
            ? 'bg-indigo-600 text-white hover:bg-indigo-500'
            : 'bg-gray-700 text-gray-200 hover:bg-gray-600'
        }`}
      >
        {active ? 'Assigned' : 'Assign'}
      </button>

      {/* Held rather than clicked: the value follows the finger for as long as the
          gesture lasts, and a click would have nothing to hold. The button is here for
          the same reason a play button is, next to the spacebar that does it — and it
          is the one place the live value can be read once the cursor is gone.
          The release is the hook's to catch, not this button's: once the lock is taken
          every mouse event targets the locked element, so no `pointerup` ever reaches
          here. */}
      <button
        type="button"
        disabled={!assigned}
        onPointerDown={e => {
          // Or the press would move focus and the lock would be requested against a
          // button that is about to lose it.
          e.preventDefault();
          touchpad?.begin(true);
        }}
        title={
          assigned
            ? 'Hold G, or hold this, and move the touchpad up and down'
            : 'Assign a controller first'
        }
        className={`shrink-0 px-2 py-0.5 rounded transition-colors disabled:bg-gray-800 disabled:text-gray-600 ${
          performing
            ? 'bg-emerald-600 text-white'
            : 'bg-gray-700 text-gray-200 hover:bg-gray-600'
        }`}
      >
        {performing ? `Perform ${touchpad?.controllerValue ?? 0}` : 'Perform (G)'}
      </button>

      {unmapped && (
        <span className="text-amber-400 truncate" role="status">
          This plugin does not accept that controller — learn it first.
        </span>
      )}
    </div>
  );
};
