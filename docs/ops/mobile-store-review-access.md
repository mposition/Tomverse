# Android store reviewer access

This implements the native email screen entry described by
[store review operations](tomverse-chat-store-review.md). It is disabled by
default and does not create an account or a production credential on deployment.

An operator may configure `MOBILE_STORE_REVIEW_ENABLED=true` and the server-only
`MOBILE_STORE_REVIEW_CREDENTIAL_JSON` for one dedicated Free account. The object
contains `submissionId`, `userId`, `email`, `appId` (`app.tomverse.shell`),
`buildNumber`, `state`, `validUntil`, a random 32-byte hex `salt`, and `codeHash`.
The code hash is generated with `hashMobileStoreReviewCode`; raw codes must never
enter source, logs, API replies or build assets. Deliver the raw code only in the
store's private app-access instructions. The existing code-request screen returns
its usual success state without sending mail for this one configured address.

Allowed states are `prepared`, `submitted`, `in_review` and `unresolved`.
Malformed, expired, terminal-state and more-than-31-day credentials fail closed.
Rotate the salt and code per submission. Apply the existing daily readback and
rolling-extension runbook before activating a real submission; this patch does
not provision that schedule or its alert destinations.

Provision a new dedicated address and account for each submission; the script
intentionally refuses account reuse. The account-wide budget also limits correct
logins and can be exhausted by someone who knows the review address. Monitor that
failure separately from a bad code. The request response can identify the special
review address, so its email is not treated as a secret; the code remains private.

Verification uses the existing native route origin refusal, admission budget,
active-account check and session issuance/rotation. The additional code check
has an account-wide 5/minute and 100/day budget, before the slow password hash.
The account must remain verified, active, email-login-enabled and non-admin. Its
plan must exactly match the credential's `plan` (`Free` by default). The owner's
Google-review exception permits `Max` only after a separate normal Admin plan
adjustment: `manually_adjusted` status with an unexpired period end is required.
The credential never upgrades a plan, grants credits or resets usage. The owner
approved one temporary Max review account using the existing monthly allowance,
no additional credit top-ups, with access revoked after review. Use the existing
Admin plan-adjust approval and audit path; never update plan fields directly.
App/build claims are client assertions, not platform attestation. The credential,
account binding, expiry and limits enforce access; ordinary OTP login is unchanged.

Activation requires a dedicated account with no customer data, a tested private
credential, existing session/refresh/logout evidence, and operator confirmation.
The implementation and a locally generated draft are not activation evidence.
