"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import Link from "next/link";
import { Modal, Input, Button, Badge } from "@/shared/components";
import ProviderIcon from "./ProviderIcon";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { HOSTED_TOOLS_WIP, HOSTED_TOOLS_WIP_MESSAGE } from "@/shared/constants/hostedTools";
import {
  getHostedProviderCatalog, getHostedProviderAccounts, getProviderHostedAdapters, loadHostedSearchCatalog,
  getHostedFamilyAccounts, getHostedProviderFamilyIds, selectHostedSource, sortHostedProviders,
} from "@/shared/utils/hostedSearchProviders";

const FIELD_CLASS = "rounded-lg border border-border bg-surface px-3 py-2 text-sm";

const MODES = [
  { id: "searxng", label: "SearXNG-compatible endpoint" },
  { id: "json", label: "Custom JSON search API" },
  { id: "plugin", label: "Local JS plugin (direct tool backend)" },
  { id: "linked", label: "Connected provider (hosted search tool) · WIP", disabled: HOSTED_TOOLS_WIP },
];

const AUTH_HEADERS = [
  { id: "none", label: "No auth" },
  { id: "bearer", label: "Authorization: Bearer" },
  { id: "x-api-key", label: "X-API-Key" },
];

export function HostedProviderPicker({ providers, connections, adapters, onSelect, onBack }) {
  const [query, setQuery] = useState("");
  const filtered = sortHostedProviders(providers, connections).filter((provider) =>
    `${provider.name || ""} ${provider.id} ${provider.searchTerms || ""}`.toLowerCase().includes(query.toLowerCase().trim()));
  return (
    <div className="flex flex-col gap-4">
      <Button onClick={onBack} variant="ghost">
        <span className="material-symbols-outlined text-[18px]">arrow_back</span>Back
      </Button>
      <input type="search" autoFocus aria-label="Search providers" placeholder="Search providers…"
        value={query} onChange={(event) => setQuery(event.target.value)} className={FIELD_CLASS} />
      <p className="text-xs text-text-muted">API, OAuth and free providers. Choose a provider, then its account and hosted search adapter.</p>
      <div className="grid grid-cols-2 gap-2">
        {filtered.map((provider) => {
          const accounts = getHostedFamilyAccounts(connections, provider.id);
          const active = accounts.filter((account) => account.isActive !== false && account.hasCredential !== false);
          const available = adapters.filter((adapter) => getHostedProviderFamilyIds(provider.id)
            .some((id) => getProviderHostedAdapters([adapter], id).length));
          return (
            <button type="button" key={provider.id} onClick={() => onSelect(provider.id)}
              className="flex items-center gap-2 rounded-lg border border-border bg-surface p-3 text-left hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-primary">
              <ProviderIcon providerId={provider.id} alt="" size={28} fallbackText={(provider.name || provider.id).slice(0, 2)} />
              <span className="min-w-0 flex flex-col gap-1">
                <span className="text-sm font-medium break-words">{provider.name || provider.id}</span>
                {provider.connectionLabel && <span className="text-xs text-text-muted">{provider.connectionLabel}</span>}
                <span className="text-xs text-text-muted">{provider.noAuth ? "Keyless" : `${active.length} active / ${accounts.length} accounts`}</span>
                <span className="text-xs text-text-muted">{available.length ? `${available.length} adapter(s)` : "Local plugin required"}</span>
              </span>
            </button>
          );
        })}
      </div>
      {!filtered.length && <p className="text-sm text-text-muted">No providers found.</p>}
    </div>
  );
}

// Build the provider-node payload for create/update. An empty linked account
// selection is serialized as an explicit null so a previously pinned account
// is cleared on edit instead of preserved (PUT treats a missing field as
// "keep the current value").
export function buildNodePayload(form) {
  return {
    name: form.name.trim(),
    mode: form.mode,
    ...(!["linked", "plugin"].includes(form.mode)
      ? {
          baseUrl: form.baseUrl.trim(),
          authHeader: form.authHeader,
        }
      : {
          sourceProviderId: form.sourceProviderId.trim(),
          sourceConnectionId: form.sourceConnectionId || null,
          ...(form.sourceAdapterId !== undefined ? { sourceAdapterId: form.sourceAdapterId || null } : {}),
          ...(form.mode === "plugin" ? { sourceModel: null } :
            (form.sourceModel !== undefined ? { sourceModel: form.sourceModel.trim() || null } : {})),
        }),
  };
}

