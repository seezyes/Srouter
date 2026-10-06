"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getCapabilityComboHref } from "@/shared/utils/capabilityRoutes";
import {
  SEARCH_WORKFLOW_KINDS,
  generateSearchWorkflowName,
  getSearchWorkflowKind,
  isValidSearchWorkflowName,
  listSearchWorkflows,
  summarizeSearchWorkflows,
} from "@/shared/utils/searchWorkflows";

const FIELD_CLASS = "rounded-lg border border-border bg-surface px-3 py-2 text-sm";

function comboProviderIds(combo) {
  return (Array.isArray(combo.models) ? combo.models : [])
    .slice(0, 6)
    .map((entry) => (typeof entry === "string" ? entry.split("/")[0] : ""));
}

export function SearchWorkflowList({ workflows }) {
  if (!Array.isArray(workflows) || workflows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border px-3 py-8 text-center text-sm text-text-muted">
        No Search or Fetch workflows yet. Create one to group providers for /v1/search or /v1/web/fetch.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {workflows.map((combo) => {
        const kind = getSearchWorkflowKind(combo.kind);
        const providerIds = comboProviderIds(combo);
        return (
          <Link key={combo.id} href={getCapabilityComboHref(combo.kind, combo.id)} className="block">
            <Card padding="xs" className="cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
              <div className="flex min-w-0 items-center gap-3">
                <span aria-hidden="true" className="material-symbols-outlined text-primary text-[18px]">{kind?.icon || "layers"}</span>
                <code className="min-w-0 flex-1 truncate font-mono text-sm font-medium">{combo.name}</code>
                <Badge size="sm" variant={combo.kind === "webSearch" ? "primary" : "info"}>{kind?.label || combo.kind}</Badge>
                <div className="hidden flex-wrap items-center gap-1 sm:flex sm:shrink-0">
                  {providerIds.map((providerId, index) => {
                    const provider = AI_PROVIDERS[providerId];
                    return (
                      <div key={`${providerId}-${index}`} title={provider?.name || providerId} className="flex size-5 items-center justify-center rounded" style={{ backgroundColor: `${provider?.color ?? "#888"}15` }}>
                        <ProviderIcon
                          providerId={providerId}
                          alt={provider?.name || providerId}
                          size={18}
                          className="max-h-[18px] max-w-[18px] rounded object-contain"
                          fallbackText={provider?.textIcon || providerId.slice(0, 2).toUpperCase()}
                          fallbackColor={provider?.color}
                        />
                      </div>
                    );
                  })}
                </div>
                <span className="shrink-0 text-[11px] text-text-muted" title="Provider or model entries in this combo">{(Array.isArray(combo.models) ? combo.models : []).length}</span>
                <span aria-hidden="true" className="material-symbols-outlined text-[16px] text-text-muted">chevron_right</span>
              </div>
            </Card>
          </Link>
        );
      })}
    </div>
  );
}

