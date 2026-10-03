import assert from "node:assert/strict";
import test from "node:test";

/**
 * A WHATWG `URL` keeps the brackets for an IPv6 host -- `new URL("http://[::1]:3000/").hostname`
 * is `"[::1]"`, never `"::1"` -- so a loopback guard that compares `hostname`
 * to the bare `"::1"` never fires. Three modules were written that way, and
 * the consequence differed per module: `lib/publicUrl.ts` accepted a loopback
 * literal as the app's public origin in production, while `lib/securityEnvironment.ts`
 * and `lib/turnstile.ts` merely took their stricter branch. These tests pin
 * the IPv6 answer against the IPv4 answer the same guard already gave, and
 * against a genuinely remote host that must stay remote.
 */

const withEnvironment = async (overrides, body) => {
  const saved = new Map(
    Object.keys(overrides).map((key) => [key, process.env[key]])
  );
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test("lib/securityEnvironment.ts treats a bracketed IPv6 loopback database host as private", async () => {
  const { getSecurityEnvironmentStatus } = await import(
    "../lib/securityEnvironment.ts"
  );

  // Private host, no sslmode: the host itself is what satisfies the check,
  // exactly as it does for `127.0.0.1`.
  for (const host of ["[::1]:5432", "127.0.0.1:5432", "localhost:5432"]) {
    await withEnvironment(
      {
        NODE_ENV: "production",
        DATABASE_URL: `postgresql://app:secret@${host}/chat`,
        DIRECT_DATABASE_URL: undefined,
      },
      () => {
        assert.equal(
          getSecurityEnvironmentStatus().checks.databaseTransportSecurity,
          true,
          `${host} should count as a private database host`
        );
      }
    );
  }

  // A genuinely remote host still has to prove its transport.
  await withEnvironment(
    {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://app:secret@db.example.com:5432/chat",
      DIRECT_DATABASE_URL: undefined,
    },
    () => {
      assert.equal(
        getSecurityEnvironmentStatus().checks.databaseTransportSecurity,
        false,
        "a remote database host without verify-full must fail the check"
      );
    }
  );
  await withEnvironment(
    {
      NODE_ENV: "production",
      DATABASE_URL:
        "postgresql://app:secret@db.example.com:5432/chat?sslmode=verify-full",
      DIRECT_DATABASE_URL: undefined,
    },
    () => {
      assert.equal(
        getSecurityEnvironmentStatus().checks.databaseTransportSecurity,
        true,
        "a remote database host with verify-full passes on its sslmode"
      );
    }
  );
});

test("lib/publicUrl.ts refuses a bracketed IPv6 loopback origin in production", async () => {
  const { getPublicAppOrigin } = await import("../lib/publicUrl.ts");
  const request = new Request("https://tomverse.app/api/share");

  // The defect: a loopback origin was accepted, and every absolute URL the app
  // generates -- share links, email links -- would have pointed at the
  // server's own loopback. A refused origin falls through to the canonical one.
  for (const origin of [
    "https://[::1]:3000",
    "https://127.0.0.1:3000",
    "https://localhost:3000",
  ]) {
    await withEnvironment(
      {
        NODE_ENV: "production",
        NEXT_PUBLIC_SHARE_BASE_URL: origin,
        PUBLIC_APP_URL: undefined,
        NEXT_PUBLIC_APP_URL: undefined,
      },
      () => {
        assert.equal(
          getPublicAppOrigin(request),
          "https://tomverse.app",
          `${origin} must not be accepted as the public origin in production`
        );
      }
    );
  }

  await withEnvironment(
    {
      NODE_ENV: "production",
      NEXT_PUBLIC_SHARE_BASE_URL: "https://chat.example.com",
      PUBLIC_APP_URL: undefined,
      NEXT_PUBLIC_APP_URL: undefined,
    },
    () => {
      assert.equal(
        getPublicAppOrigin(request),
        "https://chat.example.com",
        "a genuinely remote https origin is still honoured"
      );
    }
  );
});

test("lib/turnstile.ts skips verification for a bracketed IPv6 loopback Host in development", async () => {
  const { verifyGuestTurnstile } = await import("../lib/turnstile.ts");
  const { ChatAccessError } = await import("../lib/chatSecurity.ts");

  const verify = (host) =>
    verifyGuestTurnstile(
      new Request("http://placeholder.invalid/api/chat", {
        headers: { host },
      }),
      undefined
    );

  // A `Host` header carrying an IPv6 literal is bracketed (RFC 7230), so this
  // is the shape a developer browsing `http://[::1]:3000` actually sends.
  // No token is supplied, so anything that does not take the local-development
  // exit throws before reaching Cloudflare.
  await withEnvironment(
    { NODE_ENV: "development", TURNSTILE_SECRET_KEY: "x".repeat(32) },
    async () => {
      for (const host of ["[::1]:3000", "127.0.0.1:3000", "localhost:3000"]) {
        await assert.doesNotReject(
          () => verify(host),
          `${host} should be recognised as local development`
        );
      }

      await assert.rejects(
        () => verify("chat.example.com"),
        (error) => {
          assert.ok(error instanceof ChatAccessError);
          assert.equal(error.code, "TURNSTILE_REQUIRED");
          return true;
        },
        "a remote Host must still require guest verification"
      );
    }
  );
});
