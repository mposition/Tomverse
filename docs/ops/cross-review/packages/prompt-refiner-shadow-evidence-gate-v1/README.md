# Prompt Refiner shadow evidence gate v1 독립 검토

이 디렉터리는 commit `985d331ce102778a06adb149831cf0796786e46d`까지의
Prompt Refiner shadow evidence gate v1 패키지와 Claude Code Max 읽기 전용
판정을 보존한다. 검토 직전마다 `ANTHROPIC_API_KEY`와
`ANTHROPIC_AUTH_TOKEN`을 제거하고 `claude.ai` first-party Max 구독 인증을
확인했다. Anthropic API key는 사용하지 않았다.

## 결과

- round 0 digest: `sha256:84b96e722ed3296e4b9171667479130ead4e60ce402e74aee67832afd3aed530`
- round 1 digest: `sha256:b1b7c84dc63d80c1c48cb6b7a862e67bf83a312e6afbe6df0faedd5be780de78`
- round 2 digest: `sha256:467dd791e14c12d7887baef4410987aaec37c7368ff2d115e60808e023e6e1d9`
- 각 round의 전체 unit과 guard: 모두 통과
- 최종 reviewer 결론: `approve`
- control program 상태: `on_hold (revisions_exhausted)`

round 0의 corpus digest 결속, fail/insufficient 우선순위, v3 실행 수치 출처
3건은 round 1에서 닫혔다. round 1의 injection failed/incomplete 표현과 공유
길이 밴드 한계 2건은 round 2에서 닫혔다. round 2는 새 nit 2건을 남겼다:
unknown-only case의 일반 reason 이름도 `failed`와 `incomplete`로 분리할 것,
spec duplicate-key 테스트가 실제 duplicate parser branch를 실행하도록 할 것.

두 건은 재현 가능하므로 `approve` 문구만으로 통합하지 않는다. 원본 verdict와
`on_hold` 상태를 그대로 보존하고, 사용자 승인에 따라 후속 task에서 수정·재검토한다.
이 기록은 provider 호출, 제품 UI, Router 결합, paid run 또는 rollout을 승인하지 않는다.
