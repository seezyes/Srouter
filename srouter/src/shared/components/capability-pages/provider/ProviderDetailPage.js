"use client";

import { useParams, notFound, useRouter } from "next/navigation";
import Link from "next/link";
import { useState, useEffect } from "react";
import { Card, Badge, Button, AddCustomEmbeddingModal, AddCustomSearchProviderModal, NoAuthProxyCard, ProviderInfoCard } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { MEDIA_PROVIDER_KINDS, AI_PROVIDERS, isCustomEmbeddingProvider, isCustomWebSearchProvider } from "@/shared/constants/providers";
import { getCapabilityListingHref } from "@/shared/utils/capabilityRoutes";
import ConnectionsCard from "@/app/(dashboard)/dashboard/providers/components/ConnectionsCard";
import ModelsCard from "@/app/(dashboard)/dashboard/providers/components/ModelsCard";
import { KIND_EXAMPLE_CONFIG } from "./components/exampleShared";
import { EmbeddingExampleCard } from "./components/EmbeddingExampleCard";
import { TtsExampleCard } from "./components/TtsExampleCard";
import { GenericExampleCard } from "./components/GenericExampleCard";
import { ExaSearchExampleCard } from "./components/ExaSearchExampleCard";
import { SttExampleCard } from "./components/SttExampleCard";

