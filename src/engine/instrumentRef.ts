/**
 * What a `Track.instrument` string names.
 *
 * The field started life as a bare General MIDI id — `'acoustic_grand_piano'` —
 * and every project file ever written contains that form. Rather than migrate
 * them, a bare id keeps meaning exactly what it always meant and native plugins
 * take a prefixed form alongside it. Old files load unchanged, and a file
 * schema bump is not needed to introduce VST3.
 *
 * A VST3 plugin is named by its class id and nothing else. The class id is
 * globally unique by the VST3 specification, which makes it the one identifier
 * that survives a project file moving between machines — an install path would
 * not, and the plugin's display name changes between versions. Resolving a class
 * id back to a file on disk is the scanner's job, not this module's.
 */

/** The prefix marking a native plugin rather than a General MIDI sound. */
const VST3_PREFIX = 'vst3:';

/** A VST3 class id: the 16-byte TUID, lowercase hex. */
const CLASS_ID_PATTERN = /^[0-9a-f]{32}$/;

export type InstrumentRef =
  | { kind: 'gm'; instrumentId: string }
  | { kind: 'vst3'; classId: string };

/** Whether a string names a VST3 plugin. Cheap enough for render paths. */
export function isVst3Ref(instrument: string): boolean {
  return instrument.startsWith(VST3_PREFIX);
}

/** Build the `Track.instrument` value for a plugin class id. */
export function vst3Ref(classId: string): string {
  return `${VST3_PREFIX}${normalizeClassId(classId)}`;
}

/**
 * Class ids arrive from the scanner as hex that may be upper- or mixed-case
 * depending on how the plugin spells its TUID. Normalising on the way in is
 * what lets the id be compared as a plain string everywhere else.
 */
function normalizeClassId(classId: string): string {
  return classId.trim().toLowerCase().replace(/-/g, '');
}

/**
 * Interpret a `Track.instrument` value.
 *
 * A malformed VST3 ref falls back to General MIDI rather than throwing, for the
 * same reason `gmInstrumentId` clamps out-of-range programs: a damaged or
 * hand-edited project file should still open. The GM layer then resolves the
 * unrecognised id to the acoustic grand, which is the app's universal fallback.
 */
export function parseInstrumentRef(instrument: string): InstrumentRef {
  if (!isVst3Ref(instrument)) {
    return { kind: 'gm', instrumentId: instrument };
  }

  const classId = normalizeClassId(instrument.slice(VST3_PREFIX.length));
  if (!CLASS_ID_PATTERN.test(classId)) {
    return { kind: 'gm', instrumentId: instrument };
  }

  return { kind: 'vst3', classId };
}
