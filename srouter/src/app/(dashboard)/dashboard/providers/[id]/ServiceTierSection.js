"use client";

import { useState } from "react";
import { Card, Select } from "@/shared/components";

const OPTIONS = [
  { value: "inherit", label: "None / inherit request" },
  { value: "default", label: "Standard — 1×" },
  { value: "fast", label: "Fast — 2.5× subscription / 2× credits" },
  { value: "ultrafast", label: "Ultrafast — GPT-6 Astra only; 8× / 6×" },
];

function AccountTierRow({ connection, onSaved }) {
  const savedValue = connection.providerSpecificData?.serviceTier || "inherit";
  const [pendingValue, setPendingValue] = useState(null);
  const [error, setError] = useState("");
  const name = connection.displayName || connection.name || connection.email || connection.id;

  const save = async (value) => {
    setPendingValue(value);
    setError("");
    try {
      const response = await fetch(`/api/providers/${encodeURIComponent(connection.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceTier: value === "inherit" ? null : value }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save service tier");
      onSaved(connection.id, data.connection.providerSpecificData?.serviceTier ?? null);
    } catch (failure) {
      setError(failure.message || "Could not save service tier");
    } finally {
      // Failed writes automatically return to the last persisted account value.
      setPendingValue(null);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-surface-2/40 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium"><span data-streamer-sensitive>{name}</span></p>
        {connection.email && connection.email !== name && (
          <p className="truncate text-xs text-text-muted"><span data-streamer-sensitive>{connection.email}</span></p>
        )}
        {pendingValue !== null && <p className="text-xs text-text-muted" role="status">Saving…</p>}
      </div>
      <Select
        className="sm:w-96 sm:shrink-0"
        selectClassName="!py-1.5 !text-xs"
        aria-label="Default service tier for account"
        title="Used only when the request omits service_tier. Availability depends on model, plan, account and region."
        options={OPTIONS}
        value={pendingValue ?? savedValue}
        disabled={pendingValue !== null}
        error={error}
        onChange={(event) => save(event.target.value)}
      />
    </div>
  );
}

export default function ServiceTierSection({ connections, onSaved }) {
  return (
    <Card>
      <details>
        <summary className="cursor-pointer text-lg font-semibold">Service tier</summary>
        <div className="mt-4 space-y-3">
          <p className="text-xs text-text-muted">
            Per-account default, only when the harness omits service_tier. Explicit request values always win.
            None / inherit sends no tier; Standard selects normal usage without a speed opt-in.
            Availability depends on model, plan, account and region.
          </p>
          {connections.map((connection) => (
            <AccountTierRow key={connection.id} connection={connection} onSaved={onSaved} />
          ))}
          {connections.length === 0 && <p className="text-sm text-text-muted">Add an account to set its default tier.</p>}
          <p className="text-xs text-text-muted">
            Fast speeds up GPT-6.1 Sol, GPT-6 Astra, GPT-6 Sol and GPT-6 Luna where available
            (1.5× speed on GPT-5.6/5.5), and draws usage relative to Standard at 2.5× for
            included subscription limits and 2× for purchased credits / Enterprise pay-as-you-go.
            Ultrafast is GPT-6 Astra only (Pro $500 and eligible Enterprise/Edu): 8× included
            subscription, 6× purchased credits / pay-as-you-go. Multipliers describe billing,
            not speed. API dollar rates are not subscription credit rates.{" "}
            <a className="text-primary underline" href="https://developers.openai.com/codex/speed" target="_blank" rel="noopener noreferrer">Codex speed</a>
            {" · "}
            <a className="text-primary underline" href="https://developers.openai.com/codex/pricing" target="_blank" rel="noopener noreferrer">Subscription pricing</a>
            {" · "}
            <a className="text-primary underline" href="https://developers.openai.com/api/docs/guides/ultrafast-mode" target="_blank" rel="noopener noreferrer">Ultrafast eligibility</a>
          </p>
        </div>
      </details>
    </Card>
  );
}
