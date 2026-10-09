// Railway Infrastructure as Code for the Agent project.
//
// Scope: the whole `Tomverse Agents` project. Unlike ./railway.ts this file
// exports no partial, and that is the point -- an apply deletes what the file
// owns but does not declare, so a database service somebody adds to this
// project by hand is removed by the next apply instead of becoming the
// reference variable the agents are not allowed to have.
//
// That is also why the agents are in a second project at all: a reference
// variable only resolves inside its own project, so a project with no
// database service and no shared variables has nothing for
// `${{ Postgres.DATABASE_URL }}` to resolve to. The services here reach
// product state through the app's internal routes.
//
// Keep this file a pass-through. The resource list is built by
// buildAgentRunnerResources(), which the unit tests exercise without the SDK.
//
// Run it with the `agents:` scripts in ./package.json, which pass
// --file agents-railway.ts; the default scripts still plan ./railway.ts
// against the shared project.

import { defineRailway, github, image, preserve, project, service } from "railway/iac";
import { AGENT_RAILWAY_PROJECT, buildAgentRunnerResources } from "./agent-runners.ts";

export default defineRailway((ctx) =>
  project(AGENT_RAILWAY_PROJECT, {
    resources: buildAgentRunnerResources(ctx.environment, {
      github,
      image,
      preserve,
      service,
    }),
  })
);
