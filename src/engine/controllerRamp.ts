import { toControllerValue } from '@/engine/touchpadExpression';

/**
 * Walking a controller from one value to another one step at a time.
 *
 * A sampled curve states a value every `PARAM_GRID_SECONDS` and lets the plugin
 * hold it in between, which is all a parameter *read* by a plugin needs: a filter
 * cutoff that arrives in four jumps sounds like a filter sweep. An instrument that
 * *acts* on controller movement is a different thing. A harp's glissando plucks a
 * string per controller step, so a curve that climbs twenty steps between two
 * samples does not play a fast run — it plays twenty strings on the same sample,
 * which is a crack rather than a glissando. The same is true of any sampler
 * crossfading zones on a controller: a jump crossfades instantly, and an instant
 * crossfade is a click.
 *
 * Nothing about the curve is wrong in that case; what is wrong is that the values
 * *sent* skip. So a jump is expanded into the run of values a hand would have
 * moved through — a straight line from where the controller was to where it is
 * going, one step at a time — and the plugin hears movement rather than a leap.
 * This is also what a MIDI timeline in any DAW delivers, because a controller lane
 * there is a stream of single-step events rather than a curve to be sampled.
 *
 * Two limits keep the line from becoming a flood:
 *
 * - `MIN_STEP_SECONDS` is how close together two values may be sent. Reached
 *   only by a genuinely near-vertical edge, and then the line walks in the
 *   smallest increments that fit rather than refusing to smooth the jump at all.
 * - `MAX_RAMP_SECONDS` is how far back the line may begin. A jump after a long
 *   flat stretch has an arbitrary amount of empty time behind it, and drawing the
 *   line across all of it would put its first half in the past.
 *
 * Both are generous against what a smooth curve actually asks for. A glissando
 * sweeping the full controller range over a second moves 1.3 steps per sample, so
 * the line is one or two points long and this module changes almost nothing. It
 * earns its place on the steep edges: a vertical one drawn by hand, the seam where
 * a loop comes round to a curve that opens somewhere else, and the boundary
 * between two placements whose curves end and start at different levels.
 */

/** One value to send, and the moment on the instrument's clock to send it at. */
export interface RampPoint {
  value: number;
  when: number;
}

/**
 * The closest two sent values may be in time.
 *
 * A millisecond is a thousand controller values a second, which is what a MIDI
 * cable carries at its limit and what a plugin's own MIDI input is built to take.
 * It also bounds what one block can be handed: at 48 kHz a 480-frame block spans
 * ten milliseconds, so no more than ten of these can land in one, well under the
 * point limit of a VST3 parameter queue.
 */
export const MIN_STEP_SECONDS = 0.001;

/**
 * How long the straight line drawn across a jump may be.
 *
 * Fifty milliseconds is long enough that even a full-range jump moves less than
 * three controller steps at a time, and short enough that the line is heard as
 * the movement it replaces rather than as a slur. It is also what bounds the
 * lateness of the points: they are placed inside a look-ahead window a few
 * hundred milliseconds wide, so a line beginning fifty milliseconds before the
 * value was due is still comfortably in the future.
 */
export const MAX_RAMP_SECONDS = 0.05;

/**
 * The values to send so the controller arrives at `to` by `when` without skipping.
 *
 * Always ends with `to` at exactly `when`: the line is a way of getting there, not
 * a different destination, so a curve smoothed this way still states the value the
 * curve states at the moment it states it.
 *
 * A single point is the answer whenever there is no line to draw: the values are
 * already neighbours, or the two moments are the same one. That is also what
 * makes this safe to route every emission through rather than only the ones known
 * to jump.
 *
 * @param from - Where the controller is now, normalised 0-1.
 * @param to - Where it is going, normalised 0-1.
 * @param fromWhen - When `from` was sent, on the instrument's clock. Non-finite
 *   for a curve that has only ever been pinned, which is a moment that is known
 *   to have passed rather than an unknown value — so the line simply takes its
 *   full length. The first move after a Play is a jump like any other, and on a
 *   curve that opens somewhere far from where the plugin was sitting it is the
 *   biggest one there is.
 * @param when - When `to` is due.
 */
export function rampPoints(
  from: number,
  to: number,
  fromWhen: number,
  when: number
): RampPoint[] {
  const arrival = [{ value: to, when }];

  const fromStep = toControllerValue(from);
  const toStep = toControllerValue(to);
  const distance = Math.abs(toStep - fromStep);

  // Neighbours already, so there is nothing to walk through. Also the answer for
  // a value that has not moved at all, which a caller filtering on the snapped
  // value will never ask about but a caller routing everything through here will.
  if (distance <= 1) return arrival;

  // Where the line begins: at the last value sent, or a full line back for a
  // curve with no sent value behind it.
  const earliest = when - MAX_RAMP_SECONDS;
  const start = Number.isFinite(fromWhen) ? Math.max(fromWhen, earliest) : earliest;

  // No room to draw in — two values due at the same moment, or one already past.
  // A jump is still better than nothing sent, since leaving the curve behind
  // where it should be is a fault of its own.
  if (start >= when) return arrival;

  const span = when - start;

  // As many steps as the rate allows, and never more than there are steps to
  // take. `floor` rather than `round` so the spacing can only come out at or
  // above the minimum — with a nudge, because a span that is an exact multiple of
  // the minimum in decimal is a hair under it in binary, and would otherwise lose
  // its last point to the rounding.
  const count = Math.min(
    distance,
    Math.max(1, Math.floor(span / MIN_STEP_SECONDS + 1e-9))
  );

  const points: RampPoint[] = [];
  for (let i = 1; i < count; i++) {
    // Rounded to a whole controller step, then back to the normalised range every
    // target is driven in. With `count` at most `distance` the increment is never
    // below one step, so these are strictly increasing and no two of them say the
    // same thing.
    const step = Math.round(fromStep + ((toStep - fromStep) * i) / count);
    points.push({ value: step / 127, when: start + (span * i) / count });
  }

  // Stated rather than computed, so the arrival is exact whichever way the
  // arithmetic above rounded.
  points.push(arrival[0]);
  return points;
}
