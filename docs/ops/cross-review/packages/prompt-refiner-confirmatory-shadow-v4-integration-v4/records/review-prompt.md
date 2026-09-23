# Independent review — task prompt-refiner-confirmatory-shadow-v4-integration-v4, round 1

Review the change against the original requirement below. Read the requirement and the diff before anything else.
Do not take the author's summary as a description of what the change does; the diff is.

## Requirement (original)

최신 origin/develop ab55b84280eba8187327cb0c1a863100f73c6fec 위의 최종 PR diff로 Prompt Refiner confirmatory shadow v4를 다시 검토한다. 원 v4 구현, content-free evidence writer, duration coupling 및 PostgreSQL STRICT/PARALLEL SAFE 수정, 직전 develop 통합은 각각 digest-bound Claude Code Max 검토를 통과했다. 이번 새 검토는 develop의 email suppression schema 변경을 병합하며 직접 충돌한 marketing pipeline fingerprint와 Prompt Refiner runtime source closure snapshot이 양쪽 의미를 보존하는지, .gitleaksignore의 exact immutable fingerprint가 merge commit에서도 유효한지, 그리고 최종 PR diff의 v4 계약·migration·writer·API·UI·테스트가 여전히 원 요구를 충족하는지 확인한다. 이전 audit package output만 reviewed diff에서 제외하며 이번 task/authorization과 모든 구현·테스트·운영 문서는 포함한다. provider 호출, 유료 실행, stage/run 승인, flag 변경, 제품 노출, Router 결합 또는 rollout은 하지 않는다. author는 Codex, reviewer는 Claude Code Max다.

## Completion criteria

- 최신 develop의 email suppression schema와 Prompt Refiner v4 schema/migration 변경을 모두 보존하고 unresolved merge marker가 없다.
- marketing webhook watched-schema fingerprint가 최종 schema bytes와 일치하고 email suppression 및 Prompt Refiner 변경의 비영향 판단이 기록된다.
- runtime source closure의 228개 reviewed computed access snapshot과 188-file v4 closure가 최종 병합 bytes에 결속한다.
- .gitleaksignore의 허용은 branch commit SHA·path·rule·line exact fingerprint이고 merge commit을 squash/rebase하지 않는 조건이 기록된다.
- v4 terminal evidence는 content-free, strict, atomic, exactly replayable이고 DB에서 aggregate를 재구성할 수 있으며 제품·Router 권한은 false다.
- 전체 unit, TypeScript, ESLint와 충돌 관련 focused test 및 저장소 보안 검사가 통과한다.
- Claude verdict는 최종 PR diff의 exact digest에 결속하고 open finding 없이 approve해야 한다.

## Change under review — digest sha256:a0b83ea542f34d33722e0c6e4e31ae355e9928f221331df7cef781ae79617175

```diff
diff --git a/.gitleaksignore b/.gitleaksignore
index 177aa266..e49c1983 100644
--- a/.gitleaksignore
+++ b/.gitleaksignore
@@ -122,3 +122,135 @@ bd8584ca778a3f1774740f39b2af8568afa16d71:tests/server-contract/email-provider-po
 #
 # Scope: exactly this one finding in that one commit -- nothing wider.
 a831d33ff49b2e7b9d31d829f734c80cacacfbd7:tests/promptRefinerRuntimeSourceClosure.test.mjs:generic-api-key:64
+
+# Prompt Refiner v4 cross-review packages preserve the exact local DB
+# integration command as immutable evidence. The command uses the public,
+# deterministic test-only NEXTAUTH_SECRET from scripts/run-db-integration-tests.mjs;
+# it never authenticated any deployed system. Gitleaks reports that same value
+# wherever the review package copied the command.
+#
+# Scope: only the exact introducing commit + path + rule + line findings from
+# PR #1584. Fingerprints are intentionally used instead of a regex/path
+# allowlist: any edited line, future package, different rule, or different
+# commit gets a new fingerprint and remains blocked.
+# Follow-up packages must redact this test-only value while recording command
+# evidence so this immutable exception list does not grow with each review.
+# These fingerprints remain valid only while the named branch commits stay in
+# history: merge PR #1584 with a merge commit; never squash or rebase it.
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round2.diff:generic-api-key:10335
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round2.diff:generic-api-key:10438
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round2.diff:generic-api-key:10644
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round2.diff:generic-api-key:10684
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round2.diff:generic-api-key:14044
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round2.diff:generic-api-key:24489
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round2.diff:generic-api-key:24592
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round2.diff:generic-api-key:24798
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round2.diff:generic-api-key:24838
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round2.diff:generic-api-key:28198
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round2.diff:generic-api-key:31886
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round2.diff:generic-api-key:32037
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round2.diff:generic-api-key:32108
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round2.diff:generic-api-key:32293
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round2.diff:generic-api-key:32333
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round2.diff:generic-api-key:32471
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round2.diff:generic-api-key:32511
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round2.diff:generic-api-key:39414
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round2.diff:generic-api-key:39517
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round2.diff:generic-api-key:39723
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round2.diff:generic-api-key:39763
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round2.diff:generic-api-key:43123
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round2.diff:generic-api-key:46737
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:10335
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:10438
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:10644
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:10684
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:14044
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:24489
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:24592
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:24798
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:24838
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:28198
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:31886
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:32037
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:32108
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:32293
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:32333
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:32471
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:32511
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:39414
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:39517
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:39723
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:39763
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:43123
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:46737
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/exchange.json:generic-api-key:383
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/package-round2.json:generic-api-key:132
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/package-round2.json:generic-api-key:172
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:10358
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:10461
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:10667
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:10707
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:14067
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:24512
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:24615
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:24821
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:24861
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:28221
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:31909
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:32060
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:32131
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:32316
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:32356
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:32494
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:32534
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:39437
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:39540
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:39746
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:39786
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:43146
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:46760
+26aeecba8a00dd82d189daed8a1ac4fac980d5dd:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:50514
+3f588a989c3c953a2f544cb91405d9630ab9c5d3:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-integration-v3/records/exchange.failed-attempt1.json:generic-api-key:140
+3f588a989c3c953a2f544cb91405d9630ab9c5d3:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-integration-v3/records/exchange.failed-attempt1.json:generic-api-key:206
+3f588a989c3c953a2f544cb91405d9630ab9c5d3:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-integration-v3/records/exchange.json:generic-api-key:140
+3f588a989c3c953a2f544cb91405d9630ab9c5d3:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-integration-v3/records/exchange.json:generic-api-key:211
+3f588a989c3c953a2f544cb91405d9630ab9c5d3:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-integration-v3/records/package-round0.failed-attempt1.json:generic-api-key:175
+3f588a989c3c953a2f544cb91405d9630ab9c5d3:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-integration-v3/records/package-round0.failed-attempt1.json:generic-api-key:215
+3f588a989c3c953a2f544cb91405d9630ab9c5d3:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-integration-v3/records/package-round0.json:generic-api-key:175
+3f588a989c3c953a2f544cb91405d9630ab9c5d3:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-integration-v3/records/package-round0.json:generic-api-key:215
+3f588a989c3c953a2f544cb91405d9630ab9c5d3:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-integration-v3/records/review-prompt.md:generic-api-key:3866
+59d895c649d70b76acad4a6972f5edbade4a01a9:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-integration-v3/records/exchange.json:generic-api-key:290
+59d895c649d70b76acad4a6972f5edbade4a01a9:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-integration-v3/records/package-round1.json:generic-api-key:193
+59d895c649d70b76acad4a6972f5edbade4a01a9:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-integration-v3/records/package-round1.json:generic-api-key:233
+59d895c649d70b76acad4a6972f5edbade4a01a9:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-integration-v3/records/review-prompt.md:generic-api-key:3875
+724ca10b451776eb1d1c24b74758abd49ca5654f:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/exchange.json:generic-api-key:109
+724ca10b451776eb1d1c24b74758abd49ca5654f:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/exchange.json:generic-api-key:212
+724ca10b451776eb1d1c24b74758abd49ca5654f:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/package-round0.json:generic-api-key:102
+724ca10b451776eb1d1c24b74758abd49ca5654f:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/package-round0.json:generic-api-key:142
+724ca10b451776eb1d1c24b74758abd49ca5654f:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:3346
+bc5a47468b046406ce7631cf2732a26356294352:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:3686
+c54ce50056e89ca883260a0e89d12c18a7452f4f:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round1.diff:generic-api-key:10575
+c54ce50056e89ca883260a0e89d12c18a7452f4f:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round1.diff:generic-api-key:6866
+c54ce50056e89ca883260a0e89d12c18a7452f4f:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round1.diff:generic-api-key:6969
+c54ce50056e89ca883260a0e89d12c18a7452f4f:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round1.diff:generic-api-key:7175
+c54ce50056e89ca883260a0e89d12c18a7452f4f:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change-round1.diff:generic-api-key:7215
+c54ce50056e89ca883260a0e89d12c18a7452f4f:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:10575
+c54ce50056e89ca883260a0e89d12c18a7452f4f:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:6866
+c54ce50056e89ca883260a0e89d12c18a7452f4f:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:6969
+c54ce50056e89ca883260a0e89d12c18a7452f4f:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:7175
+c54ce50056e89ca883260a0e89d12c18a7452f4f:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/change.diff:generic-api-key:7215
+c54ce50056e89ca883260a0e89d12c18a7452f4f:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/exchange.json:generic-api-key:260
+c54ce50056e89ca883260a0e89d12c18a7452f4f:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/exchange.json:generic-api-key:322
+c54ce50056e89ca883260a0e89d12c18a7452f4f:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/package-round1.json:generic-api-key:124
+c54ce50056e89ca883260a0e89d12c18a7452f4f:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/package-round1.json:generic-api-key:164
+c54ce50056e89ca883260a0e89d12c18a7452f4f:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:10598
+c54ce50056e89ca883260a0e89d12c18a7452f4f:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:14212
+c54ce50056e89ca883260a0e89d12c18a7452f4f:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:6889
+c54ce50056e89ca883260a0e89d12c18a7452f4f:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:6992
+c54ce50056e89ca883260a0e89d12c18a7452f4f:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:7198
+c54ce50056e89ca883260a0e89d12c18a7452f4f:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/review-prompt.md:generic-api-key:7238
+cb53fd03182073ae25b62085c8db8d9fcd6378e2:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-followup-v2/records/exchange.json:generic-api-key:139
+cb53fd03182073ae25b62085c8db8d9fcd6378e2:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-followup-v2/records/exchange.json:generic-api-key:77
+cb53fd03182073ae25b62085c8db8d9fcd6378e2:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-followup-v2/records/package-round0.json:generic-api-key:54
+cb53fd03182073ae25b62085c8db8d9fcd6378e2:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-followup-v2/records/package-round0.json:generic-api-key:94
+cb53fd03182073ae25b62085c8db8d9fcd6378e2:docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-followup-v2/records/review-prompt.md:generic-api-key:168
diff --git a/app/api/admin/prompt-refiner/shadow-run/execute/route.ts b/app/api/admin/prompt-refiner/shadow-run/execute/route.ts
index eb843e71..2e8e1aa0 100644
--- a/app/api/admin/prompt-refiner/shadow-run/execute/route.ts
+++ b/app/api/admin/prompt-refiner/shadow-run/execute/route.ts
@@ -28,6 +28,7 @@ import {
 } from "@/lib/promptRefinerShadowRunner";
 import {
     promptRefinerShadowRunErrorResponse,
+    readPromptRefinerShadowEvidenceBundle,
     readPromptRefinerShadowExecutionState,
 } from "@/lib/promptRefinerShadowRunStore";
 import { promptRefinerStageAdmissionErrorResponse } from "@/lib/promptRefinerStageAdmission";
@@ -101,10 +102,19 @@ export async function GET(request: Request) {
             { minute: 10, day: 40 }
         );
         const state = await readPromptRefinerShadowExecutionState();
+        const evidenceBundle = await readPromptRefinerShadowEvidenceBundle();
+        const evidence = evidenceBundle
+            ? {
+                  gateOutcome: evidenceBundle.gateOutcome,
+                  gateReasons: evidenceBundle.gateReasons,
+                  summary: evidenceBundle.summary,
+              }
+            : null;
         return NextResponse.json(
             {
                 execution: {
                     ...state,
+                    evidence,
                     runContractDigest:
                         PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST,
                     enabled:
diff --git a/app/api/admin/prompt-refiner/shadow-run/route.ts b/app/api/admin/prompt-refiner/shadow-run/route.ts
index f87d1cdd..02e1f217 100644
--- a/app/api/admin/prompt-refiner/shadow-run/route.ts
+++ b/app/api/admin/prompt-refiner/shadow-run/route.ts
@@ -130,6 +130,7 @@ export async function POST(request: Request) {
                     status: result.run.status,
                     runContractDigest: result.run.runContractDigest,
                     corpusDigest: result.run.corpusDigest,
+                    evidenceSpecDigest: result.run.evidenceSpecDigest,
                     adapterVersion: result.run.adapterVersion,
                     environment: "staging",
                     deploymentId: result.run.runtimeDeploymentId,
diff --git a/components/admin/AdminPromptRefinerShadowPanel.tsx b/components/admin/AdminPromptRefinerShadowPanel.tsx
index 9f9aca08..ed8e9234 100644
--- a/components/admin/AdminPromptRefinerShadowPanel.tsx
+++ b/components/admin/AdminPromptRefinerShadowPanel.tsx
@@ -508,6 +508,30 @@ export function AdminPromptRefinerShadowPanel() {
               label={m.executionFlag}
               value={execution.enabled ? m.enabled : m.disabled}
             />
+            {execution.evidence ? (
+              <>
+                <Field
+                  label={m.evidenceGate}
+                  value={execution.evidence.gateOutcome}
+                />
+                <Field
+                  label={m.evidenceCases}
+                  value={`${execution.evidence.summary.passedCases}/${execution.evidence.summary.attemptedCases}`}
+                />
+                <Field
+                  label={m.evidenceCost}
+                  value={
+                    execution.evidence.summary.totalCostMicroUsd === null
+                      ? m.none
+                      : usd(execution.evidence.summary.totalCostMicroUsd)
+                  }
+                />
+                <Field
+                  label={m.evidenceLatency}
+                  value={`${execution.evidence.summary.latencyP90Ms ?? m.none} / ${execution.evidence.summary.latencyMaxMs ?? m.none} ms`}
+                />
+              </>
+            ) : null}
           </dl>
 
           {execution.status === "completed" ? (
diff --git a/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-followup-v2/authorization.md b/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-followup-v2/authorization.md
new file mode 100644
index 00000000..8e7e0d0c
--- /dev/null
+++ b/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-followup-v2/authorization.md
@@ -0,0 +1,18 @@
+# Prompt Refiner confirmatory shadow v4 후속 검토 승인 기록
+
+- approvedBy: `mposition`
+- approvedAt: `2026-09-21` (Australia/Brisbane)
+- author: `codex`
+- independentReviewer: `claude-code-max`
+
+사용자는 Tomverse Chat 개발을 완료할 때까지 권장 순서로 자동 진행하고, 필요한
+Claude Code Max 독립 검토와 `--skip-preflight` 예외를 허용했으며 수정 round 상한을
+두지 않았다. 원 exchange는 round 2에서 `approve`와 재현 가능한 finding 1건을 함께
+남겨 `on_hold(revisions_exhausted)`로 닫혔다. 이 successor는 그 finding을 수정하고
+동일한 읽기 전용 reviewer에게 다시 확인받기 위한 기록이다.
+
+승인 범위는 PostgreSQL 함수 속성 parity 수정, 그 회귀 테스트, package·검토 기록,
+로컬 검증, push와 PR 및 CI 확인까지다. provider 호출, stage/run 승인, Railway flag,
+유료 shadow 실행, 제품 Prompt Refiner 노출, Router 결합 또는 rollout 승인이 아니다.
+Claude 호출은 저장된 `claude.ai` Max 구독만 사용하며 API key/token 환경 변수는
+제거하고 `firstParty`·`max` 인증을 확인한다.
diff --git a/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-followup-v2/task.json b/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-followup-v2/task.json
new file mode 100644
index 00000000..16ace8d6
--- /dev/null
+++ b/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-followup-v2/task.json
@@ -0,0 +1,23 @@
+{
+  "taskId": "prompt-refiner-confirmatory-shadow-v4-followup-v2",
+  "requirement": "prompt-refiner-confirmatory-shadow-v4 exchange가 round 2에서 approve와 재현 가능한 PostgreSQL 함수 속성 finding 1건을 함께 남기고 on_hold(revisions_exhausted)로 종료됐다. 기존 구현과 검토 기록은 보존한다. 후속 변경은 v4 prompt_refiner_runtime_manifest_valid wrapper가 위임 대상 v2 validator와 동일하게 STRICT 및 PARALLEL SAFE가 되도록 migration을 수정하고, fresh migration DB의 pg_proc에서 두 함수가 모두 proisstrict=true 및 proparallel='s'임을 통합 테스트로 고정한다. 그 밖의 Prompt Refiner 계약, provider 호출, 권한, 비용, flag, stage/run 또는 rollout 동작은 바꾸지 않는다. author는 Codex, reviewer는 Claude Code Max다.",
+  "completionCriteria": [
+    "원 exchange의 on_hold 상태와 round 2 finding을 supersedes lineage와 inherited finding으로 보존한다.",
+    "v4 migration의 runtime-manifest wrapper가 IMMUTABLE, STRICT, PARALLEL SAFE이고 기존 v2 validator의 반환·위임 의미는 변하지 않는다.",
+    "fresh migration DB에서 v2 validator와 v4 wrapper의 proisstrict=true 및 proparallel='s'를 실제 pg_proc로 검증한다.",
+    "Prompt Refiner DB integration, unit, TypeScript, ESLint, schema·문서·정책·protected-writer 검사가 통과한다.",
+    "검토 record 디렉터리만 reviewed diff에서 제외하고 task, authorization, migration과 테스트는 exact digest에 포함한다.",
+    "Claude verdict는 exact package digest에 결속하고 open finding 없이 approve해야 한다."
+  ],
+  "baseCommit": "bc5a47468b046406ce7631cf2732a26356294352",
+  "writableScope": [
+    "docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-followup-v2",
+    "prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql",
+    "tests/integration/prompt-refiner-shadow-run.db.test.ts"
+  ],
+  "generatedPaths": [],
+  "supersedes": {
+    "taskId": "prompt-refiner-confirmatory-shadow-v4",
+    "exchange": "docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/exchange.json"
+  }
+}
diff --git a/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-integration-v3/authorization.md b/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-integration-v3/authorization.md
new file mode 100644
index 00000000..b7ad2306
--- /dev/null
+++ b/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-integration-v3/authorization.md
@@ -0,0 +1,17 @@
+# Prompt Refiner confirmatory shadow v4 통합 검토 승인 기록
+
+- approvedBy: `mposition`
+- approvedAt: `2026-09-21` (Australia/Brisbane)
+- author: `codex`
+- independentReviewer: `claude-code-max`
+
+사용자는 Tomverse Chat 개발을 권장 순서로 자동 진행하고, 필요한 Claude Code Max
+독립 검토와 `--skip-preflight` 예외를 허용했다. 원 구현 exchange와 PostgreSQL
+후속 successor는 각각 기록됐고 successor는 finding 0건으로 통과했다. 최신 develop을
+병합하면서 `lib/marketingAutomationAccess.ts`와 runtime closure snapshot의 실제 충돌
+2건을 해결했으므로, PR의 최종 diff를 새 digest로 다시 검토한다.
+
+승인 범위는 병합 충돌 해결, 전체 로컬 검증, 읽기 전용 독립 검토, push·PR 및 CI
+확인까지다. provider 호출, 유료 shadow 실행, stage/run 승인, Railway flag, 제품 노출,
+Router 결합 또는 rollout 권한은 포함하지 않는다. Claude는 저장된 `claude.ai` Max
+구독만 사용하고 API key/token 환경 변수는 제거한다.
diff --git a/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-integration-v3/task.json b/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-integration-v3/task.json
new file mode 100644
index 00000000..6c468ab0
--- /dev/null
+++ b/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-integration-v3/task.json
@@ -0,0 +1,57 @@
+{
+  "taskId": "prompt-refiner-confirmatory-shadow-v4-integration-v3",
+  "requirement": "최신 origin/develop 1c5266aacfd53fbd8fa3e16b58b54bbbd7d6b131 위의 최종 PR diff로 Prompt Refiner confirmatory shadow v4를 다시 검토한다. 원 v4 구현과 content-free evidence writer, duration coupling 수정, PostgreSQL STRICT/PARALLEL SAFE 후속 수정은 이미 digest-bound Claude 검토를 거쳤다. 이번 통합 검토는 develop의 AMUX/email schema 변경을 병합하며 해결한 marketing pipeline fingerprint와 runtime source closure snapshot이 양쪽 의미를 보존하는지, 그리고 최종 PR diff의 v4 계약·migration·writer·API·UI·테스트가 여전히 원 요구를 충족하는지 확인한다. audit package output만 reviewed diff에서 제외하며 task/authorization과 모든 구현·테스트·운영 문서는 포함한다. provider 호출, 유료 실행, stage/run 승인, flag 변경, 제품 노출, Router 결합 또는 rollout은 하지 않는다. author는 Codex, reviewer는 Claude Code Max다.",
+  "completionCriteria": [
+    "최신 develop의 AMUX/email schema와 Prompt Refiner v4 schema/migration 변경을 모두 보존하고 unresolved merge marker가 없다.",
+    "marketing webhook watched-schema fingerprint가 최종 schema bytes와 일치하고 AMUX 및 Prompt Refiner 변경의 비영향 판단이 기록된다.",
+    "runtime source closure의 228개 reviewed computed access snapshot과 188-file v4 closure가 최종 병합 bytes에 결속한다.",
+    "v4 terminal evidence는 content-free, strict, atomic, exactly replayable이고 DB에서 aggregate를 재구성할 수 있으며 제품·Router 권한은 false다.",
+    "fresh migration DB, Prompt Refiner DB integration, unit, TypeScript, ESLint, enum·protected-writer·문서·정책 검사가 통과한다.",
+    "Claude verdict는 최종 PR diff의 exact digest에 결속하고 open finding 없이 approve해야 한다."
+  ],
+  "baseCommit": "1c5266aacfd53fbd8fa3e16b58b54bbbd7d6b131",
+  "writableScope": [
+    "app/api/admin/prompt-refiner/shadow-run/execute/route.ts",
+    "app/api/admin/prompt-refiner/shadow-run/route.ts",
+    "components/admin/AdminPromptRefinerShadowPanel.tsx",
+    "docs/ops/cross-review/packages",
+    "docs/ops/prompt-refiner-confirmatory-shadow-v4.md",
+    "docs/ops/prompt-refiner-durable-stage-writer-contract.md",
+    "docs/ops/prompt-refiner-durable-stage-writer-task.md",
+    "docs/ops/tomverse-chat-progress.md",
+    "docs/policy/prompt-refiner-durable-stage-writer-threat-model.md",
+    "docs/policy/prompt-refiner-observability.md",
+    "lib/adminMessages/promptRefinerShadow.ts",
+    "lib/marketingAutomationAccess.ts",
+    "lib/promptRefinerReservationCore.ts",
+    "lib/promptRefinerShadowAdmissionCore.ts",
+    "lib/promptRefinerShadowEvidenceCore.ts",
+    "lib/promptRefinerShadowOperatorCore.ts",
+    "lib/promptRefinerShadowRunContract.ts",
+    "lib/promptRefinerShadowRunStore.ts",
+    "lib/promptRefinerShadowRunner.ts",
+    "lib/promptRefinerShadowSystemAudit.ts",
+    "lib/promptRefinerStageAdmissionCore.ts",
+    "prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql",
+    "prisma/schema.prisma",
+    "scripts/check-enum-constraints.mjs",
+    "scripts/check-protected-table-writers-core.mjs",
+    "tests/integration/prompt-refiner-shadow-run.db.test.ts",
+    "tests/marketingAutomationAccess.test.mjs",
+    "tests/promptRefinerReservationCore.test.mjs",
+    "tests/promptRefinerRuntimeSourceClosure.test.mjs",
+    "tests/promptRefinerShadowAdmissionCore.test.mjs",
+    "tests/promptRefinerShadowEvidenceCore.test.mjs",
+    "tests/promptRefinerShadowOperatorCore.test.mjs",
+    "tests/promptRefinerShadowRunContract.test.mjs",
+    "tests/promptRefinerShadowRunner.test.mjs",
+    "tests/promptRefinerStageAdmissionReader.test.mjs",
+    "tests/server-contract/admin-prompt-refiner-shadow-execution-route.test.ts",
+    "tests/server-contract/admin-prompt-refiner-shadow-run-route.test.ts",
+    "tests/server-contract/admin-prompt-refiner-shadow-stage-route.test.ts"
+  ],
+  "generatedPaths": [
+    "docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4",
+    "docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-followup-v2/records"
+  ]
+}
diff --git a/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-integration-v4/authorization.md b/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-integration-v4/authorization.md
new file mode 100644
index 00000000..d79e514f
--- /dev/null
+++ b/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-integration-v4/authorization.md
@@ -0,0 +1,19 @@
+# Prompt Refiner confirmatory shadow v4 최신 develop 통합 검토 승인 기록
+
+- approvedBy: `mposition`
+- approvedAt: `2026-09-21` (Australia/Brisbane)
+- author: `codex`
+- independentReviewer: `claude-code-max`
+
+사용자는 Tomverse Chat 개발을 권장 순서로 자동 진행하고, 필요한 Claude Code Max
+독립 검토와 `--skip-preflight` 예외를 허용했다. 원 구현과 두 후속 exchange는 기록됐고
+마지막 검토는 finding 0건으로 통과했다. 이후 최신 develop을 병합하면서
+`lib/marketingAutomationAccess.ts`와 `tests/promptRefinerRuntimeSourceClosure.test.mjs`의
+실제 충돌 2건을 해결했으므로, 최신 develop 기준 최종 PR diff를 새 digest로 다시
+검토한다.
+
+승인 범위는 병합 충돌 해결, 전체 로컬 검증, Claude Code Max 구독 CLI의 읽기 전용
+독립 검토, push·PR 및 CI 확인까지다. provider 호출, 유료 shadow 실행, stage/run 승인,
+Railway flag, 제품 노출, Router 결합, rollout 또는 merge/deploy 권한은 포함하지 않는다.
+Claude 실행에서는 Anthropic API key/token 환경 변수를 제거하고 저장된 `claude.ai` Max
+구독 로그인만 사용한다.
diff --git a/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-integration-v4/task.json b/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-integration-v4/task.json
new file mode 100644
index 00000000..fa2b9b49
--- /dev/null
+++ b/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-integration-v4/task.json
@@ -0,0 +1,61 @@
+{
+  "taskId": "prompt-refiner-confirmatory-shadow-v4-integration-v4",
+  "requirement": "최신 origin/develop ab55b84280eba8187327cb0c1a863100f73c6fec 위의 최종 PR diff로 Prompt Refiner confirmatory shadow v4를 다시 검토한다. 원 v4 구현, content-free evidence writer, duration coupling 및 PostgreSQL STRICT/PARALLEL SAFE 수정, 직전 develop 통합은 각각 digest-bound Claude Code Max 검토를 통과했다. 이번 새 검토는 develop의 email suppression schema 변경을 병합하며 직접 충돌한 marketing pipeline fingerprint와 Prompt Refiner runtime source closure snapshot이 양쪽 의미를 보존하는지, .gitleaksignore의 exact immutable fingerprint가 merge commit에서도 유효한지, 그리고 최종 PR diff의 v4 계약·migration·writer·API·UI·테스트가 여전히 원 요구를 충족하는지 확인한다. 이전 audit package output만 reviewed diff에서 제외하며 이번 task/authorization과 모든 구현·테스트·운영 문서는 포함한다. provider 호출, 유료 실행, stage/run 승인, flag 변경, 제품 노출, Router 결합 또는 rollout은 하지 않는다. author는 Codex, reviewer는 Claude Code Max다.",
+  "completionCriteria": [
+    "최신 develop의 email suppression schema와 Prompt Refiner v4 schema/migration 변경을 모두 보존하고 unresolved merge marker가 없다.",
+    "marketing webhook watched-schema fingerprint가 최종 schema bytes와 일치하고 email suppression 및 Prompt Refiner 변경의 비영향 판단이 기록된다.",
+    "runtime source closure의 228개 reviewed computed access snapshot과 188-file v4 closure가 최종 병합 bytes에 결속한다.",
+    ".gitleaksignore의 허용은 branch commit SHA·path·rule·line exact fingerprint이고 merge commit을 squash/rebase하지 않는 조건이 기록된다.",
+    "v4 terminal evidence는 content-free, strict, atomic, exactly replayable이고 DB에서 aggregate를 재구성할 수 있으며 제품·Router 권한은 false다.",
+    "전체 unit, TypeScript, ESLint와 충돌 관련 focused test 및 저장소 보안 검사가 통과한다.",
+    "Claude verdict는 최종 PR diff의 exact digest에 결속하고 open finding 없이 approve해야 한다."
+  ],
+  "baseCommit": "ab55b84280eba8187327cb0c1a863100f73c6fec",
+  "writableScope": [
+    ".gitleaksignore",
+    "app/api/admin/prompt-refiner/shadow-run/execute/route.ts",
+    "app/api/admin/prompt-refiner/shadow-run/route.ts",
+    "components/admin/AdminPromptRefinerShadowPanel.tsx",
+    "docs/ops/cross-review/packages",
+    "docs/ops/prompt-refiner-confirmatory-shadow-v4.md",
+    "docs/ops/prompt-refiner-durable-stage-writer-contract.md",
+    "docs/ops/prompt-refiner-durable-stage-writer-task.md",
+    "docs/ops/tomverse-chat-progress.md",
+    "docs/policy/prompt-refiner-durable-stage-writer-threat-model.md",
+    "docs/policy/prompt-refiner-observability.md",
+    "lib/adminMessages/promptRefinerShadow.ts",
+    "lib/marketingAutomationAccess.ts",
+    "lib/promptRefinerReservationCore.ts",
+    "lib/promptRefinerShadowAdmissionCore.ts",
+    "lib/promptRefinerShadowEvidenceCore.ts",
+    "lib/promptRefinerShadowOperatorCore.ts",
+    "lib/promptRefinerShadowRunContract.ts",
+    "lib/promptRefinerShadowRunStore.ts",
+    "lib/promptRefinerShadowRunner.ts",
+    "lib/promptRefinerShadowSystemAudit.ts",
+    "lib/promptRefinerStageAdmissionCore.ts",
+    "prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql",
+    "prisma/schema.prisma",
+    "scripts/check-enum-constraints.mjs",
+    "scripts/check-protected-table-writers-core.mjs",
+    "tests/gitleaksAllowlist.test.mjs",
+    "tests/integration/prompt-refiner-shadow-run.db.test.ts",
+    "tests/marketingAutomationAccess.test.mjs",
+    "tests/promptRefinerReservationCore.test.mjs",
+    "tests/promptRefinerRuntimeSourceClosure.test.mjs",
+    "tests/promptRefinerShadowAdmissionCore.test.mjs",
+    "tests/promptRefinerShadowEvidenceCore.test.mjs",
+    "tests/promptRefinerShadowOperatorCore.test.mjs",
+    "tests/promptRefinerShadowRunContract.test.mjs",
+    "tests/promptRefinerShadowRunner.test.mjs",
+    "tests/promptRefinerStageAdmissionReader.test.mjs",
+    "tests/server-contract/admin-prompt-refiner-shadow-execution-route.test.ts",
+    "tests/server-contract/admin-prompt-refiner-shadow-run-route.test.ts",
+    "tests/server-contract/admin-prompt-refiner-shadow-stage-route.test.ts"
+  ],
+  "generatedPaths": [
+    "docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4",
+    "docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-followup-v2/records",
+    "docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-integration-v3/records"
+  ]
+}
diff --git a/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4.authorization.md b/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4.authorization.md
new file mode 100644
index 00000000..ef165b45
--- /dev/null
+++ b/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4.authorization.md
@@ -0,0 +1,21 @@
+# Prompt Refiner confirmatory shadow v4 구현·검토 승인 기록
+
+- approvedBy: `mposition`
+- approvedAt: `2026-09-21` (Australia/Brisbane)
+- author: `codex`
+- independentReviewer: `claude-code-max`
+
+사용자는 Tomverse Chat 개발율 100%까지 권장 순서에 따라 자동 개발을 계속하도록
+승인했고, 독립 검토가 필요할 때 Claude Code Max 검토를 받도록 지시했다. 이번 작업은
+완료된 합성 shadow v3의 후속인 confirmatory v4 계약과 content-free evidence writer를
+구현하는 범위다. Claude 검토의 `--skip-preflight` 예외와 수정 round 상한 없음도 승인됐다.
+
+이 승인은 소스·migration·테스트·운영 문서 구현과 읽기 전용 독립 검토에만 적용한다.
+provider 호출, Railway flag 변경, stage/run 승인, 유료 shadow 실행, 제품 Prompt Refiner
+노출, Router 결합, rollout 또는 merge 권한으로 해석하지 않는다. 실제 v4 실행은 exact
+배포·비용표와 별도 운영 승인을 다시 결속해야 한다.
+
+Claude 호출은 저장된 `claude.ai` Max 구독만 사용한다. 호출 직전
+`ANTHROPIC_API_KEY`와 `ANTHROPIC_AUTH_TOKEN`을 제거하고 `loggedIn=true`,
+`authMethod=claude.ai`, `apiProvider=firstParty`, `subscriptionType=max`를 확인한다.
+reviewer는 Read/Grep/Glob 전용이며 source를 수정하지 않는다.
diff --git a/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4.task.json b/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4.task.json
new file mode 100644
index 00000000..dd108558
--- /dev/null
+++ b/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4.task.json
@@ -0,0 +1,64 @@
+{
+  "taskId": "prompt-refiner-confirmatory-shadow-v4",
+  "requirement": "CHAT-01 Prompt Refiner의 새 confirmatory shadow v4를 구현한다. v4는 새 stage/reservation/run authority로 v3의 소진·만료된 권한과 분리하고, provider가 반환한 refined prompt를 runner 메모리에서 동결 evidence spec으로 평가한 뒤 proposal bytes나 per-item content digest 없이 closed case evidence만 terminal receipt와 같은 transaction에 영속화한다. 완주 뒤 DB의 content-free case evidence와 telemetry만으로 aggregate gate bundle을 재구성할 수 있어야 한다. 배포만으로 stage/run/flag/provider 호출은 발생하지 않으며 실제 유료 실행은 별도 exact 승인 전까지 금지한다. author는 Codex, reviewer는 Claude Code Max다.",
+  "completionCriteria": [
+    "stage/reservation/run v4 identity와 digest가 v3 row를 보존하면서 새 권한을 별도 생성하도록 schema, migration, application validation과 audit metadata에 일치한다.",
+    "v4 source closure가 evidence core/spec, runner/writer, schema/migration과 모든 runtime dependency의 exact bytes를 결속한다.",
+    "runner는 suggested proposal을 메모리에서만 평가하고 failed/unknown을 포함한 content-free case evidence를 terminal writer에 전달한 뒤 proposal을 저장·로그·API 반환하지 않는다.",
+    "terminal writer는 case evidence shape/status/spec binding을 strict 검증하고 terminal receipt·audit·attempt evidence를 한 transaction에 기록하며 동일 facts replay만 허용한다.",
+    "완료된 v4 run은 저장된 case evidence와 cost/latency telemetry만으로 동결 aggregate bundle을 재구성하고 pass/fail/insufficient를 반환하며 제품·Router·유료 권한은 모두 false다.",
+    "v3 기존 row와 terminal receipt는 변경·재해석하지 않고 v4 migration은 seed, backfill, provider call 또는 flag 변경을 수행하지 않는다.",
+    "전체 unit, focused Prompt Refiner, DB integration/contract, TypeScript, ESLint, 문서·정책·schema·protected-writer 검사가 통과한다.",
+    "Claude verdict는 exact package digest에 결속하고 actionable finding마다 location, severity, evidence와 reproduction을 기록한다.",
+    "재귀적인 audit diff 팽창을 막기 위해 이 exchange의 package output 디렉터리만 reviewed diff에서 제외하며 task, authorization, 구현·테스트·migration·운영 문서는 모두 검토 대상에 남고 package, exchange, events, failure, verdict 기록은 저장소에 보존한다."
+  ],
+  "baseCommit": "388cb319cd657da468ae99711b24c7fe8a44a012",
+  "writableScope": [
+    "app/api/admin/prompt-refiner/shadow-run/execute/route.ts",
+    "app/api/admin/prompt-refiner/shadow-run/route.ts",
+    "components/admin/AdminPromptRefinerShadowPanel.tsx",
+    "docs/ops/cross-review/packages",
+    "docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4.authorization.md",
+    "docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4.task.json",
+    "docs/ops/prompt-refiner-confirmatory-shadow-v4.md",
+    "docs/ops/prompt-refiner-durable-stage-writer-contract.md",
+    "docs/ops/prompt-refiner-durable-stage-writer-task.md",
+    "docs/ops/prompt-refiner-durable-run-writer-contract.md",
+    "docs/ops/tomverse-chat-progress.md",
+    "docs/policy/prompt-refiner-durable-stage-writer-threat-model.md",
+    "docs/policy/prompt-refiner-observability.md",
+    "lib/adminMessages/promptRefinerShadow.ts",
+    "lib/marketingAutomationAccess.ts",
+    "lib/promptRefinerReservationAuthority.ts",
+    "lib/promptRefinerReservationCore.ts",
+    "lib/promptRefinerShadowAdmissionCore.ts",
+    "lib/promptRefinerShadowEvidenceCore.ts",
+    "lib/promptRefinerShadowOperatorCore.ts",
+    "lib/promptRefinerShadowRunContract.ts",
+    "lib/promptRefinerShadowRunner.ts",
+    "lib/promptRefinerShadowRunStore.ts",
+    "lib/promptRefinerShadowSystemAudit.ts",
+    "lib/promptRefinerStageAdmission.ts",
+    "lib/promptRefinerStageAdmissionCore.ts",
+    "prisma/schema.prisma",
+    "prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql",
+    "scripts/check-enum-constraints.mjs",
+    "scripts/check-protected-table-writers-core.mjs",
+    "tests/adminPromptRefinerShadowOperator.test.mjs",
+    "tests/integration/prompt-refiner-reservation-admission.db.test.ts",
+    "tests/integration/prompt-refiner-shadow-run.db.test.ts",
+    "tests/promptRefinerReservationCore.test.mjs",
+    "tests/promptRefinerRuntimeSourceClosure.test.mjs",
+    "tests/promptRefinerShadowAdmissionCore.test.mjs",
+    "tests/promptRefinerShadowEvidenceCore.test.mjs",
+    "tests/promptRefinerShadowOperatorCore.test.mjs",
+    "tests/promptRefinerShadowRunContract.test.mjs",
+    "tests/promptRefinerShadowRunner.test.mjs",
+    "tests/promptRefinerStageAdmissionReader.test.mjs",
+    "tests/promptRefinerStageAdmissionCore.test.mjs",
+    "tests/server-contract/admin-prompt-refiner-shadow-execution-route.test.ts",
+    "tests/server-contract/admin-prompt-refiner-shadow-run-route.test.ts",
+    "tests/server-contract/admin-prompt-refiner-shadow-stage-route.test.ts"
+  ],
+  "generatedPaths": []
+}
diff --git a/docs/ops/prompt-refiner-confirmatory-shadow-v4.md b/docs/ops/prompt-refiner-confirmatory-shadow-v4.md
new file mode 100644
index 00000000..53ab8650
--- /dev/null
+++ b/docs/ops/prompt-refiner-confirmatory-shadow-v4.md
@@ -0,0 +1,88 @@
+# Prompt Refiner confirmatory shadow v4 계약
+
+상태: **구현 승인됨, provider 실행·제품 노출 미승인**
+
+구현 승인 기록: `mposition`, 2026-09-21 (Australia/Brisbane). 이 승인은
+confirmatory shadow v4의 계약, content-free evidence 저장·재구성, 관리자 표시와
+독립 검토에만 적용한다. provider 호출, 유료 실행, 제품 Chat 연결, 제안형 UI 공개,
+Router 결합 또는 rollout을 승인하지 않는다.
+
+## 1. 목적과 버전 경계
+
+이 회차는 완료된 `prompt-refiner-shadow-v1` / `prompt-refiner-shadow-run-v3`를
+수정하거나 소급 평가하지 않는다. 새 권한은 다음 별도 identity를 사용한다.
+
+- reservation stage: `prompt-refiner-shadow-v2`
+- stage admission: `prompt-refiner-stage-admission-v2`
+- runtime source manifest: `prompt-refiner-runtime-source-manifest-v3`
+- execution manifest: `prompt-refiner-shadow-execution-manifest-v2`
+- run: `prompt-refiner-shadow-run-v4`
+
+기존 v1/v3 행은 이전 187-file 계약과 nullable evidence를 유지한다. v2/v4 행만
+188-file 계약과 case별 evidence를 요구한다. migration은 행을 seed하거나 기존 행을
+backfill하지 않는다.
+
+stage proposal v1은 과거 provider-free evidence에 결속된 역사적 byte identity이므로 그
+내부의 `prompt-refiner-shadow-v1` 및 v1 reservation digest를 수정하지 않는다. 이는 현행
+authority 선언이 아니다. 새 `prompt-refiner-shadow-v2`와 v2 reservation digest는 stage의
+execution manifest, runtime manifest v3 및 DB CHECK가 별도로 결속하며 application validation도
+그 현행 manifest를 authority로 사용한다.
+
+## 2. 현행 runtime 결속
+
+관리자 stage preview와 create-only writer는 승인 시점 staging deployment의 full commit
+SHA, Railway deployment id와 **188개 고정 source 파일**의 exact bytes를 결속한다.
+188개 중 178개는 8개 실행 root의 local TypeScript/JavaScript runtime import closure이며,
+나머지 10개는 resolution metadata와 Prisma schema 및 두 migration이다. 파일당 8 MiB,
+전체 16 MiB 상한을 적용한다.
+
+PostgreSQL validator는 v3 manifest에서 새 migration이 정확한 정렬 위치에 한 번만 있는지
+검사하고, 그것을 제거해 만든 187-file v2 manifest도 기존 validator로 다시 검증한다.
+따라서 새 wrapper가 과거 계약을 느슨하게 재구현하지 않는다.
+
+## 3. evidence 저장 경계
+
+Refiner 결과 문자열은 요청 처리 중 메모리에서만 평가하고 DB, audit, 응답 또는 로그에
+저장하지 않는다. terminal transaction은 다음을 원자적으로 기록한다.
+
+1. 고정 case identity와 terminal reason
+2. token·cost·latency receipt
+3. strict `PromptRefinerShadowCaseEvidence` JSON
+4. 같은 evidence를 결속한 hash-chained system audit
+
+terminal replay는 reason, usage, latency와 evidence가 모두 정확히 같을 때만 idempotent하다.
+DB CHECK와 trigger는 v4 terminal에 evidence object가 없거나 case/status/audit 결속이
+다르면 거부한다. latency는 application writer와 DB CHECK 모두 0~60,000ms로 제한해 저장된
+terminal이 aggregate validator에서 재구성 불가능해지는 상태를 막는다. unknown sweep도
+prompt 없이 결정적인 insufficient evidence를 만든다.
+
+완료된 16개 terminal row는 고정 corpus와 evidence spec으로 다시 검증한 뒤 aggregate
+bundle을 재구성한다. 누락·순서 변경·위조·내부 불일치는 fail-closed다. 관리자 API는
+제품 권한을 열지 않는 content-free gate outcome과 집계만 표시한다.
+
+## 4. 비권한성
+
+v4 run contract의 `entryPointReady`와 `executionAdmitted`는 owner-only shadow 실행 경로가
+계약상 존재하므로 `true`다. 그러나 이 구현 승인이나 evidence pass만으로 실제 provider
+실행 권한이 생기지는 않는다. provider 실행에는 별도 비용 승인, 정확한 stage/run 승인과
+default-off execution flag가 모두 필요하다.
+
+다음 제품 권한은 계속 false다.
+
+- `productAdapterReady`
+- `suggestionUiAuthorized`
+- `routerCouplingAuthorized`
+- `paidRunAuthorized`
+
+제품 Chat 또는 Router는 이 경로를 import할 수 없다.
+
+## 5. 검증 기준
+
+- 빈 PostgreSQL에서 전체 migration 적용 및 schema drift 0
+- v1/v3 legacy 행·제약 보존과 v2/v4 create-only 분리
+- case evidence와 terminal audit의 같은 transaction 결속
+- content-bearing 필드 저장·응답·로그 부재
+- 16-case durable aggregate의 순서·완전성·threshold 재계산
+- owner-only, recent-auth, origin, rate-limit 관리자 경계
+- full unit, server-contract, DB integration, typecheck, lint 및 저장소 gate 통과
+- Claude Code Max 독립 검토 승인
diff --git a/docs/ops/prompt-refiner-durable-stage-writer-contract.md b/docs/ops/prompt-refiner-durable-stage-writer-contract.md
index 03e73a21..a5d1f996 100644
--- a/docs/ops/prompt-refiner-durable-stage-writer-contract.md
+++ b/docs/ops/prompt-refiner-durable-stage-writer-contract.md
@@ -2,22 +2,24 @@
 
 ## 1. 불변 식별자
 
-- stage: `prompt-refiner-shadow-v1`
-- admission: `prompt-refiner-stage-admission-v1`
+- stage: `prompt-refiner-shadow-v2` (`prompt-refiner-shadow-v1`은 완료된 legacy 행으로 보존)
+- admission: `prompt-refiner-stage-admission-v2`
 - approval TTL: 정확히 60분
 - environment: `staging`만
-- confirmation: `APPROVE PROMPT REFINER SHADOW STAGE V1 FOR 60 MINUTES`
+- confirmation: `APPROVE PROMPT REFINER SHADOW STAGE V2 FOR 60 MINUTES`
 - 감사 reason은 클라이언트 입력이 아니라 서버 내부 상수 `bounded_staging_shadow_cost_approval`로만 기록한다.
 
-과거 proposal/evidence/corpus/source digest와 reservation/execution contract의 실제 값은
-코드와 migration CHECK에 함께 고정된다. 운영자는 값을 request로 교체할 수 없다.
+과거 v1 proposal/evidence/corpus/source digest는 그대로 재검증하지만, 현행 v2 reservation
+authority는 v2 execution manifest가 별도로 결속한다. 과거 proposal 안의 v1 stage 표기는
+과거 승인 제안의 byte identity이며 현행 stage identity가 아니다. 두 계약의 실제 값은 코드와
+migration CHECK에 함께 고정되고 운영자는 값을 request로 교체할 수 없다.
 
 ## 2. GET preview
 
 `GET /api/admin/prompt-refiner/shadow-stage`
 
 인증된 owner와 최근 인증을 요구한다. DB mutation, rate-limit 소비, stage/audit 생성은 없다.
-서버가 과거 evidence를 replay하고 현재 deployment의 187개 고정 source 파일 raw bytes를 읽어
+서버가 과거 evidence를 replay하고 현재 deployment의 188개 고정 source 파일 raw bytes를 읽어
 proposal/runtime-source/execution digest, commit, deployment, 고정 비용·slot·TTL과
 `executionAdmitted:false`, `productAdapterReady:false`를 반환한다. 또한 environment,
 deployment id, commit SHA, 세 digest, 비용·capacity·TTL 전체의 canonical JSON을 결속한
@@ -35,7 +37,7 @@ body는 4 KiB 이하 strict JSON이고 다음 다섯 필드만 허용한다.
   "runtimeSourceManifestDigest": "sha256:<64 hex>",
   "executionManifestDigest": "sha256:<64 hex>",
   "previewBindingDigest": "sha256:<64 hex>",
-  "confirmation": "APPROVE PROMPT REFINER SHADOW STAGE V1 FOR 60 MINUTES"
+  "confirmation": "APPROVE PROMPT REFINER SHADOW STAGE V2 FOR 60 MINUTES"
 }
 ```
 
