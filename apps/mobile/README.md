# `apps/mobile` — locally bundled Capacitor shell (spike)

A readiness spike, not the app. It exists to answer one question with a build
rather than an opinion: **do the shared packages run in a browser bundle that
Next.js did not produce?**

It renders a diagnostic screen and nothing else. There is no sign-in, no
request to the API, no conversation, no composer.

## Why it stops there

`docs/policy/tomverse-chat-delivery-plan.md §4` names four packages —
`chat-core`, `chat-ui`, `api-client`, `ui-tokens` — and `apps/mobile` as the
Vite + Capacitor shell built on top of them. Two of the four exist. `chat-ui`
and `api-client` do not.

So a chat screen here could only be a copy of `components/chat/*`, and a copy is
precisely the failure the packages exist to prevent: "two implementations of the
same chat drifting apart until fixing a streaming bug means fixing it twice"
(`docs/policy/shared-packages.md §1`). The same reasoning rules out an
authenticated screen — the mobile bearer path in
`docs/policy/tomverse-chat-mobile-authentication.md` is a decision, not yet an
implementation, and a shell that authenticated some other way would be a second
answer to it.

## What it verifies

Run against the built bundle, in a browser, with the values read back:

| Check | What a failure would mean |
|---|---|
| `@tomverse/chat-core` resolves and evaluates | The package needs Next.js to compile it |
| A finished answer reports `normal` | The package built but behaves differently outside Next.js |
| A truncated answer reports `incomplete` / `length` | Same, on the path that matters to a user |
| `@tomverse/ui-tokens` carries its values | The stylesheet compiled to nothing, or needs Tailwind |
| Brand accent tokens resolve | A token depends on a variable only `app/globals.css` injects |

The last two are read with `getComputedStyle`, not by checking the file exists;
`scripts/verify-package-build-matrix.mjs` explains why that distinction matters.

## Commands

```bash
npm run build:mobile-shell          # vite build -> apps/mobile/dist
npm run check:capacitor-local-bundle # fails on server.url / cleartext / allowNavigation
npm --workspace @tomverse/mobile run typecheck
npm --workspace @tomverse/mobile run preview
```

## Native projects are not committed

`ios/` and `android/` are generated, not authored:

```bash
npm --workspace @tomverse/mobile exec cap add android
npm --workspace @tomverse/mobile exec cap add ios      # macOS + Xcode only
npm run build:mobile-shell && npm --workspace @tomverse/mobile run cap:sync
```

Neither has been generated or built in this repository. Verified requirements,
read from the Capacitor 8.5.0 packages themselves:

| | Value | Source |
|---|---|---|
| iOS deployment target | 15.0 | `@capacitor/ios` `Capacitor.podspec`, `scripts/pods_helpers.rb` |
| Android `minSdk` | 24 | `@capacitor/android` `capacitor/build.gradle` |
| Android `compileSdk` / `targetSdk` | 36 | same |
| Android Gradle Plugin | 8.13.0 | same |
| Java source/target | 21 | same |

`targetSdk 36` matches what Google Play requires of new apps and updates from
2026-08-31, so the default needs no override.

## The origin this shell produces

Capacitor's own configuration reference gives the defaults this config keeps:

| Platform | Option | Default | Resulting origin |
|---|---|---|---|
| iOS | `server.iosScheme` | `capacitor` | `capacitor://localhost` |
| Android | `server.androidScheme` | `https` | `https://localhost` |

`lib/requestOrigin.ts` accepts neither: the first fails on protocol, the second
on the host allowlist, which excludes `localhost`. So every non-`GET` request
from this shell would be answered `403 INVALID_REQUEST_ORIGIN` by the
mutation-origin check in `proxy.ts` before reaching a route. That is a real gap,
recorded in
`.github/audits/2026-08-30-native-mobile-readiness.md` rather than patched here —
widening the check is an authentication-boundary decision, not a spike.
