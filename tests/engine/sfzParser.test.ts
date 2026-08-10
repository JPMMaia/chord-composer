import { describe, it, expect } from 'vitest';
import {
  parseKey,
  parseSfz,
  sampleKey,
  sfzSamples,
  sfzToPreset,
  type ParsedSfz,
} from '@/engine/sfzParser';

/**
 * The head of the real freepats ocarina, verbatim — the file this feature was built
 * for. Worth carrying literally rather than paraphrasing: it is the one sample of the
 * format that is known to exist in the wild in exactly this shape, including the `//+`
 * metadata header, the `#` in a file name, and inheritance from both `<global>` and
 * `<group>`.
 */
const OCARINA = `//+ Name: Ocarina
//+ Date: 2024-10-02
//+ URL: http://freepats.zenvoid.org/Wind/ocarina.html#Ocarina1

<global>
 ampeg_release=0.4

<group>
 loop_mode=loop_continuous
<region>
 lokey=60 hikey=70
 pitch_keycenter=66
 loop_start=14805 loop_end=45027
 sample=samples/F#4.wav
<region>
 key=76
 loop_start=16668 loop_end=63256
 sample=samples/E5_01.wav
<region>
 lokey=86 hikey=92
 pitch_keycenter=88
 loop_start=3797 loop_end=62613
 sample=samples/E6.wav
`;

/** The regions of a parse, by the sample each names. */
const bySample = (parsed: ParsedSfz) =>
  Object.fromEntries(parsed.regions.map(r => [r.sample, r]));

/** The ocarina's samples are 48 kHz; `unknownRate` stands for an unreadable header. */
const RATE = 48000;
const unknownRate = () => undefined;

const preset = (parsed: ParsedSfz, sampleRate: () => number | undefined = () => RATE) =>
  sfzToPreset(parsed, { baseUrl: 'C:/lib/Ocarina', sampleRate });

const regions = (parsed: ParsedSfz, sampleRate?: () => number | undefined) =>
  preset(parsed, sampleRate).groups[0].regions;

describe('parseSfz', () => {
  it('lifts the name out of the //+ header', () => {
    expect(parseSfz(OCARINA).name).toBe('Ocarina');
  });

  it('has no name when the file carries no header', () => {
    expect(parseSfz('<region> sample=a.wav').name).toBeUndefined();
  });

  it('reads every region of the real file', () => {
    const parsed = parseSfz(OCARINA);
    expect(parsed.regions).toHaveLength(3);
    expect(sfzSamples(parsed)).toEqual([
      'samples/F#4.wav',
      'samples/E5_01.wav',
      'samples/E6.wav',
    ]);
  });

  it('inherits ampeg_release from <global> and loop_mode from <group>', () => {
    for (const region of parseSfz(OCARINA).regions) {
      expect(region.ampegRelease).toBe(0.4);
      expect(region.loop).toBe(true);
    }
  });

  it('keeps lokey, hikey and an explicit pitch_keycenter apart', () => {
    const region = bySample(parseSfz(OCARINA))['samples/F#4.wav'];
    expect(region.loKey).toBe(60);
    expect(region.hiKey).toBe(70);
    expect(region.pitchKeyCenter).toBe(66);
  });

  it('reads loop points as the frames SFZ states', () => {
    const region = bySample(parseSfz(OCARINA))['samples/E6.wav'];
    expect(region.loopStartFrames).toBe(3797);
    expect(region.loopEndFrames).toBe(62613);
  });

  it('lets key= set the range and the centre together', () => {
    const region = bySample(parseSfz(OCARINA))['samples/E5_01.wav'];
    expect(region.loKey).toBe(76);
    expect(region.hiKey).toBe(76);
    expect(region.pitchKeyCenter).toBe(76);
  });

  it("defaults a region's own opcodes over the ones it inherits", () => {
    const parsed = parseSfz(`
      <global> volume=-6 ampeg_release=1
      <group> volume=-3
      <region> sample=a.wav ampeg_release=0.2
    `);
    expect(parsed.regions[0].volume).toBe(-3);
    expect(parsed.regions[0].ampegRelease).toBe(0.2);
  });

  it('does not carry one group\u2019s opcodes into the next', () => {
    const parsed = parseSfz(`
      <group> volume=-6
      <region> sample=a.wav
      <group>
      <region> sample=b.wav
    `);
    expect(parsed.regions[0].volume).toBe(-6);
    expect(parsed.regions[1].volume).toBeUndefined();
  });

  it('accepts note names as well as numbers for keys', () => {
    const parsed = parseSfz('<region> sample=a.wav lokey=c4 hikey=f#5 pitch_keycenter=Bb3');
    expect(parsed.regions[0]).toMatchObject({ loKey: 60, hiKey: 78, pitchKeyCenter: 58 });
  });

  it('covers the whole keyboard when no key opcode says otherwise', () => {
    const parsed = parseSfz('<region> sample=a.wav');
    // The spec's default centre is 60 even when the range is everything.
    expect(parsed.regions[0]).toMatchObject({ loKey: 0, hiKey: 127, pitchKeyCenter: 60 });
  });

  it('reads several opcodes from one line', () => {
    const parsed = parseSfz('<region> lokey=60 hikey=72 sample=a.wav');
    expect(parsed.regions[0]).toMatchObject({ loKey: 60, hiKey: 72, sample: 'a.wav' });
  });

  it('keeps the spaces in a sample name', () => {
    const parsed = parseSfz('<region> sample=my long name.wav lokey=60');
    expect(parsed.regions[0].sample).toBe('my long name.wav');
  });

  it('normalises backslashes in sample paths', () => {
    expect(parseSfz('<region> sample=samples\\F#4.wav').regions[0].sample).toBe(
      'samples/F#4.wav'
    );
  });

  it('prepends the <control> default_path', () => {
    const parsed = parseSfz('<control> default_path=samples/\n<region> sample=F#4.wav');
    expect(parsed.regions[0].sample).toBe('samples/F#4.wav');
  });

  it('ignores opcodes it does not implement', () => {
    const parsed = parseSfz('<region> sample=a.wav cutoff=800 fil_type=lpf_2p seq_position=1');
    expect(parsed.regions).toHaveLength(1);
    expect(parsed.regions[0].sample).toBe('a.wav');
  });

  it('drops the opcodes of headers it does not implement', () => {
    const parsed = parseSfz(`
      <region> sample=a.wav
      <effect> volume=-96
      <region> sample=b.wav
    `);
    expect(parsed.regions.map(r => r.volume)).toEqual([undefined, undefined]);
  });

  it('skips a region that names no sample', () => {
    expect(parseSfz('<region> lokey=60 hikey=72').regions).toHaveLength(0);
  });

  it('reads an empty file as no regions', () => {
    expect(parseSfz('').regions).toHaveLength(0);
  });

  it('strips // comments and /* */ blocks', () => {
    const parsed = parseSfz(`
      // <region> sample=commented-out.wav
      /* <region> sample=also-not-real.wav */
      <region> sample=real.wav // trailing
    `);
    expect(sfzSamples(parsed)).toEqual(['real.wav']);
  });

  it('treats loop_mode=no_loop as no loop, even with loop points', () => {
    const parsed = parseSfz('<region> sample=a.wav loop_mode=no_loop loop_start=1 loop_end=2');
    expect(parsed.regions[0].loop).toBe(false);
  });

  it('takes loop points alone as intent to loop', () => {
    const parsed = parseSfz('<region> sample=a.wav loop_start=1 loop_end=2');
    expect(parsed.regions[0].loop).toBe(true);
  });
});

