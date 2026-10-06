"use client";

/**
 * Browser presentation store — backdrop state and the developer-mode gate.
 *
 * Persisted to localStorage and read by:
 *   - IsoCubeBackground (applies CSS backdrop variables + baked layer opacity),
 *   - Settings and Import (the developer-mode gate).
 *
 * The generator/icon editor and their settings are archived outside Srouter.
 * Obsolete geometry/animation/mark fields are not rehydrated into this store.
 *
 * Defaults live in src/shared/constants/uiSettings.js so the pre-paint script
 * in src/app/layout.js can share them.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DEFAULT_BACKDROP,
  DEFAULT_CUBE,
  UI_STORAGE_KEY,
  applyBackdropVars,
} from "@/shared/constants/uiSettings";

const useUIStore = create(
  persist(
    (set, get) => ({
      developerMode: false,
      backdrop: { ...DEFAULT_BACKDROP },
      cube: { ...DEFAULT_CUBE },

      setDeveloperMode: (developerMode) => set({ developerMode: !!developerMode }),

      setBackdrop: (patch) => {
        const backdrop = { ...get().backdrop, ...(patch || {}) };
        set({ backdrop });
        applyBackdropVars(backdrop);
      },

      setCube: (patch) => set({ cube: { ...get().cube, ...(patch || {}) } }),

      resetBackdrop: () => {
        const backdrop = { ...DEFAULT_BACKDROP };
        set({ backdrop });
        applyBackdropVars(backdrop);
      },

      resetCube: () => set({ cube: { ...DEFAULT_CUBE } }),
    }),
    {
      name: UI_STORAGE_KEY,
      // Merge persisted state over the defaults so a store written by an older
      // build never loses newly added option keys. Only supported slices are read;
      // obsolete browser fields are ignored without rewriting storage on hydration.
      merge: (persisted, current) => ({
        ...current,
        developerMode: persisted?.developerMode ?? current.developerMode,
        backdrop: { ...DEFAULT_BACKDROP, ...(persisted?.backdrop || {}) },
        cube: {
          enabled: persisted?.cube?.enabled ?? DEFAULT_CUBE.enabled,
          dim: persisted?.cube?.dim ?? DEFAULT_CUBE.dim,
        },
      }),
      onRehydrateStorage: () => (state) => {
        if (state) applyBackdropVars(state.backdrop);
      },
    },
  ),
);

export default useUIStore;
