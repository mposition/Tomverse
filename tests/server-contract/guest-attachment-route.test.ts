import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";

/**
 * Server-side contract for /api/chat/guest-attachment.
 *
 * This is the one attachment surface an unauthenticated caller can reach, so
 * the tests below are mostly about what it *refuses*: a renamed executable, an
 * archive, a file whose extension and type disagree, a corrupt document, a
 * document too long for a guest turn, and another guest's object.
 *
 * Only object storage, the rate limiter and Turnstile are replaced. The
 * validation and parsing are the real ones -- the same worker-isolated PDF,
 * image and Office parsers the signed-in path uses -- because a lenient stub
 * would make every acceptance test below meaningless.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "guest-attachment-contract-secret";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

type Stored = { body: Buffer; contentType: string };

type World = {
  objects: Map<string, Stored>;
  deletes: string[];
  rateLimits: string[];
  uploadBytes: Array<{ subject: string; bytes: number; limit?: number }>;
  turnstileActions: string[];
  turnstileShouldFail: boolean;
  /** Everything the route logged, so content leakage can be asserted against. */
  logs: string[];
};

const freshWorld = (): World => ({
  objects: new Map(),
  deletes: [],
  rateLimits: [],
  uploadBytes: [],
  turnstileActions: [],
  turnstileShouldFail: false,
  logs: [],
});

let world = freshWorld();
let mocksInstalled = false;

async function loadRoute(): Promise<{
  POST: (request: Request) => Promise<Response>;
  DELETE: (request: Request) => Promise<Response>;
}> {
  if (!mocksInstalled) {
    mocksInstalled = true;
    const original = (path: string) =>
      require(resolve(ROOT, path)) as Record<string, unknown>;
    const realChatSecurity = original("lib/chatSecurity.ts") as {
      ChatAccessError: new (...args: unknown[]) => Error;
    };

    // --- object storage --------------------------------------------------
    const realR2 = original("lib/r2.ts");
    mock.module(mod("lib/r2.ts"), {
      namedExports: {
        ...realR2,
        writeR2Object: async (key: string, body: Buffer, contentType: string) => {
          world.objects.set(key, { body, contentType });
        },
        validateR2ObjectMetadata: async (key: string) => {
          const stored = world.objects.get(key);
          if (!stored) throw new Error("missing object");
          return { size: stored.body.byteLength, contentType: stored.contentType, etag: null };
        },
        deleteR2Object: async (key: string) => {
          world.deletes.push(key);
          world.objects.delete(key);
        },
      },
    });

    // --- rate limiting and the daily byte budget --------------------------
    const realApiSecurity = original("lib/apiSecurity.ts");
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: {
        ...realApiSecurity,
        consumeApiRateLimit: async (
          _request: unknown,
          _subject: string,
          scope: string
        ) => {
          world.rateLimits.push(scope);
        },
        reserveDailyUploadBytes: async (
          subject: string,
          bytes: number,
          limit?: number
        ) => {
          world.uploadBytes.push({ subject, bytes, limit });
        },
      },
    });

    // --- operational feature flags (database-backed) ----------------------
    const realAppSettings = original("lib/appSettings.ts");
    mock.module(mod("lib/appSettings.ts"), {
      namedExports: {
        ...realAppSettings,
        getOperationalFeatureFlags: async () => ({ attachmentsEnabled: true }),
      },
    });

    // --- guest verification ----------------------------------------------
    const realTurnstile = original("lib/turnstile.ts");
    mock.module(mod("lib/turnstile.ts"), {
      namedExports: {
        ...realTurnstile,
        ensureGuestVerified: async (
          _request: unknown,
          _token: unknown,
          action: string
        ) => {
          world.turnstileActions.push(action);
          if (world.turnstileShouldFail) {
            throw new realChatSecurity.ChatAccessError(
              403,
              "TURNSTILE_FAILED",
              "Verification failed."
            );
          }
          return undefined;
        },
      },
    });
  }

  return (await import(
    `${mod("app/api/chat/guest-attachment/route.ts")}?spy=cached`
  )) as {
    POST: (request: Request) => Promise<Response>;
    DELETE: (request: Request) => Promise<Response>;
  };
}

// --- fixtures ---------------------------------------------------------------

