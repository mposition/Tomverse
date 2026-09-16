# Railway Infrastructure as Code

Scope: the five scheduled-job cron services only. The web service `Tomverse`
is managed in the Railway dashboard and is deliberately not owned by this file.

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
