import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@/engine/platform';
import { MAX_CC } from '@/engine/parameterAutomation';

/**
 * The MIDI controllers a loaded VST3 plugin will accept.
 *
 * The `vst3Params.ts` of controllers, memoised the same way and for the same
 * reason. What makes it a separate list is that a plugin publishes its
 * controllers through a different interface — `IMidiMapping` rather than its
 * parameter list — and normally flags the parameters they resolve to hidden, so
 * the two barely overlap.
 *
 * This exists because a plugin's parameter names are not always usable. Kontakt
 * publishes hundreds of host-automation slots all titled "Kontakt"; its own MIDI
 * learn binds a control to a controller instead, needing no names at all.
 *
 * In a browser build there are no plugins, so every entry point answers with an
 * empty list rather than throwing.
 */

/** One controller the plugin maps, as reported by the native side. */
export interface Vst3CcInfo {
  /** The controller number, 0-127. */
  controller: number;
  /**
   * The `ParamID` it resolves to on this instance.
   *
   * Reported for completeness and never stored in a project: it belongs to this
   * installed version of this plugin, while the controller is what the user
   * bound. Resolution happens natively on every send.
   */
  paramId: number;
}

const cached = new Map<string, Promise<Vst3CcInfo[]>>();

/**
 * The controllers a track's plugin accepts.
 *
 * An empty list means the plugin implements no `IMidiMapping` — it cannot be
 * sent MIDI CC at all, and there is no learn to offer.
 *
 * @param trackId - The track whose plugin to ask.
 * @param classId - Which plugin it is, so the native side can load it on demand,
 *   exactly as `listVst3Params` does.
 */
export function listVst3Cc(trackId: string, classId: string): Promise<Vst3CcInfo[]> {
  if (!isTauri()) return Promise.resolve([]);

  const key = `${trackId} ${classId}`;
  const existing = cached.get(key);
  if (existing) return existing;

  const pending = invoke<Vst3CcInfo[]>('vst3_list_cc', { trackId, classId }).catch(err => {
    // A plugin that would not answer must not leave the panel permanently
    // broken, so the rejected promise is not what stays cached.
    console.error('vst3: could not list MIDI controllers', err);
    cached.delete(key);
    return [] as Vst3CcInfo[];
  });

  cached.set(key, pending);
  return pending;
}

/** Drop the memoised lists. Exists for tests, and for a rescan. */
export function resetVst3Cc(): void {
  cached.clear();
}

/**
 * Controller numbers to reach for first, in order.
 *
 * 20-31 and 102-119 are the two blocks the MIDI spec leaves undefined, so they
 * are the ones least likely to already mean something to a sampler, a control
 * surface or another plugin in the chain.
 */
const PREFERRED_BLOCKS: [number, number][] = [
  [20, 31],
  [102, 119],
];

/**
 * Controllers to avoid handing out, even when nothing else is free.
 *
 * Each already has a job that a plugin, a keyboard or the MIDI file exporter may
 * act on regardless of what it was bound to here: bank select, data entry, the
 * volume the export already writes, pan, expression, sustain, the RPN/NRPN
 * selectors, and the channel-mode messages.
 */
const RESERVED = new Set([
  0, 32, 6, 38, 7, 10, 11, 64, 96, 97, 98, 99, 100, 101,
  120, 121, 122, 123, 124, 125, 126, 127,
]);

/**
 * The controller to offer next: mapped by the plugin, not already automated, and
 * as far out of the way as possible.
 *
 * Null when there is nothing left to offer, which is also what a plugin with no
 * `IMidiMapping` produces — the panel is then absent rather than offering a
 * number that would go nowhere.
 *
 * @param supported - What the plugin maps, from `listVst3Cc`.
 * @param taken - Controllers this track already has a lane for.
 */
export function nextFreeCc(supported: Vst3CcInfo[], taken: Iterable<number>): number | null {
  const used = new Set(taken);
  const mapped = new Set(supported.map(cc => cc.controller));
  const free = (cc: number) => mapped.has(cc) && !used.has(cc);

  for (const [from, to] of PREFERRED_BLOCKS) {
    for (let cc = from; cc <= to; cc++) {
      if (free(cc)) return cc;
    }
  }

  // Nothing left in the quiet blocks. Anything the spec has not already spoken
  // for beats refusing, since the user can still pick a number by hand.
  for (let cc = 0; cc <= MAX_CC; cc++) {
    if (!RESERVED.has(cc) && free(cc)) return cc;
  }

  return null;
}
