import React, { useCallback, useEffect, useRef } from 'react';
import { editorStore } from '@/store/editorStore';

export interface HorizontalScrollbarProps {
  /** Full width of the beat axis including the left gutter, in pixels. */
  contentWidth: number;
}

/**
 * The editor's one horizontal scrollbar, driving the chord timeline and the piano
 * roll from a single shared offset.
 *
 * It is a real scroll container wrapping a hairline spacer rather than a custom
 * thumb: the browser then sizes, styles and drags it, and keyboard and wheel
 * scrolling come along for free.
 *
 * `contentWidth` includes the piano key column, so this bar's scrollable range
 * matches the panes' — they scroll `contentWidth − PIANO_KEYS_WIDTH` inside a
 * viewport that is narrower by exactly that gutter.
 */
export const HorizontalScrollbar: React.FC<HorizontalScrollbarProps> = ({ contentWidth }) => {
  const scrollX = editorStore(s => s.scrollX);
  const setScrollX = editorStore(s => s.setScrollX);
  const setScrollExtent = editorStore(s => s.setScrollExtent);

  const elementRef = useRef<HTMLDivElement>(null);

  const measure = useCallback(() => {
    const element = elementRef.current;
    if (element) setScrollExtent(contentWidth, element.clientWidth);
  }, [contentWidth, setScrollExtent]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    // Also measured directly: the observer's first callback is asynchronous, and
    // until the extent is known every offset would clamp to zero.
    measure();

    return () => observer.disconnect();
  }, [measure]);

  // The store is the source of truth, so an offset set anywhere else — the other
  // pane's wheel, the playhead follow — lands here too. Writing only on a real
  // difference is what stops this from looping against the scroll handler below.
  useEffect(() => {
    const element = elementRef.current;
    if (element && Math.abs(element.scrollLeft - scrollX) > 1) {
      element.scrollLeft = scrollX;
    }
  }, [scrollX]);

  return (
    <div
      ref={elementRef}
      data-testid="shared-scrollbar"
      onScroll={e => setScrollX(e.currentTarget.scrollLeft)}
      className="shrink-0 h-3 overflow-x-auto overflow-y-hidden bg-gray-800 border-t border-gray-700"
    >
      <div style={{ width: `${contentWidth}px` }} className="h-px" />
    </div>
  );
};
