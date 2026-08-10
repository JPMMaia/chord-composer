import { describe, it, expect } from 'vitest';
import { wavSampleRate } from '@/engine/wavHeader';

/**
 * Build a RIFF/WAVE file out of chunks.
 *
 * Hand-built rather than read from disk: what is under test is the *walk* — that the
 * parser finds `fmt ` wherever it is rather than at the offset it usually sits at —
 * and that only shows up in files a fixture would not naturally contain.
 */
function wav(chunks: { id: string; body: number[] }[]): ArrayBuffer {
  const bytes: number[] = [];
  const push = (text: string) => bytes.push(...[...text].map(c => c.charCodeAt(0)));
  const pushU32 = (value: number) =>
    bytes.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);

  push('RIFF');
  pushU32(0); // Size of the rest; never read.
  push('WAVE');

  for (const chunk of chunks) {
    push(chunk.id);
    pushU32(chunk.body.length);
    bytes.push(...chunk.body);
    // Chunks pad to an even length, and the pad byte is not counted in the size.
    if (chunk.body.length % 2) bytes.push(0);
  }

  return Uint8Array.from(bytes).buffer;
}

/** A `fmt ` body: PCM, mono, at `rate`, with the trailing fields the spec requires. */
function fmt(rate: number, extra: number[] = []): number[] {
  return [
    0x01, 0x00, // PCM
    0x01, 0x00, // mono
    rate & 0xff, (rate >> 8) & 0xff, (rate >> 16) & 0xff, (rate >> 24) & 0xff,
    0x00, 0x00, 0x00, 0x00, // bytes per second
    0x03, 0x00, // block align
    0x18, 0x00, // bits per sample
    ...extra,
  ];
}

describe('wavSampleRate', () => {
  it('reads the rate of an ordinary file', () => {
    expect(wavSampleRate(wav([{ id: 'fmt ', body: fmt(48000) }]))).toBe(48000);
    expect(wavSampleRate(wav([{ id: 'fmt ', body: fmt(44100) }]))).toBe(44100);
  });

  it('finds fmt behind a LIST chunk', () => {
    const bytes = wav([
      { id: 'LIST', body: [...'INFOhello'].map(c => c.charCodeAt(0)) },
      { id: 'fmt ', body: fmt(48000) },
    ]);
    expect(wavSampleRate(bytes)).toBe(48000);
  });

  it('steps over the pad byte of an odd-sized chunk', () => {
    const bytes = wav([
      { id: 'fact', body: [1, 2, 3] },
      { id: 'fmt ', body: fmt(22050) },
    ]);
    expect(wavSampleRate(bytes)).toBe(22050);
  });

  it('reads WAVE_FORMAT_EXTENSIBLE, whose rate sits in the same place', () => {
    const extensible = wav([{ id: 'fmt ', body: fmt(96000, new Array(24).fill(0)) }]);
    expect(wavSampleRate(extensible)).toBe(96000);
  });

  it('answers undefined for bytes that are not a WAV', () => {
    expect(wavSampleRate(Uint8Array.from([1, 2, 3, 4]).buffer)).toBeUndefined();
    expect(wavSampleRate(new ArrayBuffer(0))).toBeUndefined();
    expect(
      wavSampleRate(Uint8Array.from([...'RIFF____NOPE'].map(c => c.charCodeAt(0))).buffer)
    ).toBeUndefined();
  });

  it('answers undefined when there is no fmt chunk', () => {
    expect(wavSampleRate(wav([{ id: 'data', body: [0, 0, 0, 0] }]))).toBeUndefined();
  });

  it('answers undefined for a truncated fmt chunk rather than reading past the end', () => {
    expect(wavSampleRate(wav([{ id: 'fmt ', body: [1, 0, 1, 0] }]))).toBeUndefined();
  });

  it('stops rather than looping when a chunk size runs past the end', () => {
    // A size field claiming far more than the buffer holds: the walk must terminate.
    const bytes = Uint8Array.from([
      ...[...'RIFF'].map(c => c.charCodeAt(0)),
      0, 0, 0, 0,
      ...[...'WAVE'].map(c => c.charCodeAt(0)),
      ...[...'junk'].map(c => c.charCodeAt(0)),
      0xff, 0xff, 0xff, 0x7f,
    ]).buffer;

    expect(wavSampleRate(bytes)).toBeUndefined();
  });

  it('rejects a rate of zero, which no file was recorded at', () => {
    expect(wavSampleRate(wav([{ id: 'fmt ', body: fmt(0) }]))).toBeUndefined();
  });
});
