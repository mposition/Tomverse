# Native attachment upload compatibility

```
Release SHA:        ddc3e4a8fd52860dc326845eb34fbc93cf965891
Staging deployment:  c75f64ad-9e08-4c60-95db-1a07b72e2342 (exact RC below)
Date / timezone:    2026-10-31 / Australia/Brisbane (AEST)
```

## Released change

Installed native clients rejected the bucket-prefixed R2 hostname produced by
the server's default S3 presigner before uploading any file bytes. Upload signing
now keeps the account hostname and puts the bucket in the path. Bucket/key,
content length, expiry, ownership checks and native destination permissions are
preserved. Read-link addressing is unchanged. No APK update is needed.

- Feature: [#3164](https://github.com/mposition/Tomverse/pull/3164).
- Selective release: [#3169](https://github.com/mposition/Tomverse/pull/3169), containing this feature only.
- Reviewed implementation: `4d77d92cb5116a040f30a9b638c19780fc270c90`.
- Test-verified RC: `b01a0046bad65d5d6795c493bb77251595619152`.
- Main merge: `ddc3e4a8fd52860dc326845eb34fbc93cf965891`,
  2026-10-31 18:52 AEST (08:52 UTC). Its tree is identical to the verified RC.
- Rollback: `ef7a50d469e89c01a5c64b7ab3cad2d6b0f8f1ad`, healthy deployment
  `78880d4e-fc9a-4cba-9767-61e783c6cf36` before this rollout.

## Verification

- [x] All 42 focused attachment/native checks, scoped ESLint and diff checks passed.
  The real AWS presigner/native destination guard regression failed before the fix
  and passed afterwards; read-link addressing remains covered.
- [x] Independent security review `r-20261031-052354-ebdb99` accepted the implementation
  with no blocking findings. Subsequent bookkeeping commits did not change its tree.
- [x] All 38 candidate checks, including deployment statuses, passed before main merge.
  Admission-cancelled suites were completed through normal reruns on the same SHA.
- [x] Dev deployment `ac57ba08-6fd4-487d-8edd-a4449e91559a` matched merge
  `4ce5475e241e4e69e9362a9ec97433a673811e9b` through build-info and source hashes.
- [x] Test deployment `c75f64ad-9e08-4c60-95db-1a07b72e2342` matched the exact RC.
  Native-compatible signing and unauthenticated PUT/PATCH refusals (HTTP 403)
  were verified. A 50-byte synthetic file uploaded with HTTP 200 and downloaded
  with identical bytes, including through the existing server's default-addressing
  metadata/read path. Only the exact disposable object was removed; absence was
  confirmed. No customer data or paid AI calls were used.

- [x] Production deployment `efbf32cb-752e-4237-a331-3b3b177b90db` reached
  SUCCESS at 2026-10-31T09:20:05Z (19:20 AEST). Runtime readback at 09:20:19Z
  reported the exact main merge above and source SHA-256
  `582af6aee8cfc645da0c0f55fb005377113411e2cf3d0b5257768ead5b0f51ad`.
  Upload signing passed the installed native host guard, bucket/key were
  preserved, and unauthenticated PUT/PATCH both returned HTTP 403. Production
  readback made zero object writes and zero paid AI calls; access rules were
  unchanged. The real byte-transfer probe above was performed in Test.

## Existing ancestry follow-up

[Back-merge run 41186336682](https://github.com/mposition/Tomverse/actions/runs/41186336682)
could not reconcile pre-existing financial, audit and marketing file conflicts.
The workflow's jobs failed, while its run intentionally succeeded so this
unrelated ancestry problem would not cancel a deployable production release.
No recovery pull request was opened by that run.

The previous main base was already outside develop's ancestry before this release.
The upload implementation and its regression test are byte-identical on this
release and develop `cab96b75edb7d9dbe3c9e5b10abb0f442484a5ca`; neither is a
conflicted file. This record does not claim full main-to-develop ancestry
restoration. Reconciliation of the pre-existing conflicts remains a separate
follow-up and must preserve the newer develop work.
