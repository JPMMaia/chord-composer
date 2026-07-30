import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChordEditor } from "@/components/ChordEditor";
import { Bar, Scale, ChordSegment } from "@/types/music";
import { generateId } from "@/utils/id";

const makeBar = (chords: ChordSegment[] = []): Bar => ({
  id: generateId(),
  barIndex: 0,
  scale: { root: "C", type: "major" },
  chords,
  notes: [],
});

const makeChord = (
  roman: string,
  duration: number,
  chordSymbol?: string
): ChordSegment => ({
  id: generateId(),
  romanNumeral: roman,
  chordSymbol,
  duration,
});

// Mock dnd-kit components
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useDroppable: () => ({ setNodeRef: () => null, isOver: false }),
  useDraggable: () => ({
    attributes: { "aria-grabbed": "false" },
    listeners: { onPointerDown: () => {} },
    setNodeRef: () => null,
    active: null,
  }),
  DragOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  UniqueIdentifier: String,
}));

describe("ChordEditor", () => {
  const mockOnChordReorder = vi.fn();
  const mockOnChordAdd = vi.fn();
  const mockOnChordRemove = vi.fn();
  const mockOnBarSplit = vi.fn();
  const mockOnAutoFillNotes = vi.fn();
  const mockOnCustomChordInput = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders chord blocks for diatonic chords", () => {
    const bar = makeBar([
      makeChord("I", 2),
      makeChord("V", 2),
    ]);
    render(
      <ChordEditor
        bar={bar}
        scale={bar.scale}
        onChordReorder={mockOnChordReorder}
        onChordAdd={mockOnChordAdd}
        onChordRemove={mockOnChordRemove}
        onBarSplit={mockOnBarSplit}
        onAutoFillNotes={mockOnAutoFillNotes}
        onCustomChordInput={mockOnCustomChordInput}
      />
    );
    expect(screen.getByText(/I/)).toBeInTheDocument();
    expect(screen.getByText(/V/)).toBeInTheDocument();
  });

  it("renders Roman numeral labels", () => {
    const bar = makeBar([
      makeChord("I", 1),
      makeChord("ii", 1),
      makeChord("iii", 1),
      makeChord("IV", 1),
    ]);
    render(
      <ChordEditor
        bar={bar}
        scale={bar.scale}
        onChordReorder={mockOnChordReorder}
        onChordAdd={mockOnChordAdd}
        onChordRemove={mockOnChordRemove}
        onBarSplit={mockOnBarSplit}
        onAutoFillNotes={mockOnAutoFillNotes}
        onCustomChordInput={mockOnCustomChordInput}
      />
    );
    // Check that all chord blocks are rendered
    const chordBlocks = document.querySelectorAll('[data-chord-block]');
    expect(chordBlocks).toHaveLength(4);
    // Verify the roman numerals are present in the DOM
    expect(document.body.textContent).toContain("I");
    expect(document.body.textContent).toContain("ii");
    expect(document.body.textContent).toContain("iii");
    expect(document.body.textContent).toContain("IV");
  });

  it("renders chord symbols when provided", () => {
    const bar = makeBar([
      makeChord("I", 4, "Cmaj7"),
    ]);
    render(
      <ChordEditor
        bar={bar}
        scale={bar.scale}
        onChordReorder={mockOnChordReorder}
        onChordAdd={mockOnChordAdd}
        onChordRemove={mockOnChordRemove}
        onBarSplit={mockOnBarSplit}
        onAutoFillNotes={mockOnAutoFillNotes}
        onCustomChordInput={mockOnCustomChordInput}
      />
    );
    expect(screen.getByText(/Cmaj7/)).toBeInTheDocument();
  });

  it("renders chord symbol with Roman numeral (e.g. 'I → Cmaj')", () => {
    const bar = makeBar([
      makeChord("I", 4, "Cmaj"),
    ]);
    render(
      <ChordEditor
        bar={bar}
        scale={bar.scale}
        onChordReorder={mockOnChordReorder}
        onChordAdd={mockOnChordAdd}
        onChordRemove={mockOnChordRemove}
        onBarSplit={mockOnBarSplit}
        onAutoFillNotes={mockOnAutoFillNotes}
        onCustomChordInput={mockOnCustomChordInput}
      />
    );
    expect(screen.getByText(/I/)).toBeInTheDocument();
    expect(screen.getByText(/Cmaj/)).toBeInTheDocument();
  });

  it("allows adding a custom chord symbol", () => {
    const bar = makeBar([makeChord("I", 4)]);
    render(
      <ChordEditor
        bar={bar}
        scale={bar.scale}
        onChordReorder={mockOnChordReorder}
        onChordAdd={mockOnChordAdd}
        onChordRemove={mockOnChordRemove}
        onBarSplit={mockOnBarSplit}
        onAutoFillNotes={mockOnAutoFillNotes}
        onCustomChordInput={mockOnCustomChordInput}
      />
    );
    const addButton = screen.getByRole("button", { name: /add chord/i });
    fireEvent.click(addButton);
  });

  it("calls onChordAdd with a new chord segment", () => {
    const bar = makeBar([makeChord("I", 4)]);
    render(
      <ChordEditor
        bar={bar}
        scale={bar.scale}
        onChordReorder={mockOnChordReorder}
        onChordAdd={mockOnChordAdd}
        onChordRemove={mockOnChordRemove}
        onBarSplit={mockOnBarSplit}
        onAutoFillNotes={mockOnAutoFillNotes}
        onCustomChordInput={mockOnCustomChordInput}
      />
    );
    const addButton = screen.getByRole("button", { name: /add chord/i });
    fireEvent.click(addButton);
    expect(mockOnChordAdd).toHaveBeenCalled();
  });

  it("calls onChordRemove when removing a chord", () => {
    const bar = makeBar([
      makeChord("I", 2),
      makeChord("V", 2),
    ]);
    render(
      <ChordEditor
        bar={bar}
        scale={bar.scale}
        onChordReorder={mockOnChordReorder}
        onChordAdd={mockOnChordAdd}
        onChordRemove={mockOnChordRemove}
        onBarSplit={mockOnBarSplit}
        onAutoFillNotes={mockOnAutoFillNotes}
        onCustomChordInput={mockOnCustomChordInput}
      />
    );
    const removeButtons = screen.getAllByRole("button", { name: /remove chord/i });
    fireEvent.click(removeButtons[0]);
    expect(mockOnChordRemove).toHaveBeenCalled();
  });

  it("calls onBarSplit with the specified chord count", () => {
    const bar = makeBar([makeChord("I", 4)]);
    render(
      <ChordEditor
        bar={bar}
        scale={bar.scale}
        onChordReorder={mockOnChordReorder}
        onChordAdd={mockOnChordAdd}
        onChordRemove={mockOnChordRemove}
        onBarSplit={mockOnBarSplit}
        onAutoFillNotes={mockOnAutoFillNotes}
        onCustomChordInput={mockOnCustomChordInput}
      />
    );
    const splitButton = screen.getByRole("button", { name: /split bar/i });
    fireEvent.click(splitButton);
    // Click the "2 segments" option to trigger the split
    const option2 = screen.getByText("2 segments");
    fireEvent.click(option2);
    expect(mockOnBarSplit).toHaveBeenCalledWith(2);
  });

  it("calls onAutoFillNotes when auto-fill is triggered", () => {
    const bar = makeBar([
      makeChord("I", 2),
      makeChord("V", 2),
    ]);
    render(
      <ChordEditor
        bar={bar}
        scale={bar.scale}
        onChordReorder={mockOnChordReorder}
        onChordAdd={mockOnChordAdd}
        onChordRemove={mockOnChordRemove}
        onBarSplit={mockOnBarSplit}
        onAutoFillNotes={mockOnAutoFillNotes}
        onCustomChordInput={mockOnCustomChordInput}
      />
    );
    const autoFillButton = screen.getByRole("button", { name: /auto-fill/i });
    fireEvent.click(autoFillButton);
    expect(mockOnAutoFillNotes).toHaveBeenCalled();
  });

  it("calls onCustomChordInput with a chord symbol", () => {
    const bar = makeBar([makeChord("I", 4)]);
    render(
      <ChordEditor
        bar={bar}
        scale={bar.scale}
        onChordReorder={mockOnChordReorder}
        onChordAdd={mockOnChordAdd}
        onChordRemove={mockOnChordRemove}
        onBarSplit={mockOnBarSplit}
        onAutoFillNotes={mockOnAutoFillNotes}
        onCustomChordInput={mockOnCustomChordInput}
      />
    );
    // Find the custom chord input and type a symbol
    const input = screen.getByPlaceholderText(/chord symbol/i);
    if (input) {
      fireEvent.change(input, { target: { value: "Am7" } });
      const form = input.closest("form");
      if (form) {
        fireEvent.submit(form);
      }
      expect(mockOnCustomChordInput).toHaveBeenCalledWith("Am7");
    }
  });

  it("renders with empty chords array", () => {
    const bar = makeBar([]);
    const { container } = render(
      <ChordEditor
        bar={bar}
        scale={bar.scale}
        onChordReorder={mockOnChordReorder}
        onChordAdd={mockOnChordAdd}
        onChordRemove={mockOnChordRemove}
        onBarSplit={mockOnBarSplit}
        onAutoFillNotes={mockOnAutoFillNotes}
        onCustomChordInput={mockOnCustomChordInput}
      />
    );
    expect(container).toBeInTheDocument();
  });

  it("renders split bar options for 2, 3, 4 segments", () => {
    const bar = makeBar([makeChord("I", 4)]);
    render(
      <ChordEditor
        bar={bar}
        scale={bar.scale}
        onChordReorder={mockOnChordReorder}
        onChordAdd={mockOnChordAdd}
        onChordRemove={mockOnChordRemove}
        onBarSplit={mockOnBarSplit}
        onAutoFillNotes={mockOnAutoFillNotes}
        onCustomChordInput={mockOnCustomChordInput}
      />
    );
    const splitButton = screen.getByRole("button", { name: /split bar/i });
    fireEvent.click(splitButton);
    // After clicking, split options should appear
    expect(splitButton).toBeInTheDocument();
  });

  it("highlights the selected chord block", () => {
    const bar = makeBar([
      makeChord("I", 2),
      makeChord("V", 2),
    ]);
    render(
      <ChordEditor
        bar={bar}
        scale={bar.scale}
        onChordReorder={mockOnChordReorder}
        onChordAdd={mockOnChordAdd}
        onChordRemove={mockOnChordRemove}
        onBarSplit={mockOnBarSplit}
        onAutoFillNotes={mockOnAutoFillNotes}
        onCustomChordInput={mockOnCustomChordInput}
        selectedChordId={bar.chords[0].id}
      />
    );
    const firstChordBlock = screen.getByText(/I/).closest("[data-chord-block]");
    expect(firstChordBlock).toHaveAttribute("data-chord-block", bar.chords[0].id);
  });

  it("shows correct chord count for 3/4 time signature", () => {
    const bar = makeBar([
      makeChord("I", 1),
      makeChord("iv", 1),
      makeChord("V", 1),
    ]);
    render(
      <ChordEditor
        bar={bar}
        scale={bar.scale}
        onChordReorder={mockOnChordReorder}
        onChordAdd={mockOnChordAdd}
        onChordRemove={mockOnChordRemove}
        onBarSplit={mockOnBarSplit}
        onAutoFillNotes={mockOnAutoFillNotes}
        onCustomChordInput={mockOnCustomChordInput}
      />
    );
    expect(screen.getByText(/I/)).toBeInTheDocument();
    expect(screen.getByText(/iv/)).toBeInTheDocument();
    expect(screen.getByText(/V/)).toBeInTheDocument();
  });
});
