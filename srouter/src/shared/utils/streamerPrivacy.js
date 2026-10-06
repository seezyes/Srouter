export const STREAMER_STORAGE_KEY = "srouter.streamerMode";
export const STREAMER_HIDDEN_LABEL = "Hidden in Privacy Mode";

export function readStreamerPreference(storage) {
  try {
    return storage?.getItem(STREAMER_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeStreamerPreference(storage, enabled) {
  try {
    storage?.setItem(STREAMER_STORAGE_KEY, String(enabled === true));
  } catch {
    // Still usable for this page when browser storage is unavailable.
  }
}

export const STREAMER_PREPAINT_SCRIPT = `(function(){try{if(/^\\/dashboard(?:\\/|$)/.test(location.pathname)&&localStorage.getItem(${JSON.stringify(STREAMER_STORAGE_KEY)})==='true'){document.documentElement.classList.add('streamer-mode')}}catch(e){}})();`;

const PRIVATE_BLOCKS = '[data-streamer-sensitive], pre, textarea, input:not([type]), input[type="text"], input[type="email"], input[type="password"], input[type="url"], input[type="search"], input[type="tel"]';
const SKIP_ELEMENTS = "script, style, noscript, .material-symbols-outlined";
const PRIVATE_ATTRIBUTES = ["title", "aria-label", "placeholder", "alt", "href", "label"];

// This is a screen-sharing guard, not data redaction. It never changes form
// values or React text nodes (except native option display labels), so save,
// provider requests and explicit clipboard copies retain the real values.
export function createStreamerPrivacyGuard(doc) {
  let observer = null;
  let active = null;
  const maskedElements = new Set();
  const attributes = new Map();
  const options = new Map();

  function mask(element) {
    if (element.getAttribute("data-streamer-mask") !== "true") {
      element.setAttribute("data-streamer-mask", "true");
    }
    maskedElements.add(element);
  }

  function protectAttribute(element, name) {
    let saved = attributes.get(element);
    const current = element.getAttribute(name);
    const prior = saved?.get(name);
    const explicitSecret = element.closest(`${PRIVATE_BLOCKS}, [data-streamer-private-attributes]`);
    if (prior && current === prior.masked) {
      if (explicitSecret) return;
      element.setAttribute(name, prior.original);
      saved.delete(name);
      return;
    }
    // React may have supplied a new attribute since our last pass.
    saved?.delete(name);
    if (current === null || !explicitSecret) return;
    if (!saved) {
      saved = new Map();
      attributes.set(element, saved);
    }
    const masked = name === "href" ? null : STREAMER_HIDDEN_LABEL;
    saved.set(name, { original: current, masked });
    if (masked === null) element.removeAttribute(name);
    else element.setAttribute(name, masked);
  }

  function protectOption(option) {
    const current = option.textContent;
    const saved = options.get(option);
    if (!option.closest("[data-streamer-sensitive]")) {
      if (saved) restoreOption(option, saved);
      return;
    }
    if (saved && current === saved.masked) {
      protectAttribute(option, "label");
      return;
    }
    if (saved) restoreOption(option, saved);
    const original = option.textContent;
    const valueAttribute = option.getAttribute("value");
    const value = option.value;
    // Keep implicitly valued options stable while changing only their labels.
    if (valueAttribute === null) option.setAttribute("value", value);
    const index = Array.from(option.parentElement?.options || []).indexOf(option);
    const masked = `${STREAMER_HIDDEN_LABEL}${index >= 0 ? ` (${index + 1})` : ""}`;
    options.set(option, { original, masked, value, valueAttribute });
    option.textContent = masked;
    protectAttribute(option, "label");
  }

  function restoreOption(option, saved) {
    if (option.textContent === saved.masked) option.textContent = saved.original;
    if (saved.valueAttribute === null && option.getAttribute("value") === saved.value) {
      // Restore only our own synthesized value attribute.
      option.removeAttribute("value");
    }
    options.delete(option);
  }

  function scanElement(element) {
    if (element.matches(SKIP_ELEMENTS) || element.closest(SKIP_ELEMENTS)) return;
    if (element.tagName === "OPTION") {
      protectOption(element);
      for (const name of PRIVATE_ATTRIBUTES) protectAttribute(element, name);
      return;
    }
    for (const name of PRIVATE_ATTRIBUTES) protectAttribute(element, name);
    // Avoid leaving credential-bearing native datalist suggestions on screen.
    if (element.tagName === "INPUT" && element.hasAttribute("list")) {
      const saved = attributes.get(element) || new Map();
      if (!saved.has("list")) {
        saved.set("list", { original: element.getAttribute("list"), masked: null });
        attributes.set(element, saved);
        element.removeAttribute("list");
      }
    }
    if (element.hasAttribute("data-streamer-sensitive")) mask(element);
    else if (maskedElements.has(element)) {
      element.removeAttribute("data-streamer-mask");
      maskedElements.delete(element);
    }
  }

  function scan(node) {
    const element = node.nodeType === 1 ? node : node.parentElement;
    if (!element) return;
    scanElement(element);
    for (const child of element.querySelectorAll("*")) scanElement(child);
  }

  function restore() {
    for (const element of maskedElements) element.removeAttribute("data-streamer-mask");
    maskedElements.clear();
    for (const [option, saved] of options) restoreOption(option, saved);
    for (const [element, saved] of attributes) restoreAttributes(element, saved);
    attributes.clear();
  }

  function restoreAttributes(element, saved) {
    for (const [name, entry] of saved) {
      if (element.getAttribute(name) === entry.masked) {
        element.setAttribute(name, entry.original);
      }
    }
  }

  function setEnabled(enabled) {
    if (active === enabled) return;
    active = enabled;
    doc.documentElement.classList.toggle("streamer-mode", enabled);
    if (!enabled) {
      observer?.disconnect();
      observer = null;
      restore();
      doc.documentElement.removeAttribute("data-streamer-ready");
      return;
    }
    // Include portals under body, not just the dashboard React subtree.
    observer = new doc.defaultView.MutationObserver(records => {
      const targets = new Set();
      for (const record of records) {
        if (record.type === "childList") {
          targets.add(record.target);
          for (const node of record.addedNodes) targets.add(node);
        } else if (record.type === "characterData") {
          if (record.target.parentElement) targets.add(record.target.parentElement);
        } else targets.add(record.target);
      }
      for (const target of targets) scan(target);
      // Do not retain removed modal/log nodes for the rest of the session.
      for (const element of maskedElements) {
        if (!element.isConnected) {
          element.removeAttribute("data-streamer-mask");
          maskedElements.delete(element);
        }
      }
      for (const [element, saved] of options) {
        if (!element.isConnected) restoreOption(element, saved);
      }
      for (const [element, saved] of attributes) {
        if (!element.isConnected) {
          restoreAttributes(element, saved);
          attributes.delete(element);
        }
      }
    });
    observer.observe(doc.body, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: [...PRIVATE_ATTRIBUTES, "list", "data-streamer-sensitive", "data-streamer-private-attributes"],
    });
    scan(doc.body);
    doc.documentElement.setAttribute("data-streamer-ready", "true");
  }

  return {
    setEnabled,
    dispose() {
      setEnabled(false);
    },
  };
}
