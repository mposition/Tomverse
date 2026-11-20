# The Scout's image (docs/policy/product-research-agent.md §10, §13): the daily
# walker (`Product Research Scout`). It holds Chromium, the renderers the walker
# exercises, and no credential.
#
# The base is Playwright's own image at the version package-lock.json pins, so
# the browsers it carries are the ones @playwright/test expects. It runs as the
# image's unprivileged `pwuser`: Chromium refuses its sandbox to root.
#
# No ARG and no secret: the build reads no credential, and Railway exposes a
# variable to a Docker build only when the Dockerfile asks for it with ARG.
# `npm ci --ignore-scripts` keeps the dependency install from running package
# lifecycle scripts; the walker needs none of them.
# tests/productResearchScoutDockerfile.test.mjs holds this file to that.

FROM mcr.microsoft.com/playwright:v1.65.0-noble@sha256:9beb546099e11f52d62e505537914870e01a67e0e6b00ae41da4775324e73dbe

WORKDIR /probe

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json ./
COPY lib/ lib/
COPY scripts/agents/product-research-scout.mjs scripts/agents/product-research-scout.mjs
COPY scripts/report-product-consistency-core.mjs scripts/report-product-consistency-core.mjs

USER pwuser
CMD ["npm", "run", "agent:product-research-scout"]
