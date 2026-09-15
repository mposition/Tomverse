# Prompt Refiner offer gate mutation 증거

- 대상 source package: followup v2 round 1
- 대상 digest: `sha256:9e47a4e805fedb40508f8cd6f42ad801eabed35d07143b2d5ca2230054e2a003`
- 실행 환경: Windows, repository의 `next start` Playwright server
- 전제: 매 mutation 뒤 `npm run build`를 먼저 실행해 `.next`가 수정 source와 같게 함

## Mutation 1 — late-response guard 제거

`ChatPageClient.tsx`의 응답 처리에서
`requestSequence !== promptRefinerRequestSequenceRef.current`와
`requestScopeKey !== promptRefinerScopeKeyRef.current` 검사를 제거했다. 그 뒤 다음을
실행했다.

```text
npm run build
npm run test:e2e:run -- --project=desktop-chromium tests/e2e/prompt-refiner-chat-input.spec.ts --grep='late result'
```

결과는 실패였다. `prompt-refiner-ready` 예상 개수 0에 실제 1이 관측됐다. 즉 transport
abort를 무력화하고, 원문을 동일 문자열로 다시 채우고, fixture settlement marker를
기다리는 테스트는 sequence/scope guard가 없으면 stale 응답을 직접 검출한다.

## Mutation 2 — scope effect 제거

`promptRefinerScopeKey` 변경 시 `resetPromptRefinerFixture()`를 호출하는
`useLayoutEffect`를 제거했다. 동일하게 새 build 후 다음을 실행했다.

```text
npm run test:e2e:run -- --project=desktop-chromium tests/e2e/prompt-refiner-chat-input.spec.ts --grep='same draft'
```

결과는 실패였다. 다른 대화로 전환한 뒤 `prompt-refiner-ready` 예상 개수 0에 실제 1이
관측됐다. 두 대화의 draft는 같은 `한국어 원문 질문`이므로 문자열 비교가 이 실패를
대신 만들 수 없다.

두 방어선을 원본대로 복원하고 `npm run build` 후 같은 두 test를 함께 실행한 결과는
2/2 통과였다. mutation은 증거 수집 직후 복원됐으며 round 2 패키지는 복원된 source로
다시 build한 뒤 전체 검사를 실행한다.
