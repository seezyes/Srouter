import { describe, expect, it } from "vitest";
import { mergeWithDefaults } from "../../src/lib/db/repos/settingsRepo.js";

describe("Token Saver opt-in defaults", () => {
  it.each([null, {}, { rtkEnabled: undefined, loopGuardEnabled: undefined }])("defaults RTK and Loop guard off for %j", (raw) => {
    const settings = mergeWithDefaults(raw);
    expect(settings.rtkEnabled).toBe(false);
    expect(settings.loopGuardEnabled).toBe(false);
  });

  it.each([true, false])("preserves explicit saved value %s without changing the input", (enabled) => {
    const raw = { rtkEnabled: enabled, loopGuardEnabled: enabled };
    expect(mergeWithDefaults(raw)).toMatchObject(raw);
    expect(raw).toEqual({ rtkEnabled: enabled, loopGuardEnabled: enabled });
  });
});
