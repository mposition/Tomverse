import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

/**
 * §5.6's rules over this agent's own files
 * (docs/policy/trust-safety-compliance-agent.md).
 *
 * The section's point is that the write boundary is checked from the route
 * inward and over the agent's own files -- everything reachable from an entry
 * point without passing one of the six approved shared modules. Task 8 builds
 * the static check that walks those edges; this holds the part that is a
 * property of each file's own text, and it exists because independent review
 * found three of these violated at once: a value import of `@prisma/client`, a
 * `process.env` handed to a function, and a table looked up by a variable key.
 *
 * What this does not do is follow imports. A file that imports a self file is
 * still checked here only on its own text, so this is a floor, not the §5.6
 * check itself.
 */

const SELF_FILES = [
  "lib/trustSafetyBoundsCore.ts",
  "lib/trustSafetyRoundCore.ts",
  "lib/trustSafetyTransaction.ts",
  "lib/trustSafetyObserverRun.ts",
  "lib/trustSafetyObserverPing.ts",
  "lib/trustSafetyObserverRound.ts",
  "lib/trustSafetyActivationCore.ts",
  "lib/trustSafetyActivationStore.ts",
  "lib/trustSafetyAuditEntryVerify.ts",
  "lib/trustSafetyDsrCountsCore.ts",
  "lib/trustSafetyDsrObservation.ts",
  "app/api/internal/trust-safety/observe/route.ts",
  "app/api/admin/agents/trust-safety/activation/route.ts",
];

/**
 * The six boundary modules (ㄴ) names. An import of one of these stops the
 * walk; a seventh is a failure, and adding one is an amendment of the policy.
 */
const BOUNDARY_MODULES = [
  "@/lib/prisma",
  "@/lib/adminAudit",
  "@/lib/auth",
  "next-auth/next",
  "@/lib/adminAuth",
  "@/lib/adminReauthentication",
];

/**
 * (ㄴ') closes the outside-repo specifiers at eight, with the shape each is
 * allowed in. `null` means any import form.
 */
const ALLOWED_SPECIFIERS = new Map([
  ["server-only", null],
  // Type-only, as `lib/adminAudit.ts` imports it.
  ["@prisma/client", "type"],
  // A boundary module and an outside specifier at once, so it is in both lists.
  ["next-auth/next", "getServerSession"],
  // The activation body's `.strict()` schema is how this repository does it.
  ["zod", null],
  // The `Session` type, named by the files that take a session.
  ["next-auth", "type"],
  // E2's panel.
  ["react", null],
  ["next/link", null],
  ["next/navigation", null],
]);

