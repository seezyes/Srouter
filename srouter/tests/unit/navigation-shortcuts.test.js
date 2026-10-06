import { describe, expect, it, vi } from "vitest";
import { createNavigationShortcuts, PRIMARY_SHORTCUTS, SYSTEM_SHORTCUTS } from "../../src/shared/utils/navigationShortcuts.js";

const event = (key, extra = {}) => ({
  key, code: /^\d$/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`,
  preventDefault: vi.fn(), ...extra,
});

describe("dashboard shortcuts", () => {
  it.each(Object.entries(PRIMARY_SHORTCUTS))("opens %s only on release", (key, target) => {
    const activate = vi.fn();
    const keys = createNavigationShortcuts(activate);
    keys.keydown(event(key));
    expect(activate).not.toHaveBeenCalled();
    keys.keyup(event(key));
    expect(activate).toHaveBeenCalledExactlyOnceWith(target);
  });
  it.each(Object.entries(SYSTEM_SHORTCUTS))("handles %s without primary navigation", (chord, target) => {
    for (const order of [chord.split("+"), chord.split("+").reverse()]) {
      const activate = vi.fn();
      const keys = createNavigationShortcuts(activate);
      order.forEach((key) => keys.keydown(event(key)));
      order.forEach((key) => keys.keyup(event(key)));
      expect(activate).toHaveBeenCalledExactlyOnceWith(target);
    }
  });
  it("opens Settings on 4+5 and leaves 5+6 inert", () => {
    expect(SYSTEM_SHORTCUTS["4+5"]).toBe("/dashboard/profile");
    expect(SYSTEM_SHORTCUTS["5+6"]).toBeUndefined();
    const activate = vi.fn();
    const keys = createNavigationShortcuts(activate);
    keys.keydown(event("4"));
    keys.keydown(event("5"));
    keys.keyup(event("5"));
    keys.keyup(event("4"));
    expect(activate).toHaveBeenCalledExactlyOnceWith("/dashboard/profile");
    activate.mockClear();
    keys.keydown(event("5"));
    keys.keydown(event("6"));
    keys.keyup(event("6"));
    keys.keyup(event("5"));
    expect(activate).not.toHaveBeenCalled();
  });
  it.each(["1", "e"])("ignores inputs, composition, modifiers and blocked overlays for %s", (key) => {
    const activate = vi.fn();
    const keys = createNavigationShortcuts(activate);
    for (const extra of [
      { target: { closest: () => ({}) } }, { target: { isContentEditable: true } },
      { isComposing: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true },
      { defaultPrevented: true },
    ]) {
      keys.keydown(event(key, extra));
      keys.keyup(event(key, extra));
    }
    const blocked = createNavigationShortcuts(activate, () => true);
    blocked.keydown(event(key));
    blocked.keyup(event(key));
    expect(activate).not.toHaveBeenCalled();
  });
  it("resets on blur and suppresses repeats and unknown chords", () => {
    const activate = vi.fn();
    const keys = createNavigationShortcuts(activate);
    keys.keydown(event("1"));
    keys.reset();
    keys.keyup(event("1"));
    keys.keydown(event("1"));
    keys.keydown(event("1", { repeat: true }));
    keys.keydown(event("3"));
    keys.keyup(event("3"));
    keys.keyup(event("1"));
    expect(activate).not.toHaveBeenCalled();
  });
  it.each([
    ["й", "KeyQ", "/dashboard/plugins"],
    ["ц", "KeyW", "/dashboard/harness"],
    ["у", "KeyE", "/dashboard/search"],
  ])("uses physical %s/%s for non-English layouts", (key, code, target) => {
    const activate = vi.fn();
    const keys = createNavigationShortcuts(activate);
    keys.keydown(event(key, { code }));
    keys.keyup(event(key, { code }));
    expect(activate).toHaveBeenCalledExactlyOnceWith(target);
  });
});
