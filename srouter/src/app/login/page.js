"use client";

import { useState, useEffect } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import IsoCubeBackground from "@/app/landing/components/IsoCubeBackground";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [resetHint, setResetHint] = useState("");
  const [retryAfter, setRetryAfter] = useState(0);
  const [loading, setLoading] = useState(false);
  const [hasPassword, setHasPassword] = useState(null);
  const [authMode, setAuthMode] = useState("password");
  const [ssoType, setSsoType] = useState("oidc");
  const [oidcConfigured, setOidcConfigured] = useState(false);
  const [oidcLoginLabel, setOidcLoginLabel] = useState("Sign in with OIDC");
  const [samlConfigured, setSamlConfigured] = useState(false);
  const [samlLoginLabel, setSamlLoginLabel] = useState("Sign in with SAML SSO");
  const [mustChange, setMustChange] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  // First-run helpers: shown only while no password is set and the page is open
  // on the host machine (fresh installs otherwise live on the public default).
  const [localRequest, setLocalRequest] = useState(false);
  const [firstRunMode, setFirstRunMode] = useState("none");
  const [firstRunPassword, setFirstRunPassword] = useState("");
  const [firstRunConfirm, setFirstRunConfirm] = useState("");
  const [firstRunLoading, setFirstRunLoading] = useState(false);
  const [firstRunError, setFirstRunError] = useState("");

  // Countdown for rate-limit
  useEffect(() => {
    if (retryAfter <= 0) return;
    const id = setInterval(() => setRetryAfter((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [retryAfter]);

  useEffect(() => {
    async function checkAuth() {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

      try {
        const res = await fetch(`${baseUrl}/api/auth/status`, {
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (res.ok) {
          const data = await res.json();
          // loginBypassed covers every policy level that lets this request through;
          // the middleware already redirected requests that must see the login form.
          if (data.authenticated === true || data.loginBypassed === true) {
            window.location.assign("/dashboard");
            return;
          }
          setHasPassword(!!data.hasPassword);
          setLocalRequest(data.localRequest === true);
          setAuthMode(data.authMode || "password");
          setSsoType(data.ssoType || "oidc");
          setOidcConfigured(data.oidcConfigured === true);
          setOidcLoginLabel(data.oidcLoginLabel || "Sign in with OIDC");
          setSamlConfigured(data.samlConfigured === true);
          setSamlLoginLabel(data.samlLoginLabel || "Sign in with SAML SSO");
        } else {
          // Safe fallback on non-OK response to avoid infinite loading state.
          setHasPassword(true);
        }
      } catch (err) {
        clearTimeout(timeoutId);
        setHasPassword(true);
      }
    }
    checkAuth();
  }, []);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setResetHint("");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.mustChangePassword) {
          setMustChange(true);
          return;
        }
        window.location.assign("/dashboard");
      } else {
        const data = await res.json();
        setError(data.error || "Invalid password");
        if (data.resetHint) setResetHint(data.resetHint);
        if (data.retryAfter) setRetryAfter(Number(data.retryAfter));
      }
    } catch (err) {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  // Force a new password before entering the dashboard (default + remote).
  const handleSetNewPassword = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: password, newPassword }),
      });
      if (res.ok) {
        window.location.assign("/dashboard");
      } else {
        const data = await res.json();
        setError(data.error || "Failed to set password");
      }
    } catch (err) {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleOidcLogin = () => {
    window.location.href = "/api/auth/oidc/start";
  };

  // First-run actions (local-only, only while no password is set): set a real
  // password, or drop the login window for requests from this machine.
  const callFirstRun = async (body) => {
    setFirstRunLoading(true);
    setFirstRunError("");
    try {
      const res = await fetch("/api/auth/first-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFirstRunError(data.error || "Failed to apply");
        return false;
      }
      return true;
    } catch (err) {
      setFirstRunError("An error occurred. Please try again.");
      return false;
    } finally {
      setFirstRunLoading(false);
    }
  };

  const handleFirstRunPassword = async (e) => {
    e.preventDefault();
    if (firstRunPassword !== firstRunConfirm) {
      setFirstRunError("Passwords do not match");
      return;
    }
    if (await callFirstRun({ action: "set-password", newPassword: firstRunPassword })) {
      window.location.assign("/dashboard");
    }
  };

  const handleFirstRunNoLogin = async () => {
    if (await callFirstRun({ action: "no-login-local" })) {
      window.location.assign("/dashboard");
    }
  };

  const handleSamlLogin = () => {
    window.location.href = "/api/auth/saml/start";
  };

  const isSsoEnabled = ["sso", "oidc", "saml", "both"].includes(authMode);
  const activeSsoType = ssoType || (authMode === "saml" ? "saml" : "oidc");

  const samlAvailable = isSsoEnabled && activeSsoType === "saml" && samlConfigured;
  const oidcAvailable = isSsoEnabled && activeSsoType === "oidc" && oidcConfigured;
  const ssoAvailable = samlAvailable || oidcAvailable;

  const passwordAvailable = authMode === "password" || authMode === "both" || !ssoAvailable;

  // Show loading state while checking password
  if (hasPassword === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg bg-app-gradient p-4">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          <p className="text-text-muted mt-4">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-4 relative overflow-hidden isolate">
      {/* Backdrop: static Iso Cube Field (replaces the old square grid). */}
      <IsoCubeBackground variant="contained" baseClassName="bg-bg bg-app-gradient" />
      <div className="relative z-10 w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gradient-brand mb-2">Srouter</h1>
          <p className="text-text-muted">
            {samlAvailable
              ? "Sign in with SAML 2.0 Single Sign-On"
              : oidcAvailable
              ? "Sign in with your OIDC provider to access the dashboard"
              : "Enter your password to access the dashboard"}
          </p>
        </div>

        <Card>
          {mustChange ? (
            <form onSubmit={handleSetNewPassword} className="flex flex-col gap-4">
              <p className="text-sm text-amber-600 dark:text-amber-400 text-center">
                Set a new password before accessing the dashboard remotely.
              </p>
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">New password</label>
                <Input
                  type="password"
                  placeholder="Enter new password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  autoFocus
                />
                {error && <p className="text-xs text-red-500">{error}</p>}
              </div>
              <Button type="submit" variant="primary" className="w-full" loading={loading} disabled={!newPassword}>
                Set password
              </Button>
            </form>
          ) : (
          <div className="flex flex-col gap-4">
            {samlAvailable && (
              <Button type="button" variant="primary" className="w-full" onClick={handleSamlLogin}>
                {samlLoginLabel}
              </Button>
            )}

            {oidcAvailable && (
              <Button type="button" variant="primary" className="w-full" onClick={handleOidcLogin}>
                {oidcLoginLabel}
              </Button>
            )}

            {ssoAvailable && passwordAvailable && <div className="h-px bg-border/60" />}

            {passwordAvailable ? (
              <form onSubmit={handleLogin} className="flex flex-col gap-4">
                {isSsoEnabled && !ssoAvailable && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 text-center">
                    {activeSsoType === "saml" ? "SAML SSO" : "OIDC"} login is enabled, but configuration is incomplete. Password login is still available for recovery.
                  </p>
                )}

                {authMode === "both" && ssoAvailable && (
                  <p className="text-xs text-text-muted text-center">
                    Password and {activeSsoType === "saml" ? "SAML SSO" : "OIDC"} login are both enabled.
                  </p>
                )}

                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium">Password</label>
                  <Input
                    type="password"
                    placeholder="Enter password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoFocus={!oidcAvailable}
                  />
                  {error && <p className="text-xs text-red-500">{error}</p>}
                  {retryAfter > 0 && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      Locked. Retry in <span className="font-mono">{retryAfter}s</span>.
                    </p>
                  )}
                  {resetHint && (
                    <p className="text-xs text-text-muted">
                      Forgot password? Open <code className="bg-sidebar px-1 rounded">srouter</code> CLI on the host → <b>Settings</b> → <b>Reset Password to Default</b>.
                    </p>
                  )}
                </div>

                <Button
                  type="submit"
                  variant="primary"
                  className="w-full"
                  loading={loading}
                  disabled={retryAfter > 0}
                >
                  {retryAfter > 0 ? `Wait ${retryAfter}s` : "Login"}
                </Button>

                <p className="text-xs text-center text-text-muted mt-2">
                  Default password is <code className="bg-sidebar px-1 rounded">123456</code>
                </p>
                {hasPassword === false && localRequest && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 flex flex-col gap-2">
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      No password set. The dashboard is protected only by the public default password,
                      and sign-in from other devices stays blocked until you set your own.
                    </p>
                    {firstRunMode === "password" ? (
                      <form onSubmit={handleFirstRunPassword} className="flex flex-col gap-2">
                        <Input
                          type="password"
                          placeholder="New password"
                          value={firstRunPassword}
                          onChange={(e) => setFirstRunPassword(e.target.value)}
                          required
                          autoFocus
                        />
                        <Input
                          type="password"
                          placeholder="Confirm new password"
                          value={firstRunConfirm}
                          onChange={(e) => setFirstRunConfirm(e.target.value)}
                          required
                        />
                        <div className="flex gap-2">
                          <Button type="submit" variant="primary" size="sm" loading={firstRunLoading}>
                            Save password
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => { setFirstRunMode("none"); setFirstRunError(""); }}
                          >
                            Cancel
                          </Button>
                        </div>
                      </form>
                    ) : (
                      <div className="flex flex-col sm:flex-row gap-2">
                        <Button type="button" variant="primary" size="sm" onClick={() => setFirstRunMode("password")}>
                          Set a password
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          loading={firstRunLoading}
                          onClick={handleFirstRunNoLogin}
                        >
                          Remove login on this computer
                        </Button>
                      </div>
                    )}
                    {firstRunError && <p className="text-xs text-red-500">{firstRunError}</p>}
                  </div>
                )}
                {hasPassword === false && !localRequest && (
                  <p className="text-xs text-center text-amber-600 dark:text-amber-400">
                    Security risk: no password set. You will be asked to set one when logging in remotely.
                  </p>
                )}
              </form>
            ) : (
              error && <p className="text-xs text-red-500">{error}</p>
            )}
          </div>
          )}
        </Card>
      </div>
    </div>
  );
}
