import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@/engine/platform';
import type { Instrument, ScheduledNote } from '@/engine/instrument';
import type { AutomationTarget, Project } from '@/types/music';

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

/** Where the transport is, as a plugin's process context states it. */
export interface Vst3Transport {
  /** Whether the transport is rolling. */
  playing: boolean;
  tempo: number;
  /** Beats per measure and the beat's note value, for the bar under the playhead. */
  numerator: number;
  denominator: number;
}

/**
 * The last transport sent, so repeating it costs nothing.
 *
 * The scheduling pass is the only thing that knows the tempo *and* runs often
 * enough to notice it change, and it runs twenty times a second. Comparing here
 * rather than asking the caller to is what lets it simply say where it is on
 * every pass.
 */
let lastTransport: Vst3Transport | null = null;

/**
 * Tell the native side what the transport is doing.
 *
 * Every plugin is handed this as its `ProcessContext`, which a VST3 plugin is
 * entitled to and which nothing native can work out for itself: the output
 * stream runs whether or not anything is playing, and the tempo lives in the
 * store. A plugin without one cannot sync to a tempo and cannot tell playing
 * from idling.
 *
 * Safe to call on every scheduling pass: an unchanged transport sends nothing.
 */
export function setVst3Transport(transport: Vst3Transport): void {
  if (!isTauri()) return;
  if (
    lastTransport &&
    lastTransport.playing === transport.playing &&
    lastTransport.tempo === transport.tempo &&
    lastTransport.numerator === transport.numerator &&
    lastTransport.denominator === transport.denominator
  ) {
    return;
  }
  lastTransport = transport;

  // Spread into a plain record rather than passed as the interface: `invoke`
  // takes an index signature, which a declared shape does not satisfy however
  // well its keys match.
  invoke('vst3_set_transport', { ...transport }).catch(err => {
    // Nothing stops playing over this: a plugin with a stale context plays the
    // wrong tempo-synced delay, which is far better than a silent track. The
    // cache is cleared so the next pass tries again.
    console.error('vst3: could not state the transport', err);
    lastTransport = null;
  });
}

/**
 * Put every hosted instrument back the way it was when it loaded.
 *
 * A detailed sampled instrument can get slower the longer it plays, and a
 * buffer does not cure that — it only puts off the moment the shortfall is
 * heard. Reloading the instrument inside the plugin's own editor clears it, and
 * this asks the native side for the same thing without re-streaming the samples
 * a real reload would.
 *
 * One global call rather than a loop over the pool: the engine walks its own
 * slots, and it has to hold the renderer's lock to do any of this safely, which
 * is a thing to do once rather than once per track.
 *
 * Answers how many instruments were put back — 0 where there is no plugin
 * engine at all, which includes every browser.
 */
