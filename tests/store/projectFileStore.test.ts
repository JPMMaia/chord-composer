import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { projectFileStore, isProjectDirty } from '@/store/projectFileStore';
import { projectStore } from '@/store/projectStore';
import type { ProjectFileRef } from '@/engine/projectFile';

const PATH_REF: ProjectFileRef = { kind: 'path', path: 'C:/songs/ballad.json' };

describe('projectFileStore', () => {
  beforeEach(() => {
    projectFileStore.getState().clear();
    projectStore.getState().createProject();
  });

  afterEach(() => {
    projectStore.getState().resetProject();
    projectFileStore.getState().clear();
  });

  it('starts with no file', () => {
    expect(projectFileStore.getState().ref).toBeNull();
    expect(projectFileStore.getState().savedSnapshot).toBeNull();
  });

  it('remembers the file it is told about', () => {
    projectFileStore.getState().setRef(PATH_REF);
    expect(projectFileStore.getState().ref).toEqual(PATH_REF);
  });

  it('forgets everything on clear', () => {
    projectFileStore.getState().setRef(PATH_REF);
    projectFileStore.getState().clear();
    expect(projectFileStore.getState().ref).toBeNull();
    expect(projectFileStore.getState().savedSnapshot).toBeNull();
  });

  it('refuses to adopt a download as the current file', () => {
    const project = projectStore.getState().project!;
    // The bytes left the app, so the project counts as written — but there is no
    // file to go back to, so the next save has to ask again.
    projectFileStore.getState().markSaved(project, { kind: 'download', name: 'song.json' });

    expect(projectFileStore.getState().ref).toBeNull();
    expect(projectFileStore.getState().savedSnapshot).toBe(project);
  });

  describe('isProjectDirty', () => {
    it('is false without a project', () => {
      expect(isProjectDirty(null)).toBe(false);
    });

    it('is true for a project that has never been written', () => {
      expect(isProjectDirty(projectStore.getState().project)).toBe(true);
    });

    it('is false straight after a save', () => {
      const project = projectStore.getState().project!;
      projectFileStore.getState().markSaved(project, PATH_REF);
      expect(isProjectDirty(project)).toBe(false);
    });

    it('turns true again on the next edit', () => {
      projectFileStore.getState().markSaved(projectStore.getState().project!, PATH_REF);
      // Every store mutation replaces the project object, which is exactly what the
      // dirty check compares — no separate flag to keep in step.
      projectStore.getState().setBpm(140);
      expect(isProjectDirty(projectStore.getState().project)).toBe(true);
    });
  });
});
