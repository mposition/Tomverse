---
status: approved_design_only
workId: CHAT-01
policyVersion: 1
approvedBy: mposition
approvedAt: 2026-10-01T10:39:06+10:00
approvedSpecCommit: cdc947a4eb33f33bd27d099e1d041bc478e702e2
approvedSpecSha256: a1ebccdbbe10c02725d73686235f379f51abd38f5cf8a6acd9e3ba294edbbfea
approvedScopes:
  - NUMERIC_SPEC_AND_COST_CEILING_DESIGN_ONLY
perRequestDesignCeilingMicroUsd: 29918
designCeilingProviderCostMicroUsd: 2393440
spendAuthority: none
implementationBlockedUntilFurtherApprovals: true
---

# CHAT-01 vNext 수치안·비용 상한 승인 기록

운영자 `mposition`은 위 commit과 SHA-256이 가리키는
[수치 spec 원본](prompt-refiner-quality-evaluation-vnext-numeric-spec-draft.md)의
**정확한 설계값과 비용 상한**을 승인했다. 승인 답변을 확인한 직후 이 기록을
작성했다. 원본 문서의 `PROPOSED · NOT APPROVED · NO DISPATCH` 머리글은 승인
전 바이트를 고정한 스냅샷이므로 수정하지 않는다. 승인 사실은 이 별도 기록이
증명하며, 원본의 SHA-256이 달라지면 이 승인을 재사용할 수 없다.

승인된 설계는 N=80(한국어·영어 각 40), 재작성 성공 최소 60/64, 안전 자제
16/16, p90 최대 6초·최대 지연 12초, 사람 감사 최대 8건, 독립 모델 judge
0건이다. 직접 Luna 경로의 요청당 최악 비용은 29,918 microUSD, 80-slot
provider 총상한은 2,393,440 microUSD(US$2.393440)다. 언어·셀·challenge
태그와 나머지 gate는 위 SHA-256의 원문에 결속된다. 이 승인은 *비용 계산의
설계 상한*이지 지출 authority가 아니다.

이 승인에는 새 holdout 작성·봉인, provider 호환성 유료 probe나 호출, 새로운
stage/run authority, DB 예약 consume, flag·변수 변경, 제품 연결·실사용 traffic,
PR 병합·배포가 포함되지 않는다. cache-write count의 무료 계약·관측 증거가
없으면 유료 80건 full run은 admission 거부 상태다. 정책이 요구하는 source
closure·manifest/root·접근·보존·정확한 배포와 stage/run 비용 승인·사람
disposition은 각 단계에서 별도로 결속해야 한다. 기존 정책에 명시된 동결
corpus/spec와 과거 run·판정·감사 기록은 이 승인으로 바뀌지 않는다.
