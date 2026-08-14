import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SectionBand } from '@/components/SectionBand';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { editorStore } from '@/store/editorStore';
import { DEFAULT_SNAP_BEATS } from '@/engine/timeline';
import { PIXELS_PER_BEAT } from '@/utils/constants';
import type { Section } from '@/types/music';

/** Two 4/4 bars' worth of band, the width every test here draws on. */
const TOTAL_BEATS = 8;

function sections(): Section[] {
  return projectStore.getState().project?.sections ?? [];
}

function loop(): [number | undefined, number | undefined] {
  const { loopStart, loopEnd } = projectStore.getState().project!;
  return [loopStart, loopEnd];
}

/** Drag across the band. jsdom zeroes the rect, so clientX reads as beats. */
function dragBand(fromBeat: number, toBeat: number) {
  const band = screen.getByTestId('section-band');
  fireEvent.pointerDown(band, { clientX: fromBeat * PIXELS_PER_BEAT, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: toBeat * PIXELS_PER_BEAT, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: toBeat * PIXELS_PER_BEAT, pointerId: 1 });
}

/** Drag an element that is already on the band — a section's body or one of its handles. */
function dragElement(el: HTMLElement, fromBeat: number, toBeat: number) {
  fireEvent.pointerDown(el, { clientX: fromBeat * PIXELS_PER_BEAT, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: toBeat * PIXELS_PER_BEAT, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: toBeat * PIXELS_PER_BEAT, pointerId: 1 });
}

describe('SectionBand', () => {
  beforeEach(() => {
    selectionStore.getState().clearSelection();
    editorStore.setState({ snapBeats: DEFAULT_SNAP_BEATS, pixelsPerBeat: PIXELS_PER_BEAT });
    projectStore.getState().createProject();
    projectStore.getState().addBar();
    projectStore.getState().addBar();
  });

  it('creates a section spanning a drag across the band', () => {
    render(<SectionBand totalBeats={TOTAL_BEATS} />);
    dragBand(1, 5);

    expect(sections()).toHaveLength(1);
    expect(sections()[0]).toMatchObject({ startBeat: 1, endBeat: 5, name: 'Section 1' });
  });

  it('reads a backwards drag as the same span', () => {
    render(<SectionBand totalBeats={TOTAL_BEATS} />);
    dragBand(6, 2);

    expect(sections()[0]).toMatchObject({ startBeat: 2, endBeat: 6 });
  });

  it('snaps a new section to the grid', () => {
    editorStore.getState().setSnapBeats(0.5);
    render(<SectionBand totalBeats={TOTAL_BEATS} />);
    dragBand(0.9, 3.4);

    expect(sections()[0]).toMatchObject({ startBeat: 1, endBeat: 3.5 });
  });

  it('does nothing on a click that never moved', () => {
    render(<SectionBand totalBeats={TOTAL_BEATS} />);
    const band = screen.getByTestId('section-band');
    fireEvent.pointerDown(band, { clientX: 3 * PIXELS_PER_BEAT, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 3 * PIXELS_PER_BEAT, pointerId: 1 });

    expect(sections()).toHaveLength(0);
  });

  it('opens the new section for renaming, and Enter commits the name', () => {
    render(<SectionBand totalBeats={TOTAL_BEATS} />);
    dragBand(0, 4);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Intro' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(sections()[0].name).toBe('Intro');
  });

  it('reverts a rename on Escape', () => {
    render(<SectionBand totalBeats={TOTAL_BEATS} />);
    dragBand(0, 4);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Intro' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(sections()[0].name).toBe('Section 1');
  });

  it('resizes a section by its end handle, leaving the start put', () => {
    render(<SectionBand totalBeats={TOTAL_BEATS} />);
    dragBand(1, 5);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });

    dragElement(screen.getByRole('button', { name: 'Section 1 end' }), 5, 7);

    expect(sections()[0]).toMatchObject({ startBeat: 1, endBeat: 7 });
  });

  it('moves a whole section when its body is dragged', () => {
    render(<SectionBand totalBeats={TOTAL_BEATS} />);
    dragBand(0, 4);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });

    const body = screen.getByTestId(`section-${sections()[0].id}`);
    dragElement(body, 2, 4);

    expect(sections()[0]).toMatchObject({ startBeat: 2, endBeat: 6 });
  });

  it('sets the play range to a clicked section', () => {
    render(<SectionBand totalBeats={TOTAL_BEATS} />);
    dragBand(2, 6);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });

    fireEvent.click(screen.getByTestId(`section-${sections()[0].id}`));

    expect(loop()).toEqual([2, 6]);
    expect(selectionStore.getState().selectedSectionId).toBe(sections()[0].id);
  });

  it('does not jump the play range after a move drag', () => {
    render(<SectionBand totalBeats={TOTAL_BEATS} />);
    dragBand(0, 4);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });

    const body = screen.getByTestId(`section-${sections()[0].id}`);
    dragElement(body, 2, 4);
    fireEvent.click(body);

    expect(loop()).toEqual([undefined, undefined]);
  });

  it('removes the selected section on Delete', () => {
    render(<SectionBand totalBeats={TOTAL_BEATS} />);
    dragBand(1, 5);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });

    fireEvent.click(screen.getByTestId(`section-${sections()[0].id}`));
    fireEvent.keyDown(window, { key: 'Delete' });

    expect(sections()).toHaveLength(0);
    expect(selectionStore.getState().selectedSectionId).toBeNull();
  });

  it('removes a section from its × button', () => {
    render(<SectionBand totalBeats={TOTAL_BEATS} />);
    dragBand(1, 5);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });

    fireEvent.click(screen.getByRole('button', { name: 'Remove Section 1' }));

    expect(sections()).toHaveLength(0);
  });

  it('trims the earlier section when a new one is drawn over it', () => {
    render(<SectionBand totalBeats={TOTAL_BEATS} />);
    dragBand(0, 6);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    dragBand(4, 8);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });

    expect(sections().map(s => [s.startBeat, s.endBeat])).toEqual([
      [0, 4],
      [4, 8],
    ]);
  });
});
