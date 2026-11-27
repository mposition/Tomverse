# The Tomverse cloud Code runner (docs/ops/desktop-cloud-execution.md, services/code-runner/README.md).
#
# Build from the repository root:
#   docker build -f services/code-runner/Dockerfile -t tomverse-code-runner .
#
# Two stages. The first builds the Tomverse CLI engine the way a person installs it: its own package.json with its
# pinned dependency versions, compiled with tsc. The second holds Node, git, bubblewrap and prlimit, the runner's five
# scripts (Node built-ins only) and the built engine. No application code, no server secrets, no package manager run
# at start.
#
# bubblewrap needs unprivileged user namespaces on the host. The runner checks that it can create them at start and
# refuses to run any job otherwise; it never falls back to running a job unsandboxed in this image.

FROM node:22-alpine AS cli
WORKDIR /cli
COPY apps/tomverse-cli/package.json apps/tomverse-cli/tsconfig.json ./
COPY apps/tomverse-cli/src ./src
COPY apps/tomverse-cli/scripts/build.mjs ./scripts/build.mjs
RUN npm install --omit=dev --no-audit --no-fund --no-package-lock \
  && npm install --no-save --no-audit --no-fund --no-package-lock typescript@6.0.3 @types/node@22.20.5 \
  && node scripts/build.mjs \
  && npm prune --omit=dev --no-audit --no-fund \
  && rm -rf src scripts tsconfig.json

FROM node:22-alpine
RUN apk add --no-cache git bubblewrap util-linux-misc ca-certificates \
  && addgroup -S runner \
  && adduser -S -G runner -h /home/runner runner
COPY --from=cli /cli /cli
WORKDIR /runner
COPY services/code-runner/runner.mjs services/code-runner/job.mjs services/code-runner/worker.mjs services/code-runner/model-adapter.mjs services/code-runner/isolation.mjs ./
RUN printf '{"private":true,"type":"module"}\n' > package.json

USER runner
ENV NODE_ENV=production \
  CODE_RUNNER_CLI_RUNTIME=/cli/dist/runtime.js \
  CODE_RUNNER_READONLY_PATHS=/cli
CMD ["node", "/runner/runner.mjs"]
