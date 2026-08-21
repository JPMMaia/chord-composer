/**
 * An instrument set, saved on its own so it can be reused across pieces.
 *
 * Setting up instruments is the slowest part of starting a piece: every project opens
 * with one `Piano`, and rebuilding a working ensemble means adding each instrument by
 * hand, picking its sound, and — for a VST3 plugin — reopening the plugin's editor and
 * dialling in the preset again. That work is about the ensemble, not the song, so it
 * can be carried forward on its own.
 *
 * A template is `project.tracks` with everything song-specific stripped out. What stays
 * is what the instrument *is*: its name, its sound ref, its mix settings, and, for a
 * plugin, the plugin's own state blob. What goes is what belongs to one song or one
 * session: the track id, `volumeAutomation` and `parameterAutomation` (both derived
 * from the phrases of a particular piece), `muted`/`solo`/`visible`,
 * and every bar of content.
 *
 * The reader is tolerant in the same way `fileIO.ts`'s is — an entry it cannot make
 * sense of is dropped rather than failing the whole load — with one deliberate
 * exception: JSON with no `instruments` array is rejected outright, because that is
 * what a project file picked by mistake looks like, and appending silence to the
 * project would be a worse answer than a message.
 */
import type { Project } from '@/types/music';

/**
 * Version 1.0 — the first. Every field is written, so there is nothing yet for a
 * reader to infer from absence; the field exists so a later change can.
 */
export const TEMPLATE_SCHEMA_VERSION = '1.0';

/** The Open/Save dialog filter. JSON contents, but a name of its own. */
export const TEMPLATE_FILTER = {
  name: 'Chord Composer Instruments',
  extensions: ['cctemplate'],
};

/** One instrument in a template: what it is, not what it played. */
export interface TemplateInstrument {
  name: string;
  /** A `Track.instrument` ref — a GM id, `vst3:<classid>`, or `sfz:<path>`. */
  instrument: string;
  volume: number;
  pan: number;
  color?: string;
  /** A VST3 plugin's own state, base64'd and opaque. Absent for every other kind. */
  vst3State?: string;
}

export interface InstrumentTemplate {
  version: string;
  /** What the set is called — seeded from the project it was captured from. */
  name: string;
  instruments: TemplateInstrument[];
  createdAt: string;
}

/** Keep a number inside a range, the way `validateProject` bounds the same fields. */
function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Capture a project's instruments.
 *
 * The caller passes a project that has already been through `captureVst3State`, so
 * `vst3State` is what the plugin holds now rather than what it held at the last save.
 */
export function templateFromProject(project: Project, name: string): InstrumentTemplate {
  return {
    version: TEMPLATE_SCHEMA_VERSION,
    name,
    instruments: project.tracks.map(track => ({
      name: track.name,
      instrument: track.instrument,
      volume: track.volume,
      pan: track.pan,
      color: track.color,
      vst3State: track.vst3State,
    })),
    createdAt: new Date().toISOString(),
  };
}

/** Two-space JSON, matching what `fileIO.ts` writes — these files are readable. */
export function serializeTemplate(template: InstrumentTemplate): string {
  return JSON.stringify(template, null, 2);
}

/**
 * Read a template back, dropping what cannot be understood.
 *
 * An unrecognised instrument ref is kept **verbatim**. `instrumentRef.ts` documents the
 * rule already in force for projects: a class id or an SFZ path this machine does not
 * know is left alone rather than quietly replaced, so the instrument comes back intact
 * once the plugin is installed or the samples are found again. The instruments panel
 * already renders such a ref as a missing plugin rather than a wrong one.
 */
export function deserializeTemplate(json: string): InstrumentTemplate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('That file is not a valid instruments template.');
  }

  const t = parsed as Record<string, unknown> | null;
  if (!t || typeof t !== 'object' || !Array.isArray(t.instruments)) {
    // The likely cause is a project file picked from the Open dialog, so the message
    // names the two things rather than saying the file is broken.
    throw new Error('That file is not an instruments template — it lists no instruments.');
  }

  const instruments: TemplateInstrument[] = (t.instruments as unknown[])
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    // An entry that names no sound describes no instrument, so there is nothing to
    // append; every other field has a sensible default.
    .filter(entry => typeof entry.instrument === 'string' && entry.instrument.length > 0)
    .map((entry, i) => ({
      name: typeof entry.name === 'string' && entry.name ? entry.name : `Instrument ${i + 1}`,
      instrument: entry.instrument as string,
      volume: clamp(entry.volume, 0, 1, 1),
      pan: clamp(entry.pan, -1, 1, 0),
      color: typeof entry.color === 'string' ? entry.color : undefined,
      // Opaque base64. Anything that is not a string is dropped rather than handed to
      // the plugin, which would reject it.
      vst3State: typeof entry.vst3State === 'string' ? entry.vst3State : undefined,
    }));

  return {
    version: typeof t.version === 'string' ? t.version : TEMPLATE_SCHEMA_VERSION,
    name: typeof t.name === 'string' && t.name ? t.name : 'Instruments',
    instruments,
    createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date().toISOString(),
  };
}
