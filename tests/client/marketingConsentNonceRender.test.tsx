import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketingConsentReservation } from "@/components/analytics/MarketingConsentReservation";
import { StructuredData } from "@/components/seo/StructuredData";

const scriptBody = (html: string) => html.match(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/i)?.[1];

test("script body extraction handles HTML casing and closing-tag whitespace", () => {
  assert.equal(scriptBody('<SCRIPT nonce="test">first()</SCRIPT >'), "first()");
  assert.equal(scriptBody("<script>first()</script><script>second()</script>"), "first()");
});

test("request-time marketing passes the nonce without changing consent logic", () => {
  const staticMarkup = renderToStaticMarkup(<MarketingConsentReservation />);
  const dynamicMarkup = renderToStaticMarkup(<MarketingConsentReservation nonce="synthetic-request-nonce" />);
  assert.doesNotMatch(staticMarkup, /\bnonce=/);
  assert.match(dynamicMarkup, /nonce="synthetic-request-nonce"/);
  assert.equal(scriptBody(dynamicMarkup), scriptBody(staticMarkup));
  assert.match(scriptBody(dynamicMarkup) ?? "", /localStorage\.getItem/);
  assert.match(scriptBody(dynamicMarkup) ?? "", /v!=="accepted"&&v!=="declined"/);
});

test("request-time structured data uses the same nonce while static markup omits it", () => {
  const data = { "@context": "https://schema.org", name: "Tomverse" };
  const staticMarkup = renderToStaticMarkup(<StructuredData data={data} />);
  const dynamicMarkup = renderToStaticMarkup(<StructuredData data={data} nonce="synthetic-request-nonce" />);
  assert.doesNotMatch(staticMarkup, /\bnonce=/);
  assert.match(dynamicMarkup, /nonce="synthetic-request-nonce"/);
  assert.equal(scriptBody(dynamicMarkup), scriptBody(staticMarkup));
});
