# 독립 검토 결과 — 발견 대기열: 채택·제외, 재검토, 구조화된 결정 기록

검토자: codex (독립 실행) · 7라운드 · 최종 **승인** (P1 없음)
요청서: `model-discovery-adopt-exclude-independent-review-prompt-2026-09-13.md`,
`model-discovery-adopt-exclude-round{2,3,4,5,6}-prompt-2026-09-13.md` (7차는 대화 안에서 전달)
계약: `.github/audits/model-lifecycle-email-2026-08-22.md` §51

## 배경

운영자 결정(2026-09-13): 발견 대기열 화면은 `채택`·`제외` 두 결정만 둡니다. `결정 필요`·`보류`
버튼은 아무것도 누르지 않은 것과 구분되지 않아 제거하고, `조치 없음`은 `제외`로 바꾸되 영구
종단이 아니라 명시적 `재검토`로 대기열에 되돌릴 수 있게 합니다. 행의 자동 분석 문장이 운영자 사유로
기록되던 감사 기록은 `decision`·`reasonCode`·`operatorReason`·`analysisSnapshot`으로 분리합니다.

## 라운드 요약

| 라운드 | P1 | P2 | 핵심 |
|---|---|---|---|
| 1차 | 0 | 5 | 스냅샷이 화면 값과 결속 안 됨, 채택 스냅샷 실패 은폐, 일반 전이 `approved` 우회, DB CHECK와 서비스 불일치, 늦은 응답이 보기를 덮음 |
| 2차 | 0 | 6 | 200건 벌크가 64 KiB 초과, 채택 사유 1,001자 500, 보기 전환 경쟁, 숨은 구성원 분석 기록, 이미 승인된 item 채택 기록 누락, §51 API 누락 |
| 3차 | 0 | 4 | 패밀리 일부만 제외 가능, 스냅샷 null 허용, 제외됨 보기 조회가 이력에 비례, `FAMILY_MISMATCH` 후 대화상자 복구 불가 |
| 4차 | 0 | 4 | 검사와 쓰기 비원자, 제외 출발 상태 DB 미강제, 결정 행위자 미강제, stage 정책과 확인 문구 충돌 |
| 5차 | 0 | 3 | 테이블 잠금이 채택과 교착, alias 변경 경합, 부분 재개봉 |
| 6차 | 0 | 1 | 결정 요청 중 보기 전환 |
| 7차 | 0 | 0 | 승인 |

## 설계에 반영된 주요 결정

- **분석 스냅샷은 서버가 계산하고, 화면과는 fingerprint로 결속.** 제외 요청은 패밀리마다 운영자가
  읽은 대표 행과 그 분석의 16자리 fingerprint를 보냅니다. 서버 계산과 다르면 409
  `ANALYSIS_CHANGED`. 대표의 분석을 모든 구성원 이벤트에 기록합니다(숨은 구성원의 보지 않은 분석을
  "본 값"으로 남기지 않음). 문장을 보내지 않아 200건 벌크도 요청 한도 안입니다.
- **결정은 패밀리 전체 단위.** 제외·재검토 모두 제출이 서버가 지금 읽은 패밀리 구성원 전체와 정확히
  같아야 합니다(409 `FAMILY_MISMATCH`, 1,000 초과 503 `QUEUE_TOO_LARGE`). 트랜잭션 안에서 해당 상태의
  id 집합을 재확인합니다.
- **채택은 별도 기록 이벤트.** `approved` 단계에 붙이면 이미 승인을 지난 item에 기록이 없으므로, 채택
  경로 끝에서 `fromStatus = toStatus` 이벤트(`recordAdoptionDecision`)로 남깁니다. 일반 전이로 `approved`에
  가는 요청은 거부해 승인은 채택으로만 일어납니다. 분석을 계산하지 못하면 registry 생성 전에 503.
- **DB CHECK가 서비스와 같은 모양을 강제.** 목록 2개와 shape 1개: 제외는 사유 코드·미결정 출발·스냅샷
  필수, 재검토는 서면 사유 필수·스냅샷 없음, 채택은 사유·스냅샷 필수·채택 종착 상태, 모든 결정은
  행위자 필수, 사유는 공백 불가·1,000자 이하.
- **테이블 잠금은 쓰지 않음.** 4차 대응으로 넣은 `SHARE ROW EXCLUSIVE` 잠금이 채택 트랜잭션(행 잠금 뒤
  UPDATE)과 교착해(5차) 제거했습니다.

## 잔여 위험 (수용, codex 6차 판정 "타당")

재확인과 commit 사이의 좁은 틈, 또는 대기열 테이블을 건드리지 않는 catalogue alias 변경으로 패밀리가
다시 묶이면 구성원 하나가 원래 보기에 남을 수 있습니다. 결과는 화면에 보이고 따로 결정할 수 있으며
되돌릴 수 있습니다 — AGENTS.md "검증 범위는 되돌릴 수 없는 것에 비례"에 따라 직렬화 대신 검사로 둡니다.
codex 6차: "남는 창의 결과는 대기열 노출 상태의 가역적 불일치입니다. 이 경합 자체는 P1/P2로 보지
않습니다."

## 기존 정책과의 관계

- prerelease로 기록된 결정은 같은 패밀리의 stable release를 억제하지 않습니다(기존 stage 정책 유지).
  확인 문구에 "프리뷰·베타 버전을 제외한 경우 정식 출시 버전은 새로 제안될 수 있습니다"를 덧붙였습니다.
- `scripts/close-filtered-model-lifecycle-items.mjs`는 계속 사유 코드 없이 닫습니다(제외됨 보기에
  "사유 기록 없이 종료됨").
- `rejected`·`completed`는 종단으로 남습니다.

## 검증

- typecheck, 변경 파일 ESLint, `security:regression`, `check:enum-constraints`(87 closed list),
  `check:encoding:strict`, `check:locale-translation`, `check:accent-tokens`,
  `check:policy-section-references`, `check:db-integration-coverage`(111 suite) 통과.
- core 단위 50, route contract 14, admin locale 13 통과. 최종 트리의 전체 unit: 8,968건 중 8,960 통과,
  실패 7건은 이 Windows 환경에서 원래 실패하는 테스트와 같습니다.
- **실행하지 못한 것:** `tests/integration/model-lifecycle-exclusion.db.test.ts`(DATABASE_URL 없음, CI의
  PostgreSQL job에서 실행), 실제 잠금 경합, staging 화면.
