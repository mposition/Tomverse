# Chat 운영 가용성 복구와 자동 비활성화 제거 — 2026-10-13

운영자가 production Chat의 재활성화와, 이미 켜진 제품을 코드가 자동으로
비활성화하는 경로의 제거를 지시했다. 구현·검증·독립 검토와 운영 반영은
각각 별도 상태이며 이 기록은 병합이나 staging 생략 승인이 아니다.

## 운영 복구 — 완료

- 실행 중인 production: commit `31c01377bbc55da02b9961b2f6512a4d63b441a3`,
  deployment `6148c8e0-3d2d-4236-bbac-ca2dda6059b2`, Railway `SUCCESS`.
- 출시 설정은 켜져 있었으나 실행 소스 fingerprint가 바뀌어 기존 v2 활성화
  쌍을 찾지 못했다(`activation_pair_absent`). 운영자 스위치가 꺼진 것이 아니다.
- 별도로 Auto guard는 `unknown_dispatch_or_cost`, generation 1로 중단돼
  있었다. 이전 불명 비용과 요청은 정산·해제·재시도하지 않았다.
- 기존 Google Owner 세션의 실제 재인증과 Admin UI로 현재 배포의 활성화,
  Auto 재개와 Guest 활성화를 기록했다. 직접 감사 테이블 쓰기를 하지 않았다.
- Router 감사: `cmv6cu36k002g02plhllw6xha`.
- Refiner 제품 감사: `cmv6cu373002h02plhsjm4gyt`.
- Owner 재개 감사: `cmv6cvdpu002i02pl70jhc7af`, 재개 generation 2.
- Guest 감사: `cmv6cvwsc002j02pls47z83bv`.
- `/chat` 접근과 Smart Adaptive ON, 익명 capability `offered: true`를 확인했다.
  유료 Chat/Refiner provider 요청은 실행하지 않았다.

## 재발 방지 구현과 검증 — 완료, 운영 반영은 대기

[운영자 결정 v3](../../docs/policy/chat-operator-controlled-availability-v3.md)에
따라 소스·commit·배포 변경은 기존 Owner 활성화를 자동 만료시키지 않는다.
최신 승인 쌍과 그 Guest 승인을 읽고, 활성화 당시의 소스와 실행 식별자는
수정하지 않는다. capability와 실제 dispatch admission이 같은 규칙을 쓴다.
현재 Router 제어, 가격·candidate·adapter pin과 감사 무결성은 계속 검증하며,
더 새로운 무효 승인이나 중복 승인은 이전 승인으로 우회하지 않는다.

운영 오류는 `prompt_refiner.product_auto_guard_observed` 감사로 기록하고
전역 guard나 출시 설정을 끄지 않는다. 같은 generation·사유는 한 시간 동안
중복 기록을 제한하고 이후 재발은 다시 기록한다. 요청별 거부·원문 fallback,
unknown hold, 중복 claim, Guest quota와 비용 예약·정산은 유지한다.

- 제품 server/client 회귀 89건 PASS.
- 제품 상태 server/client 회귀 23건 PASS.
- 실제 PostgreSQL 17 guard·감사·Prisma 바인딩 및 actor 권한 16건 PASS,
  skipped 0. 실제 `adminAudit.ts`를 사용해 권한 검사·DB 시계·HMAC·체인 연결,
  동시성·시간대·시간 창·불명 요청 보존과 기존 Owner 재개를 검증했다.
- 소스 fingerprint·Router authority·Guest binding 8건 PASS.
- 보호 테이블 검사와 검사기 회귀 31건 PASS; 문서 참조·변경 파일 lint·
  TypeScript·`git diff --check` PASS.
- 깨끗한 작업 폴더의 `npm ci`/Prisma 생성과 Next route typegen을 사용했다.
  공유 checkout의 의존성이나 기존 로컬 변경을 수정하지 않았다.

## 독립 검토

저장된 Claude Code Max 로그인으로 읽기 전용 검토를 실행했다. `--safe-mode`,
MCP 비활성화와 읽기 도구 제한을 사용했다. 최초 판정은 새 감사 action의
권한 매핑 누락과 목 처리된 감사 writer 때문에 REJECT였다. 정확한 guard
target의 action을 등록하고 실제 canonical writer를 쓰는 DB 검증을 보강한 뒤
후속 판정은 **ACCEPT**였다. 기존 paused action은 과거 기록 호환성을 위해
유지하며 system actor에 직접 감사 테이블 쓰기 권한을 추가하지 않는다.

비차단 의견은 다음과 같이 처리했다.

- 시간 창은 명시적 bigint cast와 실제 Prisma driver로 검증했다.
- digest helper는 두 입력 필드만 명시적으로 사용한다. 기존 canonical JSON은
  키를 정렬하며 추가 필드가 digest에 유입되지 않는다.
- 관측 함수의 두 호출부는 감사 체인 락을 guard 행 락보다 먼저 잡는다.
  동시성 DB 검증이 이 순서를 확인한다.
- 기존 `AdminAuditLog`의 `(action, createdAt)`와 `(targetType, targetId)`
  인덱스가 한 시간의 관측 조회를 지원한다. 새 migration은 필요하지 않다.
- 기존 latch 이름은 호출부 호환성을 위해 유지한다. 호출부는 반환값을
  무시하고 요청의 기존 오류·fallback을 별도로 반환한다.
- active guard 컬럼은 가용성 상태다. 품질 문제는 영수증·새 관측 감사로
  기록하며, 과거 실패한 품질 게이트와 Router 측정 대기는 PASS로 바꾸지 않는다.

## 병합 전 hotfix 승인과 남은 조건

PR CI의 후속 수정은 budget DB 시료의 `metadata`·UTC `createdAt` 보완과
공용 감사 actor closure 변경에 따른 Marketing fingerprint 갱신이다.
Marketing 판정·권한은 그대로이며 기존 검증 증거는 stale로 남는다.
격리된 loopback PostgreSQL 17에 현재 전체 migration을 적용한 뒤
`test:prompt-refiner-product-db` 39개(0 skip), Marketing 단위 19개,
TypeScript·scoped eslint·protected writer·문서 참조 검사를 통과했다.
이 후속 diff도 Claude Code 독립 검토 ACCEPT를 받았다.

운영 복구와 새 코드의 운영 배포는 다르다. 이번 변경은 아직 병합·배포하지
않았다. 운영자 mposition이 2026-10-13 이 작업의 PR #2449에 대해
"staging 생략 hotfix 승인"이라고 명시적으로 승인했다. 승인은 실제 병합 전이며,
CI 통과 뒤 이 production 가용성 사고 수정의 병합·배포에 적용한다.
[릴리스 체크리스트 §7.9.2](../RELEASE_CHECKLIST.md)의 staging 생략 승인을
기록하며, CI에서 드러난 테스트 시료 보완과 감사 closure fingerprint 갱신은
같은 수정 범위다. Marketing 권한·외부 호출·활성화 증거를 승인하지 않는다.
운영 반영 뒤 정확한 release SHA, 활성화 지속·운영 제어 readback과
develop back-merge를 확인한다.

전체 Chat 진행률은 현재 승인 계획의 기능별 분모를 확인하지 않았으므로
산정하지 않는다. 이번 완료는 운영 가용성 복구와 위 두 자동 비활성화 경로의
구현·검증이며, Chat 전체 기능·품질 검증 완료를 뜻하지 않는다.
