"use client";

import { useRef, useState } from "react";
import PropTypes from "prop-types";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { getProviderIconSrc } from "@/shared/utils/providerIcon";
import styles from "./ProviderCardGroup.module.css";

export default function ProviderCardGroup({ name, entries, renderCard, iconSrc }) {
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
    return entries.map(([id, provider], index) => (
      // `relative` + an absolute toggle keeps the grid cell at its natural card
      // height: the control overlays the card edge instead of being laid out
      // under it, so revealed pairs no longer make the first row taller.
      <div key={id} className={`${styles.reveal} relative flex min-w-0 flex-col [&>a]:flex-1`}>
        {renderCard([id, provider])}
        {index === 0 && (
          <button
            ref={focusControl}
            type="button"
            aria-expanded={true}
            aria-label={`Collapse ${name} providers`}
            onClick={toggle}
            className="absolute right-1 top-full z-20 -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs leading-none text-text-muted shadow-sm hover:text-text-primary focus-visible:outline-2 focus-visible:outline-primary"
          >
            <span aria-hidden="true">⌃ </span>Collapse {name}
          </button>
        )}
      </div>
    ));
  }

  const provider = entries[0][1];
  return (
    <button
      ref={focusControl}
      type="button"
      aria-expanded={false}
      aria-label={`Expand ${name} providers: ${entries.map(([, info]) => info.name).join(", ")}`}
      onClick={toggle}
      className={`${styles.reveal} flex min-w-0 items-center gap-3 rounded-xl border border-border bg-surface p-3 text-left transition-colors hover:bg-black/[0.01] dark:hover:bg-white/[0.01] focus-visible:outline-2 focus-visible:outline-primary`}
    >
      <ProviderIcon
        src={iconSrc || getProviderIconSrc(provider.id)}
        alt=""
        size={30}
        className="shrink-0 rounded-lg"
        fallbackText={provider.textIcon || name.slice(0, 2)}
        fallbackColor={provider.color}
      />
      <div className="min-w-0 flex-1">
        <h3 className="font-semibold">{name}</h3>
        <p className="text-xs text-text-muted">
          {entries.map(([, info]) => info.name).join(" · ")}
        </p>
      </div>
      <span aria-hidden="true" className="material-symbols-outlined shrink-0 text-text-muted">expand_more</span>
    </button>
  );
}

ProviderCardGroup.propTypes = {
  name: PropTypes.string.isRequired,
  entries: PropTypes.array.isRequired,
  renderCard: PropTypes.func.isRequired,
  iconSrc: PropTypes.string,
};
