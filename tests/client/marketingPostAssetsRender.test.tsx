import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";

import { MarketingPostAssets } from "@/components/admin/AdminMarketingPanel";
import { adminMarketingMessages } from "@/lib/adminMessages/marketing";

/**
 * The files a queued or published post carries, executed.
 *
 * Same technique as the other client render tests: the component is called and
 * the returned element tree walked, so the link each file gets is read directly.
 */

const propsOf = (node: ReactNode, found: Record<string, unknown>[] = []) => {
  if (node === null || node === undefined || typeof node === "boolean") return found;
  if (typeof node === "string" || typeof node === "number") return found;
  if (Array.isArray(node)) {
    for (const child of node) propsOf(child, found);
    return found;
  }
  const element = node as { props?: Record<string, unknown> };
  if (element.props) {
    found.push(element.props);
    propsOf(element.props.children as ReactNode, found);
  }
  return found;
};

const textOf = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const element = node as { props?: { children?: ReactNode } };
  return element.props ? textOf(element.props.children) : "";
};

const previewLinks = (node: ReactNode) =>
  propsOf(node).filter((props) => props["data-testid"] === "marketing-asset-preview-link");

const IDS = [
  "media-20261101-review-compare-en-short",
  "media-20261101-review-compare-ko-short",
];

for (const locale of ["en", "ko"] as const) {
  const m = adminMarketingMessages[locale] as unknown as Record<string, string>;

  test(`${locale}: each attached file opens the Assets tab's preview`, () => {
    const tree = MarketingPostAssets({ assetIds: IDS, m });
    const links = previewLinks(tree);
    assert.deepEqual(
      links.map((link) => link.href),
      IDS.map((id) => `/api/admin/marketing/assets/${id}/preview`),
    );
    for (const link of links) {
      assert.equal(link.target, "_blank");
      assert.equal(link.rel, "noopener noreferrer");
    }
    const text = textOf(tree);
    assert.ok(text.includes(m.postAssets));
    for (const id of IDS) assert.ok(text.includes(id));
  });

  test(`${locale}: a post with no files says so instead of showing nothing`, () => {
    for (const assetIds of [[], null, undefined, "media-x", [""], [3]]) {
      const tree = MarketingPostAssets({ assetIds, m });
      assert.equal(previewLinks(tree).length, 0);
      assert.equal(textOf(tree).trim(), m.postNoAssets);
    }
  });
}

test("both languages carry the attached-files lines", () => {
  for (const locale of ["en", "ko"] as const) {
    const m = adminMarketingMessages[locale] as unknown as Record<string, string>;
    assert.ok(m.postAssets && m.postAssets.length > 0);
    assert.ok(m.postNoAssets && m.postNoAssets.length > 0);
  }
});
