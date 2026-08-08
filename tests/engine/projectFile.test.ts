import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  autosaveRef,
  canPickFiles,
  canQuickSave,
  ensureWritable,
  fileLabel,
  isReusable,
  pickOpenRef,
  pickSaveRef,
  readRef,
  writeRef,
  type ProjectFileRef,
} from '@/engine/projectFile';

/** Pretend to be the desktop build, which is what `isTauri()` reads. */
function asTauri(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

function asBrowser(): void {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

function stubPicker(name: keyof Window & string, value: unknown): void {
  (window as unknown as Record<string, unknown>)[name] = value;
}

function clearPickers(): void {
  delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
  delete (window as unknown as Record<string, unknown>).showOpenFilePicker;
}

/** A writable file handle, of which jsdom has no notion whatsoever. */
function fakeHandle(name = 'song.json', contents = '{}') {
  const written: string[] = [];
  return {
    written,
    handle: {
      name,
      createWritable: async () => ({
        write: async (blob: Blob) => void written.push(await blob.text()),
        close: async () => {},
      }),
      getFile: async () => new File([contents], name, { type: 'application/json' }),
    } as unknown as FileSystemFileHandle,
  };
}

describe('projectFile', () => {
  beforeEach(() => {
    asBrowser();
    clearPickers();
  });

  afterEach(() => {
    asBrowser();
    clearPickers();
    vi.restoreAllMocks();
  });

  describe('capabilities', () => {
    it('reports no quick save in a browser without the picker', () => {
      expect(canQuickSave()).toBe(false);
      expect(canPickFiles()).toBe(false);
    });

    it('reports quick save once the picker exists', () => {
      stubPicker('showSaveFilePicker', vi.fn());
      stubPicker('showOpenFilePicker', vi.fn());
      expect(canQuickSave()).toBe(true);
      expect(canPickFiles()).toBe(true);
    });

    it('reports both on the desktop, which has its own dialogs', () => {
      asTauri();
      expect(canQuickSave()).toBe(true);
      expect(canPickFiles()).toBe(true);
    });
  });

  describe('isReusable', () => {
    it('accepts a path and a handle but not a download', () => {
      expect(isReusable({ kind: 'path', path: 'C:/x/song.json' })).toBe(true);
      expect(isReusable({ kind: 'handle', handle: fakeHandle().handle })).toBe(true);
      expect(isReusable({ kind: 'download', name: 'song.json' })).toBe(false);
      expect(isReusable(null)).toBe(false);
    });
  });

  describe('fileLabel', () => {
    it('takes the last segment of a path, either slash', () => {
      expect(fileLabel({ kind: 'path', path: 'C:\\songs\\ballad.json' })).toBe('ballad.json');
      expect(fileLabel({ kind: 'path', path: '/home/x/ballad.json' })).toBe('ballad.json');
    });

    it('uses a handle’s own name', () => {
      expect(fileLabel({ kind: 'handle', handle: fakeHandle('tune.json').handle })).toBe('tune.json');
    });
  });

  describe('autosaveRef', () => {
    it('puts the sidecar beside the project file', () => {
      expect(autosaveRef({ kind: 'path', path: 'C:/x/song.json' })).toEqual({
        kind: 'path',
        path: 'C:/x/song.autosave.json',
      });
    });

    it('appends to a path that has no extension', () => {
      expect(autosaveRef({ kind: 'path', path: 'C:/x/song' })).toEqual({
        kind: 'path',
        path: 'C:/x/song.autosave.json',
      });
    });

    it('has nowhere to put one in the browser', () => {
      // A file handle cannot address its siblings, so the caller falls back to
      // localStorage rather than prompting for a whole directory.
      expect(autosaveRef({ kind: 'handle', handle: fakeHandle().handle })).toBeNull();
      expect(autosaveRef({ kind: 'download', name: 'song.json' })).toBeNull();
      expect(autosaveRef(null)).toBeNull();
    });
  });

  describe('pickSaveRef', () => {
    it('returns a handle reference when the user picks a file', async () => {
      const { handle } = fakeHandle('picked.json');
      stubPicker('showSaveFilePicker', vi.fn().mockResolvedValue(handle));

      const ref = await pickSaveRef('song.json');
      expect(ref).toEqual({ kind: 'handle', handle });
    });

    it('returns null — and downloads nothing — when the user cancels', async () => {
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      stubPicker(
        'showSaveFilePicker',
        vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError'))
      );

      expect(await pickSaveRef('song.json')).toBeNull();
      expect(click).not.toHaveBeenCalled();
    });

    it('falls back to a download when the browser has no picker at all', async () => {
      expect(await pickSaveRef('song.json')).toEqual({ kind: 'download', name: 'song.json' });
    });
  });

  describe('pickOpenRef', () => {
    it('returns null when the user cancels', async () => {
      stubPicker(
        'showOpenFilePicker',
        vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError'))
      );
      expect(await pickOpenRef()).toBeNull();
    });

    it('returns null when there is no picker to open', async () => {
      expect(await pickOpenRef()).toBeNull();
    });
  });

  describe('writeRef and readRef', () => {
    it('round-trips through a file handle', async () => {
      const { handle, written } = fakeHandle('song.json', '{"name":"on disk"}');
      const ref: ProjectFileRef = { kind: 'handle', handle };

      await writeRef(ref, '{"name":"written"}');
      expect(written).toEqual(['{"name":"written"}']);
      expect(await readRef(ref)).toBe('{"name":"on disk"}');
    });

    it('sends a download reference to the Downloads folder', async () => {
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      global.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock') as never;
      global.URL.revokeObjectURL = vi.fn() as never;

      await writeRef({ kind: 'download', name: 'song.json' }, '{}');
      expect(click).toHaveBeenCalled();
    });

    it('cannot read a download back', async () => {
      await expect(readRef({ kind: 'download', name: 'song.json' })).rejects.toThrow();
    });
  });

  describe('ensureWritable', () => {
    it('is false for a download, which names nothing writable', async () => {
      expect(await ensureWritable({ kind: 'download', name: 'song.json' })).toBe(false);
    });

    it('asks for permission when a restored handle does not have it', async () => {
      const requestPermission = vi.fn().mockResolvedValue('granted');
      const handle = {
        name: 'song.json',
        queryPermission: vi.fn().mockResolvedValue('prompt'),
        requestPermission,
      } as unknown as FileSystemFileHandle;

      expect(await ensureWritable({ kind: 'handle', handle })).toBe(true);
      expect(requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
    });

    it('is false when the user refuses', async () => {
      const handle = {
        name: 'song.json',
        queryPermission: vi.fn().mockResolvedValue('prompt'),
        requestPermission: vi.fn().mockResolvedValue('denied'),
      } as unknown as FileSystemFileHandle;

      expect(await ensureWritable({ kind: 'handle', handle })).toBe(false);
    });

    it('does not ask again once permission is granted', async () => {
      const requestPermission = vi.fn();
      const handle = {
        name: 'song.json',
        queryPermission: vi.fn().mockResolvedValue('granted'),
        requestPermission,
      } as unknown as FileSystemFileHandle;

      expect(await ensureWritable({ kind: 'handle', handle })).toBe(true);
      expect(requestPermission).not.toHaveBeenCalled();
    });
  });
});
