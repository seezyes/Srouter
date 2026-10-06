import { useState, useEffect } from "react";
import PropTypes from "prop-types";

/**
 * Countdown for a per-connection time value.
 *
 * Two uses (owner policy 2026-10-05):
 * - without `label`: the local retry window (⏱) — how long the router keeps
 *   repeat attempts local before making a real upstream attempt again;
 * - with `label` (e.g. "reset"): the announced quota reset (⟳) reported by the
 *   provider. Informational only: it never blocks selection on its own.
 */
export default function CooldownTimer({ until, label = null }) {
  const [remaining, setRemaining] = useState("");

  useEffect(() => {
    const updateRemaining = () => {
      const diff = new Date(until).getTime() - Date.now();
      if (diff <= 0) {
        setRemaining("");
        return;
      }
      const secs = Math.floor(diff / 1000);
      if (secs < 60) {
        setRemaining(`${secs}s`);
      } else if (secs < 3600) {
        setRemaining(`${Math.floor(secs / 60)}m ${secs % 60}s`);
      } else {
        const hrs = Math.floor(secs / 3600);
        const mins = Math.floor((secs % 3600) / 60);
        setRemaining(`${hrs}h ${mins}m`);
      }
    };

    updateRemaining();
    const interval = setInterval(updateRemaining, 1000);
    return () => clearInterval(interval);
  }, [until]);

  if (!remaining) return null;

  return label ? (
    <span className="font-mono text-xs text-text-muted" title="Provider-reported quota reset">
      ⟳ {label} {remaining}
    </span>
  ) : (
    <span className="font-mono text-xs text-orange-500">
      ⏱ {remaining}
    </span>
  );
}

CooldownTimer.propTypes = {
  until: PropTypes.string.isRequired,
  label: PropTypes.string,
};
