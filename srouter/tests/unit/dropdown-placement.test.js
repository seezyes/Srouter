import { describe, expect, it } from "vitest";
import {
  ROW_MENU_ESTIMATED_HEIGHT,
  shouldOpenUpward,
} from "@/shared/utils/dropdownPlacement.js";

/**
 * Row action menus open inside a scrollable connection list, so a menu with no
 * room below its button was clipped by the list and the last account's Pool menu
 * showed up as a sliver. These assert the flip decision itself.
 */
describe("shouldOpenUpward", () => {
  const viewportHeight = 800;

  it("keeps the menu below when there is room", () => {
    expect(shouldOpenUpward({ anchorTop: 100, anchorBottom: 130, viewportHeight })).toBe(false);
  });

  it("flips the menu up for a row near the bottom of the viewport", () => {
    expect(shouldOpenUpward({ anchorTop: 740, anchorBottom: 770, viewportHeight })).toBe(true);
  });

  it("flips only when the room above is the better side", () => {
    // A button at the very top of a short viewport has nowhere good to open.
    expect(shouldOpenUpward({ anchorTop: 10, anchorBottom: 40, viewportHeight: 60 })).toBe(false);
  });

  it("honours a shorter menu height", () => {
    expect(
      shouldOpenUpward({ anchorTop: 400, anchorBottom: 430, viewportHeight, menuHeight: 20 }),
    ).toBe(false);
  });

  it("falls back to opening downward without a measurable anchor", () => {
    expect(shouldOpenUpward({ anchorTop: NaN, anchorBottom: 10, viewportHeight })).toBe(false);
    expect(shouldOpenUpward({})).toBe(false);
  });

  it("estimates a menu tall enough for a normal pool list", () => {
    expect(ROW_MENU_ESTIMATED_HEIGHT).toBeGreaterThanOrEqual(120);
  });
});
