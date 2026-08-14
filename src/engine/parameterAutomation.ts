import type { AutomationPoint, AutomationTarget, ParameterAutomation } from '@/types/music';
import { normalizePoints } from '@/engine/volumeAutomation';

/**
 * A track's plugin curves, as a list of lanes.
 *
 * Kept free of React and Web Audio in the spirit of `@/engine/volumeAutomation`
 * and `@/engine/sections`, and deliberately thin: everything that happens
 * *within* a lane is `normalizePoints`' job, already written and already tested.
 * All this module owns is the list — which targets have a curve, in what order,
 * and with no two lanes claiming the same one.
 *
 * `normalizeParameterAutomation` is the single gate every stored list passes
 * through, so nothing downstream has to defend against an unsorted, duplicated
 * or malformed array.
 */

/**
 * A lane's identity in the timeline's stack, and in the scheduler's cursor map.
 *
 * Two things need to tell one instrument's lanes apart — which point is selected,
 * and how far through each curve playback has got — and both want one opaque
 * string rather than a shape to destructure. Volume is in here too, even though
 * it lives on a different field, because the stack shows it as the first lane and
 * nothing downstream should have to special-case it.
 */
export const VOLUME_LANE_KEY = 'volume';

/** The lane key for a curve's target: `param:12`, `cc:20`. */
export function laneKey(target: AutomationTarget): string {
  return target.kind === 'param' ? `param:${target.paramId}` : `cc:${target.controller}`;
}

/** The highest MIDI controller number. Controllers are a 7-bit value. */
export const MAX_CC = 127;

/** Whether a value off a file or the UI names something a plugin could be sent. */
function isTarget(target: unknown): target is AutomationTarget {
  if (typeof target !== 'object' || target === null) return false;

  const candidate = target as AutomationTarget;
  if (candidate.kind === 'param') {
    // A VST3 `ParamID` is an unsigned 32-bit integer.
    return Number.isInteger(candidate.paramId) && candidate.paramId >= 0;
  }
  if (candidate.kind === 'cc') {
    return (
      Number.isInteger(candidate.controller) &&
      candidate.controller >= 0 &&
      candidate.controller <= MAX_CC
    );
  }
  return false;
}

/** Whether a value off a file or the UI can be read as a lane. */
function isLane(lane: unknown): lane is ParameterAutomation {
  if (typeof lane !== 'object' || lane === null) return false;
  return isTarget((lane as ParameterAutomation).target);
}

export interface NormalizeOptions {
  /**
   * Drop lanes left with no points.
   *
   * False while editing, because a lane just added has no points yet and must
   * survive until one is drawn on it. True on load, where an empty lane is a
   * curve that drives nothing rather than a gesture in progress.
   */
  dropEmpty?: boolean;
}

/**
 * Sorted by lane key, deduped, and stripped of anything unusable.
 *
 * A duplicated target resolves to the *later* lane, which is the rule
 * `normalizePoints` already applies to a duplicated beat. Sorting by key rather
 * than by id keeps parameters and controllers in stable, separate runs.
 */
export function normalizeParameterAutomation(
  lanes: ParameterAutomation[],
  { dropEmpty = false }: NormalizeOptions = {}
): ParameterAutomation[] {
  if (!Array.isArray(lanes)) return [];

  const byKey = new Map<string, ParameterAutomation>();
  for (const lane of lanes) {
    if (!isLane(lane)) continue;

    byKey.set(laneKey(lane.target), {
      // Rebuilt rather than spread, so a lane off a file carries no key the rest
      // of the app has never heard of.
      target:
        lane.target.kind === 'param'
          ? { kind: 'param', paramId: lane.target.paramId }
          : { kind: 'cc', controller: lane.target.controller },
      name: typeof lane.name === 'string' ? lane.name : '',
      points: normalizePoints(lane.points ?? []),
    });
  }

  return [...byKey.values()]
    .filter(lane => !dropEmpty || lane.points.length > 0)
    .sort((a, b) => laneKey(a.target).localeCompare(laneKey(b.target)));
}

/** The lane with that key, or null when nothing has one. */
export function laneFor(
  lanes: ParameterAutomation[],
  key: string
): ParameterAutomation | null {
  return lanes.find(lane => laneKey(lane.target) === key) ?? null;
}

/**
 * `lanes` with one added.
 *
 * A target that already has a lane keeps it, curve and all: adding a lane is how
 * you start drawing on a target, and doing it twice must not be how you silently
 * erase what is already there.
 */
export function withLane(
  lanes: ParameterAutomation[],
  lane: ParameterAutomation
): ParameterAutomation[] {
  if (laneFor(lanes, laneKey(lane.target))) return lanes;
  return normalizeParameterAutomation([...lanes, lane]);
}

/** `lanes` without the one with that key. A key with no lane is a no-op. */
export function withoutLane(
  lanes: ParameterAutomation[],
  key: string
): ParameterAutomation[] {
  if (!laneFor(lanes, key)) return lanes;
  return lanes.filter(lane => laneKey(lane.target) !== key);
}

/**
 * `lanes` with one lane's points replaced by `edit`'s result.
 *
 * The single way a curve is changed, so that every edit is normalized on the way
 * back in and the neighbouring lanes are provably left alone.
 */
export function withLanePoints(
  lanes: ParameterAutomation[],
  key: string,
  edit: (points: AutomationPoint[]) => AutomationPoint[]
): ParameterAutomation[] {
  if (!laneFor(lanes, key)) return lanes;

  return lanes.map(lane =>
    laneKey(lane.target) === key
      ? { ...lane, points: normalizePoints(edit(lane.points)) }
      : lane
  );
}

/** `lanes` with one lane renamed. An empty name is refused, not stored. */
export function withLaneName(
  lanes: ParameterAutomation[],
  key: string,
  name: string
): ParameterAutomation[] {
  const trimmed = name.trim();
  if (!trimmed || !laneFor(lanes, key)) return lanes;

  return lanes.map(lane =>
    laneKey(lane.target) === key ? { ...lane, name: trimmed } : lane
  );
}
