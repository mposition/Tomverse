import { expect, type Locator } from "@playwright/test";

export async function renderedWordLineCount(locator: Locator, word: string) {
  await expect(locator).toContainText(word);
  return locator.evaluate((element, target) => {
    const start = element.textContent!.indexOf(target);
    const end = start + target.length;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const tops = new Set<number>();
    let consumed = 0;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent ?? "";
      for (let index = Math.max(consumed, start); index < Math.min(consumed + text.length, end); index++) {
        const range = document.createRange();
        range.setStart(node, index - consumed);
        range.setEnd(node, index - consumed + 1);
        tops.add(Math.round(range.getBoundingClientRect().top));
      }
      consumed += text.length;
    }
    return tops.size;
  }, word);
}