/** The file with its comments removed: the rules are about code, not prose. */
const codeOf = (file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");

/**
 * The file's import statements.
 *
 * `[^;]*?` keeps a match inside one statement. Without it, `import
 * "server-only";` -- which has no `from` -- starts a match that runs on to the
 * next statement's `from`, and the import after it is judged on the wrong
 * text. That is how the first run of this file reported a type-only import as
 * a value import.
 */
const importsOf = (code) => code.match(/^import\s+[^;]*?from\s+"[^"]+";$/gm) ?? [];

test("the self files are the ones this agent wrote", () => {
  // A new lib/trustSafety*.ts that is not listed here would escape every rule
  // below, so the list is checked against the directory rather than trusted.

  const onDisk = readdirSync("lib")
    .filter((name) => name.startsWith("trustSafety") && name.endsWith(".ts"))
    .map((name) => `lib/${name}`);
  for (const file of onDisk) {
    assert.ok(SELF_FILES.includes(file), `${file} is not in the checked list`);
  }
});

test("reflection is not used at all, in any form", () => {
  // §5.6 closes the reflective bypasses by name rather than by path, after
  // five review rounds of enumerating individual functions did not end. The
  // rule is that these names do not appear -- not that one syntax is avoided.
  for (const file of SELF_FILES) {
    const code = codeOf(file);
    for (const name of ["Object", "Reflect", "Proxy", "WebAssembly", "__proto__"]) {
      assert.doesNotMatch(code, new RegExp(`\\b${name}\\b`), `${file}: ${name}`);
    }
    for (const name of ["Function", "eval"]) {
      assert.doesNotMatch(code, new RegExp(`\\b${name}\\s*\\(`), `${file}: ${name}(`);
      assert.doesNotMatch(code, new RegExp(`\\.${name}\\b`), `${file}: .${name}`);
    }
    // `constructor` is banned as a property name and as a destructuring key,
    // both of which reach `Function`. §5.6 exempts one form, and names the
    // mistake of writing the exemption so widely that it narrowed the ban: a
    // class body's own `constructor` declaration.
    assert.doesNotMatch(code, /\.constructor\b/, `${file}: .constructor`);
    assert.doesNotMatch(code, /\{[^}\n]*\bconstructor\s*:/, `${file}: { constructor: }`);
    for (const declaration of code.match(/^\s*constructor\s*\(/gm) ?? []) {
      assert.match(declaration, /^\s{2,}constructor\s*\(/, `${file}: ${declaration.trim()}`);
    }
  }
});

test("a global object appears only as process.env.<literal>", () => {
  // The one allowed form. Putting the object in a variable, passing it as an
  // argument or destructuring it are all failures -- review found the route
  // handing `process.env` to the round, which is the second of those.
  for (const file of SELF_FILES) {
    const code = codeOf(file);
    for (const name of ["globalThis", "global", "self", "window"]) {
      assert.doesNotMatch(code, new RegExp(`\\b${name}\\b`), `${file}: ${name}`);
    }
    const uses = code.match(/\bprocess\b[^\n]*/g) ?? [];
    for (const use of uses) {
      assert.match(
        use,
        /\bprocess\.env\.[A-Z0-9_]+\b/,
        `${file}: process used as something other than process.env.<literal>: ${use.trim()}`,
      );
      assert.doesNotMatch(use, /process\.env[^.]/, `${file}: process.env as a value: ${use.trim()}`);
      assert.doesNotMatch(use, /process\.env\s*\[/, `${file}: computed env key: ${use.trim()}`);
    }
  }
});

test("built-in modules are imported by name, and only the allowed pairs", () => {
  // (ㄱ-1) is an allowlist, not a ban list: an export that is not named here
  // fails by default, including ones a future Node adds. `node:crypto` is
  // allowed whole because it opens no connection.
  const allowed = new Map([
    ["node:crypto", null],
    ["node:net", ["isIP", "isIPv4", "isIPv6"]],
  ]);
  for (const file of SELF_FILES) {
    const code = codeOf(file);
    const imports = importsOf(code);
    for (const statement of imports) {
      const specifier = statement.match(/from\s+"([^"]+)"/)[1];
      const builtin = specifier.startsWith("node:") ? specifier : null;
      if (builtin === null) continue;
      assert.ok(allowed.has(builtin), `${file}: ${builtin} is not an allowed module`);
      // Namespace and default imports hide which export is used, so the
      // allowlist could not be applied to them.
      assert.doesNotMatch(statement, /import\s+\*/, `${file}: namespace import of ${builtin}`);
      assert.match(statement, /import\s*\{/, `${file}: named imports only, from ${builtin}`);
      const names = statement.match(/\{([^}]*)\}/)[1].split(",").map((part) => part.trim());
      const permitted = allowed.get(builtin);
      if (permitted === null) continue;
      for (const name of names) {
        assert.ok(permitted.includes(name), `${file}: ${builtin} export ${name} is not allowed`);
      }
    }
    assert.doesNotMatch(code, /\brequire\s*\(/, `${file}: require`);
    assert.doesNotMatch(code, /\bimport\s*\(/, `${file}: dynamic import`);
  }
});

test("only (ㄴ')'s eight outside specifiers are imported, in their allowed shape", () => {
  // The list is closed: an outside specifier that is not one of the eight
  // fails, which is how `next/server` and the shared admin-route helpers stay
  // out of these files. A type edge is erased at build, so `@prisma/client`
  // and `next-auth` are allowed only in that form -- a value import of
  // `@prisma/client` for its isolation-level enum, which review found, brings
  // the whole package in.
  assert.equal(ALLOWED_SPECIFIERS.size, 8, "eight, as the section counts them");
  for (const file of SELF_FILES) {
    const code = codeOf(file);
    for (const statement of importsOf(code)) {
      const specifier = statement.match(/from\s+"([^"]+)"/)[1];
      if (specifier.startsWith("@/") || specifier.startsWith(".")) {
        // A repository file. Boundary modules stop the walk; the rest are
        // self files and are listed above.
        continue;
      }
      if (specifier.startsWith("node:")) continue;
      assert.ok(
        ALLOWED_SPECIFIERS.has(specifier),
        `${file}: ${specifier} is not one of the eight allowed specifiers`,
      );
      const shape = ALLOWED_SPECIFIERS.get(specifier);
      if (shape === "type") {
        assert.match(
          statement,
          /^import\s+type\s|^import\s*\{\s*type\s/,
          `${file}: ${specifier} must be a type-only import`,
        );
      } else if (shape !== null) {
        const names = (statement.match(/\{([^}]*)\}/)?.[1] ?? "")
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean);
        assert.deepEqual(names, [shape], `${file}: ${specifier} allows only ${shape}`);
      }
    }
  }
  // A side-effect import carries no names, and `server-only` is the one these
  // files make.
  for (const file of SELF_FILES) {
    for (const bare of codeOf(file).match(/^import\s+"([^"]+)";$/gm) ?? []) {
      assert.match(bare, /^import "server-only";$/, `${file}: ${bare}`);
    }
  }
});

test("no seventh boundary module is called", () => {
  // (ㄴ'): widening the boundary is the only way to weaken this check, so the
  // repository modules these files may import are the six, plus this agent's
  // own files. `lib/apiSecurity.ts` and `lib/adminApproval.ts` are the two
  // that an admin route reaches for by habit, and they are not on the list.
  for (const file of SELF_FILES) {
    for (const statement of importsOf(codeOf(file))) {
      const specifier = statement.match(/from\s+"([^"]+)"/)[1];
      if (!specifier.startsWith("@/")) continue;
      const own = SELF_FILES.some((self) => `@/${self.replace(/\.tsx?$/, "")}` === specifier);
      assert.ok(
        own || BOUNDARY_MODULES.includes(specifier),
        `${file}: ${specifier} is neither a self file nor one of the six boundary modules`,
      );
    }
  }
});

test("a property is never reached through a key the file cannot reduce", () => {
  // (ㄱ-2) is fail-closed about this: a key that does not reduce to a literal
  // in the same file is a failure, because a name-based rule cannot judge a
  // name it cannot see. Tables are read through a `Map` instead, which is what
  // the policy suggests and what the bounds table now is.
  for (const file of SELF_FILES) {
    const code = codeOf(file);
    // No space before the bracket: a computed access is written attached, and
    // allowing a gap made this read `as [string, ...string[]]` -- a type
    // annotation -- as an access on an identifier called `as`.
    const accesses = code.match(/[A-Za-z_$][\w$]*\[[^\]]+\]/g) ?? [];
    for (const access of accesses) {
      const key = access.slice(access.indexOf("[") + 1, access.lastIndexOf("]")).trim();
      const reducible = /^\d+$/.test(key) || /^["'][^"']*["']$/.test(key);
      assert.ok(reducible, `${file}: computed access ${access}`);
    }
  }
});

