# memory extraction decision-grade eval 실행 절차

`(gpt-5-6-luna, mem-extract-v2)` 쌍을 실제로 재고, 그 결과로 register를
승인하기까지의 절차입니다. 근거는
`docs/policy/external-conversation-import-and-memory.md` §12.2~§12.5이고,
표본을 만들고 동결한 절차는 `docs/ops/memory-extraction-eval-dataset.md`입니다.

이 문서는 **실행 순서와 판정 경계**만 정합니다. 기준 수치는 정책 §12.3에 있고
여기에 옮겨 적지 않습니다 — 옮겨 적은 숫자는 정책이 바뀌는 날 틀린 것이 됩니다.

## 0. 이 문서가 정하지 않는 것

- 합격 여부 (정책 §12.3이 정하고 harness가 계산합니다)
- register `status: approved` 전환 (§12.4, 사람의 서명)
- flag 활성화 (§15.1의 순서, staging 검증 뒤)
- 이 회차의 제외·재실행 규칙 (§3에서 **사람이 확정**합니다)

## 1. 지금 어디인가

`docs/ops/memory-extraction-eval-dataset.md` §9의 8단계 중 **5단계**입니다.

| # | 단계 | 상태 |
|---|---|---|
| 1 | 지침 합의 + 착수 승인 | 완료 (2026-08-23) |
| 2 | batch 작성·검수 | 완료 — 28 batch, 1,150건 |
| 3 | 동결 | 완료 (2026-08-24) — `mem-eval-seed-11`, `decision`, `frozen` |
| 4 | eval 실행 예산 승인 | 완료 — US$20, issue #837 |
| 5 | **decision-grade 실행 → blind review → 독립 재실행** | ← 여기 |
| 6 | §12.3 판정 | |
| 7 | register `approved` + 서명 | |
| 8 | staging 검증 → flag | |

동결로 harness의 거절 사유에서 dataset이 빠졌습니다. 남은 것은 `OPENAI_API_KEY`
하나이고, 예산 없는 `gpt-5-4-mini`는 그대로 거절입니다.

## 2. 실행 전 확인 — 전부 기계가 합니다

```
npm run check:memory-eval-freeze          # §7.1 일곱 조건
npm run check:memory-extraction-eval      # register 구조 (fail-closed)
npm run eval:memory-extraction            # smoke — 경로가 끝까지 도는가
node --import tsx --test tests/memoryValidatorAdversarial.test.mjs
node --import tsx --test tests/memoryExtractionEvalCore.test.mjs
git status --porcelain                    # 비어 있어야 합니다
```

마지막 줄이 비어 있어야 하는 이유는 취향이 아닙니다. harness가 artifact에
`workingTreeDirty`를 적고, 그 값이 `true`인 회차는 **commit이 그 실행을 설명하지
못합니다** — §12.2의 "동일 commit" 요건이 성립하지 않습니다.

validator 테스트 두 개가 여기 있는 이유는 §12.3의 마지막 조항입니다. critical
범주는 eval에서 관측 0건과 **별개로** 결정적 validator 테스트도 통과해야 하고,
②③④의 표본 하한 완화(arm당 200 → 125)도 그 corpus가 살아 있는 동안에만
유효합니다(§12.2 조건부 요건 4개). 둘 중 하나가 깨지면 이 회차는 성립하지
않습니다.

## 2.5 실행 환경

**이 회차는 배포 환경이 아닙니다.** production도 staging도 아니고, Railway
console에서 도는 것도 아닙니다 — 그곳에는 git checkout이 없고, 애초에 필요한
것도 아닙니다.

필요한 것은 넷뿐입니다.

| 필요 | 왜 |
|---|---|
| 저장소 checkout (clean tree) | harness가 `commitSha`와 `workingTreeDirty`를 artifact에 적습니다 |
| `npm ci` | `tsx`와 AI SDK |
| `OPENAI_API_KEY` | 유일한 자격증명. gate와 실제 호출이 **같은 변수**를 봅니다 |
| OpenAI로 나가는 네트워크 | |

**데이터베이스는 필요 없습니다.** live 경로
(`memoryExtractionPipeline` → `models` → `modelPricing` → `activeAiModel`)의
어느 파일도 Prisma를 import하지 않습니다. 모델 설정은 `lib/models.ts`의 **정적
카탈로그**에서 오고 운영 `ModelRegistryEntry` 행에서 오지 않습니다 — 그래서 이
회차는 DB drift(`creditWeight`·`maxOutputTokens` 화석)에 영향을 받지 않고, 어느
기계에서 돌리든 같은 것을 잽니다. 출력 상한도 harness가 4,096으로 직접 넘깁니다.

