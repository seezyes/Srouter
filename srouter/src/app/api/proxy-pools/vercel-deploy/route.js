import { NextResponse } from "next/server";
import { createProxyPool } from "@/models";
import { RELAY_TARGET_GUARD_SOURCE } from "@/shared/utils/ssrfGuard.js";

const VERCEL_API = "https://api.vercel.com";

// Relay function source code deployed to Vercel
// Forwards requests to target URL specified in x-relay-target header
const RELAY_FUNCTION_CODE = `
${RELAY_TARGET_GUARD_SOURCE}
export const config = { runtime: "edge" };

export default async function handler(req) {
  const target = req.headers.get("x-relay-target");
  const relayPath = req.headers.get("x-relay-path") || "/";
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

  const rawHeaders = {};
  for (const [k, v] of req.headers.entries()) rawHeaders[k] = v;
  delete rawHeaders["x-relay-target"];
  delete rawHeaders["x-relay-path"];
  delete rawHeaders["host"];

  const response = await fetch(targetUrl, {
    method: req.method,
    headers: rawHeaders,
    body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
    duplex: "half",
  });

  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
}
`;

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

async function pollDeployment(deploymentId, token, scope) {
  while (true) {
    const res = await scope.fetch(`${VERCEL_API}/v13/deployments/${deploymentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new DeploymentError("Failed to check Vercel deployment", res.status);
    const data = await scope.run(() => res.json());
    if (data.readyState === "READY") return data;
    if (data.readyState === "ERROR" || data.readyState === "CANCELED") {
      throw new DeploymentError("Vercel deployment failed");
    }
    await scope.wait(3000);
  }
}

// POST /api/proxy-pools/vercel-deploy
export async function POST(request) {
  const scope = deploymentScope(request.signal, 120000);
  try {
    const body = await scope.run(() => request.json());
    const vercelToken = body.vercelToken;
    const projectName = body.projectName?.trim() || `relay-${Date.now().toString(36)}`;

    if (!vercelToken) {
      return NextResponse.json({ error: "Vercel API token is required" }, { status: 400 });
    }

    // Deploy relay function to Vercel
    const deployRes = await scope.fetch(`${VERCEL_API}/v13/deployments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${vercelToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: projectName,
        files: [
          {
            file: "api/relay.js",
            data: RELAY_FUNCTION_CODE,
          },
          {
            file: "package.json",
            data: JSON.stringify({ name: projectName, version: "1.0.0" }),
          },
          {
            file: "vercel.json",
            data: JSON.stringify({
              rewrites: [{ source: "/(.*)", destination: "/api/relay" }],
            }),
          },
        ],
        projectSettings: {
          framework: null,
        },
        target: "production",
      }),
    });

    if (!deployRes.ok) {
      throw new DeploymentError("Failed to create Vercel deployment", deployRes.status);
    }

    const deployment = await scope.run(() => deployRes.json());
    const deploymentId = deployment.id || deployment.uid;

    // Disable deployment protection (Vercel Authentication)
    const projectId = deployment.projectId || projectName;
    const protectionRes = await scope.fetch(`${VERCEL_API}/v9/projects/${projectId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${vercelToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ssoProtection: null }),
    });
    if (!protectionRes.ok) {
      throw new DeploymentError("Failed to update Vercel deployment protection", protectionRes.status);
    }

    // Poll until deployment is ready
    const ready = await pollDeployment(deploymentId, vercelToken, scope);
    const deployUrl = `https://${ready.url}`;

    // Create proxy pool entry with type vercel
    scope.signal.throwIfAborted();
    // Bound the wait, not the DB transaction: a late commit is still possible.
    // Never infer rollback or delete remote resources when registration is canceled.
    const proxyPool = await scope.run(() => createProxyPool({
      name: projectName,
      proxyUrl: deployUrl,
      type: "vercel",
      noProxy: "",
      isActive: true,
      strictProxy: false,
    }));

    return NextResponse.json({ proxyPool, deployUrl }, { status: 201 });
  } catch (error) {
    // Cleanup remains blocked: no verified operation-bound ownership receipt.
    // The returned deployment/project ids or requested name alone do not prove
    // new ownership. In particular, never delete a reused project or restore
    // its protection settings based on a guessed previous value.
    return NextResponse.json(
      { error: error instanceof DeploymentError ? error.message : "Vercel deployment failed" },
      { status: error instanceof DeploymentError ? error.status : 500 }
    );
  } finally {
    scope.close();
  }
}
