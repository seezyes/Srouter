"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import PropTypes from "prop-types";
import ProviderIcon from "@/shared/components/ProviderIcon";
import HeaderMenu from "@/shared/components/HeaderMenu";
import HeaderLanguage from "@/shared/components/HeaderLanguage";
import ThemeToggle from "@/shared/components/ThemeToggle";
import StreamerModeToggle from "@/shared/components/StreamerMode";
import { DonateModal } from "./onDemandModals";
import { useHeaderSearchStore } from "@/store/headerSearchStore";
import { OAUTH_PROVIDERS, APIKEY_PROVIDERS } from "@/shared/constants/config";
import { getCapabilityPageInfo } from "@/shared/utils/capabilityRoutes";
import { getProviderIconSrc } from "@/shared/utils/providerIcon";
import { translate } from "@/i18n/runtime";
import styles from "./Header.module.css";

const getPageInfo = (pathname) => {
  if (!pathname) return { title: "", description: "", breadcrumbs: [] };

  const capabilityPageInfo = getCapabilityPageInfo(pathname);
  if (capabilityPageInfo) return capabilityPageInfo;

  // Provider detail page: /dashboard/providers/[id]
  const providerMatch = pathname.match(/\/providers\/([^/]+)$/);
  if (providerMatch) {
    const providerId = providerMatch[1];
    const providerInfo =
      OAUTH_PROVIDERS[providerId] || APIKEY_PROVIDERS[providerId];
    if (providerInfo) {
      return {
        title: providerInfo.name,
        description: "",
        breadcrumbs: [
          { label: "Providers", href: "/dashboard/providers" },
          {
            label: providerInfo.name,
            image: getProviderIconSrc(providerInfo.id),
          },
        ],
      };
    }
  }

  if (pathname.includes("/providers") && !pathname.includes("/media-providers"))
    return {
      title: "Providers",
      description: "Manage your AI provider connections",
      icon: "dns",
      breadcrumbs: [],
    };
  if (pathname.includes("/combos"))
    return {
      title: "Combo & Fallback",
      description: "Model combos, Vision Advisor and capability fallbacks",
      icon: "layers",
      breadcrumbs: [],
    };
  if (pathname.includes("/usage"))
    return {
      title: "Usage & Analytics",
      description:
        "Monitor your API usage, token consumption, and request logs",
      icon: "bar_chart",
      breadcrumbs: [],
    };
  if (pathname.includes("/auth-files"))
    return {
      title: "Auth Files",
      description: "Map provider credentials stored in the local database",
      icon: "vpn_key",
      breadcrumbs: [],
    };
  if (pathname.includes("/quota"))
    return {
      title: "Quota Tracker",
      description: "Track and manage your API quota limits",
      icon: "data_usage",
      breadcrumbs: [],
    };
  if (pathname.includes("/mitm"))
    return {
      title: "MITM Proxy",
      description: "Intercept CLI tool traffic and route through Srouter",
      icon: "security",
      breadcrumbs: [],
    };
  if (pathname.includes("/plugins") || pathname.includes("/token-saver"))
    return {
      title: "Plugins & Customization",
      description: "Configure plugins and custom system prompts",
      icon: "savings",
      breadcrumbs: [],
    };
  if (pathname.includes("/harness") || pathname.includes("/cli-tools"))
    return {
      title: "Harness Apps",
      description: "Configure coding agents and harness apps",
      icon: "terminal",
      breadcrumbs: [],
    };
  if (pathname.includes("/proxy-pools"))
    return {
      title: "Proxy Pools",
      description: "Manage your proxy pool configurations",
      icon: "lan",
      breadcrumbs: [],
    };
  if (pathname.includes("/proxy-fitness"))
    return { title: "Proxy Fitness", description: "Network · Proxy diagnostics", icon: "network_check", breadcrumbs: [] };
  if (pathname.includes("/vpn"))
    return { title: "VPN", description: "Network · Local VPN client proxy (preview)", icon: "vpn_lock", breadcrumbs: [] };
  if (pathname.includes("/skills"))
    return {
      title: "Agent Skills",
      description: "Copy a link and paste to your AI to use Srouter — no install needed",
      icon: "extension",
      breadcrumbs: [],
    };
  if (pathname.includes("/endpoint"))
    return {
      title: "Endpoint",
      description: "API endpoint configuration",
      icon: "api",
      breadcrumbs: [],
    };
  if (pathname.includes("/profile"))
    return {
      title: "Settings",
      description: "Manage your preferences",
      icon: "settings",
      breadcrumbs: [],
    };
  if (pathname.includes("/translator"))
    return {
      title: "Translator",
      description: "Debug translation flow between formats",
      icon: "translate",
      breadcrumbs: [],
    };
  if (pathname.includes("/console-log"))
    return {
      title: "Console Log",
      description: "Live server console output",
      icon: "monitor",
      breadcrumbs: [],
    };
  if (pathname === "/dashboard")
    return {
      title: "Endpoint",
      description: "API endpoint configuration",
      icon: "api",
      breadcrumbs: [],
    };
  return { title: "", description: "", breadcrumbs: [] };
};

