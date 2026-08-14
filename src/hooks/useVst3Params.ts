import { useEffect, useState } from 'react';
import { listVst3Params, type Vst3ParamInfo } from '@/engine/vst3Params';
import { parseInstrumentRef } from '@/engine/instrumentRef';
import type { Track } from '@/types/music';

export interface Vst3ParamsState {
  params: Vst3ParamInfo[];
  /**
   * Whether the native call is still out.
   *
   * Worth distinguishing from "asked, found nothing", for the same reason
   * `useVst3Plugins` distinguishes them: a picker that says "no parameters"
   * while the list that would contradict it is still being built is worse than
   * one that says it is still looking.
   */
  loading: boolean;
}

/**
 * The automation targets a track's plugin offers.
 *
 * Empty for a track that is not a plugin at all — a General MIDI or SFZ sound
 * has nothing to automate but its volume, which has a lane of its own — and
 * empty in a browser build, where there are no plugins to ask.
 *
 * Asked per track rather than once for the panel, unlike `useVst3Plugins`: the
 * answer belongs to one plugin instance, and only the instrument being edited
 * has its lanes on screen.
 */
export function useVst3Params(track: Track | null | undefined): Vst3ParamsState {
  const [params, setParams] = useState<Vst3ParamInfo[]>([]);
  const [loading, setLoading] = useState(false);

  // `parseInstrumentRef` already resolves a malformed ref to General MIDI, so a
  // `vst3` kind here is one the native side can actually be asked about.
  const ref = parseInstrumentRef(track?.instrument ?? '');
  const classId = ref.kind === 'vst3' ? ref.classId : null;
  const trackId = track?.id ?? null;

  useEffect(() => {
    if (!trackId || !classId) {
      // Cleared rather than left standing: switching to a track with no plugin
      // must not leave the previous plugin's parameters on offer.
      setParams([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    listVst3Params(trackId, classId).then(found => {
      if (cancelled) return;
      setParams(found);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [trackId, classId]);

  return { params, loading };
}
