---
version: alpha
name: "Tomverse Admin Console"
description: "Evidence-led operations controls using the existing Tomverse admin visual language."
colors:
  primary: "#3B82F6"
  surface-light: "#FFFFFF"
  surface-dark: "#18181B"
  background-dark: "#09090B"
  border-dark: "#3F3F46"
  text-dark: "#FAFAFA"
  muted-dark: "#A1A1AA"
  action-blue: "#3B82F6"
typography:
  latin:
    fontFamily: "Geist, system-ui, sans-serif"
  korean:
    fontFamily: "Noto Sans KR, system-ui, sans-serif"
  code:
    fontFamily: "Geist Mono, ui-monospace, monospace"
rounded:
  control: "0.5rem"
  section: "1rem"
spacing:
  section-gap: "1.5rem"
  compact-gap: "0.75rem"
components:
  admin-page-tabs: {}
  automatic-admission: {}
---

## Overview

This context records the existing Admin Console identity for the AMUX automatic
admission settings work. It does not redesign the public Chat, Review or Studio
surfaces. The audience is the operator using a desktop console, with the same
actions reachable on a narrow screen. Admin supports English and Korean.

The reference is an operations control panel: observed state first, the evidence
that permits an action second, the action last. Separate owner approval, server
configuration and graduation evidence. Avoid presenting an enabled setting as
proof that a worker is running. Do not decorate the screen with invented counts,
activity graphs, live indicators or a new marketing palette.

Runtime ownership remains in the existing CSS and Tailwind tokens (Model B).
This document mirrors their accepted values rather than generating new tokens.
The Figma mockup is an illustrative state, not runtime evidence.

## Colors

Use the existing white/zinc surfaces, zinc text and borders, and blue actions.
The frontmatter mirrors Tailwind white, zinc-950/900/700/50/400 and blue-500.
State colors use the role tokens in `app/globals.css`: `status-switch-on-*` for
enabled settings and `status-success-*` for verified success. Amber denotes a
qualification or an approved exception; it never turns missing measurements
into a successful graduation. Color accompanies a written state.

## Typography

Inherit `--font-ui` and `--font-code` from `app/globals.css`. English uses Geist;
Korean uses Noto Sans KR. Do not import a screen-local font. Use established
admin heading/body/help sizes, comfortable Korean line height, and wrapping
labels. Monospace is for identifiers, not ordinary help text.

## Layout

Reuse the Admin Console shell and `AdminPageTabs`; the settings panel does not
create a second sidebar or page header. Keep natural document scrolling.
Stack the state summary, qualification rows, scope explanation and action area.
At narrow widths, preserve that reading order and wrap the confirmation label;
every action keeps at least a 44px touch target. No fixed viewport-height form.

## Elevation & Depth

Section borders and a slightly raised inset establish hierarchy. No decorative
glows, hero gradients or shadows that imply priority or system health.

## Shapes

Use the existing admin rounded controls and rounded section panels. Keep
interactive elements visibly distinct from passive status labels.

## Components

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
| --- | --- | --- | --- | --- |
| Form | `AmuxV22PromotionControl` with a native labelled checkbox and buttons | v22 API and orchestration policy | activate, stop new admissions | sequencing and browser state checks |
| CRUD | `adminFetch` and the existing v22 activation route | owner authentication, CAS and audit binding | safe GET refresh, explicit owner POST | route and sequencing tests |
| Toast | inline status and `AdminApiFailureNotice` | Admin Console refusal contract | known refusal, unknown outcome, saved but unreadable | render and browser checks |
| Scrollbar | `app/globals.css` and the existing Admin Console scroller | current runtime CSS | document scrolling | narrow viewport inspection |

Navigation, permission filtering and English/Korean labels remain owned by
`adminNavigation`, `adminNavigationLocale` and `AdminLocaleProvider`. The UI
contract is `docs/ui-contracts/admin-console-ia.md`.

## Do's and Don'ts

- Preserve explicit activation confirmation, current audit identity and owner
  reauthentication. A state refresh never resends an uncertain write.
- Distinguish initial read failure, known refusal, conflict, uncertain write,
  and an acknowledged write whose subsequent read failed.
- Keep stop available when the server permits it, including a closed admission
  environment gate. Stopping new admissions is separate from stopping a worker.
- Display measured graduation count/span separately from the bootstrap exception.
- Do not infer capacity, ready-card count, claim status, execution status or
  runtime halt state from the activation-control response.
- Keep legacy promotion and grant tools available until their separate retirement.