export default function Header({ onMenuClick, showMenuButton = true }) {
  const pathname = usePathname();
  const [displayName, setDisplayName] = useState("");
  const [loginMethod, setLoginMethod] = useState("");
  const [donateOpen, setDonateOpen] = useState(false);
  const searchVisible = useHeaderSearchStore((s) => s.visible);
  const centeredSearch = pathname === "/dashboard/providers" && searchVisible;

  // Memoize page info to prevent unnecessary recalculations
  const pageInfo = useMemo(() => getPageInfo(pathname), [pathname]);
  const { title, description, icon, breadcrumbs } = pageInfo;

  useEffect(() => {
    let cancelled = false;

    async function loadAuthStatus() {
      try {
        const res = await fetch("/api/auth/status", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setDisplayName(data?.displayName || data?.samlName || data?.samlEmail || data?.oidcName || data?.oidcEmail || "");
          setLoginMethod(data?.loginMethod || "");
        }
      } catch {
        if (!cancelled) {
          setDisplayName("");
          setLoginMethod("");
        }
      }
    }

    loadAuthStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogout = async () => {
    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      if (res.ok) {
        window.location.assign("/login");
      }
    } catch (err) {
      console.error("Failed to logout:", err);
    }
  };

  return (
    <header className={`shrink-0 flex items-center justify-between gap-3 px-4 lg:px-8 pt-3 pb-2 border-b border-border-subtle bg-surface/60 backdrop-blur-xl lg:bg-transparent lg:backdrop-blur-none z-20 ${centeredSearch ? styles.withSearch : ""}`}>
      <div className="flex items-center gap-3 min-w-0 flex-1">
      {/* Mobile menu button */}
      <div className="flex items-center gap-3 lg:hidden shrink-0">
        {showMenuButton && (
          <button
            onClick={onMenuClick}
            className="text-text-main hover:text-primary transition-colors"
          >
            <span className="material-symbols-outlined">menu</span>
          </button>
        )}
      </div>

      {/* Page title with breadcrumbs */}
      <div className="flex flex-col min-w-0 flex-1">
        {breadcrumbs.length > 0 ? (
          <div className="flex items-center gap-2">
            {breadcrumbs.map((crumb, index) => (
              <div
                key={`${crumb.label}-${crumb.href || "current"}`}
                className="flex items-center gap-2"
              >
                {index > 0 && (
                  <span className="material-symbols-outlined text-text-muted text-base">
                    chevron_right
                  </span>
                )}
                {crumb.href ? (
                  <Link
                    href={crumb.href}
                    className="text-text-muted hover:text-primary transition-colors"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <div className="flex items-center gap-2">
                    {crumb.image && (
                      <ProviderIcon
                        src={crumb.image}
                        alt={crumb.label}
                        size={28}
                        className="object-contain rounded max-w-[28px] max-h-[28px]"
                        fallbackText={crumb.label.slice(0, 2).toUpperCase()}
                      />
                    )}
                    <h1 className="text-base lg:text-2xl font-semibold text-text-main tracking-tight truncate">
                      {translate(crumb.label)}
                    </h1>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : title ? (
          <div>
            <div className="flex items-center gap-2">
              {icon && (
                <span className="material-symbols-outlined text-primary text-xl lg:text-2xl">
                  {icon}
                </span>
              )}
              <h1 className="text-base lg:text-2xl font-semibold tracking-tight truncate">
                {translate(title)}
              </h1>
            </div>
            {description && (
              <p className="hidden lg:block text-sm text-text-muted truncate">
                {translate(description)}
              </p>
            )}
          </div>
        ) : null}
      </div>
      </div>

      {centeredSearch && (
        <div className={styles.searchSlot}>
          <HeaderSearch accented />
          <HeaderSearchFilter />
        </div>
      )}

      {/* Right actions */}
      <div className="flex items-center justify-end gap-1 shrink-0">
        {displayName && (loginMethod === "OIDC" || loginMethod === "SAML") && (
          <div
            className={`${centeredSearch ? "hidden 2xl:flex max-w-[140px]" : "hidden sm:flex max-w-[220px]"} items-center px-3 py-1.5 rounded-full border border-border bg-surface/70 text-xs text-text-muted truncate`}
            title={displayName}
            data-streamer-private-attributes
          >
            <span className="material-symbols-outlined text-[14px] mr-1.5 text-primary">person</span>
            <span data-streamer-sensitive className="truncate">{displayName}</span>
            <span className="ml-2 shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
              {loginMethod}
            </span>
          </div>
        )}
        {!centeredSearch && <HeaderSearch />}
        <button
          onClick={() => setDonateOpen(true)}
          className="flex items-center gap-1.5 px-3 h-8 rounded-lg border border-pink-500/30 bg-pink-500/10 text-pink-600 dark:text-pink-400 hover:bg-pink-500/20 transition-colors text-sm font-medium"
          aria-label="Donate"
        >
          <span className="material-symbols-outlined text-[18px]">volunteer_activism</span>
          <span className="hidden sm:inline">Donate</span>
        </button>
        <StreamerModeToggle />
        <ThemeToggle />
        <HeaderLanguage />
        <HeaderMenu onLogout={handleLogout} />
      </div>
      <DonateModal isOpen={donateOpen} onClose={() => setDonateOpen(false)} />
    </header>
  );
}

function HeaderSearchFilter() {
  const options = useHeaderSearchStore((s) => s.filterOptions);
  const value = useHeaderSearchStore((s) => s.filterValue);
  const setValue = useHeaderSearchStore((s) => s.setFilterValue);

  if (!options.length) return null;

  return (
    <select
      value={value}
      onChange={(e) => setValue(e.target.value)}
      className="h-9 max-w-[10rem] shrink-0 rounded-lg border border-black/10 bg-black/[0.02] px-2 text-xs text-text-primary outline-none transition-colors hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-primary dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
      aria-label="Filter providers by connection status"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function HeaderSearch({ accented = false }) {
  const visible = useHeaderSearchStore((s) => s.visible);
  const query = useHeaderSearchStore((s) => s.query);
  const placeholder = useHeaderSearchStore((s) => s.placeholder);
  const setQuery = useHeaderSearchStore((s) => s.setQuery);

  if (!visible) return null;

  return (
    <div className={accented ? styles.searchBorder : styles.searchPlain}>
      <div className={styles.searchInner}>
        <span
          className={`material-symbols-outlined ${styles.searchIcon} ${styles.searchLeadingIcon}`}
          aria-hidden="true"
        >
          search
        </span>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder || "Search"}
          className={styles.searchInput}
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            className={styles.searchClear}
            aria-label="Clear search"
          >
            <span className={`material-symbols-outlined ${styles.searchIcon}`} aria-hidden="true">
              close
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

HeaderSearch.propTypes = {
  accented: PropTypes.bool,
};

Header.propTypes = {
  onMenuClick: PropTypes.func,
  showMenuButton: PropTypes.bool,
};