export async function resetVst3Plugins(): Promise<number> {
  if (!isTauri()) return 0;

  try {
    return (await invoke<number>('vst3_reset_all')) ?? 0;
  } catch (err) {
    // Nothing depends on this having worked. An instrument that was not put
    // back is one that goes on getting slower, which is where it started.
    console.error('vst3: could not reset the instruments', err);
    return 0;
  }
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
  lastTransport = null;
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

  /**
   * Parameter changes waiting to go over IPC, batched like the notes above and
   * for the same reason: one scheduling pass emits every due breakpoint of every
   * curve in one synchronous loop, and a round trip each would put the whole
   * automation stack in the path of every tick.
   *
   * Separate from `batch` rather than interleaved with it: the two go to
   * different commands, and a note and a parameter change have nothing to say
   * about each other's ordering — the native side places both on the same frame
   * counter, so the order they arrive in does not matter.
   */
  private paramBatch: { target: AutomationTarget; value: number; when: number }[] = [];
  private paramFlushQueued = false;

  /** The preset to restore once the plugin exists, from the project file. */
  private initialState: string | undefined;

  /**
   * A volume set before the plugin existed, or null if none was.
   *
   * The pool sets a volume on an instrument the moment it builds one, which for
   * a plugin is before the native side has anything to set it on — so it is
   * kept here and applied once the plugin exists.
   */
  private pendingVolume: number | null = null;

  /**
   * The last hold or release sent for each pitch, so the next one waits for it.
   *
   * Per pitch because that is the only order a plugin can hear: a note-off names
   * just the pitch, so a release overtaking the next hold of the same key cuts
   * the new note off as it starts. Different pitches go out side by side, or a
   * chord's keys would be spread a round trip apart.
   */
  private keyChains = new Map<number, Promise<unknown>>();

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
        // Whatever the track's volume was set to while there was no plugin to
        // set it on.
        if (this.pendingVolume !== null) this.setVolume(this.pendingVolume);
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

  /**
   * Place a parameter change on the plugin's timeline.
   *
   * Sample-accurate, unlike `setVolume`: a parameter goes through VST3's own
   * change queue, which carries a sample offset per point, so this command can
   * and does carry a time. That is why there is an `automateTarget` at all where
   * there is no `rampVolume` — the host-side gain multiply has nowhere to put a
   * time, and a plugin parameter does.
   */
  automateTarget(target: AutomationTarget, value: number, when: number): void {
    if (this.disposed || !this.loaded) return;

    this.paramBatch.push({ target, value, when });
    if (this.paramFlushQueued) return;

    this.paramFlushQueued = true;
    queueMicrotask(() => this.flushParams());
  }

  private flushParams(): void {
    this.paramFlushQueued = false;
    if (this.disposed || this.paramBatch.length === 0) return;

    const params = this.paramBatch;
    this.paramBatch = [];

    invoke('vst3_automate', { trackId: this.trackId, params }).catch(err => {
      console.error('vst3: could not automate parameters', err);
    });
  }

  /**
   * State a parameter now.
   *
   * Goes out on its own rather than through the batch: what this expresses is
   * "the value is this, as of now", and holding that behind a microtask while
   * queued future points went ahead of it would invert the two.
   */
  setTarget(target: AutomationTarget, value: number): void {
    if (this.disposed || !this.loaded) return;

    invoke('vst3_set_target', { trackId: this.trackId, target, value }).catch(err => {
      console.error('vst3: could not set a parameter', err);
    });
  }

  /**
   * Sound a note for as long as the returned function goes uncalled.
   *
   * Not expressible through `schedule`, which wants a length up front: a held
   * key has none, and the fixed-length preview `audition.ts` falls back to
   * leaves a slow-releasing library — an orchestral one, typically — sounding
   * long after the key came up.
   *
   * Holds and releases of one pitch go out strictly in turn (`keyChains`). Two
   * `invoke`s are two independent round trips and nothing promises they arrive
   * in order: an off overtaking its own on would hang the note until the next
   * Stop, and one overtaking the *next* on — a key struck again under the pedal,
   * whose old note is released just before the new one sounds — reaches the
   * plugin as on-then-off and muffles the new note at birth.
   */
  sustain(note: { midiNote: number; velocity: number }): () => void {
    if (this.disposed || !this.loaded) return () => {};

    this.sendKey(note.midiNote, () =>
      invoke('vst3_hold', {
        trackId: this.trackId,
        midiNote: note.midiNote,
        velocity: note.velocity,
      }).catch(err => {
        console.error('vst3: could not hold note', err);
      })
    );

    return () => {
      this.sendKey(note.midiNote, () =>
        invoke('vst3_release', {
          trackId: this.trackId,
          midiNote: note.midiNote,
        }).catch(err => {
          console.error('vst3: could not release note', err);
        })
      );
    };
  }

  /** Send a hold or release once everything already sent for this pitch has landed. */
  private sendKey(midiNote: number, send: () => Promise<unknown>): void {
    const previous = this.keyChains.get(midiNote) ?? Promise.resolve();
    this.keyChains.set(
      midiNote,
      previous.then(() => (this.disposed ? undefined : send()))
    );
  }

  stopAll(): void {
    if (this.disposed) return;
    // Drop anything not yet sent as well, or a Stop is immediately followed by
    // the notes it was meant to cancel — and by the curve it was meant to end.
    this.batch = [];
    this.paramBatch = [];
    invoke('vst3_stop', { trackId: this.trackId }).catch(() => {});
  }

  /**
   * Deliberately the only level control this backend offers: there is no
   * `rampVolume` here because the level goes over IPC to a plugin rendering on its
   * own device, and the command carries no time. Volume automation therefore steps
   * this once per scheduling pass rather than scheduling a ramp — coarser than the
   * samplers get, and the reason `Instrument.rampVolume` is optional.
   */
  setVolume(volume: number): void {
    if (this.disposed) return;

    this.pendingVolume = this.loaded ? null : volume;
    invoke('vst3_set_volume', { trackId: this.trackId, volume }).catch(() => {});
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.batch = [];
    this.paramBatch = [];

    if (this.loaded) sharedClock.release();
    this.loaded = false;
    if (live.get(this.trackId) === this) live.delete(this.trackId);

    invoke('vst3_unload', { trackId: this.trackId }).catch(() => {});
  }
}
