/**
 * The General MIDI melodic sounds an instrument can be set to.
 *
 * The ids are smplr's soundfont names, and the order is GM program order, so an
 * entry's index *is* its GM program number — which is what the MIDI exporter writes
 * as a Program Change. That coupling is why this list is spelled out rather than
 * derived from smplr's `getSoundfontNames()`: that function returns the same 128
 * names sorted alphabetically, which would silently give every instrument the wrong
 * program number.
 *
 * GM's percussion set is deliberately absent. Drums are unpitched and ignore the
 * bar's scale, so they need their own palette and note generation rather than an
 * entry here.
 */

/** One selectable sound. */
export interface GmInstrument {
  /** smplr soundfont name, e.g. 'string_ensemble_1'. */
  id: string;
  /** Display name, e.g. 'String Ensemble 1'. */
  label: string;
  /** GM family, used to group the picker. */
  family: string;
}

/** The 16 GM families, in program order. Each covers exactly 8 programs. */
export const GM_FAMILIES = [
  'Piano',
  'Chromatic Percussion',
  'Organ',
  'Guitar',
  'Bass',
  'Strings',
  'Ensemble',
  'Brass',
  'Reed',
  'Pipe',
  'Synth Lead',
  'Synth Pad',
  'Synth Effects',
  'Ethnic',
  'Percussive',
  'Sound Effects',
] as const;

/**
 * The 128 GM melodic sounds in program order.
 *
 * Labels are the GM standard names; ids are smplr's. The two differ in more places
 * than is obvious — GM's "Clavi" is smplr's `clavinet`, "Synth Voice" is
 * `synth_choir`, "Bag pipe" is `bagpipe` — so both are spelled out rather than one
 * being derived from the other.
 */
const GM_NAMES: Array<[id: string, label: string]> = [
  // Piano (0-7)
  ['acoustic_grand_piano', 'Acoustic Grand Piano'],
  ['bright_acoustic_piano', 'Bright Acoustic Piano'],
  ['electric_grand_piano', 'Electric Grand Piano'],
  ['honkytonk_piano', 'Honky-tonk Piano'],
  ['electric_piano_1', 'Electric Piano 1'],
  ['electric_piano_2', 'Electric Piano 2'],
  ['harpsichord', 'Harpsichord'],
  ['clavinet', 'Clavi'],
  // Chromatic Percussion (8-15)
  ['celesta', 'Celesta'],
  ['glockenspiel', 'Glockenspiel'],
  ['music_box', 'Music Box'],
  ['vibraphone', 'Vibraphone'],
  ['marimba', 'Marimba'],
  ['xylophone', 'Xylophone'],
  ['tubular_bells', 'Tubular Bells'],
  ['dulcimer', 'Dulcimer'],
  // Organ (16-23)
  ['drawbar_organ', 'Drawbar Organ'],
  ['percussive_organ', 'Percussive Organ'],
  ['rock_organ', 'Rock Organ'],
  ['church_organ', 'Church Organ'],
  ['reed_organ', 'Reed Organ'],
  ['accordion', 'Accordion'],
  ['harmonica', 'Harmonica'],
  ['tango_accordion', 'Tango Accordion'],
  // Guitar (24-31)
  ['acoustic_guitar_nylon', 'Acoustic Guitar (nylon)'],
  ['acoustic_guitar_steel', 'Acoustic Guitar (steel)'],
  ['electric_guitar_jazz', 'Electric Guitar (jazz)'],
  ['electric_guitar_clean', 'Electric Guitar (clean)'],
  ['electric_guitar_muted', 'Electric Guitar (muted)'],
  ['overdriven_guitar', 'Overdriven Guitar'],
  ['distortion_guitar', 'Distortion Guitar'],
  ['guitar_harmonics', 'Guitar Harmonics'],
  // Bass (32-39)
  ['acoustic_bass', 'Acoustic Bass'],
  ['electric_bass_finger', 'Electric Bass (finger)'],
  ['electric_bass_pick', 'Electric Bass (pick)'],
  ['fretless_bass', 'Fretless Bass'],
  ['slap_bass_1', 'Slap Bass 1'],
  ['slap_bass_2', 'Slap Bass 2'],
  ['synth_bass_1', 'Synth Bass 1'],
  ['synth_bass_2', 'Synth Bass 2'],
  // Strings (40-47)
  ['violin', 'Violin'],
  ['viola', 'Viola'],
  ['cello', 'Cello'],
  ['contrabass', 'Contrabass'],
  ['tremolo_strings', 'Tremolo Strings'],
  ['pizzicato_strings', 'Pizzicato Strings'],
  ['orchestral_harp', 'Orchestral Harp'],
  ['timpani', 'Timpani'],
  // Ensemble (48-55)
  ['string_ensemble_1', 'String Ensemble 1'],
  ['string_ensemble_2', 'String Ensemble 2'],
  ['synth_strings_1', 'Synth Strings 1'],
  ['synth_strings_2', 'Synth Strings 2'],
  ['choir_aahs', 'Choir Aahs'],
  ['voice_oohs', 'Voice Oohs'],
  ['synth_choir', 'Synth Voice'],
  ['orchestra_hit', 'Orchestra Hit'],
  // Brass (56-63)
  ['trumpet', 'Trumpet'],
  ['trombone', 'Trombone'],
  ['tuba', 'Tuba'],
  ['muted_trumpet', 'Muted Trumpet'],
  ['french_horn', 'French Horn'],
  ['brass_section', 'Brass Section'],
  ['synth_brass_1', 'Synth Brass 1'],
  ['synth_brass_2', 'Synth Brass 2'],
  // Reed (64-71)
  ['soprano_sax', 'Soprano Sax'],
  ['alto_sax', 'Alto Sax'],
  ['tenor_sax', 'Tenor Sax'],
  ['baritone_sax', 'Baritone Sax'],
  ['oboe', 'Oboe'],
  ['english_horn', 'English Horn'],
  ['bassoon', 'Bassoon'],
  ['clarinet', 'Clarinet'],
  // Pipe (72-79)
  ['piccolo', 'Piccolo'],
  ['flute', 'Flute'],
  ['recorder', 'Recorder'],
  ['pan_flute', 'Pan Flute'],
  ['blown_bottle', 'Blown Bottle'],
  ['shakuhachi', 'Shakuhachi'],
  ['whistle', 'Whistle'],
  ['ocarina', 'Ocarina'],
  // Synth Lead (80-87)
  ['lead_1_square', 'Lead 1 (square)'],
  ['lead_2_sawtooth', 'Lead 2 (sawtooth)'],
  ['lead_3_calliope', 'Lead 3 (calliope)'],
  ['lead_4_chiff', 'Lead 4 (chiff)'],
  ['lead_5_charang', 'Lead 5 (charang)'],
  ['lead_6_voice', 'Lead 6 (voice)'],
  ['lead_7_fifths', 'Lead 7 (fifths)'],
  ['lead_8_bass__lead', 'Lead 8 (bass + lead)'],
  // Synth Pad (88-95)
  ['pad_1_new_age', 'Pad 1 (new age)'],
  ['pad_2_warm', 'Pad 2 (warm)'],
  ['pad_3_polysynth', 'Pad 3 (polysynth)'],
  ['pad_4_choir', 'Pad 4 (choir)'],
  ['pad_5_bowed', 'Pad 5 (bowed)'],
  ['pad_6_metallic', 'Pad 6 (metallic)'],
  ['pad_7_halo', 'Pad 7 (halo)'],
  ['pad_8_sweep', 'Pad 8 (sweep)'],
  // Synth Effects (96-103)
  ['fx_1_rain', 'FX 1 (rain)'],
  ['fx_2_soundtrack', 'FX 2 (soundtrack)'],
  ['fx_3_crystal', 'FX 3 (crystal)'],
  ['fx_4_atmosphere', 'FX 4 (atmosphere)'],
  ['fx_5_brightness', 'FX 5 (brightness)'],
  ['fx_6_goblins', 'FX 6 (goblins)'],
  ['fx_7_echoes', 'FX 7 (echoes)'],
  ['fx_8_scifi', 'FX 8 (sci-fi)'],
  // Ethnic (104-111)
  ['sitar', 'Sitar'],
  ['banjo', 'Banjo'],
  ['shamisen', 'Shamisen'],
  ['koto', 'Koto'],
  ['kalimba', 'Kalimba'],
  ['bagpipe', 'Bag pipe'],
  ['fiddle', 'Fiddle'],
  ['shanai', 'Shanai'],
  // Percussive (112-119)
  ['tinkle_bell', 'Tinkle Bell'],
  ['agogo', 'Agogo'],
  ['steel_drums', 'Steel Drums'],
  ['woodblock', 'Woodblock'],
  ['taiko_drum', 'Taiko Drum'],
  ['melodic_tom', 'Melodic Tom'],
  ['synth_drum', 'Synth Drum'],
  ['reverse_cymbal', 'Reverse Cymbal'],
  // Sound Effects (120-127)
  ['guitar_fret_noise', 'Guitar Fret Noise'],
  ['breath_noise', 'Breath Noise'],
  ['seashore', 'Seashore'],
  ['bird_tweet', 'Bird Tweet'],
  ['telephone_ring', 'Telephone Ring'],
  ['helicopter', 'Helicopter'],
  ['applause', 'Applause'],
  ['gunshot', 'Gunshot'],
];

