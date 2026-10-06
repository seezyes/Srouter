import { afterEach, describe, expect, it, vi } from "vitest";
import { computeDragSelection } from "@/app/(dashboard)/dashboard/providers/[id]/connectionSelection.js";
import { createConnectionSelectionGesture } from "@/app/(dashboard)/dashboard/providers/[id]/connectionSelectionGesture.js";

const makeConnections = (ids) => ids.map((id) => ({ id }));

describe("computeDragSelection", () => {
  it("selects a forward range inclusive of both ends", () => {
    const connections = makeConnections(["a", "b", "c", "d"]);
    expect(computeDragSelection(connections, 1, 3)).toEqual(["b", "c", "d"]);
  });

  it("selects a backward range inclusive of both ends", () => {
    const connections = makeConnections(["a", "b", "c", "d"]);
    expect(computeDragSelection(connections, 3, 1)).toEqual(["b", "c", "d"]);
  });

  it("unions the dragged range with the selection that existed before the drag", () => {
    const connections = makeConnections(["a", "b", "c", "d", "e"]);
    expect(computeDragSelection(connections, 2, 4, ["a"])).toEqual(["a", "c", "d", "e"]);
  });

  it("clamps indices outside the connections array", () => {
    const connections = makeConnections(["a", "b", "c"]);
    expect(computeDragSelection(connections, -5, 1)).toEqual(["a", "b"]);
    expect(computeDragSelection(connections, 1, 99)).toEqual(["b", "c"]);
  });

  it("returns the base ids when connections is empty or not an array", () => {
    expect(computeDragSelection([], 0, 1, ["x"])).toEqual(["x"]);
    expect(computeDragSelection(null, 0, 1, ["x"])).toEqual(["x"]);
    expect(computeDragSelection(undefined, 0, 1, ["x"])).toEqual(["x"]);
    expect(computeDragSelection("nope", 0, 1, ["y"])).toEqual(["y"]);
    expect(computeDragSelection([], 0, 1)).toEqual([]);
  });

  it("dedupes ids from the base selection, the dragged range or the list itself", () => {
    const connections = makeConnections(["a", "b", "c"]);
    expect(computeDragSelection(connections, 0, 1, ["a", "b"], true)).toEqual(["a", "b"]);
    const duplicated = makeConnections(["a", "a", "b"]);
    expect(computeDragSelection(duplicated, 0, 2)).toEqual(["a", "b"]);
  });

  it("does not mutate the connections or base arrays", () => {
    const connections = makeConnections(["a", "b", "c"]);
    const base = ["c"];
    const connectionsCopy = connections.map((conn) => ({ ...conn }));
    const baseCopy = [...base];
    computeDragSelection(connections, 0, 2, base);
    expect(connections).toEqual(connectionsCopy);
    expect(base).toEqual(baseCopy);
  });

  it("treats a non-array base as empty", () => {
    const connections = makeConnections(["a", "b"]);
    expect(computeDragSelection(connections, 0, 0, null)).toEqual(["a"]);
  });
});

// Exercise the same controller used by the page, including native event order.
function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type, event = {}) {
      for (const listener of [...(listeners.get(type) || [])]) listener(event);
    },
    listenerCount() {
      return [...listeners.values()].reduce((count, group) => count + group.size, 0);
    },
  };
}

function gestureHarness(base = []) {
  vi.useFakeTimers();
  const window = { ...eventTarget(), setTimeout, clearTimeout };
  const document = { ...eventTarget(), hidden: false, body: { style: { userSelect: "text" } } };
  const connections = makeConnections(["a", "b", "c", "d", "e"]);
  let selected = base.slice();
  const toggle = vi.fn((id) => {
    selected = selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id];
  });
  const gesture = createConnectionSelectionGesture({
    window, document, onSelection: (ids) => { selected = ids; },
  });
  return {
    window, document, gesture, toggle,
    selected: () => selected,
    begin: (index, button = 0) => gesture.begin({ button }, index, connections, selected),
    enter: (index, buttons = 1) => gesture.extend({ buttons }, index),
    change: (id) => gesture.change(id, toggle),
  };
}

afterEach(() => vi.useRealTimers());

