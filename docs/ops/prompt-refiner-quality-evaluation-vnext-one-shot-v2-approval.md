---
status: approved_implementation_only
workId: CHAT-01
policyVersion: 2
approvedBy: mposition
approvalDate: 2026-10-01
approvedPolicyCommit: 4f215bfcc3b9d3b0098303d333d1dd7fea19f30e
approvedPolicySha256: dacdaab3360b7d848ea622bf83cc6a49c519c8a2f50ed1bc2d8b34a9a5b5ef7b
approvedScope: ONE_SHOT_OPERATOR_MANAGED_HOLDOUT_GATE_FREE_IMPLEMENTATION
spendAuthority: none
dispatchAuthority: none
productConnectionAuthority: none
---

# CHAT-01 단회 운영자 평가 정책·무료 구현 승인 기록

운영자 `mposition`은 위 commit과 SHA-256이 가리키는
[정책 v2 원본](../policy/prompt-refiner-quality-evaluation-vnext-one-shot-v2.md)의
한시적 공식 합성 품질 게이트와 원문 없는 runner·서버 결속 코드, 합성 테스트,
Claude Code Max 구독 CLI 독립 검토를 정확한 범위로 승인했다. 원본의 `draft`와
`implementationBlockedUntilApproved`는 승인 전 스냅샷의 바이트를 보존하기
위해 수정하지 않는다. 이 별도 기록이 해당 스냅샷에 대한 승인 사실을 결속한다.

기존 N=80·ko/en 각 40과 모든 수치 문턱, v1 source closure·corpus, 과거 v3–v6
실행·판정은 바뀌지 않는다. 특히 v6의 13/16 FAIL은 그대로다. 실제 holdout
작성·보관·봉인, 유료 provider 호출, stage/run 승인·실행, durable reservation
consume, flag·변수 변경, PR 병합·배포, 제품 UI·Router·실사용 traffic 연결은
이 승인에 포함되지 않는다. 이 승인으로 구현한 코드는 별도의 exact 운영
승인과 필수 증거가 들어오기 전까지 fail-closed 상태를 유지한다.
