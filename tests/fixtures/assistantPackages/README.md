# Assistant package fixtures

`docs/policy/assistant-package-import.md` §5.

이 디렉터리에는 **실제로 배포된 Agent Skill 패키지 하나**가 들어 있습니다. 나머지
경우 — 경로 탈출, symlink, 암호화 entry, 중복 이름, 압축 폭탄, 크기 불일치, native
manifest의 모든 거절 분기 — 는 `tests/support/zipArchive.mjs`가 test 안에서 바이트
단위로 만듭니다. 정상 경로만 진짜 파일로 확인하고 거절 경로는 손으로 만든 바이트로
확인하는 것은 `tests/fixtures/legacyOffice/`가 이미 쓰는 방식입니다.

## `webapp-testing.skill.zip`

| 항목 | 값 |
|---|---|
| 출처 | `https://github.com/anthropics/skills` |
| commit | `3b3fad96af16a10759d930941b4520ba0c40edae` |
| 경로 | `skills/webapp-testing/` |
| 라이선스 | Apache License 2.0 (`LICENSE.txt`가 아카이브 안에 그대로 들어 있음) |
| 내려받은 날짜 | 2026-08-23 (UTC) |
| zip SHA-256 | `ab7dfc8c202805bdd277225e4704b760bdfde2e5a9011fb89a0ad0d09e27216f` |

아카이브는 위 경로의 파일 6개를 이름순으로 정렬해 고정된 timestamp로 다시 압축한
것입니다. 원본 저장소의 zip이 아니라 이 저장소가 만든 zip이므로, 같은 입력에서 항상
같은 바이트가 나옵니다 — 그래야 위의 SHA-256이 의미를 갖습니다.

원본 파일의 SHA-256 앞 16자리:

```
bc6b3af2f331cbc7  LICENSE.txt
51b7349e77ec63b7  SKILL.md
ea46877289acb82d  examples/console_logging.py
d63c89604a22f884  examples/element_discovery.py
9d533aafb875ee3a  examples/static_html_automation.py
b0dcf4918935b795  scripts/with_server.py
```

### 이 패키지의 script는 실행된 적이 없고 실행될 수도 없습니다

`.py` 파일 4개는 압축을 푼 적조차 없습니다. parser는 중앙 디렉터리에서 확장자를
보고 `executable_script`로 건너뛰므로, 그 entry의 바이트는 inflate 대상에 들어가지
않습니다. "풀었지만 무시했다"가 아니라 **읽지 않았다**는 것이 §1.1이 요구하는
형태이고, `tests/assistantPackageArchive.test.mjs`가 이를 고정합니다.

이 fixture를 만들 때도 실행하지 않았습니다. `git clone` 후 파일을 그대로 압축했을
뿐이며, `pip install`·`python`·`playwright` 중 어느 것도 돌리지 않았습니다.

### 정답지

`webapp-testing.expected.json`이 이 패키지에서 나와야 하는 결과입니다. 사람이 답을
판정할 근거 없이 판정하게 두지 않으려고 같이 둡니다 — 무엇이 instructions가 되고,
무엇이 knowledge 후보가 되고, 무엇이 어떤 사유로 빠지는지가 전부 적혀 있습니다.

정답지의 첫 초안은 구현이 만들었습니다. 그대로 두면 "구현이 자기 출력과 같다"는
것밖에 증명하지 못하므로, 모든 항목을 원본에서 **따로 계산해 대조했습니다.**

- `instructionsLength` 3574와 `instructionsHead` — SKILL.md에서 frontmatter를 떼고
  trim 한 길이를 파서와 무관한 script로 다시 셌습니다.
- `LICENSE.txt` digest — 위의 `sha256sum` 값과 같은 값입니다.
- `instructionUrls` — SKILL.md 전체에서 URL을 정규식으로 다시 뽑아 `http://localhost:5173`
  하나임을 확인했고, 정답지의 host가 port를 뗀 `localhost`임을 확인했습니다.
- 건너뛴 4건 — 아카이브의 `.py` 파일 목록과 일치합니다.

`instructions`는 길이와 앞부분만 적습니다. 전문을 복사하면 upstream이 SKILL.md를
고칠 때마다 정답지가 조용히 틀려지고, 그때 실패하는 것은 이 저장소의 코드가 아니라
정답지입니다.

### 갱신할 때

upstream이 이 skill을 바꾸면 fixture는 **자동으로 따라가지 않습니다.** 다시 만들려면
같은 경로를 clone 해서 다시 압축하고, 위의 commit·SHA-256·정답지를 함께 고칩니다.
셋 중 하나만 고치면 나머지 둘이 무엇을 말하는지 알 수 없게 됩니다.
