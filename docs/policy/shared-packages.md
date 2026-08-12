# Shared packages and framework purity

Status: active. Enforced by `npm run check:shared-packages` (PR Fast Gate,
static tier), `npm run lint`, and `tests/sharedPackages.test.mjs`.

Release gate: `PACKAGE-01` — *Shared chat packages remain framework-neutral*,
metric `forbidden_nextjs_imports_in_shared_packages = 0`
(`docs/release-gates/tomverse-chat-v1.yaml`). Numbers live in that registry;
this document explains the boundary and how it is held.

## 1. Why the boundary exists

The delivery plan (`docs/policy/tomverse-chat-delivery-plan.md` §4) ships one
chat product to three environments: the Next.js server, a browser bundle
(mobile web and PWA), and a locally bundled Capacitor shell. The failure mode
it is written against is not a build error — it is two implementations of the
same chat drifting apart until fixing a streaming bug means fixing it twice,
differently, and finding out from users which copy was missed.

Shared packages are the mechanism against that. They only work while the
shared half genuinely runs unchanged in all three places. A single import that
resolves in only one of them turns a shared package back into app code that
happens to live in a different directory.

## 2. Layout

```text
packages/
  chat-core/       framework-neutral chat semantics, state machines, stream events
  ui-tokens/       design tokens as plain CSS custom properties
```

The plan's eventual set is `chat-core`, `chat-ui`, `api-client`, `ui-tokens`,
with `apps/mobile` as the Vite + Capacitor shell. They are introduced one at a
time, each seeded with code that is already shared, not with code that might
be. The Next.js app stays at the repository root; moving it to `apps/web` is a
later mechanical migration and is not a prerequisite for anything here.

Extraction is incremental on purpose. §4 of the plan is explicit that the
whole composer and all IME/view behaviour must not move into a package at
once, and that Review behaviour is frozen with regression E2E coverage before
state machines move.

## 3. What a shared package may not reach

`packages/*/src/**` may not import:

| Forbidden | Why |
|---|---|
| `next`, `next/*` | Pins the code to one client. Navigation, images and routing are injected ports. |
| `server-only`, `@/*`, `@prisma/client`, `next-auth` | Reaches the server or the app root. A package that can import the app is not extracted. |
| `node:*` and bare Node builtins (`fs`, `path`, `crypto`, …) | Does not load in a browser bundle. Use Web Crypto/Streams, or take the capability as a port. |
| `@capacitor/*`, `react-native` | Pins the code to the native shell. |

A package also declares **no `dependencies` and no `peerDependencies`**. A
dependency block is how a framework returns without any source file naming it.
`"type": "module"` is required — the mobile shell bundles ESM only.

Anything genuinely platform-specific is injected: the package declares the
port, each client supplies the implementation.

### CSS assets

A package can ship no TypeScript at all — `ui-tokens` is a single stylesheet —
and then neither the ESLint rule nor the tsconfig says anything about it. The
same boundary is enforced by rules that fit CSS:

| Forbidden in `packages/*/src/**.css` | Why |
|---|---|
| Tailwind at-rules (`@theme`, `@apply`, `@utility`, `@custom-variant`, …) | They only resolve inside a Tailwind build, so the file is a fragment of one app's build rather than a shared asset. |
| `@import` of anything outside the package | The importing app owns what else is on the page. |
| `var(--x)` with no fallback, where `--x` is not defined in the file | This is the CSS form of a forbidden global: `var(--font-geist-sans)` loads anywhere and renders as nothing outside the Next.js app that injects it. |

Two more rules are about the app rather than the package, and exist because
either failure would leave every check above passing:

- **the app must import each exported stylesheet** — an extracted asset no
  client loads is not shared, it is dead;
- **the app must not redefine a token the package owns** — a second definition
  is decided by import order, and the tests would still read the package's
  value.

What stays in the web app: `next/font` wiring and the `--font-ui` /
`--font-code` families that resolve its variables, the Korean metric-matched
`@font-face`, the `:lang()` rules, and the whole `@theme inline` block. Naming
a colour in `@theme` is how a Tailwind utility gets generated, which is a build
concern and not a token.

## 4. How it is held

Three independent nets, because each one misses something the others catch.

1. **ESLint `no-restricted-imports`**, scoped to `packages/*/src/**` in
   `eslint.config.mjs`. This is the rule PACKAGE-01 is measured on.
