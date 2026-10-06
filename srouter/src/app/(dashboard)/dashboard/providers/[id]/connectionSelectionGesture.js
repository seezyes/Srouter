import { computeDragSelection } from "./connectionSelection";

/** Mouse lifecycle shared by the page handlers and offline tests. */
export function createConnectionSelectionGesture({ window, document, onSelection }) {
  let drag = null;
  let suppressChange = false;
  let suppressionTimer = null;
  let disposed = false;

  const clearSuppression = () => {
    if (suppressionTimer !== null) window.clearTimeout(suppressionTimer);
    suppressionTimer = null;
    suppressChange = false;
  };

  const finish = (suppressClick = false) => {
    if (!drag) return;
    const { moved, previousUserSelect } = drag;
    drag = null;
    window.removeEventListener("mouseup", onMouseUp, true);
    window.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("blur", onCancel);
    window.removeEventListener("pointercancel", onCancel);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    document.body.style.userSelect = previousUserSelect;
    if (moved && suppressClick) {
      clearSuppression();
      suppressChange = true;
      // Native checkbox change follows mouseup synchronously, before this task.
      suppressionTimer = window.setTimeout(clearSuppression, 0);
    }
  };

  const onMouseUp = (event) => {
    if (event.button === 0) finish(true);
  };
  const onMouseMove = (event) => {
    if ((event.buttons & 1) === 0) finish(true);
  };
  const onCancel = () => {
    finish();
    clearSuppression();
  };
  const onVisibilityChange = () => {
    if (document.hidden) onCancel();
  };

  return {
    begin(event, index, connections, selectedIds) {
      if (disposed || event.button !== 0 || !connections[index]?.id) return;
      onCancel();
      drag = {
        anchorIndex: index,
        lastIndex: index,
        connections: connections.slice(),
        base: selectedIds.slice(),
        select: !selectedIds.includes(connections[index].id),
        moved: false,
        previousUserSelect: document.body.style.userSelect,
      };
      document.body.style.userSelect = "none";
      window.addEventListener("mouseup", onMouseUp, true);
      window.addEventListener("mousemove", onMouseMove, true);
      window.addEventListener("blur", onCancel);
      window.addEventListener("pointercancel", onCancel);
      document.addEventListener("visibilitychange", onVisibilityChange);
    },
    extend(event, index) {
      if (!drag) return;
      if ((event.buttons & 1) === 0) {
        finish(true);
        return;
      }
      if (index === drag.lastIndex) return;
      drag.moved = true;
      drag.lastIndex = index;
      onSelection(computeDragSelection(drag.connections, drag.anchorIndex, index, drag.base, drag.select));
    },
    change(connectionId, toggle) {
      if (disposed || suppressChange || drag?.moved) return;
      toggle(connectionId);
    },
    dispose() {
      onCancel();
      disposed = true;
    },
  };
}