**git checkout이 아닌 곳에서는 harness가 거절합니다.** 배포된 컨테이너에는 git
metadata가 없어 `commitSha`가 `unknown`이 되고, 같은 실패로 `workingTreeDirty`
까지 `false`가 됩니다 — 인용할 수 없는 회차가 깨끗한 회차처럼 보입니다. 그래서
거절은 1,150번의 유료 호출 **앞**에 있습니다.

**`npm run`으로 실행합니다.** bare `node --import tsx scripts/…`로 돌리면
live adapter가 첫 케이스에서 죽습니다 — `lib/activeAiModel.ts`가
`import "server-only"`로 시작하고, 그것을 통과시키는 `--conditions=react-server`
가 npm script 쪽에 있기 때문입니다. 돈은 안 나가지만 회차는 날아갑니다.

### 2.5.1 어디서 돌리는가 — GitHub Actions

`Memory eval — decision-grade run` workflow를 수동 dispatch합니다
(`.github/workflows/memory-eval-decision-grade.yml`). 사람 기계에서 돌리는 것도
가능하지만 이쪽을 기본으로 두는 이유는 셋입니다.

- checkout이 **구조적으로** clean이라 §12.2의 "동일 commit"이 사고로 깨지지
  않습니다.
- 키가 셸 기록이 아니라 repository secret(`OPENAI_API_KEY`)에 있습니다.
- artifact를 플랫폼이 보존하고, **그 run URL이 곧 §12.1의 `artifactRef`**입니다.
  로컬 실행은 이 불변 참조를 따로 만들어야 합니다.

입력은 다섯입니다 — `model`, `run_label`(`run1`·`run2`…), `max_cost_usd`,
`limit`, 그리고 `confirm`에 **`SPEND`를 그대로 입력**해야 합니다. 유료 provider를
부르는 dispatch이므로 오타나 실수로 눌리지 않게 한 겹 둡니다.

**`limit`은 회차를 compatibility probe로 바꿉니다** — 앞의 N건만 돌고 멈춥니다.
배선이 맞는지 1,150번 지불하며 배우지 않기 위한 것이고, v1이 정확히 그렇게
세 번의 dispatch를 썼습니다. probe는 결과가 아닙니다: artifact에 `probeLimit`이
남고 `decisionGrade`는 숫자와 무관하게 false이며, admissibility 검사와 blind
review 시트 단계는 건너뜁니다(전자는 매번 폐기 판정을 낼 뿐이고, 후자는 8개
cell을 표집하는데 probe가 대부분에 닿지 않습니다).

`limit`을 준 채 **그 flag를 모르는 branch**를 고르면 실행 전에 멈춥니다. 옛
harness는 모르는 flag를 조용히 버리므로 10건을 요청하고 1,150건을 청구받게
되는데, 모르는 flag는 작은 회차가 아니라 전체 회차입니다.

순서도 의도된 것입니다. 무료로 거절할 수 있는 것(동결 조건·register 구조·smoke)
이 **키가 provider 앞에 놓이기 전에** 전부 돌고, artifact 업로드는 admissibility
검사 **앞**에 `if: always()`로 있습니다 — 1,150번을 이미 지불한 회차가 뒤 단계
실패로 기록을 잃어서는 안 됩니다.

한 번에 하나만 돕니다(`concurrency`), 그리고 진행 중인 회차를 **취소하지
않습니다** — 취소는 이미 지불한 호출을 버리는 일입니다.

운영자가 할 일은 secret `OPENAI_API_KEY` 등록과 dispatch 두 가지입니다.

## 3. 사전 등록 — 제외·재실행 규칙 [확정 · 2026-08-24 @mposition]

§12.2는 **제외·재실행 규칙을 사전에 고정**하라고 요구합니다. 결과를 보고 정하면
그 규칙은 결과를 설명하는 도구가 되기 때문입니다. 아래는 harness가 실제로 하는
일에서 유도했고, **첫 회차를 돌리기 전에 확정됐습니다.** 회차별로 다시 정하지
않습니다 — 회차마다 고쳐 쓸 수 있는 규칙은 사전 등록이 아닙니다.

판정은 손으로 하지 않습니다. `npm run check:memory-eval-run -- --artifact=<path>`
가 아래 표를 그대로 적용하고, 폐기 대상이면 비정상 종료합니다.

