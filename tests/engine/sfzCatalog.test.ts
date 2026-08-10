import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The dialog is native, and so is reading the file the dialog returns.
const open = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/plugin-dialog', () => ({ open }));

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
  forgetSfzInstrument,
  listSfzInstruments,
  pickSfzFile,
  rememberSfzInstrument,
  resetSfzCatalog,
  sfzNameFor,
  sfzOption,
} from '@/engine/sfzCatalog';

const MARKER = '__TAURI_INTERNALS__';
const OCARINA = 'C:\\Users\\JPMMa\\Documents\\SFZ\\Ocarina\\Ocarina 20241002.sfz';

const asDesktop = () => {
  (window as unknown as Record<string, unknown>)[MARKER] = {};
};

beforeEach(() => {
  resetSfzCatalog();
  open.mockReset();
  invoke.mockReset();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[MARKER];
});

describe('remembering instruments', () => {
  it('starts with nothing', () => {
    expect(listSfzInstruments()).toEqual([]);
  });

  it('lists what it was told, most recent first', () => {
    rememberSfzInstrument({ path: 'C:/a.sfz', name: 'A' });
    rememberSfzInstrument({ path: 'C:/b.sfz', name: 'B' });

    expect(listSfzInstruments()).toEqual([
      { path: 'C:/b.sfz', name: 'B' },
      { path: 'C:/a.sfz', name: 'A' },
    ]);
  });

  it('moves a path already known to the front rather than listing it twice', () => {
    rememberSfzInstrument({ path: 'C:/a.sfz', name: 'A' });
    rememberSfzInstrument({ path: 'C:/b.sfz', name: 'B' });
    rememberSfzInstrument({ path: 'C:/a.sfz', name: 'A' });

    expect(listSfzInstruments().map(i => i.path)).toEqual(['C:/a.sfz', 'C:/b.sfz']);
  });

  it('treats a path differing only in case as the same file', () => {
    rememberSfzInstrument({ path: 'C:/Lib/A.sfz', name: 'A' });
    rememberSfzInstrument({ path: 'c:/lib/a.sfz', name: 'A' });

    expect(listSfzInstruments()).toHaveLength(1);
  });

  it('forgets one without touching the others', () => {
    rememberSfzInstrument({ path: 'C:/a.sfz', name: 'A' });
    rememberSfzInstrument({ path: 'C:/b.sfz', name: 'B' });

    forgetSfzInstrument('C:/a.sfz');

    expect(listSfzInstruments().map(i => i.path)).toEqual(['C:/b.sfz']);
  });

  it('reads a corrupt list as an empty one rather than throwing', () => {
    localStorage.setItem('chord-composer-sfz-instruments-v1', '{not json');

    expect(listSfzInstruments()).toEqual([]);
  });

  it('drops entries a different build may have written', () => {
    localStorage.setItem(
      'chord-composer-sfz-instruments-v1',
      JSON.stringify([{ path: 'C:/a.sfz', name: 'A' }, 'nonsense', { path: 7 }])
    );

    expect(listSfzInstruments()).toEqual([{ path: 'C:/a.sfz', name: 'A' }]);
  });
});

describe('naming', () => {
  it('prefers the name the instrument was remembered under', () => {
    rememberSfzInstrument({ path: OCARINA, name: 'Ocarina' });

    expect(sfzNameFor(OCARINA)).toBe('Ocarina');
  });

  it('falls back to the file name for a path it has never seen', () => {
    expect(sfzNameFor(OCARINA)).toBe('Ocarina 20241002');
  });

  it('builds the picker entry from the ref and the name', () => {
    expect(sfzOption({ path: 'C:/a.sfz', name: 'A' })).toEqual({
      value: 'sfz:C:/a.sfz',
      label: 'A',
    });
  });
});

describe('pickSfzFile', () => {
  it('takes the name out of the file\u2019s //+ header', async () => {
    asDesktop();
    open.mockResolvedValue(OCARINA);
    invoke.mockResolvedValue('//+ Name: Ocarina\n<region> sample=a.wav');

    await expect(pickSfzFile()).resolves.toEqual({ path: OCARINA, name: 'Ocarina' });
    expect(listSfzInstruments()).toEqual([{ path: OCARINA, name: 'Ocarina' }]);
  });

  it('falls back to the file name when the file names itself nothing', async () => {
    asDesktop();
    open.mockResolvedValue(OCARINA);
    invoke.mockResolvedValue('<region> sample=a.wav');

    await expect(pickSfzFile()).resolves.toEqual({ path: OCARINA, name: 'Ocarina 20241002' });
  });

  it('still remembers the file when it cannot be read', async () => {
    asDesktop();
    open.mockResolvedValue(OCARINA);
    invoke.mockRejectedValue(new Error('busy'));

    await expect(pickSfzFile()).resolves.toEqual({ path: OCARINA, name: 'Ocarina 20241002' });
  });

  it('answers null when the dialog is cancelled, and remembers nothing', async () => {
    asDesktop();
    open.mockResolvedValue(null);

    await expect(pickSfzFile()).resolves.toBeNull();
    expect(listSfzInstruments()).toEqual([]);
  });

  it('answers null in a browser build without opening anything', async () => {
    await expect(pickSfzFile()).resolves.toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
});
