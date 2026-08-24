"use client";

/**
 * Last-resort boundary for failures in the root layout itself.
 *
 * This file replaces the root layout when active, so per the Next 16 docs it
 * must render its own <html>/<body> and cannot rely on the app's global
 * stylesheet or the theme class. Styles are therefore inline, and both colour
 * schemes are handled with `color-scheme` plus neutral values that stay legible
 * either way. No `metadata` export is possible in a Client Component, so the
 * document title is set with React's <title>. It is English for the same
 * reason: `LanguageProvider` lives in the layouts this file replaces, so there
 * is no locale to read here.
 *
 * The prop is `retry`. Next passed `unstable_retry` in v16.2.0 and renamed it
 * in v16.3.0; the runtime passes `error`, `reset` and `retry` and nothing
 * else, so the old name destructured `undefined` and the retry button threw a
 * `TypeError` of its own -- in the boundary that has nothing beneath it to
 * catch that. Pinned by `tests/errorBoundaryProps.test.mjs`.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          colorScheme: "light dark",
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          padding: "2rem 1.5rem",
          textAlign: "center",
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        }}
      >
        <title>Something went wrong — Tomverse</title>
        <h1 style={{ fontSize: "1.25rem", fontWeight: 800, margin: 0 }}>
          Something went wrong
        </h1>
        <p style={{ maxWidth: "28rem", lineHeight: 1.6, margin: 0 }}>
          We hit an unexpected error while loading Tomverse. Your account and
          conversations are unaffected.{" "}
          {/* A digest only exists for a server-side throw. The old copy told
              the reader to quote the reference "not available", which reads as
              an instruction to repeat those two words to support. */}
          {error.digest ? (
            <>
              Quote reference{" "}
              <span
                style={{ fontFamily: "ui-monospace, monospace", fontWeight: 700 }}
              >
                {error.digest}
              </span>{" "}
              if you contact support.
            </>
          ) : (
            "Contact support if it keeps happening."
          )}
        </p>
        <button
          type="button"
          onClick={() => retry()}
          style={{
            marginTop: "0.5rem",
            padding: "0.55rem 1.1rem",
            borderRadius: "0.75rem",
            border: "1px solid currentColor",
            background: "transparent",
            font: "inherit",
            fontWeight: 800,
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