**케이스 단위 제외는 없습니다.** harness는 provider 오류도 파싱 실패도 조용히
버리지 않고 사유와 함께 점수에 넣습니다(§12.2). 그러므로 사전 등록이 정하는 것은
"어떤 케이스를 뺄까"가 아니라 **"어떤 회차를 통째로 버릴까"**입니다.

| artifact 신호 | 뜻 | 처리 |
|---|---|---|
| `commitSha` 가 `unknown`(또는 없음) | 회차가 자기 commit을 대지 못함 | 폐기 |
| `workingTreeDirty: true` | commit이 실행을 설명하지 못함 | 폐기·재실행 |
| `truncatedByCostCeiling: true` | 상한에서 잘림, 전체 표본이 아님 | 폐기·재실행 |
| `abortedOnConsecutiveFailures: true` | 5회 연속 실패 — 고장이지 불운이 아님 | 폐기, 원인 조사 |
| `decisionGrade` 가 `true` 가 아님 | live·floor·frozen 중 하나가 빠짐 | 인용 불가 |
| `spendCeilingReliable` 가 `true` 가 아님 | 가격 미해석 호출 있음 — 지출은 하한값 | **판정은 유효**, 비용만 청구서로 정산 |

`commitSha` 줄이 맨 위인 이유는 그것 없이는 `workingTreeDirty`를 믿을 수 없기
때문입니다. git이 없는 곳에서 돌리면 `git rev-parse`가 실패해 commit이
`unknown`이 되고, **같은 실패 때문에 `workingTreeDirty`도 `false`가 됩니다** —
artifact가 티 없는 checkout처럼 읽힙니다. 이제 harness가 그런 회차를 아예
거절하므로(§2.5) 이 줄은 그 전에 만들어진 artifact를 위해 남습니다.

가운데 넷은 `true`일 때, 뒤의 둘은 **`true`가 아닐 때** 걸립니다. 필드가 아예 없는
artifact(옛 harness가 만든 것)도 뒤의 둘에서는 걸린다는 뜻이고, 그것이 의도입니다
— 없는 값을 "괜찮음"으로 읽는 것이 인용 불가한 회차가 인용되는 경로입니다.

마지막 줄이 다른 이유는 그것이 **비용 회계의 문제이지 품질의 문제가 아니기**
때문입니다. 가격을 못 읽은 것과 모델이 틀린 것은 다른 사실이고, 섞으면 멀쩡한
회차를 버리거나 상한 없이 돈을 쓴 회차를 멀쩡하다고 부르게 됩니다.

**재실행 규칙.** 버린 회차는 **전체를 다시** 돌립니다. 두 회차의 케이스를 섞지
않습니다 — 섞은 표본은 어느 실행의 것도 아닙니다. 그리고 실패한 회차의 재실행은
§12.2가 요구하는 **독립 재실행이 아닙니다**: 그것은 1회차를 다시 얻는 것이고,
독립 재실행은 성공한 1회차 위에 따로 쌓는 2회차입니다.

**두 회차가 어긋나면**(한쪽만 §12.3을 통과하면) 그 불일치 자체가 결과입니다.
평균 내지 않고, 좋은 쪽을 고르지 않으며, 승인은 보류하고 원인을 찾습니다.

## 4. 1회차 실행

```
export OPENAI_API_KEY=...
npm run eval:memory-extraction -- \
  --live \
  --model=gpt-5-6-luna \
  --json=artifacts/mem-eval-run1.json \
  --max-cost-usd=6
```

- `--json`은 **필수로 취급합니다.** 없으면 raw record가 남지 않고, raw record가
  없는 회차는 register에 인용할 수 없습니다(§12.1).
- `--max-cost-usd`는 승인 예산을 **좁히기만** 합니다. 승인 상한(US$20)보다 큰
  값을 주면 실행 자체가 거절됩니다.
- 1,150건 전부를 한 번에 돕니다. 중간에 멈추면 `truncated`이고 전체 표본이
  아닙니다.

끝나면 **판정을 읽기 전에** 회차가 인용 가능한지부터 확인합니다.

```
npm run check:memory-eval-run -- --artifact=artifacts/mem-eval-run1.json
```

비정상 종료면 §3이 그 회차를 폐기한 것이고, 그 회차의 숫자는 나쁜 소식이 아니라
**소식이 아닙니다.** 순서가 이런 이유는 화면에 판정이 떠 있는 상태에서 인용
가능성을 따지면 그 판단이 판정을 따라가기 때문입니다.

