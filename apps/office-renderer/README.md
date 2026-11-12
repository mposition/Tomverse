# Office renderer

The image the office renderer service runs: Gotenberg plus the Hangul (HWP 5.x,
HWPX) filter and Korean fonts. What it is for and how it is wired to the app:
`docs/policy/generated-artifacts.md` section 15. How to deploy it on Railway:
`docs/ops/office-renderer.md`.

This directory holds no application code. It is built only by the renderer
service, never by the app's own build.
