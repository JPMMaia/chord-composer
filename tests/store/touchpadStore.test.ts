import { describe, it, expect, beforeEach } from 'vitest';
import { projectStore } from '@/store/projectStore';
import { openTestPhrase } from '../helpers/phrases';
import { phraseById } from '@/engine/phrases';
import { laneFor } from '@/engine/parameterAutomation';
import type { AutomationPoint, ParameterAutomation } from '@/types/music';

/**
 * What the touchpad writes and what it is pointed at: the store half of performing a
 * controller. The gesture itself is `engine/touchpadExpression`, and the wiring
 * between them is `hooks/useTouchpadExpression`.
 */

const CC11 = { kind: 'cc', controller: 11 } as const;

function firstTrackId(): string {
  return projectStore.getState().project!.tracks[0].id;
}

function lane(phraseId: string, key: string): ParameterAutomation | null {
  const phrase = phraseById(projectStore.getState().project!.phrases, phraseId)!;
  return laneFor(phrase.parameterAutomation ?? [], key);
}

const points = (phraseId: string, key: string): AutomationPoint[] =>
  lane(phraseId, key)?.points ?? [];

beforeEach(() => {
  projectStore.getState().resetProject();
  projectStore.getState().createProject();
  // Two bars, so a gesture has somewhere to run.
  projectStore.getState().addBar();
});

describe('setTrackTouchpadTarget', () => {
  it('points the touchpad at a controller', () => {
    const trackId = firstTrackId();
    projectStore.getState().setTrackTouchpadTarget(trackId, CC11);

    expect(projectStore.getState().project!.tracks[0].touchpadTarget).toEqual(CC11);
  });

  it('unassigns it again', () => {
    const trackId = firstTrackId();
    projectStore.getState().setTrackTouchpadTarget(trackId, CC11);
    projectStore.getState().setTrackTouchpadTarget(trackId, null);

    expect(projectStore.getState().project!.tracks[0].touchpadTarget).toBeUndefined();
  });

  it('is per instrument, so selecting another one changes what the finger drives', () => {
    const first = firstTrackId();
    const second = projectStore.getState().addTrack('Strings')!;

    projectStore.getState().setTrackTouchpadTarget(first, CC11);
    projectStore.getState().setTrackTouchpadTarget(second, { kind: 'cc', controller: 1 });

    const tracks = projectStore.getState().project!.tracks;
    expect(tracks.find(t => t.id === first)!.touchpadTarget).toEqual(CC11);
    expect(tracks.find(t => t.id === second)!.touchpadTarget).toEqual({
      kind: 'cc',
      controller: 1,
    });
  });
});

describe('recordLanePoints', () => {
  it('creates the lane the gesture is played on', () => {
    const { phraseId } = openTestPhrase(firstTrackId(), 2);

    projectStore
      .getState()
      .recordLanePoints(phraseId, CC11, 'CC 11', [
        { beat: 0, value: 0.2 },
        { beat: 1, value: 0.8 },
      ]);

    expect(lane(phraseId, 'cc:11')).toMatchObject({ target: CC11, name: 'CC 11' });
    expect(points(phraseId, 'cc:11')).toEqual([
      { beat: 0, value: 0.2 },
      { beat: 1, value: 0.8 },
    ]);
  });

  it('adds to a lane that already exists rather than replacing it', () => {
    // Punching in over one stretch of a phrase has to leave the rest of the curve
    // standing.
    const { phraseId } = openTestPhrase(firstTrackId(), 2);
    projectStore.getState().addLane(phraseId, CC11, 'CC 11');
    projectStore.getState().addLanePoint(phraseId, 'cc:11', 0, 0.1);

    projectStore.getState().recordLanePoints(phraseId, CC11, 'CC 11', [
      { beat: 2, value: 0.9 },
    ]);

    expect(points(phraseId, 'cc:11')).toEqual([
      { beat: 0, value: 0.1 },
      { beat: 2, value: 0.9 },
    ]);
  });

  it('keeps the points sorted whatever order the flush hands them in', () => {
    const { phraseId } = openTestPhrase(firstTrackId(), 2);

    projectStore.getState().recordLanePoints(phraseId, CC11, 'CC 11', [
      { beat: 2, value: 0.9 },
      { beat: 1, value: 0.5 },
    ]);

    expect(points(phraseId, 'cc:11').map(p => p.beat)).toEqual([1, 2]);
  });

  it('lets a later pass overwrite a breakpoint on the same beat', () => {
    const { phraseId } = openTestPhrase(firstTrackId(), 2);
    projectStore.getState().recordLanePoints(phraseId, CC11, 'CC 11', [
      { beat: 1, value: 0.2 },
    ]);
    projectStore.getState().recordLanePoints(phraseId, CC11, 'CC 11', [
      { beat: 1, value: 0.7 },
    ]);

    expect(points(phraseId, 'cc:11')).toEqual([{ beat: 1, value: 0.7 }]);
  });

  it('does nothing for an empty flush', () => {
    const { phraseId } = openTestPhrase(firstTrackId(), 2);
    const before = projectStore.getState().project;

    projectStore.getState().recordLanePoints(phraseId, CC11, 'CC 11', []);

    // No lane created, and no new project object — an empty flush must not push a
    // snapshot onto the undo stack.
    expect(lane(phraseId, 'cc:11')).toBeNull();
    expect(projectStore.getState().project).toBe(before);
  });

  it('does nothing for a phrase that is not there', () => {
    projectStore.getState().recordLanePoints('no-such-phrase', CC11, 'CC 11', [
      { beat: 0, value: 0.5 },
    ]);

    expect(projectStore.getState().project!.phrases).toEqual([]);
  });

  it('reaches the instrument playing the phrase, through the compiled track', () => {
    // The lane is written on the phrase; what the scheduler reads is the track's
    // derived copy, so a performed curve is only real once `compileAutomation` has
    // spread it over the placements.
    const trackId = firstTrackId();
    const { phraseId } = openTestPhrase(trackId, 2);

    projectStore.getState().recordLanePoints(phraseId, CC11, 'CC 11', [
      { beat: 0, value: 0.25 },
    ]);

    const track = projectStore.getState().project!.tracks.find(t => t.id === trackId)!;
    expect(laneFor(track.parameterAutomation ?? [], 'cc:11')?.points).toContainEqual({
      beat: 0,
      value: 0.25,
    });
  });
});
