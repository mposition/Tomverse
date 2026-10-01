---
status: approved_implementation_only
approvedBy: mposition
approvalDate: 2026-10-01
approvedScope: OFFLINE_80_SLOT_EXECUTION_CONTRACT_AND_CACHE_WRITE_GUARD
numericSpecCommit: cdc947a4eb33f33bd27d099e1d041bc478e702e2
numericSpecSha256: a1ebccdbbe10c02725d73686235f379f51abd38f5cf8a6acd9e3ba294edbbfea
spendAuthority: none
dispatchAuthority: none
---

# Prompt Refiner vNext 실행 계약 구현 범위 기록

운영자 mposition은 2026-10-01 대화에서 비용 청구 없는 vNext 80슬롯 successor
실행 계약·cache-write 계측 guard의 구현과 Claude Code Max 구독 CLI 독립 검토를
승인했다. 이는 위 exact 수치 설계의 **코드 구현 범위** 승인이지 운영 실행
승인이 아니다. 정책 v1의 최초 오프라인 schema/parser/validator/tests 승인과는
별개의 후속 범위로 기록한다.

이번 범위는 계약 상수, 완전한 usage 및 가격 pin 검증, 삼분된 input 버킷의
보수적 비용 계산, 불완전·모순 관측의 fail-closed 처리와 무과금 테스트다.
stage와 run의 같은 US$2.393440 상한은 동일한 80슬롯의 **중첩 경계**이며
합산 지출 US$4.786880을 허용하는 별도 예산 두 개가 아니다.
구현은 provider·DB·route·제품 호출 경로에 연결하지 않고
`executionAdmitted=false` 및 `reservationReleaseAuthorized=false`를 유지한다.
기존 v1 stage/run 및 v6의 13/16 FAIL은 바꾸지 않는다.

새 holdout 작성, provider 요청, stage/run 승인·실행, durable reservation consume,
운영 가격 승인, flag/변수 변경, PR 병합·배포, 제품 UI·Router 또는 실제 사용자
traffic 연결은 이 기록으로 허용되지 않는다. 후속에는 봉인 manifest/source
closure와 exact 앱 배포·가격의 검증, 서버 소유 durable reservation authority,
별도 owner stage/run 비용 승인이 각각 필요하다.
그보다 먼저 provider가 cache-write count를 미사용 시 명시 정수 `0`을 포함해
보고한다는 **무료 계약·관측 증거**가 있어야 한다. 이 오프라인 guard의 비용값은
잠긴 요율로 계산한 보수적 상한이며 실제 provider invoice 대조가 아니다;
invoice 대조는 실행 후 별도 정산 절차다. 증거가 없으면 유료 80건 full run을
거부하고, 호환성 유료 probe도 별도 exact 승인 없이 실행하지 않는다.
