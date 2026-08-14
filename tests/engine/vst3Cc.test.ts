import { describe, expect, it } from 'vitest';
import { nextFreeCc, type Vst3CcInfo } from '@/engine/vst3Cc';

/** A plugin that maps every controller, as a sampler like Kontakt does. */
const allCc: Vst3CcInfo[] = Array.from({ length: 128 }, (_, controller) => ({
  controller,
  paramId: 1000 + controller,
}));

const only = (...controllers: number[]): Vst3CcInfo[] =>
  controllers.map(controller => ({ controller, paramId: 1000 + controller }));

describe('nextFreeCc', () => {
  // 20-31 is the first block the MIDI spec leaves undefined, so it is the one
  // least likely to already mean something to a keyboard or another plugin.
  it('reaches for the first undefined block', () => {
    expect(nextFreeCc(allCc, [])).toBe(20);
  });

  it('steps past a controller that already has a lane', () => {
    expect(nextFreeCc(allCc, [20, 21])).toBe(22);
  });

  it('falls through to the second undefined block once the first is used up', () => {
    const taken = Array.from({ length: 12 }, (_, i) => 20 + i);
    expect(nextFreeCc(allCc, taken)).toBe(102);
  });

  // Each of these already has a job that something in the chain may act on
  // regardless of what it was bound to here.
  it('never offers a controller the spec has already spoken for', () => {
    const reserved = [0, 6, 7, 10, 11, 32, 38, 64, 96, 100, 120, 127];
    for (const cc of reserved) {
      expect(nextFreeCc(only(cc), [])).toBeNull();
    }
  });

  it('offers an ordinary controller outside the quiet blocks when it must', () => {
    // Not reserved, and not in either preferred block.
    expect(nextFreeCc(only(45), [])).toBe(45);
  });

  it('offers only what the plugin actually maps', () => {
    expect(nextFreeCc(only(25, 30), [])).toBe(25);
    expect(nextFreeCc(only(25, 30), [25])).toBe(30);
  });

  // Which is what a plugin implementing no `IMidiMapping` produces. The panel
  // checks for it rather than offering a number that would go nowhere.
  it('answers null when the plugin maps nothing', () => {
    expect(nextFreeCc([], [])).toBeNull();
  });

  it('answers null once every mapped controller has a lane', () => {
    expect(nextFreeCc(only(25, 30), [25, 30])).toBeNull();
  });
});