@@ -63,7 +65,7 @@ stage를 200으로 반환하며 audit을 추가하지 않는다. actor 또는 im
 
 ## 5. 저장 manifest
 
-runtime source manifest v2는 schema version, full commit SHA, 정렬된 고정 경로 각각의 byte
+runtime source manifest v3는 schema version, full commit SHA, 정렬된 고정 경로 각각의 byte
 size와 SHA-256 및 검증된 총 byte 수만 담는다. 8 MiB/file과 16 MiB/closure를 모두
 fail-closed로 적용한다. execution manifest는 고정 reservation/execution contract,
 cost/capacity와 두 false readiness boolean만 담는다. 두 JSON 모두 strict canonical digest로
@@ -75,9 +77,9 @@ error/body는 담지 않는다.
 - migration은 기존 stage가 있으면 중단하고 seed/backfill하지 않는다.
 - writer가 UTC로 정규화한 한 DB clock snapshot으로 승인·만료 시각을 audit metadata와 stage 양쪽에
   기록하고, INSERT trigger는 두 값이 정확히 일치하지 않으면 거부한다.
-- DB CHECK는 187개 경로의 순서·exact key set·개별/총 크기·lowercase SHA-256 shape와 두 canonical
+- DB CHECK는 188개 경로의 순서·exact key set·개별/총 크기·lowercase SHA-256 shape와 두 canonical
   digest를 다시 계산하고 execution manifest의 canonical digest도 다시 계산한다.
-- 187개 중 178개 TypeScript/JavaScript source는 8개 실행 root에서 현재 parser가 지원하는
+- 188개 중 178개 TypeScript/JavaScript source는 8개 실행 root에서 현재 parser가 지원하는
   static import/re-export, literal dynamic import, literal `require`, require alias,
   `module.require`와 `createRequire` 호출로 도달하는 local runtime 폐쇄와 같아야 한다.
   `node:module`과 `module`은 같은 builtin으로 취급하고 named·default·namespace import의
@@ -86,8 +88,8 @@ error/body는 담지 않는다.
   `require("node:module")` 또는 `module.require("module")`의 반환값에서 곧바로
   `createRequire`/`_load` 등을 호출하는 체인도 별칭 추적을 우회할 수 있으므로 거부한다.
   type-only import는 제외하고, 해석할 수 없는 local 또는 non-literal runtime import도
-  테스트에서 거부한다. 나머지 9개는 root/workspace package metadata와
-  TypeScript/Prisma/migration 형식을 결속하는 고정 파일이다. 경로 해석은 checked-in
+  테스트에서 거부한다. 나머지 10개는 root/workspace package metadata와
+  TypeScript/Prisma/two-migration 형식을 결속하는 고정 파일이다. 경로 해석은 checked-in
   `tsconfig` compiler option과 workspace package exports를 사용한다. closure 검사는 현재
   실행 폐쇄에서 사용하는 `process.env`, 직접 `process.cwd()`, 고정 operational state용
   `globalThis.__tomverseOperationalState`, `lib/prisma.ts`의 정확한
diff --git a/docs/ops/prompt-refiner-durable-stage-writer-task.md b/docs/ops/prompt-refiner-durable-stage-writer-task.md
index 8062bc61..7d1b7083 100644
--- a/docs/ops/prompt-refiner-durable-stage-writer-task.md
+++ b/docs/ops/prompt-refiner-durable-stage-writer-task.md
@@ -14,8 +14,10 @@ flag·credential·receipt writer를 연결하지 않는다.
 
 - 기존 `PromptRefinerReservationStage`의 additive migration
 - 승인 시점의 DB-owned 시각과 고정 60분 TTL
-- staging 환경, runtime commit, Railway deployment id, 187-file/16 MiB bounded exact-byte
+- staging 환경, runtime commit, Railway deployment id, 188-file/16 MiB bounded exact-byte
   runtime import-closure source manifest
+- 완료된 v1 proposal은 역사적 byte identity로 보존하고 현행 v2 reservation authority는
+  v2 execution manifest에 별도로 결속
 - 과거 proposal/evidence/corpus/source identity와 현재 execution manifest의 immutable 결속
 - owner 전용 관리자 GET preview와 POST create-only writer
 - advisory lock, DB rate limit, fixed confirmation, 최근 인증, 전역 CSRF
diff --git a/docs/ops/tomverse-chat-progress.md b/docs/ops/tomverse-chat-progress.md
index 5b9406e9..1df8f7bc 100644
--- a/docs/ops/tomverse-chat-progress.md
+++ b/docs/ops/tomverse-chat-progress.md
@@ -1179,7 +1179,7 @@ events와 최종 `exchange.json`의 감사 기록은 수정하지 않았다. 검
 ## 2026-09-17 Prompt Refiner durable stage writer 회차 (round 0 request_changes, 수정 검증·round 1 대기)
 
 앞 회차의 다음 순서 ①을 구현했다. 과거 admission proposal/evidence/corpus/source
-identity와 승인 시점 staging deployment의 full commit, exact 187-file runtime import-closure source manifest,
+identity와 승인 시점 staging deployment의 full commit, 당시 v1의 exact 187-file runtime import-closure source manifest,
 고정 execution manifest를 하나의 immutable stage에 결속한다. 승인 시각과 60분 expiry는
 DB clock이 소유하며, owner 전용 POST는 advisory lock 아래 tamper-evident success audit과
 stage insert를 한 transaction으로 처리한다. 동일 actor·동일 runtime의 exact replay만
@@ -1222,20 +1222,24 @@ provider admission은 열리지 않는다.
 ## 2026-09-20 Prompt Refiner durable stage writer 통합 완료 회차
 
 앞 회차의 durable DB provenance/admin writer를 최종 독립 검토와 Linux 통합 CI까지
-마쳤다. stage는 과거 evidence, 사람 승인·비용 상한, 승인 시점 staging deployment의
+마쳤다. 당시 v1 stage는 과거 evidence, 사람 승인·비용 상한, 승인 시점 staging deployment의
 full commit, 187개 고정 runtime import-closure 파일, execution manifest와 60분 DB-clock
 expiry를 한 행에 결속한다. owner 전용 preview/create는 advisory lock 아래 stage와
 tamper-evident audit을 같은 transaction으로 기록하며, exact replay만 idempotent하다.
 reserve/consume도 같은 stage-linked audit HMAC, runtime source와 execution manifest,
 expiry를 다시 검증한다.
 
-rebase 뒤 source closure와 정책 문서의 187개 전체·178개 runtime source·9개 metadata
+rebase 뒤 당시 v1 source closure와 정책 문서의 187개 전체·178개 runtime source·9개 metadata
 설명을 실제 계산값에 다시 결속했다. Linux CI에서만 드러난 관리자 route test loader의
 query-suffix named-export 차이는 제품 route를 바꾸지 않고 direct import와 명시적 auth
 mock으로 닫았다. provider/API/model/Railway/credential/receipt/제품 caller/flag를 연결하지
 않았고 `executionAdmitted`와 `productAdapterReady`는 계속 false다. migration은 stage를
 seed 또는 backfill하지 않으므로 이 병합만으로 유료 실행이나 제품 공개가 시작되지 않는다.
 
+후속 confirmatory v2/v4 현재 계약은 exact 188-file runtime import-closure source manifest를
+사용한다. 178개 runtime source와 10개 metadata/schema/migration 파일이며, v1의 187-file
+행과 manifest는 수정하거나 소급 재해석하지 않는다.
+
 ### 한눈에 보는 전체 Chat 진척
 
 | 항목 | 이번 판단 |
diff --git a/docs/policy/prompt-refiner-durable-stage-writer-threat-model.md b/docs/policy/prompt-refiner-durable-stage-writer-threat-model.md
index ae79e1cc..6f256fbb 100644
--- a/docs/policy/prompt-refiner-durable-stage-writer-threat-model.md
+++ b/docs/policy/prompt-refiner-durable-stage-writer-threat-model.md
@@ -37,7 +37,7 @@ journal/witness replay, corpus/source identity를 기존 proposal core로 다시
 | 만료된 승인을 서비스가 재사용 | reserve/consume이 DB clock, exact runtime facts, stage expiry를 재검증 |
 | 서비스 검사 우회 직접 reservation/consume | DB trigger가 stage approval expiry와 고정 contract를 다시 검사. application reserve/consume은 audit HMAC을 별도로 재검증해 위조 stage가 provider 경계로 진행하지 못하게 한다 |
 | model registry 또는 pricing drift | transaction에서 registry SHARE lock 후 exact execution contract 재검증 |
-| symlink/path traversal 또는 거대 파일 | import-closure로 검증되는 187개 고정 path allowlist, fd open/fstat, symlink component 거부, bounded read/post-fstat, 파일당 8 MiB 및 전체 16 MiB cap |
+| symlink/path traversal 또는 거대 파일 | import-closure로 검증되는 188개 고정 path allowlist, fd open/fstat, symlink component 거부, bounded read/post-fstat, 파일당 8 MiB 및 전체 16 MiB cap |
 | 보안 의존성 source drift 누락 | admin route/reservation/shadow execution/proxy root의 local runtime import 폐쇄를 TypeScript 실제 module resolution과 workspace exports로 재계산하고 TS↔SQL ordered path equality를 강제; type-only만 제외하며 aliased require/module.require/createRequire를 추적한다. `node:module`/`module`의 named·default·namespace `createRequire`는 지원하되 runtime re-export, dynamic namespace, 반환 namespace 직접 체이닝과 다른 module namespace surface는 거부한다. 현재 폐쇄에서 필요한 `process.env`, 직접 `process.cwd()`, 고정 operational state의 정확한 초기화와 Map `get`/`set`, `lib/prisma.ts`의 정확한 `globalForPrisma.prisma` singleton 필드, 검증된 `Reflect.apply` 캡처만 safe form으로 인정한다. Node `global`의 다른 직접·별칭 사용과 constructor/`__proto__`/임의 `prototype` chain, 열거된 Reflect/module/process/globalThis/eval/Function non-literal·간접 loader, unresolved local import를 거부한다. non-static element access는 기본 거부하고 현재 실행 폐쇄의 검토된 데이터 인덱싱만 path·line·column·정확한 source text의 정렬된 SHA-256 snapshot으로 동결한다. 접근의 추가·이동·표현 변경은 snapshot 불일치로 fail-closed하며, 갱신 전 loader/capability escape 여부를 별도 검토하고 negative fixture를 보강한다. 이 snapshot은 검토된 예외의 완전한 구조 목록이지 임의 JavaScript reflection 의미론의 증명이 아니다. snapshot 안의 `value[key]`를 유지한 채 다른 위치의 `key` binding 의미만 바꾸는 residual은 승인된 exact source-file bytes, full commit SHA와 deployment ID의 결속 및 독립 source review로 통제한다. |
 | prompt/credential/provider error가 provenance에 유입 | manifest schema는 path/size/hash와 고정 실행 숫자만 허용; audit reason은 request가 아니라 서버 내부 상수 |
 | 승인 endpoint 탐색·CSRF·탈취 session | 비관리자 404, owner-only, recent authentication, global origin guard, DB atomic rate limit |
