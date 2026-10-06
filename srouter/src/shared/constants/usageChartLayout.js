// Shared geometry for the real charts and both scheduling/chunk placeholders.
// Card border + responsive padding + gap are identical in every state.
export const USAGE_CHART_LAYOUT = {
  cardClassName: "flex min-w-0 flex-col gap-3 p-3 sm:p-4",
  usage: { headerHeight: 38, bodyHeight: 220 },
  provider: { headerHeight: 30, bodyHeight: 180 },
  models: { headerHeight: 30, bodyHeight: 180 },
};
