"use client";

import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

// Native top layer escapes scroll clipping and the disabled row's opacity.
export default function TopLayerMenu({ anchorRef, onClose, children }) {
  const menuRef = useRef(null);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const anchor = anchorRef.current;
    if (!menu || !anchor) return;
    const position = () => {
      const rect = anchor.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8))}px`;
    };
    menu.showPopover();
    position();
    // Dismiss on scroll rather than trying to follow a row outside its viewport.
    const scroll = (event) => { if (!menu.contains(event.target)) onClose(); };
    window.addEventListener("resize", position);
    window.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [anchorRef, onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={menuRef}
      popover="auto"
      onToggle={(event) => { if (event.newState === "closed") onClose(); }}
      onClick={(event) => event.stopPropagation()}
      className="fixed inset-auto m-0 min-w-[160px] max-w-[calc(100vw-16px)] max-h-[min(320px,80vh)] overflow-y-auto rounded-lg border border-border bg-white py-1 text-text-main shadow-xl dark:bg-[#181b24]"
    >
      {children}
    </div>,
    document.body,
  );
}