diff --git a/docs/policy/prompt-refiner-observability.md b/docs/policy/prompt-refiner-observability.md
index ff01f15c..c02399be 100644
--- a/docs/policy/prompt-refiner-observability.md
+++ b/docs/policy/prompt-refiner-observability.md
@@ -1,5 +1,9 @@
 # Prompt Refiner receipt와 관측 계약
 
+구현 승인 기록: `mposition`, 2026-09-21 (Australia/Brisbane). 승인 범위는
+confirmatory shadow v4 계약과 content-free evidence writer의 구현·독립 검토까지이며,
+provider 호출·유료 실행·제품 노출·Router 결합은 포함하지 않는다.
+
 상태: **provider-independent 데이터·실행 사전등록·예약 authority 구현, 제품 수집 미연결**.
 
 이 문서는 Prompt Refiner 한 요청에서 무엇을 관측하고 어떤 분모로 읽는지를
@@ -42,8 +46,9 @@ profile 검사 결과를 과거에 캐시한 값이나 caller가 전달한 lease
 
 ## 0. Durable reservation authority 경계
 
-- stage는 `prompt-refiner-shadow-v1` 한 행으로 제한되며 요청당 24,916 microUSD,
-  최대 100개, 총 2,491,600 microUSD를 DB constraint와 transaction에서 함께 지킨다.
+- 완료된 legacy stage는 `prompt-refiner-shadow-v1`, confirmatory authority는
+  `prompt-refiner-shadow-v2`로 분리한다. 새 승인은 v2 한 행에만 생성되며 요청당 24,916
+  microUSD, 최대 100개, 총 2,491,600 microUSD를 DB constraint와 transaction에서 함께 지킨다.
 - reservation `BEFORE INSERT` trigger는 stage를 잠그고 정확한 계약·초기 상태·5분 TTL을
   검증만 한다. 성공한 행이 보이는 `AFTER INSERT` trigger만 실제 tombstone 집계와 stage
   counter를 결속한다. stage 최초 counter는 0/0이어야 하고 direct stage counter UPDATE는
@@ -295,17 +300,17 @@ mutation, seed, runtime receipt 또는 제품 호출 효과도 없다. 따라서
 실제 admin writer는 승인 직전에 현재 source·manifest·environment를 exact-byte로 다시
 검증하고, exact evidence digest, 승인자·승인 시각, environment, expiry와 실행 manifest를
 새 durable row에 함께 결속하는 migration과 운영 계약이 독립 검토된 뒤에만
-추가한다. 그 writer 전까지 현재 v1 admission의 fail-closed 결과와 default-off 제품 상태를
+추가한다. 그 writer 전까지 현재 v2 admission의 fail-closed 결과와 default-off 제품 상태를
 유지한다.
 
 ## 11. durable staging approval provenance
 
-후속 `prompt-refiner-stage-admission-v1`은 과거 proposal을 현재 staging 배포에 다시
+후속 `prompt-refiner-stage-admission-v2`는 과거 proposal을 현재 staging 배포에 다시
 결속하는 create-only 관리자 writer다. 과거 evidence는 매 preview/승인에서 strict core로
-다시 replay하고, 현재 runtime은 full commit SHA, Railway deployment id와 고정 187개 source
+다시 replay하고, 현재 runtime은 full commit SHA, Railway deployment id와 고정 188개 source
 파일의 exact bytes(개별/총 size와 SHA-256)를 canonical manifest로 만든다. 178개 source는
-admin/admission/reservation/shadow execution/proxy root의 local runtime import 폐쇄이며 9개는
-root/workspace resolution metadata를 포함한 고정 형식 파일이다. 파일당 8 MiB와 전체 16 MiB를
+admin/admission/reservation/shadow execution/proxy root의 local runtime import 폐쇄이며 10개는
+root/workspace resolution metadata, Prisma schema와 두 migration을 포함한 고정 형식 파일이다. 파일당 8 MiB와 전체 16 MiB를
 넘으면 거부한다. 별도 execution manifest는
 고정 모델·가격·output cap·retry·timeout·최악 비용·100 slot 계약을 담되
 `executionAdmitted=false`, `productAdapterReady=false`를 유지한다.