describe('parseKey', () => {
  it('reads plain MIDI numbers', () => {
    expect(parseKey('60')).toBe(60);
    expect(parseKey('0')).toBe(0);
  });

  it('reads note names, with C4 as middle C', () => {
    expect(parseKey('c4')).toBe(60);
    expect(parseKey('C-1')).toBe(0);
    expect(parseKey('a4')).toBe(69);
    expect(parseKey('g9')).toBe(127);
  });

  it('reads accidentals both ways', () => {
    expect(parseKey('c#4')).toBe(61);
    expect(parseKey('db4')).toBe(61);
  });

  it('answers undefined for anything else', () => {
    expect(parseKey(undefined)).toBeUndefined();
    expect(parseKey('loud')).toBeUndefined();
  });
});

describe('sfzToPreset', () => {
  it('declares the directory and the wav format', () => {
    const built = preset(parseSfz(OCARINA));
    expect(built.samples.baseUrl).toBe('C:/lib/Ocarina');
    expect(built.samples.formats).toEqual(['wav']);
  });

  it('carries the instrument name into the preset meta', () => {
    expect(preset(parseSfz(OCARINA)).meta?.name).toBe('Ocarina');
  });

  it('puts every region in one group', () => {
    const built = preset(parseSfz(OCARINA));
    expect(built.groups).toHaveLength(1);
    expect(built.groups[0].regions).toHaveLength(3);
  });

  it('strips the extension from sample names, since smplr appends the format', () => {
    expect(regions(parseSfz(OCARINA))[0].sample).toBe('samples/F#4');
    expect(sampleKey('samples/F#4.wav')).toBe('samples/F#4');
  });

  it('states the range and the centre separately, never smplr\u2019s key', () => {
    // `key` would make smplr discard `pitch`, mistuning any region whose centre is
    // not its own lowest note.
    const region = regions(parseSfz(OCARINA))[1];
    expect(region.keyRange).toEqual([76, 76]);
    expect(region.pitch).toBe(76);
    expect(region.key).toBeUndefined();
  });

  it('converts loop frames to seconds at the file\u2019s own rate', () => {
    const region = regions(parseSfz(OCARINA))[0];
    expect(region.loop).toBe(true);
    expect(region.loopStart).toBeCloseTo(14805 / 48000, 10);
    // SFZ's loop_end is the last frame inside the loop; Web Audio jumps back one later.
    expect(region.loopEnd).toBeCloseTo(45028 / 48000, 10);
  });

  it('plays through rather than looping at the wrong point when the rate is unknown', () => {
    const region = regions(parseSfz(OCARINA), unknownRate)[0];
    expect(region.loop).toBeUndefined();
    expect(region.loopStart).toBeUndefined();
    expect(region.loopEnd).toBeUndefined();
  });

  it('maps the amplitude envelope onto smplr\u2019s', () => {
    const parsed = parseSfz('<region> sample=a.wav ampeg_attack=0.01 ampeg_release=0.4');
    expect(regions(parsed)[0]).toMatchObject({ ampAttack: 0.01, ampRelease: 0.4 });
  });

  it('passes volume through as decibels and tune as cents', () => {
    const parsed = parseSfz('<region> sample=a.wav volume=-6 tune=-50 transpose=12');
    expect(regions(parsed)[0]).toMatchObject({ volume: -6, detune: -50, tune: 12 });
  });

  it('converts the sample offset to seconds too', () => {
    const parsed = parseSfz('<region> sample=a.wav offset=2400');
    expect(regions(parsed)[0].offset).toBeCloseTo(0.05, 10);
  });

  it('carries the velocity range', () => {
    const parsed = parseSfz('<region> sample=a.wav lovel=64 hivel=100');
    expect(regions(parsed)[0].velRange).toEqual([64, 100]);
  });
});
