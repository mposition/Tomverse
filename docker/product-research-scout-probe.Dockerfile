# The improvement scout's S0 probe image (docs/policy/product-research-agent.md
# §20, S0 (1), (2), (3), (4), (10), (11)).
#
# A measurement image, not the walker or the browser service: it answers
# whether Chromium launches with its sandbox inside a Railway container, what
# production's public pages answer a datacenter address, and whether the
# renderer probes and their checks run on Linux. The services SC1 and SC2 build
# get images of their own, sized by what this one measures.
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
# tests/productResearchScoutProbeDockerfile.test.mjs holds this file to that.

FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f

WORKDIR /probe

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json ./
COPY lib/ lib/
COPY scripts/agents/product-research-scout-s0-probe.mjs scripts/agents/product-research-scout-s0-probe.mjs

USER pwuser
CMD ["npm", "run", "agent:product-research-scout-s0-probe", "--", "all"]
