import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { HorizontalScrollbar } from '@/components/HorizontalScrollbar';
import { editorStore } from '@/store/editorStore';

/** The stubbed viewport width every element reports. */
const VIEWPORT_WIDTH = 800;

/**
 * jsdom does no layout: `clientWidth` is always 0 and `scrollLeft` is read-only.
 * Both are stubbed on the prototype — before the first render, so the component's
 * measuring effect sees a real viewport on mount — with scroll positions kept in a
 * side table so the store→DOM write is observable.
 */
const scrollPositions = new WeakMap<Element, number>();

function stubLayout(): void {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => VIEWPORT_WIDTH,
  });
  Object.defineProperty(Element.prototype, 'scrollLeft', {
    configurable: true,
    get(this: Element) {
      return scrollPositions.get(this) ?? 0;
    },
    set(this: Element, value: number) {
      scrollPositions.set(this, value);
    },
  });
}

function restoreLayout(): void {
  // @ts-expect-error — removing the stub restores jsdom's own accessor.
  delete HTMLElement.prototype.clientWidth;
  // @ts-expect-error — same.
  delete Element.prototype.scrollLeft;
}

describe('HorizontalScrollbar', () => {
  beforeEach(() => {
    editorStore.setState({ scrollX: 0, maxScrollX: 0, viewportWidth: 0 });
    stubLayout();
  });

  afterEach(restoreLayout);

  it('gives the scrollbar the full content width to scroll over', () => {
    const { getByTestId } = render(<HorizontalScrollbar contentWidth={2000} />);

    const spacer = getByTestId('shared-scrollbar').firstElementChild!;
    expect(spacer).toHaveStyle({ width: '2000px' });
  });

  it('reports the scrollable extent from the measured viewport', () => {
    render(<HorizontalScrollbar contentWidth={2000} />);

    expect(editorStore.getState().viewportWidth).toBe(VIEWPORT_WIDTH);
    expect(editorStore.getState().maxScrollX).toBe(2000 - VIEWPORT_WIDTH);
  });

  it('publishes its scroll position to the shared offset', () => {
    const { getByTestId } = render(<HorizontalScrollbar contentWidth={2000} />);
    const element = getByTestId('shared-scrollbar');

    element.scrollLeft = 320;
    fireEvent.scroll(element);

    expect(editorStore.getState().scrollX).toBe(320);
  });

  it('follows the shared offset when something else moves it', () => {
    const { getByTestId } = render(<HorizontalScrollbar contentWidth={2000} />);

    act(() => {
      editorStore.getState().setScrollX(500);
    });

    expect(getByTestId('shared-scrollbar').scrollLeft).toBe(500);
  });

  it('cannot be scrolled past the end of the project', () => {
    const { getByTestId } = render(<HorizontalScrollbar contentWidth={2000} />);
    const element = getByTestId('shared-scrollbar');

    element.scrollLeft = 9999;
    fireEvent.scroll(element);

    expect(editorStore.getState().scrollX).toBe(2000 - VIEWPORT_WIDTH);
  });
});
