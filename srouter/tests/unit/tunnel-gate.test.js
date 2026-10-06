import { describe, it, expect } from "vitest";
import { tunnelSecurityBlockReason } from "../../src/lib/auth/tunnelGate.js";

describe("tunnel security gate", () => {
  it("refuses the tunnel while the public default password is still in place", () => {
    expect(tunnelSecurityBlockReason({ requireLogin: true })).toMatch(/custom dashboard password/i);
    expect(tunnelSecurityBlockReason({ requireLogin: "local", password: "" })).toMatch(/custom dashboard password/i);
  });

  it("refuses the tunnel when the login window is fully off", () => {
    const reason = tunnelSecurityBlockReason({ password: "bcrypt-hash", requireLogin: false });
    expect(reason).toMatch(/login policy/i);
  });

  it("allows the tunnel only with a custom password and a guarded policy", () => {
    expect(tunnelSecurityBlockReason({ password: "bcrypt-hash", requireLogin: true })).toBeNull();
    expect(tunnelSecurityBlockReason({ password: "bcrypt-hash", requireLogin: "local" })).toBeNull();
  });

  it("treats missing settings as unsafe", () => {
    expect(tunnelSecurityBlockReason(null)).toMatch(/custom dashboard password/i);
    expect(tunnelSecurityBlockReason(undefined)).toMatch(/custom dashboard password/i);
  });
});
