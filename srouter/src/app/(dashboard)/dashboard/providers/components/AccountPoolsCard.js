"use client";

import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import { Badge, Button, Card, Input, Modal, Select } from "@/shared/components";
import { compareModelVersions } from "@/shared/utils/modelVersionSort";

const NO_POOL = "__none__";
const MODELS_PREVIEW_COUNT = 6;

function connectionLabel(connection) {
  return connection?.displayName || connection?.name || connection?.email || connection?.id?.slice(0, 8) || "account";
}

// ── PoolEditorModal ────────────────────────────────────────────
// Create a pool or rename/regroup an existing one. The model group is a
// multi-select over the provider's own available models.
function PoolEditorModal({ isOpen, pool, availableModels, onSubmit, onClose }) {
  const [name, setName] = useState(pool?.name || "");
  const [selected, setSelected] = useState(pool?.models || []);
  const [search, setSearch] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  const filteredModels = useMemo(() => {
    const term = search.trim().toLowerCase();
    return availableModels.filter((model) => !term ||
      model.id.toLowerCase().includes(term) || (model.name || "").toLowerCase().includes(term))
      .sort((a, b) => compareModelVersions(a.id, b.id));
  }, [availableModels, search]);

  const toggleModel = (modelId) => {
    setSelected((prev) => (prev.includes(modelId) ? prev.filter((id) => id !== modelId) : [...prev, modelId]));
  };

  const handleSubmit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError("Name is required");
      return;
    }
    if (selected.length === 0) {
      setFormError("Select at least one model: a pool only serves the models in its group");
      return;
    }
    setSaving(true);
    const result = await onSubmit({ name: trimmedName, models: selected });
    setSaving(false);
    if (!result?.ok) {
      setFormError(result?.error || "Failed to save pool");
      return;
    }
    onClose();
  };

  return (
    <Modal isOpen={isOpen} title={pool ? `Edit Pool: ${pool.name || "pool"}` : "New Account Pool"} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="GPT-5 accounts"
          required
        />

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <label className="text-sm font-medium text-text-main">
              Model group <span className="text-red-500">*</span>
            </label>
            <span className="text-xs text-text-muted">{selected.length} selected</span>
          </div>
          <p className="text-xs text-text-muted">
            Accounts in this pool only serve the selected models. Accounts with no pool stay as fallback for every model.
          </p>
          <Input
            placeholder="Search models..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            icon="search"
          />
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSelected(filteredModels.map((model) => model.id))}>
              Select all
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
              Clear
            </Button>
          </div>
          <div className="max-h-64 overflow-y-auto rounded-lg border border-border bg-background p-2">
            {filteredModels.length === 0 ? (
              <p className="p-2 text-xs text-text-muted">No models match this search.</p>
            ) : (
              filteredModels.map((model) => (
                <label
                  key={model.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-black/[0.04] dark:hover:bg-white/[0.04]"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(model.id)}
                    onChange={() => toggleModel(model.id)}
                    className="size-4 rounded border-gray-300 text-primary focus:ring-primary"
                  />
                  <span className="truncate">{model.id}</span>
                  {model.kind && model.kind !== "llm" && (
                    <Badge variant="default" size="sm">{model.kind}</Badge>
                  )}
                  {model.name && model.name !== model.id && (
                    <span className="truncate text-xs text-text-muted">{model.name}</span>
                  )}
                </label>
              ))
            )}
          </div>
        </div>

        {formError && <p className="text-xs text-red-500">{formError}</p>}

        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={saving}>
            {saving ? "Saving..." : (pool ? "Save" : "Create")}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth disabled={saving}>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

PoolEditorModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  pool: PropTypes.shape({ id: PropTypes.string, name: PropTypes.string, models: PropTypes.array }),
  availableModels: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    kind: PropTypes.string,
  })).isRequired,
  onSubmit: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};

