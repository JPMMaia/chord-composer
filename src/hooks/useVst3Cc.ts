import { useEffect, useState } from 'react';
import { listVst3Cc, type Vst3CcInfo } from '@/engine/vst3Cc';
import { parseInstrumentRef } from '@/engine/instrumentRef';
import type { Track } from '@/types/music';

/**
 * The MIDI controllers a track's plugin accepts.
 *
 * `useVst3Params`' sibling, asked per track for the same reason and empty in the
 * same cases — a General MIDI or SFZ sound, and a browser build. Empty also when
 * the plugin implements no `IMidiMapping`, which is the case the MIDI-learn panel
 * checks before offering itself.
 */
export function useVst3Cc(track: Track | null | undefined): Vst3CcInfo[] {
  const [supported, setSupported] = useState<Vst3CcInfo[]>([]);

  const ref = parseInstrumentRef(track?.instrument ?? '');
  const classId = ref.kind === 'vst3' ? ref.classId : null;
  const trackId = track?.id ?? null;

  useEffect(() => {
    if (!trackId || !classId) {
      // Cleared rather than left standing, so switching to a track with no
      // plugin does not leave the previous plugin's controllers on offer.
      setSupported([]);
      return;
    }

    let cancelled = false;
    listVst3Cc(trackId, classId).then(found => {
      if (!cancelled) setSupported(found);
    });

    return () => {
      cancelled = true;
    };
  }, [trackId, classId]);

  return supported;
}