describe("connection selection gesture handlers", () => {
  it("adds from an unselected anchor, shrinking and reversing against the original base", () => {
    const h = gestureHarness(["e"]);
    h.begin(2);
    h.enter(4);
    expect(h.selected()).toEqual(["e", "c", "d"]);
    h.enter(3);
    expect(h.selected()).toEqual(["e", "c", "d"]);
    h.enter(2);
    expect(h.selected()).toEqual(["e", "c"]);
    h.enter(0);
    expect(h.selected()).toEqual(["e", "a", "b", "c"]);
    h.gesture.dispose();
  });

  it("removes from a selected anchor, restoring outside-range ids on shrink and reversal", () => {
    const h = gestureHarness(["a", "b", "c", "d", "e"]);
    h.begin(2);
    h.enter(4);
    expect(h.selected()).toEqual(["a", "b"]);
    h.enter(3);
    expect(h.selected()).toEqual(["a", "b", "e"]);
    h.enter(2);
    expect(h.selected()).toEqual(["a", "b", "d", "e"]);
    h.enter(0);
    expect(h.selected()).toEqual(["d", "e"]);
    h.gesture.dispose();
  });

  it.each([{ base: [] }, { base: ["b"] }])("plain click toggles exactly once from $base", ({ base }) => {
    const h = gestureHarness(base);
    h.begin(1);
    h.window.emit("mouseup", { button: 0 });
    h.change("b");
    expect(h.toggle).toHaveBeenCalledExactlyOnceWith("b");
    expect(h.selected()).toEqual(base.length ? [] : ["b"]);
    expect(h.document.body.style.userSelect).toBe("text");
    expect(h.window.listenerCount()).toBe(0);
    expect(h.document.listenerCount()).toBe(0);
    h.gesture.dispose();
  });

  it("suppresses checkbox change during and immediately after drag, not the next click", () => {
    const h = gestureHarness();
    h.begin(0);
    h.enter(2);
    h.change("a");
    h.window.emit("mouseup", { button: 0 });
    h.change("a");
    expect(h.selected()).toEqual(["a", "b", "c"]);
    expect(h.toggle).not.toHaveBeenCalled();
    vi.runAllTimers();
    h.begin(0);
    h.window.emit("mouseup", { button: 0 });
    h.change("a");
    expect(h.selected()).toEqual(["b", "c"]);
    h.gesture.dispose();
  });

  it.each(["row", "window"])("detects lost mouseup on %s movement with buttons===0", (source) => {
    const h = gestureHarness();
    h.begin(0);
    h.enter(1);
    if (source === "row") h.enter(3, 0);
    else h.window.emit("mousemove", { buttons: 0 });
    h.enter(4);
    expect(h.selected()).toEqual(["a", "b"]);
    expect(h.document.body.style.userSelect).toBe("text");
    expect(h.window.listenerCount()).toBe(0);
    h.gesture.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["blur", "pointercancel", "hidden", "unmount"])("cleans up on %s and ignores later hover", (reason) => {
    const h = gestureHarness();
    h.begin(0);
    h.enter(1);
    if (reason === "hidden") {
      h.document.hidden = true;
      h.document.emit("visibilitychange");
    } else if (reason === "unmount") h.gesture.dispose();
    else h.window.emit(reason);
    h.enter(4);
    expect(h.selected()).toEqual(["a", "b"]);
    expect(h.document.body.style.userSelect).toBe("text");
    expect(h.window.listenerCount()).toBe(0);
    expect(h.document.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    h.gesture.dispose();
  });

  it("rejects right-button gestures and does not end a left drag on right-button mouseup", () => {
    const h = gestureHarness();
    h.begin(0, 2);
    h.enter(2, 2);
    expect(h.selected()).toEqual([]);
    expect(h.window.listenerCount()).toBe(0);
    expect(h.document.body.style.userSelect).toBe("text");
    h.begin(0);
    h.window.emit("mouseup", { button: 2 });
    h.enter(1, 3);
    expect(h.selected()).toEqual(["a", "b"]);
    h.enter(3, 2);
    h.enter(4);
    expect(h.selected()).toEqual(["a", "b"]);
    h.gesture.dispose();
  });

  it("navigation disposal clears pending suppression and cannot attach new listeners", () => {
    const h = gestureHarness();
    h.begin(0);
    h.enter(1);
    h.window.emit("mouseup", { button: 0 });
    expect(vi.getTimerCount()).toBe(1);
    h.gesture.dispose();
    h.begin(2);
    h.change("c");
    expect(h.selected()).toEqual(["a", "b"]);
    expect(h.window.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