2. **Each package's own `tsconfig.json`** — no `extends`, `"lib": ["ES2022"]`
   with no `dom`, `"types": []`, no `paths`. So `window`, `document`,
   `process` and `Buffer` are unresolved identifiers. ESLint catches a
   forbidden *import*; this catches a forbidden *global*, which no import rule
   can see.
3. **`scripts/check-shared-packages.mjs`**, which reports the metric, runs the
   other two, and applies the CSS rules below.
4. **`scripts/verify-package-build-matrix.mjs`**, which builds the packages
   with a bundler that is not Next.js and runs the result (§6). It counts violations through ESLint's own API rather than
   re-implementing the scan, so the number the gate is measured on and the
   number that fails `npm run lint` are the same number by construction. It
   also refuses to report a count for a package the rule does not actually
   apply to — a rule that stopped applying reports the same `0` a clean
   package does.

## 5. Consumption

Packages ship TypeScript source and no build output. The app that consumes
them compiles them:

- `next.config.ts` lists each package in `transpilePackages`.
- The root `tsconfig.json` maps the specifier to the package's source, so
  `tsc` and the editor read TypeScript rather than a build artefact that does
  not exist.
- npm workspaces (`"workspaces": ["packages/*"]`) create the `node_modules`
  symlink, which is what makes the specifier resolve at runtime for tests and
  scripts.

A package with its own build step would need its own target and module
decisions, and the first thing to diverge would be exactly the chat behaviour
these packages exist to keep identical. If a package ever does need one, that
is a decision to record here first.

## 6. The build matrix, and what PACKAGE-01 still needs

Both of the gate's evidence items now exist:

- **ESLint `no-restricted-imports` report** — `npm run check:shared-packages`
  prints the metric on every PR.
- **Next.js and Vite build matrix** — the Next.js half is `next build`, which
  runs on every PR. The Vite half is `npm run verify:package-build-matrix`.

The Vite half is deliberately not an application. Plan §4 names the build
matrix as one of the three enforcement mechanisms for the *packages*, beside
ESLint and `transpilePackages`; `apps/mobile` is a Phase 3 deliverable with its
own scope, and waiting for it would leave the packages unenforced in between.

What that script does, and why each part is there:

1. **Bundles the packages with Vite**, no plugins, browser target, nothing
   external. `next build` resolves `next/*`, Node builtins and app-injected
   variables perfectly well, so it cannot answer the question the gate asks.
2. **Fails on Vite's warnings, not only on its errors.** A Node builtin in a
   browser build is externalized with a warning and the build *succeeds*,
   shipping an import no browser can resolve. Judging the exit code alone
   would have passed that.
3. **Executes the bundle and checks the values.** Built is not working: a
   bundle that resolved everything and then behaves differently outside
   Next.js is exactly the case worth catching.
4. **Checks the emitted CSS carries its values**, including the
   `prefers-color-scheme` block — a stylesheet that built to nothing satisfies
   a file-exists check.

The entry uses `export *` rather than a named import list. Entry exports are
bundle roots, so this pins every export into the build; a named list was tried
first and was not equivalent — an export it did not mention was tree-shaken
away, and an import that has been shaken away is never resolved, so a
`node:crypto` added to a package built green.

**PACKAGE-01 still stays `pending`, and this document does not change that.**
The gate is approved by a person against recorded evidence
(`approvedBy` / `evidenceRefs` in `docs/release-gates/tomverse-chat-v1.yaml`),
and producing evidence is not the same as recording an approval. What has
changed is that the evidence now exists to point at.

## 7. Adding a package

1. Create `packages/<name>/` with `package.json` (`"type": "module"`, no
   dependencies, `exports` pointing at what it ships). A package with
   TypeScript also needs a standalone `tsconfig.json` matching §4.2; a
   CSS-only package needs no tsconfig.
2. For TypeScript, add the specifier to `transpilePackages` in `next.config.ts`
   and to `paths` in the root `tsconfig.json`. For CSS, `@import` the export
   from `app/globals.css` — the workspace symlink is what resolves it.
3. Run `npm install` so the workspace symlink exists, and commit the lockfile.
4. Seed it by *moving* code that is already shared, and update its callers —
   do not leave a re-export shim in `lib/`. A shim keeps the old import path
   working, which means nothing forces the boundary to be respected and the
   package quietly becomes optional.
5. `npm run check:shared-packages` and `npm run test:unit` cover the rest
   automatically; the tests iterate over whatever is in `packages/`.
