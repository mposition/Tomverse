# Tomverse Chat Store Review Operations

- Status: Draft for Phase 0 implementation
- Primary owner: Mobile/Release (Engineer C)
- Backup owner: Web/UI (Engineer B)
- Auth incident co-owner: Backend/AI (Engineer A)
- Canonical gates: `STORE-01`, `STORE-02`, `AUTH-01` through `AUTH-04`, and `PRIVACY-01` through `PRIVACY-02` in `docs/release-gates/tomverse-chat-v1.yaml`

## 1. Review path

The submitted app must be useful without an in-app purchase. A clean install must support account creation or review-account login, one complete chat response within the Free allowance, and saved history. Normal Free-tier rate limits and abuse controls stay enabled.

Each store submission receives a dedicated, submission-scoped review credential for a non-privileged Free account. It is not reused across submissions, does not expose production customer data, and does not introduce a general email/password login path. The credential and any recovery instructions are supplied only through the store's private review notes.

The review account must support the same token exchange, rotation, reuse detection, logout, device revoke, account deletion, and export boundaries as a normal mobile account. A test-only bypass of authorization or billing policy is prohibited.

## 2. Submission-scoped fixed verification code

Store reviewers cannot access the dedicated account's mailbox. For an active submission only, the existing email verification-code screen accepts a fixed review verification code supplied with the dedicated review email in the store's private review notes.

This is an explicitly isolated static credential, not a normal OTP and not a general password feature:

- The credential record is bound to exactly one review account, store, submission, submitted app/build identity, and credential version.
- The raw code is shown only when preparing private review notes. The server stores a one-way, server-peppered hash and compares it in constant time; plaintext is never retained or logged.
- The verification service considers the fixed-code branch only when the target account is flagged as the dedicated account for that active submission and the request carries the matching submitted app/build identity. Ordinary accounts can never enter this branch.
- Existing attempt limits, IP/device signals, lockout, audit, and incident alerts apply. Success issues the same short-lived access token and rotating refresh-token family as normal mobile login; it does not create a privileged session.
- `validUntil` follows the rolling-extension lifecycle below. Rotation invalidates the prior code immediately. Acceptance, withdrawal, account deletion, or terminal revoke makes the code unusable even if a stale client still holds it.
- The daily synthetic login uses this exact submitted-build path. A separate internal shortcut does not qualify as `STORE-02` evidence.
- The submitted app/build identity claim is client-asserted and therefore defense-in-depth only, not an isolation guarantee, unless platform attestation (App Attest / Play Integrity) is adopted later. The controls that actually gate access are the hashed code, the account binding, attempt limits, and terminal revocation. `AUTH-02` evidence must not present build binding as a hard isolation boundary.

`AUTH-02` review-account E2E must prove successful use on the intended account/submission and rejection for another account, another submission/build, an expired code, a rotated code, a revoked code, excessive attempts, and post-terminal-state reuse. It must also prove that the normal OTP/magic-link path remains unchanged for ordinary accounts.

## 3. Credential lifecycle

Credential state follows the submission state:

```text
prepared -> submitted -> waiting_for_review -> in_review
                                  |                |
                                  v                v
                              unresolved      accepted/rejected
                                  |
                                  v
                           resubmitted/withdrawn
```

- `prepared`: credential is created and verified but not yet exposed to the store.
- `submitted`, `waiting_for_review`, `in_review`, and `unresolved`: the submission is active. A daily job extends `validUntil` to at least 14 days from the check time and performs the synthetic login.
- `accepted`: revoke within 24 hours after the release decision is confirmed.
- `rejected`: revoke or rotate before resubmission. Never silently reuse the previous secret.
- `withdrawn`: revoke within 24 hours.
- `resubmitted`: issue a new submission-scoped credential and restart monitoring.

Rolling extension is tied to authoritative submission state, not an assumed review duration. At 45 active days, Mobile/Release performs a manual state audit. At 60 active days, continued extension requires Mobile/Release and Security/Privacy approval. The credential may never expire merely because review lasted longer than expected.

Secrets are stored only in the approved secret store. Logs and alerts contain submission ID, account ID, credential version, expiry, and failure class, but never the secret, OTP, magic-link token, access token, or refresh token.

## 4. Daily synthetic login

The Mobile/Release-owned scheduled check runs at least once every 24 hours while a submission is active:

1. Read current submission and credential state.
2. Extend active credential expiry according to the rolling rule.
3. Execute the same review credential exchange used by the submitted build.
4. Validate refresh rotation, a minimal authenticated profile call, and logout/revocation.
5. Record success/failure evidence against the submission and credential versions.
6. On failure, emit an operational incident immediately.

The job must not spend chat credits or mutate user conversations. A separate pre-submission clean-device E2E covers the full Free chat flow for `STORE-01`.

## 5. Alerts and ownership

Synthetic-login failures use the existing operational monitoring path rather than a store-specific alert stack:

- call `reportOperationalIncident` with component `tomverse-chat-store-review`;
- deliver Slack alerts through `OPS_ALERT_SLACK_WEBHOOK_URL`, falling back to `SLACK_WEBHOOK_URL`;
- deliver email alerts through `OPS_ALERT_EMAIL`, falling back to `ADMIN_ALERT_EMAIL`;
- create the existing admin notification/audit entry for traceability.

Mobile/Release is the primary acknowledgement and incident commander. Web/UI is the backup for submission and client issues. Backend/AI jointly owns token exchange, rotation, revoke, and auth-service remediation. Security/Privacy joins any suspected credential exposure, deep-link hijack, CORS bypass, or reuse-detection incident.

No alert destination is considered configured until a test incident has been delivered and acknowledged in the target environment. The submission checklist records the active Slack/email destinations by configuration key, not by embedding addresses in this document.

## 6. Failure response

- Authentication or token failure: Mobile/Release pauses submission changes; Backend/AI checks auth health, key/version state, rotation, and reuse detection.
- Expired credential: extend only after confirming active submission state; record why the daily extension failed.
- Client/deep-link failure: reproduce on the submitted build and physical device; do not replace universal/app links with an insecure custom-scheme-only workaround.
- Suspected exposure: revoke immediately, rotate, update private review notes, and open a Security/Privacy incident.
- Store outage or synthetic-runner outage: mark the check inconclusive rather than successful and rerun from an independent environment.

Release remains blocked until the active-submission evidence required by `STORE-02` is complete and all `AUTH-*` findings meet the canonical YAML.

## 7. Submission checklist

- Review credential is scoped to this submission and verified on the submitted build.
- Fixed verification code is account/submission/build-bound, hash-stored, rate-limited, and absent for ordinary accounts.
- Free account can complete a useful chat without purchase.
- Review notes explain login, Auto model selection, network requirements, and account deletion.
- Synthetic login schedule is active and a test alert was acknowledged.
- Primary and backup owners are available for the expected review window.
- Credential rolling extension and terminal revocation are enabled.
- Apple sign-in or the required equivalent login is available.
- Account deletion and unified data export pass on a clean device.
- CORS and deep-link attack evidence is attached to `AUTH-04`.
