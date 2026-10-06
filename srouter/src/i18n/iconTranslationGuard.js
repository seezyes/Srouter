const ICON_SELECTOR = ".material-symbols-outlined";
let observer;

function protectIcons(root) {
  if (root.nodeType !== 1) return;
  const icons = [...root.querySelectorAll(ICON_SELECTOR)];
  if (root.matches(ICON_SELECTOR)) icons.unshift(root);
  for (const icon of icons) {
    if (icon.getAttribute("translate") !== "no") icon.setAttribute("translate", "no");
    if (!icon.classList.contains("notranslate")) icon.classList.add("notranslate");
    if (icon.getAttribute("data-i18n-skip") !== "true") icon.setAttribute("data-i18n-skip", "true");
  }
}

// Run after React hydration, before waiting for the locale dictionary. Protect
// only ligature glyphs, not their surrounding buttons, labels or tooltips.
export function initIconTranslationGuard() {
  if (typeof document === "undefined" || !document.body) return;
  protectIcons(document.body);
  if (observer) return;

  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        protectIcons(mutation.target);
      } else {
        for (const node of mutation.addedNodes) protectIcons(node);
      }
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
  });
}
