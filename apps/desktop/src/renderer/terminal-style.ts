let installed = false;

/**
 * The window's content policy allows style sheets from the app only, with no inline styles. xterm writes the cell sizes and
 * theme colours into <style> elements it creates, and per-cell colours into style attributes through setAttribute; the policy
 * blocks both. The same styles are allowed through the CSSOM (a constructed style sheet, and `style.cssText`), which the
 * policy does not restrict, so these two hand xterm's styles to those and the policy itself stays as strict as it was.
 */
export function installStyleSheetCompat() {
  if (installed) return;
  installed = true;
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
    if (name.toLowerCase() === "style" && "style" in this) (this as HTMLElement).style.cssText = String(value);
    else setAttribute.call(this, name, value);
  };
  if (typeof CSSStyleSheet === "undefined" || !("adoptedStyleSheets" in document)) return;
  const original = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
  if (!original?.get || !original.set) return;
  const sheets = new Map<HTMLStyleElement, CSSStyleSheet>();
  Object.defineProperty(HTMLStyleElement.prototype, "textContent", {
    configurable: true,
    get() { return original.get!.call(this); },
    set(this: HTMLStyleElement, value: string | null) {
      for (const [element, sheet] of sheets) {
        if (element !== this && !element.isConnected) {
          sheets.delete(element);
          document.adoptedStyleSheets = document.adoptedStyleSheets.filter((item) => item !== sheet);
        }
      }
      let sheet = sheets.get(this);
      if (!sheet) {
        sheet = new CSSStyleSheet();
        sheets.set(this, sheet);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
      sheet.replaceSync(String(value ?? ""));
    },
  });
}