diff --git a/lib/adminMessages/promptRefinerShadow.ts b/lib/adminMessages/promptRefinerShadow.ts
index b93d2d49..c12752a9 100644
--- a/lib/adminMessages/promptRefinerShadow.ts
+++ b/lib/adminMessages/promptRefinerShadow.ts
@@ -43,6 +43,10 @@ export const adminPromptRefinerShadowMessages = defineAdminMessages({
     executionFlag: "Execution flag",
     dispatches: "Dispatches",
     terminals: "Terminals",
+    evidenceGate: "Evidence gate",
+    evidenceCases: "Evidence cases passed",
+    evidenceCost: "Evidence cost",
+    evidenceLatency: "Evidence latency p90 / max",
     nextCase: "Next case",
     inFlight: "In flight",
     enabled: "enabled",
@@ -110,6 +114,10 @@ export const adminPromptRefinerShadowMessages = defineAdminMessages({
     executionFlag: "실행 flag",
     dispatches: "dispatch",
     terminals: "terminal",
+    evidenceGate: "증거 게이트",
+    evidenceCases: "증거 통과 case",
+    evidenceCost: "증거 집계 비용",
+    evidenceLatency: "증거 지연 p90 / 최대",
     nextCase: "다음 case",
     inFlight: "진행 중",
     enabled: "활성",
diff --git a/lib/marketingAutomationAccess.ts b/lib/marketingAutomationAccess.ts
index 205e6abc..278dd4b5 100644
--- a/lib/marketingAutomationAccess.ts
+++ b/lib/marketingAutomationAccess.ts
@@ -193,6 +193,11 @@ export const computeMarketingWebhookPipelineFingerprint = (
  * an admission decision; the fingerprint moves because the closed file digest
  * deliberately requires this review whenever any schema bytes move.
  *
+ * 2026-09-21: Prompt Refiner confirmatory shadow v4 adds nullable evidence
+ * columns and a new attempt check to the same schema. Those additions do not
+ * touch a marketing model or admission decision; the watched-file digest still
+ * moves so the dependency is reviewed explicitly.
+ *
  * 2026-09-21, again: the same watched file, and this time the declared change
  * is a documentation comment. `SuppressionCause`'s model comment said the rows
  * were written beside `SuppressionEntry` and read by no send decision, which
@@ -204,7 +209,7 @@ export const computeMarketingWebhookPipelineFingerprint = (
  * defect. This was the look.
  */
 export const MARKETING_WEBHOOK_PIPELINE_FINGERPRINT =
-  "2e91a2bfe987ecd4c5dfed650523f3c3018e1908b5610b2214b29e4dea945570";
+  "79c43d3d43de3ccc6c95312f7835a0d78386c7b08bf395272816968fe7491b41";
 
 const sha256 = (value: string): string =>
   createHash("sha256").update(value, "utf8").digest("hex");
diff --git a/lib/promptRefinerReservationCore.ts b/lib/promptRefinerReservationCore.ts
index 05ebc87f..cf0e1fbe 100644
--- a/lib/promptRefinerReservationCore.ts
+++ b/lib/promptRefinerReservationCore.ts
@@ -13,9 +13,13 @@ import {
  * This module decides shapes and state only; it does not read or write a DB.
  */
 export const PROMPT_REFINER_RESERVATION_AUTHORITY_VERSION =
-    "prompt-refiner-reservation-authority-v1" as const;
+    "prompt-refiner-reservation-authority-v2" as const;
+export const PROMPT_REFINER_RESERVATION_STAGE_IDS = Object.freeze([
+    "prompt-refiner-shadow-v1",
+    "prompt-refiner-shadow-v2",
+] as const);
 export const PROMPT_REFINER_RESERVATION_STAGE_ID =
-    "prompt-refiner-shadow-v1" as const;
+    PROMPT_REFINER_RESERVATION_STAGE_IDS[1];
 export const PROMPT_REFINER_RESERVATION_TTL_MS = 5 * 60 * 1_000;
 
 export const PROMPT_REFINER_RESERVATION_STAGE_STATUSES = Object.freeze([
@@ -64,10 +68,12 @@ const computedReservationContractDigest = `sha256:${createHash("sha256")
     .digest("hex")}`;
 
 export const PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST =
-    "sha256:c5cc412eb47821d56f6eed2e837d11086a9ab744069715e90d33ea37a378d55f" as const;
+    "sha256:6b60c957793effe904d82748d9f7353d6490d150eff66ba4a02f1aac63f376d1" as const;
 
 if (computedReservationContractDigest !== PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST) {
-    throw new Error("Prompt Refiner reservation contract digest drifted");
+    throw new Error(
+        `Prompt Refiner reservation contract digest drifted: ${computedReservationContractDigest}`
+    );
 }
 
 export const PROMPT_REFINER_RESERVATION_REFUSALS = Object.freeze([
diff --git a/lib/promptRefinerShadowAdmissionCore.ts b/lib/promptRefinerShadowAdmissionCore.ts
index 0b5d3cf7..4df4961d 100644
--- a/lib/promptRefinerShadowAdmissionCore.ts
+++ b/lib/promptRefinerShadowAdmissionCore.ts
@@ -13,8 +13,6 @@ import {
     PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD,
 } from "./promptRefinerExecutionContract";
 import {
-    PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
-    PROMPT_REFINER_RESERVATION_STAGE_ID,
     PROMPT_REFINER_RESERVATION_TTL_MS,
 } from "./promptRefinerReservationCore";
 import {
@@ -99,6 +97,13 @@ export const PROMPT_REFINER_SHADOW_ADMISSION_MANIFEST_SHA256 =
     "9e15f6413083dd980fbd9003d9396d2c8519cacedba20fcb4bb951a796a7b73d" as const;
 export const PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_DIGEST =
     "sha256:75198565b0bcc1e481c89c6ac8946d11793d28b7afbd96e18d36a03a27f06cc2" as const;
+// These two values are part of the already-reviewed v1 proposal bytes. They
+// describe the historical proposal, not the live reservation authority. The
+// current v2 authority is bound independently by promptRefinerExecutionManifest.
+export const PROMPT_REFINER_SHADOW_PROPOSAL_RESERVATION_STAGE_ID =
+    "prompt-refiner-shadow-v1" as const;
+export const PROMPT_REFINER_SHADOW_PROPOSAL_RESERVATION_CONTRACT_DIGEST =
+    "sha256:c5cc412eb47821d56f6eed2e837d11086a9ab744069715e90d33ea37a378d55f" as const;
 
 const INTERNAL_ADMISSION_EVIDENCE_FILES = INTRINSIC_OBJECT_FREEZE([
     "admission-readiness-v1.report.json",
@@ -198,8 +203,8 @@ export type PromptRefinerShadowStageProposal = {
         journalSchemaVersion: typeof PROMPT_REFINER_SHADOW_JOURNAL_VERSION;
     }>;
     readonly reservationStage: Readonly<{
-        stageId: typeof PROMPT_REFINER_RESERVATION_STAGE_ID;
-        contractDigest: typeof PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST;
+        stageId: typeof PROMPT_REFINER_SHADOW_PROPOSAL_RESERVATION_STAGE_ID;
+        contractDigest: typeof PROMPT_REFINER_SHADOW_PROPOSAL_RESERVATION_CONTRACT_DIGEST;
         perRequestCostMicroUsd: typeof PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD;
         maxReservations: typeof PROMPT_REFINER_SHADOW_MAX_DISPATCHES;
         costCeilingMicroUsd: typeof PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD;
@@ -673,8 +678,9 @@ function trustedUnsignedProposal(): Omit<
             journalSchemaVersion: PROMPT_REFINER_SHADOW_JOURNAL_VERSION,
         },
         reservationStage: {
-            stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
-            contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+            stageId: PROMPT_REFINER_SHADOW_PROPOSAL_RESERVATION_STAGE_ID,
+            contractDigest:
+                PROMPT_REFINER_SHADOW_PROPOSAL_RESERVATION_CONTRACT_DIGEST,
             perRequestCostMicroUsd:
                 PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
             maxReservations: PROMPT_REFINER_SHADOW_MAX_DISPATCHES,
diff --git a/lib/promptRefinerShadowEvidenceCore.ts b/lib/promptRefinerShadowEvidenceCore.ts
index fbf242dc..88774bf4 100644
--- a/lib/promptRefinerShadowEvidenceCore.ts
+++ b/lib/promptRefinerShadowEvidenceCore.ts
@@ -34,6 +34,7 @@ export const PROMPT_REFINER_SHADOW_EVIDENCE_BUNDLE_VERSION =
 export const PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_DIGEST =
     "7794b9fbbd8fba1f16d19f935a977098f3f7a8d302014d6e7de3fe00813ae4c1" as const;
 export const PROMPT_REFINER_SHADOW_EVIDENCE_MAX_SPEC_BYTES = 64 * 1024;
+export const PROMPT_REFINER_SHADOW_EVIDENCE_MAX_DURATION_MS = 60_000;
 
 const LANGUAGES = ["ko", "en"] as const;
 const CATEGORIES = [
@@ -114,6 +115,14 @@ export type PromptRefinerShadowEvidenceRunCase = {
     costMicroUsd: number | null;
 };
 
+export type PromptRefinerShadowStoredEvidenceCase = {
+    caseId: string;
+    terminalStatus: EvidenceTerminalStatus;
+    evidence: PromptRefinerShadowCaseEvidence;
+    durationMs: number | null;
+    costMicroUsd: number | null;
+};
+
 export type PromptRefinerShadowEvidenceCaseFailure =
     | "not_suggested"
     | "source_not_changed"
@@ -448,13 +457,13 @@ export function validatePromptRefinerShadowEvidenceSpec(
             thresholds.maximumLatencyP90Ms,
             "maximum_latency_p90",
             1,
-            60_000
+            PROMPT_REFINER_SHADOW_EVIDENCE_MAX_DURATION_MS
         ),
         maximumLatencyMaxMs: safeInteger(
             thresholds.maximumLatencyMaxMs,
             "maximum_latency_max",
             1,
-            60_000
+            PROMPT_REFINER_SHADOW_EVIDENCE_MAX_DURATION_MS
         ),
     };
     if (parsedThresholds.maximumLatencyMaxMs < parsedThresholds.maximumLatencyP90Ms) {
@@ -663,6 +672,261 @@ function evaluateSuggestedCase(
     };
 }
 
+/**
+ * Evaluates one transient provider result. The returned object is content-free:
+ * callers must discard `refinedPrompt` immediately after this function returns.
+ */
+export function evaluatePromptRefinerShadowCaseEvidence(input: {
+    corpus: PromptRefinerShadowCorpus;
+    spec: PromptRefinerShadowEvidenceSpec;
+    caseIndex: number;
+    terminalStatus: EvidenceTerminalStatus;
+    refinedPrompt: string | null;
+}): PromptRefinerShadowCaseEvidence {
+    const corpus = validatePromptRefinerShadowCorpus(input.corpus);
+    if (corpus.contentDigest !== PROMPT_REFINER_SHADOW_CORPUS_DIGEST) {
+        fail("corpus_contract_digest_mismatch");
+    }
+    const spec = validatePromptRefinerShadowEvidenceSpec(input.spec);
+    const caseIndex = safeInteger(input.caseIndex, "case_index", 0, 15);
+    const sourceCase = corpus.cases[caseIndex]!;
+    const caseSpec = spec.cases[caseIndex]!;
+    if (
+        sourceCase.id !== EVIDENCE_CASE_IDS[caseIndex] ||
+        sourceCase.id !== caseSpec.id ||
+        sourceCase.language !== caseSpec.language ||
+        sourceCase.category !== caseSpec.category
+    ) {
+        fail("corpus_case_contract_mismatch");
+    }
+    if (input.terminalStatus === "suggested") {
+        const refinedPrompt = boundedString(
+            input.refinedPrompt,
+            "refined_prompt",
+            PROMPT_REFINER_MAX_PROMPT_BYTES
+        );
+        if (
+            refinedPrompt.length > PROMPT_REFINER_MAX_PROMPT_CHARS ||
+            Buffer.byteLength(refinedPrompt, "utf8") >
+                PROMPT_REFINER_SHADOW_MAX_OUTPUT_BYTES
+        ) {
+            fail("suggested_run_case_invalid");
+        }
+        return evaluateSuggestedCase(sourceCase, caseSpec, refinedPrompt);
+    }
+    if (input.refinedPrompt !== null) {
+        fail("non_suggested_run_case_has_prompt");
+    }
+    return failedOrUnknownEvidence(sourceCase, caseSpec, input.terminalStatus);
+}
+
+const nullableBoolean = (value: unknown, where: string): boolean | null => {
+    if (value !== null && typeof value !== "boolean") fail(`${where}_invalid`);
+    return value as boolean | null;
+};
+
+const evidenceFailureReasons = (
+    value: unknown
+): PromptRefinerShadowEvidenceCaseFailure[] => {
+    if (!Array.isArray(value) || value.length > 7) {
+        fail("stored_failure_reasons_invalid");
+    }
+    const allowed: readonly PromptRefinerShadowEvidenceCaseFailure[] = [
+        "not_suggested",
+        "source_not_changed",
+        "length_out_of_bounds",
+        "language_mismatch",
+        "required_concept_missing",
+        "exact_literal_missing",
+        "unsafe_injection_framing",
+    ];
+    const reasons = value.map((item) =>
+        enumValue(item, allowed, "stored_failure_reason")
+    );
+    if (new Set(reasons).size !== reasons.length) {
+        fail("stored_failure_reasons_duplicate");
+    }
+    return reasons;
+};
+
+/** Strictly validates the closed evidence shape accepted by the DB writer. */
+export function validatePromptRefinerShadowCaseEvidence(input: {
+    value: unknown;
+    spec: PromptRefinerShadowEvidenceSpec;
+    caseIndex: number;
+    terminalStatus: EvidenceTerminalStatus;
+}): PromptRefinerShadowCaseEvidence {
+    const spec = validatePromptRefinerShadowEvidenceSpec(input.spec);
+    const caseIndex = safeInteger(input.caseIndex, "case_index", 0, 15);
+    const caseSpec = spec.cases[caseIndex]!;
+    const object = strictBenchmarkObject(
+        input.value,
+        [
+            "caseId",
+            "language",
+            "category",
+            "terminalStatus",
+            "evidenceStatus",
+            "distinctFromSource",
+            "lengthWithinBounds",
+            "languageMatched",
+            "requiredConceptGroups",
+            "matchedConceptGroups",
+            "requiredExactLiterals",
+            "preservedExactLiterals",
+            "injectionSafelyFramed",
+            "lengthBucket",
+            "failureReasons",
+        ],
+        "stored_case_evidence"
+    );
+    if (
+        object.caseId !== caseSpec.id ||
+        object.language !== caseSpec.language ||
+        object.category !== caseSpec.category ||
+        object.terminalStatus !== input.terminalStatus
+    ) {
+        fail("stored_case_evidence_binding_mismatch");
+    }
+    const evidenceStatus = enumValue(
+        object.evidenceStatus,
+        ["pass", "fail", "insufficient_evidence"] as const,
+        "stored_evidence_status"
+    );
+    const distinctFromSource = nullableBoolean(
+        object.distinctFromSource,
+        "stored_distinct_from_source"
+    );
+    const lengthWithinBounds = nullableBoolean(
+        object.lengthWithinBounds,
+        "stored_length_within_bounds"
+    );
+    const languageMatched = nullableBoolean(
+        object.languageMatched,
+        "stored_language_matched"
+    );
+    const requiredConceptGroups = safeInteger(
+        object.requiredConceptGroups,
+        "stored_required_concept_groups",
+        1,
+        8
+    );
+    const matchedConceptGroups =
+        object.matchedConceptGroups === null
+            ? null
+            : safeInteger(
+                  object.matchedConceptGroups,
+                  "stored_matched_concept_groups",
+                  0,
+                  requiredConceptGroups
+              );
+    const requiredExactLiterals = safeInteger(
+        object.requiredExactLiterals,
+        "stored_required_exact_literals",
+        0,
+        8
+    );
+    const preservedExactLiterals =
+        object.preservedExactLiterals === null
+            ? null
+            : safeInteger(
+                  object.preservedExactLiterals,
+                  "stored_preserved_exact_literals",
+                  0,
+                  requiredExactLiterals
+              );
+    const injectionSafelyFramed = nullableBoolean(
+        object.injectionSafelyFramed,
+        "stored_injection_safely_framed"
+    );
+    const lengthValue =
+        object.lengthBucket === null
+            ? null
+            : enumValue(
+                  object.lengthBucket,
+                  ["shorter", "same", "up_to_2x", "up_to_4x", "over_4x"] as const,
+                  "stored_length_bucket"
+              );
+    const failureReasons = evidenceFailureReasons(object.failureReasons);
+    if (
+        requiredConceptGroups !== caseSpec.requiredConceptGroups.length ||
+        requiredExactLiterals !== caseSpec.exactLiterals.length
+    ) {
+        fail("stored_case_evidence_requirement_mismatch");
+    }
+    if (input.terminalStatus !== "suggested") {
+        const expectedStatus =
+            input.terminalStatus === "unknown" ? "insufficient_evidence" : "fail";
+        const expectedReasons =
+            input.terminalStatus === "failed" ? ["not_suggested"] : [];
+        if (
+            evidenceStatus !== expectedStatus ||
+            distinctFromSource !== null ||
+            lengthWithinBounds !== null ||
+            languageMatched !== null ||
+            matchedConceptGroups !== null ||
+            preservedExactLiterals !== null ||
+            injectionSafelyFramed !== null ||
+            lengthValue !== null ||
+            canonicalBenchmarkJson(failureReasons) !==
+                canonicalBenchmarkJson(expectedReasons)
+        ) {
+            fail("stored_non_suggested_evidence_invalid");
+        }
+    } else {
+        if (
+            distinctFromSource === null ||
+            lengthWithinBounds === null ||
+            languageMatched === null ||
+            matchedConceptGroups === null ||
+            preservedExactLiterals === null ||
+            lengthValue === null ||
+            (caseSpec.injection === null
+                ? injectionSafelyFramed !== null
+                : injectionSafelyFramed === null)
+        ) {
+            fail("stored_suggested_evidence_incomplete");
+        }
+        const expectedReasons: PromptRefinerShadowEvidenceCaseFailure[] = [];
+        if (!distinctFromSource) expectedReasons.push("source_not_changed");
+        if (!lengthWithinBounds) expectedReasons.push("length_out_of_bounds");
+        if (!languageMatched) expectedReasons.push("language_mismatch");
+        if (matchedConceptGroups !== requiredConceptGroups) {
+            expectedReasons.push("required_concept_missing");
+        }
+        if (preservedExactLiterals !== requiredExactLiterals) {
+            expectedReasons.push("exact_literal_missing");
+        }
+        if (injectionSafelyFramed === false) {
+            expectedReasons.push("unsafe_injection_framing");
+        }
+        if (
+            canonicalBenchmarkJson(failureReasons) !==
+                canonicalBenchmarkJson(expectedReasons) ||
+            evidenceStatus !== (expectedReasons.length === 0 ? "pass" : "fail")
+        ) {
+            fail("stored_suggested_evidence_inconsistent");
+        }
+    }
+    return {
+        caseId: caseSpec.id,
+        language: caseSpec.language,
+        category: caseSpec.category,
+        terminalStatus: input.terminalStatus,
+        evidenceStatus,
+        distinctFromSource,
+        lengthWithinBounds,
+        languageMatched,
+        requiredConceptGroups,
+        matchedConceptGroups,
+        requiredExactLiterals,
+        preservedExactLiterals,
+        injectionSafelyFramed,
+        lengthBucket: lengthValue,
+        failureReasons,
+    };
+}
+
 function validateRunCase(
     value: unknown,
     expectedId: string
@@ -681,7 +945,12 @@ function validateRunCase(
     const durationMs =
         object.durationMs === null
             ? null
-            : safeInteger(object.durationMs, "duration_ms", 0, 60_000);
+            : safeInteger(
+                  object.durationMs,
+                  "duration_ms",
+                  0,
+                  PROMPT_REFINER_SHADOW_EVIDENCE_MAX_DURATION_MS
+              );
     const costMicroUsd =
         object.costMicroUsd === null
             ? null
@@ -733,48 +1002,16 @@ function nearestRank(values: number[], percentile: number): number | null {
     return sorted[Math.ceil(percentile * sorted.length) - 1]!;
 }
 
-/**
- * Evaluates one complete synthetic shadow run. Inputs may contain proposal
- * text; outputs deliberately cannot.
- */
-export function evaluatePromptRefinerShadowEvidence(input: {
-    corpus: PromptRefinerShadowCorpus;
-    spec: PromptRefinerShadowEvidenceSpec;
-    cases: unknown;
-}): PromptRefinerShadowEvidenceBundle {
-    const corpus = validatePromptRefinerShadowCorpus(input.corpus);
-    if (corpus.contentDigest !== PROMPT_REFINER_SHADOW_CORPUS_DIGEST) {
-        fail("corpus_contract_digest_mismatch");
-    }
-    const spec = validatePromptRefinerShadowEvidenceSpec(input.spec);
-    if (!Array.isArray(input.cases) || input.cases.length !== 16) {
-        fail("run_requires_16_cases");
-    }
-    const runCases = input.cases.map((candidate, index) =>
-        validateRunCase(candidate, EVIDENCE_CASE_IDS[index]!)
-    );
-    const cases = corpus.cases.map((sourceCase, index) => {
-        const caseSpec = spec.cases[index]!;
-        const runCase = runCases[index]!;
-        if (
-            sourceCase.id !== caseSpec.id ||
-            sourceCase.language !== caseSpec.language ||
-            sourceCase.category !== caseSpec.category
-        ) {
-            fail("corpus_case_contract_mismatch");
-        }
-        return runCase.terminalStatus === "suggested"
-            ? evaluateSuggestedCase(
-                  sourceCase,
-                  caseSpec,
-                  runCase.refinedPrompt!
-              )
-            : failedOrUnknownEvidence(
-                  sourceCase,
-                  caseSpec,
-                  runCase.terminalStatus
-              );
-    });
+type ContentFreeRunFact = Pick<
+    PromptRefinerShadowStoredEvidenceCase,
+    "terminalStatus" | "durationMs" | "costMicroUsd"
+>;
+
+function buildEvidenceBundle(
+    spec: PromptRefinerShadowEvidenceSpec,
+    cases: PromptRefinerShadowCaseEvidence[],
+    runCases: ContentFreeRunFact[]
+): PromptRefinerShadowEvidenceBundle {
     const suggestedCases = runCases.filter(
         (item) => item.terminalStatus === "suggested"
     ).length;
@@ -820,17 +1057,11 @@ export function evaluatePromptRefinerShadowEvidence(input: {
         durations.length === runCases.length ? Math.max(...durations) : null;
     const gateReasons: PromptRefinerShadowEvidenceGateReason[] = [];
     if (passedCases !== spec.thresholds.requiredCasePasses) {
-        if (failedEvidenceCases > 0) {
-            gateReasons.push("case_evidence_failed");
-        }
-        if (incompleteEvidenceCases > 0) {
-            gateReasons.push("case_evidence_incomplete");
-        }
+        if (failedEvidenceCases > 0) gateReasons.push("case_evidence_failed");
+        if (incompleteEvidenceCases > 0) gateReasons.push("case_evidence_incomplete");
     }
     if (passedInjectionCases !== spec.thresholds.requiredInjectionPasses) {
-        if (failedInjectionCases > 0) {
-            gateReasons.push("injection_evidence_failed");
-        }
+        if (failedInjectionCases > 0) gateReasons.push("injection_evidence_failed");
         if (incompleteInjectionCases > 0) {
             gateReasons.push("injection_evidence_incomplete");
         }
@@ -914,3 +1145,126 @@ export function evaluatePromptRefinerShadowEvidence(input: {
         ],
     };
 }
+
+/** Rebuilds an aggregate using only durable content-free case evidence. */
+export function aggregatePromptRefinerShadowStoredEvidence(input: {
+    corpus: PromptRefinerShadowCorpus;
+    spec: PromptRefinerShadowEvidenceSpec;
+    cases: unknown;
+}): PromptRefinerShadowEvidenceBundle {
+    const corpus = validatePromptRefinerShadowCorpus(input.corpus);
+    if (corpus.contentDigest !== PROMPT_REFINER_SHADOW_CORPUS_DIGEST) {
+        fail("corpus_contract_digest_mismatch");
+    }
+    const spec = validatePromptRefinerShadowEvidenceSpec(input.spec);
+    if (!Array.isArray(input.cases) || input.cases.length !== 16) {
+        fail("stored_run_requires_16_cases");
+    }
+    const rows = input.cases.map((candidate, index) => {
+        const object = strictBenchmarkObject(
+            candidate,
+            ["caseId", "terminalStatus", "evidence", "durationMs", "costMicroUsd"],
+            "stored_evidence_run_case"
+        );
+        if (object.caseId !== EVIDENCE_CASE_IDS[index]) {
+            fail("stored_run_case_id_or_order_mismatch");
+        }
+        const terminalStatus = enumValue(
+            object.terminalStatus,
+            TERMINAL_STATUSES,
+            "stored_terminal_status"
+        );
+        const durationMs =
+            object.durationMs === null
+                ? null
+                : safeInteger(
+                      object.durationMs,
+                      "stored_duration_ms",
+                      0,
+                      PROMPT_REFINER_SHADOW_EVIDENCE_MAX_DURATION_MS
+                  );
+        const costMicroUsd =
+            object.costMicroUsd === null
+                ? null
+                : safeInteger(
+                      object.costMicroUsd,
+                      "stored_cost_micro_usd",
+                      0,
+                      100_000_000
+                  );
+        if (terminalStatus === "suggested" && durationMs === null) {
+            fail("stored_suggested_case_missing_duration");
+        }
+        if (terminalStatus === "failed" && durationMs === null) {
+            fail("stored_failed_case_missing_duration");
+        }
+        if (
+            terminalStatus === "unknown" &&
+            (durationMs !== null || costMicroUsd !== null)
+        ) {
+            fail("stored_unknown_case_claims_metrics");
+        }
+        return {
+            caseId: EVIDENCE_CASE_IDS[index]!,
+            terminalStatus,
+            evidence: validatePromptRefinerShadowCaseEvidence({
+                value: object.evidence,
+                spec,
+                caseIndex: index,
+                terminalStatus,
+            }),
+            durationMs,
+            costMicroUsd,
+        };
+    });
+    return buildEvidenceBundle(
+        spec,
+        rows.map((row) => row.evidence),
+        rows
+    );
+}
+
+/**
+ * Evaluates one complete synthetic shadow run. Inputs may contain proposal
+ * text; outputs deliberately cannot.
+ */
+export function evaluatePromptRefinerShadowEvidence(input: {
+    corpus: PromptRefinerShadowCorpus;
+    spec: PromptRefinerShadowEvidenceSpec;
+    cases: unknown;
+}): PromptRefinerShadowEvidenceBundle {
+    const corpus = validatePromptRefinerShadowCorpus(input.corpus);
+    if (corpus.contentDigest !== PROMPT_REFINER_SHADOW_CORPUS_DIGEST) {
+        fail("corpus_contract_digest_mismatch");
+    }
+    const spec = validatePromptRefinerShadowEvidenceSpec(input.spec);
+    if (!Array.isArray(input.cases) || input.cases.length !== 16) {
+        fail("run_requires_16_cases");
+    }
+    const runCases = input.cases.map((candidate, index) =>
+        validateRunCase(candidate, EVIDENCE_CASE_IDS[index]!)
+    );
+    const cases = corpus.cases.map((sourceCase, index) => {
+        const caseSpec = spec.cases[index]!;
+        const runCase = runCases[index]!;
+        if (
+            sourceCase.id !== caseSpec.id ||
+            sourceCase.language !== caseSpec.language ||
+            sourceCase.category !== caseSpec.category
+        ) {
+            fail("corpus_case_contract_mismatch");
+        }
+        return runCase.terminalStatus === "suggested"
+            ? evaluateSuggestedCase(
+                  sourceCase,
+                  caseSpec,
+                  runCase.refinedPrompt!
+              )
+            : failedOrUnknownEvidence(
+                  sourceCase,
+                  caseSpec,
+                  runCase.terminalStatus
+              );
+    });
+    return buildEvidenceBundle(spec, cases, runCases);
+}
diff --git a/lib/promptRefinerShadowOperatorCore.ts b/lib/promptRefinerShadowOperatorCore.ts
index 3473b774..887e12fd 100644
--- a/lib/promptRefinerShadowOperatorCore.ts
+++ b/lib/promptRefinerShadowOperatorCore.ts
@@ -10,6 +10,19 @@
 const DIGEST = /^sha256:[a-f0-9]{64}$/;
 const HEX_DIGEST = /^[a-f0-9]{64}$/;
 const FULL_SHA = /^[a-f0-9]{40}$/;
+const EVIDENCE_GATE_REASONS = new Set([
+  "case_evidence_failed",
+  "case_evidence_incomplete",
+  "injection_evidence_failed",
+  "injection_evidence_incomplete",
+  "terminal_failure_present",
+  "unknown_present",
+  "cost_incomplete",
+  "cost_threshold_exceeded",
+  "latency_incomplete",
+  "latency_p90_exceeded",
+  "latency_max_exceeded",
+]);
 
 export const PROMPT_REFINER_SHADOW_OPERATOR_PATH =
   "/admin/prompt-refiner-shadow" as const;
@@ -21,8 +34,8 @@ export const PROMPT_REFINER_SHADOW_EXECUTION_PATH =
   "/api/admin/prompt-refiner/shadow-run/execute" as const;
 
 export const PROMPT_REFINER_SHADOW_OPERATOR_CONTRACT = Object.freeze({
-  stageId: "prompt-refiner-shadow-v1",
-  runId: "prompt-refiner-shadow-run-v3",
+  stageId: "prompt-refiner-shadow-v2",
+  runId: "prompt-refiner-shadow-run-v4",
   environment: "staging",
   provider: "openai",
   modelId: "gpt-5-6-luna",
@@ -40,11 +53,11 @@ export const PROMPT_REFINER_SHADOW_OPERATOR_CONTRACT = Object.freeze({
   tokenizerEncoding: "o200k_base",
   maxInputTokens: 100_000,
   stageConfirmation:
-    "APPROVE PROMPT REFINER SHADOW STAGE V1 FOR 60 MINUTES",
+    "APPROVE PROMPT REFINER SHADOW STAGE V2 FOR 60 MINUTES",
   runConfirmation:
-    "APPROVE PROMPT REFINER SHADOW RUN V3 FOR THE DISPLAYED COST CEILING",
+    "APPROVE PROMPT REFINER SHADOW RUN V4 FOR THE DISPLAYED COST CEILING",
   executionConfirmation:
-    "EXECUTE THE APPROVED PROMPT REFINER SHADOW RUN V3 ONCE",
+    "EXECUTE THE APPROVED PROMPT REFINER SHADOW RUN V4 ONCE",
 });
 
 type UnknownRecord = Record<string, unknown>;
@@ -92,6 +105,7 @@ export type PromptRefinerRunPreview = Readonly<{
   stageApprovalExpiresAt: string;
   runContractDigest: string;
   corpusDigest: string;
+  evidenceSpecDigest: string;
   adapterVersion: string;
   provider: string;
   modelId: string;
@@ -126,9 +140,28 @@ export type PromptRefinerExecutionPreview = Readonly<{
   runContractDigest: string;
   enabled: boolean;
   confirmation: string;
+  evidence: PromptRefinerExecutionEvidence | null;
   productAdapterReady: false;
 }>;
 
+export type PromptRefinerExecutionEvidence = Readonly<{
+  gateOutcome: "pass" | "fail" | "insufficient_evidence";
+  gateReasons: readonly string[];
+  summary: Readonly<{
+    attemptedCases: number;
+    suggestedCases: number;
+    failedCases: number;
+    unknownCases: number;
+    passedCases: number;
+    passedInjectionCases: number;
+    costReportedCases: number;
+    totalCostMicroUsd: number | null;
+    latencyReportedCases: number;
+    latencyP90Ms: number | null;
+    latencyMaxMs: number | null;
+  }>;
+}>;
+
 export type PromptRefinerExecutionResult = Readonly<{
   status: "completed" | "stopped_unknown" | "in_flight" | "paused";
   attemptedThisInvocation: number;
@@ -145,6 +178,116 @@ const expectDigest = (value: unknown) => {
   return parsed && DIGEST.test(parsed) ? parsed : null;
 };
 
+const evidenceProblems = (value: unknown): readonly string[] => {
+  if (value === null) return [];
+  const evidence = record(value);
+  const summary = record(evidence?.summary);
+  if (!evidence || !summary) return ["evidence_shape"];
+  if (
+    Object.keys(evidence).sort().join("|") !==
+      "gateOutcome|gateReasons|summary" ||
+    Object.keys(summary).sort().join("|") !==
+      [
+        "attemptedCases",
+        "costReportedCases",
+        "failedCases",
+        "latencyMaxMs",
+        "latencyP90Ms",
+        "latencyReportedCases",
+        "passedCases",
+        "passedInjectionCases",
+        "suggestedCases",
+        "totalCostMicroUsd",
+        "unknownCases",
+      ].sort().join("|")
+  ) {
+    return ["evidence_shape"];
+  }
+  const serialized = JSON.stringify(value);
+  if (/"(?:sourceText|refinedPrompt|promptDigest|proposalDigest)"/.test(serialized)) {
+    return ["evidence_content_leak"];
+  }
+  const problems: string[] = [];
+  const gateReasons = Array.isArray(evidence.gateReasons)
+    ? evidence.gateReasons
+    : null;
+  if (
+    evidence.gateOutcome !== "pass" &&
+    evidence.gateOutcome !== "fail" &&
+    evidence.gateOutcome !== "insufficient_evidence"
+  ) {
+    problems.push("evidence_outcome");
+  }
+  if (
+    gateReasons === null ||
+    gateReasons.some(
+      (reason) => typeof reason !== "string" || !EVIDENCE_GATE_REASONS.has(reason)
+    ) ||
+    new Set(gateReasons).size !== gateReasons.length
+  ) {
+    problems.push("evidence_reasons");
+  }
+  for (const key of [
+    "attemptedCases",
+    "suggestedCases",
+    "failedCases",
+    "unknownCases",
+    "passedCases",
+    "passedInjectionCases",
+    "costReportedCases",
+    "latencyReportedCases",
+  ] as const) {
+    const parsed = integer(summary[key]);
+    if (parsed === null || parsed < 0 || parsed > 16) problems.push(`evidence_${key}`);
+  }
+  for (const key of ["totalCostMicroUsd", "latencyP90Ms", "latencyMaxMs"] as const) {
+    const value = summary[key];
+    if (value !== null && (integer(value) === null || (value as number) < 0)) {
+      problems.push(`evidence_${key}`);
+    }
+  }
+  const attemptedCases = integer(summary.attemptedCases);
+  const suggestedCases = integer(summary.suggestedCases);
+  const failedCases = integer(summary.failedCases);
+  const unknownCases = integer(summary.unknownCases);
+  const passedCases = integer(summary.passedCases);
+  const passedInjectionCases = integer(summary.passedInjectionCases);
+  const costReportedCases = integer(summary.costReportedCases);
+  const latencyReportedCases = integer(summary.latencyReportedCases);
+  if (
+    attemptedCases !== 16 ||
+    suggestedCases === null ||
+    failedCases === null ||
+    unknownCases === null ||
+    suggestedCases + failedCases + unknownCases !== 16 ||
+    passedCases === null ||
+    passedCases > suggestedCases ||
+    passedInjectionCases === null ||
+    passedInjectionCases > 2 ||
+    costReportedCases === null ||
+    (costReportedCases === 16) !== (summary.totalCostMicroUsd !== null) ||
+    latencyReportedCases === null ||
+    (latencyReportedCases === 16) !==
+      (summary.latencyP90Ms !== null && summary.latencyMaxMs !== null) ||
+    (summary.latencyP90Ms !== null &&
+      summary.latencyMaxMs !== null &&
+      (summary.latencyP90Ms as number) > (summary.latencyMaxMs as number))
+  ) {
+    problems.push("evidence_summary_relationships");
+  }
+  if (
+    (evidence.gateOutcome === "pass") !== (gateReasons?.length === 0) ||
+    (evidence.gateOutcome === "pass" &&
+      (passedCases !== 16 ||
+        passedInjectionCases !== 2 ||
+        failedCases !== 0 ||
+        unknownCases !== 0))
+  ) {
+    problems.push("evidence_gate_relationships");
+  }
+  return problems;
+};
+
 export const promptRefinerStagePreviewProblems = (
   value: unknown
 ): readonly string[] => {
@@ -220,6 +363,8 @@ export const promptRefinerRunPreviewProblems = (
   }
   if (!HEX_DIGEST.test(string(preview.corpusDigest) || ""))
     problems.push("corpusDigest");
+  if (!HEX_DIGEST.test(string(preview.evidenceSpecDigest) || ""))
+    problems.push("evidenceSpecDigest");
   if (preview.environment !== contract.environment) problems.push("environment");
   if (preview.deploymentId !== stage.deploymentId) problems.push("deployment_id");
   if (preview.commitSha !== stage.commitSha) problems.push("commit_sha");
@@ -312,6 +457,7 @@ export const promptRefinerExecutionPreviewProblems = (
   if (execution.confirmation !== contract.executionConfirmation)
     problems.push("confirmation");
   if (execution.productAdapterReady !== false) problems.push("product_adapter");
+  problems.push(...evidenceProblems(execution.evidence));
   return problems;
 };
 
diff --git a/lib/promptRefinerShadowRunContract.ts b/lib/promptRefinerShadowRunContract.ts
index cabae8c7..30a75ec2 100644
--- a/lib/promptRefinerShadowRunContract.ts
+++ b/lib/promptRefinerShadowRunContract.ts
@@ -20,9 +20,15 @@ import {
     PROMPT_REFINER_SHADOW_CORPUS_ID,
     PROMPT_REFINER_SHADOW_CORPUS_VERSION,
 } from "@/lib/promptRefinerShadowHarness";
+import {
+    PROMPT_REFINER_SHADOW_EVIDENCE_MAX_DURATION_MS,
+    PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_DIGEST,
+    PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_ID,
+    PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_VERSION,
+} from "@/lib/promptRefinerShadowEvidenceCore";
 
 export const PROMPT_REFINER_SHADOW_RUN_CONTRACT_VERSION =
-    "prompt-refiner-shadow-run-v3" as const;
+    "prompt-refiner-shadow-run-v4" as const;
 export const PROMPT_REFINER_SHADOW_ADAPTER_VERSION =
     "prompt-refiner-openai-sdk-adapter-v1" as const;
 export const PROMPT_REFINER_SHADOW_BYTE_PREFILTER_FRAMING_ALLOWANCE = 32 as const;
@@ -30,18 +36,22 @@ export const PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE = "js-tiktoken" as const;
 export const PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE_VERSION = "1.0.21" as const;
 export const PROMPT_REFINER_SHADOW_TOKENIZER_ENCODING = "o200k_base" as const;
 export const PROMPT_REFINER_SHADOW_RUN_SOURCE_MANIFEST_VERSION =
-    "prompt-refiner-shadow-run-source-v1" as const;
+    "prompt-refiner-shadow-run-source-v2" as const;
 export const PROMPT_REFINER_SHADOW_RUN_APPROVAL_FLAG =
     "PROMPT_REFINER_SHADOW_RUN_APPROVAL_ENABLED" as const;
 export const PROMPT_REFINER_SHADOW_RUN_CONFIRMATION =
-    "APPROVE PROMPT REFINER SHADOW RUN V3 FOR THE DISPLAYED COST CEILING" as const;
+    "APPROVE PROMPT REFINER SHADOW RUN V4 FOR THE DISPLAYED COST CEILING" as const;
 export const PROMPT_REFINER_SHADOW_RUN_ID =
-    "prompt-refiner-shadow-run-v3" as const;
+    "prompt-refiner-shadow-run-v4" as const;
 export const PROMPT_REFINER_SHADOW_EXECUTION_FLAG =
     "PROMPT_REFINER_SHADOW_EXECUTION_ENABLED" as const;
 export const PROMPT_REFINER_SHADOW_EXECUTION_CONFIRMATION =
-    "EXECUTE THE APPROVED PROMPT REFINER SHADOW RUN V3 ONCE" as const;
-export const PROMPT_REFINER_SHADOW_RUN_UNKNOWN_AFTER_MS = 60_000 as const;
+    "EXECUTE THE APPROVED PROMPT REFINER SHADOW RUN V4 ONCE" as const;
+// Unknown sweeps persist this threshold as terminal telemetry. Deriving it
+// from the evidence ceiling prevents the sweep from producing a receipt that
+// the writer or the durable aggregate reader must reject.
+export const PROMPT_REFINER_SHADOW_RUN_UNKNOWN_AFTER_MS =
+    PROMPT_REFINER_SHADOW_EVIDENCE_MAX_DURATION_MS;
 export const PROMPT_REFINER_SHADOW_RUN_SWEEP_BATCH = 16 as const;
 export const PROMPT_REFINER_SHADOW_ROUTE_MAX_DURATION_SECONDS = 300 as const;
 /**
@@ -84,6 +94,7 @@ export const PROMPT_REFINER_SHADOW_RUN_SOURCE_PATHS = Object.freeze([
     "lib/adminAuditSystemActors.ts",
     "lib/maintenance.ts",
     "lib/promptRefinerShadowLiveAdapter.ts",
+    "lib/promptRefinerShadowEvidenceCore.ts",
     "lib/promptRefinerShadowRunContract.ts",
     "lib/promptRefinerShadowRunner.ts",
     "lib/promptRefinerShadowRunStore.ts",
@@ -91,8 +102,12 @@ export const PROMPT_REFINER_SHADOW_RUN_SOURCE_PATHS = Object.freeze([
     "lib/promptRefinerShadowTokenizer.ts",
     "package-lock.json",
     "package.json",
+    "docs/ops/prompt-refiner-shadow/corpus-v1.json",
+    "docs/ops/prompt-refiner-shadow/evidence-spec-v1.json",
+    "prisma/schema.prisma",
     "prisma/migrations/20260920120000_prompt_refiner_shadow_run_writer/migration.sql",
     "prisma/migrations/20260920190000_prompt_refiner_shadow_execution_runner/migration.sql",
+    "prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql",
 ] as const);
 export const PROMPT_REFINER_SHADOW_RUN_SOURCE_MAX_FILE_BYTES = 2 * 1024 * 1024;
 export const PROMPT_REFINER_SHADOW_RUN_SOURCE_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
@@ -130,9 +145,8 @@ const canonicalJson = (value: unknown): string => {
 /**
  * The stage writer authorises a bounded reservation pool, not provider work.
  * This second contract narrows one future paid run to the frozen 16-case
- * synthetic corpus. The durable writer and preview are ready, while the false
- * entry-point and execution-admission values remain part of the digest:
- * shipping storage must not turn the deployed stage into an executable run.
+ * synthetic corpus. The owner-only execution entry point is admitted only for
+ * that shadow run; product Chat remains explicitly outside the contract.
  */
 export const PROMPT_REFINER_SHADOW_RUN_CONTRACT = Object.freeze({
     runContractVersion: PROMPT_REFINER_SHADOW_RUN_CONTRACT_VERSION,
@@ -147,6 +161,16 @@ export const PROMPT_REFINER_SHADOW_RUN_CONTRACT = Object.freeze({
         corpusDigest: PROMPT_REFINER_SHADOW_CORPUS_DIGEST,
         cases: PROMPT_REFINER_SHADOW_CORPUS_CASES,
     }),
+    evidence: Object.freeze({
+        specVersion: PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_VERSION,
+        specId: PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_ID,
+        specDigest: PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_DIGEST,
+        evaluation: "transient_proposal_to_content_free_case_evidence" as const,
+        durableProposalBytes: false,
+        durablePerItemContentDigest: false,
+        terminalReceiptAtomicity: "same_transaction" as const,
+        aggregateRebuild: "content_free_attempt_evidence" as const,
+    }),
     request: Object.freeze({
         timeoutMs: PROMPT_REFINER_TIMEOUT_MS,
         retryCount: PROMPT_REFINER_RETRY_COUNT,
@@ -197,7 +221,7 @@ const computedDigest = `sha256:${createHash("sha256")
 
 // Replaced with the computed literal before review. A mismatch fails import.
 export const PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST =
-    "sha256:7c487a9b88258f5be3e704bcea0c491def7a9f96830b66c6cbd3512361ecf280" as const;
+    "sha256:16051b8c1c10d1d14b85e65dc3697cf7230dd6c9bce8a30bb03d328f963eafd7" as const;
 
 if (computedDigest !== PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST) {
     throw new Error(`Prompt Refiner shadow run contract digest drifted: ${computedDigest}`);
@@ -339,6 +363,7 @@ export type PromptRefinerShadowRunPreviewBinding = Readonly<{
     stageApprovalExpiresAt: string;
     runContractDigest: typeof PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST;
     corpusDigest: typeof PROMPT_REFINER_SHADOW_CORPUS_DIGEST;
+    evidenceSpecDigest: typeof PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_DIGEST;
     adapterVersion: typeof PROMPT_REFINER_SHADOW_ADAPTER_VERSION;
     provider: typeof PROMPT_REFINER_EXECUTION_MODEL_PIN.provider;
     modelId: typeof PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId;
@@ -375,6 +400,7 @@ export const buildPromptRefinerShadowRunPreviewBinding = (input: {
         stageApprovalExpiresAt: input.stageApprovalExpiresAt.toISOString(),
         runContractDigest: PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST,
         corpusDigest: PROMPT_REFINER_SHADOW_CORPUS_DIGEST,
+        evidenceSpecDigest: PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_DIGEST,
         adapterVersion: PROMPT_REFINER_SHADOW_ADAPTER_VERSION,
         provider: PROMPT_REFINER_EXECUTION_MODEL_PIN.provider,
         modelId: PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId,
diff --git a/lib/promptRefinerShadowRunStore.ts b/lib/promptRefinerShadowRunStore.ts
index cebc556e..5a478dd4 100644
--- a/lib/promptRefinerShadowRunStore.ts
+++ b/lib/promptRefinerShadowRunStore.ts
@@ -4,6 +4,9 @@ import { randomUUID } from "node:crypto";
 import type { Session } from "next-auth";
 import { Prisma, type ModelRegistryEntry } from "@prisma/client";
 
+import corpusJson from "@/docs/ops/prompt-refiner-shadow/corpus-v1.json";
+import evidenceSpecJson from "@/docs/ops/prompt-refiner-shadow/evidence-spec-v1.json";
+
 import { writeAdminAuditLog } from "@/lib/adminAudit";
 import {
     ADMIN_AUDIT_VERIFICATION_KEY_ORDERS,
@@ -63,12 +66,30 @@ import {
     promptRefinerShadowRunPreviewBindingDigest,
     type PromptRefinerShadowRunSourceManifest,
 } from "@/lib/promptRefinerShadowRunContract";
-import { PROMPT_REFINER_SHADOW_CORPUS_DIGEST } from "@/lib/promptRefinerShadowHarness";
+import {
+    aggregatePromptRefinerShadowStoredEvidence,
+    evaluatePromptRefinerShadowCaseEvidence,
+    PROMPT_REFINER_SHADOW_EVIDENCE_MAX_DURATION_MS,
+    PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_DIGEST,
+    validatePromptRefinerShadowCaseEvidence,
+    validatePromptRefinerShadowEvidenceSpec,
+    type PromptRefinerShadowCaseEvidence,
+    type PromptRefinerShadowEvidenceBundle,
+} from "@/lib/promptRefinerShadowEvidenceCore";
+import {
+    PROMPT_REFINER_SHADOW_CORPUS_DIGEST,
+    validatePromptRefinerShadowCorpus,
+} from "@/lib/promptRefinerShadowHarness";
 import {
     writePromptRefinerDispatchAudit,
     writePromptRefinerTerminalAudit,
 } from "@/lib/promptRefinerShadowSystemAudit";
 
+const shadowCorpus = validatePromptRefinerShadowCorpus(corpusJson);
+const shadowEvidenceSpec = validatePromptRefinerShadowEvidenceSpec(
+    evidenceSpecJson
+);
+
 type PromptRefinerShadowDispatchFact = {
     requestId: string;
     adapterVersion: string;
@@ -114,6 +135,7 @@ type StoredRun = {
     runContractVersion: string;
     runContractDigest: string;
     corpusDigest: string;
+    evidenceSpecDigest: string | null;
     adapterVersion: string;
     status: string;
     perRequestCostMicroUsd: bigint;
@@ -253,6 +275,7 @@ const runApprovalMetadata = (run: StoredRun) => ({
     runContractVersion: run.runContractVersion,
     runContractDigest: run.runContractDigest,
     corpusDigest: run.corpusDigest,
+    evidenceSpecDigest: run.evidenceSpecDigest,
     adapterVersion: run.adapterVersion,
     runtimeSourceManifestDigest: run.runtimeSourceManifestDigest,
     previewBindingDigest: run.previewBindingDigest,
@@ -351,6 +374,7 @@ const runMatchesRuntime = (
         run.runContractVersion === PROMPT_REFINER_SHADOW_RUN_CONTRACT_VERSION &&
         run.runContractDigest === PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST &&
         run.corpusDigest === PROMPT_REFINER_SHADOW_CORPUS_DIGEST &&
+        run.evidenceSpecDigest === PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_DIGEST &&
         run.adapterVersion === PROMPT_REFINER_SHADOW_ADAPTER_VERSION &&
         ["approved", "running"].includes(run.status) &&
         run.perRequestCostMicroUsd ===
@@ -431,6 +455,7 @@ export const readPromptRefinerShadowExecutionState = async (): Promise<
             run.runContractVersion !== PROMPT_REFINER_SHADOW_RUN_CONTRACT_VERSION ||
             run.runContractDigest !== PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST ||
             run.corpusDigest !== PROMPT_REFINER_SHADOW_CORPUS_DIGEST ||
+            run.evidenceSpecDigest !== PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_DIGEST ||
             run.adapterVersion !== PROMPT_REFINER_SHADOW_ADAPTER_VERSION ||
             run.perRequestCostMicroUsd !==
                 BigInt(PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD) ||
@@ -628,6 +653,7 @@ export const createPromptRefinerShadowRun = async (input: {
             runContractVersion: PROMPT_REFINER_SHADOW_RUN_CONTRACT_VERSION,
             runContractDigest: PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST,
             corpusDigest: PROMPT_REFINER_SHADOW_CORPUS_DIGEST,
+            evidenceSpecDigest: PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_DIGEST,
             adapterVersion: PROMPT_REFINER_SHADOW_ADAPTER_VERSION,
             status: "approved",
             perRequestCostMicroUsd: BigInt(PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD),
@@ -859,6 +885,7 @@ const terminalInputIsValid = (
     DISPATCH_TERMINAL_REASONS.has(reason) &&
     Number.isSafeInteger(telemetry.durationMs) &&
     telemetry.durationMs >= 0 &&
+    telemetry.durationMs <= PROMPT_REFINER_SHADOW_EVIDENCE_MAX_DURATION_MS &&
     nullableNonnegativeInteger(telemetry.usage.inputTokens) &&
     nullableNonnegativeInteger(telemetry.usage.cachedInputTokens) &&
     nullableNonnegativeInteger(telemetry.usage.cacheWriteInputTokens) &&
@@ -869,6 +896,15 @@ const terminalInputIsValid = (
         telemetry.usage.costUpperBoundMicroUsd <=
             PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD);
 
+const evidenceTerminalStatus = (
+    reason: PromptRefinerTerminalReason
+): "suggested" | "failed" | "unknown" =>
+    reason === "suggested"
+        ? "suggested"
+        : reason === "unknown_after_dispatch"
+          ? "unknown"
+          : "failed";
+
 const terminalValuesEqual = (
     attempt: {
         terminalReason: string | null;
@@ -879,9 +915,11 @@ const terminalValuesEqual = (
         outputTokens: number | null;
         reasoningTokens: number | null;
         actualCostMicroUsd: bigint | null;
+        evidence: unknown;
     },
     reason: PromptRefinerTerminalReason,
-    telemetry: TerminalTelemetry
+    telemetry: TerminalTelemetry,
+    evidence: PromptRefinerShadowCaseEvidence
 ) =>
     attempt.terminalReason === reason &&
     attempt.durationMs === telemetry.durationMs &&
@@ -893,13 +931,15 @@ const terminalValuesEqual = (
     attempt.actualCostMicroUsd ===
         (telemetry.usage.costUpperBoundMicroUsd === null
             ? null
-            : BigInt(telemetry.usage.costUpperBoundMicroUsd));
+            : BigInt(telemetry.usage.costUpperBoundMicroUsd)) &&
+    canonicalBenchmarkJson(attempt.evidence) === canonicalBenchmarkJson(evidence);
 
 export const recordPromptRefinerShadowTerminal = async (input: {
     attemptId: string;
     terminalReason: PromptRefinerTerminalReason;
     durationMs: number;
     usage: PromptRefinerShadowUsage;
+    evidence: unknown;
 }) => {
     if (
         !/^[A-Za-z0-9_-]{1,128}$/.test(input.attemptId) ||
@@ -931,8 +971,43 @@ export const recordPromptRefinerShadowTerminal = async (input: {
         const attempt = await tx.promptRefinerShadowAttempt.findUniqueOrThrow({
             where: { id: input.attemptId },
         });
+        if (
+            run.runContractDigest !== PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST ||
+            run.evidenceSpecDigest !== PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_DIGEST
+        ) {
+            refuse(
+                409,
+                "PROMPT_REFINER_SHADOW_EVIDENCE_RUN_MISMATCH",
+                "The attempt is not bound to the reviewed evidence contract."
+            );
+        }
+        const evidence: PromptRefinerShadowCaseEvidence = (() => {
+            try {
+                return validatePromptRefinerShadowCaseEvidence({
+                    value: input.evidence,
+                    spec: shadowEvidenceSpec,
+                    caseIndex: attempt.caseIndex,
+                    terminalStatus: evidenceTerminalStatus(
+                        input.terminalReason
+                    ),
+                });
+            } catch {
+                return refuse(
+                    400,
+                    "PROMPT_REFINER_SHADOW_EVIDENCE_INVALID",
+                    "The terminal evidence is invalid."
+                );
+            }
+        })();
         if (attempt.status === "terminal") {
-            if (terminalValuesEqual(attempt, input.terminalReason, input)) {
+            if (
+                terminalValuesEqual(
+                    attempt,
+                    input.terminalReason,
+                    input,
+                    evidence
+                )
+            ) {
                 return { created: false, replayed: true, attempt, run };
             }
             refuse(409, "PROMPT_REFINER_SHADOW_TERMINAL_CONFLICT", "A different terminal receipt already exists.");
@@ -962,6 +1037,7 @@ export const recordPromptRefinerShadowTerminal = async (input: {
             outputTokens: input.usage.outputTokens,
             reasoningTokens: input.usage.reasoningTokens,
             actualCostMicroUsd: input.usage.costUpperBoundMicroUsd,
+            evidence: evidence as unknown as Prisma.InputJsonValue,
         });
         const updatedCount = await tx.promptRefinerShadowAttempt.updateMany({
             where: { id: attempt.id, status: "dispatch_intent" },
@@ -980,6 +1056,7 @@ export const recordPromptRefinerShadowTerminal = async (input: {
                     input.usage.costUpperBoundMicroUsd === null
                         ? null
                         : BigInt(input.usage.costUpperBoundMicroUsd),
+                evidence: evidence as unknown as Prisma.InputJsonValue,
                 terminalAuditLogId,
             },
         });
@@ -1025,6 +1102,111 @@ export const recordPromptRefinerShadowTerminal = async (input: {
     });
 };
 
+/**
+ * Rebuilds the reviewed bundle only from durable, content-free attempt facts.
+ * Incomplete runs return null; malformed or differently bound completed rows
+ * fail closed instead of being rendered as evidence.
+ */
+export const readPromptRefinerShadowEvidenceBundle = async (): Promise<
+    PromptRefinerShadowEvidenceBundle | null
+> => {
+    const run = await prisma.promptRefinerShadowRun.findUnique({
+        where: { id: PROMPT_REFINER_SHADOW_RUN_ID },
+        select: {
+            runContractDigest: true,
+            corpusDigest: true,
+            evidenceSpecDigest: true,
+            maxDispatches: true,
+            terminalCount: true,
+        },
+    });
+    if (!run) return null;
+    if (
+        run.runContractDigest !== PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST ||
+        run.corpusDigest !== PROMPT_REFINER_SHADOW_CORPUS_DIGEST ||
+        run.evidenceSpecDigest !== PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_DIGEST
+    ) {
+        refuse(
+            409,
+            "PROMPT_REFINER_SHADOW_EVIDENCE_RUN_MISMATCH",
+            "The stored run is not bound to the reviewed evidence contract."
+        );
+    }
+    if (
+        run.terminalCount !== run.maxDispatches ||
+        run.maxDispatches !== PROMPT_REFINER_SHADOW_CASE_IDS.length
+    ) {
+        return null;
+    }
+    const attempts = await prisma.promptRefinerShadowAttempt.findMany({
+        where: { runId: PROMPT_REFINER_SHADOW_RUN_ID },
+        orderBy: { caseIndex: "asc" },
+        select: {
+            caseId: true,
+            caseIndex: true,
+            status: true,
+            terminalReason: true,
+            evidence: true,
+            durationMs: true,
+            actualCostMicroUsd: true,
+        },
+    });
+    if (attempts.length !== PROMPT_REFINER_SHADOW_CASE_IDS.length) {
+        refuse(
+            409,
+            "PROMPT_REFINER_SHADOW_EVIDENCE_INCOMPLETE",
+            "The completed run does not contain every evidence case."
+        );
+    }
+    const cases = attempts.map((attempt, index) => {
+        if (
+            attempt.caseIndex !== index ||
+            attempt.caseId !== PROMPT_REFINER_SHADOW_CASE_IDS[index] ||
+            attempt.status !== "terminal" ||
+            typeof attempt.terminalReason !== "string" ||
+            !DISPATCH_TERMINAL_REASONS.has(
+                attempt.terminalReason as PromptRefinerTerminalReason
+            ) ||
+            attempt.evidence === null
+        ) {
+            refuse(
+                409,
+                "PROMPT_REFINER_SHADOW_EVIDENCE_INVALID",
+                "The completed run contains invalid evidence facts."
+            );
+        }
+        return {
+            caseId: attempt.caseId,
+            terminalStatus: evidenceTerminalStatus(
+                attempt.terminalReason as PromptRefinerTerminalReason
+            ),
+            evidence: attempt.evidence,
+            durationMs:
+                attempt.terminalReason === "unknown_after_dispatch"
+                    ? null
+                    : attempt.durationMs,
+            costMicroUsd:
+                attempt.terminalReason === "unknown_after_dispatch" ||
+                attempt.actualCostMicroUsd === null
+                    ? null
+                    : Number(attempt.actualCostMicroUsd),
+        };
+    });
+    try {
+        return aggregatePromptRefinerShadowStoredEvidence({
+            corpus: shadowCorpus,
+            spec: shadowEvidenceSpec,
+            cases,
+        });
+    } catch {
+        return refuse(
+            409,
+            "PROMPT_REFINER_SHADOW_EVIDENCE_INVALID",
+            "The completed run evidence could not be verified."
+        );
+    }
+};
+
 const unknownTelemetry = (): TerminalTelemetry => ({
     durationMs: PROMPT_REFINER_SHADOW_RUN_UNKNOWN_AFTER_MS,
     usage: {
@@ -1062,7 +1244,7 @@ export const sweepPromptRefinerShadowUnknowns = async () => {
             },
             orderBy: [{ dispatchIntentAt: "asc" }, { id: "asc" }],
             take: PROMPT_REFINER_SHADOW_RUN_SWEEP_BATCH,
-            select: { id: true },
+            select: { id: true, caseIndex: true },
         });
         return { observedAt, stale };
     });
@@ -1073,6 +1255,13 @@ export const sweepPromptRefinerShadowUnknowns = async () => {
             const result = await recordPromptRefinerShadowTerminal({
                 attemptId: attempt.id,
                 terminalReason: "unknown_after_dispatch",
+                evidence: evaluatePromptRefinerShadowCaseEvidence({
+                    corpus: shadowCorpus,
+                    spec: shadowEvidenceSpec,
+                    caseIndex: attempt.caseIndex,
+                    terminalStatus: "unknown",
+                    refinedPrompt: null,
+                }),
                 ...unknownTelemetry(),
             });
             if (result.created || result.replayed) closed.push(attempt.id);
diff --git a/lib/promptRefinerShadowRunner.ts b/lib/promptRefinerShadowRunner.ts
index 0916442b..517b30bb 100644
--- a/lib/promptRefinerShadowRunner.ts
+++ b/lib/promptRefinerShadowRunner.ts
@@ -3,6 +3,7 @@ import "server-only";
 import { randomUUID } from "node:crypto";
 
 import corpusJson from "@/docs/ops/prompt-refiner-shadow/corpus-v1.json";
+import evidenceSpecJson from "@/docs/ops/prompt-refiner-shadow/evidence-spec-v1.json";
 import {
     releasePromptRefinerReservation,
     reservePromptRefinerExecution,
@@ -13,6 +14,10 @@ import type {
 } from "@/lib/promptRefinerReservationCore";
 import { runPromptRefinerShadowLiveAdapter } from "@/lib/promptRefinerShadowLiveAdapter";
 import { reportOperationalIncident } from "@/lib/operationalMonitoring";
+import {
+    evaluatePromptRefinerShadowCaseEvidence,
+    validatePromptRefinerShadowEvidenceSpec,
+} from "@/lib/promptRefinerShadowEvidenceCore";
 import {
     PROMPT_REFINER_SHADOW_CASE_IDS,
     PROMPT_REFINER_SHADOW_EXECUTION_FLAG,
@@ -35,6 +40,7 @@ import {
 import { PROMPT_REFINER_TIMEOUT_MS } from "@/lib/promptRefinerExecutionContract";
 
 const corpus = validatePromptRefinerShadowCorpus(corpusJson);
+const evidenceSpec = validatePromptRefinerShadowEvidenceSpec(evidenceSpecJson);
 if (corpus.contentDigest !== PROMPT_REFINER_SHADOW_CORPUS_DIGEST) {
     throw new Error("The bundled Prompt Refiner shadow corpus is not the frozen corpus.");
 }
@@ -177,7 +183,7 @@ const resultFromState = (
     });
 
 const requestIdFor = (caseId: string): string =>
-    `prsv3_${caseId.replaceAll("-", "_")}_${randomUUID().replaceAll("-", "")}`;
+    `prsv4_${caseId.replaceAll("-", "_")}_${randomUUID().replaceAll("-", "")}`;
 
 /**
  * Runs the approved synthetic cases strictly in corpus order. There is no
@@ -381,11 +387,25 @@ export const createPromptRefinerShadowRunner = (
             );
         }
         try {
+            const terminalStatus =
+                outcome.terminalReason === "suggested"
+                    ? "suggested"
+                    : outcome.terminalReason === "unknown_after_dispatch"
+                      ? "unknown"
+                      : "failed";
+            const evidence = evaluatePromptRefinerShadowCaseEvidence({
+                corpus: dependencies.corpus,
+                spec: evidenceSpec,
+                caseIndex,
+                terminalStatus,
+                refinedPrompt: outcome.refinedPrompt,
+            });
             await dependencies.recordTerminal({
                 attemptId,
                 terminalReason: outcome.terminalReason,
                 durationMs: outcome.durationMs,
                 usage: outcome.usage,
+                evidence,
             });
         } catch (error) {
             await reportRunnerIncident(dependencies, {
diff --git a/lib/promptRefinerShadowSystemAudit.ts b/lib/promptRefinerShadowSystemAudit.ts
index dacf7735..75edae7e 100644
--- a/lib/promptRefinerShadowSystemAudit.ts
+++ b/lib/promptRefinerShadowSystemAudit.ts
@@ -69,6 +69,7 @@ export const writePromptRefinerTerminalAudit = (input: {
     outputTokens: number | null;
     reasoningTokens: number | null;
     actualCostMicroUsd: number | null;
+    evidence: Prisma.InputJsonValue;
 }): Promise<string> =>
     writeSystemAuditLog({
         tx: input.tx,
@@ -92,6 +93,7 @@ export const writePromptRefinerTerminalAudit = (input: {
             outputTokens: input.outputTokens,
             reasoningTokens: input.reasoningTokens,
             actualCostMicroUsd: input.actualCostMicroUsd,
+            evidence: input.evidence,
             retryCount: 0,
         },
     });
diff --git a/lib/promptRefinerStageAdmissionCore.ts b/lib/promptRefinerStageAdmissionCore.ts
index d6172321..690f3b16 100644
--- a/lib/promptRefinerStageAdmissionCore.ts
+++ b/lib/promptRefinerStageAdmissionCore.ts
@@ -27,18 +27,18 @@ import { canonicalBenchmarkJson } from "@/lib/routerDevelopmentBenchmark";
  * cannot create a stage, reserve a slot, call a provider, or enable a flag.
  */
 export const PROMPT_REFINER_STAGE_ADMISSION_VERSION =
-  "prompt-refiner-stage-admission-v1" as const;
+  "prompt-refiner-stage-admission-v2" as const;
 export const PROMPT_REFINER_RUNTIME_SOURCE_MANIFEST_VERSION =
-  "prompt-refiner-runtime-source-manifest-v2" as const;
+  "prompt-refiner-runtime-source-manifest-v3" as const;
 export const PROMPT_REFINER_EXECUTION_MANIFEST_VERSION =
-  "prompt-refiner-shadow-execution-manifest-v1" as const;
+  "prompt-refiner-shadow-execution-manifest-v2" as const;
 export const PROMPT_REFINER_STAGE_APPROVAL_TTL_MS = 60 * 60 * 1_000;
 export const PROMPT_REFINER_STAGE_ENVIRONMENT = "staging" as const;
 export const PROMPT_REFINER_STAGE_CONFIRMATION =
-  "APPROVE PROMPT REFINER SHADOW STAGE V1 FOR 60 MINUTES" as const;
+  "APPROVE PROMPT REFINER SHADOW STAGE V2 FOR 60 MINUTES" as const;
 export const PROMPT_REFINER_STAGE_REASON =
   "bounded_staging_shadow_cost_approval" as const;
-export const PROMPT_REFINER_RUNTIME_SOURCE_FILE_COUNT = 187 as const;
+export const PROMPT_REFINER_RUNTIME_SOURCE_FILE_COUNT = 188 as const;
 export const PROMPT_REFINER_RUNTIME_SOURCE_FILE_MAX_BYTES = 8 * 1024 * 1024;
 export const PROMPT_REFINER_RUNTIME_SOURCE_TOTAL_MAX_BYTES = 16 * 1024 * 1024;
 
@@ -64,6 +64,7 @@ export const PROMPT_REFINER_RUNTIME_SOURCE_PATHS = Object.freeze([
   "tsconfig.json",
   "prisma/schema.prisma",
   "prisma/migrations/20260918130000_prompt_refiner_stage_admission/migration.sql",
+  "prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql",
   "apps/mobile/package.json",
   "packages/chat-core/package.json",
   "packages/ui-tokens/package.json",
diff --git a/prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql b/prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql
new file mode 100644
index 00000000..88fdf224
--- /dev/null
+++ b/prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql
@@ -0,0 +1,727 @@
+-- Admit the reviewed Prompt Refiner confirmatory shadow v4 without mutating
+-- the completed v1/v3 stage, reservations, run or attempts. No row is seeded,
+-- no approval is inferred and no provider can be called by this migration.
+
+ALTER FUNCTION "prompt_refiner_runtime_manifest_valid"(JSONB, TEXT, TEXT, TEXT)
+    RENAME TO "prompt_refiner_runtime_manifest_v2_valid";
+
+-- v3 is the v2 closure plus this migration at the exact reviewed position.
+-- The original validator remains the authority for all 187 legacy paths; this
+-- wrapper validates the one-file extension and both full-manifest digests.
+CREATE FUNCTION "prompt_refiner_runtime_manifest_valid"(
+    manifest JSONB,
+    commit_sha TEXT,
+    source_identity_digest TEXT,
+    manifest_digest TEXT
+)
+RETURNS BOOLEAN
+LANGUAGE plpgsql
+IMMUTABLE
+STRICT
+PARALLEL SAFE
+AS $$
+DECLARE
+    files JSONB;
+    added JSONB;
+    legacy_files JSONB;
+    legacy_manifest JSONB;
+BEGIN
+    IF manifest->>'schemaVersion' = 'prompt-refiner-runtime-source-manifest-v2' THEN
+        RETURN "prompt_refiner_runtime_manifest_v2_valid"(
+            manifest, commit_sha, source_identity_digest, manifest_digest
+        );
+    END IF;
+    IF manifest->>'schemaVersion' <> 'prompt-refiner-runtime-source-manifest-v3'
+       OR jsonb_typeof(manifest) <> 'object'
+       OR manifest <> jsonb_build_object(
+            'schemaVersion', manifest->'schemaVersion',
+            'commitSha', manifest->'commitSha',
+            'totalSizeBytes', manifest->'totalSizeBytes',
+            'files', manifest->'files'
+       )
+       OR manifest->>'commitSha' <> commit_sha
+       OR commit_sha !~ '^[a-f0-9]{40}$'
+       OR jsonb_typeof(manifest->'files') <> 'array'
+       OR jsonb_array_length(manifest->'files') <> 188
+       OR jsonb_typeof(manifest->'totalSizeBytes') <> 'number'
+       OR manifest->>'totalSizeBytes' !~ '^[1-9][0-9]*$'
+       OR (manifest->>'totalSizeBytes')::NUMERIC > 16777216
+       OR source_identity_digest <> "prompt_refiner_sha256_json"(
+            jsonb_build_object('files', manifest->'files')
+       )
+       OR manifest_digest <> "prompt_refiner_sha256_json"(manifest) THEN
+        RETURN FALSE;
+    END IF;
+    files := manifest->'files';
+    added := files->6;
+    IF added <> jsonb_build_object(
+            'path', 'prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql',
+            'sizeBytes', added->'sizeBytes',
+            'sha256', added->'sha256'
+       )
+       OR jsonb_typeof(added->'sizeBytes') <> 'number'
+       OR added->>'sizeBytes' !~ '^[1-9][0-9]*$'
+       OR (added->>'sizeBytes')::NUMERIC > 8388608
+       OR jsonb_typeof(added->'sha256') <> 'string'
+       OR added->>'sha256' !~ '^[a-f0-9]{64}$' THEN
+        RETURN FALSE;
+    END IF;
+    SELECT jsonb_agg(value ORDER BY ordinal)
+    INTO legacy_files
+    FROM jsonb_array_elements(files) WITH ORDINALITY AS entry(value, ordinal)
+    WHERE ordinal <> 7;
+    legacy_manifest := jsonb_build_object(
+        'schemaVersion', 'prompt-refiner-runtime-source-manifest-v2',
+        'commitSha', commit_sha,
+        'totalSizeBytes',
+            (manifest->>'totalSizeBytes')::NUMERIC - (added->>'sizeBytes')::NUMERIC,
+        'files', legacy_files
+    );
+    RETURN "prompt_refiner_runtime_manifest_v2_valid"(
+        legacy_manifest,
+        commit_sha,
+        "prompt_refiner_sha256_json"(jsonb_build_object('files', legacy_files)),
+        "prompt_refiner_sha256_json"(legacy_manifest)
+    );
+EXCEPTION WHEN OTHERS THEN
+    RETURN FALSE;
+END;
+$$;
+
+ALTER TABLE "PromptRefinerReservationStage"
+    DROP CONSTRAINT "PromptRefinerReservationStage_id_check",
+    DROP CONSTRAINT "PromptRefinerReservationStage_contract_check",
+    DROP CONSTRAINT "PromptRefinerReservationStage_admission_identity_check",
+    DROP CONSTRAINT "PromptRefinerReservationStage_runtime_identity_check",
+    DROP CONSTRAINT "PromptRefinerReservationStage_execution_manifest_check";
+
+ALTER TABLE "PromptRefinerReservationStage"
+    ADD CONSTRAINT "PromptRefinerReservationStage_id_check" CHECK (
+        "id" IN ('prompt-refiner-shadow-v1', 'prompt-refiner-shadow-v2')
+    ),
+    ADD CONSTRAINT "PromptRefinerReservationStage_contract_check" CHECK (
+        "contractVersion" = 'prompt-refiner-execution-contract-v1'
+        AND (
+            ("id" = 'prompt-refiner-shadow-v1'
+             AND "contractDigest" = 'sha256:c5cc412eb47821d56f6eed2e837d11086a9ab744069715e90d33ea37a378d55f')
+            OR
+            ("id" = 'prompt-refiner-shadow-v2'
+             AND "contractDigest" = 'sha256:6b60c957793effe904d82748d9f7353d6490d150eff66ba4a02f1aac63f376d1')
+        )
+    ),
+    ADD CONSTRAINT "PromptRefinerReservationStage_admission_identity_check" CHECK (
+        "proposalVersion" = 'prompt-refiner-shadow-stage-proposal-v1'
+        AND "proposalDigest" = 'sha256:75198565b0bcc1e481c89c6ac8946d11793d28b7afbd96e18d36a03a27f06cc2'
+        AND "evidenceBundleDigest" = 'sha256:61d66909a0d493c9b0bfae5faaa3e79ad827a6cba8598f39167ecf506176a159'
+        AND "evidenceManifestSha256" = '9e15f6413083dd980fbd9003d9396d2c8519cacedba20fcb4bb951a796a7b73d'
+        AND "historicalSourceRef" = 'f1e1b0c23fd93cfa9dbaa0a68abe603d989c3830'
+        AND "historicalSourceIdentityDigest" = 'ac1813483dc62e44bb34fdc681be908611d72493567ba437322012a6e3438f39'
+        AND "corpusDigest" = 'bcb2709f74aa4983595a7121ad27c3abd80946a6e28d36442cf440f6dcf22958'
+        AND (
+            ("id" = 'prompt-refiner-shadow-v1'
+             AND "admissionVersion" = 'prompt-refiner-stage-admission-v1')
+            OR
+            ("id" = 'prompt-refiner-shadow-v2'
+             AND "admissionVersion" = 'prompt-refiner-stage-admission-v2')
+        )
+    ),
+    -- PostgreSQL constraints bind to a function object, not a function name.
+    -- Recreate this CHECK after renaming the legacy validator so v1 rows keep
+    -- using the wrapper's v2 branch and new v2 rows may use manifest v3.
+    ADD CONSTRAINT "PromptRefinerReservationStage_runtime_identity_check" CHECK (
+        "runtimeEnvironment" = 'staging'
+        AND "runtimeCommitSha" ~ '^[a-f0-9]{40}$'
+        AND "runtimeDeploymentId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
+        AND "runtimeSourceIdentityDigest" ~ '^sha256:[a-f0-9]{64}$'
+        AND "runtimeSourceManifestDigest" ~ '^sha256:[a-f0-9]{64}$'
+        AND (
+            ("id" = 'prompt-refiner-shadow-v1'
+             AND "runtimeSourceManifest"->>'schemaVersion' = 'prompt-refiner-runtime-source-manifest-v2')
+            OR
+            ("id" = 'prompt-refiner-shadow-v2'
+             AND "runtimeSourceManifest"->>'schemaVersion' = 'prompt-refiner-runtime-source-manifest-v3')
+        )
+        AND "prompt_refiner_runtime_manifest_valid"(
+            "runtimeSourceManifest",
+            "runtimeCommitSha",
+            "runtimeSourceIdentityDigest",
+            "runtimeSourceManifestDigest"
+        )
+    ),
+    ADD CONSTRAINT "PromptRefinerReservationStage_execution_manifest_check" CHECK (
+        "executionManifestDigest" ~ '^sha256:[a-f0-9]{64}$'
+        AND jsonb_typeof("executionManifest") = 'object'
+        AND "executionManifestDigest" = "prompt_refiner_sha256_json"("executionManifest")
+        AND (
+            ("id" = 'prompt-refiner-shadow-v1' AND "executionManifest" = '{
+              "schemaVersion":"prompt-refiner-shadow-execution-manifest-v1",
+              "stageId":"prompt-refiner-shadow-v1",
+              "reservationContractDigest":"sha256:c5cc412eb47821d56f6eed2e837d11086a9ab744069715e90d33ea37a378d55f",
+              "runtimeSource":{"fileCount":187,"maxFileBytes":8388608,"maxTotalBytes":16777216},
+              "executionContractVersion":"prompt-refiner-execution-contract-v1",
+              "executionContract":{"contractVersion":"prompt-refiner-execution-contract-v1","refinerVersion":"suggest-v1","mode":"shadow","userVisible":false,"model":{"provider":"openai","modelId":"gpt-5-6-luna","apiModelId":"gpt-5.6-luna","pricingVersion":"openai-gpt-5.6-luna-2026-08-01","pricingEffectiveDate":"2026-08-01","routing":"direct_provider_api","processingTier":"standard","reasoningEffort":"medium","contextWindowTokens":1050000,"reasoningTokenBilling":"billed_as_output","inputUsdPerMillionTokens":0.2,"outputUsdPerMillionTokens":1.2},"request":{"maxSourceChars":16000,"maxSourceBytes":32768,"maxInputTokens":100000,"maxOutputTokens":4096,"timeoutMs":15000,"retryCount":0,"promptCaching":"disabled","tools":"none","perRequestCostCeilingMicroUsd":24916},"stage":{"maxDispatches":100,"costCeilingMicroUsd":2491600,"requiresSeparateApproval":true,"reservationAuthority":"unavailable"}},
+              "perRequestCostMicroUsd":24916,"maxReservations":100,"costCeilingMicroUsd":2491600,"executionAdmitted":false,"productAdapterReady":false
+            }'::jsonb)
+            OR
+            ("id" = 'prompt-refiner-shadow-v2' AND "executionManifest" = '{
+              "schemaVersion":"prompt-refiner-shadow-execution-manifest-v2",
+              "stageId":"prompt-refiner-shadow-v2",
+              "reservationContractDigest":"sha256:6b60c957793effe904d82748d9f7353d6490d150eff66ba4a02f1aac63f376d1",
+              "runtimeSource":{"fileCount":188,"maxFileBytes":8388608,"maxTotalBytes":16777216},
+              "executionContractVersion":"prompt-refiner-execution-contract-v1",
+              "executionContract":{"contractVersion":"prompt-refiner-execution-contract-v1","refinerVersion":"suggest-v1","mode":"shadow","userVisible":false,"model":{"provider":"openai","modelId":"gpt-5-6-luna","apiModelId":"gpt-5.6-luna","pricingVersion":"openai-gpt-5.6-luna-2026-08-01","pricingEffectiveDate":"2026-08-01","routing":"direct_provider_api","processingTier":"standard","reasoningEffort":"medium","contextWindowTokens":1050000,"reasoningTokenBilling":"billed_as_output","inputUsdPerMillionTokens":0.2,"outputUsdPerMillionTokens":1.2},"request":{"maxSourceChars":16000,"maxSourceBytes":32768,"maxInputTokens":100000,"maxOutputTokens":4096,"timeoutMs":15000,"retryCount":0,"promptCaching":"disabled","tools":"none","perRequestCostCeilingMicroUsd":24916},"stage":{"maxDispatches":100,"costCeilingMicroUsd":2491600,"requiresSeparateApproval":true,"reservationAuthority":"unavailable"}},
+              "perRequestCostMicroUsd":24916,"maxReservations":100,"costCeilingMicroUsd":2491600,"executionAdmitted":false,"productAdapterReady":false
+            }'::jsonb)
+        )
+    );
+
+CREATE OR REPLACE FUNCTION "prompt_refiner_stage_guard"()
+RETURNS TRIGGER AS $$
+DECLARE
+    actual_count INTEGER;
+    actual_cost BIGINT;
+    observed_at TIMESTAMP(3);
+    audit "AdminAuditLog"%ROWTYPE;
+    audit_approved_at TIMESTAMP(3);
+    audit_expires_at TIMESTAMP(3);
+BEGIN
+    IF TG_OP = 'DELETE' THEN
+        RAISE EXCEPTION 'PromptRefinerReservationStage % cannot be deleted', OLD."id";
+    END IF;
+    IF TG_OP = 'INSERT' THEN
+        observed_at := (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
+        IF NEW."id" <> 'prompt-refiner-shadow-v2'
+           OR NEW."reservationCount" <> 0 OR NEW."allocatedCostMicroUsd" <> 0
+           OR NEW."status" <> 'approved' THEN
+            RAISE EXCEPTION 'PromptRefinerReservationStage v2 must start with zero accounting and approved status';
+        END IF;
+        SELECT * INTO audit FROM "AdminAuditLog"
+        WHERE "id" = NEW."authorizationAuditLogId";
+        audit_approved_at := ((audit."metadata"->>'approvedAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')::TIMESTAMP(3);
+        audit_expires_at := ((audit."metadata"->>'approvalExpiresAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')::TIMESTAMP(3);
+        IF NOT FOUND OR audit."actorUserId" IS DISTINCT FROM NEW."approvedBy"
+           OR audit."action" <> 'prompt_refiner.shadow_stage.activated'
+           OR audit."targetType" <> 'PromptRefinerReservationStage'
+           OR audit."targetId" IS DISTINCT FROM NEW."id"
+           OR audit."entryHash" IS NULL OR audit."entryHash" !~ '^[a-f0-9]{64}$'
+           OR audit."createdAt" < observed_at - INTERVAL '1 minute'
+           OR audit."createdAt" > observed_at + INTERVAL '1 minute'
+           OR audit."metadata" IS DISTINCT FROM jsonb_build_object(
+                'admissionVersion', NEW."admissionVersion",
+                'proposalDigest', NEW."proposalDigest",
+                'evidenceBundleDigest', NEW."evidenceBundleDigest",
+                'runtimeSourceManifestDigest', NEW."runtimeSourceManifestDigest",
+                'executionManifestDigest', NEW."executionManifestDigest",
+                'environment', NEW."runtimeEnvironment",
+                'deploymentId', NEW."runtimeDeploymentId",
+                'commitSha', NEW."runtimeCommitSha",
+                'perRequestCostMicroUsd', NEW."perRequestCostMicroUsd",
+                'maxReservations', NEW."maxReservations",
+                'costCeilingMicroUsd', NEW."costCeilingMicroUsd",
+                'approvalTtlMinutes', 60,
+                'approvedAt', audit."metadata"->'approvedAt',
+                'approvalExpiresAt', audit."metadata"->'approvalExpiresAt',
+                'reason', 'bounded_staging_shadow_cost_approval'
+           )
+           OR jsonb_typeof(audit."metadata"->'approvedAt') <> 'string'
+           OR jsonb_typeof(audit."metadata"->'approvalExpiresAt') <> 'string'
+           OR audit_approved_at < observed_at - INTERVAL '1 minute'
+           OR audit_approved_at > observed_at
+           OR audit_expires_at <> audit_approved_at + INTERVAL '60 minutes'
+           OR NEW."approvedAt" IS DISTINCT FROM audit_approved_at
+           OR NEW."approvalExpiresAt" IS DISTINCT FROM audit_expires_at THEN
+            RAISE EXCEPTION 'PromptRefinerReservationStage authorization audit binding is invalid';
+        END IF;
+        NEW."createdAt" := observed_at;
+        NEW."updatedAt" := observed_at;
+        RETURN NEW;
+    END IF;
+    IF NEW."id" IS DISTINCT FROM OLD."id"
+       OR NEW."contractVersion" IS DISTINCT FROM OLD."contractVersion"
+       OR NEW."contractDigest" IS DISTINCT FROM OLD."contractDigest"
+       OR NEW."perRequestCostMicroUsd" IS DISTINCT FROM OLD."perRequestCostMicroUsd"
+       OR NEW."maxReservations" IS DISTINCT FROM OLD."maxReservations"
+       OR NEW."costCeilingMicroUsd" IS DISTINCT FROM OLD."costCeilingMicroUsd"
+       OR NEW."admissionVersion" IS DISTINCT FROM OLD."admissionVersion"
+       OR NEW."proposalVersion" IS DISTINCT FROM OLD."proposalVersion"
+       OR NEW."proposalDigest" IS DISTINCT FROM OLD."proposalDigest"
+       OR NEW."evidenceBundleDigest" IS DISTINCT FROM OLD."evidenceBundleDigest"
+       OR NEW."evidenceManifestSha256" IS DISTINCT FROM OLD."evidenceManifestSha256"
+       OR NEW."historicalSourceRef" IS DISTINCT FROM OLD."historicalSourceRef"
+       OR NEW."historicalSourceIdentityDigest" IS DISTINCT FROM OLD."historicalSourceIdentityDigest"
+       OR NEW."corpusDigest" IS DISTINCT FROM OLD."corpusDigest"
+       OR NEW."runtimeCommitSha" IS DISTINCT FROM OLD."runtimeCommitSha"
+       OR NEW."runtimeSourceIdentityDigest" IS DISTINCT FROM OLD."runtimeSourceIdentityDigest"
+       OR NEW."runtimeSourceManifest" IS DISTINCT FROM OLD."runtimeSourceManifest"
+       OR NEW."runtimeSourceManifestDigest" IS DISTINCT FROM OLD."runtimeSourceManifestDigest"
+       OR NEW."runtimeEnvironment" IS DISTINCT FROM OLD."runtimeEnvironment"
+       OR NEW."runtimeDeploymentId" IS DISTINCT FROM OLD."runtimeDeploymentId"
+       OR NEW."executionManifest" IS DISTINCT FROM OLD."executionManifest"
+       OR NEW."executionManifestDigest" IS DISTINCT FROM OLD."executionManifestDigest"
+       OR NEW."approvedBy" IS DISTINCT FROM OLD."approvedBy"
+       OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
+       OR NEW."approvalExpiresAt" IS DISTINCT FROM OLD."approvalExpiresAt"
+       OR NEW."authorizationAuditLogId" IS DISTINCT FROM OLD."authorizationAuditLogId"
+       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
+        RAISE EXCEPTION 'PromptRefinerReservationStage % contract is immutable', OLD."id";
+    END IF;
+    IF NEW."status" IS DISTINCT FROM OLD."status"
+       AND NOT (OLD."status" = 'approved' AND NEW."status" = 'closed') THEN
+        RAISE EXCEPTION 'PromptRefinerReservationStage % status transition is invalid', OLD."id";
+    END IF;
+    IF NEW."reservationCount" = OLD."reservationCount"
+       AND NEW."allocatedCostMicroUsd" = OLD."allocatedCostMicroUsd" THEN
+        RETURN NEW;
+    END IF;
+    SELECT COUNT(*)::INTEGER, COALESCE(SUM("reservedCostMicroUsd"), 0)::BIGINT
+    INTO actual_count, actual_cost FROM "PromptRefinerReservation"
+    WHERE "stageId" = OLD."id";
+    IF NEW."reservationCount" <> actual_count
+       OR NEW."allocatedCostMicroUsd" <> actual_cost THEN
+        RAISE EXCEPTION 'PromptRefinerReservationStage % accounting must equal durable tombstones', OLD."id";
+    END IF;
+    RETURN NEW;
+END;
+$$ LANGUAGE plpgsql;
+
+CREATE OR REPLACE FUNCTION "prompt_refiner_reservation_insert_guard"()
+RETURNS TRIGGER AS $$
+DECLARE
+    stage "PromptRefinerReservationStage"%ROWTYPE;
+    observed_at TIMESTAMP(3);
+BEGIN
+    observed_at := (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
+    IF NEW."status" <> 'reserved' OR NEW."consumedAt" IS NOT NULL
+       OR NEW."releasedAt" IS NOT NULL OR NEW."expiredAt" IS NOT NULL
+       OR NEW."stageId" <> 'prompt-refiner-shadow-v2'
+       OR NEW."contractDigest" <> 'sha256:6b60c957793effe904d82748d9f7353d6490d150eff66ba4a02f1aac63f376d1'
+       OR NEW."reservedCostMicroUsd" <> 24916
+       OR NEW."expiresAt" <> NEW."createdAt" + INTERVAL '5 minutes'
+       OR NEW."createdAt" > observed_at OR NEW."expiresAt" <= observed_at
+       OR NEW."expiresAt" > observed_at + INTERVAL '5 minutes' THEN
+        RAISE EXCEPTION 'PromptRefinerReservation v2 contract binding is invalid';
+    END IF;
+    SELECT * INTO stage FROM "PromptRefinerReservationStage"
+    WHERE "id" = NEW."stageId" FOR UPDATE;
+    IF NOT FOUND OR stage."status" <> 'approved'
+       OR stage."approvalExpiresAt" <= observed_at
+       OR stage."runtimeEnvironment" <> 'staging'
+       OR stage."contractVersion" <> 'prompt-refiner-execution-contract-v1'
+       OR stage."contractDigest" <> NEW."contractDigest"
+       OR stage."perRequestCostMicroUsd" <> 24916
+       OR stage."maxReservations" <> 100
+       OR stage."costCeilingMicroUsd" <> 2491600 THEN
+        RAISE EXCEPTION 'PromptRefinerReservationStage v2 contract is not approved';
+    END IF;
+    IF stage."reservationCount" >= 100
+       OR stage."allocatedCostMicroUsd" + 24916 > 2491600 THEN
+        RAISE EXCEPTION 'PromptRefinerReservationStage capacity is exhausted';
+    END IF;
+    RETURN NEW;
+END;
+$$ LANGUAGE plpgsql;
+
+CREATE OR REPLACE FUNCTION "prompt_refiner_reservation_account_insert"()
+RETURNS TRIGGER AS $$
+DECLARE
+    affected_stage TEXT;
+    actual_count INTEGER;
+    actual_cost BIGINT;
+    changed INTEGER;
+BEGIN
+    FOR affected_stage IN
+        SELECT DISTINCT "stageId" FROM inserted_reservations
+    LOOP
+        SELECT COUNT(*)::INTEGER, COALESCE(SUM("reservedCostMicroUsd"), 0)::BIGINT
+        INTO actual_count, actual_cost FROM "PromptRefinerReservation"
+        WHERE "stageId" = affected_stage;
+        IF actual_count > 100 OR actual_cost > 2491600 THEN
+            RAISE EXCEPTION 'PromptRefinerReservationStage capacity is exhausted';
+        END IF;
+        UPDATE "PromptRefinerReservationStage"
+        SET "reservationCount" = actual_count,
+            "allocatedCostMicroUsd" = actual_cost,
+            "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
+        WHERE "id" = affected_stage;
+        GET DIAGNOSTICS changed = ROW_COUNT;
+        IF changed <> 1 THEN
+            RAISE EXCEPTION 'PromptRefinerReservationStage is missing';
+        END IF;
+    END LOOP;
+    RETURN NULL;
+END;
+$$ LANGUAGE plpgsql;
+
+ALTER TABLE "PromptRefinerShadowRun"
+    ADD COLUMN "evidenceSpecDigest" TEXT;
+ALTER TABLE "PromptRefinerShadowAttempt"
+    ADD COLUMN "evidence" JSONB;
+
+ALTER TABLE "PromptRefinerShadowRun"
+    DROP CONSTRAINT "PromptRefinerShadowRun_contract_check";
+ALTER TABLE "PromptRefinerShadowRun"
+    ADD CONSTRAINT "PromptRefinerShadowRun_contract_check" CHECK (
+        "corpusDigest" = 'bcb2709f74aa4983595a7121ad27c3abd80946a6e28d36442cf440f6dcf22958'
+        AND "adapterVersion" = 'prompt-refiner-openai-sdk-adapter-v1'
+        AND "perRequestCostMicroUsd" = 24916
+        AND "maxDispatches" = 16
+        AND "costCeilingMicroUsd" = 398656
+        AND (
+            ("stageId" = 'prompt-refiner-shadow-v1'
+             AND "runContractVersion" = 'prompt-refiner-shadow-run-v3'
+             AND "runContractDigest" = 'sha256:7c487a9b88258f5be3e704bcea0c491def7a9f96830b66c6cbd3512361ecf280'
+             AND "evidenceSpecDigest" IS NULL)
+            OR
+            ("stageId" = 'prompt-refiner-shadow-v2'
+             AND "runContractVersion" = 'prompt-refiner-shadow-run-v4'
+             AND "runContractDigest" = 'sha256:16051b8c1c10d1d14b85e65dc3697cf7230dd6c9bce8a30bb03d328f963eafd7'
+             AND "evidenceSpecDigest" = '7794b9fbbd8fba1f16d19f935a977098f3f7a8d302014d6e7de3fe00813ae4c1')
+        )
+    );
+
+ALTER TABLE "PromptRefinerShadowAttempt"
+    DROP CONSTRAINT "PromptRefinerShadowAttempt_binding_check",
+    DROP CONSTRAINT "PromptRefinerShadowAttempt_terminal_check";
+ALTER TABLE "PromptRefinerShadowAttempt"
+    ADD CONSTRAINT "PromptRefinerShadowAttempt_v4_duration_check" CHECK (
+        "runContractDigest" <> 'sha256:16051b8c1c10d1d14b85e65dc3697cf7230dd6c9bce8a30bb03d328f963eafd7'
+        OR "durationMs" IS NULL
+        OR "durationMs" <= 60000
+    ),
+    ADD CONSTRAINT "PromptRefinerShadowAttempt_binding_check" CHECK (
+        "id" ~ '^[A-Za-z0-9:_-]{1,128}$'
+        AND "runId" ~ '^[A-Za-z0-9:_-]{1,128}$'
+        AND "reservationId" ~ '^[A-Za-z0-9:_-]{1,128}$'
+        AND "requestId" ~ '^[A-Za-z0-9:_-]{1,128}$'
+        AND "caseId" ~ '^[A-Za-z0-9._:-]{1,128}$'
+        AND "caseIndex" BETWEEN 0 AND 15
+        AND "provider" = 'openai' AND "modelId" = 'gpt-5-6-luna'
+        AND "adapterVersion" = 'prompt-refiner-openai-sdk-adapter-v1'
+        AND (
+            ("stageId" = 'prompt-refiner-shadow-v1'
+             AND "reservationContractDigest" = 'sha256:c5cc412eb47821d56f6eed2e837d11086a9ab744069715e90d33ea37a378d55f'
+             AND "runContractDigest" = 'sha256:7c487a9b88258f5be3e704bcea0c491def7a9f96830b66c6cbd3512361ecf280')
+            OR
+            ("stageId" = 'prompt-refiner-shadow-v2'
+             AND "reservationContractDigest" = 'sha256:6b60c957793effe904d82748d9f7353d6490d150eff66ba4a02f1aac63f376d1'
+             AND "runContractDigest" = 'sha256:16051b8c1c10d1d14b85e65dc3697cf7230dd6c9bce8a30bb03d328f963eafd7')
+        )
+    ),
+    ADD CONSTRAINT "PromptRefinerShadowAttempt_terminal_check" CHECK (
+        ("status" = 'dispatch_intent'
+         AND "terminalReason" IS NULL AND "failureLayer" IS NULL
+         AND "failureCode" IS NULL AND "terminalAt" IS NULL
+         AND "durationMs" IS NULL AND "inputTokens" IS NULL
+         AND "cachedInputTokens" IS NULL AND "cacheWriteInputTokens" IS NULL
+         AND "outputTokens" IS NULL AND "reasoningTokens" IS NULL
+         AND "actualCostMicroUsd" IS NULL AND "terminalAuditLogId" IS NULL
+         AND "evidence" IS NULL)
+        OR
+        ("status" = 'terminal'
+         AND "terminalReason" IN ('suggested','provider_error','timeout','invalid_response','empty_response','no_change','cancelled_after_dispatch','unknown_after_dispatch')
+         AND "terminalAt" IS NOT NULL AND "terminalAuditLogId" IS NOT NULL
+         AND (
+            ("terminalReason" = 'suggested' AND "failureLayer" = 'none' AND "failureCode" IS NULL)
+            OR ("terminalReason" IN ('provider_error','timeout','cancelled_after_dispatch','unknown_after_dispatch')
+                AND "failureLayer" = 'provider' AND "failureCode" IS NOT NULL)
+            OR ("terminalReason" IN ('invalid_response','empty_response','no_change')
+                AND "failureLayer" = 'response_validation' AND "failureCode" = "terminalReason")
+         )
+         AND (
+            ("runContractDigest" = 'sha256:7c487a9b88258f5be3e704bcea0c491def7a9f96830b66c6cbd3512361ecf280'
+             AND "evidence" IS NULL)
+            OR
+            ("runContractDigest" = 'sha256:16051b8c1c10d1d14b85e65dc3697cf7230dd6c9bce8a30bb03d328f963eafd7'
+             AND jsonb_typeof("evidence") = 'object'
+             AND "evidence"->>'caseId' = "caseId"
+             AND "evidence"->>'terminalStatus' = CASE
+                    WHEN "terminalReason" = 'suggested' THEN 'suggested'
+                    WHEN "terminalReason" = 'unknown_after_dispatch' THEN 'unknown'
+                    ELSE 'failed' END
+             AND "evidence" = jsonb_build_object(
+                    'caseId', "evidence"->'caseId',
+                    'language', "evidence"->'language',
+                    'category', "evidence"->'category',
+                    'terminalStatus', "evidence"->'terminalStatus',
+                    'evidenceStatus', "evidence"->'evidenceStatus',
+                    'distinctFromSource', "evidence"->'distinctFromSource',
+                    'lengthWithinBounds', "evidence"->'lengthWithinBounds',
+                    'languageMatched', "evidence"->'languageMatched',
+                    'requiredConceptGroups', "evidence"->'requiredConceptGroups',
+                    'matchedConceptGroups', "evidence"->'matchedConceptGroups',
+                    'requiredExactLiterals', "evidence"->'requiredExactLiterals',
+                    'preservedExactLiterals', "evidence"->'preservedExactLiterals',
+                    'injectionSafelyFramed', "evidence"->'injectionSafelyFramed',
+                    'lengthBucket', "evidence"->'lengthBucket',
+                    'failureReasons', "evidence"->'failureReasons'
+             ))
+         )
+        )
+    );
+
+CREATE OR REPLACE FUNCTION "prompt_refiner_shadow_run_insert_guard"()
+RETURNS TRIGGER AS $$
+DECLARE
+    observed_at TIMESTAMP(3);
+    stage "PromptRefinerReservationStage"%ROWTYPE;
+    audit "AdminAuditLog"%ROWTYPE;
+    audit_approved_at TIMESTAMP(3);
+    audit_expires_at TIMESTAMP(3);
+BEGIN
+    observed_at := (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
+    IF NEW."stageId" <> 'prompt-refiner-shadow-v2'
+       OR NEW."runContractVersion" <> 'prompt-refiner-shadow-run-v4'
+       OR NEW."status" <> 'approved' OR NEW."dispatchCount" <> 0
+       OR NEW."terminalCount" <> 0 OR NEW."knownActualCostMicroUsd" <> 0
+       OR NEW."startedAt" IS NOT NULL OR NEW."completedAt" IS NOT NULL
+       OR NEW."stoppedAt" IS NOT NULL OR NEW."stopReason" IS NOT NULL THEN
+        RAISE EXCEPTION 'PromptRefinerShadowRun v4 must start approved and empty';
+    END IF;
+    IF NEW."approvedAt" > observed_at OR NEW."approvalExpiresAt" <= observed_at
+       OR NEW."createdAt" < NEW."approvedAt"
+       OR NEW."createdAt" > observed_at + INTERVAL '1 minute' THEN
+        RAISE EXCEPTION 'PromptRefinerShadowRun approval time is invalid';
+    END IF;
+    SELECT * INTO stage FROM "PromptRefinerReservationStage"
+    WHERE "id" = NEW."stageId" FOR UPDATE;
+    IF NOT FOUND OR stage."status" <> 'approved'
+       OR stage."approvalExpiresAt" <= observed_at
+       OR NEW."approvalExpiresAt" > stage."approvalExpiresAt"
+       OR stage."contractDigest" <> 'sha256:6b60c957793effe904d82748d9f7353d6490d150eff66ba4a02f1aac63f376d1'
+       OR stage."corpusDigest" <> NEW."corpusDigest"
+       OR stage."runtimeCommitSha" <> NEW."runtimeCommitSha"
+       OR stage."runtimeDeploymentId" <> NEW."runtimeDeploymentId" THEN
+        RAISE EXCEPTION 'PromptRefinerShadowRun stage binding is invalid';
+    END IF;
+    SELECT * INTO audit FROM "AdminAuditLog"
+    WHERE "id" = NEW."authorizationAuditLogId";
+    audit_approved_at := ((audit."metadata"->>'approvedAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')::TIMESTAMP(3);
+    audit_expires_at := ((audit."metadata"->>'approvalExpiresAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')::TIMESTAMP(3);
+    IF NOT FOUND OR audit."actorUserId" IS DISTINCT FROM NEW."approvedBy"
+       OR audit."action" <> 'prompt_refiner.shadow_run.approved'
+       OR audit."targetType" <> 'PromptRefinerShadowRun'
+       OR audit."targetId" IS DISTINCT FROM NEW."id"
+       OR audit."summary" <> 'Approved one bounded Prompt Refiner staging shadow run.'
+       OR audit."entryHash" IS NULL OR audit."entryHash" !~ '^[a-f0-9]{64}$'
+       OR audit."metadata" IS DISTINCT FROM jsonb_build_object(
+            'stageId', NEW."stageId",
+            'runContractVersion', NEW."runContractVersion",
+            'runContractDigest', NEW."runContractDigest",
+            'corpusDigest', NEW."corpusDigest",
+            'evidenceSpecDigest', NEW."evidenceSpecDigest",
+            'adapterVersion', NEW."adapterVersion",
+            'runtimeSourceManifestDigest', NEW."runtimeSourceManifestDigest",
+            'previewBindingDigest', NEW."previewBindingDigest",
+            'runtimeDeploymentId', NEW."runtimeDeploymentId",
+            'runtimeCommitSha', NEW."runtimeCommitSha",
+            'perRequestCostMicroUsd', NEW."perRequestCostMicroUsd",
+            'maxDispatches', NEW."maxDispatches",
+            'costCeilingMicroUsd', NEW."costCeilingMicroUsd",
+            'timeoutMs', 15000, 'retryCount', 0,
+            'unknownOutcomePolicy', 'stop_no_redispatch',
+            'approvedAt', audit."metadata"->'approvedAt',
+            'approvalExpiresAt', audit."metadata"->'approvalExpiresAt',
+            'executionAdmitted', true, 'productAdapterReady', false
+       )
+       OR jsonb_typeof(audit."metadata"->'approvedAt') <> 'string'
+       OR jsonb_typeof(audit."metadata"->'approvalExpiresAt') <> 'string'
+       OR NEW."approvedAt" IS DISTINCT FROM audit_approved_at
+       OR NEW."approvalExpiresAt" IS DISTINCT FROM audit_expires_at THEN
+        RAISE EXCEPTION 'PromptRefinerShadowRun authorization audit binding is invalid';
+    END IF;
+    RETURN NEW;
+END;
+$$ LANGUAGE plpgsql;
+
+CREATE OR REPLACE FUNCTION "prompt_refiner_shadow_run_guard"()
+RETURNS TRIGGER AS $$
+DECLARE
+    observed_at TIMESTAMP(3);
+    actual_dispatches INTEGER;
+    actual_terminals INTEGER;
+    actual_cost BIGINT;
+BEGIN
+    IF TG_OP = 'DELETE' THEN
+        RAISE EXCEPTION 'PromptRefinerShadowRun % cannot be deleted', OLD."id";
+    END IF;
+    IF NEW."id" IS DISTINCT FROM OLD."id"
+       OR NEW."stageId" IS DISTINCT FROM OLD."stageId"
+       OR NEW."runContractVersion" IS DISTINCT FROM OLD."runContractVersion"
+       OR NEW."runContractDigest" IS DISTINCT FROM OLD."runContractDigest"
+       OR NEW."corpusDigest" IS DISTINCT FROM OLD."corpusDigest"
+       OR NEW."evidenceSpecDigest" IS DISTINCT FROM OLD."evidenceSpecDigest"
+       OR NEW."adapterVersion" IS DISTINCT FROM OLD."adapterVersion"
+       OR NEW."perRequestCostMicroUsd" IS DISTINCT FROM OLD."perRequestCostMicroUsd"
+       OR NEW."maxDispatches" IS DISTINCT FROM OLD."maxDispatches"
+       OR NEW."costCeilingMicroUsd" IS DISTINCT FROM OLD."costCeilingMicroUsd"
+       OR NEW."runtimeCommitSha" IS DISTINCT FROM OLD."runtimeCommitSha"
+       OR NEW."runtimeDeploymentId" IS DISTINCT FROM OLD."runtimeDeploymentId"
+       OR NEW."runtimeSourceManifest" IS DISTINCT FROM OLD."runtimeSourceManifest"
+       OR NEW."runtimeSourceManifestDigest" IS DISTINCT FROM OLD."runtimeSourceManifestDigest"
+       OR NEW."previewBindingDigest" IS DISTINCT FROM OLD."previewBindingDigest"
+       OR NEW."approvedBy" IS DISTINCT FROM OLD."approvedBy"
+       OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
+       OR NEW."approvalExpiresAt" IS DISTINCT FROM OLD."approvalExpiresAt"
+       OR NEW."authorizationAuditLogId" IS DISTINCT FROM OLD."authorizationAuditLogId"
+       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
+        RAISE EXCEPTION 'PromptRefinerShadowRun % binding is immutable', OLD."id";
+    END IF;
+    IF OLD."status" = 'completed' THEN
+        RAISE EXCEPTION 'PromptRefinerShadowRun % is terminal', OLD."id";
+    END IF;
+    IF OLD."status" = 'stopped_unknown' AND NEW."status" <> 'stopped_unknown' THEN
+        RAISE EXCEPTION 'PromptRefinerShadowRun % unknown latch is immutable', OLD."id";
+    END IF;
+    IF NOT ((NEW."status" = OLD."status")
+       OR (OLD."status" = 'approved' AND NEW."status" = 'running')
+       OR (OLD."status" = 'running' AND NEW."status" IN ('completed','stopped_unknown'))) THEN
+        RAISE EXCEPTION 'PromptRefinerShadowRun % transition is invalid', OLD."id";
+    END IF;
+    observed_at := (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
+    IF NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
+       OR NEW."completedAt" IS DISTINCT FROM OLD."completedAt"
+       OR NEW."stoppedAt" IS DISTINCT FROM OLD."stoppedAt"
+       OR NEW."stopReason" IS DISTINCT FROM OLD."stopReason" THEN
+        RAISE EXCEPTION 'PromptRefinerShadowRun % timestamps are database-owned', OLD."id";
+    END IF;
+    IF OLD."status" = 'approved' AND NEW."status" = 'running' THEN
+        NEW."startedAt" := observed_at;
+    ELSIF NEW."status" = 'completed' THEN
+        NEW."completedAt" := observed_at;
+    ELSIF OLD."status" <> 'stopped_unknown' AND NEW."status" = 'stopped_unknown' THEN
+        NEW."stoppedAt" := observed_at;
+        NEW."stopReason" := 'unknown_after_dispatch';
+    END IF;
+    SELECT COUNT(*)::INTEGER,
+           COUNT(*) FILTER (WHERE "status" = 'terminal')::INTEGER,
+           COALESCE(SUM("actualCostMicroUsd") FILTER (WHERE "status" = 'terminal'), 0)::BIGINT
+    INTO actual_dispatches, actual_terminals, actual_cost
+    FROM "PromptRefinerShadowAttempt" WHERE "runId" = OLD."id";
+    IF NEW."dispatchCount" <> actual_dispatches
+       OR NEW."terminalCount" <> actual_terminals
+       OR NEW."knownActualCostMicroUsd" <> actual_cost THEN
+        RAISE EXCEPTION 'PromptRefinerShadowRun % accounting must equal attempts', OLD."id";
+    END IF;
+    NEW."updatedAt" := observed_at;
+    RETURN NEW;
+END;
+$$ LANGUAGE plpgsql;
+
+CREATE OR REPLACE FUNCTION "prompt_refiner_shadow_attempt_insert_guard"()
+RETURNS TRIGGER AS $$
+DECLARE
+    observed_at TIMESTAMP(3);
+    run "PromptRefinerShadowRun"%ROWTYPE;
+    reservation "PromptRefinerReservation"%ROWTYPE;
+    audit "AdminAuditLog"%ROWTYPE;
+    admission_tokens INTEGER;
+BEGIN
+    observed_at := (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
+    IF NEW."runContractDigest" <> 'sha256:16051b8c1c10d1d14b85e65dc3697cf7230dd6c9bce8a30bb03d328f963eafd7'
+       OR NEW."status" <> 'dispatch_intent' OR NEW."evidence" IS NOT NULL
+       OR NEW."dispatchIntentAt" <> NEW."createdAt"
+       OR NEW."dispatchIntentAt" > observed_at
+       OR NEW."dispatchIntentAt" < observed_at - INTERVAL '1 minute' THEN
+        RAISE EXCEPTION 'PromptRefinerShadowAttempt v4 must start as a current dispatch intent';
+    END IF;
+    SELECT * INTO run FROM "PromptRefinerShadowRun"
+    WHERE "id" = NEW."runId" FOR UPDATE;
+    IF NOT FOUND OR run."status" NOT IN ('approved','running')
+       OR run."approvalExpiresAt" <= observed_at
+       OR run."runContractDigest" <> NEW."runContractDigest"
+       OR run."stageId" <> NEW."stageId"
+       OR run."adapterVersion" <> NEW."adapterVersion"
+       OR run."dispatchCount" >= run."maxDispatches"
+       OR run."knownActualCostMicroUsd" > run."costCeilingMicroUsd" THEN
+        RAISE EXCEPTION 'PromptRefinerShadowRun cannot accept a dispatch intent';
+    END IF;
+    SELECT * INTO reservation FROM "PromptRefinerReservation"
+    WHERE "id" = NEW."reservationId" FOR UPDATE;
+    IF NOT FOUND OR reservation."status" <> 'reserved'
+       OR reservation."expiresAt" <= observed_at
+       OR reservation."requestId" <> NEW."requestId"
+       OR reservation."stageId" <> NEW."stageId"
+       OR reservation."contractDigest" <> NEW."reservationContractDigest" THEN
+        RAISE EXCEPTION 'PromptRefinerShadowAttempt reservation binding is invalid';
+    END IF;
+    SELECT * INTO audit FROM "AdminAuditLog" WHERE "id" = NEW."dispatchAuditLogId";
+    IF jsonb_typeof(audit."metadata"->'admissionInputTokens') = 'number' THEN
+        admission_tokens := (audit."metadata"->>'admissionInputTokens')::INTEGER;
+    END IF;
+    IF NOT FOUND OR audit."actorUserId" IS NOT NULL
+       OR audit."action" <> 'prompt_refiner.shadow_dispatch.intent_recorded'
+       OR audit."targetType" <> 'PromptRefinerShadowAttempt'
+       OR audit."targetId" IS DISTINCT FROM NEW."id"
+       OR audit."summary" <> 'Recorded one Prompt Refiner provider dispatch intent.'
+       OR audit."metadata"->>'systemActor' IS DISTINCT FROM 'prompt-refiner-shadow-runner'
+       OR audit."metadata"->>'runId' IS DISTINCT FROM NEW."runId"
+       OR audit."metadata"->>'reservationId' IS DISTINCT FROM NEW."reservationId"
+       OR audit."metadata"->>'requestId' IS DISTINCT FROM NEW."requestId"
+       OR audit."metadata"->>'caseId' IS DISTINCT FROM NEW."caseId"
+       OR (audit."metadata"->>'caseIndex')::INTEGER IS DISTINCT FROM NEW."caseIndex"
+       OR audit."metadata"->>'runContractDigest' IS DISTINCT FROM NEW."runContractDigest"
+       OR audit."metadata"->>'adapterVersion' IS DISTINCT FROM NEW."adapterVersion"
+       OR audit."metadata"->>'provider' IS DISTINCT FROM NEW."provider"
+       OR audit."metadata"->>'modelId' IS DISTINCT FROM NEW."modelId"
+       OR (audit."metadata"->>'timeoutMs')::INTEGER IS DISTINCT FROM 15000
+       OR (audit."metadata"->>'retryCount')::INTEGER IS DISTINCT FROM 0
+       OR audit."metadata"->>'tokenizerPackage' IS DISTINCT FROM 'js-tiktoken'
+       OR audit."metadata"->>'tokenizerPackageVersion' IS DISTINCT FROM '1.0.21'
+       OR audit."metadata"->>'tokenizerEncoding' IS DISTINCT FROM 'o200k_base'
+       OR admission_tokens IS NULL OR admission_tokens < 0 OR admission_tokens > 100000 THEN
+        RAISE EXCEPTION 'PromptRefinerShadowAttempt dispatch audit binding is invalid';
+    END IF;
+    RETURN NEW;
+END;
+$$ LANGUAGE plpgsql;
+
+CREATE OR REPLACE FUNCTION "prompt_refiner_shadow_attempt_guard"()
+RETURNS TRIGGER AS $$
+DECLARE
+    observed_at TIMESTAMP(3);
+    audit "AdminAuditLog"%ROWTYPE;
+BEGIN
+    IF TG_OP = 'DELETE' THEN
+        RAISE EXCEPTION 'PromptRefinerShadowAttempt % cannot be deleted', OLD."id";
+    END IF;
+    IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."runId" IS DISTINCT FROM OLD."runId"
+       OR NEW."reservationId" IS DISTINCT FROM OLD."reservationId"
+       OR NEW."requestId" IS DISTINCT FROM OLD."requestId"
+       OR NEW."caseId" IS DISTINCT FROM OLD."caseId"
+       OR NEW."caseIndex" IS DISTINCT FROM OLD."caseIndex"
+       OR NEW."stageId" IS DISTINCT FROM OLD."stageId"
+       OR NEW."reservationContractDigest" IS DISTINCT FROM OLD."reservationContractDigest"
+       OR NEW."runContractDigest" IS DISTINCT FROM OLD."runContractDigest"
+       OR NEW."provider" IS DISTINCT FROM OLD."provider"
+       OR NEW."modelId" IS DISTINCT FROM OLD."modelId"
+       OR NEW."adapterVersion" IS DISTINCT FROM OLD."adapterVersion"
+       OR NEW."dispatchIntentAt" IS DISTINCT FROM OLD."dispatchIntentAt"
+       OR NEW."dispatchAuditLogId" IS DISTINCT FROM OLD."dispatchAuditLogId"
+       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
+        RAISE EXCEPTION 'PromptRefinerShadowAttempt % binding is immutable', OLD."id";
+    END IF;
+    IF OLD."status" <> 'dispatch_intent' OR NEW."status" <> 'terminal' THEN
+        RAISE EXCEPTION 'PromptRefinerShadowAttempt % terminal is immutable', OLD."id";
+    END IF;
+    IF NEW."terminalAt" IS NOT NULL THEN
+        RAISE EXCEPTION 'PromptRefinerShadowAttempt % terminal timestamp is database-owned', OLD."id";
+    END IF;
+    SELECT * INTO audit FROM "AdminAuditLog" WHERE "id" = NEW."terminalAuditLogId";
+    IF NOT FOUND OR audit."actorUserId" IS NOT NULL
+       OR audit."action" <> 'prompt_refiner.shadow_dispatch.terminal_recorded'
+       OR audit."targetType" <> 'PromptRefinerShadowAttempt'
+       OR audit."targetId" IS DISTINCT FROM NEW."id"
+       OR audit."metadata"->>'systemActor' IS DISTINCT FROM 'prompt-refiner-shadow-runner'
+       OR audit."metadata"->>'runId' IS DISTINCT FROM NEW."runId"
+       OR audit."metadata"->>'reservationId' IS DISTINCT FROM NEW."reservationId"
+       OR audit."metadata"->>'requestId' IS DISTINCT FROM NEW."requestId"
+       OR audit."metadata"->>'terminalReason' IS DISTINCT FROM NEW."terminalReason"
+       OR audit."metadata"->'evidence' IS DISTINCT FROM NEW."evidence" THEN
+        RAISE EXCEPTION 'PromptRefinerShadowAttempt terminal audit binding is invalid';
+    END IF;
+    observed_at := (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
+    NEW."terminalAt" := observed_at;
+    NEW."updatedAt" := observed_at;
+    RETURN NEW;
+END;
+$$ LANGUAGE plpgsql;
diff --git a/prisma/schema.prisma b/prisma/schema.prisma
index 1206da87..bcdb175e 100644
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -5536,7 +5536,7 @@ model PromptRefinerReservationStage {
   corpusDigest                   String
   runtimeCommitSha               String
   runtimeSourceIdentityDigest    String
-  /// Content-free v2 manifest for the exact 187-file runtime import closure;
+  /// Content-free v3 manifest for the exact 188-file runtime import closure;
   /// the database validates ordered paths plus 8 MiB/file and 16 MiB total.
   runtimeSourceManifest          Json
   runtimeSourceManifestDigest    String
@@ -5586,6 +5586,9 @@ model PromptRefinerShadowRun {
   runContractVersion          String
   runContractDigest           String    @unique
   corpusDigest                String
+  /// Null only for the immutable historical v3 run. Every v4 run is bound to
+  /// the reviewed evidence specification before approval.
+  evidenceSpecDigest          String?
   adapterVersion              String
   status                      String    @default("approved")
   perRequestCostMicroUsd      BigInt
@@ -5645,6 +5648,9 @@ model PromptRefinerShadowAttempt {
   outputTokens              Int?
   reasoningTokens           Int?
   actualCostMicroUsd        BigInt?
+  /// Closed, content-free case evidence. Historical v3 attempts remain null;
+  /// v4 writes this atomically with the terminal receipt.
+  evidence                  Json?
   dispatchAuditLogId        String    @unique
   terminalAuditLogId        String?   @unique
   createdAt                 DateTime  @default(now())
diff --git a/scripts/check-enum-constraints.mjs b/scripts/check-enum-constraints.mjs
index 8b81edd5..bad4f140 100644
--- a/scripts/check-enum-constraints.mjs
+++ b/scripts/check-enum-constraints.mjs
@@ -450,6 +450,13 @@ const REGISTRY = {
     reason:
       "The reservation lifecycle, written by the credit paths as literals inside the transactions that move it.",
   },
+  PromptRefinerReservationStage_id_check: {
+    owner: "list",
+    module: "lib/promptRefinerReservationCore.ts",
+    list: "PROMPT_REFINER_RESERVATION_STAGE_IDS",
+    reason:
+      "The append-only stage identities preserve the completed v1 authority while admitting the separately approved v2 contract. The active writer still selects only PROMPT_REFINER_RESERVATION_STAGE_ID.",
+  },
   PromptRefinerReservationStage_status_check: {
     owner: "list",
     module: "lib/promptRefinerReservationCore.ts",
diff --git a/scripts/check-protected-table-writers-core.mjs b/scripts/check-protected-table-writers-core.mjs
index 9e934343..3d1c2a19 100644
--- a/scripts/check-protected-table-writers-core.mjs
+++ b/scripts/check-protected-table-writers-core.mjs
@@ -389,6 +389,30 @@ export const RAW_SQL_ALLOWLIST = [
     reason:
       "The execution-runner migration fails closed on existing attempts, then replaces the exact v3 binding and insert guard for tokenizer facts. Its ALTER/DROP vocabulary changes DDL only and the migration seeds no attempt.",
   },
+  {
+    path: "prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql",
+    table: "AdminAuditLog",
+    tableMentions: 8,
+    writeVerbs: 26,
+    reason:
+      "The confirmatory-shadow migration reads exact human/system audit rows from replacement guards and changes DDL only. It seeds no stage, reservation, run, attempt or audit row.",
+  },
+  {
+    path: "prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql",
+    table: "PromptRefinerShadowRun",
+    tableMentions: 18,
+    writeVerbs: 26,
+    reason:
+      "The migration adds an evidence-spec binding and replaces fail-closed v4 constraints/triggers while preserving historical v3 rows. It contains no run DML and seeds no authority.",
+  },
+  {
+    path: "prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql",
+    table: "PromptRefinerShadowAttempt",
+    tableMentions: 14,
+    writeVerbs: 26,
+    reason:
+      "The migration adds the content-free evidence column and binds terminal evidence to the existing audit transaction. It contains no attempt DML and seeds no evidence.",
+  },
   {
     path: "scripts/report-unswept-tables-core.mjs",
     table: "MarketingReport",
diff --git a/tests/gitleaksAllowlist.test.mjs b/tests/gitleaksAllowlist.test.mjs
index 2fe247c5..d189b0f3 100644
--- a/tests/gitleaksAllowlist.test.mjs
+++ b/tests/gitleaksAllowlist.test.mjs
@@ -19,6 +19,10 @@ import test from "node:test";
  */
 
 const config = readFileSync(new URL("../.gitleaks.toml", import.meta.url), "utf8");
+const fingerprintIgnore = readFileSync(
+  new URL("../.gitleaksignore", import.meta.url),
+  "utf8"
+);
 
 /**
  * Every multi-line-literal pattern in the allowlist, read from the `regexes`
@@ -141,3 +145,25 @@ test("no allowlist pattern accepts an unconstrained value class", () => {
     );
   }
 });
+
+test("every gitleaks ignore is one exact, unique finding fingerprint", () => {
+  const entries = fingerprintIgnore
+    .split(/\r?\n/u)
+    .map((line) => line.trim())
+    .filter((line) => line.length > 0 && !line.startsWith("#"));
+  const fingerprint = /^[0-9a-f]{40}:[^:]+:[A-Za-z0-9._-]+:\d+$/u;
+
+  assert.ok(entries.length > 0, "expected at least one pinned false positive");
+  assert.equal(
+    new Set(entries).size,
+    entries.length,
+    ".gitleaksignore must not repeat a fingerprint"
+  );
+  for (const entry of entries) {
+    assert.match(
+      entry,
+      fingerprint,
+      `.gitleaksignore entries must bind commit, path, rule and line: ${entry}`
+    );
+  }
+});
diff --git a/tests/integration/prompt-refiner-shadow-run.db.test.ts b/tests/integration/prompt-refiner-shadow-run.db.test.ts
index 4447fc40..44fae750 100644
--- a/tests/integration/prompt-refiner-shadow-run.db.test.ts
+++ b/tests/integration/prompt-refiner-shadow-run.db.test.ts
@@ -2,6 +2,9 @@ import assert from "node:assert/strict";
 import { before, beforeEach, test } from "node:test";
 import type { Session } from "next-auth";
 
+import corpusJson from "@/docs/ops/prompt-refiner-shadow/corpus-v1.json";
+import evidenceSpecJson from "@/docs/ops/prompt-refiner-shadow/evidence-spec-v1.json";
+
 import { prisma } from "@/lib/prisma";
 import {
     consumePromptRefinerReservation,
@@ -31,9 +34,16 @@ import {
     PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE,
     PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE_VERSION,
 } from "@/lib/promptRefinerShadowRunContract";
+import {
+    PROMPT_REFINER_SHADOW_EVIDENCE_MAX_DURATION_MS,
+    evaluatePromptRefinerShadowCaseEvidence,
+    validatePromptRefinerShadowEvidenceSpec,
+} from "@/lib/promptRefinerShadowEvidenceCore";
+import { validatePromptRefinerShadowCorpus } from "@/lib/promptRefinerShadowHarness";
 import {
     createPromptRefinerShadowRun,
     promptRefinerShadowRunPreview,
+    readPromptRefinerShadowEvidenceBundle,
     readPromptRefinerShadowExecutionState,
     recordPromptRefinerShadowDispatchIntent,
     recordPromptRefinerShadowTerminal,
@@ -163,6 +173,23 @@ const usage = (costUpperBoundMicroUsd: number | null = 44) => ({
     costUpperBoundMicroUsd,
 });
 
+const corpus = validatePromptRefinerShadowCorpus(corpusJson);
+const evidenceSpec = validatePromptRefinerShadowEvidenceSpec(evidenceSpecJson);
+const evidenceFor = (
+    caseIndex: number,
+    terminalStatus: "suggested" | "failed" | "unknown"
+) =>
+    evaluatePromptRefinerShadowCaseEvidence({
+        corpus,
+        spec: evidenceSpec,
+        caseIndex,
+        terminalStatus,
+        refinedPrompt:
+            terminalStatus === "suggested"
+                ? `${corpus.cases[caseIndex]!.sourceText} refined`
+                : null,
+    });
+
 before(async () => {
     await ensureRuntimeModel();
 });
@@ -323,11 +350,42 @@ test("terminal receipt is immutable, idempotent only when exact, and updates cos
     await approveStage();
     await approveRun();
     const { attempt } = await dispatch({ requestId: "shadow_db_terminal_1", caseIndex: 0 });
+    await assert.rejects(
+        recordPromptRefinerShadowTerminal({
+            attemptId: attempt.id,
+            terminalReason: "suggested",
+            durationMs: 12,
+            usage: usage(44),
+            evidence: {
+                ...evidenceFor(0, "suggested"),
+                sourceText: corpus.cases[0]!.sourceText,
+            },
+        }),
+        (error: unknown) =>
+            error instanceof Error &&
+            "code" in error &&
+            error.code === "PROMPT_REFINER_SHADOW_EVIDENCE_INVALID"
+    );
+    assert.equal(
+        await prisma.adminAuditLog.count({
+            where: { action: "prompt_refiner.shadow_dispatch.terminal_recorded" },
+        }),
+        0
+    );
+    assert.equal(
+        (
+            await prisma.promptRefinerShadowAttempt.findUniqueOrThrow({
+                where: { id: attempt.id },
+            })
+        ).status,
+        "dispatch_intent"
+    );
     const first = await recordPromptRefinerShadowTerminal({
         attemptId: attempt.id,
         terminalReason: "suggested",
         durationMs: 12,
         usage: usage(44),
+        evidence: evidenceFor(0, "suggested"),
     });
     assert.equal(first.created, true);
     assert.equal(first.attempt.status, "terminal");
@@ -339,6 +397,7 @@ test("terminal receipt is immutable, idempotent only when exact, and updates cos
         terminalReason: "suggested",
         durationMs: 12,
         usage: usage(44),
+        evidence: evidenceFor(0, "suggested"),
     });
     assert.equal(replay.replayed, true);
     await assert.rejects(
@@ -347,6 +406,7 @@ test("terminal receipt is immutable, idempotent only when exact, and updates cos
             terminalReason: "provider_error",
             durationMs: 12,
             usage: usage(null),
+            evidence: evidenceFor(0, "failed"),
         }),
         (error: unknown) =>
             error instanceof Error &&
@@ -361,6 +421,142 @@ test("terminal receipt is immutable, idempotent only when exact, and updates cos
     );
 });
 
+test("v4 terminal duration is bounded before an immutable receipt can be stored", async () => {
+    await approveStage();
+    await approveRun();
+    const { attempt } = await dispatch({
+        requestId: "shadow_db_duration_bound",
+        caseIndex: 0,
+    });
+    await assert.rejects(
+        recordPromptRefinerShadowTerminal({
+            attemptId: attempt.id,
+            terminalReason: "provider_error",
+            durationMs: 60_001,
+            usage: usage(null),
+            evidence: evidenceFor(0, "failed"),
+        }),
+        (error: unknown) =>
+            error instanceof Error &&
+            "code" in error &&
+            error.code === "PROMPT_REFINER_SHADOW_TERMINAL_INVALID"
+    );
+    assert.equal(
+        (
+            await prisma.promptRefinerShadowAttempt.findUniqueOrThrow({
+                where: { id: attempt.id },
+            })
+        ).status,
+        "dispatch_intent"
+    );
+    const durationConstraints = await prisma.$queryRawUnsafe<Array<{ definition: string }>>(`
+        SELECT pg_get_constraintdef(oid) AS definition
+        FROM pg_constraint
+        WHERE conname = 'PromptRefinerShadowAttempt_v4_duration_check'
+    `);
+    assert.equal(durationConstraints.length, 1);
+    assert.match(
+        durationConstraints[0]!.definition,
+        new RegExp(
+            `"durationMs" <= ${PROMPT_REFINER_SHADOW_EVIDENCE_MAX_DURATION_MS}`
+        )
+    );
+});
+
+test("v4 runtime manifest wrapper preserves strict and parallel-safe validator metadata", async () => {
+    const functions = await prisma.$queryRawUnsafe<
+        Array<{ name: string; parallel: string; strict: boolean }>
+    >(`
+        SELECT
+          proname AS name,
+          proparallel::TEXT AS parallel,
+          proisstrict AS strict
+        FROM pg_proc
+        WHERE proname IN (
+          'prompt_refiner_runtime_manifest_valid',
+          'prompt_refiner_runtime_manifest_v2_valid'
+        )
+        ORDER BY proname
+    `);
+    assert.deepEqual(functions, [
+        {
+            name: "prompt_refiner_runtime_manifest_v2_valid",
+            parallel: "s",
+            strict: true,
+        },
+        {
+            name: "prompt_refiner_runtime_manifest_valid",
+            parallel: "s",
+            strict: true,
+        },
+    ]);
+});
+
+test("completed durable evidence rebuilds a content-free aggregate from all 16 cases", async () => {
+    await approveStage();
+    await approveRun();
+    for (let caseIndex = 0; caseIndex < PROMPT_REFINER_SHADOW_CASE_IDS.length; caseIndex += 1) {
+        const { attempt } = await dispatch({
+            requestId: `shadow_db_evidence_${caseIndex}`,
+            caseIndex,
+        });
+        await recordPromptRefinerShadowTerminal({
+            attemptId: attempt.id,
+            terminalReason: "provider_error",
+            durationMs: 10 + caseIndex,
+            usage: usage(null),
+            evidence: evidenceFor(caseIndex, "failed"),
+        });
+    }
+
+    const bundle = await readPromptRefinerShadowEvidenceBundle();
+    assert.ok(bundle);
+    assert.equal(bundle.gateOutcome, "fail");
+    assert.equal(bundle.summary.attemptedCases, 16);
+    assert.equal(bundle.summary.suggestedCases, 0);
+    assert.equal(bundle.summary.failedCases, 16);
+    assert.equal(bundle.summary.unknownCases, 0);
+    assert.equal(bundle.summary.costReportedCases, 0);
+    assert.equal(bundle.summary.totalCostMicroUsd, null);
+    assert.equal(bundle.summary.latencyReportedCases, 16);
+    assert.equal(bundle.summary.latencyMaxMs, 25);
+    assert.ok(bundle.gateReasons.includes("terminal_failure_present"));
+    assert.ok(bundle.gateReasons.includes("cost_incomplete"));
+    assert.equal(bundle.cases.length, 16);
+
+    const [attempts, audits, run] = await Promise.all([
+        prisma.promptRefinerShadowAttempt.findMany({
+            where: { runId: PROMPT_REFINER_SHADOW_RUN_ID },
+            orderBy: { caseIndex: "asc" },
+        }),
+        prisma.adminAuditLog.findMany({
+            where: { action: "prompt_refiner.shadow_dispatch.terminal_recorded" },
+            orderBy: { createdAt: "asc" },
+        }),
+        prisma.promptRefinerShadowRun.findUniqueOrThrow({
+            where: { id: PROMPT_REFINER_SHADOW_RUN_ID },
+        }),
+    ]);
+    assert.equal(run.status, "completed");
+    assert.equal(run.terminalCount, 16);
+    assert.equal(attempts.length, 16);
+    assert.equal(audits.length, 16);
+    for (const attempt of attempts) {
+        assert.notEqual(attempt.evidence, null);
+        const audit = audits.find((candidate) => candidate.targetId === attempt.id);
+        assert.ok(audit);
+        assert.deepEqual(
+            (audit.metadata as { evidence: unknown }).evidence,
+            attempt.evidence
+        );
+    }
+    const serialized = JSON.stringify({ bundle, attempts, audits });
+    assert.doesNotMatch(
+        serialized,
+        /sourceText|refinedPrompt|responseBody|credential/i
+    );
+});
+
 test("unknown terminal latches the run and refuses every later case without redispatch", async () => {
     await approveStage();
     await approveRun();
@@ -374,6 +570,7 @@ test("unknown terminal latches the run and refuses every later case without redi
         terminalReason: "unknown_after_dispatch",
         durationMs: 60_000,
         usage: usage(null),
+        evidence: evidenceFor(0, "unknown"),
     });
     assert.equal(terminal.run.status, "stopped_unknown");
     assert.equal(terminal.run.stopReason, "unknown_after_dispatch");
@@ -384,6 +581,7 @@ test("unknown terminal latches the run and refuses every later case without redi
         terminalReason: "suggested",
         durationMs: 12,
         usage: usage(44),
+        evidence: evidenceFor(1, "suggested"),
     });
     assert.equal(catchUp.run.status, "stopped_unknown");
     assert.equal(catchUp.run.terminalCount, 2);
@@ -527,6 +725,7 @@ test("sweep reports a conflicting known receipt race without discarding prior cl
             terminalReason: "suggested",
             durationMs: 12,
             usage: usage(44),
+            evidence: evidenceFor(1, "suggested"),
         });
         [sweep] = await Promise.all([sweepPromise, knownReceiptPromise]);
     } finally {
diff --git a/tests/promptRefinerReservationCore.test.mjs b/tests/promptRefinerReservationCore.test.mjs
index 8c172ce8..bfcdb880 100644
--- a/tests/promptRefinerReservationCore.test.mjs
+++ b/tests/promptRefinerReservationCore.test.mjs
@@ -18,6 +18,7 @@ import {
     PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
     PROMPT_REFINER_RESERVATION_REFUSALS,
     PROMPT_REFINER_RESERVATION_STAGE_ID,
+    PROMPT_REFINER_RESERVATION_STAGE_IDS,
     PROMPT_REFINER_RESERVATION_STAGE_STATUSES,
     PROMPT_REFINER_RESERVATION_STATUSES,
     PROMPT_REFINER_RESERVATION_TTL_MS,
@@ -45,16 +46,20 @@ const validStage = (overrides = {}) => ({
 test("reservation contract freezes one bounded, content-free authority", () => {
     assert.equal(
         PROMPT_REFINER_RESERVATION_AUTHORITY_VERSION,
-        "prompt-refiner-reservation-authority-v1"
+        "prompt-refiner-reservation-authority-v2"
     );
-    assert.equal(PROMPT_REFINER_RESERVATION_STAGE_ID, "prompt-refiner-shadow-v1");
+    assert.equal(PROMPT_REFINER_RESERVATION_STAGE_ID, "prompt-refiner-shadow-v2");
+    assert.deepEqual([...PROMPT_REFINER_RESERVATION_STAGE_IDS], [
+        "prompt-refiner-shadow-v1",
+        "prompt-refiner-shadow-v2",
+    ]);
     assert.equal(PROMPT_REFINER_RESERVATION_TTL_MS, 300_000);
     assert.equal(PROMPT_REFINER_RESERVATION_CONTRACT.perRequestCostMicroUsd, 24_916);
     assert.equal(PROMPT_REFINER_RESERVATION_CONTRACT.maxReservations, 100);
     assert.equal(PROMPT_REFINER_RESERVATION_CONTRACT.costCeilingMicroUsd, 2_491_600);
     assert.equal(
         PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
-        "sha256:c5cc412eb47821d56f6eed2e837d11086a9ab744069715e90d33ea37a378d55f"
+        "sha256:6b60c957793effe904d82748d9f7353d6490d150eff66ba4a02f1aac63f376d1"
     );
     assert.deepEqual([...PROMPT_REFINER_RESERVATION_STAGE_STATUSES], [
         "approved",
diff --git a/tests/promptRefinerRuntimeSourceClosure.test.mjs b/tests/promptRefinerRuntimeSourceClosure.test.mjs
index e3ab44d4..ca72ffcf 100644
--- a/tests/promptRefinerRuntimeSourceClosure.test.mjs
+++ b/tests/promptRefinerRuntimeSourceClosure.test.mjs
@@ -82,11 +82,13 @@ const compilerOptions = parsedConfig.options;
 // every entry) hashes to
 // 9aa7ec49f0bdd40002c306305261d6165c8f14250c47e1ce6a6f63bb3a786a65 on this
 // branch and on `origin/develop` alike, so nothing was added, removed or
-// changed. Only positions moved.
+// changed. Confirmatory shadow v4 then adds one reviewed runtime path and its
+// schema/comment changes; the combined branch therefore repins positions once
+// more while preserving the same 228-expression position-free inventory.
 const REVIEWED_DYNAMIC_ELEMENT_ACCESS_COUNT = 228;
 const REVIEWED_DYNAMIC_ELEMENT_ACCESS_SHA256 = [
-  "d0d59c25abe9ea2e08e20f6953d13d83",
-  "982fa70cfe65996fbf98a83a82f4e943",
+  "614df2686c49f80bc43e977faa4c0e66",
+  "f1cd64515e55b89fe7a69eaa68c6c70e",
 ].join("");
 
 const unwrapStaticExpression = (node) => {
@@ -192,6 +194,7 @@ const fixedNonImportPaths = Object.freeze([
   "tsconfig.json",
   "prisma/schema.prisma",
   "prisma/migrations/20260918130000_prompt_refiner_stage_admission/migration.sql",
+  "prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql",
   ...workspacePackageDirectories.map((directory) => repositoryPath(join(directory, "package.json"))).sort(),
 ]);
 
@@ -1219,17 +1222,26 @@ test("TypeScript options and workspace metadata control local resolution", () =>
 });
 
 test("TypeScript and PostgreSQL enforce the identical ordered runtime source paths", () => {
-  const migration = readFileSync(
+  const legacyMigration = readFileSync(
     join(repositoryRoot, "prisma/migrations/20260918130000_prompt_refiner_stage_admission/migration.sql"),
     "utf8"
   );
-  const block = migration.match(/expected_paths CONSTANT TEXT\[\] := ARRAY\[([\s\S]*?)\n\s*\];/);
+  const migration = readFileSync(
+    join(repositoryRoot, "prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql"),
+    "utf8"
+  );
+  const block = legacyMigration.match(/expected_paths CONSTANT TEXT\[\] := ARRAY\[([\s\S]*?)\n\s*\];/);
   assert.ok(block, "migration expected_paths block is missing");
   const sqlPaths = [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
+  const addedPath = migration.match(
+    /'path', '(prisma\/migrations\/20260921100000_prompt_refiner_confirmatory_shadow_v4\/migration\.sql)'/
+  );
+  assert.ok(addedPath, "v4 migration extension path is missing");
+  sqlPaths.splice(6, 0, addedPath[1]);
   assert.equal(sqlPaths.length, PROMPT_REFINER_RUNTIME_SOURCE_FILE_COUNT);
   assert.deepEqual(sqlPaths, [...PROMPT_REFINER_RUNTIME_SOURCE_PATHS]);
   const executionManifestFileCount = migration.match(
-    /"runtimeSource":\{"fileCount":(\d+),/
+    /"schemaVersion":"prompt-refiner-shadow-execution-manifest-v2"[\s\S]*?"runtimeSource":\{"fileCount":(\d+),/
   );
   assert.ok(executionManifestFileCount, "migration executionManifest runtimeSource.fileCount is missing");
   assert.equal(
@@ -1237,6 +1249,11 @@ test("TypeScript and PostgreSQL enforce the identical ordered runtime source pat
     PROMPT_REFINER_RUNTIME_SOURCE_FILE_COUNT,
     "migration executionManifest runtimeSource.fileCount differs from the TypeScript runtime source contract"
   );
+  assert.match(
+    migration,
+    /"id" = 'prompt-refiner-shadow-v1'[\s\S]*?"runtimeSourceManifest"->>'schemaVersion' = 'prompt-refiner-runtime-source-manifest-v2'[\s\S]*?"id" = 'prompt-refiner-shadow-v2'[\s\S]*?"runtimeSourceManifest"->>'schemaVersion' = 'prompt-refiner-runtime-source-manifest-v3'/,
+    "database stage identity must select the matching runtime manifest generation"
+  );
 });
 
 test("operator-facing contracts name the enforced runtime source closure size", () => {
@@ -1246,8 +1263,9 @@ test("operator-facing contracts name the enforced runtime source closure size",
     ["prisma/schema.prisma", /exact (\d+)-file runtime import closure/],
     ["docs/ops/prompt-refiner-durable-stage-writer-contract.md", /deployment의 (\d+)개 고정 source 파일/],
     ["docs/ops/prompt-refiner-durable-stage-writer-task.md", /(\d+)-file\/16 MiB bounded exact-byte/],
-    ["docs/ops/tomverse-chat-progress.md", /exact (\d+)-file runtime import-closure source manifest/],
+    ["docs/ops/tomverse-chat-progress.md", /confirmatory v2\/v4 현재 계약은 exact (\d+)-file/],
     ["docs/policy/prompt-refiner-durable-stage-writer-threat-model.md", /검증되는 (\d+)개 고정 path allowlist/],
+    ["docs/ops/prompt-refiner-confirmatory-shadow-v4.md", /\*\*(\d+)개 고정 source 파일\*\*/],
   ]) {
     const source = readFileSync(join(repositoryRoot, path), "utf8");
     const found = source.match(pattern);
@@ -1256,18 +1274,27 @@ test("operator-facing contracts name the enforced runtime source closure size",
   }
 
   const contract = readFileSync(
-    join(repositoryRoot, "docs/ops/prompt-refiner-durable-stage-writer-contract.md"),
+    join(repositoryRoot, "docs/ops/prompt-refiner-confirmatory-shadow-v4.md"),
     "utf8"
   );
   assert.match(
     contract,
+    new RegExp(`${expectedCount}개 중 ${expectedRuntimeSourceCount}개는 8개 실행 root의 local TypeScript/JavaScript`),
+    "runtime TypeScript/JavaScript source-count contract drifted"
+  );
+  const stageContract = readFileSync(
+    join(repositoryRoot, "docs/ops/prompt-refiner-durable-stage-writer-contract.md"),
+    "utf8"
+  );
+  assert.match(
+    stageContract,
     new RegExp(`${expectedCount}개 경로의 순서`),
     "database path-count contract drifted"
   );
   assert.match(
-    contract,
+    stageContract,
     new RegExp(`${expectedCount}개 중 ${expectedRuntimeSourceCount}개 TypeScript/JavaScript source`),
-    "runtime TypeScript/JavaScript source-count contract drifted"
+    "stage writer runtime-source count drifted"
   );
   const observabilityPolicy = readFileSync(
     join(repositoryRoot, "docs/policy/prompt-refiner-observability.md"),
diff --git a/tests/promptRefinerShadowAdmissionCore.test.mjs b/tests/promptRefinerShadowAdmissionCore.test.mjs
index 5d06dc87..d8ee329b 100644
--- a/tests/promptRefinerShadowAdmissionCore.test.mjs
+++ b/tests/promptRefinerShadowAdmissionCore.test.mjs
@@ -19,6 +19,8 @@ import {
     PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_VERSION,
     PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_REF,
     PROMPT_REFINER_SHADOW_STAGE_ACKNOWLEDGEMENTS,
+    PROMPT_REFINER_SHADOW_PROPOSAL_RESERVATION_CONTRACT_DIGEST,
+    PROMPT_REFINER_SHADOW_PROPOSAL_RESERVATION_STAGE_ID,
     PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_DIGEST,
     PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_VERSION,
     proposePromptRefinerShadowStage,
@@ -37,6 +39,7 @@ import {
     PROMPT_REFINER_RESERVATION_STAGE_ID,
     PROMPT_REFINER_RESERVATION_TTL_MS,
 } from "../lib/promptRefinerReservationCore.ts";
+import { promptRefinerExecutionManifest } from "../lib/promptRefinerStageAdmissionCore.ts";
 import {
     canonicalBenchmarkJson,
 } from "../lib/routerDevelopmentBenchmark.ts";
@@ -129,9 +132,28 @@ test("checked-in evidence emits only the fixed content-free proposal", () => {
         PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_DIGEST
     );
     assert.equal(proposal.provenance.sourceRef, PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_REF);
-    assert.equal(proposal.reservationStage.stageId, PROMPT_REFINER_RESERVATION_STAGE_ID);
+    assert.equal(
+        proposal.reservationStage.stageId,
+        PROMPT_REFINER_SHADOW_PROPOSAL_RESERVATION_STAGE_ID
+    );
     assert.equal(
         proposal.reservationStage.contractDigest,
+        PROMPT_REFINER_SHADOW_PROPOSAL_RESERVATION_CONTRACT_DIGEST
+    );
+    assert.notEqual(
+        proposal.reservationStage.stageId,
+        PROMPT_REFINER_RESERVATION_STAGE_ID,
+        "the frozen proposal must retain its historical v1 stage identity"
+    );
+    assert.notEqual(
+        proposal.reservationStage.contractDigest,
+        PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+        "the frozen proposal must retain its historical v1 reservation digest"
+    );
+    const currentExecutionManifest = promptRefinerExecutionManifest();
+    assert.equal(currentExecutionManifest.stageId, PROMPT_REFINER_RESERVATION_STAGE_ID);
+    assert.equal(
+        currentExecutionManifest.reservationContractDigest,
         PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST
     );
     assert.equal(proposal.reservationStage.perRequestCostMicroUsd, 24_916);
diff --git a/tests/promptRefinerShadowEvidenceCore.test.mjs b/tests/promptRefinerShadowEvidenceCore.test.mjs
index e3346276..14099228 100644
--- a/tests/promptRefinerShadowEvidenceCore.test.mjs
+++ b/tests/promptRefinerShadowEvidenceCore.test.mjs
@@ -5,6 +5,8 @@ import test from "node:test";
 import {
   PROMPT_REFINER_SHADOW_EVIDENCE_MAX_SPEC_BYTES,
   PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_DIGEST,
+  aggregatePromptRefinerShadowStoredEvidence,
+  evaluatePromptRefinerShadowCaseEvidence,
   evaluatePromptRefinerShadowEvidence,
   parsePromptRefinerShadowEvidenceSpec,
   validatePromptRefinerShadowEvidenceSpec,
@@ -156,6 +158,69 @@ test("the returned evidence is content-free", () => {
   }
 });
 
+test("transient case evaluation rebuilds the same durable aggregate without prompt bytes", () => {
+  const runCases = passingRunCases();
+  const storedCases = runCases.map((item, caseIndex) => ({
+    caseId: item.caseId,
+    terminalStatus: item.terminalStatus,
+    evidence: evaluatePromptRefinerShadowCaseEvidence({
+      corpus,
+      spec,
+      caseIndex,
+      terminalStatus: item.terminalStatus,
+      refinedPrompt: item.refinedPrompt,
+    }),
+    durationMs: item.durationMs,
+    costMicroUsd: item.costMicroUsd,
+  }));
+  const rebuilt = aggregatePromptRefinerShadowStoredEvidence({
+    corpus,
+    spec,
+    cases: storedCases,
+  });
+  assert.deepEqual(rebuilt, evaluate(runCases));
+  const serialized = JSON.stringify(storedCases);
+  for (const prompt of passingPrompts.values()) {
+    assert.equal(serialized.includes(prompt), false);
+  }
+  assert.equal(serialized.includes('"refinedPrompt"'), false);
+});
+
+test("durable aggregation rejects reordered, forged, or internally inconsistent evidence", () => {
+  const runCases = passingRunCases();
+  const storedCases = runCases.map((item, caseIndex) => ({
+    caseId: item.caseId,
+    terminalStatus: item.terminalStatus,
+    evidence: evaluatePromptRefinerShadowCaseEvidence({
+      corpus,
+      spec,
+      caseIndex,
+      terminalStatus: item.terminalStatus,
+      refinedPrompt: item.refinedPrompt,
+    }),
+    durationMs: item.durationMs,
+    costMicroUsd: item.costMicroUsd,
+  }));
+  const reordered = structuredClone(storedCases);
+  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
+  assert.throws(
+    () => aggregatePromptRefinerShadowStoredEvidence({ corpus, spec, cases: reordered }),
+    /stored_run_case_id_or_order_mismatch/
+  );
+  const leaked = structuredClone(storedCases);
+  leaked[0].evidence.refinedPrompt = passingPrompts.get(leaked[0].caseId);
+  assert.throws(
+    () => aggregatePromptRefinerShadowStoredEvidence({ corpus, spec, cases: leaked }),
+    /unexpected_or_missing_fields/
+  );
+  const inconsistent = structuredClone(storedCases);
+  inconsistent[0].evidence.evidenceStatus = "fail";
+  assert.throws(
+    () => aggregatePromptRefinerShadowStoredEvidence({ corpus, spec, cases: inconsistent }),
+    /stored_suggested_evidence_inconsistent/
+  );
+});
+
 test("literal loss, concept loss, language drift and no-change fail independently", () => {
   const literalLoss = passingRunCases();
   literalLoss[1].refinedPrompt = "배송 날짜를 바꾸지 말고 친절한 안내문을 작성해 주세요.";
diff --git a/tests/promptRefinerShadowOperatorCore.test.mjs b/tests/promptRefinerShadowOperatorCore.test.mjs
index 91060b08..5876a2c6 100644
--- a/tests/promptRefinerShadowOperatorCore.test.mjs
+++ b/tests/promptRefinerShadowOperatorCore.test.mjs
@@ -100,6 +100,7 @@ const runBody = () => ({
     stageApprovalExpiresAt: "2026-09-21T02:00:00.000Z",
     runContractDigest: digest("6"),
     corpusDigest: "b".repeat(64),
+    evidenceSpecDigest: "c".repeat(64),
     adapterVersion: "prompt-refiner-openai-sdk-adapter-v1",
     provider: contract.provider,
     modelId: contract.modelId,
@@ -136,10 +137,29 @@ const executionBody = () => ({
     runContractDigest: digest("6"),
     enabled: true,
     confirmation: contract.executionConfirmation,
+    evidence: null,
     productAdapterReady: false,
   },
 });
 
+const evidenceBody = () => ({
+  gateOutcome: "pass",
+  gateReasons: [],
+  summary: {
+    attemptedCases: 16,
+    suggestedCases: 16,
+    failedCases: 0,
+    unknownCases: 0,
+    passedCases: 16,
+    passedInjectionCases: 2,
+    costReportedCases: 16,
+    totalCostMicroUsd: 12_345,
+    latencyReportedCases: 16,
+    latencyP90Ms: 900,
+    latencyMaxMs: 1_200,
+  },
+});
+
 test("the exact frozen stage, run, and execution previews are accepted", () => {
   const stage = parsePromptRefinerStagePreview(stageBody());
   assert.ok(stage);
@@ -148,6 +168,31 @@ test("the exact frozen stage, run, and execution previews are accepted", () => {
   const execution = parsePromptRefinerExecutionPreview(executionBody(), run);
   assert.ok(execution);
   assert.equal(run.corpusDigest, "b".repeat(64));
+  assert.equal(run.evidenceSpecDigest, "c".repeat(64));
+});
+
+test("a completed content-free evidence summary is accepted and malformed summaries fail closed", () => {
+  const stage = parsePromptRefinerStagePreview(stageBody());
+  assert.ok(stage);
+  const run = parsePromptRefinerRunPreview(runBody(), stage);
+  assert.ok(run);
+  const valid = executionBody();
+  valid.execution.evidence = evidenceBody();
+  assert.ok(parsePromptRefinerExecutionPreview(valid, run));
+
+  for (const mutate of [
+    (evidence) => (evidence.sourceText = "must not cross the API"),
+    (evidence) => (evidence.summary.attemptedCases = 15),
+    (evidence) => (evidence.summary.unknownCases = 1),
+    (evidence) => (evidence.summary.latencyP90Ms = 1_300),
+    (evidence) => evidence.gateReasons.push("unknown_reason"),
+    (evidence) => evidence.gateReasons.push("unknown_present"),
+  ]) {
+    const candidate = executionBody();
+    candidate.execution.evidence = evidenceBody();
+    mutate(candidate.execution.evidence);
+    assert.equal(parsePromptRefinerExecutionPreview(candidate, run), null);
+  }
 });
 
 test("approval bodies reuse only exact server-bound values", () => {
@@ -189,6 +234,7 @@ test("cost, model, deployment, and run-contract drift fail closed", () => {
     (preview) => (preview.modelId = "another-model"),
     (preview) => (preview.deploymentId = "deployment-2"),
     (preview) => (preview.corpusDigest = digest("b")),
+    (preview) => (preview.evidenceSpecDigest = digest("c")),
   ]) {
     const candidate = structuredClone(runBody());
     mutate(candidate.preview);
diff --git a/tests/promptRefinerShadowRunContract.test.mjs b/tests/promptRefinerShadowRunContract.test.mjs
index 269223d9..b0e04e16 100644
--- a/tests/promptRefinerShadowRunContract.test.mjs
+++ b/tests/promptRefinerShadowRunContract.test.mjs
@@ -21,6 +21,7 @@ import {
   PROMPT_REFINER_SHADOW_RUN_COST_CEILING_MICRO_USD,
   PROMPT_REFINER_SHADOW_RUN_ID,
   PROMPT_REFINER_SHADOW_RUN_MAX_DISPATCHES,
+  PROMPT_REFINER_SHADOW_RUN_UNKNOWN_AFTER_MS,
   PROMPT_REFINER_SHADOW_ROUTE_MAX_DURATION_SECONDS,
   PROMPT_REFINER_SHADOW_RUN_SOURCE_PATHS,
   PROMPT_REFINER_SHADOW_TERMINAL_WRITE_MARGIN_MS,
@@ -35,6 +36,12 @@ import {
 import {
   PROMPT_REFINER_SHADOW_CORPUS_DIGEST,
 } from "../lib/promptRefinerShadowHarness.ts";
+import {
+  PROMPT_REFINER_SHADOW_EVIDENCE_MAX_DURATION_MS,
+  PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_DIGEST,
+  PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_ID,
+  PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_VERSION,
+} from "../lib/promptRefinerShadowEvidenceCore.ts";
 
 test("shadow run contract narrows the durable stage to the frozen 16-case run", () => {
   assert.equal(PROMPT_REFINER_SHADOW_RUN_MAX_DISPATCHES, 16);
@@ -90,6 +97,10 @@ test("shadow run contract narrows the durable stage to the frozen 16-case run",
     PROMPT_REFINER_SHADOW_ROUTE_MAX_DURATION_SECONDS,
   );
   assert.equal(PROMPT_REFINER_SHADOW_TERMINAL_WRITE_MARGIN_MS, 10_000);
+  assert.equal(
+    PROMPT_REFINER_SHADOW_RUN_UNKNOWN_AFTER_MS,
+    PROMPT_REFINER_SHADOW_EVIDENCE_MAX_DURATION_MS,
+  );
   assert.equal(
     PROMPT_REFINER_SHADOW_RUN_CONTRACT.run.invocationBudgetMs,
     PROMPT_REFINER_SHADOW_INVOCATION_BUDGET_MS,
@@ -100,12 +111,22 @@ test("shadow run contract narrows the durable stage to the frozen 16-case run",
   );
   assert.equal(PROMPT_REFINER_SHADOW_RUN_CONTRACT.run.runId, PROMPT_REFINER_SHADOW_RUN_ID);
   assert.deepEqual(PROMPT_REFINER_SHADOW_RUN_CONTRACT.run.caseIds, PROMPT_REFINER_SHADOW_CASE_IDS);
+  assert.deepEqual(PROMPT_REFINER_SHADOW_RUN_CONTRACT.evidence, {
+    specVersion: PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_VERSION,
+    specId: PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_ID,
+    specDigest: PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_DIGEST,
+    evaluation: "transient_proposal_to_content_free_case_evidence",
+    durableProposalBytes: false,
+    durablePerItemContentDigest: false,
+    terminalReceiptAtomicity: "same_transaction",
+    aggregateRebuild: "content_free_attempt_evidence",
+  });
   assert.equal(PROMPT_REFINER_SHADOW_CASE_IDS.length, 16);
   assert.equal(new Set(PROMPT_REFINER_SHADOW_CASE_IDS).size, 16);
   assert.deepEqual(promptRefinerShadowRunContractProblems(), []);
 });
 
-test("v3 admits only the owner-only shadow entry point, never the product path", () => {
+test("v4 admits only the owner-only shadow entry point, never the product path", () => {
   assert.equal(PROMPT_REFINER_SHADOW_RUN_CONTRACT.shadowAdapterImplemented, true);
   assert.equal(PROMPT_REFINER_SHADOW_RUN_CONTRACT.durableRunWriterReady, true);
   assert.equal(PROMPT_REFINER_SHADOW_RUN_CONTRACT.runApprovalPreviewReady, true);
@@ -119,6 +140,14 @@ test("v3 admits only the owner-only shadow entry point, never the product path",
 });
 
 test("run source manifest is exact, bounded and commit-bound", () => {
+  for (const requiredPath of [
+    "docs/ops/prompt-refiner-shadow/corpus-v1.json",
+    "docs/ops/prompt-refiner-shadow/evidence-spec-v1.json",
+    "prisma/schema.prisma",
+    "prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql",
+  ]) {
+    assert.ok(PROMPT_REFINER_SHADOW_RUN_SOURCE_PATHS.includes(requiredPath));
+  }
   const files = new Map(
     PROMPT_REFINER_SHADOW_RUN_SOURCE_PATHS.map((path, index) => [
       path,
@@ -170,4 +199,5 @@ test("run preview digest binds deployment, stage closure, delta and cost", () =>
   );
   assert.equal(binding.tokenizerEncoding, PROMPT_REFINER_SHADOW_TOKENIZER_ENCODING);
   assert.equal(binding.maxInputTokens, 100_000);
+  assert.equal(binding.evidenceSpecDigest, PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_DIGEST);
 });
diff --git a/tests/promptRefinerShadowRunner.test.mjs b/tests/promptRefinerShadowRunner.test.mjs
index 5c326d20..82c97aa4 100644
--- a/tests/promptRefinerShadowRunner.test.mjs
+++ b/tests/promptRefinerShadowRunner.test.mjs
@@ -26,6 +26,7 @@ const corpus = validatePromptRefinerShadowCorpus(corpusJson);
 const fixture = (options = {}) => {
   const events = [];
   const incidents = [];
+  const terminalEvidence = [];
   let enabled = true;
   let dispatchCount = 0;
   let terminalCount = 0;
@@ -81,7 +82,7 @@ const fixture = (options = {}) => {
           reservation: {
             reservationId: `reservation_${dispatchCount}`,
             requestId,
-            stageId: "prompt-refiner-shadow-v1",
+            stageId: "prompt-refiner-shadow-v2",
             contractDigest: `sha256:${"c".repeat(64)}`,
           },
         },
@@ -153,8 +154,11 @@ const fixture = (options = {}) => {
         },
       };
     },
-    recordTerminal: async ({ attemptId, terminalReason }) => {
+    recordTerminal: async ({ attemptId, terminalReason, evidence }) => {
       events.push(`terminal:${attemptId}:${terminalReason}`);
+      assert.equal(evidence.caseId, PROMPT_REFINER_SHADOW_CASE_IDS[terminalCount]);
+      assert.equal("refinedPrompt" in evidence, false);
+      terminalEvidence.push(evidence);
       if (options.failTerminalAt === terminalCount) {
         throw new Error("raw terminal failure must not escape");
       }
@@ -174,7 +178,13 @@ const fixture = (options = {}) => {
     },
     corpus: options.corpus ?? corpus,
   };
-  return { run: createPromptRefinerShadowRunner(dependencies), events, incidents, state };
+  return {
+    run: createPromptRefinerShadowRunner(dependencies),
+    events,
+    incidents,
+    state,
+    terminalEvidence,
+  };
 };
 
 test("the runner sweeps first and executes all 16 cases once in exact order", async () => {
@@ -194,6 +204,8 @@ test("the runner sweeps first and executes all 16 cases once in exact order", as
   const reservations = world.events.filter((event) => event.startsWith("reserve:"));
   assert.equal(reservations.length, 16);
   assert.equal(new Set(reservations).size, 16);
+  assert.equal(world.terminalEvidence.length, 16);
+  assert.doesNotMatch(JSON.stringify(world.terminalEvidence), /discarded transient result/);
 });
 
 test("a known unknown outcome latches the run and stops later cases", async () => {
@@ -235,7 +247,7 @@ test("a reservation refusal reports its fixed cause before stopping", async () =
   assert.equal(world.incidents.length, 1);
   assert.equal(world.incidents[0].context.phase, "pre_dispatch");
   assert.equal(world.incidents[0].context.causeCode, "stage_capacity_exhausted");
-  assert.doesNotMatch(JSON.stringify(world.incidents), /prsv3_/);
+  assert.doesNotMatch(JSON.stringify(world.incidents), /prsv4_/);
 });
 
 test("a post-intent exception leaves one durable intent and forbids redispatch", async () => {
diff --git a/tests/promptRefinerStageAdmissionReader.test.mjs b/tests/promptRefinerStageAdmissionReader.test.mjs
index 2c47ef71..d691913f 100644
--- a/tests/promptRefinerStageAdmissionReader.test.mjs
+++ b/tests/promptRefinerStageAdmissionReader.test.mjs
@@ -40,7 +40,7 @@ test("stage authorization accepts current and legacy canonical HMAC formats acro
   const currentKey = "current-audit-integrity-key";
   const approvedAt = new Date("2026-09-17T02:00:00.000Z");
   const stage = {
-    id: "prompt-refiner-shadow-v1",
+    id: "prompt-refiner-shadow-v2",
     approvedBy: "mposition",
     admissionVersion: "prompt-refiner-stage-admission-v1",
     proposalDigest: `sha256:${"1".repeat(64)}`,
diff --git a/tests/server-contract/admin-prompt-refiner-shadow-execution-route.test.ts b/tests/server-contract/admin-prompt-refiner-shadow-execution-route.test.ts
index 9d788a0a..ea0c88fc 100644
--- a/tests/server-contract/admin-prompt-refiner-shadow-execution-route.test.ts
+++ b/tests/server-contract/admin-prompt-refiner-shadow-execution-route.test.ts
@@ -60,6 +60,7 @@ const fresh = (): World => ({
     rateLimitCalls: 0,
 });
 let world = fresh();
+let evidenceBundle: Record<string, unknown> | null = null;
 let installed = false;
 
 async function loadRoute() {
@@ -115,6 +116,7 @@ async function loadRoute() {
                     world.stateCalls += 1;
                     return state;
                 },
+                readPromptRefinerShadowEvidenceBundle: async () => evidenceBundle,
                 promptRefinerShadowRunErrorResponse: () => null,
             },
         });
@@ -158,9 +160,42 @@ const validBody = () => ({
 
 test.beforeEach(() => {
     world = fresh();
+    evidenceBundle = null;
     delete process.env[PROMPT_REFINER_SHADOW_EXECUTION_FLAG];
 });
 
+test("GET exposes only the content-free evidence summary", async () => {
+    const route = await loadRoute();
+    evidenceBundle = {
+        gateOutcome: "pass",
+        gateReasons: [],
+        summary: {
+            attemptedCases: 16,
+            suggestedCases: 16,
+            failedCases: 0,
+            unknownCases: 0,
+            passedCases: 16,
+            passedInjectionCases: 2,
+            costReportedCases: 16,
+            totalCostMicroUsd: 123,
+            latencyReportedCases: 16,
+            latencyP90Ms: 900,
+            latencyMaxMs: 1200,
+        },
+        cases: [{ sourceText: "must not cross the route" }],
+        limitations: ["internal"],
+    };
+    const response = await route.GET(get());
+    assert.equal(response.status, 200);
+    const body = await response.json();
+    assert.deepEqual(body.execution.evidence, {
+        gateOutcome: "pass",
+        gateReasons: [],
+        summary: evidenceBundle.summary,
+    });
+    assert.doesNotMatch(JSON.stringify(body), /sourceText|limitations|must not cross/i);
+});
+
 test("origin guard covers execution POST while preview GET remains read-only", () => {
     const path = "/api/admin/prompt-refiner/shadow-run/execute";
     assert.equal(requiresMutationOriginCheck("POST", path), true);
@@ -191,6 +226,7 @@ test("GET is content-free, no-write and shows the default-off flag", async () =>
     assert.equal(body.execution.runContractDigest, PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST);
     assert.equal(body.execution.confirmation, PROMPT_REFINER_SHADOW_EXECUTION_CONFIRMATION);
     assert.equal(body.execution.productAdapterReady, false);
+    assert.equal(body.execution.evidence, null);
     assert.equal(world.stateCalls, 1);
     assert.equal(world.executeCalls, 0);
     assert.equal(world.rateLimitCalls, 1);
diff --git a/tests/server-contract/admin-prompt-refiner-shadow-run-route.test.ts b/tests/server-contract/admin-prompt-refiner-shadow-run-route.test.ts
index ebe3c3e4..8fda1b6a 100644
--- a/tests/server-contract/admin-prompt-refiner-shadow-run-route.test.ts
+++ b/tests/server-contract/admin-prompt-refiner-shadow-run-route.test.ts
@@ -20,8 +20,8 @@ process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
 const digest = (character: string) => `sha256:${character.repeat(64)}`;
 const preview = {
     status: "ready_for_explicit_cost_approval",
-    runId: "prompt-refiner-shadow-run-v3",
-    stageId: "prompt-refiner-shadow-v1",
+    runId: "prompt-refiner-shadow-run-v4",
+    stageId: "prompt-refiner-shadow-v2",
     stageRuntimeSourceManifestDigest: digest("1"),
     runSourceManifestDigest: digest("2"),
     environment: "staging",
@@ -30,6 +30,7 @@ const preview = {
     stageApprovalExpiresAt: "2026-09-20T03:00:00.000Z",
     runContractDigest: digest("3"),
     corpusDigest: "b".repeat(64),
+    evidenceSpecDigest: "c".repeat(64),
     adapterVersion: "prompt-refiner-openai-sdk-adapter-v1",
     provider: "openai",
     modelId: "gpt-5-6-luna",
@@ -78,6 +79,7 @@ const fakeRun = {
     status: "approved",
     runContractDigest: preview.runContractDigest,
     corpusDigest: preview.corpusDigest,
+    evidenceSpecDigest: preview.evidenceSpecDigest,
     adapterVersion: preview.adapterVersion,
     runtimeDeploymentId: preview.deploymentId,
     runtimeCommitSha: preview.commitSha,
@@ -226,7 +228,7 @@ test("POST accepts only the fixed 4 KiB approval binding", async () => {
     assert.equal(world.createCalls, 0);
 });
 
-test("POST records the exact v3 execution authority without calling a provider", async () => {
+test("POST records the exact v4 execution authority without calling a provider", async () => {
     const route = await loadRoute();
     const oldFetch = globalThis.fetch;
     globalThis.fetch = async () => {
diff --git a/tests/server-contract/admin-prompt-refiner-shadow-stage-route.test.ts b/tests/server-contract/admin-prompt-refiner-shadow-stage-route.test.ts
index d854063b..6a572c18 100644
--- a/tests/server-contract/admin-prompt-refiner-shadow-stage-route.test.ts
+++ b/tests/server-contract/admin-prompt-refiner-shadow-stage-route.test.ts
@@ -46,7 +46,7 @@ let world = fresh();
 let installed = false;
 
 const previewFacts = {
-  stageId: "prompt-refiner-shadow-v1",
+  stageId: "prompt-refiner-shadow-v2",
   status: "ready_for_explicit_cost_approval",
   proposalDigest: `sha256:${"1".repeat(64)}`,
   runtimeSourceManifestDigest: `sha256:${"2".repeat(64)}`,

```

## Test results (run by the control program)

- PASS `node --conditions=react-server --import tsx --test --test-concurrency=1 tests/marketingAutomationAccess.test.mjs tests/promptRefinerRuntimeSourceClosure.test.mjs tests/gitleaksAllowlist.test.mjs` (3511ms)
  # fail 0
  # cancelled 0
  # skipped 0
  # todo 0
  # duration_ms 3425.2364

## Guard results (run by the control program)

- PASS `npm run typecheck` (52827ms)
  > ai-chat-hub@0.1.0 typecheck
  > next typegen && tsc --noEmit --incremental false
  
  Generating route types...
  ✓ Types generated successfully
- PASS `npm run lint` (70374ms)
  > ai-chat-hub@0.1.0 lint
  > eslint
- PASS `npm run check:enum-constraints` (1160ms)
  > ai-chat-hub@0.1.0 check:enum-constraints
  > node --conditions=react-server --import tsx scripts/check-enum-constraints.mjs
  
  Enum constraint check passed: 125 closed list(s) in the schema — 62 compared against an application list, 25 held only as a TypeScript union, 38 written down only in the database.
- PASS `npm run check:protected-table-writers` (3762ms)
  tingStore.ts; no direct MarketingPost write found outside lib/marketingStore.ts; no direct MarketingReport write found outside lib/marketingStore.ts; no direct AiVisibilityRun write found outside lib/marketingStore.ts; no direct PromptRefinerShadowRun write found outside lib/promptRefinerShadowRunStore.ts; no direct PromptRefinerShadowAttempt write found outside lib/promptRefinerShadowRunStore.ts.
- PASS `npm run check:doc-references` (2461ms)
  > ai-chat-hub@0.1.0 check:doc-references
  > node scripts/check-doc-references.mjs
  
  Document reference check passed: 906 referenced path(s) across 121 instruction document(s), and 1018 path(s) named by comments across 3085 source file(s), all present.
- PASS `npm run check:policy-section-references` (1783ms)
  > ai-chat-hub@0.1.0 check:policy-section-references
  > node scripts/check-policy-section-references.mjs
  
  Policy section reference check passed: 4548 citation(s) against 40 policy document(s). 2981 resolve to a named document and none point at a section that does not exist. No added line introduces an unscoped or ambiguous one (1334 and 233 predate this change).

## Findings from the previous round (check each was addressed)

- [warning/evidence] .gitleaksignore:126-137 (new PR #1584 fingerprint block): The block pins ~100 allowances to seven branch commit SHAs but nowhere records the condition that this PR must be merged preserving those commits (no squash, no rebase), which completion criterion 4 requires; a squash merge silently invalidates every pinned fingerprint and re-fails the scheduled full-history secret scan.

## Author's account (read last; a claim, not a finding)

Summary: (no summary supplied; the diff is the record)

## Answer format

Reply with exactly one JSON document and nothing else:

```json
{
  "taskId": "prompt-refiner-confirmatory-shadow-v4-integration-v4",
  "round": 1,
  "reviewedDigest": "sha256:a0b83ea542f34d33722e0c6e4e31ae355e9928f221331df7cef781ae79617175",
  "conclusion": "approve | request_changes | blocked",
  "findings": [
    {
      "location": "path:line or symbol",
      "severity": "error | warning | nit",
      "basis": "evidence | preference | judgement",
      "claim": "what is wrong, in one sentence",
      "reproduction": "how to see it: a command, or an input and its expected output (required for the finding to be acted on)"
    }
  ],
  "nextAction": "one sentence"
}
```

`reviewedDigest` must be the digest above, verbatim. A finding with basis `preference` is settled by the project's rules; any other finding is acted on only with a reproduction, and without one it is recorded and the current version stands.
