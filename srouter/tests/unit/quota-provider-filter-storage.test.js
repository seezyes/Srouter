import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QUOTA_PROVIDER_FILTER_KEY,
  readQuotaProviderFilter,
  resolveQuotaProviderFilter,
  saveQuotaProviderFilter,
  subscribeQuotaProviderFilter,
} from "../../src/shared/utils/quotaProviderFilterStorage.js";

afterEach(() => vi.unstubAllGlobals());

function browser() {
  const target = new EventTarget();
  const values = new Map();
  target.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  vi.stubGlobal("window", target);
  return target;
}

describe("quota provider filter persistence", () => {
  it("prioritizes explicit URL including all and empty over saved selection", () => {
    expect(resolveQuotaProviderFilter("codex", "factory")).toBe("codex");
    expect(resolveQuotaProviderFilter("all", "factory")).toBe("all");
    expect(resolveQuotaProviderFilter("", "factory")).toBe("all");
    expect(resolveQuotaProviderFilter(null, "codex,factory")).toBe("codex,factory");
  });

  it("restores the last selection and persists the all-provider reset", () => {
    browser();
    saveQuotaProviderFilter("codex, factory,codex");
    expect(readQuotaProviderFilter()).toBe("codex,factory");
    saveQuotaProviderFilter("all");
    expect(readQuotaProviderFilter()).toBe("all");
    expect(window.localStorage.getItem(QUOTA_PROVIDER_FILTER_KEY)).toBe("all");
  });

  it("notifies local subscribers and removes listeners on unmount", () => {
    browser();
    const onChange = vi.fn();
    const unsubscribe = subscribeQuotaProviderFilter(onChange);
    saveQuotaProviderFilter("codex");
    expect(onChange).toHaveBeenCalledTimes(1);
    unsubscribe();
    saveQuotaProviderFilter("factory");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("fails safely without browser storage or when storage throws", () => {
    vi.stubGlobal("window", undefined);
    expect(readQuotaProviderFilter()).toBe("all");
    expect(() => saveQuotaProviderFilter("codex")).not.toThrow();
    vi.stubGlobal("window", {
      get localStorage() { throw new Error("Blocked"); },
    });
    expect(readQuotaProviderFilter()).toBe("all");
    expect(() => saveQuotaProviderFilter("codex")).not.toThrow();
    expect(resolveQuotaProviderFilter("codex", readQuotaProviderFilter())).toBe("codex");
  });
});
