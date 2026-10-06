"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, Card, Input, Select } from "@/shared/components";

export default function VpnPage() {
  const [clients, setClients] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [client, setClient] = useState("FlClashX");
  const [url, setUrl] = useState("");
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState(false);

  const discover = async () => {
    setScanning(true);
    setMessage("");
    try {
      const response = await fetch("/api/network/vpn-clients", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setClients(data.clients || []);
      setMessage(data.note || "Discovery finished. These are listening ports, not verified proxy endpoints.");
    } catch (error) {
      setMessage(error.message || "Discovery failed.");
    } finally { setScanning(false); }
  };

  const addProxy = async () => {
    setSaved(false);
    let endpoint;
    try {
      endpoint = new URL(url.trim());
      if (!["http:", "https:"].includes(endpoint.protocol) ||
        !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
        !endpoint.port || endpoint.username || endpoint.password ||
        endpoint.pathname !== "/" && endpoint.pathname !== "" || endpoint.search || endpoint.hash) throw new Error();
    } catch {
      setMessage("Enter a loopback proxy URL with a port, e.g. http://127.0.0.1:7890. Do not enter a subscription link.");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/proxy-pools", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `${client} local`, proxyUrl: endpoint.href, isActive: true, strictProxy: true, type: "http" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setSaved(true);
      setMessage("Proxy pool created. Assign it to the Srouter accounts you want to route through this client.");
    } catch (error) { setMessage(error.message || "Could not create proxy pool."); }
    finally { setSaving(false); }
  };

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <Card>
        <h2 className="text-lg font-semibold">Local VPN client <span className="text-xs text-amber-500">Preview</span></h2>
        <p className="mt-2 text-sm text-text-muted">
          Use the local proxy exposed by FlClashX, Happ or Incy. Subscriptions and node selection
          stay in that app. Srouter does not import profiles or change system proxy, TUN or client settings.
        </p>
        <p className="mt-2 text-xs text-amber-500">
          The client must be running with an existing HTTP proxy listener. SOCKS-only and TUN-only modes are not supported by this preview.
          Global proxy/TUN remains under the client&apos;s control; its routing can still affect Srouter.
          This integration has not been tested with these apps.
        </p>
        <p className="mt-2 text-xs text-text-muted">
          FlClashX commonly uses HTTP port 7890; Happ documents HTTP port 10809. Actual ports may differ.
          INCY&apos;s local proxy support is unconfirmed. The client&apos;s current node and routing rules apply,
          including any DIRECT rules. Srouter cannot select a separate subscription or node.
        </p>
      </Card>
      <Card>
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-medium">Find running clients</h3>
          <Button size="sm" icon="search" loading={scanning} onClick={discover}>Scan this machine</Button>
        </div>
        <p className="mt-2 text-xs text-text-muted">Scans the machine running Srouter, not a remote browser. Reads process names and local ports only, not subscriptions. Closed apps are not discovered.</p>
        <div className="mt-3 flex flex-col gap-2">
          {clients.map((entry) => (
            <div key={entry.name} className="rounded-lg border border-border p-3 text-sm">
              <span className="font-medium">{entry.name}</span>
              <span className="ml-2 text-xs text-text-muted">{entry.running ? "Running" : "Not detected"}</span>
              <p className="mt-1 text-xs text-text-muted">
                {entry.ports?.length ? `Candidate ports: ${entry.ports.join(", ")}. Check the proxy port in the app; controller/API ports are not proxies.` : "No listening ports found."}
              </p>
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <h3 className="mb-3 font-medium">Connect selected Srouter accounts</h3>
        <div className="flex flex-col gap-3">
          <Select label="Client" value={client} onChange={(event) => { setClient(event.target.value); setSaved(false); }}
            options={["FlClashX", "Happ", "Incy"].map((name) => ({ value: name, label: name }))} />
          <Input label="Local proxy URL (not a subscription)" value={url}
            onChange={(event) => { setUrl(event.target.value); setSaved(false); }} placeholder="http://127.0.0.1:7890" />
          <p className="text-xs text-text-muted">Authenticated local proxies are not supported by this preview. Do not paste credentials or subscription URLs.</p>
          <p className="text-xs text-text-muted">
            Creates a regular proxy pool, without changing the global Srouter proxy or existing account bindings.
            Remove the binding to stop using it. If the VPN app stops, bound requests may fail.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={addProxy} loading={saving} disabled={!url.trim() || saved}>Create proxy pool</Button>
            <Link href="/dashboard/proxy-pools" className="text-sm text-primary">Open Proxy Pools</Link>
          </div>
        </div>
      </Card>
      {message && <p role="status" className="text-sm text-text-muted">{message}</p>}
    </div>
  );
}