// MediaProviderDetailPage
export default function CapabilityProviderDetailPage({ kind }) {
  const { id } = useParams();
  const router = useRouter();
  const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === kind);
  const isCustomSearch = isCustomWebSearchProvider(id) && kind === "webSearch";
  const isCustom = (isCustomEmbeddingProvider(id) && kind === "embedding") || isCustomSearch;

  const handleDeleteCustom = async () => {
    if (!confirm(isCustomSearch ? "Delete this Custom Search provider?" : "Delete this Custom Embedding node?")) return;
    try {
      const res = await fetch(`/api/provider-nodes/${id}`, { method: "DELETE" });
      if (res.ok) router.push(getCapabilityListingHref(kind));
    } catch (error) {
      console.log("Error deleting custom embedding node:", error);
    }
  };

  const [customNode, setCustomNode] = useState(null);
  const [customLoading, setCustomLoading] = useState(isCustom);
  const [showEditModal, setShowEditModal] = useState(false);

  // Fetch custom node info from API for custom embedding nodes
  useEffect(() => {
    if (!isCustom) return;
    let cancelled = false;
    fetch("/api/provider-nodes", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setCustomNode((d.nodes || []).find((n) => n.id === id) || null);
        setCustomLoading(false);
      })
      .catch(() => { if (!cancelled) setCustomLoading(false); });
    return () => { cancelled = true; };
  }, [id, isCustom]);

  if (!kindConfig) return notFound();

  const builtInProvider = AI_PROVIDERS[id];

  // For custom nodes, build a synthetic provider object
  const provider = isCustom
    ? (customNode ? {
        id,
        name: customNode.name || (isCustomSearch ? "Custom Search" : "Custom Embedding"),
        color: "#6366F1",
        textIcon: isCustomSearch ? "CS" : "CE",
      } : null)
    : builtInProvider;

  if (!isCustom && !builtInProvider) return notFound();
  if (isCustom && !customLoading && !customNode) return notFound();
  if (isCustom && customLoading) {
    return <div className="text-text-muted text-sm py-12 text-center">Loading...</div>;
  }

  const kinds = isCustom ? [isCustomSearch ? "webSearch" : "embedding"] : (provider.serviceKinds ?? ["llm"]);
  if (!isCustom && !kinds.includes(kind)) return notFound();

  return (
    <div className="flex flex-col gap-8">
      {/* Back */}
      <div>
        <Link
          href={getCapabilityListingHref(kind)}
          className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-primary transition-colors mb-4"
        >
          <span className="material-symbols-outlined text-lg">arrow_back</span>
          {kindConfig.label}
        </Link>

        {/* Header */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
          <div className="size-12 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: `${provider.color}15` }}>
            <ProviderIcon
              src={`/providers/${provider.id}.png`}
              alt={provider.name}
              size={48}
              className="object-contain rounded-lg max-w-[48px] max-h-[48px]"
              fallbackText={provider.textIcon || provider.id.slice(0, 2).toUpperCase()}
              fallbackColor={provider.color}
            />
          </div>
          <div className="flex-1">
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <h1 className="text-3xl font-semibold tracking-tight">{provider.name}</h1>
              {!isCustom && provider.notice?.apiKeyUrl && (
                <a
                  href={provider.notice.apiKeyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                >
                  <span className="material-symbols-outlined text-sm">open_in_new</span>
                  Get API Key
                </a>
              )}
            </div>
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              {isCustom && (
                <Badge variant="default" size="sm">
                  Custom{isCustomSearch ? ` · ${customNode?.mode || ""}` : ` · ${customNode?.prefix}`}
                </Badge>
              )}
              {kinds.map((k) => (
                <Badge key={k} variant={k === kind ? "primary" : "default"} size="sm">
                  {k.toUpperCase()}
                </Badge>
              ))}
            </div>
          </div>
          {isCustom && (
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
              <Button size="sm" variant="secondary" icon="edit" onClick={() => setShowEditModal(true)}>
                Edit
              </Button>
              <Button size="sm" variant="secondary" icon="delete" onClick={handleDeleteCustom}>
                Delete
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Kind-specific notice (e.g. codex/image requires Plus) */}
      {!isCustom && provider.kindNotice?.[kind] && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-400">
          <span className="material-symbols-outlined text-[20px] mt-0.5">warning</span>
          <p className="text-sm">{provider.kindNotice[kind]}</p>
        </div>
      )}

      {/* Provider notice text (only when there's actual text content) */}
      {!isCustom && provider.notice?.text && !provider.deprecated && (
        <div className="flex flex-col gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 sm:flex-row sm:items-center">
          <span className="material-symbols-outlined text-[16px] text-blue-500 shrink-0">info</span>
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-blue-600 dark:text-blue-400">{provider.notice.text}</p>
          {provider.notice.apiKeyUrl && (
            <a
              href={provider.notice.apiKeyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex justify-center rounded bg-blue-500 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-600 sm:py-0.5"
            >
              Get API Key →
            </a>
          )}
        </div>
      )}

      {/* Connections: endpoint-mode custom search nodes manage keys as normal
          connections of the node; linked nodes use the source provider's
          existing accounts and must not get their own key rows. */}
      {isCustomSearch && ["linked", "plugin"].includes(customNode?.mode) ? (
        <Card padding="sm">
          <h3 className="mb-2 font-semibold text-sm">{customNode.mode === "plugin" ? "Local search plugin" : "Hosted tools · WIP (unavailable)"}</h3>
          <p className="text-xs text-text-muted">
            {customNode.mode === "plugin"
              ? "SRouter invokes the installed local plugin directly, without calling a model. The plugin must be loaded at server startup."
              : "This connector is disabled until it can call the tool backend directly without invoking a model."}
            The saved source is <span className="font-medium text-text-primary">{AI_PROVIDERS[customNode.sourceProviderId]?.name || customNode.sourceProviderId}</span>.
            {customNode.mode === "plugin"
              ? "Only the selected source account is used. This plugin exposes Search, not automatic Fetch or tool discovery."
              : "Existing configuration is preserved; no credentials or model requests are used by this linked provider."}
          </p>
        </Card>
      ) : !isCustom && provider.noAuth ? (
        <NoAuthProxyCard providerId={id} />
      ) : (
        <ConnectionsCard providerId={id} isOAuth={false} />
      )}

      {/* Models - hidden for tts/webSearch/webFetch (provider IS the model); custom uses prefix as alias */}
      {kind !== "tts" && kind !== "webSearch" && kind !== "webFetch" && (
        <ModelsCard
          providerId={id}
          kindFilter={kind}
          providerAliasOverride={isCustom ? customNode?.prefix : undefined}
        />
      )}

      {/* Provider Info — config-driven, supports searchConfig, fetchConfig, ttsConfig, embeddingConfig, systemoneConfig, searchViaChat */}
      {!isCustom && (provider.searchConfig || provider.fetchConfig || provider.ttsConfig || provider.sttConfig || provider.embeddingConfig || provider.systemoneConfig || provider.searchViaChat) && (
        <ProviderInfoCard
          config={
            kind === "webFetch" ? provider.fetchConfig
              : kind === "tts" ? provider.ttsConfig
              : kind === "stt" ? provider.sttConfig
              : kind === "embedding" ? provider.embeddingConfig
              : kind === "systemone" ? provider.systemoneConfig
              : provider.searchConfig || { mode: "chat-completions", defaultModel: provider.searchViaChat?.defaultModel, pricingUrl: provider.searchViaChat?.pricingUrl, freeTier: provider.searchViaChat?.freeTier }
          }
          provider={provider}
          title={`${kindConfig.label} Config`}
        />
      )}

      {/* Example — per kind */}
      {kind === "embedding" && (
        <EmbeddingExampleCard providerId={id} customAlias={customNode?.prefix} />
      )}
      {kind === "tts" && <TtsExampleCard providerId={id} />}
      {kind === "stt" && !isCustom && <SttExampleCard providerId={id} />}
      {!isCustom && kind === "webSearch" && id === "exa" && <ExaSearchExampleCard providerId={id} />}
      {(!isCustom || isCustomSearch) && KIND_EXAMPLE_CONFIG[kind] && (kind !== "webSearch" || id !== "exa") && <GenericExampleCard providerId={id} kind={kind} />}

      {isCustomSearch && (
        <AddCustomSearchProviderModal
          isOpen={showEditModal}
          node={customNode}
          onClose={() => setShowEditModal(false)}
          onSaved={(updated) => {
            setCustomNode(updated);
            setShowEditModal(false);
          }}
        />
      )}
      {isCustom && !isCustomSearch && (
        <AddCustomEmbeddingModal
          isOpen={showEditModal}
          node={customNode}
          onClose={() => setShowEditModal(false)}
          onSaved={(updated) => {
            setCustomNode(updated);
            setShowEditModal(false);
          }}
        />
      )}
    </div>
  );
}
