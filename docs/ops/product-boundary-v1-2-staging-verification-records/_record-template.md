---
record: staging-verification
checklist: docs/ops/product-boundary-v1-2-staging-checklist.md
templateRevision: 2026-08-23a
environment:
deploySha:
startedAtUtc:
completedAtUtc:
executor:
approver:
result:
frozen: false
digest:
---

# 제품 경계 v1.2 staging 검증 실행 — <날짜> / <deploy SHA>

## 실행 환경

| 항목 | 값 |
|---|---|
| 환경 | staging / production / 기타 |
| 배포 SHA (전체 40자리) | |
| production SHA와 동일한가 | |
| template revision | 2026-08-23a |
| 시작 (UTC) | |
| 종료 (UTC) | |
| 실행자 | |
| `TOMVERSE_AUTO_ROUTER_UI_ENABLED` (시작 시점) | |
| `ROUTING_DISPATCH_INSTRUMENTATION` (staging) | |
| `PRODUCT_KEY_READ_MODE` (설정돼 있다면) | |

flag를 켠 채로 실행했다면 그 사실을 여기 적습니다 — 기록 README 9번.

## 결과

체크리스트의 A–D 구획을 그대로 옮기고, 각 항목에 **관측**과 **판정**을 적습니다.
실행하지 않은 항목은 `미기록`입니다.

## 배포 전 선행

| 항목 | 관측 | 판정 |
|---|---|---|
| P-1 Search Console 28·90일 기준값 | 저장 위치 · 시각: | |

숫자는 적지 않습니다(기록 README 8번). P-1은 staging 구획이 아니라 순서의
문제이므로 letter가 없습니다.

## A. 마이그레이션 안전성

| 항목 | 관측 | 판정 |
|---|---|---|
| A-1 `ROUTING_DISPATCH_INSTRUMENTATION` (production) | | |
| A-1 `RoutingRun` 행 수 (production) | | |
| A-1 평소 분당 턴 수 | | |
| A-1 결론 — 그대로 배포 / 마이그레이션 분리 | | |
| A-2 `conversation_product_key_expand` 소요 | | |
| A-2 `routing_run_product_attribution` 소요 | | |
| A-2 제약 3종이 `convalidated = false` | | |

A-1의 결론이 "분리"라면 **이 회차는 여기서 멈춥니다.** 코드가 바뀌어야 하고,
바뀐 코드는 새 SHA이며 새 기록입니다.

## B. 대화 경로

| 항목 | 관측 | 판정 | 크레딧 |
|---|---|---|---|
| B-1 새 대화의 `productKey` | | | 0 |
| B-2 배포 이전 대화가 열림 · `offered=false` | | | 0 |
| B-3 턴이 답함 · Auto 배지 없음 | | | |
| B-3 `RoutingRun.conversationId` 기록됨 | | | |

B-3의 `productKey`는 backfill 전이므로 `NULL`이 정상입니다.

## C. 회수되지 않는 표면

| 항목 | 관측 | 판정 |
|---|---|---|
| C-1 welcome 메일 수신 · 옛 이름 없음 | | |
| C-2 Checkout line item 이름 | | |
| C-2 billing welcome 메일 | | |

## D. 선택

| 항목 | 관측 | 판정 | 크레딧 |
|---|---|---|---|
| D-1 이미지 대화 `productKey='studio'` | | | |
| D-2 게스트 이관 `productKey='review'` | | | 0 |
| D-3 공유 페이지 표기 | | | 0 |
| D-4 export 헤더 표기 | | | 0 |
| D-5 `/review` 200 · noindex | | | 0 |
| D-6 backfill dry-run 추출 건수 | | | 0 |

실행하지 않은 항목은 `미기록`입니다.

## 크레딧 합계

| | |
|---|---|
| 유료 turn 수 | |
| 소비 크레딧 | |

## 정리

| 만든 것 | 지웠는가 |
|---|---|
| 계정 | |
| 대화 | |
| 이미지 | |
| 공유 링크 | |

남긴 것이 있으면 무엇을 왜 남겼는지 적습니다 — 다음 회차 B-2의 전제입니다.

## 판정과 서명

**사람만 씁니다.**

| | |
|---|---|
| 판정 (통과 / 조건부 / 실패) | |
| 조건부·실패라면 무엇이 | |
| 서명 | |
| 서명 일시 (UTC) | |
