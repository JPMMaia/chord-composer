import { describe, it, expect } from 'vitest';
import {
  isSfzRef,
  isVst3Ref,
  parseInstrumentRef,
  sfzRef,
  vst3Ref,
} from '@/engine/instrumentRef';
import { DEFAULT_INSTRUMENT_ID, GM_INSTRUMENTS } from '@/engine/instrumentCatalog';

/** A syntactically valid VST3 class id: the 16-byte TUID as 32 hex characters. */
const CID = '565354416d736e6f53757267652058';
const VALID_CID = '565354416d736e6f53757267652058ab';

describe('parseInstrumentRef', () => {
  it('reads a bare General MIDI id as GM', () => {
    expect(parseInstrumentRef('acoustic_grand_piano')).toEqual({
      kind: 'gm',
      instrumentId: 'acoustic_grand_piano',
    });
  });

  // Every project file ever written stores the bare form, so this is the
  // compatibility guarantee the whole namespace design rests on.
  it('reads every catalogue id as GM', () => {
    for (const entry of GM_INSTRUMENTS) {
      expect(parseInstrumentRef(entry.id).kind).toBe('gm');
    }
  });

  // Files written before instruments could choose a sound leave this behind.
  it('reads the empty string as GM', () => {
    expect(parseInstrumentRef('')).toEqual({ kind: 'gm', instrumentId: '' });
  });

  it('reads a prefixed class id as VST3', () => {
    expect(parseInstrumentRef(`vst3:${VALID_CID}`)).toEqual({
      kind: 'vst3',
      classId: VALID_CID,
    });
  });

  it('lower-cases a class id spelled in upper case', () => {
    expect(parseInstrumentRef(`vst3:${VALID_CID.toUpperCase()}`)).toEqual({
      kind: 'vst3',
      classId: VALID_CID,
    });
  });

  it('strips the hyphens of a dashed class id', () => {
    // Derived from VALID_CID rather than spelled out, so the two cannot drift.
    const c = VALID_CID;
    const dashed = `${c.slice(0, 8)}-${c.slice(8, 12)}-${c.slice(12, 16)}-${c.slice(16, 20)}-${c.slice(20)}`;
    expect(parseInstrumentRef(`vst3:${dashed}`)).toEqual({
      kind: 'vst3',
      classId: VALID_CID,
    });
  });

  // A damaged or hand-edited file should still open; the GM layer then resolves
  // the unrecognised id to the acoustic grand.
  describe('malformed VST3 refs fall back to GM rather than throwing', () => {
    const bad = [
      'vst3:',
      `vst3:${CID}`, // 30 chars — too short
      `vst3:${VALID_CID}ff`, // too long
      'vst3:zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', // not hex
      'vst3:not-a-class-id',
    ];

    for (const instrument of bad) {
      it(`${JSON.stringify(instrument)}`, () => {
        expect(parseInstrumentRef(instrument)).toEqual({ kind: 'gm', instrumentId: instrument });
      });
    }
  });
});

describe('vst3Ref', () => {
  it('round-trips through parseInstrumentRef', () => {
    expect(parseInstrumentRef(vst3Ref(VALID_CID))).toEqual({
      kind: 'vst3',
      classId: VALID_CID,
    });
  });

  it('normalises case and hyphens so the same plugin yields one id', () => {
    expect(vst3Ref(VALID_CID.toUpperCase())).toBe(vst3Ref(VALID_CID));
  });
});

describe('isVst3Ref', () => {
  it('is false for GM ids', () => {
    expect(isVst3Ref(DEFAULT_INSTRUMENT_ID)).toBe(false);
    expect(isVst3Ref('')).toBe(false);
  });

  it('is true for the prefixed form', () => {
    expect(isVst3Ref(vst3Ref(VALID_CID))).toBe(true);
  });

  // Deliberately a prefix test and not a validity test: the two questions have
  // different callers, and `parseInstrumentRef` is the one that validates.
  it('is true for a malformed ref that still carries the prefix', () => {
    expect(isVst3Ref('vst3:garbage')).toBe(true);
  });
});

/** A real library path: spaces, a drive letter, backslashes, and a `+`. */
const OCARINA = 'C:\\Users\\JPMMa\\Documents\\SFZ\\Ocarina SFZ+WAV-20241002\\Ocarina.sfz';

describe('sfzRef', () => {
  it('round-trips through parseInstrumentRef', () => {
    expect(parseInstrumentRef(sfzRef(OCARINA))).toEqual({ kind: 'sfz', path: OCARINA });
  });

  // Unlike a class id there is nothing to normalise, and touching the path would
  // break every filesystem that distinguishes case.
  it('keeps the path exactly as the OS gave it', () => {
    expect(sfzRef(OCARINA)).toBe(`sfz:${OCARINA}`);
    expect(parseInstrumentRef(sfzRef('/home/jp/Lib/A.sfz'))).toEqual({
      kind: 'sfz',
      path: '/home/jp/Lib/A.sfz',
    });
  });

  it('keeps a colon in the path, which every Windows path has', () => {
    expect(parseInstrumentRef('sfz:C:/lib/a.sfz')).toEqual({
      kind: 'sfz',
      path: 'C:/lib/a.sfz',
    });
  });

  // Same posture as a malformed class id: a hand-edited file should still open.
  it('falls back to GM for a prefix naming no file', () => {
    expect(parseInstrumentRef('sfz:')).toEqual({ kind: 'gm', instrumentId: 'sfz:' });
  });
});

describe('isSfzRef', () => {
  it('is false for GM ids and plugins', () => {
    expect(isSfzRef(DEFAULT_INSTRUMENT_ID)).toBe(false);
    expect(isSfzRef('')).toBe(false);
    expect(isSfzRef(vst3Ref(VALID_CID))).toBe(false);
  });

  it('is true for the prefixed form', () => {
    expect(isSfzRef(sfzRef(OCARINA))).toBe(true);
  });
});
