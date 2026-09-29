# The engineering agent's runtime image (docs/policy/engineering-agent.md §8).
#
# One minimal image for both services -- the runner and the publisher -- which
# differ only by start command and by the variables Railway gives each. It
# holds Node, git and the two services' import closure: the five scripts and
# the three dependency-free core modules they import. No package manager
# install, no installed packages, no application code, nothing a clone could run.
# tests/engineeringAgentServices.test.mjs holds the COPY list to the closure.
#
# Built only by .github/workflows/engineering-agent-image.yml on main, never
# on the deployment platform; Railway runs it by digest
# (.railway/scheduled-jobs.ts).

FROM node:22-alpine

RUN apk add --no-cache git ca-certificates \
  && addgroup -S agent \
  && adduser -S -G agent -h /home/agent agent

WORKDIR /agent

COPY lib/engineeringAgentCore.ts lib/engineeringAgentCore.ts
COPY lib/engineeringAgentModelCall.ts lib/engineeringAgentModelCall.ts
COPY lib/engineeringAgentSecretPatterns.ts lib/engineeringAgentSecretPatterns.ts
COPY scripts/engineering-agent-runner.mjs scripts/engineering-agent-runner.mjs
COPY scripts/engineering-agent-runner-core.mjs scripts/engineering-agent-runner-core.mjs
COPY scripts/engineering-agent-publisher.mjs scripts/engineering-agent-publisher.mjs
COPY scripts/engineering-agent-publisher-core.mjs scripts/engineering-agent-publisher-core.mjs
COPY scripts/engineering-agent-supervisor.mjs scripts/engineering-agent-supervisor.mjs

# The core modules are TypeScript loaded with --experimental-strip-types; the
# package type makes them ES modules without a reparse.
RUN printf '{"private":true,"type":"module"}\n' > package.json

USER agent
ENV NODE_ENV=production
