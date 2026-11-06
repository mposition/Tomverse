# The trust-safety observer runtime image
# (docs/policy/trust-safety-compliance-agent.md §4).
#
# The service is a clock and an HTTP client: it calls one internal route with a
# bearer secret and reports the answer as an exit code. So the image holds Node
# and the four dependency-free modules that do it -- no package manager
# install, no application code, no product database client, and not the
# dead-man ping URL, which §4 keeps in the main app.
#
# A single stage with no ARG and no secret mount: Railway only exposes a
# variable to a Docker build that the Dockerfile asks for with ARG, so asking
# for none keeps every runtime secret out of the build. The build-environment
# gate runs before anything else is copied and fails the build, printing names
# only, if a secret or a credential-shaped name is visible. A cache hit reuses
# that step without running it again -- the cache key does not include the
# environment -- so the gate is evidence for the builds that ran it.
#
# tests/trustSafetyServiceIac.test.mjs holds this file to that, command by
# command.

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

WORKDIR /observer

COPY scripts/trust-safety/build-env-gate.mjs scripts/trust-safety/build-env-gate.mjs
COPY scripts/trust-safety/runtime-variables-core.mjs scripts/trust-safety/runtime-variables-core.mjs
RUN node scripts/trust-safety/build-env-gate.mjs

COPY scripts/trust-safety/ scripts/trust-safety/
RUN printf '{"private":true,"type":"module"}\n' > package.json \
  && addgroup -S observer \
  && adduser -S -G observer -h /home/observer observer

USER observer
ENV NODE_ENV=production
ENTRYPOINT ["node", "scripts/trust-safety/supervise.mjs"]
