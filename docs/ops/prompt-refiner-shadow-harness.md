# Prompt Refiner provider-free shadow harness

## 1. 목적과 비목적

이 하네스는 Prompt Refiner의 **동결 corpus·출력 파서·메시지 구조·중단/재개
기록**을 외부 호출 없이 재현하는 개발 전용 검증기다. 체크인된 합성 fixture만
읽으며 provider/model/API/Railway/자격증명/과금 경로가 없다. 실행 보고서의
`providerCalls`와 `costMicroUsd`는 항상 알려진 값 `0`이다.

이 결과는 실제 모델 품질, 의미 보존, 주입 저항 행동, provider 안정성, 비용·지연,
release gate 또는 rollout readiness의 증거가 아니다. reservation authority를
dispatch에 연결하지 않고, stage seed/admin writer·제품 route/runtime caller·receipt
writer·flag 활성화·`admitted: true` 경로도 만들지 않는다.

## 2. 동결 입력과 source 결속

- corpus: `docs/ops/prompt-refiner-shadow/corpus-v1.json`
- schema/corpus version: `prompt-refiner-shadow-corpus-v1`
- case 수: 16개(한국어 8, 영어 8), 배열 순서가 실행 순서다.
- content digest:
  `bcb2709f74aa4983595a7121ad27c3abd80946a6e28d36442cf440f6dcf22958`
- data classification: `synthetic_test_only`

corpus는 사람이 작성한 합성 텍스트만 담는다. parser는 exact schema, 고정 case 수와
ID 순서, 언어 균형, byte/character 제한, 중복 원문, version과 digest를 확인한다.
credential/private-key·URL·email 형태 검사는 방어적 보조 장치이며 개인정보 부재를
일반적으로 증명하지 않는다. 신뢰 경계는 검토된 고정 bytes와 digest다.

CLI는 full 40-hex commit SHA를 요구하고 고정 allowlist의 각 파일을 `git show`로 읽은
bytes와 현재 작업 트리 bytes가 정확히 같을 때만 실행한다. EOL 차이도 drift다. corpus
경로나 adapter/plugin/live/provider 모드를 인자로 바꿀 수 없고, 동적 plugin loading과
credential lookup도 없다. sourceRef와 정렬된 `path → file SHA-256` map의 canonical
identity digest는 journal·witness 최초 header에 함께 고정되며, 재개 시 둘 다 정확히
같아야 한다. 고정 allowlist의 모든 경로와 `.gitattributes` 자체를 `eol=lf`로 pin해
Windows `core.autocrlf=true`의 정상 checkout도 Git blob bytes와 같게 유지한다. 테스트는
그 checkout과 네트워크 child trap 아래 CLI를 실행한다.

## 3. 출력 파서

fixture output은 실제 모델 모양의 불신 입력으로 취급한다.

1. 64 KiB와 BOM 경계를 검사한다.
2. `parseBenchmarkJson()`으로 JSON syntax·duplicate key·complexity를 제한한다.
3. `strictBenchmarkObject(["refinedPrompt"])`으로 필드를 정확히 하나만 허용한다.
4. 기존 Prompt Refiner prompt의 byte/character 계약을 적용한다.
5. 빈 결과·원문과 같은 결과·기타 invalid 결과를 고정 failure code로 바꾼다.

fence 제거, 앞뒤 prose 탐색, JSON 복구, schema coercion 또는 부분 salvage는 하지
않는다. audit/journal/report에는 사용자/source prompt·fixture output·refined prompt의
bytes나 **per-item content digest**를 쓰지 않는다. 반면 합성 fixture 집합의 provenance인
`corpusDigest`와 실행 source identity hash는 header와 aggregate report에 저장한다. 이는
사용자 콘텐츠 receipt가 아니다.

## 4. 서로 다른 두 지표

`structuralBoundaryViolations`는 `promptRefinerModelMessages()`가 공격 문자열을 data
message 밖으로 내보내지 않았는지를 `auditPromptRefinerMessages()`로 검사한 값이다.
이는 메시지 구조 증거일 뿐 모델의 비순응 행동 또는 주입 저항 증거가 아니다.

