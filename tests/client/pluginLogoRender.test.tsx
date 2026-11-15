import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PluginLogo, pluginLogoInitial } from "@/components/plugins/PluginLogo";

test("a catalogued provider renders its logo eagerly at every viewport", () => {
  for (const id of ["buildkite", "circleback", "activecampaign"]) {
    const html = renderToStaticMarkup(<PluginLogo name={id} providerId={id} />);
    assert.match(html, new RegExp(`src="/plugins/providers/${id}.png"`), id);
    assert.doesNotMatch(html, /loading="lazy"/, id);
  }
});

test("a server without a catalogued logo keeps the generic plugin icon", () => {
  const html = renderToStaticMarkup(<PluginLogo name="" />);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /<svg/);
});

test("the fallback initial is the service's first letter or digit", () => {
  assert.equal(pluginLogoInitial("buildkite"), "B");
  assert.equal(pluginLogoInitial("  circleback"), "C");
  assert.equal(pluginLogoInitial("1Password"), "1");
  assert.equal(pluginLogoInitial("깃허브"), "깃");
  assert.equal(pluginLogoInitial("  "), "");
});
