/**
 * The one number a WAV header is needed for: its sample rate.
 *
 * SFZ states loop points as frame indices — `loop_start=14805` is the 14805th sample —
 * while Web Audio's `AudioBufferSourceNode.loopStart` is a time in seconds. Converting
 * between them needs the rate the file was recorded at, and that is known long before
 * the file is decoded: it sits in the `fmt ` chunk, a few dozen bytes in.
 *
 * Reading it here rather than waiting for `decodeAudioData` is what lets the whole
 * preset be built up front, in one pass over bytes that have already been read.
 *
 * The parse walks the RIFF chunk list rather than assuming `fmt ` comes first. It
 * usually does, but a file carrying a `LIST`/`INFO` credits block ahead of it is
 * perfectly legal and not rare — and a wrong guess here would silently mistune every
 * loop in the instrument.
 */

/** Byte length of a chunk's `id` + `size` fields. */
const CHUNK_HEADER = 8;

/**
 * The sample rate declared by a WAV file, or `undefined` if the bytes are not a WAV,
 * are truncated, or carry no `fmt ` chunk.
 *
 * `undefined` is a normal answer, not a failure: a caller that cannot find the rate
 * plays the sample without looping, which is worse but still music.
 */
export function wavSampleRate(bytes: ArrayBuffer): number | undefined {
  const view = new DataView(bytes);

  // "RIFF" .... "WAVE" — 12 bytes before the first chunk.
  if (view.byteLength < 12) return undefined;
  if (readTag(view, 0) !== 'RIFF' || readTag(view, 8) !== 'WAVE') return undefined;

  let offset = 12;
  while (offset + CHUNK_HEADER <= view.byteLength) {
    const tag = readTag(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + CHUNK_HEADER;

    if (tag === 'fmt ') {
      // formatTag, channels, then the rate — the same layout for PCM and for
      // WAVE_FORMAT_EXTENSIBLE, which only ever adds fields after it.
      if (body + 8 > view.byteLength) return undefined;
      const rate = view.getUint32(body + 4, true);
      return rate > 0 ? rate : undefined;
    }

    // Chunks are padded to an even length, and the pad byte is not counted in `size`.
    offset = body + size + (size % 2);
  }

  return undefined;
}

function readTag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}
