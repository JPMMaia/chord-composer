import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
  directoryOf,
  fileNameOf,
  localFileExists,
  readLocalBytes,
  readLocalText,
  resolvePath,
} from '@/engine/localFile';

const MARKER = '__TAURI_INTERNALS__';

const asDesktop = () => {
  (window as unknown as Record<string, unknown>)[MARKER] = {};
};

beforeEach(() => {
  invoke.mockReset();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[MARKER];
});

describe('path helpers', () => {
  it('finds the directory a file sits in, either separator', () => {
    expect(directoryOf('C:\\lib\\Ocarina\\Ocarina.sfz')).toBe('C:/lib/Ocarina');
    expect(directoryOf('/home/jp/lib/Ocarina.sfz')).toBe('/home/jp/lib');
  });

  it('keeps the root when the file is at it', () => {
    expect(directoryOf('/Ocarina.sfz')).toBe('/');
  });

  it('takes the file name, with or without its extension', () => {
    expect(fileNameOf('C:\\lib\\Ocarina 20241002.sfz')).toBe('Ocarina 20241002.sfz');
    expect(fileNameOf('C:\\lib\\Ocarina 20241002.sfz', true)).toBe('Ocarina 20241002');
  });

  it('resolves a sample against the directory of its instrument', () => {
    expect(resolvePath('C:/lib/Ocarina', 'samples/F#4.wav')).toBe(
      'C:/lib/Ocarina/samples/F#4.wav'
    );
  });

  it('collapses . and .. so a shared sample folder resolves', () => {
    expect(resolvePath('C:/lib/Ocarina', '../shared/a.wav')).toBe('C:/lib/shared/a.wav');
    expect(resolvePath('C:/lib/Ocarina', './samples/a.wav')).toBe('C:/lib/Ocarina/samples/a.wav');
  });

  it('leaves an absolute sample path alone', () => {
    expect(resolvePath('C:/lib/Ocarina', 'D:/other/a.wav')).toBe('D:/other/a.wav');
    expect(resolvePath('C:/lib/Ocarina', '/srv/a.wav')).toBe('/srv/a.wav');
  });

  it('normalises the backslashes a sample path may carry', () => {
    expect(resolvePath('C:/lib/Ocarina', 'samples\\F#4.wav')).toBe(
      'C:/lib/Ocarina/samples/F#4.wav'
    );
  });
});

describe('reading', () => {
  it('reads text through the native command', async () => {
    asDesktop();
    invoke.mockResolvedValue('<region> sample=a.wav');

    await expect(readLocalText('C:/lib/a.sfz')).resolves.toBe('<region> sample=a.wav');
    expect(invoke).toHaveBeenCalledWith('file_read_text', { path: 'C:/lib/a.sfz' });
  });

  it('passes an ArrayBuffer straight through', async () => {
    asDesktop();
    const bytes = Uint8Array.from([1, 2, 3]).buffer;
    invoke.mockResolvedValue(bytes);

    await expect(readLocalBytes('C:/lib/a.wav')).resolves.toBe(bytes);
  });

  it('accepts a number array, which an older bridge answers with', async () => {
    asDesktop();
    invoke.mockResolvedValue([1, 2, 3]);

    const buffer = await readLocalBytes('C:/lib/a.wav');

    expect(new Uint8Array(buffer)).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it('refuses in a browser build rather than answering with nothing', async () => {
    await expect(readLocalText('C:/lib/a.sfz')).rejects.toThrow(/desktop/);
    await expect(readLocalBytes('C:/lib/a.wav')).rejects.toThrow(/desktop/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reports no file in a browser build without asking', async () => {
    await expect(localFileExists('C:/lib/a.sfz')).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('treats a failed existence check as absent', async () => {
    asDesktop();
    invoke.mockRejectedValue(new Error('nope'));

    await expect(localFileExists('C:/lib/a.sfz')).resolves.toBe(false);
  });
});
