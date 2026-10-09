# The ops-observer runtime image (docs/policy/sre-ops.md §3 rules 5 and 6).
#
# One image for both services -- the page observer and the digest observer --
# which differ only by the supervisor argument their start command passes and
# by the variables Railway gives each. Railway builds it from
# RAILWAY_DOCKERFILE_PATH.
#
# A single stage with no ARG and no secret mount: Railway only exposes a
# variable to a Docker build that the Dockerfile asks for with ARG, so asking
# for none keeps every runtime secret out of the build. The first command the
# image runs checks it whenever that step executes: before anything else is
# copied, the build-environment gate fails the build, printing names only, if
# a runtime secret name or a credential-shaped name is visible. Only the gate
# and the one module it imports are copied ahead of it. A build cache hit
# reuses the step without running it again -- the cache key does not include
# the environment -- so the gate is evidence for the builds that ran it, not
# for every build; no later step writes the environment into a layer.
#
# The image holds Node and the dependency-free observer modules. No package
# manager install, no application code, no product database client.
# tests/opsObserverDockerfile.test.mjs holds this file to that, command by
# command.

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

WORKDIR /observer

COPY scripts/ops-observer/build-env-gate.mjs scripts/ops-observer/build-env-gate.mjs
COPY scripts/ops-observer/runtime-variables-core.mjs scripts/ops-observer/runtime-variables-core.mjs
RUN node scripts/ops-observer/build-env-gate.mjs

COPY scripts/ops-observer/ scripts/ops-observer/
RUN printf '{"private":true,"type":"module"}\n' > package.json \
  && addgroup -S observer \
  && adduser -S -G observer -h /home/observer observer

USER observer
ENV NODE_ENV=production
ENTRYPOINT ["node", "scripts/ops-observer/supervise.mjs"]
