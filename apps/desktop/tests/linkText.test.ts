import assert from "node:assert/strict";
import test from "node:test";
import { splitLinkText } from "../src/link-text";

const links = (text: string) => splitLinkText(text).filter((part) => part.url).map((part) => part.url);

test("Public https addresses in plain answer text become links and the rest stays text", () => {
  assert.deepEqual(splitLinkText("See https://example.com/a?b=1#c for details."), [
    { text: "See " }, { text: "https://example.com/a?b=1#c", url: "https://example.com/a?b=1#c" }, { text: " for details." },
  ]);
  assert.deepEqual(splitLinkText("no links here"), [{ text: "no links here" }]);
  assert.deepEqual(splitLinkText(""), []);
  const text = "a https://example.com/x b https://example.org/y c";
  assert.equal(splitLinkText(text).map((part) => part.text).join(""), text);
  assert.deepEqual(links(text), ["https://example.com/x", "https://example.org/y"]);
});

test("Closing punctuation, brackets and attached CJK text are not part of the link", () => {
  assert.deepEqual(links("(https://example.com/page)"), ["https://example.com/page"]);
  assert.deepEqual(links("Docs: https://example.com/page."), ["https://example.com/page"]);
  assert.deepEqual(links("see [https://example.com/a],"), ["https://example.com/a"]);
  assert.deepEqual(links("https://en.example.org/wiki/Foo_(bar) is fine"), ["https://en.example.org/wiki/Foo_(bar)"]);
  assert.deepEqual(links("**https://example.com/bold**"), ["https://example.com/bold"]);
  assert.deepEqual(links("https://example.com/，然后"), ["https://example.com/"]);
  assert.deepEqual(links("https://example.com/docs을 참고"), ["https://example.com/docs"]);
  assert.equal(splitLinkText("https://example.com/docs을 참고").map((part) => part.text).join(""), "https://example.com/docs을 참고");
});

test("Local, private, credentialed and non-https addresses are never linked", () => {
  for (const text of ["http://example.com/", "https://localhost:3000/", "https://127.0.0.1/", "https://192.168.0.1/admin", "https://user:pw@example.com/",
    "https://printer/", "file:///C:/x", "javascript:alert(1)", "ftp://example.com/"]) {
    assert.deepEqual(links(text), [], text);
    assert.deepEqual(splitLinkText(text), [{ text }], text);
  }
});
