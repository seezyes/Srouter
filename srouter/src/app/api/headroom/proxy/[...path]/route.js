import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";

export const dynamic = "force-dynamic";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const DASHBOARD_PREFIX = "/api/headroom/proxy";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

async function getTargetBase() {
  const settings = await getSettings();
  const url = settings.headroomUrl || DEFAULT_HEADROOM_URL;
  const target = new URL(url);
  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error("Headroom URL must use http or https");
  }
  return target;
}

function buildTargetUrl(base, path, search) {
  const target = new URL(base);
  target.pathname = `/${path.join("/")}`;
  target.search = search;
  return target;
}

function forwardedHeaders(request, target) {
  const headers = new Headers(request.headers);
  for (const header of headers.keys()) {
    if (HOP_BY_HOP_HEADERS.has(header.toLowerCase())) headers.delete(header);
  }
  headers.delete("host");
  // Never leak viewer credentials to a non-loopback Headroom host
  if (!LOOPBACK_HOSTS.has(target.hostname.replace(/^\[|\]$/g, "").toLowerCase())) {
    headers.delete("cookie");
    headers.delete("authorization");
  }
  return headers;
}

function rewriteDashboardHtml(html) {
  return html.replace(
    /fetch\('(?=\/(?:stats|health|stats-history|transformations\/feed))/g,
    `fetch('${DASHBOARD_PREFIX}`,
  );
}

function cancellableBody(body, signal) {
  if (!body) return null;
  const reader = body.getReader();
  let finished = false;
  let controller;
  const cleanup = () => signal.removeEventListener("abort", abort);
  const cancel = (reason) => {
    if (finished) return Promise.resolve();
    finished = true;
    cleanup();
    return reader.cancel(reason);
  };
  const abort = () => {
    const cancellation = cancel(signal.reason);
    controller.error(signal.reason || new Error("Request aborted"));
    void cancellation.catch(() => {});
  };
  return new ReadableStream({
    start(streamController) {
      controller = streamController;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(streamController) {
      try {
        const { done, value } = await reader.read();
        if (finished) return;
        if (done) {
          finished = true;
          cleanup();
          streamController.close();
        } else {
          streamController.enqueue(value);
        }
      } catch (error) {
        if (finished) return;
        finished = true;
        cleanup();
        streamController.error(error);
      }
    },
    cancel,
  });
}

async function proxy(request, { params }) {
  try {
    const base = await getTargetBase();
    const { search } = new URL(request.url);
    const path = (await params).path || [];
    const target = buildTargetUrl(base, path, search);
    const method = request.method;
    const hasBody = !["GET", "HEAD"].includes(method);

    const response = await fetch(target, {
      method,
      headers: forwardedHeaders(request, target),
      body: hasBody ? request.body : undefined,
      duplex: hasBody ? "half" : undefined,
      redirect: "manual",
      signal: request.signal,
    });

    const headers = new Headers(response.headers);
    for (const header of headers.keys()) {
      if (HOP_BY_HOP_HEADERS.has(header.toLowerCase())) headers.delete(header);
    }
    const body = cancellableBody(response.body, request.signal);

    if (path.join("/") === "dashboard") {
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("text/html")) {
        headers.delete("content-length");
        return new NextResponse(rewriteDashboardHtml(await new Response(body).text()), {
          status: response.status,
          headers,
        });
      }
    }

    return new NextResponse(body, { status: response.status, headers });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;
