---
name: amux-idea
description: Put an idea, and optionally the plan this session wrote for it, into the AMUX backlog with the shared one-line command. Use when the operator asks to put something into AMUX or the backlog ("AMUX에 넣어 주세요", "backlog로 넣어 주세요", "send this idea to AMUX").
---

# AMUX idea intake

The command is the same in every coding tool (owner decision 2026-11-21,
`docs/policy/amux-intake.md`, section "세션 계획 첨부 접수"). It runs from the
repository root on the operator's PC.

The intake secret and origin are environment variables
(`TOMVERSE_AMUX_SESSION_INTAKE_CLIENT_SECRET`, `TOMVERSE_AMUX_SESSION_INTAKE_ORIGIN`)
set by the operator. Never print, echo or write them, and never ask for them in
chat. If the command answers `credential_unavailable`, tell the operator the
variables are missing in this tool's environment.

## Idea only

1. Write the idea body to a scratch Markdown file (no secrets, personal data,
   absolute local paths or private URLs; the intake refuses them).
2. Run:

   ```
   npm run amux:idea -- submit --tool "Claude Code" --provider "Anthropic" --title "<one line>" --body <file.md>
   ```

   Without `--repo` the checkout's GitHub origin is the reference. Add
   `--pr owner/name#123` for a pull request.

The box analyses the idea and the operator approves its plan in the Admin idea.

## Idea with this session's plan

1. `npm run amux:idea -- prompt --title "<one line>" --body <file.md>` prints the
   exact analysis prompt the box would run.
2. Read the repository as the work needs, then write the answer: one JSON object
   with `outcome: "propose"`, `coverageStatus: "complete"`, `coveredScope` and
   `units` in the prompt's unit format. Every Task names `expectedPaths`. Leave
   out `ownerQuestion`: a plan with an open question is refused, so ask the
   operator in chat first.
3. `npm run amux:idea -- check --plan <plan.json>` runs the same parser and
   content checks with no network. Fix what it names (rule, field, unit index).
4. Submit with `--plan <plan.json>` added to the idea-only command.

The plan skips the box analysis and waits for the operator's one plan approval
in the Admin idea, marked as written by a session with no record of files read.
It is registered without that approval only if the operator has switched on
`TOMVERSE_AMUX_SESSION_PLAN_AUTO_REGISTER`; do not set it yourself.

## After the command

- Report the `adminPath` and, when a plan was attached, `plan.state`.
- A failure prints a closed code only. Never resend the same request: an unknown
  outcome is read back with `npm run amux:idea -- readback --request-id <id>`,
  using the request ID printed before the send.