// ── AccountPoolsCard ───────────────────────────────────────────
// Pools group this provider's accounts and declare the models each group may
// serve. Membership is per connection ("Move to pool" on each row).
export default function AccountPoolsCard({
  providerName,
  pools,
  loading,
  error,
  availableModels,
  connections,
  onCreate,
  onUpdate,
  onDelete,
  onMoveConnection,
  onConnectionsChanged,
}) {
  const [editorState, setEditorState] = useState(null); // { pool } | { pool: null }
  const [confirmPool, setConfirmPool] = useState(null);
  const [busyConnectionId, setBusyConnectionId] = useState(null);
  const [actionError, setActionError] = useState("");
  const [pendingDelete, setPendingDelete] = useState(false);

  const membersByPool = useMemo(() => {
    const map = new Map();
    for (const connection of connections || []) {
      const poolId = connection?.providerSpecificData?.accountPoolId;
      if (!poolId) continue;
      if (!map.has(poolId)) map.set(poolId, []);
      map.get(poolId).push(connection);
    }
    return map;
  }, [connections]);

  const unassignedCount = useMemo(
    () => (connections || []).filter((connection) => !connection?.providerSpecificData?.accountPoolId).length,
    [connections],
  );

  const handleMove = async (connectionId, poolId) => {
    setActionError("");
    setBusyConnectionId(connectionId);
    try {
      const result = await onMoveConnection(connectionId, poolId);
      if (!result?.ok) {
        setActionError(result?.error || "Failed to move account");
        return;
      }
      if (onConnectionsChanged) await onConnectionsChanged();
    } finally {
      setBusyConnectionId(null);
    }
  };

  const handleDelete = async () => {
    if (!confirmPool) return;
    setActionError("");
    setPendingDelete(true);
    try {
      const result = await onDelete(confirmPool.id);
      if (!result?.ok) {
        setActionError(result?.error || "Failed to delete pool");
        return;
      }
      setConfirmPool(null);
      if (onConnectionsChanged) await onConnectionsChanged();
    } finally {
      setPendingDelete(false);
    }
  };

  return (
    <>
      <Card>
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">Account Pools</h2>
            <p className="text-xs text-text-muted">
              Each pool serves its own model group. Accounts with no pool stay as fallback for every model.
            </p>
          </div>
          <Button size="sm" icon="add" onClick={() => setEditorState({ pool: null })} className="w-full sm:w-auto">
            New Pool
          </Button>
        </div>

        {!!error && <p className="mb-3 text-xs text-red-500">{error}</p>}
        {!!actionError && <p className="mb-3 text-xs text-red-500">{actionError}</p>}

        {loading ? (
          <div className="h-16 animate-pulse rounded-lg bg-black/5" />
        ) : pools.length === 0 ? (
          <p className="text-sm text-text-muted">
            No pools yet — every {providerName || "provider"} account serves every model.
          </p>
        ) : (
          <div className="flex flex-col divide-y divide-black/[0.03] dark:divide-white/[0.03]">
            {pools.map((pool) => {
              const members = membersByPool.get(pool.id) || [];
              const preview = [...pool.models].sort(compareModelVersions).slice(0, MODELS_PREVIEW_COUNT);
              const hidden = pool.models.length - preview.length;
              return (
                <div key={pool.id} className="flex flex-col gap-1.5 py-2">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="material-symbols-outlined text-base text-text-muted">workspaces</span>
                      <span className="truncate text-sm font-medium">{pool.name}</span>
                      <Badge variant={pool.models.length > 0 ? "primary" : "warning"} size="sm">
                        {pool.models.length > 0 ? `${pool.models.length} model${pool.models.length === 1 ? "" : "s"}` : "serves no models"}
                      </Badge>
                      <Badge variant={members.length > 0 ? "success" : "default"} size="sm">
                        {members.length} account{members.length === 1 ? "" : "s"}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="ghost" icon="edit" onClick={() => setEditorState({ pool })}>Edit</Button>
                      <Button size="sm" variant="ghost" icon="delete" onClick={() => setConfirmPool(pool)}>Delete</Button>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {preview.map((modelId) => (
                      <code
                        key={modelId}
                        className="rounded bg-black/5 px-1.5 py-0.5 font-mono text-[10px] text-text-muted dark:bg-white/5"
                      >
                        {modelId}
                      </code>
                    ))}
                    {hidden > 0 && <span className="text-[10px] text-text-muted">+{hidden} more</span>}
                  </div>

                  {members.length === 0 ? (
                    <p className="text-xs text-text-muted">No accounts in this pool yet.</p>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      {members.map((connection) => (
                        <div key={connection.id} className="flex min-w-0 items-center gap-2 py-0.5">
                          <div className="w-28 shrink-0 sm:w-36">
                            <Select
                              aria-label="Move account to pool"
                              selectClassName="!py-1 !pl-2 !pr-7 !text-xs !rounded-md"
                              value={connection.providerSpecificData?.accountPoolId || NO_POOL}
                              disabled={busyConnectionId === connection.id}
                              onChange={(e) => handleMove(connection.id, e.target.value === NO_POOL ? null : e.target.value)}
                              placeholder="Move to pool"
                              options={[
                                { value: NO_POOL, label: "No pool" },
                                ...pools.map((entry) => ({ value: entry.id, label: entry.name })),
                              ]}
                            />
                          </div>
                          <span data-streamer-sensitive className="truncate text-xs" title={connectionLabel(connection)}>{connectionLabel(connection)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {!loading && pools.length > 0 && (
          <p className="mt-3 text-xs text-text-muted">
            {unassignedCount} account{unassignedCount === 1 ? "" : "s"} without a pool (fallback for every model).
          </p>
        )}
      </Card>

      {editorState && (
        <PoolEditorModal
          isOpen
          pool={editorState.pool}
          availableModels={availableModels}
          onSubmit={({ name, models }) => (
            editorState.pool ? onUpdate(editorState.pool.id, { name, models }) : onCreate({ name, models })
          )}
          onClose={() => setEditorState(null)}
        />
      )}

      <Modal
        isOpen={!!confirmPool}
        onClose={() => setConfirmPool(null)}
        title="Delete Account Pool"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmPool(null)} disabled={pendingDelete}>Cancel</Button>
            <Button variant="danger" onClick={handleDelete} loading={pendingDelete}>Delete</Button>
          </>
        }
      >
        <p className="text-text-muted">
          Delete pool &quot;{confirmPool?.name}&quot;? Its accounts are kept and become fallback for every model.
        </p>
      </Modal>
    </>
  );
}

AccountPoolsCard.propTypes = {
  providerName: PropTypes.string,
  pools: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    models: PropTypes.array,
  })).isRequired,
  loading: PropTypes.bool,
  error: PropTypes.string,
  availableModels: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    kind: PropTypes.string,
  })).isRequired,
  connections: PropTypes.array,
  onCreate: PropTypes.func.isRequired,
  onUpdate: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
  onMoveConnection: PropTypes.func.isRequired,
  onConnectionsChanged: PropTypes.func,
};
