"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createNavigationShortcuts } from "@/shared/utils/navigationShortcuts";
import { cn } from "@/shared/utils/cn";
import { APP_CONFIG, UPDATER_CONFIG, UPSTREAM_LINES, UPSTREAM_LINES_NOTE } from "@/shared/constants/config";
import { MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
import { getCapabilityListingHref, isCapabilityPathActive } from "@/shared/utils/capabilityRoutes";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import useSettingsStore from "@/store/settingsStore";
import Button from "./Button";
import { ConfirmModal } from "./Modal";
import { NineRemotePromoModal } from "./onDemandModals";
import SrouterMark from "./SrouterMark";
import UpstreamLines from "./UpstreamLines";
import styles from "./Sidebar.module.css";

// const VISIBLE_MEDIA_KINDS = ["embedding", "image", "imageToText", "tts", "stt", "webSearch", "webFetch", "video", "music"];
const VISIBLE_MEDIA_KINDS = ["embedding", "image", "video", "tts", "stt", "systemone"];
// Independent System entry for the shared webSearch + webFetch page.
const COMBINED_WEB_ITEM = { id: "web", label: "Web Search", icon: "travel_explore", href: "/dashboard/search", shortcut: "e" };

const navItems = [
  { href: "/dashboard/endpoint", label: "Endpoint & Key", icon: "api", shortcut: "1" },
  { href: "/dashboard/providers", label: "Providers", icon: "dns", shortcut: "2" },
  // { href: "/dashboard/basic-chat", label: "Basic Chat", icon: "chat" }, // Hidden
  { href: "/dashboard/combos", label: "Combo & Fallback", icon: "layers", shortcut: "3" },
  { href: "/dashboard/usage", label: "Usage", icon: "bar_chart", shortcut: "4" },
  { href: "/dashboard/quota", label: "Quota Tracker", icon: "data_usage", shortcut: "5" },
  { href: "/dashboard/plugins", label: "Plugins & Customization", icon: "savings", shortcut: "q" },
  // { href: "/dashboard/pxpipe", label: "PXPIPE", icon: "image" },
  { href: "/dashboard/harness", label: "Harness Apps", icon: "terminal", shortcut: "w" },
];

const debugItems = [
  { href: "/dashboard/console-log", label: "Console Log", icon: "terminal", shortcut: "3+4" },
  { href: "/dashboard/translator", label: "Translator", icon: "translate" },
];

const networkItems = [
  { href: "/dashboard/proxy-pools", label: "Proxy Pools", icon: "lan" },
  { href: "/dashboard/proxy-fitness", label: "Proxy Fitness", icon: "network_check" },
  { href: "/dashboard/vpn", label: "VPN", icon: "vpn_lock" },
];

function SidebarLabel({ children, className = "" }) {
  return (
    <span className={`${styles.label} ${className}`}>
      {children}
    </span>
  );
}

SidebarLabel.propTypes = {
  children: PropTypes.string.isRequired,
  className: PropTypes.string,
};

export default function Sidebar({ onClose }) {
  const pathname = usePathname();
  const router = useRouter();
  const [mediaOpen, setMediaOpen] = useState(null);
  const mediaActive = VISIBLE_MEDIA_KINDS.some((kind) => isCapabilityPathActive(pathname, kind));
  const mediaExpanded = mediaOpen ?? mediaActive;
  const [networkOpen, setNetworkOpen] = useState(null);
  const networkActive = networkItems.some((item) => pathname.startsWith(item.href));
  const networkExpanded = networkOpen ?? networkActive;
  const [showRemoteModal, setShowRemoteModal] = useState(false);
  const [isDisconnected, setIsDisconnected] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [shutdownCountdown, setShutdownCountdown] = useState(0);
  const [enableTranslator, setEnableTranslator] = useState(false);
  const { copied, copy } = useCopyToClipboard(2000);

  const INSTALL_CMD = UPDATER_CONFIG.installCmdLatest;

  useEffect(() => {
    const shortcuts = createNavigationShortcuts((action) => {
      if (action === "media") setMediaOpen((value) => !(value ?? mediaActive));
      else if (action === "network") setNetworkOpen((value) => !(value ?? networkActive));
      else { router.push(action); onClose?.(); }
    }, () => Boolean(onClose) === window.matchMedia("(min-width: 1024px)").matches ||
      document.body.style.overflow === "hidden" ||
      !!document.querySelector('[role="dialog"], [aria-modal="true"], dialog[open], [popover]:popover-open'));
    window.addEventListener("keydown", shortcuts.keydown);
    window.addEventListener("keyup", shortcuts.keyup);
    window.addEventListener("blur", shortcuts.reset);
    return () => {
      window.removeEventListener("keydown", shortcuts.keydown);
      window.removeEventListener("keyup", shortcuts.keyup);
      window.removeEventListener("blur", shortcuts.reset);
    };
  }, [router, onClose, networkActive, mediaActive]);

  useEffect(() => {
    useSettingsStore.getState().fetchSettings().then((data) => {
      if (data?.enableTranslator) setEnableTranslator(true);
    });
  }, []);

  // Lazy check for new npm version in background after initial render
  useEffect(() => {
    const timer = setTimeout(() => {
      fetch("/api/version")
        .then(res => res.json())
        .then(data => { if (data.hasUpdate) setUpdateInfo(data); })
        .catch(() => {});
    }, 2500);
    return () => clearTimeout(timer);
  }, []);

  const isActive = (href) => {
    if (href === "/dashboard/endpoint") {
      return pathname === "/dashboard" || pathname.startsWith("/dashboard/endpoint");
    }
    return pathname.startsWith(href);
  };

  // Open manual update panel (no countdown yet — user must click Copy to trigger shutdown)
  const handleUpdate = () => {
    setShowUpdateModal(false);
    setIsUpdating(true);
  };

  // Triggered by Copy button inside ManualUpdatePanel: copy + countdown + shutdown
  const handleCopyAndShutdown = async () => {
    try { await navigator.clipboard.writeText(INSTALL_CMD); } catch { /* clipboard blocked */ }
    copy(INSTALL_CMD);
    let remaining = UPDATER_CONFIG.shutdownCountdownSec;
    setShutdownCountdown(remaining);
    const timer = setInterval(() => {
      remaining -= 1;
      setShutdownCountdown(remaining);
      if (remaining <= 0) {
        clearInterval(timer);
        fetch("/api/version/shutdown", { method: "POST" }).catch(() => {});
        setIsDisconnected(true);
      }
    }, 1000);
  };

  const handleCancelUpdate = () => {
    setIsUpdating(false);
    setShutdownCountdown(0);
  };

  // Note: legacy updater poll removed. New flow: copy install cmd + shutdown server,
  // user runs the command manually in another terminal.


  return (
    <>
      <aside className="flex w-72 flex-col border-r border-border-subtle bg-vibrancy backdrop-blur-xl transition-colors duration-300 min-h-full">
        {/* Logo */}
        <div className="px-6 pt-5 pb-4 flex flex-col gap-2">
          <Link href="/dashboard" className="flex items-center gap-3">
            <SrouterMark size={36} className="shrink-0 rounded-[10px] shadow-[var(--shadow-warm)]" />
            <div className="flex flex-col">
              <h1 className="text-lg font-semibold tracking-tight text-text-main">
                {APP_CONFIG.name}
              </h1>
              <span className="text-xs text-text-muted">v{APP_CONFIG.version}</span>
            </div>
          </Link>
          <div className="pl-12">
            <UpstreamLines />
          </div>
          {updateInfo && (
            <div className="flex flex-col gap-1.5 rounded p-1 -m-1">
              <span className="text-xs font-semibold text-green-600 dark:text-amber-500">
                ↑ New version available: v{updateInfo.latestVersion}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowUpdateModal(true)}
                  className="px-2 py-1 rounded bg-green-600 hover:bg-green-700 dark:bg-amber-500 dark:hover:bg-amber-600 text-white text-[11px] font-semibold transition-colors cursor-pointer"
                >
                  Update now
                </button>
                <button
                  onClick={() => copy(INSTALL_CMD)}
                  title="Copy install command"
                  className="flex-1 text-left hover:opacity-80 transition-opacity cursor-pointer min-w-0"
                >
                  <code className="block text-[10px] text-green-600/80 dark:text-amber-400/70 font-mono truncate">
                    {copied ? "✓ copied!" : INSTALL_CMD}
                  </code>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Navigation */}
        <nav
          className={`${styles.navigation} flex-1 px-4 py-2 space-y-0.5 overflow-y-auto custom-scrollbar`}
        >
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={onClose}
              className={cn(
                "flex items-center gap-3 px-3 py-1 rounded-lg transition-all group",
                isActive(item.href)
                  ? "bg-primary/10 text-primary"
                  : "text-text-muted hover:bg-surface-2 hover:text-text-main"
              )}
            >
              <span
                className={cn(
                  "material-symbols-outlined text-[18px]",
                  isActive(item.href) ? "fill-1" : "group-hover:text-primary transition-colors"
                )}
              >
                {item.icon}
              </span>
              <SidebarLabel className="text-[13px] font-medium">{item.label}</SidebarLabel>
              <kbd className="ml-auto text-[10px] font-normal text-text-muted/40">{item.shortcut}</kbd>
            </Link>
          ))}

          {/* System section */}
          <div className="pt-3 mt-2 space-y-0.5">
            <p className="px-4 text-xs font-semibold text-text-muted/60 uppercase tracking-wider mb-2">
              System
            </p>

            <Link
              href={COMBINED_WEB_ITEM.href}
              onClick={onClose}
              className={cn(
                "flex items-center gap-3 px-3 py-1 rounded-lg transition-all group",
                isActive(COMBINED_WEB_ITEM.href)
                  ? "bg-primary/10 text-primary"
                  : "text-text-muted hover:bg-surface-2 hover:text-text-main"
              )}
            >
              <span
                className={cn(
                  "material-symbols-outlined text-[18px]",
                  isActive(COMBINED_WEB_ITEM.href) ? "fill-1" : "group-hover:text-primary transition-colors"
                )}
              >
                {COMBINED_WEB_ITEM.icon}
              </span>
              <SidebarLabel className="text-[13px] font-medium">{COMBINED_WEB_ITEM.label}</SidebarLabel>
              <span className="rounded border border-border-subtle px-1 text-[9px] font-medium text-text-muted/60" title="Work in progress">WIP</span>
              <kbd className="ml-auto text-[10px] font-normal text-text-muted/40">{COMBINED_WEB_ITEM.shortcut}</kbd>
            </Link>

            {/* Media Providers accordion */}
            <button
              type="button"
              onClick={() => setMediaOpen(!mediaExpanded)}
              aria-expanded={mediaExpanded}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-1 rounded-lg transition-all group",
                mediaActive
                  ? "bg-primary/10 text-primary"
                  : "text-text-muted hover:bg-surface-2 hover:text-text-main"
              )}
            >
              <span className="material-symbols-outlined text-[18px]">perm_media</span>
              <SidebarLabel className="text-[13px] font-medium flex-1 text-left">Media Providers</SidebarLabel>
              <kbd className="text-[10px] font-normal text-text-muted/40">1+2</kbd>
              {MEDIA_PROVIDER_KINDS.some((k) => VISIBLE_MEDIA_KINDS.includes(k.id) && k.isNew) && (
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-[3px] bg-green-500/15 text-green-400">NEW</span>
              )}
              <span className="material-symbols-outlined text-[14px] transition-transform" style={{ transform: mediaExpanded ? "rotate(180deg)" : "rotate(0deg)" }}>
                expand_more
              </span>
            </button>
            {mediaExpanded && (
              <div className="pl-4">
                {MEDIA_PROVIDER_KINDS.filter((k) => VISIBLE_MEDIA_KINDS.includes(k.id)).map((kind) => (
                  <Link
                    key={kind.id}
                    href={getCapabilityListingHref(kind.id)}
                    onClick={onClose}
                    className={cn(
                      "flex items-center gap-3 px-4 py-1 rounded-lg transition-all group",
                      isCapabilityPathActive(pathname, kind.id)
                        ? "bg-primary/10 text-primary"
                        : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                    )}
                  >
                    <span className="material-symbols-outlined text-[16px]">{kind.icon}</span>
                    <SidebarLabel className="text-sm">{kind.label}</SidebarLabel>
                    {kind.isNew && (
                      <span className="ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded-[3px] bg-green-500/15 text-green-400">NEW</span>
                    )}
                  </Link>
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={() => setNetworkOpen(!networkExpanded)}
              aria-expanded={networkExpanded}
              className={cn("flex w-full items-center gap-3 rounded-lg px-3 py-1", networkActive ? "text-primary" : "text-text-muted hover:bg-surface-2 hover:text-text-main")}
            >
              <span className="material-symbols-outlined text-[18px]">lan</span>
              <SidebarLabel className="flex-1 text-left text-[13px] font-medium">Network</SidebarLabel>
              <kbd className="text-[10px] font-normal text-text-muted/40">2+3</kbd>
              <span className="material-symbols-outlined text-[14px]">{networkExpanded ? "expand_less" : "expand_more"}</span>
            </button>
            {networkExpanded && (
              <div className="pl-4">
                {networkItems.map((item) => (
                  <Link key={item.href} href={item.href} onClick={onClose}
                    className={cn("flex items-center gap-3 rounded-lg px-3 py-1 text-sm", isActive(item.href) ? "bg-primary/10 text-primary" : "text-text-muted hover:bg-surface-2 hover:text-text-main")}>
                    <span className="material-symbols-outlined text-[16px]">{item.icon}</span>
                    <SidebarLabel>{item.label}</SidebarLabel>
                    {item.href === "/dashboard/vpn" && <span className="ml-auto rounded border border-border-subtle px-1 text-[9px] font-medium text-text-muted/60" title="Work in progress">WIP</span>}
                  </Link>
                ))}
              </div>
            )}

            {/* Debug items (inside System section, before Settings) */}
            {debugItems.map((item) => {
              const show = item.href !== "/dashboard/translator" || enableTranslator;
              return show ? (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onClose}
                  className={cn(
                    "flex items-center gap-3 px-3 py-1 rounded-lg transition-all group",
                    isActive(item.href)
                      ? "bg-primary/10 text-primary"
                      : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                  )}
                >
                  <span
                    className={cn(
                      "material-symbols-outlined text-[18px]",
                      isActive(item.href) ? "fill-1" : "group-hover:text-primary transition-colors"
                    )}
                  >
                    {item.icon}
                  </span>
                  <SidebarLabel className="text-[13px] font-medium">{item.label}</SidebarLabel>
                  {item.shortcut && <kbd className="ml-auto text-[10px] font-normal text-text-muted/40">{item.shortcut}</kbd>}
                </Link>
              ) : null;
            })}

            {/* 9English removed from this fork — it linked to the upstream
                product's English course site, not to anything Srouter does. */}

            {/* Settings */}
            <Link
              href="/dashboard/profile"
              onClick={onClose}
              className={cn(
                "flex items-center gap-3 px-3 py-1 rounded-lg transition-all group",
                isActive("/dashboard/profile")
                  ? "bg-primary/10 text-primary"
                  : "text-text-muted hover:bg-surface-2 hover:text-text-main"
              )}
            >
              <span
                className={cn(
                  "material-symbols-outlined text-[18px]",
                  isActive("/dashboard/profile") ? "fill-1" : "group-hover:text-primary transition-colors"
                )}
              >
                settings
              </span>
              <SidebarLabel className="text-[13px] font-medium">Settings</SidebarLabel>
              <kbd className="ml-auto text-[10px] font-normal text-text-muted/40">4+5</kbd>
            </Link>
          </div>
          <div className="pt-3 mt-2 space-y-0.5">
            <p className="px-4 text-xs font-semibold text-text-muted/60 uppercase tracking-wider mb-2">Extra</p>
            <Link href="/dashboard/skills" onClick={onClose}
              className={cn("flex items-center gap-3 px-3 py-1 rounded-lg", isActive("/dashboard/skills") ? "bg-primary/10 text-primary" : "text-text-muted hover:bg-surface-2 hover:text-text-main")}>
              <span className="material-symbols-outlined text-[18px]">extension</span>
              <SidebarLabel className="text-[13px] font-medium">Skills</SidebarLabel>
            </Link>
            <button onClick={() => setShowRemoteModal(true)}
              className="flex w-full items-center gap-3 px-3 py-1 rounded-lg text-text-muted hover:bg-surface-2 hover:text-text-main">
              <span className="material-symbols-outlined text-[18px]">computer</span>
              <SidebarLabel className="text-[13px] font-medium">9Remote</SidebarLabel>
            </button>
            {/* Import accounts from the sibling installation (no keyboard chord) */}
            <Link
              href="/dashboard/import"
              onClick={onClose}
              className={cn(
                "flex items-center gap-3 px-3 py-1 rounded-lg transition-all group",
                isActive("/dashboard/import")
                  ? "bg-primary/10 text-primary"
                  : "text-text-muted hover:bg-surface-2 hover:text-text-main"
              )}
            >
              <span
                className={cn(
                  "material-symbols-outlined text-[18px]",
                  isActive("/dashboard/import") ? "fill-1" : "group-hover:text-primary transition-colors"
                )}
              >
                download
              </span>
              <SidebarLabel className="text-[13px] font-medium">Import</SidebarLabel>
            </Link>
          </div>
        </nav>

      </aside>

      {/* Remote Promo Modal */}
      <NineRemotePromoModal isOpen={showRemoteModal} onClose={() => setShowRemoteModal(false)} />

      {/* Update Confirmation Modal */}
      <ConfirmModal
        isOpen={showUpdateModal}
        onClose={() => setShowUpdateModal(false)}
        onConfirm={handleUpdate}
        title="Update Srouter"
        message={`Show install command for v${updateInfo?.latestVersion || ""}? You can copy it and shutdown to install manually.`}
        confirmText="Show Command"
        cancelText="Cancel"
        variant="primary"
      />

      {/* Disconnected / Updating Overlay */}
      {(isDisconnected || isUpdating) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-6">
          {isUpdating ? (
            <ManualUpdatePanel
              latestVersion={updateInfo?.latestVersion}
              installCmd={INSTALL_CMD}
              copied={copied}
              onCopyAndShutdown={handleCopyAndShutdown}
              onCancel={handleCancelUpdate}
              countdown={shutdownCountdown}
              isDisconnected={isDisconnected}
            />
          ) : (
            <div className="text-center p-8">
              <div className="flex items-center justify-center size-16 rounded-full bg-red-500/20 text-red-500 mx-auto mb-4">
                <span className="material-symbols-outlined text-[32px]">power_off</span>
              </div>
              <h2 className="text-xl font-semibold text-white mb-2">Server Disconnected</h2>
              <p className="text-text-muted mb-6">The proxy server has been stopped.</p>
              <Button variant="secondary" onClick={() => globalThis.location.reload()}>
                Reload Page
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

Sidebar.propTypes = {
  onClose: PropTypes.func,
};

function ManualUpdatePanel({ latestVersion, installCmd, copied, onCopyAndShutdown, onCancel, countdown, isDisconnected }) {
  const isCountingDown = countdown > 0;
  return (
    <div className="w-full max-w-lg rounded-xl bg-neutral-900/95 border border-white/10 p-6 text-white">
      <div className="flex items-center gap-3 mb-4">
        <div className="flex items-center justify-center size-11 rounded-full bg-amber-500/20 text-amber-400">
          <span className="material-symbols-outlined text-[24px]">content_copy</span>
        </div>
        <div>
          <h2 className="text-lg font-semibold">Update Srouter{latestVersion ? ` to v${latestVersion}` : ""}</h2>
          <p className="text-xs text-white/60">
            {isDisconnected
              ? "Server stopped. Paste the command into a terminal to install."
              : isCountingDown
                ? `Command copied. Server will stop in ${countdown}s...`
                : "Click the button below to copy the install command and shutdown."}
          </p>
        </div>
      </div>

      <p className="text-sm text-white/80 mb-2">Install command:</p>
      <div className="w-full px-3 py-2 rounded bg-white/5 mb-4">
        <code className="text-xs font-mono text-amber-400 break-all">{installCmd}</code>
      </div>

      <ol className="text-xs text-white/70 space-y-1 list-decimal list-inside mb-4">
        <li>Click <strong>Copy & Shutdown</strong> below.</li>
        <li>Paste the command into your terminal and press Enter.</li>
        <li>Run <code className="px-1 rounded bg-white/10 text-green-400">srouter</code> again after install.</li>
      </ol>

      {isDisconnected ? (
        <Button variant="secondary" fullWidth onClick={() => globalThis.location.reload()}>
          Reload Page
        </Button>
      ) : (
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={isCountingDown}>
            Cancel
          </Button>
          <Button variant="primary" fullWidth onClick={onCopyAndShutdown} disabled={isCountingDown}>
            {copied ? "✓ Copied — shutting down..." : isCountingDown ? `Shutting down in ${countdown}s` : "Copy & Shutdown"}
          </Button>
        </div>
      )}
    </div>
  );
}

ManualUpdatePanel.propTypes = {
  latestVersion: PropTypes.string,
  installCmd: PropTypes.string.isRequired,
  copied: PropTypes.bool,
  onCopyAndShutdown: PropTypes.func.isRequired,
  onCancel: PropTypes.func.isRequired,
  countdown: PropTypes.number,
  isDisconnected: PropTypes.bool,
};