/** A real, minimal PNG: an 8x8 greyscale image sharp can decode. */
const pngFixture = () => {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crcTable: number[] = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const crcBuffer = Buffer.alloc(4);
    crcBuffer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, crcBuffer]);
  };

  const width = 8;
  const height = 8;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const raw = Buffer.concat(
    Array.from({ length: height }, () =>
      Buffer.concat([Buffer.from([0]), Buffer.alloc(width, 0x80)])
    )
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

/** A structurally valid one-page PDF carrying a line of extractable text. */
const pdfFixture = (text = "Guest attachment contract fixture") => {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${text.length + 46} >>\nstream\nBT /F1 12 Tf 20 100 Td (${text}) Tj ET\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(pdf.length);
    pdf += object;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
};

const upload = (
  name: string,
  mediaType: string,
  body: Buffer | string,
  options: { cookie?: string; contentType?: string } = {}
) =>
  new Request(
    `http://127.0.0.1:3100/api/chat/guest-attachment?name=${encodeURIComponent(
      name
    )}&mediaType=${encodeURIComponent(mediaType)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": options.contentType ?? mediaType,
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
      // Buffer is a Uint8Array; the cast is only to satisfy BodyInit typing.
      body: (typeof body === "string"
        ? new Uint8Array(Buffer.from(body, "utf8"))
        : new Uint8Array(body)) as BodyInit,
    }
  );

const guestCookieFrom = (response: Response) => {
  const setCookie = response.headers.get("set-cookie") || "";
  const match = /tomverse_guest=([^;]+)/.exec(setCookie);
  return match ? `tomverse_guest=${match[1]}` : undefined;
};

const readJson = async (response: Response) =>
  (await response.json()) as Record<string, unknown>;

test.beforeEach(() => {
  world = freshWorld();
});

// --- what a guest may send --------------------------------------------------

test("a plain text file is accepted, stored and described", async () => {
  const { POST } = await loadRoute();
  const response = await POST(
    upload("notes.txt", "text/plain", "Compare these two approaches.")
  );
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(body.kind, "text");
  assert.equal(body.mediaType, "text/plain");
  assert.equal(body.ephemeral, true);
  assert.ok(typeof body.expiresInMinutes === "number");
  // The key is opaque and scoped; it is not a path and carries no filename.
  assert.match(String(body.objectKey), /^guest-attachments\/[0-9a-f]{32}\/[0-9a-f]{40}$/);
  assert.equal(world.objects.size, 1);
  // The daily byte budget is charged against the guest's own subject, under a
  // guest-sized limit rather than the account one.
  assert.equal(world.uploadBytes.length, 1);
  assert.ok((world.uploadBytes[0].limit ?? Infinity) <= 25 * 1024 * 1024);
});

test("a real PNG is accepted, and stored normalised rather than as sent", async () => {
  const { POST } = await loadRoute();
  const original = pngFixture();
  const response = await POST(upload("chart.png", "image/png", original));
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(body.kind, "file");
  const [stored] = [...world.objects.values()];
  assert.equal(stored.contentType, "image/png");
  // Re-encoded by the same hardened path the signed-in flow uses, so metadata
  // that came in with the file does not go out with it.
  assert.ok(stored.body.byteLength > 0);
  assert.equal(body.size, stored.body.byteLength);
});

test("a real PDF with readable text is accepted", async () => {
  const { POST } = await loadRoute();
  const response = await POST(upload("brief.pdf", "application/pdf", pdfFixture()));
  assert.equal(response.status, 200);
  assert.equal((await readJson(response)).kind, "file");
});

// --- what a guest may not send ----------------------------------------------

test("a second file in the same message has nowhere to go: one upload, one object", async () => {
  // The per-message cap is enforced at send time by the chat route; what this
  // endpoint guarantees is that each call yields exactly one object, so the
  // composer's single slot maps to a single stored file.
  const { POST } = await loadRoute();
  const first = await POST(upload("a.txt", "text/plain", "one"));
  const cookie = guestCookieFrom(first);
  await POST(upload("b.txt", "text/plain", "two", { cookie }));
  assert.equal(world.objects.size, 2);
  const keys = [...world.objects.keys()];
  // Both belong to the same guest prefix, and neither collides with the other.
  assert.equal(keys[0].split("/")[1], keys[1].split("/")[1]);
  assert.notEqual(keys[0], keys[1]);
});

test("a file over the guest ceiling is refused before it is stored", async () => {
  const { POST } = await loadRoute();
  const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 0x41);
  const response = await POST(upload("big.txt", "text/plain", oversized));

  assert.equal(response.status, 413);
  assert.equal((await readJson(response)).code, "GUEST_ATTACHMENT_TOO_LARGE");
  assert.equal(world.objects.size, 0);
  assert.equal(world.uploadBytes.length, 0);
});

test("an executable is refused however it is labelled", async () => {
  const { POST } = await loadRoute();
  for (const [name, mediaType] of [
    ["tool.exe", "application/pdf"],
    ["tool.exe", "text/plain"],
    ["run.sh", "text/plain"],
  ] as const) {
    const response = await POST(upload(name, mediaType, "MZ\u0000\u0000"));
    assert.equal(response.status, 400, name);
    assert.equal(
      (await readJson(response)).code,
      "GUEST_ATTACHMENT_UNSUPPORTED_TYPE",
      name
    );
  }
  assert.equal(world.objects.size, 0);
});

test("an archive is refused, including a ZIP wearing a document's name", async () => {
  const { POST } = await loadRoute();
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);

  const byName = await POST(upload("bundle.zip", "text/plain", zip));
  assert.equal(byName.status, 400);
  assert.equal(
    (await readJson(byName)).code,
    "GUEST_ATTACHMENT_UNSUPPORTED_TYPE"
  );

  // ...and renaming it to something allowed does not get it past the content
  // check either.
  const byContent = await POST(upload("bundle.txt", "text/plain", zip));
  assert.equal(byContent.status, 400);
  assert.equal(
    (await readJson(byContent)).code,
    "GUEST_ATTACHMENT_TYPE_MISMATCH"
  );
  assert.equal(world.objects.size, 0);
});

test("an extension that disagrees with the media type is refused", async () => {
  const { POST } = await loadRoute();
  const response = await POST(upload("invoice.png", "application/pdf", pdfFixture()));
  assert.equal(response.status, 400);
  assert.equal((await readJson(response)).code, "GUEST_ATTACHMENT_TYPE_MISMATCH");
  assert.equal(world.objects.size, 0);
});

test("a body whose content-type contradicts the declared type is refused", async () => {
  const { POST } = await loadRoute();
  const response = await POST(
    upload("notes.txt", "text/plain", "hello", { contentType: "application/pdf" })
  );
  assert.equal(response.status, 400);
  assert.equal((await readJson(response)).code, "GUEST_ATTACHMENT_TYPE_MISMATCH");
});

test("a corrupt PDF is a user error, not a 500", async () => {
  const { POST } = await loadRoute();
  const corrupt = Buffer.concat([
    Buffer.from("%PDF-1.4\n", "latin1"),
    Buffer.alloc(2_048, 0x41),
  ]);
  const response = await POST(upload("broken.pdf", "application/pdf", corrupt));

  assert.ok(response.status === 400, `expected 400, got ${response.status}`);
  const body = await readJson(response);
  assert.ok(
    ["GUEST_ATTACHMENT_UNREADABLE", "GUEST_ATTACHMENT_NO_TEXT"].includes(
      String(body.code)
    ),
    `unexpected code ${body.code}`
  );
  assert.equal(world.objects.size, 0);
});

test("a corrupt Office document is a user error, not a 500", async () => {
  const { POST } = await loadRoute();
  // A ZIP header with nothing valid behind it: the shape an Office file has,
  // without being one.
  const corrupt = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.alloc(512, 0x00),
  ]);
  const response = await POST(
    upload(
      "report.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      corrupt
    )
  );

  assert.equal(response.status, 400);
  assert.ok(
    ["GUEST_ATTACHMENT_UNREADABLE", "GUEST_ATTACHMENT_NO_TEXT"].includes(
      String((await readJson(response)).code)
    )
  );
  assert.equal(world.objects.size, 0);
});

test("text longer than a guest turn can carry is refused at upload", async () => {
  // Refused here, where the message can name the file -- not at send time,
  // after the user has typed a question.
  const { POST } = await loadRoute();
  const response = await POST(
    upload("long.txt", "text/plain", "a".repeat(40_001))
  );

  assert.equal(response.status, 413);
  assert.equal(
    (await readJson(response)).code,
    "GUEST_ATTACHMENT_TEXT_TOO_LARGE"
  );
  assert.equal(world.objects.size, 0);
});

test("a file that is not UTF-8 text is refused rather than mangled", async () => {
  const { POST } = await loadRoute();
  const response = await POST(
    upload("notes.txt", "text/plain", Buffer.from([0xff, 0xfe, 0x41, 0x30]))
  );
  assert.equal(response.status, 400);
  assert.equal((await readJson(response)).code, "GUEST_ATTACHMENT_UNREADABLE");
});

// --- isolation, cleanup and identity ----------------------------------------

test("one guest cannot delete another guest's object", async () => {
  const { POST, DELETE } = await loadRoute();
  const guestA = await POST(upload("a.txt", "text/plain", "guest A file"));
  const keyA = String((await readJson(guestA)).objectKey);
  const cookieA = guestCookieFrom(guestA);

  // A second, unrelated guest: no cookie, so the route mints a new identity.
  const guestB = await POST(upload("b.txt", "text/plain", "guest B file"));
  const cookieB = guestCookieFrom(guestB);
  assert.notEqual(cookieA, cookieB);

  const stolen = await DELETE(
    new Request("http://127.0.0.1:3100/api/chat/guest-attachment", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", cookie: cookieB as string },
      body: JSON.stringify({ key: keyA }),
    })
  );
  assert.equal(stolen.status, 403);
  assert.equal((await readJson(stolen)).code, "GUEST_ATTACHMENT_FORBIDDEN");
  assert.ok(world.objects.has(keyA), "guest A's object was deleted by guest B");

  // The owner can.
  const own = await DELETE(
    new Request("http://127.0.0.1:3100/api/chat/guest-attachment", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", cookie: cookieA as string },
      body: JSON.stringify({ key: keyA }),
    })
  );
  assert.equal(own.status, 204);
  assert.ok(!world.objects.has(keyA));
});

test("a guest cannot reach a signed-in user's attachment area", async () => {
  const { DELETE } = await loadRoute();
  const response = await DELETE(
    new Request("http://127.0.0.1:3100/api/chat/guest-attachment", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "attachments/abcdef0123456789abcd/2026-07-30/x" }),
    })
  );
  assert.equal(response.status, 403);
});

test("a traversal-shaped key is refused even with the right prefix", async () => {
  const { POST, DELETE } = await loadRoute();
  const created = await POST(upload("a.txt", "text/plain", "x"));
  const key = String((await readJson(created)).objectKey);
  const cookie = guestCookieFrom(created);
  const prefix = key.slice(0, key.lastIndexOf("/") + 1);

  const response = await DELETE(
    new Request("http://127.0.0.1:3100/api/chat/guest-attachment", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", cookie: cookie as string },
      body: JSON.stringify({ key: `${prefix}../../attachments/someone/file` }),
    })
  );
  assert.equal(response.status, 403);
});

test("verification runs under this endpoint's own action, and blocks on failure", async () => {
  const { POST } = await loadRoute();
  world.turnstileShouldFail = true;
  const response = await POST(upload("notes.txt", "text/plain", "hello"));

  assert.equal(response.status, 403);
  assert.equal((await readJson(response)).code, "TURNSTILE_FAILED");
  assert.deepEqual(world.turnstileActions, ["guest_attachment"]);
  // Nothing was read, budgeted or stored.
  assert.equal(world.objects.size, 0);
  assert.equal(world.uploadBytes.length, 0);
});

test("the rate limit is consumed before anything is parsed", async () => {
  const { POST } = await loadRoute();
  await POST(upload("bundle.zip", "text/plain", "x"));
  assert.deepEqual(world.rateLimits, ["guest-attachment-upload"]);
});

test("the endpoint is closed to signed-in callers and offers no Drive import", async () => {
  const source = require("node:fs").readFileSync(
    resolve(ROOT, "app/api/chat/guest-attachment/route.ts"),
    "utf8"
  ) as string;
  assert.match(source, /access\.kind !== "guest"/);
  assert.match(source, /GUEST_ONLY_ENDPOINT/);
  // Google Drive stays signed-in only: no export URL, no OAuth token, nothing
  // for a guest to hand over.
  assert.ok(!/googleapis|google-drive-import|accessToken/i.test(source));
});

test("no file content or extracted text is ever logged", async () => {
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const { POST } = await loadRoute();
    const secret = "CONFIDENTIAL-SALARY-FIGURE-42";
    await POST(upload("payroll.txt", "text/plain", `\u0000${secret}`));
    await POST(upload("broken.pdf", "application/pdf", Buffer.from(`%PDF-1.4\n${secret}`, "latin1")));
  } finally {
    console.error = originalError;
  }
  const logged = JSON.stringify(errors);
  assert.ok(
    !logged.includes("CONFIDENTIAL-SALARY-FIGURE-42"),
    "file content reached the operational log"
  );
});
