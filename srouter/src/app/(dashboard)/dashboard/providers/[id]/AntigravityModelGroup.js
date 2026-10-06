"use client";

import { useRef, useState } from "react";
import PropTypes from "prop-types";

export default function AntigravityModelGroup({ name, models, renderModel }) {
  const [expanded, setExpanded] = useState(false);
  const focusRequested = useRef(false);
  const toggle = () => {
    focusRequested.current = true;
    setExpanded((value) => !value);
  };
  const focusControl = (node) => {
    if (node && focusRequested.current) {
      node.focus();
      focusRequested.current = false;
    }
  };

  if (expanded) {
    return models.map((model, index) => (
      <div key={model.id} className="relative min-w-0 max-w-full">
        {renderModel(model)}
        {index === 0 && (
          <button
            ref={focusControl}
            type="button"
            aria-expanded={true}
            aria-label={`Collapse ${name} variants`}
            onClick={toggle}
            className="absolute right-1 top-full z-20 -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs leading-none text-text-muted shadow-sm hover:text-text-primary focus-visible:outline-2 focus-visible:outline-primary"
          >
            <span aria-hidden="true">⌃ </span>Collapse {name}
          </button>
        )}
      </div>
    ));
  }

  return (
    <button
      ref={focusControl}
      type="button"
      aria-expanded={false}
      aria-label={`Expand ${name} variants: ${models.map((model) => model.name || model.id).join(", ")}`}
      onClick={toggle}
      className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left hover:bg-sidebar/50 focus-visible:outline-2 focus-visible:outline-primary"
    >
      <span aria-hidden="true" className="material-symbols-outlined shrink-0 text-base">smart_toy</span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-xs font-semibold">{name}</span>
        <span className="text-[10px] text-text-muted">{models.length} variants</span>
      </span>
      <span aria-hidden="true" className="material-symbols-outlined shrink-0 text-sm text-text-muted">expand_more</span>
    </button>
  );
}

AntigravityModelGroup.propTypes = {
  name: PropTypes.string.isRequired,
  models: PropTypes.arrayOf(PropTypes.shape({ id: PropTypes.string.isRequired })).isRequired,
  renderModel: PropTypes.func.isRequired,
};
