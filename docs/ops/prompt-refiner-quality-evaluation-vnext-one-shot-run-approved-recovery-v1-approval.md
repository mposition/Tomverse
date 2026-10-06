---
status: approved_implementation_only
workId: CHAT-01
policyVersion: 1
approvedBy: mposition
approvalDate: 2026-10-05
approvedPolicyCommit: 75bc6778b6cde6be383f4ee60fca535acd87e8ef
approvedPolicySha256: 740c83d053a13b19cdb3fbcfd39c8948d6c9f40888768607c2f3528c6d7122e2
approvedScope: ONE_SHOT_B06_RUN_APPROVED_ZERO_CONSUMPTION_RECOVERY_IMPLEMENTATION
spendAuthority: none
dispatchAuthority: none
---

# CHAT-01 B06 run-approved 회복 정책 승인 기록

운영자 `mposition`은 2026-10-05에 위 commit과 SHA-256이 가리키는
[정책 원본](../policy/prompt-refiner-quality-evaluation-vnext-one-shot-run-approved-recovery-v1.md)을
정확한 버전으로 승인했다. 원본의 `draft`와 승인 필드는 승인 전 바이트를
보존하기 위해 수정하지 않는다. 검토 서버의 독립 검토
`r-20261005-111043-6493ec`은 서로 다른 공급사의 두 검토자에게서 `accept`를
받았다.

이 승인은 이미 run 승인된 v2를 소비 0건인 상태에서 한 번만 닫고, 같은
후보·root·runner·가격을 새 배포의 v3와 80개 새 예약에 결속하는 코드와
합성 테스트를 구현할 근거다. 유료 슬롯 경로는 별도 hash-chained 유료 승인
감사가 없으면 거부한다. 슬롯 경로의 shadow 감사 검증은 A17 서명 증거의
명시적 정수 `cacheWriteInputTokens: 0`과 정확한 v3 결속을 확인한다. B06 완료
readback은 이 검증에 더해 유료 승인 감사 부재와 dispatch 차단을 확인한다.

PR 병합, 새 배포, v3 stage·run, shadow POST, 유료 호출과 슬롯 소비는 이
승인에 포함되지 않는다. 실제 holdout 원문·정답·rubric·반례는 Codex나
공개 산출물에 전달하지 않는다.
