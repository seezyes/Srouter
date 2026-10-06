import { NextResponse } from "next/server";
import { createProxyPool } from "@/models";
import { RELAY_TARGET_GUARD_SOURCE } from "@/shared/utils/ssrfGuard.js";

const DENO_V2_API = "https://api.deno.com/v2";

const DENO_RELAY_CODE = `Deno.serve(async (request) => {
  ${RELAY_TARGET_GUARD_SOURCE}
  const target = request.headers.get("x-relay-target");
  const relayPath = request.headers.get("x-relay-path") || "/";

  if (!target) {
    return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  let targetUrl;
  try {
    const base = target.replace(/\\/+$/, "");
    const path = relayPath.startsWith("/") ? relayPath : "/" + relayPath;
    targetUrl = base + path;
    assertTrustedTarget(targetUrl);
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: { "content-type": "application/json" } });
  }
  const newHeaders = new Headers(request.headers);
  newHeaders.delete("x-relay-target");
  newHeaders.delete("x-relay-path");
  newHeaders.delete("host");

  const init = {
    method: request.method,
    headers: newHeaders,
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  try {
    const response = await fetch(targetUrl, init);
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
});`;

class DeploymentError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

// One deadline covers fetch headers, response bodies and polling sleeps.
function deploymentScope(requestSignal, maxMs) {
  const controller = new AbortController();
  const deadline = Date.now() + maxMs;
  const timeout = () => controller.abort(new DeploymentError("Deployment timed out", 504));
  const disconnect = () => controller.abort(new DeploymentError("Deployment canceled", 499));
  const timer = setTimeout(timeout, maxMs);
  requestSignal?.addEventListener("abort", disconnect, { once: true });
  if (requestSignal?.aborted) disconnect();
  const run = async (operation) => {
    if (Date.now() >= deadline && !controller.signal.aborted) timeout();
    controller.signal.throwIfAborted();
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([aborted, Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation();
      })]);
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
    }
  };
  return {
    signal: controller.signal,
    run,
    fetch: (url, options) => run(() => fetch(url, { ...options, signal: controller.signal })),
    wait: async (ms) => {
      let sleep;
      try {
        await run(() => new Promise((resolve) => { sleep = setTimeout(resolve, ms); }));
      } finally {
        clearTimeout(sleep);
      }
    },
    close: () => {
      clearTimeout(timer);
      requestSignal?.removeEventListener("abort", disconnect);
    },
  };
}

export async function POST(request) {
  const scope = deploymentScope(request.signal, 60000);
  try {
    const body = await scope.run(() => request.json());
    const denoToken = body.denoToken?.trim();
    const orgDomain = body.orgDomain?.trim();
    const projectName = body.projectName?.trim() || `relay-${Date.now().toString(36)}`;

    if (!orgDomain) {
      return NextResponse.json({ error: "Organization domain is required" }, { status: 400 });
    }

    if (!denoToken) {
      return NextResponse.json({ error: "Deno Deploy API token is required" }, { status: 400 });
    }

    const headers = {
      Authorization: `Bearer ${denoToken}`,
      "Content-Type": "application/json",
    };

    const createAppRes = await scope.fetch(`${DENO_V2_API}/apps`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: projectName,
        labels: { "custom.kind": "srouter-relay" },
        config: {
          install: "deno install",
          runtime: {
            type: "dynamic",
            entrypoint: "main.ts",
          },
        },
      }),
    });

    if (!createAppRes.ok) {
      if (createAppRes.status === 409) {
        return NextResponse.json(
          { error: "App already exists. Choose a different name." },
          { status: 409 }
        );
      }
      throw new DeploymentError("Failed to create Deno app", createAppRes.status);
    }

    const app = await scope.run(() => createAppRes.json());
    const appId = app.id;

    const deployRes = await scope.fetch(`${DENO_V2_API}/apps/${appId}/deploy`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        assets: {
          "main.ts": {
            kind: "file",
            content: DENO_RELAY_CODE,
            encoding: "utf-8",
          },
        },
      }),
    });

    if (!deployRes.ok) {
      throw new DeploymentError("Deno deployment failed", deployRes.status);
    }

    const revision = await scope.run(() => deployRes.json());
    const revisionId = revision.id;

    let status = revision.status;
    while (status === "queued" || status === "building") {
      await scope.wait(2000);
      const statusRes = await scope.fetch(`${DENO_V2_API}/revisions/${revisionId}`, {
        headers: { Authorization: `Bearer ${denoToken}` },
      });
      if (!statusRes.ok) throw new DeploymentError("Failed to check Deno deployment", statusRes.status);
      const statusData = await scope.run(() => statusRes.json());
      status = statusData.status;
    }

    if (status !== "succeeded") {
      throw new DeploymentError("Deno deployment failed");
    }
    scope.signal.throwIfAborted();

    const orgSlug = orgDomain.split(".")[0];
    const deployUrl = `https://${projectName}.${orgSlug}.deno.net`;

    // Bound the wait, not the DB transaction: a late commit is still possible.
    // Never infer rollback or delete the remote app when registration is canceled.
    const proxyPool = await scope.run(() => createProxyPool({
      name: projectName,
      proxyUrl: deployUrl,
      type: "deno",
      noProxy: "",
      isActive: true,
      strictProxy: false,
    }));

    return NextResponse.json({ proxyPool, deployUrl }, { status: 201 });
  } catch (error) {
    // Cleanup is blocked until the provider's create-only contract and an
    // operation-bound ownership receipt are verified. An id, slug, HTTP 201,
    // or the shared custom.kind label alone cannot prove this request created
    // the app. Never delete a possibly reused/foreign app, including on DB
    // failure or a late response after cancellation.
    return NextResponse.json(
      { error: error instanceof DeploymentError ? error.message : "Deno deployment failed" },
      { status: error instanceof DeploymentError ? error.status : 500 }
    );
  } finally {
    scope.close();
  }
}