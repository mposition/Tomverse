---
status: approved_policy_not_activated
workId: CHAT-01
policyVersion: 1
approvedBy: mposition
approvedAt: 2026-10-09
approvedPolicyCommit: 75fbeade2a54a863bf94292a75935edf2df59418
approvedPolicySha256: 6080eada4a66d5e9f45b07d6ae9314252119e68d0eb0269e1513a7bfd776c8a3
approvedScope: PROMPT_REFINER_VNEXT_FULL_USER_AUTO_RELEASE_EXCEPTION
productActivationAuthority: none
paidDispatchAuthority: none_until_activation_conditions_pass
---

# CHAT-01 전면 Auto 출시 예외 정책 승인 기록

운영자 `mposition`은 2026-10-09에 위 commit과 SHA-256의
[전면 Auto 출시 예외 v1](../policy/prompt-refiner-vnext-full-auto-release-exception-v1.md)을
승인했다. 정책 원본의 `proposed_exact_approval_pending`·`approvedBy: null`은
승인 전 스냅샷 바이트로 보존한다. 이 기록이 **정확한 그 바이트**의 승인 사실을
결속한다. 범위는 기존 Chat Auto 이용 자격이 있는 전체 사용자에게 Refiner 제안을
자동 적용하는 출시 예외이며, 운영 상한은 US$100/일·US$3,000/월이다.

이 승인은 기존 B08의 최대 지연 12,599ms를 승인 당시 기준 12,000ms의 `pass`로
소급 변경하지 않는다. 지연 외 항목과 제한 감사가 이상 없다는 운영자 확인은
별도의 내용 없는 공식 gate·감사 receipt를 대체하지 않는다. 그 증거, 후보·가격·
배포 결속, 제품 어댑터와 default-off 서버 gate, 비용 예약·원문 fallback·kill
switch의 구현과 검증, 기존 명시적 채택 UI 계약의 Auto 전용 예외 개정 및 정확한
활성 배포에 대한 운영자 확인이 모두 끝나기 전에는 제품 flag, 실사용 자동 적용,
추가 유료 provider 호출을 허용하지 않는다.

승인된 단회 평가 v2와 수치 계약, 과거 실행·감사 기록은 불변이다. 이 승인 기록
자체는 PR 병합·배포 또는 전체 CHAT-01 완료의 증거가 아니다.
