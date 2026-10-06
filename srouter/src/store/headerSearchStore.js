/**
 * Header Search Store — Zustand-based reusable search input in Header.
 * Pages register placeholder on mount, read query, unregister on unmount.
 */

import { create } from "zustand";

export const useHeaderSearchStore = create((set) => ({
  query: "",
  placeholder: "",
  visible: false,
  filterOptions: [],
  filterValue: "all",

  setQuery: (query) => set({ query }),
  setFilterValue: (filterValue) => set({ filterValue }),

  register: (placeholder = "Search...", filterOptions = []) =>
    set({ visible: true, placeholder, query: "", filterOptions, filterValue: "all" }),

  unregister: () => set({ visible: false, placeholder: "", query: "", filterOptions: [], filterValue: "all" }),
}));
