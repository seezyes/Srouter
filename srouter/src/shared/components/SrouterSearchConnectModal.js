"use client";

import { useState } from "react";
import Link from "next/link";
import Modal from "./Modal";
import Button from "./Button";
import { getSrouterSearchConnection } from "@/shared/utils/srouterSearchConnection";

export default function SrouterSearchConnectModal({ origin, onClose, dirty, enabled }) {
  const [tab, setTab] = useState("http");
  const [message, setMessage] = useState("");
  const { endpoint, example, agentPrompt } = getSrouterSearchConnection(origin);
  const copy = async (value) => {
    try {
      await navigator.clipboard.writeText(value);
      setMessage("Copied.");
    } catch {
      setMessage("Clipboard unavailable. Select and copy the text manually.");
    }
  };
  return (
    <Modal isOpen onClose={onClose} title="Connect SrouterSearch MCP" size="xl">
      <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto text-sm">
        <p className="text-text-muted">Connect from any MCP-compatible harness. This is a server endpoint, not a browser link.</p>
        {(dirty || !enabled) && <p className="rounded-lg border border-border p-3 text-text-muted">
          {dirty ? "Save your pending settings before connecting." : "Enable SrouterSearch MCP and Save settings before connecting."}
        </p>}
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Connection instructions">
          {[["http", "HTTP setup"], ["config", "Config example"], ["agent", "Prompt for your agent"]].map(([id, label]) => (
            <Button key={id} role="tab" aria-selected={tab === id} variant={tab === id ? "primary" : "outline"}
              onClick={() => { setTab(id); setMessage(""); }}>{label}</Button>
          ))}
        </div>
        <div role="tabpanel">
          {tab === "http" && <div className="flex flex-col gap-3">
            <ol className="list-decimal space-y-2 pl-5">
              <li>Enable MCP and the desired tools, then click <strong>Save settings</strong>.</li>
              <li>In your harness, add an MCP server named <strong>SrouterSearch</strong>. Select <strong>HTTP (streamable)</strong>.</li>
              <li>Use this URL:</li>
            </ol>
            <code className="break-all rounded-lg bg-surface-2 p-3">{endpoint}</code>
            <Button variant="outline" onClick={() => copy(endpoint)}>Copy URL</Button>
            <p>Add the header <code>Authorization: Bearer &lt;SROUTER_API_KEY&gt;</code>. Get an active SRouter key from <Link href="/dashboard/endpoint" className="text-primary">Endpoint &amp; Key</Link>, not from a provider.</p>
            <p className="text-text-muted">If the Add Server form only offers a URL (as in Droid), configure the header through the harness&apos;s supported config or CLI. A URL alone is not enough. See Config example or ask your agent using the prompt.</p>
            <p>Reconnect the harness, then verify that it lists your enabled tools.</p>
            <p className="text-text-muted"><strong>SSE / STDIO:</strong> not supported directly. Localhost HTTP is still HTTP, not STDIO. A STDIO-only harness needs a separate HTTP bridge; none is bundled here.</p>
            <p className="text-text-muted">Localhost works only when the harness runs on this machine. Remote/cloud agents need an explicitly configured reachable endpoint; do not expose your server or put a key in the URL.</p>
          </div>}
          {tab === "config" && <div className="flex flex-col gap-3">
            <p className="text-text-muted">Common mcpServers-style example. The exact schema and secret storage depend on your harness. Merge this server entry, do not replace existing servers.</p>
            <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 text-xs">{example}</pre>
            <Button variant="outline" onClick={() => copy(example)}>Copy config example</Button>
            <p className="text-text-muted">Replace the placeholder securely in your harness. No key is read or copied by this page. This server has no legacy /sse endpoint or required session ID.</p>
          </div>}
          {tab === "agent" && <div className="flex flex-col gap-3">
            <p className="text-text-muted">Paste into the agent running in the harness you want to connect. This prompt contains no real API key.</p>
            <pre className="whitespace-pre-wrap rounded-lg bg-surface-2 p-3 text-xs">{agentPrompt}</pre>
            <Button variant="outline" onClick={() => copy(agentPrompt)}>Copy agent prompt</Button>
          </div>}
        </div>
        {message && <p role="status" className="text-text-muted">{message}</p>}
      </div>
    </Modal>
  );
}
