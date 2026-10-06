/**
 * Row action menus (Proxy / Pool) are absolutely positioned inside a scrollable
 * connection list, so a menu taller than the space below its button gets clipped
 * by the list's own overflow. Those menus therefore flip upward when the button
 * sits near the bottom of the viewport.
 *
 * The positioning input is kept as a plain function so the decision is testable
 * without a DOM.
 */

// Rendered height of one row menu: a "none" entry plus a handful of pool names.
export const ROW_MENU_ESTIMATED_HEIGHT = 220;

export function shouldOpenUpward({
  anchorTop,
  anchorBottom,
  viewportHeight,
  menuHeight = ROW_MENU_ESTIMATED_HEIGHT,
}) {
  if (
    !Number.isFinite(anchorTop) ||
    !Number.isFinite(anchorBottom) ||
    !Number.isFinite(viewportHeight)
  ) {
    return false;
  }
  const spaceBelow = viewportHeight - anchorBottom;
  const spaceAbove = anchorTop;
  // Flip only when the menu genuinely does not fit below and the room above is
  // the better side — a tall viewport keeps the familiar downward menu.
  return spaceBelow < menuHeight && spaceAbove > spaceBelow;
}

/** DOM wrapper: reads the anchor button's box and asks shouldOpenUpward. */
export function menuOpensUpward(element, menuHeight) {
  if (!element || typeof window === "undefined") return false;
  const rect = element.getBoundingClientRect();
  return shouldOpenUpward({
    anchorTop: rect.top,
    anchorBottom: rect.bottom,
    viewportHeight: window.innerHeight,
    menuHeight,
  });
}
