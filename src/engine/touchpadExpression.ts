import type { AutomationPoint } from '@/types/music';

/**
 * A touchpad, read as an expression strip.
 *
 * Deliberately narrow in the spirit of `@/engine/midiInput`: this module turns a
 * stream of vertical pointer movements into values between 0 and 1 and says nothing
 * about what should happen to them. No React, no Tauri, no DOM — which is what lets
 * the whole of the gesture's arithmetic be tested without a touchpad, and what would
 * let a native raw-input backend replace the pointer-lock half without anything
 * downstream noticing.
 *
 * There is no touchpad API in a webview. What a laptop touchpad *is*, to this code,
 * is a mouse reporting relative motion — so the gesture is built out of deltas rather
 * than out of a position, and the value it carries has to be held here rather than
 * read back off the pointer.
 */

/**
 * Vertical travel, in pixels, that sweeps the whole 0-1 range.
 *
 * Roughly the height of a laptop touchpad in reported pixels, so one unhurried finger
 * stroke from the bottom edge to the top is one full sweep of the controller — which
 * is the gesture a glissando actually is. Smaller would make the control twitchy at
 * the resolution a plugin can resolve; larger would need the finger lifted and
 * re-planted mid-phrase, and every re-plant is a discontinuity you can hear.
 */
export const FULL_THROW_PX = 320;

/**
 * `value` moved by one pointer-lock `movementY`, clamped to 0-1.
 *
 * Up increases. `movementY` counts downward — it is a screen axis — so the sign is
 * flipped here, once, rather than at every call site: a finger moving toward the top
 * of the touchpad should raise the controller, the way every fader in the app is
 * drawn with 1 at the top.
 *
 * A non-finite delta leaves the value alone rather than poisoning it. Pointer lock
 * can report one across a device switch, and a NaN here would be latched forever —
 * the value is accumulated, so there is nothing later that would wash it out.
 */
export function applyMovement(
  value: number,
  movementY: number,
  throwPx: number = FULL_THROW_PX
): number {
  if (!Number.isFinite(movementY) || !Number.isFinite(value)) return clamp01(value);
  if (!Number.isFinite(throwPx) || throwPx <= 0) return clamp01(value);

  return clamp01(value - movementY / throwPx);
}

/** Held to 0-1, and to 0 for anything that is not a number at all. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * The value as a controller number, 0-127.
 *
 * Never what is *sent* — a target travels to the plugin normalised, because that is
 * the range VST3 works in and the range a curve is stored in. It is what the Perform
 * button shows, since a player setting a harp's glissando to "about 90" is thinking in
 * controller numbers; and it is how the thinning below decides two samples say the
 * same thing, because a controller is a 7-bit value and a difference the rounding
 * erases is a difference the plugin could not have heard. Comparing the rounded
 * numbers rather than the floats also settles the boundary exactly: two values one
 * step apart differ here, where subtracting them and testing against 1/127 is at the
 * mercy of which way the last bit fell.
 */
export function toControllerValue(value: number): number {
  return Math.round(clamp01(value) * 127);
}

/**
 * The value snapped to the controller step it rounds to, still normalised 0-1.
 *
 * What a `cc:` curve is *sent* as. A controller is a 7-bit value, so a normalised
 * value between two steps names a position no controller could ever have been in —
 * and the plugin resolving it back to a controller number will round it to one of
 * the two neighbours anyway. Snapping first makes the difference explicit rather
 * than leaving it to the plugin, and makes a sampled curve send exactly the run of
 * values the same gesture played by hand would: each step once, in order, at the
 * moment the curve crosses it.
 *
 * That matters for an instrument that *acts* on controller movement rather than
 * merely reading it — a harp's glissando plays a string per step — where a curve
 * dithering below a step is movement the plugin can hear and the ear cannot.
 */
export function toControllerStep(value: number): number {
  return toControllerValue(value) / 127;
}

/**
 * Whether a sample is worth storing in a lane, given the last one that was kept.
 *
 * A gesture is sampled at whatever rate the pointer reports — 60 to 1000 a second on
 * a precision touchpad — and a finger held still would otherwise fill the lane with
 * hundreds of identical breakpoints, each one a point the user can grab, drag and
 * has to delete.
 *
 * Three ways to earn a place: being the first sample of the gesture, landing on a
 * different controller step from the last one kept, or being far enough along that the
 * curve would otherwise flatten a slow drift into a single straight line. The last is
 * why this is not simply a change threshold — a sweep played slowly enough is a run of
 * sub-step samples, and dropping all of them would store the gesture as nothing.
 *
 * @param minBeatGap - How long a run of unchanged samples may go unrecorded, in beats.
 */
export function worthKeeping(
  sample: AutomationPoint,
  lastKept: AutomationPoint | null,
  minBeatGap: number
): boolean {
  if (!lastKept) return true;
  if (toControllerValue(sample.value) !== toControllerValue(lastKept.value)) return true;
  return sample.beat - lastKept.beat >= minBeatGap;
}

/**
 * `samples` thinned, in order, against a running "last kept".
 *
 * The batch form of `worthKeeping`, and the one the recorder actually calls: samples
 * arrive buffered between flushes, and thinning them one at a time against a caller-held
 * cursor would put the cursor's bookkeeping in the hook rather than here.
 *
 * `last` is the point kept by the *previous* flush, so the thinning does not restart —
 * and forget what the curve was already doing — at every flush boundary.
 */
export function thin(
  samples: AutomationPoint[],
  last: AutomationPoint | null,
  minBeatGap: number
): AutomationPoint[] {
  const kept: AutomationPoint[] = [];
  let cursor = last;

  for (const sample of samples) {
    if (!worthKeeping(sample, cursor, minBeatGap)) continue;
    kept.push(sample);
    cursor = sample;
  }

  return kept;
}