test("only the ping module sends a request, and it sends one", () => {
  for (const file of SELF_FILES) {
    const code = codeOf(file);
    const calls = code.match(/\bfetch\s*\(/g) ?? [];
    const expected = file === "lib/trustSafetyObserverPing.ts" ? 1 : 0;
    assert.equal(calls.length, expected, `${file}: ${calls.length} outgoing calls`);
    for (const name of ["XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "getBuiltinModule"]) {
      assert.doesNotMatch(code, new RegExp(`\\b${name}\\b`), `${file}: ${name}`);
    }
  }
});

test("the raw statements are where §5.6 puts them", () => {
  // The wrapper's setting statements and the writer's one INSERT, and nothing
  // else anywhere. The unsafe variants are refused outright.
  const counts = new Map([
    ["lib/trustSafetyTransaction.ts", 2],
    ["lib/trustSafetyObserverRun.ts", 1],
  ]);
  for (const file of SELF_FILES) {
    const code = codeOf(file);
    const raw = code.match(/\$queryRaw/g) ?? [];
    // The wrapper names the type of its arming row as well, so the count is of
    // the tagged calls: `$queryRaw<...>` followed by a template literal.
    const tagged = code.match(/\$queryRaw(<[^>]*>)?`/g) ?? [];
    assert.equal(tagged.length, counts.get(file) ?? 0, `${file}: ${tagged.length} tagged statements`);
    assert.ok(raw.length >= tagged.length);
    for (const banned of ["$executeRaw", "$executeRawUnsafe", "$queryRawUnsafe"]) {
      assert.ok(!code.includes(banned), `${file}: ${banned}`);
    }
    // §5.4's device also rests on no file moving a deferred check earlier,
    // and that rule is not asserted here: `tests/opsObserverNoSetConstraints`
    // already sweeps every source file in the repository for it, these files
    // included, with a reviewed list of the comments allowed to name it. A
    // second check scoped to this agent would be a second owner of one rule
    // and would drift from it.
  }
});