예상 비용은 `npm run report:memory-eval-cost-estimate`가 계산합니다. **입력 쪽만
측정값이고 출력 쪽은 가정입니다** — 답변 하나에 1,024 토큰을 가정하면 2회 합계
US$3.09이고, 가정을 1,000 토큰 올릴 때마다 US$2.76이 붙습니다. 이 모델은
reasoning 토큰을 만들고 그것도 출력으로 과금되는데, 여기서 그것을 잰 사람이
아직 없습니다.

**출력 상한은 비용을 묶지 않습니다.** 상한은 모델의 능력치(128,000)이고, 매
답변이 거기 닿으면 US$353이 됩니다 — 그건 예산이 아니라 상한의 부재입니다.
비용을 묶는 것은 `--max-cost-usd`이며, 누적 지출이 거기 닿는 순간 harness가
멈춥니다. 다만 그렇게 멈춘 회차는 **truncated이고 decision-grade가 아니므로**,
가정치보다 넉넉하되 예산을 비우지 않는 값으로 잡습니다. usage를 보고하는 첫
실행이 그 가정을 숫자로 바꿉니다.

## 5. blind qualitative review

```
npm run make:memory-eval-blind-review -- \
  --artifact=artifacts/mem-eval-run1.json \
  --per-cell=5 \
  --out=docs/ops/memory-eval-blind-review-run1.md
```

시트에는 **모델이 본 대화와 뽑아낸 것만** 있고 harness의 판정과 정답 라벨은
없습니다. 숫자가 이미 맞다고 말한 것을 다시 확인하는 자리가 아니라, **숫자가
재지 못한 것**을 보는 자리이기 때문입니다. 표본은 8개 cell에서 고르게 뽑아 한 번
섞으므로, 순서에서 범주를 짐작할 수 없습니다.

검토가 끝난 뒤에 harness 판정과 대조합니다. 어긋난 건수는 시트 맨 아래에
적습니다. **읽어 보니 아닌 것이 있으면 그 사실이 §12.3의 숫자보다 앞섭니다.**

## 6. 독립 재실행 (2회차)

```
npm run eval:memory-extraction -- \
  --live --model=gpt-5-6-luna \
  --json=artifacts/mem-eval-run2.json \
  --max-cost-usd=6
```

같은 commit, 같은 `promptVersion`, 같은 dataset digest여야 합니다 — artifact의
manifest 세 값을 1회차와 대조합니다. 다르면 두 회차는 같은 것을 잰 것이
아닙니다.

정책 §12.2가 요구하는 것은 "독립 재실행"까지입니다. **다른 시간대에 돌리라는
요구는 이 정책에 없습니다**(그 조항은 `docs/policy/default-model-luna-migration.md`
§4.5.1의 것이고, 대상이 다릅니다). 다만 provider 쪽 시간대 편차를 배제하려면
간격을 두는 편이 낫고, 그렇게 하기로 정했다면 §3의 사전 등록에 적습니다.

## 7. §12.3 판정

harness가 계산해 출력하고 artifact의 `verdict`에 남깁니다. 기준은 정책 §12.3에
있으며 여기에 옮겨 적지 않습니다. 판정할 때 지키는 것은 셋입니다.

- **aggregate와 ko·en 각 arm에서 모두** 충족해야 합니다. 한쪽 arm이 미달인데
  합쳐서 넘는 것은 통과가 아닙니다.
- critical 3종의 **채택 0건 기준은 평균·비율로 완화하지 않습니다.** 1,150건 중
  1건도 0건이 아닙니다.
- zh/fr/de/es/pt는 이 회차의 범위 밖이며 **known limitation으로 기록**합니다.
  해당 locale에 같은 정량 품질을 마케팅하지 않습니다.

## 8. register 승인 (§12.4)

통과했다면 `lib/memoryExtractionEvalRegister.ts`의 해당 entry를 `approved`로
올리고 `evaluation` 블록을 채웁니다. `npm run check:memory-extraction-eval`이
PR Fast Gate에서 fail-closed로 검사하므로, 아래가 비면 병합되지 않습니다.

