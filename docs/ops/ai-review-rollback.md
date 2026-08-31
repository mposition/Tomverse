# AI Review rollback 절차

`docs/policy/ai-review-m5-quality-contract.md` §11.

되돌릴 대상은 넷이고 **되돌리는 방법과 위험이 각각 다릅니다.** 하나의
"AI Review를 끈다" 스위치는 존재하지 않으며, 만들지도 않습니다 — 네 가지 중
셋은 끄지 않고 좁히는 것이 옳은 대응입니다.

## 0. 먼저 확인

```
npm run report:ai-review-operations -- --window=7
```

`outcome` 분포와 `reviewerHealth`가 어느 층의 문제인지 말해 줍니다.

| 증상 | 층 |
|---|---|
| 특정 reviewer의 `failureRate`만 높음 | §1 reviewer |
| 모든 reviewer가 동시에 나빠짐 | §2 프롬프트 또는 provider 전반 |
| `refused_before_provider`가 급증 | reviewer 부족·크레딧·한도. reviewer 문제가 아님 |
| 실행은 되는데 `insufficient_evidence`만 나옴 | §3 telemetry |
| 항목 피드백 저장 실패 | §4 |

## 1. reviewer 모델 되돌리기

**배포 없이 환경변수로 가능합니다.**

```
COMPARISON_REVIEW_MODEL_IDS=<모델 id 쉼표 구분>
```

- 비우면 `COMPARISON_REVIEW_DEFAULT_MODEL_IDS`(mistral-medium-3-1,
  claude-sonnet-5, qwen3.7-plus)로 돌아갑니다.
- **하나만 남기면 두 번째 검토가 사라집니다.** 그건 기능 축소이지 장애 대응이
  아니므로, 후보 하나를 빼는 편을 먼저 시도합니다.
- `assertModelRuntimeAvailable()`이 이미 비활성 모델을 건너뛰므로, 한 모델이
  provider 장애일 때는 **아무것도 하지 않아도** 다음 후보로 넘어갑니다. 환경변수를
  건드리는 것은 그 fallback이 원치 않는 모델로 가는 경우뿐입니다.

변경 후 확인:

```
npm run report:ai-review-m5-readiness
```

`served pairs`가 의도한 목록인지, `production_pair_matches_approved_pair`가
무엇을 말하는지 봅니다. **승인된 pair가 아닌 것을 서비스하는 것은 그 자체로
장애가 아니지만**(오늘은 승인된 pair가 하나도 없습니다), M5 승급 중이라면
그 순간 eligibility가 깨진다는 뜻입니다.

## 2. 프롬프트 버전 되돌리기

`COMPARISON_REVIEW_PROMPT_VERSION`은 **코드 상수**이며 환경변수가 아닙니다.
되돌리려면 배포가 필요합니다.

**되돌리기 전에 알아야 할 것:** 프롬프트 버전은
`createComparisonReviewHash()`에 들어갑니다. 즉 **버전을 되돌리면 이전 버전으로
만들어진 캐시가 다시 유효해집니다** — 새로 과금되지 않고 예전 결과가 돌아옵니다.
앞으로 굴릴 때도 같은 이유로 캐시가 비껴가며, 그것은 정상입니다.

절차:

1. `lib/comparisonReview.ts`의 `COMPARISON_REVIEW_PROMPT_VERSION`을 되돌립니다
2. 프롬프트 본문(`buildComparisonReviewPrompt`)도 같은 commit에서 되돌립니다 —
   **버전 문자열만 되돌리면 새 프롬프트가 옛 버전을 참칭합니다**
3. `lib/aiReviewEvalRegister.ts`의 pair는 `(모델, promptVersion)`이므로,
   되돌린 버전의 pair가 register에 있어야 drift 보고가 의미를 갖습니다
4. 배포 후 `npm run report:ai-review-operations -- --window=7`

## 2.5 어떤 commit을 되돌리는가

**merge commit을 `git revert A^..A`로 되돌리려는 시도는 실패합니다.** merge에는
부모가 둘이라 `-m`이 필요하고, 그 범위 표기는 merge가 담고 있던 기능 commit을
되돌리지도 않습니다.

되돌릴 대상은 **기능 commit들**입니다. 목록을 먼저 만듭니다.

이 컨테이너가 아니라 **로컬 PC의 PowerShell, Tomverse clone 폴더 안**에서
실행합니다. 자격증명은 필요 없고, 아래 첫 두 명령은 읽기 전용입니다.

```
git log --oneline --no-merges --grep="ai-review" origin/develop
```

그 중 되돌릴 것을 골라 개별로 revert 합니다(오래된 것부터).

```
git revert --no-commit <sha1> <sha2> <sha3>
git commit
```

**merge 자체를 되돌려야 하는 상황이면** 부모를 지정합니다. develop으로 들어온
merge를 되돌릴 때는 보통 `-m 1`(develop 쪽)입니다.

```
git revert -m 1 <merge sha>
```

되돌린 merge를 나중에 다시 병합하려면 revert를 한 번 더 revert 해야 한다는
점을 알고 시작합니다 — 그렇지 않으면 git은 이미 병합했다고 판단합니다.

## 3. 운영 telemetry 되돌리기

