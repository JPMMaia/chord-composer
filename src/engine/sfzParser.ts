import type { SmplrPreset, SmplrRegion } from 'smplr';

/**
 * SFZ, reduced to the part this app can play.
 *
 * SFZ is a plain-text format: a list of `<region>`s, each naming a sample file and the
 * range of keys it covers, with `<group>` and `<global>` headers above them supplying
 * whatever a region does not state for itself. That model is very nearly `smplr`'s own
 * preset schema — key ranges, a pitch centre, loop points, an amplitude envelope — which
 * is what makes a local sample set playable here without a new audio engine behind it.
 *
 * The spec has several hundred opcodes. This reads the ones that change what a note
 * *sounds like* and ignores the rest rather than refusing the file: an instrument using
 * a filter cutoff we do not implement should still play its samples at the right pitch,
 * because that is the difference between an ocarina and nothing at all.
 *
 * Parsing and conversion are separate on purpose. `parseSfz` is pure text work and can
 * be tested against a real file; `sfzToPreset` needs each sample's *rate*, which is only
 * known once the WAV headers have been read, because SFZ counts loop points in frames
 * and Web Audio counts them in seconds.
 */

/**
 * The format declared in the preset.
 *
 * Never actually used to build a URL — `SfzInstrument` reads and decodes the samples
 * itself and hands smplr the finished buffers — but the field is required, and a
 * sample set is overwhelmingly likely to be WAV.
 */
const SAMPLE_FORMAT = 'wav';

/** One region, with its inherited opcodes already folded in. */
export interface SfzRegion {
  /** Path relative to the `.sfz` (or absolute), forward slashes, extension intact. */
  sample: string;
  loKey: number;
  hiKey: number;
  /** The key at which the sample plays untransposed. */
  pitchKeyCenter: number;
  loVel: number;
  hiVel: number;
  loop: boolean;
  /** Frame indices, as SFZ states them — not seconds. */
  loopStartFrames?: number;
  loopEndFrames?: number;
  offsetFrames?: number;
  /** Decibels. */
  volume?: number;
  /** Fine tuning, in cents. */
  tuneCents?: number;
  /** Coarse tuning, in semitones. */
  transpose?: number;
  /** Seconds. */
  ampegAttack?: number;
  ampegRelease?: number;
}

export interface ParsedSfz {
  /** From the `//+ Name:` header freepats-style files carry. Undefined if absent. */
  name?: string;
  regions: SfzRegion[];
}

