---
status: approved_implementation_only
workId: CHAT-01
policyVersion: 1
approvedBy: mposition
approvedAt: 2026-10-06
approvedPolicyCommit: 90e971fd41eeb5c2f6f6828e3dedb5d13ddd30e4
approvedPolicySha256: c1b0b777d384da93a2c07d33b066ded4b2a3007b3ded213851c61e27a90295c1
approvedScope: ONE_SHOT_B03O_TERMINAL_DEPLOYMENT_RECOVERY_IMPLEMENTATION
spendAuthority: none
dispatchAuthority: none
---

# CHAT-01 B03O terminal 배포 회복 정책 승인 기록

운영자 `mposition`은 2026-10-06에 위 commit과 파일 SHA-256으로 제시된
[정책 원본](../policy/prompt-refiner-quality-evaluation-vnext-one-shot-terminal-recovery-v1.md)의
구현 범위를 이 세션에서 승인했다. 대화에 초 단위 승인 시각은 없으므로 날짜
정밀도만 기록한다. 정책 원본의 승인 전 바이트와 `draft` frontmatter는 보존한다.

이 승인은 B03O terminal receipt를 포함한 새 앱 배포 때문에 기존 v3의
deployment와 runner 결속을 재사용할 수 없을 때, 소비 0건인 v3를 감사·슬롯
이력과 함께 보존하고 v4 한 번만 만드는 코드·migration·합성 테스트의 근거다.
별도 독립 검토가 필요하다. 새 PR 병합·배포·v4 stage·run·shadow·유료 승인 및
B07 provider 호출은 이 기록의 효력이 아니다.

실제 holdout 원문·정답·rubric·반례는 Codex나 공개 산출물에 전달하지 않는다.
