import { describe, expect, it } from 'vitest';
import {
  laneFor,
  laneKey,
  normalizeParameterAutomation,
  withLane,
  withLaneName,
  withLanePoints,
  withoutLane,
} from '@/engine/parameterAutomation';
import type { ParameterAutomation } from '@/types/music';

const lane = (paramId: number, points: [number, number][] = []): ParameterAutomation => ({
  target: { kind: 'param', paramId },
  name: `Param ${paramId}`,
  points: points.map(([beat, value]) => ({ beat, value })),
});

const cc = (controller: number, points: [number, number][] = []): ParameterAutomation => ({
  target: { kind: 'cc', controller },
  name: `CC ${controller}`,
  points: points.map(([beat, value]) => ({ beat, value })),
});

const keys = (lanes: ParameterAutomation[]) => lanes.map(l => laneKey(l.target));

describe('laneKey', () => {
  // The two kinds must not be able to collide: a lane driving parameter 20 and a
  // lane driving CC 20 are different curves on different things.
  it('tells a parameter apart from a controller of the same number', () => {
    expect(laneKey({ kind: 'param', paramId: 20 })).toBe('param:20');
    expect(laneKey({ kind: 'cc', controller: 20 })).toBe('cc:20');
  });
});

describe('normalizeParameterAutomation', () => {
  it('sorts lanes by key, so the stack has a stable order', () => {
    const result = normalizeParameterAutomation([lane(9, [[0, 0.5]]), lane(2, [[0, 0.5]])]);
    expect(keys(result)).toEqual(['param:2', 'param:9']);
  });

  it('keeps a parameter lane and a controller lane side by side', () => {
    const result = normalizeParameterAutomation([cc(20, [[0, 0.5]]), lane(7, [[0, 0.5]])]);
    expect(keys(result)).toEqual(['cc:20', 'param:7']);
  });

  it('runs each lane’s points through the shared point rules', () => {
    const result = normalizeParameterAutomation([
      lane(1, [
        [4, 0.4],
        [0, 0.1],
        [2, 0.2],
      ]),
    ]);
    expect(result[0].points).toEqual([
      { beat: 0, value: 0.1 },
      { beat: 2, value: 0.2 },
      { beat: 4, value: 0.4 },
    ]);
  });

  // The same rule `normalizePoints` applies to a duplicate beat: an edit that
  // lands on top of something reads as replacing it, not as being refused.
  it('collapses a duplicated target to the later lane', () => {
    const result = normalizeParameterAutomation([lane(1, [[0, 0.1]]), lane(1, [[0, 0.9]])]);

    expect(result).toHaveLength(1);
    expect(result[0].points).toEqual([{ beat: 0, value: 0.9 }]);
  });

  it('collapses a duplicated controller too', () => {
    const result = normalizeParameterAutomation([cc(20, [[0, 0.1]]), cc(20, [[0, 0.9]])]);

    expect(result).toHaveLength(1);
    expect(result[0].points).toEqual([{ beat: 0, value: 0.9 }]);
  });

  it('drops a lane whose parameter id is not a whole number', () => {
    const result = normalizeParameterAutomation([
      lane(1.5, [[0, 0.5]]),
      lane(-1, [[0, 0.5]]),
      lane(2, [[0, 0.5]]),
    ]);
    expect(keys(result)).toEqual(['param:2']);
  });

  // A controller is a 7-bit value, so anything outside it names nothing that
  // could be sent — the plugin would be asked about a controller that cannot
  // exist.
  it('drops a lane whose controller is outside 0-127', () => {
    const result = normalizeParameterAutomation([
      cc(128, [[0, 0.5]]),
      cc(-1, [[0, 0.5]]),
      cc(20.5, [[0, 0.5]]),
      cc(20, [[0, 0.5]]),
    ]);
    expect(keys(result)).toEqual(['cc:20']);
  });

  it('drops a lane whose target says nothing at all', () => {
    const result = normalizeParameterAutomation([
      { name: 'x', points: [] } as never,
      { target: { kind: 'nonsense' }, name: 'x', points: [] } as never,
      lane(2, [[0, 0.5]]),
    ]);
    expect(keys(result)).toEqual(['param:2']);
  });

  it('keeps an empty lane, because one just added has no points yet', () => {
    expect(normalizeParameterAutomation([lane(3)])).toHaveLength(1);
  });

  // The one place empty lanes are not kept: a saved file carrying one describes
  // a curve that drives nothing, which is noise rather than intent.
  it('drops an empty lane when told it is coming off a file', () => {
    const result = normalizeParameterAutomation([lane(3), lane(4, [[0, 0.5]])], {
      dropEmpty: true,
    });
    expect(keys(result)).toEqual(['param:4']);
  });

  it('tolerates a value that is not an array at all', () => {
    expect(normalizeParameterAutomation(undefined as never)).toEqual([]);
    expect(normalizeParameterAutomation([null, 'nonsense'] as never)).toEqual([]);
  });
});

