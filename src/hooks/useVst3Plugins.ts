import { useEffect, useState } from 'react';
import { listVst3Plugins, type Vst3PluginInfo } from '@/engine/vst3Catalog';
import { isTauri } from '@/engine/platform';

export interface Vst3PluginsState {
  plugins: Vst3PluginInfo[];
  /**
   * Whether the native scan is still running.
   *
   * Worth distinguishing from "scanned, found nothing", because a track already
   * set to a plugin must not be labelled *missing* while the list that would
   * vindicate it is still being built.
   */
  loading: boolean;
}

/**
 * The installed VST3 instruments, once they have been scanned.
 *
 * Starts empty and fills in, rather than suspending: the instrument picker is
 * fully usable with just its General MIDI sounds, and blocking the sidebar on a
 * multi-second native scan would make the app feel broken at launch.
 *
 * In a browser build the list stays empty and no scan is ever attempted.
 */
export function useVst3Plugins(): Vst3PluginsState {
  const [plugins, setPlugins] = useState<Vst3PluginInfo[]>([]);
  const [loading, setLoading] = useState(isTauri());

  useEffect(() => {
    if (!isTauri()) return;

    let cancelled = false;

    listVst3Plugins().then(found => {
      if (cancelled) return;
      setPlugins(found);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return { plugins, loading };
}