export default function SearchWorkflowPage() {
  const router = useRouter();
  const [combos, setCombos] = useState([]);
  const [status, setStatus] = useState("loading");
  const [loadError, setLoadError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [createKind, setCreateKind] = useState(SEARCH_WORKFLOW_KINDS[0].id);
  const [createName, setCreateName] = useState("");
  const [createError, setCreateError] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/combos", { cache: "no-store", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Could not load workflows (HTTP ${response.status}).`);
        return response.json();
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        setCombos(Array.isArray(data?.combos) ? data.combos : []);
        setStatus("ready");
      })
      .catch((error) => {
        if (controller.signal.aborted || error?.name === "AbortError") return;
        setLoadError(error?.message || "Could not load workflows.");
        setStatus("error");
      });
    return () => controller.abort();
  }, [reloadKey]);

  const existingNames = combos
    .map((combo) => combo?.name)
    .filter((name) => typeof name === "string" && name.length > 0);

  const retry = () => {
    setLoadError("");
    setStatus("loading");
    setReloadKey((key) => key + 1);
  };

  const openCreate = () => {
    setCreateKind(SEARCH_WORKFLOW_KINDS[0].id);
    setCreateName(generateSearchWorkflowName(existingNames));
    setCreateError("");
    setCreating(false);
    setCreateOpen(true);
  };

  const closeCreate = () => {
    if (creating) return;
    setCreateOpen(false);
    setCreateError("");
  };

  // The only write path: runs from the user's submit in the browser, never on
  // load and never during tests/validation.
  const submitCreate = async (event) => {
    event.preventDefault();
    const name = createName.trim();
    if (!isValidSearchWorkflowName(name)) {
      setCreateError("Name can only contain letters, numbers, -, _ and .");
      return;
    }
    if (existingNames.includes(name)) {
      setCreateError(`"${name}" is already used by another combo. Pick a unique name.`);
      return;
    }
    setCreating(true);
    setCreateError("");
    try {
      const response = await fetch("/api/combos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, models: [], kind: createKind }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.id) {
        throw new Error(data?.error || `Could not create the workflow (HTTP ${response.status}).`);
      }
      router.push(getCapabilityComboHref(createKind, data.id));
    } catch (error) {
      setCreateError(error?.message || "Could not create the workflow. Retry from this page.");
      setCreating(false);
    }
  };

  const workflows = listSearchWorkflows(combos);
  const summary = summarizeSearchWorkflows(combos);
  const createDisabled = status !== "ready" || creating;

  return (
    <div className="flex flex-col gap-4">
      <Link href="/dashboard/search" className="text-sm text-text-muted hover:text-primary">Back to Web Search</Link>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-xs text-text-muted">
          {status === "ready"
            ? `${summary.total} workflow${summary.total === 1 ? "" : "s"} · ${summary.webSearch} Web Search · ${summary.webFetch} Web Fetch`
            : "Search and Fetch combos in one list"}
        </span>
        <Button size="sm" icon="add" onClick={openCreate} disabled={createDisabled}>Create Workflow</Button>
      </div>
      <p className="text-xs text-text-muted">
        Unified management for Search and Fetch combos. A workflow routes a single request across its
        providers with fallback; multi-step research (search → summary → agent loop) is not implemented
        here and stays planned in T-0042.
      </p>
      {createOpen && (
        <Card padding="sm">
          <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={submitCreate}>
            <label className="flex flex-1 flex-col gap-1.5 text-sm">
              <span className="font-medium">Kind</span>
              <select value={createKind} onChange={(event) => setCreateKind(event.target.value)} disabled={creating} className={FIELD_CLASS}>
                {SEARCH_WORKFLOW_KINDS.map((kind) => <option key={kind.id} value={kind.id}>{kind.label}</option>)}
              </select>
            </label>
            <label className="flex flex-1 flex-col gap-1.5 text-sm">
              <span className="font-medium">Name</span>
              <input
                value={createName}
                onChange={(event) => { setCreateName(event.target.value); setCreateError(""); }}
                disabled={creating}
                spellCheck={false}
                className={FIELD_CLASS}
              />
            </label>
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={creating}>{creating ? "Creating..." : "Create"}</Button>
              <Button type="button" variant="ghost" size="sm" onClick={closeCreate} disabled={creating}>Cancel</Button>
            </div>
          </form>
          {createError && <p role="alert" className="mt-2 text-sm text-red-500">{createError}</p>}
          <p className="mt-2 text-xs text-text-muted">
            Starts empty and opens its detail page, where you add providers and models. The kind is chosen
            here and stays with the existing combo contract; existing combos and IDs are not changed.
          </p>
        </Card>
      )}
      {status === "loading" && <p className="text-sm text-text-muted">Loading workflows…</p>}
      {status === "error" && (
        <Card padding="sm">
          <p role="alert" className="text-sm text-red-500">{loadError}</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Button size="sm" variant="outline" icon="refresh" onClick={retry}>Retry</Button>
            <span className="text-xs text-text-muted">Nothing was changed. Reload the page if the problem persists.</span>
          </div>
        </Card>
      )}
      {status === "ready" && <SearchWorkflowList workflows={workflows} />}
    </div>
  );
}