// Create or update the node and, on create with an endpoint key, its key
// connection. Returns `{ node, keyError }`: a key failure is non-fatal because
// the node already exists — the caller keeps it and explains the state instead
// of retrying the create (which would duplicate the node).
export async function submitCustomSearchNode({ form, apiKey, editNode, fetchImpl = fetch }) {
  const payload = buildNodePayload(form);
  if (!editNode) payload.type = "custom-websearch";

  const res = await fetchImpl(editNode ? `/api/provider-nodes/${editNode.id}` : "/api/provider-nodes", {
    method: editNode ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error || `Failed (HTTP ${res.status})`);
  }
  const node = data.node;

  if (!editNode && !["linked", "plugin"].includes(form.mode) && apiKey.trim()) {
    let keyError = null;
    try {
      const connRes = await fetchImpl("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: node.id,
          apiKey: apiKey.trim(),
          name: `${node.name} key`,
        }),
      });
      if (!connRes.ok) {
        const connData = await connRes.json().catch(() => null);
        keyError = connData?.error || `HTTP ${connRes.status}`;
      }
    } catch (err) {
      keyError = err?.message || "network error";
    }
    if (keyError) return { node, keyError };
  }
  return { node, keyError: null };
}

// Dual-mode modal: edit when `node` provided, add otherwise.
export default function AddCustomSearchProviderModal({ isOpen, onClose, onCreated, onSaved, node }) {
  const isEdit = !!node;
  const [form, setForm] = useState({
    name: node?.name || "",
    mode: node?.mode || "searxng",
    baseUrl: node?.baseUrl || "",
    authHeader: node?.authHeader || "none",
    sourceProviderId: node?.sourceProviderId || "",
    sourceConnectionId: node?.sourceConnectionId || "",
    sourceAdapterId: node?.sourceAdapterId || "",
    sourceModel: node?.sourceModel || "",
  });
  const [apiKey, setApiKey] = useState("");
  const [connections, setConnections] = useState([]);
  const [providerNodes, setProviderNodes] = useState([]);
  const [adapters, setAdapters] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  // Node created by a partial failure (key connection failed): the dialog
  // keeps editing this node so a retry can never create a duplicate.
  const [createdNode, setCreatedNode] = useState(null);

  const linkable = getHostedProviderCatalog(providerNodes, connections);
  const accounts = getHostedProviderAccounts(connections, form.sourceProviderId);
  const familyAccounts = getHostedFamilyAccounts(connections, form.sourceProviderId);
  const familyIds = getHostedProviderFamilyIds(form.sourceProviderId);
  const pickerProviderId = form.sourceProviderId === "codex" ? "openai" : form.sourceProviderId;
  const availableAdapters = getProviderHostedAdapters(adapters, form.sourceProviderId);
  const selectedProvider = AI_PROVIDERS[form.sourceProviderId] || linkable.find((provider) => provider.id === form.sourceProviderId);
  const displayProvider = linkable.find((provider) => provider.id === pickerProviderId) || selectedProvider;
  const selectedAdapter = availableAdapters.find((adapter) => adapter.id === form.sourceAdapterId);
  const legacyAdapter = !!node && !node.sourceAdapterId && node.sourceProviderId === form.sourceProviderId
    && !!(selectedProvider?.searchConfig || selectedProvider?.searchViaChat);
  const hasAccount = selectedProvider?.noAuth || (form.sourceConnectionId
    ? accounts.some((account) => account.id === form.sourceConnectionId && account.isActive !== false && account.hasCredential !== false)
    : accounts.some((account) => account.isActive !== false && account.hasCredential !== false));
  const effectiveEdit = isEdit || !!createdNode;
  const activeNode = createdNode || node;

  /* eslint-disable react-hooks/set-state-in-effect -- reset the draft form when the dialog opens */
  useEffect(() => {
    if (!isOpen) return;
    setError("");
    setApiKey("");
    setCreatedNode(null);
    setPickerOpen(false);
    if (isEdit) {
      setForm({
        name: node.name || "",
        mode: node.mode || "searxng",
        baseUrl: node.baseUrl || "",
        authHeader: node.authHeader || "none",
        sourceProviderId: node.sourceProviderId || "",
        sourceConnectionId: node.sourceConnectionId || "",
        sourceAdapterId: node.sourceAdapterId || "",
        sourceModel: node.sourceModel || "",
      });
    } else {
      setForm({ name: "", mode: "searxng", baseUrl: "", authHeader: "none", sourceProviderId: "", sourceConnectionId: "", sourceAdapterId: "", sourceModel: "" });
    }
  }, [isOpen, isEdit, node]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Load the actual connection pool once, independent of the selected provider.
  // Selecting Codex must not accidentally look up OpenAI API accounts.
  /* eslint-disable react-hooks/set-state-in-effect -- opening starts a cancellable catalog load */
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setCatalogLoading(true);
    setCatalogError("");
    loadHostedSearchCatalog()
      .then((d) => {
        if (cancelled) return;
        setConnections(d.connections);
        setProviderNodes(d.nodes);
        setAdapters(d.adapters);
      })
      .catch((err) => {
        if (!cancelled) {
          setConnections([]);
          setAdapters([]);
          setCatalogError(err.message);
        }
      })
      .finally(() => { if (!cancelled) setCatalogLoading(false); });
    return () => { cancelled = true; };
  }, [isOpen]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const valid = !!form.name.trim()
    && (!["linked", "plugin"].includes(form.mode)
      ? !!form.baseUrl.trim()
      : !!form.sourceProviderId.trim() && !catalogLoading && !catalogError
        && (form.mode === "plugin" ? selectedAdapter?.id.startsWith("plugin:") : !HOSTED_TOOLS_WIP)
        && hasAccount && (!!selectedAdapter || (form.mode === "linked" && legacyAdapter)));

  const handleSubmit = async () => {
    if (!valid) return;
    setSubmitting(true);
    setError("");
    try {
      const { node: savedNode, keyError } = await submitCustomSearchNode({
        form,
        apiKey,
        editNode: effectiveEdit ? activeNode : null,
      });

      if (effectiveEdit) {
        if (createdNode) setCreatedNode(null);
        if (onSaved) onSaved(savedNode);
        else onClose?.();
        return;
      }

      if (keyError) {
        // The node exists; keep the dialog on it (edit mode) so a retry can
        // never create a duplicate, refresh the parent list, and keep the
        // explanation visible.
        setCreatedNode(savedNode);
        onCreated?.(savedNode);
        setError(`Provider created, but adding the API key failed: ${keyError}. You can add the key later from the provider's detail page.`);
        return;
      }

      onCreated?.(savedNode);
      onClose?.();
    } catch (err) {
      setError(err?.message || "Could not save the custom provider.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title={pickerOpen ? "Select Provider" : (effectiveEdit ? "Edit Custom Search Provider" : "Add Custom Search Provider")}
      onClose={pickerOpen ? () => setPickerOpen(false) : onClose}>
      {pickerOpen ? (
        <HostedProviderPicker providers={linkable} connections={connections} adapters={adapters}
          onBack={() => setPickerOpen(false)}
          onSelect={(providerId) => {
            setForm({ ...form, ...selectHostedSource(providerId, connections, adapters) });
            setPickerOpen(false);
          }} />
      ) : (
      <div className="flex flex-col gap-4">
        <Input
          label="Name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="My SearXNG"
          hint="Required. A friendly label; requests use the generated provider ID."
        />
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Mode</span>
          <select
            value={form.mode}
            onChange={(e) => setForm({ ...form, mode: e.target.value, sourceModel: "" })}
            className={FIELD_CLASS}
          >
            {MODES.map((mode) => <option key={mode.id} value={mode.id} disabled={mode.disabled}>{mode.label}</option>)}
          </select>
        </label>

        {HOSTED_TOOLS_WIP && (
          <div className="rounded-lg border border-border p-3 text-xs text-text-muted">
            <Badge variant="warning">Hosted tools · WIP</Badge>
            <p className="mt-2">{HOSTED_TOOLS_WIP_MESSAGE}</p>
          </div>
        )}

        {!["linked", "plugin"].includes(form.mode) ? (
          <>
            <Input
              label="Base URL"
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              placeholder={form.mode === "searxng" ? "https://searx.example.org" : "https://api.example.com/search"}
              hint={form.mode === "searxng"
                ? "SearXNG root or /search endpoint. Must be a public http(s) URL; the stored key is never redirected by client baseUrl overrides."
                : "Endpoint receiving POST { query, max_results, search_type } and answering JSON { results: [{ title, url, snippet }] }."}
            />
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Auth</span>
              <select
                value={form.authHeader}
                onChange={(e) => setForm({ ...form, authHeader: e.target.value })}
                className={FIELD_CLASS}
              >
                {AUTH_HEADERS.map((auth) => <option key={auth.id} value={auth.id}>{auth.label}</option>)}
              </select>
            </label>
            {!effectiveEdit && (
              <Input
                label="API Key (optional)"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                hint="Stored as a normal connection of this provider. Can be added later from its detail page."
              />
            )}
            {effectiveEdit && (
              <p className="text-xs text-text-muted">
                API keys are managed as connections on the provider&apos;s detail page.
              </p>
            )}
          </>
        ) : form.mode === "linked" && HOSTED_TOOLS_WIP ? null : (
          <>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Connected provider</span>
              <button type="button" onClick={() => setPickerOpen(true)} disabled={catalogLoading}
                className={`${FIELD_CLASS} flex items-center gap-2 text-left`}>
                {form.sourceProviderId && <ProviderIcon providerId={pickerProviderId} alt="" size={24} fallbackText="?" />}
                <span className="flex-1">{catalogLoading ? "Loading providers…" : (displayProvider?.name || form.sourceProviderId || "Select a provider…")}</span>
                <span className="material-symbols-outlined text-[18px]">chevron_right</span>
              </button>
              <span className="text-xs text-text-muted">
                Uses an existing API/OAuth/free connection. SRouter calls the local plugin directly, without a model.
              </span>
            </label>
            {catalogError && <p role="alert" className="text-sm text-red-500">{catalogError}</p>}
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Account</span>
              <select
                value={form.sourceConnectionId ? `account:${form.sourceConnectionId}` : `any:${form.sourceProviderId}`}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value.startsWith("any:")) {
                    const providerId = value.slice(4);
                    setForm({ ...form, sourceProviderId: providerId, sourceConnectionId: "",
                      ...(providerId !== form.sourceProviderId ? {
                        sourceAdapterId: getProviderHostedAdapters(adapters, providerId)[0]?.id || "", sourceModel: "",
                      } : {}) });
                  } else {
                    const selection = selectHostedSource(form.sourceProviderId, connections, adapters, value.slice(8));
                    setForm({ ...form, ...selection, ...(selection.sourceProviderId === form.sourceProviderId ? {
                      sourceAdapterId: form.sourceAdapterId, sourceModel: form.sourceModel,
                    } : {}) });
                  }
                }}
                disabled={!form.sourceProviderId || catalogLoading || selectedProvider?.noAuth}
                className={FIELD_CLASS}
              >
                {familyIds.map((providerId) => (
                  <option key={providerId} value={`any:${providerId}`}>Any active account{familyIds.length > 1 ? ` · ${AI_PROVIDERS[providerId]?.name || providerId}` : ""} (rotation/fallback)</option>
                ))}
                {familyAccounts.map((connection) => (
                  <option data-streamer-sensitive key={connection.id} value={`account:${connection.id}`} disabled={connection.isActive === false || connection.hasCredential === false}>
                    {connection.name || connection.email || connection.id.slice(0, 8)}{connection.authType ? ` · ${connection.authType}` : ""}{connection.isActive === false ? " (disabled)" : ""}
                  </option>
                ))}
              </select>
              <span className="text-xs text-text-muted">
                A specific account is pinned strictly: if it is unavailable the search fails instead of using another account.
              </span>
              {familyIds.length > 1 && <span className="text-xs text-text-muted">
                OpenAI API and Codex OAuth accounts are listed together. The selected account determines the actual backend and adapter; credentials are never mixed.
              </span>}
            </label>
            {form.sourceProviderId && !catalogLoading && !hasAccount && (
              <p className="text-xs text-text-muted">No active account. Connect this provider on the <Link className="text-primary underline" href="/dashboard/providers">Providers page</Link> first.</p>
            )}
            {form.sourceProviderId && (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium">Local search plugin</span>
                  <select value={form.sourceAdapterId}
                    onChange={(event) => setForm({ ...form, sourceAdapterId: event.target.value, sourceModel: "" })}
                    className={FIELD_CLASS}>
                    <option value="">{form.mode === "linked" && legacyAdapter ? "Existing search adapter (legacy)" : "Select a plugin…"}</option>
                    {availableAdapters.map((adapter) => <option key={adapter.id} value={adapter.id}>{adapter.name}</option>)}
                  </select>
                </label>
                {!availableAdapters.length && (
                  <p className="text-xs text-text-muted">Install a trusted local .mjs plugin in DATA_DIR/plugins/hosted-search, then restart SRouter. No code upload or hot reload is available.</p>
                )}
                <p className="text-xs text-text-muted">
                  This adapter exposes Web Search only. It does not discover or connect Web Fetch or other hosted tools automatically.
                </p>
              </>
            )}
          </>
        )}

        {error && (
          <div className="flex flex-col gap-1">
            <Badge variant="error">Error</Badge>
            <span role="alert" className="text-sm text-red-500">{error}</span>
          </div>
        )}

        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={!valid || submitting}>
            {submitting ? (effectiveEdit ? "Saving..." : "Creating...") : (effectiveEdit ? "Save" : "Create")}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
        </div>
      </div>
      )}
    </Modal>
  );
}

AddCustomSearchProviderModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onCreated: PropTypes.func,
  onSaved: PropTypes.func,
  node: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    mode: PropTypes.string,
    baseUrl: PropTypes.string,
    authHeader: PropTypes.string,
    sourceProviderId: PropTypes.string,
    sourceConnectionId: PropTypes.string,
    sourceAdapterId: PropTypes.string,
    sourceModel: PropTypes.string,
  }),
};

HostedProviderPicker.propTypes = {
  providers: PropTypes.array.isRequired,
  connections: PropTypes.array.isRequired,
  adapters: PropTypes.array.isRequired,
  onSelect: PropTypes.func.isRequired,
  onBack: PropTypes.func.isRequired,
};
