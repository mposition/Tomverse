# router-development-benchmark-v1 round 0 독립 검토 기록

- 검토자: Claude (대화형 세션). `claude --print --safe-mode` CLI 호출이 아니며 preflight도 없습니다.
- 대상: taskId `router-development-benchmark-v1`, round 0, source commit `138bd4c6`, digest `sha256:c5eae232832ac9cea55452bcd0425da493f7c65dd444f26a66fc3e0c21e9a345`.
- 방식: 읽기 전용. 파일 수정·commit·provider 호출·배포 없음. 재현은 worktree `H:\Project\tomverse-router-benchmark-v1-20260910`(HEAD `394387ce`)에서 실행했고, 산출물은 세션 임시 경로에만 썼습니다. 실행 전후 `git status`는 비어 있었습니다.
- 판정: **approve, findings 없음.** 판정 JSON은 `verdict-router-development-benchmark-v1-round0.json`, 기록용 후보 파일은 `verdict-round0.candidate-record.json`.

## 1. 출처 검증 (직접 실행)

| 항목 | 관측 |
|---|---|
| digest 재계산 | `git diff 89288a86 -- :(literal)<scope 10개> :(exclude,literal)<패키지 폴더>`의 sha256이 `c5eae232…`와 동일, 패키지의 diff 텍스트와 바이트 동일 |
| 패키지 커밋 이후 | `138bd4c6..394387ce` 두 커밋은 패키지 기록 파일 6개만 추가, 범위 소스 10개 파일 무변경 |
| 통합 base | `89288a86`(#1308 병합 커밋)이 HEAD의 조상 |

## 2. 기록에서 관측한 사실 (package-round0.json)

- 제어 프로그램이 `npm run test:router-development-benchmark`를 실행해 `fail 0`을 기록. 기록의 출력은 마지막 5줄뿐이라 테스트 수는 기록에 없음.
- guard 4종(`check:encoding`, `check:doc-references`, `check:policy-section-references`, `check:router-quality-eval`) 통과 기록. 타입 검사와 lint는 guard에 없음.
- `checkFailures` 빈 배열, `reviewConclusion` null, `awaiting_review`.

## 3. 직접 실행해 관측한 사실

| 검사 | 결과 |
|---|---|
| `npm run test:router-development-benchmark` | tests 95, pass 95, fail 0 (기준 "95 이상"의 최소값과 정확히 일치) |
| `npx tsc --noEmit -p tsconfig.json` | 오류 0 (route types 존재) |
| `npx eslint` 신규 6개 파일 | 통과 |
| `--mode=dry-run --plan=Pro` (임시 경로 출력) | 42 모델 × 24 case = 1008행, planned 360, refused 648, case당 15/27, profiler 불일치 8 case·80행 (README 수치와 일치), eligible 행 전부 비용 산출, NaN 없음, 계획 JSON에 `expected` 없음, `row.input` 키는 `prompt`뿐 |
| 환경 override | `lib/modelPricing.ts`가 읽는 접미사 5종(`CHAT_MODEL_<ID>_INPUT_USD_PER_MILLION` 등)과 CLI의 대소문자 무시 거부 정규식이 일치 |
| 전체 행렬 채점 (임시 답변 파일 3종) | 360행 전부 정답: correctnessRate 1; 혼합(오답·공백·비JSON·failed·timeout 각 1, 미제출 10): 각 1건씩 분리 집계, correctnessRate null, coverage 350/360; 외부 저장(20행, 지표는 절반만): evidenceStatus `self_reported_saved_answers_unverified`, 지표 합계 null. 모든 그룹(summary·모델 42·셀 168)에서 passed+incorrect+blank+invalidJson+failed+timeout = submitted, planned = submitted+notRun, 빈 그룹은 비율 null, 부분 그룹은 correctnessRate null. 채점 출력에 answerText·expected 없음 |
| grader 경계 | 공백·키 순서·`1e0`/`10E-1`/`1.000…0` 통과; BOM·fence·주석·이중 객체·중복 키(중첩 포함)·raw 탭·`+1`·`0x1`·작은따옴표·`1e400`·정밀도 손실 값은 invalid_json; 누락 키·`"null"` 문자열은 value_mismatch; `\t`·`\"`·`\\`·`\uXXXX` 이스케이프는 올바르게 복원; 깊이 32 허용/33 거부; 2^53 경계 거부 |
| 정답 값 대조 | 24개 case의 prompt를 읽고 계산·추출 case의 expected를 손으로 재확인, 불일치 없음 |

## 4. 완료 기준별 근거

1. 테스트 95건, provider·judge·코드 실행 호출 없음(테스트 그래프 검사와 CLI 테스트의 네트워크 trap) — 직접 실행으로 확인.
2. 코퍼스 검증기: 24건·셀당 6건·development-only·exact-json·needsSearch false/attachments []/tools [] 강제 — 코드와 테스트로 확인; README가 "같은 에이전트가 작성, 독립 검토 아님"을 명시.
3. grader: 의미값·중첩 키·타입·null·불리언·순서 배열 비교, 키 순서·공백·수치 표기 허용, 문자열 무정규화, 공백/오답/누락/추가/중복 키/fence/비JSON/정밀도/한도 실패 — 3절의 경계 실행으로 확인.
4. 1008행, 안정 rowId(`caseId::modelId`), 거부 행 유지, 미지·중복 모델과 변조 계획 거부(테스트), context window·품질 증거 미발명 — dry-run과 테스트로 확인.
5. `row.router` 보존, `benchmarkEligibility.basis = declared_fixture_requirements_not_router_inference`, 불일치 노출(80행), 제품 Router 파일 무변경 — filesChanged와 dry-run으로 확인.
6. 매니페스트 필드와 표현(`unverified`, 추정치 한계) — 코드·README 확인.
7. `modelInputForCase`는 `{ prompt }`만 — 코드·테스트·dry-run 출력 확인.
8. 결과 검증과 분모 규칙 — 3절의 전체 행렬 채점으로 확인.
9. CLI 인자·환경 override·읽기 한도·덮어쓰기 거부·snapshot 요구 — 코드·테스트·직접 실행 확인.
10. 기존 exchange·Router·정책 무변경(diff 범위 10개 파일), 문서에 우승자·구간·밴드·대표성·준비도 주장 없음, package는 author=codex·reviewer=claude, 제외는 자기 출력 폴더 하나.

## 5. 판정 밖 관찰 (finding 아님)

- 계획 문서와 답변 파서가 `DEVELOPMENT_LIMITS.nodes`(200,000)를 공유합니다. 42개 모델의 계획은 77,417 노드(약 1,843/모델)이고, 복제 카탈로그로 `buildDevelopmentPlan`을 돌리면 100개는 통과, 126개는 `json_complexity_limit`으로 거부됩니다. 선언된 `models` 한도 256은 실제로 닿지 못하며, 16 MiB 문서 한도는 약 170개 모델 근처에서 먼저 걸립니다. 현재 카탈로그(42)에는 영향이 없고 실패도 fail-closed라 결함으로 올리지 않았습니다.
- BOM이 앞에 붙은 답변은 invalid_json입니다. 계약("fence·설명 없이 JSON 객체 하나")과 일치하므로 그대로 두어도 됩니다.
- 테스트 수가 기준의 최소값(95)과 정확히 같아, 테스트 하나를 지우면 기준 1이 깨집니다.

## 6. 이 검토가 하지 않은 것

- reviewer CLI(`claude --print --safe-mode …`) 호출, preflight, `--mode=review`, live 모드, provider 호출.
- worktree 내 파일 쓰기. 판정 기록(`verdict-round0.json`)과 `exchange.json` 재생성은 사용자의 별도 단계입니다.
