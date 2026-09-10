# Router development benchmark v1 독립 검토 인계

상태는 **`awaiting_review`**입니다. author는 `codex`, reviewer는 `claude`이며,
Claude의 실제 판정은 아직 없습니다. 내부 Codex 검토와 로컬 테스트 통과는
독립 검토 승인으로 기록하지 않았습니다.

- 소스 commit: `138bd4c60bd0534dbf131df5f7868fe9d1f623f4`
- 비교 base: `89288a8671ef25c30084b71f8a9266a3ae9f5475`
- round: `0`
- 검토 대상 전체 digest: `sha256:c5eae232832ac9cea55452bcd0425da493f7c65dd444f26a66fc3e0c21e9a345`
- [검토 prompt](review-prompt.md), [원래 task](../router-development-benchmark-v1.task.json),
  [변경 diff](change-round0.diff), [package](package-round0.json),
  [exchange](exchange.json)

`--mode=package`만 실행했습니다. 제어 프로그램이
`npm run test:router-development-benchmark`와 `check:encoding`,
`check:doc-references`, `check:policy-section-references`,
`check:router-quality-eval`을 실제 실행하여 모두 성공을 관측했습니다.
package의 출력은 기존 도구가 보존하는 마지막 몇 줄이며, 검토자가 직접
테스트를 실행했다는 뜻은 아닙니다. `checkFailures`는 빈 배열,
`reviewConclusion`은 null입니다.

Claude/Codex author·reviewer 실행기와 `preflight`, `review`, `live` 모드는
실행하지 않았습니다. `--skip-preflight`나 실패 검사 override를 승인하거나
사용하지 않았습니다. Claude CLI 검토를 시작할 권한 및 필요한 override는
별도 결정이며 이 파일이 대신하지 않습니다.

## 복사해서 전달할 검토 요청

```text
H:\Project\tomverse-router-benchmark-v1-20260910\docs\ops\cross-review\packages\router-development-benchmark-v1\review-prompt.md를 읽고 그 응답 형식을 따르십시오.

원래 요구사항과 diff를 먼저 읽고, 그 다음 테스트 기록과 작성자 설명을 읽으십시오. 읽기 전용 검토이며 파일 수정, commit, provider 호출, 배포는 금지합니다. 테스트 기록에서 관측한 사실과 직접 실행해서 관측한 사실을 구분하십시오. 재현 가능한 정확성·집계·정답 노출·provenance·실행 경계 문제만 구체적인 위치와 재현 방법으로 보고하십시오.

판정은 taskId router-development-benchmark-v1, round 0, source commit 138bd4c60bd0534dbf131df5f7868fe9d1f623f4, digest sha256:c5eae232832ac9cea55452bcd0425da493f7c65dd444f26a66fc3e0c21e9a345에만 적용됩니다. 다른 digest에 대한 판정은 재사용하지 마십시오. 실제 Claude 판정이 기록되기 전 exchange는 awaiting_review로 유지합니다. 이 요청 자체가 CLI 실행이나 preflight 생략을 승인하는 것은 아닙니다.
```

## 생성 경위와 남은 도구 제약

최초 package 시도에서는 PowerShell 실행 환경의 PATH에 `sh`가 없어 제어
프로그램의 테스트·guard 명령이 시작되지 못했습니다. 이후 Git에 포함된
`C:\Program Files\Git\bin\sh.exe`를 해당 package 실행 process의 PATH에만
추가했습니다. 전역 설정, 설치된 프로그램, 제어 코드와 writable scope는
바꾸지 않았습니다.

재생성 시 기존 출력 5개가 먼저 scope 밖 변경으로 거부되었습니다. 현재
package 도구는 outside-scope 검사를 출력 제외 처리보다 먼저 하므로,
`--diff-exclude`에 자기 출력 폴더를 지정해도 이 검사를 통과하지 못합니다.
실패한 최초 자료는 삭제하지 않고 아래 절대 경로로 폴더째 보관했습니다.

`H:\Project\router-benchmark-v1-initial-package-attempt-20260910`

보관한 자료는 실패한 첫 시도의 기록이며 최종 통과 증거가 아닙니다. 원래
출력 위치가 빈 상태에서 같은 미검토 round 0을 package 모드로 재생성하여
위 테스트·guard의 실제 성공 결과를 얻었습니다. 제외 경로는 이 package
출력 폴더 하나뿐이며, `generatedPaths`는 비어 있습니다.

현재 round 0의 review는 scoped diff digest를 대조하므로 package 기록을
별도 commit한 뒤에도 그 소스 변경을 검토할 수 있습니다. 다만 나중에
round 1을 package할 때에는 이미 기록된 출력 파일도 outside-scope 검사에
걸리는 기존 제약이 남습니다. 이번 작업은 그 제어 프로그램을 수정하지
않았으며, 후속 자동 수정·재검토 루프가 완전히 해결됐다고 주장하지 않습니다.