export interface SfzPresetOptions {
  /** Directory the `.sfz` lives in, forward slashes, no trailing slash. */
  baseUrl: string;
  /** The recorded rate of a sample, by its SFZ path. Undefined disables its loop. */
  sampleRate: (sample: string) => number | undefined;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * A header (`<region>`) or the start of an opcode (`sample=`).
 *
 * Opcode *values* are not matched: a value runs to wherever the next header or opcode
 * begins, because sample paths contain spaces far too often to split on whitespace.
 */
const TOKEN = /<([a-z_]+)>|([a-zA-Z0-9_]+)=/g;

/** The `//+ Name: Ocarina` line freepats puts at the top of its instruments. */
const NAME_HEADER = /^\s*\/\/\+\s*Name:\s*(.+)$/m;

type Opcodes = Record<string, string>;

export function parseSfz(text: string): ParsedSfz {
  // Lifted before the comment stripper runs, since it lives inside a comment.
  const name = NAME_HEADER.exec(text)?.[1]?.trim() || undefined;

  const source = stripComments(text);
  const regions: SfzRegion[] = [];

  // One bucket per inheritance level. A `<region>` sees global, then master, then
  // group, then its own — later levels overriding earlier ones.
  let control: Opcodes = {};
  let global: Opcodes = {};
  let master: Opcodes = {};
  let group: Opcodes = {};
  let region: Opcodes | null = null;
  // Where opcodes read right now are going. Unknown headers get a scratch bucket so
  // their opcodes are dropped rather than leaking into the region below them.
  let current: Opcodes = global;

  const flush = () => {
    if (!region) return;
    const built = buildRegion({ ...global, ...master, ...group, ...region }, control);
    if (built) regions.push(built);
    region = null;
  };

  let match: RegExpExecArray | null;
  let pending: { name: string; from: number } | null = null;
  TOKEN.lastIndex = 0;

  const commit = (to: number) => {
    if (!pending) return;
    const value = source.slice(pending.from, to).trim();
    if (value) current[pending.name] = value;
    pending = null;
  };

  while ((match = TOKEN.exec(source)) !== null) {
    commit(match.index);

    const header = match[1];
    if (header === undefined) {
      pending = { name: match[2].toLowerCase(), from: TOKEN.lastIndex };
      continue;
    }

    // A new header of any kind ends the region being collected, and resets every
    // level below the one it opens — a second `<group>` must not inherit the first's.
    switch (header) {
      case 'control':
        flush();
        current = control;
        break;
      case 'global':
        flush();
        global = {};
        master = {};
        group = {};
        current = global;
        break;
      case 'master':
        flush();
        master = {};
        group = {};
        current = master;
        break;
      case 'group':
        flush();
        group = {};
        current = group;
        break;
      case 'region':
        flush();
        region = {};
        current = region;
        break;
      default:
        // `<curve>`, `<effect>`, and anything a later revision adds.
        flush();
        current = {};
    }
  }

  commit(source.length);
  flush();

  return { name, regions };
}

/** Remove `/* *​/` blocks and `//` line comments, keeping the text's length semantics. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Turn one region's merged opcodes into a region, or null if it names no sample —
 * which some files use as a placeholder and which there is nothing to play for.
 */
function buildRegion(opcodes: Opcodes, control: Opcodes): SfzRegion | null {
  const sample = opcodes.sample;
  if (!sample) return null;

  const key = parseKey(opcodes.key);
  const loKey = parseKey(opcodes.lokey) ?? key ?? 0;
  const hiKey = parseKey(opcodes.hikey) ?? key ?? 127;

  return {
    sample: joinDefaultPath(control.default_path, sample),
    loKey,
    hiKey,
    // `key=n` centres on itself. Otherwise the spec's default is 60, even when the
    // region covers some quite different range — a file that means anything else says
    // so with `pitch_keycenter`.
    pitchKeyCenter: parseKey(opcodes.pitch_keycenter) ?? key ?? 60,
    loVel: parseNumber(opcodes.lovel) ?? 0,
    hiVel: parseNumber(opcodes.hivel) ?? 127,
    loop: parseLoop(opcodes),
    loopStartFrames: parseNumber(opcodes.loop_start ?? opcodes.loopstart),
    loopEndFrames: parseNumber(opcodes.loop_end ?? opcodes.loopend),
    offsetFrames: parseNumber(opcodes.offset),
    volume: parseNumber(opcodes.volume),
    tuneCents: parseNumber(opcodes.tune ?? opcodes.pitch),
    transpose: parseNumber(opcodes.transpose),
    ampegAttack: parseNumber(opcodes.ampeg_attack),
    ampegRelease: parseNumber(opcodes.ampeg_release),
  };
}

/**
 * Whether the region loops.
 *
 * `loop_mode` decides it when stated. When it is not, loop points alone are taken as
 * intent: a file that went to the trouble of naming a loop's first and last frame did
 * not mean for the note to stop there.
 */
function parseLoop(opcodes: Opcodes): boolean {
  const mode = opcodes.loop_mode ?? opcodes.loopmode;
  if (mode) return mode === 'loop_continuous' || mode === 'loop_sustain';
  return opcodes.loop_start !== undefined || opcodes.loopstart !== undefined;
}

/** `default_path` is relative to the `.sfz`, and an absolute sample ignores it. */
function joinDefaultPath(defaultPath: string | undefined, sample: string): string {
  const file = normalizeSeparators(sample);
  if (!defaultPath || isAbsolute(file)) return file;
  const prefix = normalizeSeparators(defaultPath).replace(/\/$/, '');
  return prefix ? `${prefix}/${file}` : file;
}

function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, '/');
}

