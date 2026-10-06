"use client";

// The mark is pre-rendered raster artwork embedded in a static SVG wrapper.
// The private artwork generator is not part of this source tree.
//
// A plain <img> on purpose: /favicon.svg is a fixed-size static brand asset with
// the sizing driven by the caller, so next/image has nothing to optimize here.

export default function SrouterMark({ size = 36, className = "" }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/favicon.svg"
      width={size}
      height={size}
      className={className}
      alt="Srouter"
      draggable={false}
    />
  );
}
