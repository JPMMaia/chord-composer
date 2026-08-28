import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@/engine/platform';

/**
 * A plugin's own editor window.
 *
 * The window is native and lives outside the webview entirely — the plugin
 * draws into it, not React — so there is nothing here but the means to open and
 * close it. It opens the plugin on demand, so a synth's editor is reachable
 * without having pressed Play first.
 */

/** Open a track's plugin editor. Resolves once the window is up. */
export async function openVst3Editor(
  trackId: string,
  classId: string,
  title: string
): Promise<void> {
  if (!isTauri()) return;
  await invoke('vst3_open_editor', { trackId, classId, title });
}

/** Close a track's plugin editor, if it has one open. */
export async function closeVst3Editor(trackId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('vst3_close_editor', { trackId });
}

/**
 * What a track's plugin reports its own latency to be, in milliseconds.
 *
 * Null when the track hosts no plugin, or outside the desktop build. Shown beside
 * the instrument's manual offset and never applied: a plugin that declares its
 * latency honestly and one that sounds late while answering 0 are indistinguishable
 * from here, and the second is the common case. Seeing the reported figure is what
 * tells the user which of the two they are dealing with.
 */
export async function vst3Latency(trackId: string): Promise<number | null> {
  if (!isTauri()) return null;
  return invoke<number | null>('vst3_latency', { trackId });
}

/** Whether a track's editor window is currently open. */
export async function isVst3EditorOpen(trackId: string): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>('vst3_editor_is_open', { trackId });
}