/** All 128 GM melodic sounds, in program order. */
export const GM_INSTRUMENTS: GmInstrument[] = GM_NAMES.map(([id, label], program) => ({
  id,
  label,
  // Eight programs per family, in order — that is how GM is laid out.
  family: GM_FAMILIES[Math.floor(program / 8)],
}));

/** The sound a new instrument starts on. */
export const DEFAULT_INSTRUMENT_ID = 'acoustic_grand_piano';

const PROGRAM_BY_ID = new Map(GM_INSTRUMENTS.map((entry, program) => [entry.id, program]));

/**
 * The GM program number (0-127) for a sound id, for the MIDI exporter.
 *
 * Unknown ids — including the empty string a pre-instruments file leaves behind —
 * fall back to program 0, the acoustic grand, which is what those files sounded like.
 */
export function gmProgramNumber(instrumentId: string): number {
  return PROGRAM_BY_ID.get(instrumentId) ?? 0;
}

/**
 * The sound id for a GM program number, for the MIDI importer.
 *
 * Out-of-range programs fall back to the acoustic grand rather than throwing: a
 * malformed file should still open.
 */
export function gmInstrumentId(program: number): string {
  return GM_INSTRUMENTS[program]?.id ?? DEFAULT_INSTRUMENT_ID;
}

/** The catalogue entry for a sound id, if it names one. */
export function gmInstrument(instrumentId: string): GmInstrument | undefined {
  const program = PROGRAM_BY_ID.get(instrumentId);
  return program === undefined ? undefined : GM_INSTRUMENTS[program];
}

/** Display name for a sound id, falling back to the id itself. */
export function gmLabel(instrumentId: string): string {
  return gmInstrument(instrumentId)?.label ?? instrumentId;
}

/** The catalogue grouped by family, in GM order — the shape the picker renders. */
export function gmInstrumentsByFamily(): Array<{ family: string; instruments: GmInstrument[] }> {
  return GM_FAMILIES.map(family => ({
    family,
    instruments: GM_INSTRUMENTS.filter(entry => entry.family === family),
  }));
}
