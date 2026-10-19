# The Scout's image (docs/policy/product-research-agent.md §10, §13): the daily
# walker (`Product Research Scout`). It holds Chromium, the renderers the walker
# exercises, the local S0 probe script, and no credential.
#
# The base is Playwright's own image at the version package-lock.json pins, so
# the browsers it carries are the ones @playwright/test expects. It runs as the
# image's unprivileged `pwuser`: Chromium refuses its sandbox to root, and a
# probe that measured a sandbox by turning it off would measure nothing.
#
# No ARG and no secret: the probe reads no credential, and Railway exposes a
# variable to a Docker build only when the Dockerfile asks for it with ARG.
# `npm ci --ignore-scripts` keeps the dependency install from running package
# lifecycle scripts; the probe needs none of them.
# tests/productResearchScoutDockerfile.test.mjs holds this file to that.

FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f

WORKDIR /probe

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json ./
COPY lib/ lib/
COPY scripts/agents/product-research-scout.mjs scripts/agents/product-research-scout.mjs
COPY scripts/agents/product-research-scout-s0-probe.mjs scripts/agents/product-research-scout-s0-probe.mjs
COPY scripts/report-product-consistency-core.mjs scripts/report-product-consistency-core.mjs

USER pwuser
CMD ["npm", "run", "agent:product-research-scout"]
