"use client";

import Card from "./Card";
import { USAGE_CHART_LAYOUT } from "../constants/usageChartLayout";

export default function UsageChartSkeleton({ kind = "usage" }) {
  if (kind === "requests") {
    return <Card padding="sm" style={{ height: 480 }} className="min-w-0 motion-safe:animate-pulse" aria-hidden="true" />;
  }
  if (kind === "topology") {
    return (
      <div
        className="panel-vignette h-[320px] w-full min-w-0 rounded-lg border border-border bg-bg-subtle/30 sm:h-[480px] motion-safe:animate-pulse"
        aria-hidden="true"
      />
    );
  }
  const layout = USAGE_CHART_LAYOUT[kind];
  return (
    <Card padding="none" className={USAGE_CHART_LAYOUT.cardClassName} aria-hidden="true">
      <div style={{ height: layout.headerHeight }} className="shrink-0 rounded-lg bg-bg-subtle/50 motion-safe:animate-pulse" />
      <div style={{ height: layout.bodyHeight }} className="shrink-0 rounded-lg bg-bg-subtle/50 motion-safe:animate-pulse" />
    </Card>
  );
}
