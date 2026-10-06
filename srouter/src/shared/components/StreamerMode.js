"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";
import Toggle from "./Toggle";
import {
  getStreamerMode, getServerStreamerMode, subscribeStreamerMode,
  setStreamerMode, mountStreamerMode,
} from "@/store/streamerModeStore";

export function StreamerModeController() {
  useLayoutEffect(() => mountStreamerMode(), []);
  return null;
}

export default function StreamerModeToggle() {
  const enabled = useSyncExternalStore(subscribeStreamerMode, getStreamerMode, getServerStreamerMode);
  return (
    <button
      type="button"
      onClick={() => setStreamerMode(!enabled)}
      aria-label="Privacy Mode"
      aria-pressed={enabled}
      title={enabled ? "Privacy Mode on: hide secrets and all account names. Screen masking only; copied values remain unchanged." : "Enable Privacy Mode to hide secrets and all account names"}
      className={`flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm transition-colors ${enabled ? "bg-primary/15 text-primary ring-1 ring-primary/30" : "text-text-muted hover:bg-black/5 dark:hover:bg-white/5"}`}
    >
      <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
        {enabled ? "visibility_off" : "visibility"}
      </span>
    </button>
  );
}

export function PrivacyModeSettings() {
  const enabled = useSyncExternalStore(subscribeStreamerMode, getStreamerMode, getServerStreamerMode);
  return (
    <div>
      <div className="flex items-center justify-between gap-4 mb-4">
        <div className="flex items-center gap-3">
          <div className="size-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">visibility_off</span>
          </div>
          <h3 className="text-base sm:text-lg font-semibold">Privacy Mode</h3>
        </div>
        <Toggle checked={enabled} onChange={setStreamerMode} aria-label="Privacy Mode" />
      </div>
      <p className="text-sm text-text-muted">Hide secrets and all account names on screen.</p>
      <p className="text-xs text-text-muted mt-2">Saved only in this browser. Copied values remain unchanged.</p>
    </div>
  );
}