function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:/.test(path);
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Note names in SFZ are letter, accidentals, octave — with `c4` meaning MIDI 60. */
const NOTE_NAME = /^([a-gA-G])([#bs]*)(-?\d+)$/;
const SEMITONES = [9, 11, 0, 2, 4, 5, 7]; // a b c d e f g

/** A key value, which may be a MIDI number or a note name. */
export function parseKey(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;

  const asNumber = parseNumber(value);
  if (asNumber !== undefined && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return Math.round(asNumber);
  }

  const match = NOTE_NAME.exec(value.trim());
  if (!match) return undefined;

  const letter = match[1].toLowerCase().charCodeAt(0) - 'a'.charCodeAt(0);
  const accidentals = [...match[2]].reduce((sum, c) => sum + (c === 'b' ? -1 : 1), 0);
  const octave = Number.parseInt(match[3], 10);
  // C4 is 60, so C-1 is 0 — hence the +1 on the octave.
  return SEMITONES[letter] + accidentals + 12 * (octave + 1);
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * The name smplr knows a sample by: its path with the extension removed, because
 * smplr appends the format itself when building a URL.
 */
export function sampleKey(sample: string): string {
  return sample.replace(/\.[^./]+$/, '');
}

/** Every distinct sample the regions name, in first-seen order. */
export function sfzSamples(parsed: ParsedSfz): string[] {
  return [...new Set(parsed.regions.map(r => r.sample))];
}

/**
 * Build the preset smplr plays from.
 *
 * All regions go into one group: SFZ's groups exist to share opcodes, and `parseSfz`
 * has already pushed those down onto the regions themselves.
 */
export function sfzToPreset(parsed: ParsedSfz, options: SfzPresetOptions): SmplrPreset {
  const regions = parsed.regions.map(region => toSmplrRegion(region, options));

  return {
    meta: parsed.name ? { name: parsed.name } : undefined,
    samples: { baseUrl: options.baseUrl.replace(/\/$/, ''), formats: [SAMPLE_FORMAT] },
    groups: [{ regions }],
  };
}

function toSmplrRegion(region: SfzRegion, options: SfzPresetOptions): SmplrRegion {
  const rate = options.sampleRate(region.sample);

  // `keyRange` and `pitch`, never smplr's `key` — which is load-bearing. Setting
  // `key` makes smplr use it as the pitch centre *and discard* `pitch`, so a region
  // like the ocarina's `key=76` with a different `pitch_keycenter` would transpose
  // wrongly. Stating the range and the centre separately always says what SFZ meant.
  const converted: SmplrRegion = {
    sample: sampleKey(region.sample),
    keyRange: [region.loKey, region.hiKey],
    pitch: region.pitchKeyCenter,
    velRange: [region.loVel, region.hiVel],
  };

  if (region.volume !== undefined) converted.volume = region.volume;
  if (region.transpose !== undefined) converted.tune = region.transpose;
  if (region.tuneCents !== undefined) converted.detune = region.tuneCents;
  if (region.ampegAttack !== undefined) converted.ampAttack = region.ampegAttack;
  if (region.ampegRelease !== undefined) converted.ampRelease = region.ampegRelease;
  if (region.offsetFrames !== undefined && rate) converted.offset = region.offsetFrames / rate;

  // Loop points are frames in SFZ and seconds in Web Audio, so without the sample's
  // rate there is no honest conversion — and a loop at the wrong point is worse than
  // none, so the note simply plays through instead.
  if (region.loop && rate && region.loopEndFrames !== undefined) {
    converted.loop = true;
    converted.loopStart = (region.loopStartFrames ?? 0) / rate;
    // SFZ's `loop_end` is the last frame *inside* the loop; Web Audio's `loopEnd` is
    // the point playback jumps back from, which is one frame later.
    converted.loopEnd = (region.loopEndFrames + 1) / rate;
  }

  return converted;
}
