"use client";

import { useEffect } from "react";
import useUIStore from "@/store/uiStore";
import { applyBackdropVars, buildBakedCubeStyle } from "@/shared/constants/uiSettings";

/**
 * A repeating transparent compact 2x bitmap, shared by landing/login/dashboard.
 * The gradient and panel vignette remain CSS. Geometry is baked, not generated
 * in the browser; only enabled/dim and backdrop colours remain editable.
 */
export default function IsoCubeBackground({
  variant = "fixed",
  baseClassName = "",
}) {
  const backdrop = useUIStore((s) => s.backdrop);
  const cube = useUIStore((s) => s.cube);

  useEffect(() => {
    applyBackdropVars(backdrop);
  }, [backdrop]);

  const placement = variant === "contained" ? "absolute inset-0" : "fixed inset-0";

  return (
    <div
      aria-hidden="true"
      className={`${placement} -z-10 overflow-hidden pointer-events-none ${baseClassName}`}
    >
      <div data-cube-background="compact" style={buildBakedCubeStyle(cube)} />
    </div>
  );
}
