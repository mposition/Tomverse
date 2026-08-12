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

## 4. How it is held

Three independent nets, because each one misses something the others catch.

1. **ESLint `no-restricted-imports`**, scoped to `packages/*/src/**` in
   `eslint.config.mjs`. This is the rule PACKAGE-01 is measured on.
2. **Each package's own `tsconfig.json`** — no `extends`, `"lib": ["ES2022"]`
   with no `dom`, `"types": []`, no `paths`. So `window`, `document`,
   `process` and `Buffer` are unresolved identifiers. ESLint catches a
   forbidden *import*; this catches a forbidden *global*, which no import rule
   can see.
3. **`scripts/check-shared-packages.mjs`**, which reports the metric and runs
   the other two. It counts violations through ESLint's own API rather than
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

## 6. What PACKAGE-01 still needs

The gate lists two pieces of evidence. Only one of them exists today:

- **ESLint `no-restricted-imports` report** — satisfied. `npm run
  check:shared-packages` prints the metric on every PR.
- **Next.js and Vite build matrix** — *not yet*. There is no Vite application
  in the repository, so there is nothing to build the packages into. The
  standalone `tsc` project in §4.2 is a stronger check than nothing but it is
  not a bundler, and calling it a build matrix would misreport the gate. This
  half lands with `apps/mobile` (plan Phase 3).

PACKAGE-01 therefore stays `pending`. The mechanism is in place and measured;
the evidence set is not complete.

## 7. Adding a package

1. Create `packages/<name>/` with `package.json` (`"type": "module"`, no
   dependencies, `exports` pointing at `./src/index.ts`) and a standalone
   `tsconfig.json` matching §4.2.
2. Add the specifier to `transpilePackages` in `next.config.ts` and to `paths`
   in the root `tsconfig.json`.
3. Run `npm install` so the workspace symlink exists, and commit the lockfile.
4. Seed it by *moving* code that is already shared, and update its callers —
   do not leave a re-export shim in `lib/`. A shim keeps the old import path
   working, which means nothing forces the boundary to be respected and the
   package quietly becomes optional.
5. `npm run check:shared-packages` and `npm run test:unit` cover the rest
   automatically; the tests iterate over whatever is in `packages/`.
