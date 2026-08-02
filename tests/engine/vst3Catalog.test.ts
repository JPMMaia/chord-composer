import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Tauri's IPC is a module boundary that needs a real native host, so it is
// mocked wholesale — the same treatment `smplrPiano.test.ts` gives `smplr`.
// What matters here is the adapter's contract: which command is invoked, that
// the answer is memoised, and that a browser build never invokes at all.
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { listVst3Plugins, resetVst3Catalog, vst3Option } from '@/engine/vst3Catalog';
import type { Vst3PluginInfo } from '@/engine/vst3Catalog';

const MARKER = '__TAURI_INTERNALS__';

function inTauri(): void {
  (window as unknown as Record<string, unknown>)[MARKER] = {};
}

const plugin = (over: Partial<Vst3PluginInfo> = {}): Vst3PluginInfo => ({
  classId: '565354416d736e6f53757267652058ab',
  name: 'Surge XT',
  vendor: 'Surge Synth Team',
  version: '1.3',
  subCategories: 'Instrument|Synth',
  path: 'C:\\Program Files\\Common Files\\VST3\\Surge XT.vst3',
  ...over,
});

beforeEach(() => {
  resetVst3Catalog();
  invoke.mockReset();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[MARKER];
});

describe('listVst3Plugins', () => {
  // The browser build has no plugins and never will. Answering empty rather
  // than throwing is what keeps the calling components free of platform checks.
  it('answers empty without invoking anything in a browser', async () => {
    await expect(listVst3Plugins()).resolves.toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('lists what the native scanner reports', async () => {
    inTauri();
    invoke.mockResolvedValue([plugin()]);

    await expect(listVst3Plugins()).resolves.toEqual([plugin()]);
    expect(invoke).toHaveBeenCalledWith('vst3_list');
  });

  // The scan loads every plugin on the machine into the process. Doing that
  // once per row that asks would be untenable.
  it('memoises, so repeated callers cost one scan', async () => {
    inTauri();
    invoke.mockResolvedValue([plugin()]);

    await Promise.all([listVst3Plugins(), listVst3Plugins(), listVst3Plugins()]);

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('re-scans on request, using the rescan command', async () => {
    inTauri();
    invoke.mockResolvedValue([]);

    await listVst3Plugins();
    await listVst3Plugins(true);

    expect(invoke).toHaveBeenNthCalledWith(1, 'vst3_list');
    expect(invoke).toHaveBeenNthCalledWith(2, 'vst3_scan');
  });

  // A plugin that crashes the scan must not leave the picker permanently
  // broken, so the rejection is not what gets cached.
  it('recovers from a failed scan rather than caching the failure', async () => {
    inTauri();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    invoke.mockRejectedValueOnce(new Error('boom'));

    await expect(listVst3Plugins()).resolves.toEqual([]);

    invoke.mockResolvedValue([plugin()]);
    await expect(listVst3Plugins()).resolves.toEqual([plugin()]);
  });
});

describe('vst3Option', () => {
  it('sets the namespaced instrument id as its value', () => {
    expect(vst3Option(plugin()).value).toBe('vst3:565354416d736e6f53757267652058ab');
  });

  // Plugin names collide across vendors far more often than GM names do.
  it('folds the vendor into the label', () => {
    expect(vst3Option(plugin()).label).toBe('Surge XT — Surge Synth Team');
  });

  it('omits the separator when the plugin reports no vendor', () => {
    expect(vst3Option(plugin({ vendor: '' })).label).toBe('Surge XT');
  });
});