| 필드 | 어디서 오는가 |
|---|---|
| `artifactRef` | 보존한 artifact의 불변 참조 |
| `evaluatedCommit` | artifact manifest의 `commitSha` |
| `datasetVersion` | `mem-eval-seed-11` |
| `languages` | `["ko", "en"]` |
| `sampleCounts` | `1:ko` … `4:en` 여덟 칸, 범주별 floor 이상 |
| `metrics` | artifact `verdict`의 aggregate·arm별 Wilson 하한 |
| `criticalFalseAcceptances` | **0이어야 합니다** |
| `approver` · `approvedAt` | 사람의 서명 |
| `expiresAt` | 재평가 기한 — **미래여야** 합니다 |
| `knownLimitations` | zh/fr/de/es/pt 범위 밖 등 |

`status`를 올리는 것은 **사람의 행위**입니다. 에이전트는 이 표를 채우는 초안까지
만들 수 있고, 서명은 만들 수 없습니다.

## 9. 그다음 — flag

§15.1의 순서표가 기준입니다. `memoryExtractionEnabled`는 **5번**이고 그 앞의
1~4번은 모두 production에서 켜져 있습니다 — 4번 `assistantKnowledgeEnabled`는
2026-08-23T09:51Z에 켜졌고 기록은
`docs/ops/assistant-knowledge-staging-verification-records/2026-08-23__ea5bf48565a52e00010a6fe8aa9ac3a2153367ad.md`
입니다. 순서상 앞을 막는 것은 없습니다.

**그런데 이 두 flag를 켜는 감사되는 경로가 지금 없습니다.** 8단계에 닿기 전에
정해야 하는 것이고, 이 회차를 막지는 않으므로 여기에 적어 둡니다.

`PATCH /api/admin/app-settings`의 schema에는 두 flag가 **의도적으로 없고**
`.strict()`가 그것을 강제합니다 — 이름을 실은 요청은 무시가 아니라 거절됩니다.
근거는 `tests/appSettingWriters.test.mjs`의 `READ_ONLY_KEYS`에 결정으로
등록돼 있습니다: 활성화는 §12.4의 사람 절차이고, 체크박스는 그 절차의 마지막
단계를 앞의 다섯 단계 없이 수행하는 일이 됩니다. **이 부재는 미완이 아니라
결정입니다** — schema에 추가하는 것으로 해결하지 않습니다.

동시에 이 저장소의 운영 규칙은 flag 전환을 Admin Console로만 하고
`AdminAuditLog`에 남기는 것입니다. 두 사실이 겹치는 자리가 8단계이고, 지금
상태로는 **손으로 `AppSetting`을 고치는 것 외에 방법이 없습니다** — 권한 검사도
감사 기록도 없는 경로입니다. 정지 쪽(revocation)에는 control이 있습니다.
멈추는 것은 쉽게 만들어도 안전하기 때문입니다.

선택지는 셋이며 **판정은 사람이 합니다.**

1. 승인된 pair가 있을 때에만 켤 수 있는 전용 control — `injectableExtractionPairs()`
   가 비어 있으면 거절합니다. 절차를 건너뛸 수 없는 형태의 버튼입니다.
2. 코드로 검토되는 변경(migration 또는 배포 시점 설정). 감사 기록은 commit
   history입니다.
3. `run-default-model-reconciliation`과 같은 승인 인자 방식 script —
   `--approved-*`·티켓·실행자를 모두 요구하고 감사 로그를 남깁니다.

`memoryInjectionEnabled`는 승인 pair가 없거나 revoke되면 flag가 켜져 있어도
fail-closed입니다. 즉 flag는 절차의 마지막 도장이지 첫 단추가 아닙니다.

승인 pair가 없거나 revoke되면 flag가 켜져 있어도 injection은 fail-closed입니다.

## 10. 실행 기록 (사람이 기입)

회차마다 아래를 남깁니다. 관측 칸(manifest에서 그대로 오는 값)은 에이전트가
옮겨 적을 수 있고, 판정과 서명은 사람의 것입니다 — AGENTS.md 「기록을 채우는
경계는 관측과 판정입니다」.

| 항목 | 1회차 | 2회차 |
|---|---|---|
| 사전 등록 규칙 | §3 [확정 · 2026-08-24] | §3 [확정 · 2026-08-24] |
| `check:memory-eval-run` 결과 | | |
| commit / dirty | | |
| datasetVersion / digest | | |
| 실행 시각 | | |
| caseCount / plannedCaseCount | | |
| accruedCostUsd / 상한 | | |
| `spendCeilingReliable` | | |
| `decisionGrade` | | |
| §12.3 통과 여부 | | |
| blind review 부적절 건수 / 어긋난 건수 | | |
| artifact 경로 | | |
| 판정과 서명 | | |
