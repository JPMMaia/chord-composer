import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@/engine/platform';
import { vst3Ref } from '@/engine/instrumentRef';

/**
 * The VST3 instruments installed on this machine.
 *
 * The scan itself is native and expensive — it loads every plugin on the system
 * into the process — so the Rust side caches it and this module caches the
 * promise. Callers can ask as often as they like; the machine is only walked
 * once per session unless someone asks for a rescan.
 *
 * In a browser build there are no plugins and never will be, so every entry
 * point here answers with an empty list rather than throwing. That keeps the
 * calling components free of platform checks.
 */

/** One plugin class, as reported by the native scanner. */
export interface Vst3PluginInfo {
  /** The 16-byte TUID as 32 lowercase hex characters. */
  classId: string;
  name: string;
  vendor: string;
  version: string;
  /** The plugin's own subcategory string, e.g. `Instrument|Synth`. */
  subCategories: string;
  /** Absolute path to the `.vst3` on disk. */
  path: string;
}

let cached: Promise<Vst3PluginInfo[]> | null = null;

/**
 * The installed instruments.
 *
 * @param rescan - Re-read the install directories, picking up a plugin
 *   installed since launch. Costs a full native scan.
 */
export function listVst3Plugins(rescan = false): Promise<Vst3PluginInfo[]> {
  if (!isTauri()) return Promise.resolve([]);

  if (!cached || rescan) {
    cached = invoke<Vst3PluginInfo[]>(rescan ? 'vst3_scan' : 'vst3_list')
      .then(found => {
        for (const plugin of found) known.set(plugin.classId, plugin.name);
        return found;
      })
      // A failed scan must not leave the picker permanently broken, so the
      // rejected promise is not what gets cached.
      .catch(err => {
        console.error('vst3: scan failed', err);
        cached = null;
        return [];
      });
  }

  return cached;
}

/** Drop the memoised scan. Exists for tests. */
export function resetVst3Catalog(): void {
  cached = null;
  known.clear();
}

/**
 * Names by class id, from the last completed scan.
 *
 * `Instrument.name` is synchronous — it is a plain property, read while
 * rendering the transport — so it cannot wait on the scan. This is populated as
 * a side effect of listing, which has always happened by the time a track can
 * be set to a plugin through the UI.
 */
const known = new Map<string, string>();

/** The display name for a plugin class id, falling back to the id itself. */
export function vst3NameFor(classId: string): string {
  return known.get(classId) ?? `VST3 ${classId.slice(0, 8)}`;
}

/**
 * The picker entry for a plugin: the `Track.instrument` value it sets, and the
 * label to show.
 *
 * The vendor is folded into the label because plugin names collide across
 * vendors far more often than General MIDI names do.
 */
export function vst3Option(plugin: Vst3PluginInfo): { value: string; label: string } {
  return {
    value: vst3Ref(plugin.classId),
    label: plugin.vendor ? `${plugin.name} — ${plugin.vendor}` : plugin.name,
  };
}
