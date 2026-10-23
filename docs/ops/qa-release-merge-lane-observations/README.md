# QA·릴리스 병합 레인 관측 기록

`npm run qa-release:lane-observe -- observe`가 남기는 기록입니다(정책 `docs/policy/qa-release-agent.md` 8절 7·9·10항,
절차 `docs/ops/qa-release-merge-lane-s-m1.md`). 파일 하나가 관측 한 회입니다.

- **관측 직전에 읽은 develop·main의 보호**가 함께 기록됩니다. 그 보호가 나중에 바뀌면 그 기록은 효력을 잃고,
  `npm run qa-release:lane-rulesets`는 그 기록으로 실제 ruleset을 걸지 않습니다.
- 기록에는 GitHub의 HTTP 상태와 오류 메시지만 있고 토큰·키·header는 없습니다.
- 기록은 손으로 고치지 않습니다. 다시 관측하면 새 파일이 생깁니다.
