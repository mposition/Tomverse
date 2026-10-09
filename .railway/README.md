# Railway Infrastructure as Code

Scope: two Railway projects, with a file for each. In `Tomverse`: the
scheduled-job cron services. The web service `Tomverse` itself is managed in
the Railway dashboard and is deliberately not owned by any file here. In
`Tomverse Agents`: the agents' services -- product research
(`docs/ops/product-research-agent.md`), the engineering agent's two production
services once their image digest is recorded
(`docs/ops/engineering-agent-services.md`) and the others in
`agent-runners.ts` -- in a project that holds no database service at all.

- `scheduled-jobs.ts` -- the cron services as data (name, start command, cron,
  every variable name per environment).
- `railway.ts` -- turns that table into Railway IaC as the named partial
  `scheduled-jobs`.
- `run.mjs` -- runs the installed Railway CLI (5.42.1 or newer) with what the
  SDK needs on Windows.

Before editing, and for the migration off `railway.*.json`, read
`docs/ops/railway-iac-scheduled-jobs.md`. The two rules that matter:

1. A variable added to a cron service in the dashboard must be added to
   `scheduled-jobs.ts`, or the next apply deletes it.
2. Removing a service from `scheduled-jobs.ts` deletes that service on apply.

Run these from the **repository root** (not this folder), in PowerShell or
bash, with Node 22 and a Railway CLI 5.42.1+ that is logged in
(`railway login`). `plan` only reads; `apply` writes to Railway.

```
npm run railway:iac:install
npm run railway:iac:use-staging     # or railway:iac:use-production
npm run railway:iac:plan
npm run railway:iac:apply
```

## The Agent project is a second, separate thing

`Tomverse Agents` is its own Railway project, and the files that own it are
separate from the ones above. A reference variable only resolves inside its own
project, so a project with no database service and no shared variables has
nothing for `${{ Postgres.DATABASE_URL }}` to resolve to -- that is the whole
reason the agents are not in `Tomverse`.

- `agent-runners.ts` -- the Agent project's services as data. Unlike the cron
  table, a service here may exist in one environment and not the other, and may
  have no schedule at all.
- `agents-railway.ts` -- turns that table into Railway IaC. It exports **no
  partial**: it owns the whole project, so an apply deletes a database service
  somebody adds there by hand. That is the opposite of `railway.ts`.

Read `docs/ops/product-research-agent.md` before touching either. Rule 1 above
applies here too, and rule 2 is stronger: a service missing from
`agent-runners.ts` is deleted, and so is anything else in that project.

```
npm run railway:agents:use-staging     # or railway:agents:use-production
npm run railway:agents:plan
npm run railway:agents:apply
```

**The two sets of scripts are not interchangeable.** `railway:iac:*` acts on
the named partial inside `Tomverse`; `railway:agents:*` passes
`--file agents-railway.ts` and acts on the whole of `Tomverse Agents`. Running
one where the other belongs plans a different project than the one you linked.
