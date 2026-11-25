/**
 * The scripts the host evaluates in a local page, one call at a time, in an isolated world (the page's own scripts cannot see or
 * change them). Nothing is injected ahead of time and nothing stays in the page afterwards: each script reads what it needs and
 * returns plain data. They are source text because a bundled function would not survive being serialised.
 */

const HELPERS = String.raw`
const clip = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const isVisible = (el) => {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
};
const isSecret = (el) => {
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return false;
  const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
  return el.type === "password" || /(^|\s)(cc-|one-time-code|current-password|new-password)/.test(autocomplete);
};
const nameOf = (el) => {
  if (isSecret(el)) return clip(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.name, 160);
  return clip(el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("placeholder"), 160);
};
const uniqueSelector = (el) => {
  const doc = el.ownerDocument;
  const test = (selector) => { try { return doc.querySelectorAll(selector).length === 1 && doc.querySelector(selector) === el; } catch { return false; } };
  if (el.id) { const selector = "#" + CSS.escape(el.id); if (test(selector)) return selector; }
  for (const attribute of ["data-testid", "data-test", "data-qa", "aria-label", "name", "placeholder", "title"]) {
    const value = el.getAttribute(attribute);
    if (value && value.length < 80) {
      const selector = el.localName + "[" + attribute + "=" + JSON.stringify(value) + "]";
      if (test(selector)) return selector;
    }
  }
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== doc.documentElement && parts.length < 8) {
    if (node.id) { parts.unshift("#" + CSS.escape(node.id)); if (test(parts.join(" > "))) return parts.join(" > "); break; }
    let part = node.localName;
    const parent = node.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((child) => child.localName === node.localName);
      if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
    }
    parts.unshift(part);
    if (test(parts.join(" > "))) return parts.join(" > ");
    node = parent;
  }
  return parts.join(" > ");
};
const CONTROLS = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
`;

/** Title, visible text and the controls of the page (each with a selector the agent can click or type into). */
export const readTextScript = `(() => { ${HELPERS}
  const controls = [];
  for (const el of document.querySelectorAll(CONTROLS)) {
    if (controls.length >= 80) break;
    if (!isVisible(el)) continue;
    const kind = el.getAttribute("role") || (el.localName === "input" ? "input " + (el.type || "text") : el.localName);
    const value = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
      ? (isSecret(el) ? " value=(secret field, not read)" : el.value ? " value=" + JSON.stringify(clip(el.value, 60)) : "") : "";
    controls.push("[" + kind + "] " + JSON.stringify(nameOf(el)) + value + (el.disabled ? " (disabled)" : "") + " -> " + uniqueSelector(el));
  }
  return { title: clip(document.title, 200), text: (document.body ? document.body.innerText : "").slice(0, 12000), controls };
})()`;

/** Finds the element, scrolls it to the middle of the tab and says where its centre is and whether something covers it. */
export const locateScript = (selector: string, forTyping: boolean) => `(() => { ${HELPERS}
  let el;
  try { el = document.querySelector(${JSON.stringify(selector)}); } catch { return { error: "The selector is not valid CSS." }; }
  if (!el) return { error: "No element matches the selector. Read the page again for its current controls." };
  const matches = document.querySelectorAll(${JSON.stringify(selector)}).length;
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return { error: "The element has no visible area." };
  if (el.disabled) return { error: "The element is disabled." };
  const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { error: "The element is outside the visible area of the tab." };
  const hit = document.elementFromPoint(x, y);
  if (!hit || (hit !== el && !el.contains(hit))) return { error: "Another element covers it: " + clip(hit ? hit.localName + " " + nameOf(hit) : "nothing", 80) };
  if (${forTyping ? "true" : "false"}) {
    if (isSecret(el)) return { error: "Passwords, one-time codes and card fields are never typed by the agent." };
    const editable = el.matches('textarea,[contenteditable=""],[contenteditable=true]') ||
      (el instanceof HTMLInputElement && ["text", "search", "email", "url", "tel", "number", ""].includes(el.type));
    if (!editable) return { error: "The element is not a text field." };
  }
  return { x, y, matches, tag: el.localName, name: nameOf(el) };
})()`;

/** Focuses the element found by locateScript and puts the caret at its end, or selects what it holds to be replaced. */
export const focusScript = (selector: string, clear: boolean) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  el.focus();
  if (el.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(el);
    if (!${clear ? "true" : "false"}) range.collapse(false);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  } else if (${clear ? "true" : "false"}) {
    el.select();
  } else {
    try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* A number field has no caret to move. */ }
  }
  return document.activeElement === el;
})()`;

/** Where the element is (for a picture) and what it looks like; used on a picked element and on an element named by a selector. */
export const elementBoxScript = (selector: string) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { error: "No element matches the selector." };
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
})()`;

/** Called on a picked node (callFunctionOn): the facts the person's comment will refer to. */
export const describePickedFunction = `function () { ${HELPERS}
  const el = this;
  const r = el.getBoundingClientRect();
  return { tag: el.localName, selector: uniqueSelector(el), text: nameOf(el), url: location.href,
    box: { x: r.left, y: r.top, width: r.width, height: r.height }, page: { x: r.left + scrollX, y: r.top + scrollY } };
}`;
