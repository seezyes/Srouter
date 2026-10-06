import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setEnabled: vi.fn(), dispose: vi.fn(), storage: new Map(), events: new Map(),
}));
vi.mock("@/shared/utils/streamerPrivacy", async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    createStreamerPrivacyGuard: () => ({ setEnabled: mocks.setEnabled, dispose: mocks.dispose }),
  };
});

let store;
let localStorage;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.storage.clear();
  mocks.events.clear();
  localStorage = {
    getItem: key => mocks.storage.get(key) ?? null,
    setItem: vi.fn((key, value) => mocks.storage.set(key, value)),
  };
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", {
    localStorage,
    addEventListener: (type, listener) => mocks.events.set(type, listener),
    removeEventListener: (type, listener) => {
      if (mocks.events.get(type) === listener) mocks.events.delete(type);
    },
  });
  store = await import("../../src/store/streamerModeStore.js");
});
afterEach(() => vi.unstubAllGlobals());

describe("browser-local streamer store", () => {
  it("uses a stable SSR default and hydrates the persisted boolean", () => {
    mocks.storage.set("srouter.streamerMode", "true");
    expect(store.getServerStreamerMode()).toBe(false);
    const unmount = store.mountStreamerMode();
    expect(store.getStreamerMode()).toBe(true);
    expect(mocks.setEnabled).toHaveBeenLastCalledWith(true);
    unmount();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.events.has("storage")).toBe(false);
    // Persisted preference survives navigation/unmount.
    expect(mocks.storage.get("srouter.streamerMode")).toBe("true");
  });

  it("applies synchronously before persisting or notifying React subscribers", () => {
    const order = [];
    mocks.setEnabled.mockImplementation(() => order.push("guard"));
    const unsubscribe = store.subscribeStreamerMode(() => order.push("subscriber"));
    const unmount = store.mountStreamerMode();
    order.length = 0;
    store.setStreamerMode(true);
    expect(order).toEqual(["guard", "subscriber"]);
    expect(localStorage.setItem).toHaveBeenLastCalledWith("srouter.streamerMode", "true");
    unsubscribe();
    order.length = 0;
    store.setStreamerMode(false);
    expect(order).toEqual(["guard"]);
    unmount();
  });

  it("synchronizes same-origin tabs and clearing storage without accepting other storage areas", () => {
    const unmount = store.mountStreamerMode();
    mocks.storage.set("srouter.streamerMode", "true");
    const onStorage = mocks.events.get("storage");
    onStorage({ key: "srouter.streamerMode", storageArea: {} });
    expect(store.getStreamerMode()).toBe(false);
    onStorage({ key: "other-setting", storageArea: localStorage });
    expect(store.getStreamerMode()).toBe(false);
    onStorage({ key: "srouter.streamerMode", storageArea: localStorage });
    expect(store.getStreamerMode()).toBe(true);
    mocks.storage.clear();
    onStorage({ key: null, storageArea: localStorage });
    expect(store.getStreamerMode()).toBe(false);
    unmount();
  });

  it("still toggles in memory when browser storage is blocked", () => {
    Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } });
    const unmount = store.mountStreamerMode();
    expect(store.getStreamerMode()).toBe(false);
    expect(() => store.setStreamerMode(true)).not.toThrow();
    expect(store.getStreamerMode()).toBe(true);
    expect(mocks.setEnabled).toHaveBeenLastCalledWith(true);
    unmount();
  });
});
