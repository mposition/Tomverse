import { randomBytes } from "node:crypto";
import { mobileChatCopy } from "@/locales/mobileChat";

export const dynamic = "force-dynamic";

/** A verified App/Universal Link opens the native app before this fallback loads. */
export function GET(request: Request) {
  const forwardedNonce = request.headers.get("x-nonce") ?? "";
  const nonce = /^[A-Za-z0-9+/=]+$/.test(forwardedNonce) ? forwardedNonce : randomBytes(24).toString("base64");
  const copy = mobileChatCopy(request.headers.get("accept-language") ?? "en");
  // No application layout, analytics or external resources on this secret-bearing fallback.
  const script = `const p=new URLSearchParams(location.hash.slice(1));history.replaceState(null,"",location.pathname);const g=p.get("grant");if(p.size===2&&/^[A-Za-z0-9_-]{43}$/.test(g||"")&&/^[A-Za-z0-9_-]{43}$/.test(p.get("codeChallenge")||"")){document.querySelector("input").value=g;setTimeout(()=>{document.querySelector("input").value=""},60000)}`;
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${copy.grantTitle}</title></head><body><main><h1>${copy.grantTitle}</h1><p>${copy.returnFallback}</p><label>${copy.code}<input readonly autocomplete="off" spellcheck="false"></label><p>${copy.codeNote}</p></main><script nonce="${nonce}">${script}</script></body></html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  });
}