describe('laneFor', () => {
  it('finds a lane by key', () => {
    const lanes = [lane(1), lane(2)];
    expect(laneFor(lanes, 'param:2')).toBe(lanes[1]);
  });

  it('finds a controller lane by key', () => {
    const lanes = [lane(20), cc(20)];
    expect(laneFor(lanes, 'cc:20')).toBe(lanes[1]);
  });

  it('answers null for a key with no lane', () => {
    expect(laneFor([lane(1)], 'param:7')).toBeNull();
  });
});

describe('withLane', () => {
  it('adds a lane, sorted into place', () => {
    const result = withLane([lane(5)], lane(1));
    expect(keys(result)).toEqual(['param:1', 'param:5']);
  });

  // Adding a lane for a target that already has one must not silently wipe the
  // curve already drawn on it.
  it('leaves an existing lane alone rather than replacing it', () => {
    const result = withLane([lane(1, [[0, 0.9]])], lane(1));

    expect(result).toHaveLength(1);
    expect(result[0].points).toEqual([{ beat: 0, value: 0.9 }]);
  });
});

describe('withoutLane', () => {
  it('removes the named lane and leaves the rest', () => {
    const result = withoutLane([lane(1), lane(2)], 'param:1');
    expect(keys(result)).toEqual(['param:2']);
  });

  it('is a no-op for a key with no lane', () => {
    const lanes = [lane(1)];
    expect(withoutLane(lanes, 'param:7')).toEqual(lanes);
  });
});

describe('withLanePoints', () => {
  it('edits one lane’s points and leaves its neighbours untouched', () => {
    const lanes = [lane(1, [[0, 0.1]]), lane(2, [[0, 0.2]])];
    const result = withLanePoints(lanes, 'param:1', () => [{ beat: 3, value: 0.7 }]);

    expect(result[0].points).toEqual([{ beat: 3, value: 0.7 }]);
    expect(result[1].points).toEqual([{ beat: 0, value: 0.2 }]);
  });

  it('normalizes whatever the edit returns', () => {
    const result = withLanePoints([lane(1)], 'param:1', () => [
      { beat: 2, value: 0.2 },
      { beat: 0, value: 0.1 },
    ]);
    expect(result[0].points.map(p => p.beat)).toEqual([0, 2]);
  });

  it('is a no-op for a key with no lane', () => {
    const lanes = [lane(1)];
    expect(withLanePoints(lanes, 'param:7', () => [{ beat: 0, value: 1 }])).toEqual(lanes);
  });
});

describe('withLaneName', () => {
  // The reason renaming exists: a controller can only ever be called "CC 20",
  // and a sampler's automation slots are all called the same thing.
  it('renames one lane and leaves the rest', () => {
    const result = withLaneName([cc(20), lane(1)], 'cc:20', 'Filter Cutoff');

    expect(result[0].name).toBe('Filter Cutoff');
    expect(result[1].name).toBe('Param 1');
  });

  it('trims what it is given', () => {
    expect(withLaneName([cc(20)], 'cc:20', '  Cutoff  ')[0].name).toBe('Cutoff');
  });

  // A nameless lane would be a row with nothing in its label, and there is no
  // way back from one through the UI.
  it('refuses an empty name rather than storing one', () => {
    const lanes = [cc(20)];
    expect(withLaneName(lanes, 'cc:20', '   ')).toBe(lanes);
  });

  it('is a no-op for a key with no lane', () => {
    const lanes = [cc(20)];
    expect(withLaneName(lanes, 'param:7', 'Cutoff')).toBe(lanes);
  });
});
