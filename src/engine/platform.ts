/**
 * Which shell the app is running in.
 *
 * The app ships two ways from one codebase: a browser build, whose only sound is
 * Web Audio, and a Tauri desktop build, which can additionally host native VST3
 * plugins. Everything VST3 hides behind `isTauri()` rather than behind a build
 * flag, so `npm run dev` in a browser stays a first-class way to work on the
 * parts that have nothing to do with plugins.
 *
 * The check is a property on `window` that Tauri's IPC bootstrap injects before
 * any app code runs. It is read lazily rather than captured at module load
 * because the test environment installs and removes it between cases.
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
