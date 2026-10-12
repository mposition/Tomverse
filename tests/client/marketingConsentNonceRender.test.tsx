import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketingConsentReservation } from "@/components/analytics/MarketingConsentReservation";
import { StructuredData } from "@/components/seo/StructuredData";
import { servedRawTextElements } from "@/tests/support/servedRawTextElements";

const scriptBody = (html: string) => servedRawTextElements(html).find(element => element.tag === "script")?.body;

test("script body extraction handles HTML casing and malformed closing tags", () => {
  assert.equal(scriptBody('<SCRIPT nonce="test">first()</SCRIPT >'), "first()");
  assert.equal(scriptBody("<script>first()</script\t\n bar>"), "first()");
  assert.equal(scriptBody('<script>first()</script foo="bar">'), "first()");
  assert.equal(scriptBody("<script>first()</script><script>second()</script>"), "first()");
  assert.equal(scriptBody("<!-- <script>fake()</script> --><script>real()</script>"), "real()");
  assert.equal(scriptBody("<script-example>fake()</script-example>"), undefined);
  assert.equal(scriptBody("<template><script>inert()</script></template><script>active()</script>"), "active()");
});

test("raw-text extraction keeps source bytes and parsed attributes for CSP checks", () => {
  const body = '\r\nconst text = "한글 & < >";\r\n';
  const elements = servedRawTextElements(
    `<script nonce="abc>def" data-label="A&amp;B">${body}</script bar>` +
    '<style>\r\nbody { color: blue; }\r\n</style>' +
    '<script nonce="external" src="/client.js"></script>',
  );
  assert.deepEqual(elements, [
    { tag: "script", attributes: { nonce: "abc>def", "data-label": "A&B" }, body },
    { tag: "style", attributes: {}, body: "\r\nbody { color: blue; }\r\n" },
    { tag: "script", attributes: { nonce: "external", src: "/client.js" }, body: "" },
  ]);
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
