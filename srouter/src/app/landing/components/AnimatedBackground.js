"use client";

import IsoCubeBackground from "./IsoCubeBackground";

/**
 * Landing background.
 *
 * The previous square `linear-gradient` grid + three animated blur "orbs" (and
 * their `blob` keyframes) are replaced by the static Iso Cube Field: one baked
 * raster, no animation loop, drawn behind all landing content.
 */
export default function AnimatedBackground() {
  return <IsoCubeBackground />;
}
