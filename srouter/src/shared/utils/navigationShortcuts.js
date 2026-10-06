export const PRIMARY_SHORTCUTS = {
  "1": "/dashboard/endpoint",
  "2": "/dashboard/providers",
  "3": "/dashboard/combos",
  "4": "/dashboard/usage",
  "5": "/dashboard/quota",
  q: "/dashboard/plugins",
  w: "/dashboard/harness",
  e: "/dashboard/search",
};

export const SYSTEM_SHORTCUTS = {
  "1+2": "media",
  "2+3": "network",
  "3+4": "/dashboard/console-log",
  "4+5": "/dashboard/profile",
};

export function shortcutKey(event) {
  if (/^Digit[1-6]$/.test(event.code)) return event.code.slice(-1);
  if (event.code === "KeyQ") return "q";
  if (event.code === "KeyW") return "w";
  if (event.code === "KeyE") return "e";
  return event.key?.toLowerCase();
}

export function createNavigationShortcuts(activate, blocked = () => false) {
  const pressed = new Set();
  let consumed = false;
  const reset = () => { pressed.clear(); consumed = false; };
  const ignored = (event) => event.defaultPrevented || event.isComposing ||
    event.ctrlKey || event.altKey || event.metaKey || event.shiftKey ||
    event.target?.isContentEditable ||
    event.target?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']") ||
    blocked();
  return {
    reset,
    keydown(event) {
      if (ignored(event)) { reset(); return; }
      const key = shortcutKey(event);
      if (!Object.hasOwn(PRIMARY_SHORTCUTS, key) && key !== "6") return;
      event.preventDefault();
      if (event.repeat || pressed.has(key)) return;
      pressed.add(key);
      if (pressed.size === 2 && !consumed) {
        const action = SYSTEM_SHORTCUTS[[...pressed].sort().join("+")];
        consumed = true;
        if (action) activate(action);
      }
    },
    keyup(event) {
      if (ignored(event)) { reset(); return; }
      const key = shortcutKey(event);
      if (!pressed.has(key)) return;
      event.preventDefault();
      if (pressed.size === 1 && !consumed && PRIMARY_SHORTCUTS[key]) {
        activate(PRIMARY_SHORTCUTS[key]);
      }
      pressed.delete(key);
      if (!pressed.size) consumed = false;
    },
  };
}
