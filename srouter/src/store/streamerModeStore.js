"use client";

import {
  createStreamerPrivacyGuard, readStreamerPreference, writeStreamerPreference,
  STREAMER_STORAGE_KEY,
} from "@/shared/utils/streamerPrivacy";

let enabled = false;
let guard = null;
const listeners = new Set();
export const getStreamerMode = () => enabled;
export const getServerStreamerMode = () => false;
export const subscribeStreamerMode = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function storage() {
  try { return window.localStorage; } catch { return null; }
}

function apply(enabledValue) {
  enabled = enabledValue === true;
  guard?.setEnabled(enabled);
  for (const listener of listeners) listener();
}

export function setStreamerMode(value) {
  apply(value);
  writeStreamerPreference(storage(), enabled);
}

export function mountStreamerMode() {
  guard = createStreamerPrivacyGuard(document);
  apply(readStreamerPreference(storage()));
  const onStorage = event => {
    if (event.storageArea === storage() && (event.key === STREAMER_STORAGE_KEY || event.key === null)) {
      apply(readStreamerPreference(storage()));
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener("storage", onStorage);
    guard.dispose();
    guard = null;
  };
}
