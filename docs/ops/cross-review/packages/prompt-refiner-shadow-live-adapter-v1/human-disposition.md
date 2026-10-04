# Prompt Refiner shadow live adapter v1 사람 disposition

- 결정일: 2026-09-20
- 결정자: `mposition`
- 대상 exchange: `prompt-refiner-shadow-live-adapter-v1`
- 마지막 검토 digest: `sha256:d4911de0427db084f06ef00fb3cf774ddf4f81a342f2a8b8cacd0c1e1302694d`
- Claude 결론: **approve**
- 제어 상태: `on_hold (revisions_exhausted)`
- 결정: **남은 nit을 exchange 밖에서 수정하고 통합 진행**

`exchange.json`과 round별 package·verdict는 수정하지 않는다. 이 상태는 독립 검토의
최대 두 번 수정 상한이 소진됐다는 사실을 보존한다. 사용자는 마지막 검토가 남긴 두
nit을 exchange 밖에서 수정하고, 종료 기록을 그대로 둔 채 push·PR·통합 CI를 진행하는
권장안을 승인했다.

## 마지막 두 finding의 처리

후속 commit `2c0f0ecd422a46da5532684d415817f25935eac5`에서 다음을 수정했다.

1. 정적 provider import 검사에 `import "ai";`와
   `import "@/lib/activeAiModel";` 같은 side-effect 형식을 포함하고, dynamic import는
   허용되는 경계로 유지했다.
2. AI SDK timeout의 실제 형태인 `DOMException(..., "TimeoutError")`를 `timeout`으로
   분류하고 회귀 테스트를 추가했다. 이 분류와 `unknown_after_dispatch`는 모두
   재시도하지 않는 닫힌 결과이지만 운영 진단 정확성을 높인다.

후속 변경 뒤 `test:prompt-refiner-shadow-live-adapter` 23/23, typecheck와 대상 eslint가
통과했다. 통합 전에는 전체 package test·guard와 required CI를 다시 실행한다.

통합 전 전체 Prompt Refiner 회귀는 run contract가 admission verifier를 직접 import하면
기존 pure-core 경계를 깨뜨린다는 사실도 발견했다. 그래서 provider-free shadow harness가
corpus digest의 순수 정본을 export하고 run contract가 그 값을 사용하도록 좁게 수정했다.
기존 admission 상수와의 일치는 테스트로 고정하며 admission core의 허용 caller 집합은
확장하지 않았다. 이는 실행 권한이나 새 entry point를 추가하는 변경이 아니다.

## 승인하지 않은 것

이 결정은 실제 Prompt Refiner provider 호출, stage/reservation 생성 또는 소비, 유료
shadow, 제품·관리자 entry point, durable run/receipt writer, flag·Router·UI 연결,
품질·비용·rollout gate 통과를 승인하지 않는다. adapter와 one-run 계약은 계속
`durableRunWriterReady=false`, `entryPointReady=false`, `executionAdmitted=false`,
`productAdapterReady=false`다.