`ComparisonReviewRun` 기록은 **없어도 AI Review가 동작합니다.** 이것이 설계
목표입니다: 기록 실패가 사용자의 정상 결과를 잃게 만들지 않습니다.

- 테이블이 없으면 writer가 log-only로 내려앉고 한 번 경고합니다
  (`ComparisonReviewRun is not migrated yet`).
- 쓰기 실패는 `comparison_review_run_record_failed` 구조화 이벤트로 남습니다.
  헬스 체크는 영어를 파싱하지 않고 이 이름을 셉니다.
- **되돌리는 순서는 애플리케이션 먼저, 스키마는 그대로 두기입니다.** 코드를
  되돌리면 기록이 멈추고 사용자에게는 아무 변화가 없습니다. 남은 테이블은
  90일 TTL이 비웁니다.
- **운영 DB에서 손으로 `DROP TABLE` 하지 않습니다.** 그러면 스키마가
  migration 이력과 어긋나고, `npm run db:compare-schema`가 그것을 drift로
  보고하며, 다음 배포가 존재하지 않는 테이블을 전제한 채 올라갑니다. 이는
  AGENTS.md가 `CreditLot` CHECK 검증에 대해 이미 정한 것과 같은 규칙입니다 —
  **production에서 손으로 스키마를 바꾸면 schema 비교가 drift로 잡습니다.**
- 테이블을 정말 없애야 한다면 **별도 forward migration**으로 삭제합니다
  (`DROP TABLE "ComparisonReviewRunAttempt"; DROP TABLE
  "ComparisonReviewRun";` — 자식 먼저). 그 migration은 이력에 남고, 다른
  환경도 같은 경로로 따라옵니다.
- 서비스에 telemetry를 넘기는 것은 caller의 `telemetry` 옵션 하나이므로, 코드
  수준에서 좁히려면 route에서 그 옵션을 빼면 됩니다(기록이 멈추고 나머지는
  그대로). 배포 없이 멈추는 방법은 없습니다 — 환경변수 스위치를 두지 않은 것은
  의도이며, 기록이 조용히 꺼져 있는 상태가 가장 위험하기 때문입니다.

**되돌리는 것과 조용해지는 것은 다릅니다.** 기록이 멈춘 것을 알아채는 방법은
`telemetryCoverage()`의 비율이 갑자기 벌어지는 것과 위 구조화 이벤트 둘뿐이며,
둘 다 유지합니다.

## 4. 항목 피드백 되돌리기

- API를 막으려면 route를 제거하거나 401로 두면 되고, **UI는 저장 실패를 이미
  롤백하고 사용자에게 알립니다**(E2E가 이 경로를 검사합니다).
- 데이터 되돌리기도 **별도 forward migration**으로 합니다(§3과 같은 이유).
  사용자 본인의 판단이므로 **삭제 전에 export 의미론을 확인**합니다: 이 표는
  계정 export에 포함되며, 지우면 그 부분이 사라집니다.
- review·계정 삭제와 함께 cascade 하므로 별도 정리 작업은 없습니다.

## 4.5 평가 도구 되돌리기

평가 harness·register·threshold는 **production 경로에 없습니다.** 되돌려도
사용자에게 아무 일도 일어나지 않고, 되돌릴 이유도 사실상 하나뿐입니다 —
threshold 집합을 내렸다가 취소하는 것.

- threshold를 되돌릴 때는 **버전을 새로 만들지 말고 잘못된 버전을 그대로
  둡니다.** 승인은 `thresholdVersion`을 이름으로 인용하므로, 기존 버전을
  수정하면 그 이름으로 승인된 pair가 조용히 다른 기준으로 재해석됩니다.
- register의 `approved`를 되돌릴 때는 항목을 지우지 말고 `revoked`로 바꿉니다.
  commit 이력이 감사 기록이고, 삭제는 그 기록을 없애는 일입니다.

## 5. 되돌릴 수 **없는** 것

- **캐시된 `ComparisonReview`를 읽을 수 없게 만드는 스키마 변경.** 사용자가 이미
  크레딧을 치른 결과가 사라지고 다음 요청에서 다시 과금됩니다. 그래서 항목 id는
  저장하지 않고 파생합니다(정책 §9.1). 되돌림 대상이 아니라 **하지 않는 것**이
  대응입니다.
- **`ComparisonReviewRun`에 들어간 사용자 콘텐츠.** 90일 TTL이 있지만 유출은
  회수가 성립하지 않습니다. `tests/comparisonReviewRunCore.test.mjs`와
  `tests/integration/comparison-review-run-telemetry.db.test.ts`가 이를 막습니다.
- **register의 승인 기록.** commit 이력이 감사 기록이므로, 잘못된 승인은 되돌린
  commit이 아니라 `revoked` 항목으로 남깁니다.

## 6. drill

**이 문서를 쓴 것은 drill을 수행한 것이 아닙니다**(정책 §10.2 항목 9).
drill은 staging에서 §1과 §2를 실제로 실행하고, 날짜·실행자·소요 시간·
관측된 영향을 기록으로 남기는 것입니다. 그 기록이 생기기 전까지
`rollback_drill_completed`는 열려 있습니다.
