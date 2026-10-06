import { afterEach, describe, expect, it } from "vitest";
import { useHeaderSearchStore } from "../../src/store/headerSearchStore.js";

afterEach(() => useHeaderSearchStore.getState().unregister());

describe("header search filters", () => {
  it("keeps the search and status filter independent", () => {
    const options = [{ value: "all", label: "All" }, { value: "connected", label: "Connected" }];
    useHeaderSearchStore.getState().register("Search providers...", options);
    useHeaderSearchStore.getState().setQuery("Codex");
    useHeaderSearchStore.getState().setFilterValue("connected");
    expect(useHeaderSearchStore.getState()).toMatchObject({
      visible: true,
      query: "Codex",
      filterOptions: options,
      filterValue: "connected",
    });
  });

  it("clears filters when leaving the page or registering plain search", () => {
    useHeaderSearchStore.getState().register("Providers", [{ value: "all", label: "All" }]);
    useHeaderSearchStore.getState().setFilterValue("connected");
    useHeaderSearchStore.getState().unregister();
    expect(useHeaderSearchStore.getState()).toMatchObject({
      visible: false, query: "", filterOptions: [], filterValue: "all",
    });
    useHeaderSearchStore.getState().register("Providers", [{ value: "all", label: "All" }]);
    useHeaderSearchStore.getState().setFilterValue("connected");
    useHeaderSearchStore.getState().register("Search...");
    expect(useHeaderSearchStore.getState()).toMatchObject({
      visible: true, filterOptions: [], filterValue: "all",
    });
  });
});
