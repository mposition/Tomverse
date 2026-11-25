import { linkViewUrl } from "./web-view-contract";

export type LinkTextPart = { text: string; url?: string };

// ASCII only: answers in CJK languages attach particles and punctuation directly to an address.
const candidate = /https:\/\/[\x21-\x7e]+/gi;
const trailing = /[.,;:!?'"`<>*_~]+$/;

function balanced(text: string) {
  let value = text;
  for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]] as const) {
    while (value.endsWith(close) && value.split(close).length > value.split(open).length) value = value.slice(0, -1);
  }
  return value;
}

/** Splits plain answer text into text and public https links; anything else stays text. */
export function splitLinkText(text: string): LinkTextPart[] {
  const parts: LinkTextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(candidate)) {
    let value = match[0];
    for (let previous = ""; previous !== value;) {
      previous = value;
      value = balanced(value.replace(trailing, ""));
    }
    const target = linkViewUrl(value);
    if (!target) continue;
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    parts.push({ text: value, url: target.href });
    last = match.index + value.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
