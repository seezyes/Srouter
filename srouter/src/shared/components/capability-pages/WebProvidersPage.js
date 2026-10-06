"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Card, Badge, AddCustomSearchProviderModal } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getWebProviders, getWebProviderToolOptions, getWebProviderConnectionOptions, groupWebProviders } from "@/shared/utils/webProviderCards";
import { getWebProviderIconSrc, getWebGroupIconSrc } from "@/shared/utils/webProviderIcons";
import ProviderCardGroup from "@/app/(dashboard)/dashboard/providers/components/ProviderCardGroup";
import { getCapabilityProviderHref } from "@/shared/utils/capabilityRoutes";

import { getEffectiveConnectionStatus } from "@/shared/utils/connectionStatus";

function getEffectiveStatus(conn) {
  const isCooldown = Object.entries(conn).some(
    ([k, v]) => k.startsWith("modelLock_") && v && new Date(v).getTime() > Date.now()
  );
  // Shared with the Providers grid: a model-scoped failure must not count as a
  // broken account while the other models of that account still answer.
  return getEffectiveConnectionStatus(conn, isCooldown);
}

function ProviderCard({ provider, connections }) {
  const kind = provider.kinds[0];
  const providerInfo = AI_PROVIDERS[provider.id];
  const isNoAuth = !!providerInfo?.noAuth;
  const providerConns = connections.filter((c) => c.provider === provider.id);
  const connected = providerConns.filter((c) => { const s = getEffectiveStatus(c); return s === "active" || s === "success"; }).length;
  const error = providerConns.filter((c) => { const s = getEffectiveStatus(c); return s === "error" || s === "expired" || s === "unavailable"; }).length;
  const total = providerConns.length;
  const allDisabled = total > 0 && providerConns.every((c) => c.isActive === false);
  const tools = getWebProviderToolOptions(provider);
  const access = getWebProviderConnectionOptions(providerInfo || provider);
  const futureOptions = [...tools, ...access].filter((option) => !option.implemented);

  const renderStatus = () => {
    if (isNoAuth) return <Badge variant="success" size="sm">Ready</Badge>;
    if (allDisabled) return <Badge variant="default" size="sm">Disabled</Badge>;
    if (total === 0) return <span className="text-xs text-text-muted">No connections</span>;
    return (
      <>
        {connected > 0 && <Badge variant="success" size="sm" dot>{connected} Connected</Badge>}
        {error > 0 && <Badge variant="error" size="sm" dot>{error} Error</Badge>}
        {connected === 0 && error === 0 && <Badge variant="default" size="sm">{total} Added</Badge>}
      </>
    );
  };

  return (
      <Card padding="xs" className={`relative h-full hover:bg-black/[0.01] dark:hover:bg-white/[0.01] transition-colors ${allDisabled ? "opacity-50" : ""}`}>
        <Link
          href={getCapabilityProviderHref(kind, provider.id)}
          aria-label={`Open ${provider.name} settings`}
          className="absolute inset-0 rounded-[14px] focus-visible:outline-2 focus-visible:outline-primary"
        />
        <div className="pointer-events-none relative flex min-w-0 items-center gap-3">
          <div
            className="size-8 rounded-lg flex items-center justify-center shrink-0"
            style={{ backgroundColor: `${provider.color?.length > 7 ? provider.color : (provider.color ?? "#888") + "15"}` }}
          >
            <ProviderIcon
              src={getWebProviderIconSrc(provider.id)}
              alt={provider.name}
              size={30}
              className="object-contain rounded-lg max-w-[30px] max-h-[30px]"
              fallbackText={provider.textIcon || provider.id.slice(0, 2).toUpperCase()}
              fallbackColor={provider.color}
            />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold">{provider.name}</h3>
            </div>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">{renderStatus()}</div>
          </div>
        </div>
        <div className="pointer-events-none relative mt-2 border-t border-border pt-2 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-text-muted w-14 shrink-0">Tools</span>
            {tools.map((tool) => tool.implemented ? (
              <Link key={tool.type} href={getCapabilityProviderHref(tool.kind, provider.id)} className="pointer-events-auto relative rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary hover:bg-primary/20">
                {tool.label}
              </Link>
            ) : (
              <span key={tool.type} title={`Service capability, not integrated in SRouter: ${tool.note}`} className="pointer-events-auto rounded-full border border-dashed border-primary/40 px-2.5 py-0.5 text-xs font-semibold text-text-muted">
                {tool.label}<span className="ml-1 text-xs font-normal">future</span>
              </span>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-text-muted w-14 shrink-0">Connect</span>
            {access.map((option) => (
              <span key={option.type} title={`${option.implemented ? "" : "Possible future connection: "}${option.note}`} className={`pointer-events-auto rounded-full px-2.5 py-0.5 text-xs font-semibold text-text-muted ${option.implemented ? "bg-surface-2" : "border border-dashed border-border"}`}>
                {option.label}{!option.implemented && <span className="ml-1 text-xs font-normal">future</span>}
              </span>
            ))}
          </div>
          {futureOptions.length > 0 && (
            <details className="pointer-events-auto pt-1 text-xs text-text-muted">
              <summary className="cursor-pointer hover:text-primary">Service capabilities &amp; possible access</summary>
              <div className="mt-2 space-y-2">
                {futureOptions.map((option) => (
                  <div key={`${option.label}-${option.type}`}>
                    <span className="font-semibold">{option.label}</span>: {option.note}
                    <span className="ml-1">({option.status === "conditional" ? "conditional" : "documented"}; not integrated)</span>
                    {option.sources.map((url, index) => (
                      <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="ml-2 text-primary underline">Source {index + 1}</a>
                    ))}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </Card>
  );
}

const CUSTOM_NODE_COLOR = "#6366F1";

function getCustomModeLabel(node) {
  if (node.mode === "plugin") return `Local plugin · ${AI_PROVIDERS[node.sourceProviderId]?.name || node.sourceProviderId}`;
  if (node.mode === "linked") return `Linked · WIP · ${AI_PROVIDERS[node.sourceProviderId]?.name || node.sourceProviderId}`;
  if (node.mode === "searxng") return "SearXNG";
  return "JSON API";
}

export function CustomProviderCard({ node, connections }) {
  const providerConns = connections.filter((c) => c.provider === node.id);
  const connected = providerConns.filter((c) => {
    const s = getEffectiveStatus(c);
    return s === "active" || s === "success";
  }).length;
  const allDisabled = providerConns.length > 0 && providerConns.every((c) => c.isActive === false);
  const pinnedConnection = node.sourceConnectionId
    ? connections.find((c) => c.id === node.sourceConnectionId)
    : null;
  const isLinked = ["linked", "plugin"].includes(node.mode);

  return (
    <Card padding="xs" className={`relative h-full hover:bg-black/[0.01] dark:hover:bg-white/[0.01] transition-colors ${allDisabled ? "opacity-50" : ""}`}>
      <Link
        href={getCapabilityProviderHref("webSearch", node.id)}
        aria-label={`Open ${node.name} settings`}
        className="absolute inset-0 rounded-[14px] focus-visible:outline-2 focus-visible:outline-primary"
      />
      <div className="pointer-events-none relative flex min-w-0 items-center gap-3">
        <div
          className="size-8 rounded-lg flex items-center justify-center shrink-0"
          style={{ backgroundColor: `${CUSTOM_NODE_COLOR}15` }}
        >
          <span className="material-symbols-outlined text-[20px]" style={{ color: CUSTOM_NODE_COLOR }}>tune</span>
        </div>
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{node.name}</h3>
            <Badge size="sm" variant="default">Custom</Badge>
          </div>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <Badge size="sm" variant="info">{getCustomModeLabel(node)}</Badge>
            {isLinked ? (
              <span className="text-xs text-text-muted">
                {node.sourceConnectionId ? `Pinned: ${pinnedConnection?.name || "selected account"}` : "Any active account"}
              </span>
            ) : (
              <>
                {providerConns.length === 0 ? (
                  <span className="text-xs text-text-muted">No connections</span>
                ) : (
                  <>
                    {connected > 0 && <Badge size="sm" variant="success" dot>{connected} Connected</Badge>}
                    {connected === 0 && <Badge size="sm" variant="default">{providerConns.length} Added</Badge>}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

function Section({ providers, connections, customNodes = [] }) {
  const totalCount = providers.length + customNodes.length;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
        <span>{totalCount} providers</span>
        <span>Solid: SRouter adapter · Dashed / future: service capability or possible connection</span>
      </div>

      {/* Providers grid — bottom */}
      {totalCount === 0 ? (
        <div className="text-center py-8 border border-dashed border-border rounded-xl text-text-muted text-sm">
          No providers.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {customNodes.map((node) => (
            <CustomProviderCard key={node.id} node={node} connections={connections} />
          ))}
          {groupWebProviders(providers).map((item) => item.entries ? (
            <ProviderCardGroup
              key={item.id}
              name={item.name}
              iconSrc={getWebGroupIconSrc(item.name)}
              entries={item.entries.map((provider) => [provider.id, provider])}
              renderCard={([, provider]) => <ProviderCard provider={provider} connections={connections} />}
            />
          ) : (
            <ProviderCard key={item.id} provider={item.provider} connections={connections} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function WebProvidersPage() {
  const [connections, setConnections] = useState([]);
  const [customNodes, setCustomNodes] = useState([]);
  const [addOpen, setAddOpen] = useState(false);

  const fetchAll = async () => {
    try {
      const connsRes = await fetch("/api/providers", { cache: "no-store" });
      if (connsRes.ok) setConnections((await connsRes.json()).connections || []);
      const nodesRes = await fetch("/api/provider-nodes", { cache: "no-store" });
      if (nodesRes.ok) {
        const nodes = (await nodesRes.json()).nodes || [];
        setCustomNodes(nodes.filter((node) => node.type === "custom-websearch"));
      }
    } catch { /* noop */ }
  };

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { fetchAll(); }, []);

  const providers = getWebProviders();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
      <Link href="/dashboard/search/srouter-search" className="block">
        <Card padding="xs" className="flex items-center gap-3 hover:bg-black/[0.01] dark:hover:bg-white/[0.01] transition-colors">
          <span className="material-symbols-outlined text-primary">travel_explore</span>
          <div className="flex-1">
            <h3 className="font-semibold">SrouterSearch MCP</h3>
            <p className="text-xs text-text-muted">Search and Fetch tools for your harness · Connection and settings</p>
          </div>
          <span className="material-symbols-outlined text-text-muted">chevron_right</span>
        </Card>
      </Link>
      <Link href="/dashboard/search/workflows" className="block">
        <Card padding="xs" className="flex items-center gap-3 hover:bg-black/[0.01] dark:hover:bg-white/[0.01] transition-colors">
          <span className="material-symbols-outlined text-primary">account_tree</span>
          <div className="flex-1">
            <h3 className="font-semibold">Search Workflow</h3>
            <p className="text-xs text-text-muted">Search and page extraction · Manage existing combos and create workflows</p>
          </div>
          <span className="material-symbols-outlined text-text-muted">chevron_right</span>
        </Card>
      </Link>
      <button type="button" onClick={() => setAddOpen(true)} className="block w-full text-left">
        <Card padding="xs" className="flex items-center gap-3 hover:bg-black/[0.01] dark:hover:bg-white/[0.01] transition-colors">
          <span className="material-symbols-outlined text-primary">add_circle</span>
          <div className="flex-1">
            <h3 className="font-semibold">Add custom provider</h3>
            <p className="text-xs text-text-muted">SearXNG endpoint, JSON search API or a connected provider&apos;s hosted search tool</p>
          </div>
          <span className="material-symbols-outlined text-text-muted">expand_more</span>
        </Card>
      </button>
      </div>
      <AddCustomSearchProviderModal
        isOpen={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={() => { fetchAll(); }}
        onSaved={() => { setAddOpen(false); fetchAll(); }}
      />
      <Section
        providers={providers} connections={connections} customNodes={customNodes}
      />
    </div>
  );
}
