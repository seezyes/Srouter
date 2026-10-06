import os from "node:os";
import path from "node:path";
import { ZCODE_CONFIG } from "../config/zcodeConfig.js";

export function getZCodeBrowserOptions(proxyOptions = null, env = process.env, platform = os.platform()) {
  if (proxyOptions?.strictProxy && !proxyOptions.connectionProxyUrl) {
    throw new Error("ZCode browser verification needs a direct proxy in strict mode");
  }
  const options = { headless: true, args: ["--disable-dev-shm-usage", "--window-size=1280,720"] };
  // No author-specific Linux cache path. Use an isolated installed browser,
  // or an explicitly configured executable, on every supported OS.
  if (env.ZCODE_BROWSER_EXECUTABLE) {
    if (!path.isAbsolute(env.ZCODE_BROWSER_EXECUTABLE)) throw new Error("ZCODE_BROWSER_EXECUTABLE must be absolute");
    options.executablePath = env.ZCODE_BROWSER_EXECUTABLE;
  } else {
    options.channel = platform === "win32" ? "msedge" : "chrome";
  }
  if (proxyOptions?.connectionProxyEnabled && proxyOptions.connectionProxyUrl) {
    const proxy = new URL(proxyOptions.connectionProxyUrl);
    if (!["http:", "https:", "socks5:"].includes(proxy.protocol)) throw new Error("Unsupported ZCode browser proxy");
    options.proxy = { server: `${proxy.protocol}//${proxy.hostname}${proxy.port ? `:${proxy.port}` : ""}` };
    if (proxy.username) options.proxy.username = decodeURIComponent(proxy.username);
    if (proxy.password) options.proxy.password = decodeURIComponent(proxy.password);
  }
  return options;
}

// Request-local browser contexts, no persistent profile or saved logins.
export async function solveZCodeCaptcha(log, proxyOptions = null, signal = null) {
  if (signal?.aborted) return null;
  let browser;
  const abort = () => { browser?.close().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch(getZCodeBrowserOptions(proxyOptions));
    if (signal?.aborted) return null;
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US" });
    await context.addInitScript(({ region, prefix }) => {
      window.AliyunCaptchaConfig = { region, prefix };
    }, { region: ZCODE_CONFIG.captchaRegion, prefix: ZCODE_CONFIG.captchaPrefix });
    const page = await context.newPage();
    await page.goto(ZCODE_CONFIG.website, { waitUntil: "domcontentloaded", timeout: ZCODE_CONFIG.captchaTimeoutMs });
    return await page.evaluate(({ sceneId, timeoutMs }) => new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), timeoutMs);
      function start() {
        if (!window.initAliyunCaptcha) { clearTimeout(timeout); resolve(null); return; }
        window.initAliyunCaptcha({
          SceneId: sceneId, mode: "popup",
          getInstance: (instance) => instance.startTracelessVerification?.(),
          success: (param) => { clearTimeout(timeout); resolve(param); },
          fail: () => { clearTimeout(timeout); resolve(null); },
          onError: () => { clearTimeout(timeout); resolve(null); },
        });
      }
      if (window.initAliyunCaptcha) start();
      else {
        const script = document.createElement("script");
        script.src = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
        script.onload = start;
        script.onerror = () => { clearTimeout(timeout); resolve(null); };
        document.head.appendChild(script);
      }
    }), { sceneId: ZCODE_CONFIG.captchaSceneId, timeoutMs: ZCODE_CONFIG.captchaTimeoutMs });
  } catch {
    // Browser/OS/proxy error messages can contain local paths or credentials.
    log?.warn?.("CAPTCHA", "ZCode browser verification unavailable");
    return null;
  } finally {
    signal?.removeEventListener("abort", abort);
    await browser?.close().catch(() => {});
  }
}
