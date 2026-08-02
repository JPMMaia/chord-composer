import { invoke } from '@tauri-apps/api/core';
import type { Instrument, ScheduledNote } from '@/engine/instrument';
import type { Project } from '@/types/music';

/**
 * A natively-hosted VST3 plugin, behind the same `Instrument` interface as the
 * Web Audio samplers.
 *
 * Deliberately the same shape as `soundfontInstrument.ts`: a thin adapter onto
 * something that makes sound elsewhere. The scheduler cannot tell them apart,
 * which is exactly what `instrument.ts` was designed for.
 *
 * The one thing that is not like the samplers is the clock. `now()` still
 * answers with the `AudioContext`'s time, because that is the clock the whole
 * app schedules against — but the plugin renders on a *different* audio device,
 * with its own free-running counter. The two are kept in correspondence by
 * `Vst3Clock` below.
 */

/** How often the native side is told what the webview's clock reads. */
const SYNC_INTERVAL_MS = 500;

/**
 * Keeps the native clock anchored to the webview's.
 *
 * Shared by every plugin rather than one timer each: the anchor is a property
 * of the two clocks, not of any one instrument, and N timers would send N
 * identical messages.
 */
class Vst3Clock {
  private ctx: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private users = 0;

  /** Start syncing, if this is the first plugin to need it. */
  acquire(ctx: AudioContext): void {
    this.ctx = ctx;
    this.users += 1;
    if (this.timer !== null) return;

    this.timer = setInterval(() => this.send(), SYNC_INTERVAL_MS);
    this.send();
  }

  release(): void {
    this.users = Math.max(0, this.users - 1);
    if (this.users > 0) return;
    this.stop();
  }

  stop(): void {
    this.users = 0;
    if (this.timer === null) return;

    clearInterval(this.timer);
    this.timer = null;
    this.ctx = null;
  }

  /**
   * Anchor immediately.
   *
   * Play must not schedule its first notes against a stale anchor — half a
   * second of drift is enough to hear on the very first note — so loading and
   * starting both force one rather than waiting for the next tick.
   */
  send(): void {
    if (!this.ctx) return;
    invoke('vst3_sync', { hostTime: this.ctx.currentTime }).catch(() => {
      // A failed sync is not fatal: the next tick will try again, and until it
      // lands the native side keeps using the anchor it already has.
    });
  }
}

const sharedClock = new Vst3Clock();

/** Force an immediate re-anchor. Called at Play, before any note is scheduled. */
export function syncVst3Clock(): void {
  sharedClock.send();
}

/**
 * Stop syncing and forget how many plugins were using the clock.
 *
 * Exists for tests, which would otherwise leak a live interval — and its
 * reference count — from one case into the next.
 */
export function resetVst3Clock(): void {
  sharedClock.stop();
  live.clear();
}

/**
 * Plugins currently loaded, by track id.
 *
 * A plugin's preset lives inside the plugin, not in the store, so saving has to
 * ask it. A module-level registry rather than plumbing the instrument pool down
 * into the file-I/O hook: the two have nothing else to say to each other, and
 * the pool is owned by a React ref several components away.
 */
const live = new Map<string, Vst3Instrument>();

/**
 * The project with each plugin track's current state folded in, ready to save.
 *
 * Returns the project unchanged when nothing has a plugin — which is every
 * browser-build project, and most desktop ones — so the common path allocates
 * nothing and the caller needs no platform check.
 */
export async function captureVst3State(project: Project): Promise<Project> {
  const loaded = project.tracks.filter(track => live.get(track.id)?.isLoaded);
  if (loaded.length === 0) return project;

  const captured = new Map<string, string>();
  await Promise.all(
    loaded.map(async track => {
      const state = await live.get(track.id)?.captureState();
      if (state) captured.set(track.id, state);
    })
  );

  if (captured.size === 0) return project;

  return {
    ...project,
    tracks: project.tracks.map(track =>
      captured.has(track.id) ? { ...track, vst3State: captured.get(track.id) } : track
    ),
  };
}

export class Vst3Instrument implements Instrument {
  readonly name: string;

  private ctx: AudioContext;
  private trackId: string;
  private classId: string;
  private loadPromise: Promise<void> | null = null;
  private loaded = false;
  private disposed = false;

  /**
   * Notes waiting to go over IPC.
   *
   * `usePlayback`'s tick dispatches every due note in one synchronous loop, so
   * batching here turns a chord's worth of round trips into one. The flush is a
   * microtask, which runs at the end of that same loop.
   */
  private batch: ScheduledNote[] = [];
  private flushQueued = false;

  /** The preset to restore once the plugin exists, from the project file. */
  private initialState: string | undefined;

  constructor(
    audioContext: AudioContext,
    trackId: string,
    classId: string,
    name: string,
    initialState?: string
  ) {
    this.ctx = audioContext;
    this.trackId = trackId;
    this.classId = classId;
    this.name = name;
    this.initialState = initialState;
  }

  /** This plugin's own state, base64'd, or null if it will not give one up. */
  async captureState(): Promise<string | null> {
    if (this.disposed || !this.loaded) return null;
    try {
      return await invoke<string | null>('vst3_get_state', { trackId: this.trackId });
    } catch (err) {
      // Saving a project must not fail because one plugin was uncooperative.
      console.error('vst3: could not read plugin state', err);
      return null;
    }
  }

  now(): number {
    return this.ctx.currentTime;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  /** Idempotent, for the same reason the samplers' is: Play calls it every time. */
  load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = invoke('vst3_load', {
      trackId: this.trackId,
      classId: this.classId,
    })
      .then(async () => {
        if (this.disposed) return;

        // Before anything can be heard: a plugin that sounds on its default
        // preset for a moment and then jumps to the saved one is worse than
        // one that simply starts correct.
        if (this.initialState) {
          try {
            await invoke('vst3_set_state', {
              trackId: this.trackId,
              data: this.initialState,
            });
          } catch (err) {
            // A preset the plugin will not accept — a different version of it,
            // usually. Better to play on its defaults than not at all.
            console.error('vst3: could not restore plugin state', err);
          }
        }
      })
      .then(() => {
        if (this.disposed) return;
        this.loaded = true;
        live.set(this.trackId, this);
        // Starting the clock only once a plugin exists keeps a project with no
        // VST3 tracks from ever opening a native audio device.
        sharedClock.acquire(this.ctx);
      });

    return this.loadPromise;
  }

  schedule(note: ScheduledNote): void {
    if (this.disposed || !this.loaded) return;

    this.batch.push(note);
    if (this.flushQueued) return;

    this.flushQueued = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.flushQueued = false;
    if (this.disposed || this.batch.length === 0) return;

    const notes = this.batch;
    this.batch = [];

    invoke('vst3_schedule', { trackId: this.trackId, notes }).catch(err => {
      console.error('vst3: could not schedule notes', err);
    });
  }

  stopAll(): void {
    if (this.disposed) return;
    // Drop anything not yet sent as well, or a Stop is immediately followed by
    // the notes it was meant to cancel.
    this.batch = [];
    invoke('vst3_stop', { trackId: this.trackId }).catch(() => {});
  }

  setVolume(volume: number): void {
    if (this.disposed) return;
    invoke('vst3_set_volume', { trackId: this.trackId, volume }).catch(() => {});
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.batch = [];

    if (this.loaded) sharedClock.release();
    this.loaded = false;
    if (live.get(this.trackId) === this) live.delete(this.trackId);

    invoke('vst3_unload', { trackId: this.trackId }).catch(() => {});
  }
}
