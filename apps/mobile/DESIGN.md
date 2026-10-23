# Native application design context

The native UI is scoped to this directory. The repository root design context
describes Admin and is not the source for this product surface.

- Editable design: https://www.figma.com/design/CNmm1yYpzIE6xF4QaMwaDo
- Primary journey board: 2:2. Review modes and model selector board: 7:17.
- Runtime tokens and layout: src/app.css; porcelain, navy and cobalt with
  separate light/dark semantic values. Preserve safe areas and 44px controls.
- Brand: reuse public/tomverse-logo.png without replacing the symbol.
- Navigation: Chat / Review; Review contains Easy / Professional.
- Chat selects one manual model or server-offered Smart Adaptive. Review Easy
  will select up to three plan-eligible providers; Professional selects models.
  Review is currently a labelled preview and does not execute comparisons.
- Model selection uses a modal sheet, search, provider filter, server catalogue,
  plan labels and an explicit Apply action. Server authorization is authoritative.
- Voice fills an editable composer; it never sends automatically. Unknown send
  outcomes require a server read before another send. Text Send shows no estimate.

Figma is the editable visual reference; implemented behavior and current
verification limits are recorded in README.md and the native test suite.