`behavioralOutcomeMatched`는 로컬 fixture output의 strict parser 결과가 동결 expected와
같은지 본다. 외부 모델 행동이 아닌 deterministic fixture 회귀다. 두 지표는 별도
population과 분자를 유지하며, structural violation 0을 모델 compliance로 표현하지
않는다. 어느 하나라도 어긋나면 하네스는 non-resumable stop으로 끝난다.

## 5. journal, witness와 복구 계약

Prompt Refiner 전용 namespace의 journal은 다음을 강제한다.

- `wx` lock 하나만 허용하며 stale lock을 자동 삭제·회수하지 않는다.
- 각 JSONL event는 `seq + previousDigest + event` SHA-256 chain을 가진다.
- 별도 append-only witness JSONL이 모든 entry digest를 등록한다.
- journal과 witness의 모든 append는 `fsync`한다.
- 두 header는 같은 corpus digest뿐 아니라 sourceRef와 canonical source identity digest에
  결속된다. 다른 source snapshot으로 재개할 수 없다.
- case 평가 전 content-free `case_intent`를 먼저 durable하게 기록한다.
- intent만 있고 terminal이 없으면 결과는 `interrupted`, unknown case 1이며 재실행하지
  않는다. 자동 재시도·repair parser·trailing partial 무시는 없다.
- case terminal 뒤 stop/complete 전 중단은 clean interruption이라 같은 corpus/source로
  재개할 수 있다.
- `--max-cases=N`으로 만든 `case_limit` stop만 재개할 수 있다. 구조 또는 fixture
  mismatch stop은 재개할 수 없다.
- duplicate/orphan/conflicting terminal, chain·witness 불일치, truncation, rollback,
  event-after-completion은 모두 fail-closed한다.

상태는 `completed`, `stopped`, `interrupted`를 구분한다. 실행 횟수 한계는 corpus 16개와
호출별 `max-cases`뿐이며 wall-clock에 의존하지 않는다. provider call/cost 한계는 모두
0이다.

hash chain과 같은 로컬 디렉터리의 witness는 악의적인 호스트 관리자나 두 파일을 함께
되감는 공격을 막는 외부 원장이 아니다. 전원 장애 내구성을 모든 filesystem에 대해
증명하지도 않는다. lock 또는 등록 불일치가 남으면 운영자가 원인을 보존·조사해야 하며
이 도구는 삭제나 복구를 제안하지 않는다.

## 6. 로컬 사용

source 파일을 먼저 commit한 뒤 정확한 commit SHA를 사용한다.

```text
npm run shadow:prompt-refiner -- --journal=<new.jsonl> --source-ref=<40-hex-sha>
npm run shadow:prompt-refiner -- --journal=<existing.jsonl> --source-ref=<same-sha> --resume
```

의도적인 구간 중단은 `--max-cases=N`을 함께 쓴다. 첫 실행에는 `--resume`을 쓰지 않고,
기존 journal에는 반드시 `--resume`을 쓴다. source/corpus mismatch, unknown intent,
mismatch stop, stale lock, truncation 또는 witness disagreement는 새 실행이나 자동 수리의
근거가 아니다.

## 7. 다음 연결 경계

1. 이 source와 corpus를 Claude Code Max 읽기 전용 독립 검토와 Linux 통합 CI로
   검증한다. 이는 실행 또는 비용 승인이 아니다.
2. durable authority와 하네스를 잇는 **새 admission 계약**, stage 생성/admin writer와
   runtime receipt 저장을 별도 설계·검토한다. 기존 v1은 수정하지 않는다.
3. 새 계약과 비용을 별도 승인한 뒤에만 bounded actual shadow를 한 번 실행한다.
4. 의미 보존·행동상 주입 저항·비용·지연 증거가 승인됐을 때만 제품 제안형 UI 연결을
   제안한다.
5. Refiner 결과의 Router 결합과 전체 모델 catalogue 품질은 그 뒤의 별도 실험이다.
