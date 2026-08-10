import { useCallback, useState } from 'react';
import { listSfzInstruments, pickSfzFile, type SfzInstrumentInfo } from '@/engine/sfzCatalog';
import { sfzRef } from '@/engine/instrumentRef';

export interface SfzInstrumentsState {
  /** The remembered instruments, most recently loaded first. */
  instruments: SfzInstrumentInfo[];
  /**
   * Ask the user for an `.sfz` and remember it.
   *
   * Resolves with the `Track.instrument` value for what they chose, or null if they
   * cancelled — so a caller can set the track's sound without knowing how a ref is
   * spelled, and can tell "cancelled" from "chose something" without inspecting a path.
   */
  add(): Promise<string | null>;
}

/**
 * The SFZ instruments this machine has been shown.
 *
 * The VST3 equivalent needs a `loading` flag, because its list arrives from a native
 * scan that takes seconds. This one comes out of `localStorage` synchronously, so
 * there is no in-between state to render and none to model: the list is simply right
 * from the first paint.
 */
export function useSfzInstruments(): SfzInstrumentsState {
  const [instruments, setInstruments] = useState<SfzInstrumentInfo[]>(listSfzInstruments);

  const add = useCallback(async () => {
    const picked = await pickSfzFile();
    // Re-read rather than appending: the catalog decides the order and what falls off
    // the end, and duplicating that here would be two answers to one question.
    setInstruments(listSfzInstruments());
    return picked ? sfzRef(picked.path) : null;
  }, []);

  return { instruments, add };
}
