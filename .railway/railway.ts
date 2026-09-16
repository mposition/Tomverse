// Railway Infrastructure as Code for the scheduled-job cron services.
//
// Scope: the five cron services in ./scheduled-jobs.ts, and nothing else. The
// web service (`Tomverse`), its 160+ variables and its domains stay managed in
// the Railway dashboard. That is why this file exports a named partial: an
// IaC apply deletes what the file owns but does not declare, and a whole-
// project file would own the web service too. Do not rename the partial after
// the first apply -- ownership is recorded against the name.
//
// Keep this file a pass-through. The resource list is built by
// buildScheduledJobResources(), which the unit tests exercise without the SDK;
// anything added here (a filter, an extra resource) is invisible to them.
//
// Run it with the scripts in ./package.json (see ./README.md).

import { defineRailway, github, preserve, project, service } from "railway/iac";
import { buildScheduledJobResources } from "./scheduled-jobs.ts";

export const partial = "scheduled-jobs";

export default defineRailway((ctx) =>
  project("Tomverse", {
    resources: buildScheduledJobResources(ctx.environment, {
      github,
      preserve,
      service,
    }),
  })
);
