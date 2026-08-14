# Google 이미지 thinking 상한 실측 — 증거

- 결론과 서술: `.github/audits/image-model-verification-worksheet.md` §I
- 실행 계획과 단계별 판단: `.github/audits/google-image-thinking-cap-eval-2026-08-13.md`
- 검증: `npm run check:image-eval-evidence`

서술 문서는 **결론**이고 이 디렉터리는 **그 결론을 다시 계산할 수 있는 자료**다.
둘을 같은 것으로 취급하지 않는다 — 문장은 소리 없이 어긋나지만 숫자는 검사를
통과하지 못한다.

## 지금 여기 있는 것

`summary.json` — 실측 18표본(상한 512 · 256 · 4,096 · 2,048)의 정책 §12-8 대상
필드: 요청 상한, 모델 ID, 응답 ID, 실행 시각, usage 원문(input · output ·
thinking · total), status, 이미지 수, 이미지 modality 토큰.

`provenance: "transcribed_from_run_stdout"`. **이것은 전사(轉寫)이지 실행이 쓴
산출물이 아니다.** 스크립트가 낸 stdout을 그대로 옮긴 것이고, 원본은 실행자
장비의 `--out` 파일이다. 전사는 사람 손을 한 번 거치므로 원본보다 약한 증거이며,
`check:image-eval-evidence`가 그 사실을 매번 출력한다.

## 원본을 넣으면 강해진다

실행자 장비의 `--out` 파일 네 개를 이 디렉터리에 그대로 복사하면 된다.

```powershell
Copy-Item "$EvidenceDir\*.json" .github\audits\evidence\google-image-thinking-cap\
```

그 뒤 `npm run check:image-eval-evidence`가 하는 일이 달라진다.

- 각 원본의 **SHA-256을 출력**한다.
- `summary.json`의 모든 표본을 원본과 **필드 단위로 대조**한다. 응답 ID·토큰
  수·status·이미지 수가 하나라도 어긋나면 실패한다.
- 원본에 **API key 모양 문자열이나 digest가 아닌 프롬프트**가 있으면 실패한다.
  증거 디렉터리 자체가 유출 경로가 되지 않게 하는 것이 이 검사의 일이다.

원본을 넣기 전에 §5의 키 검사를 통과시킨다. 스크립트가 마스킹하지만, 마스킹이
잡는 것은 알고 있는 키 모양과 손에 쥔 키 값뿐이다.

## 검사가 실제로 하는 일

저장된 답과 비교하지 않고 **표본에서 결론을 다시 계산한다.**

1. 표본마다 `output + thinking = billable`, `billable + input = total`을 검산한다.
2. 상한을 넘긴 표본을 찾는다. 하나라도 있으면 결론은
   `limit_does_not_bound_billable_output`이다. 다수결도 추세도 아니다 — 검증
   대상 주장이 "상한이 과금 합계를 bound한다"이므로 반례 하나가 그것을 끝낸다.
3. 그 반례가 **완료되고 이미지를 실제로 전달했는지** 확인한다. 실패하면서 넘긴
   표본은 훨씬 약한 증거이고, §I의 결론은 완료된 표본 위에 서 있다.
4. output이 0인 표본들에 대해 `상한 − thinking`을 보고한다. 첫 두 실행이 긍정
   판정처럼 읽히므로, **측정 범위 안에서 일치했을 뿐 보편 상한이 아니라는 것**을
   숫자와 함께 남긴다.

`summary.json`을 표본이 뒷받침하지 않는 내용으로 고치면 검사가 실패한다.

## verdict 이름이 바뀐 것

스크립트의 판정 이름은 2026-08-14에 바뀌었다.

| 이전 | 현재 |
|---|---|
| `limit_does_not_bound_thinking` | `limit_does_not_bound_billable_output` |
| `consistent_with_limit_bounding_thinking` | `consistent_with_limit_bounding_billable_output` |

실측이 이유다. `max_output_tokens`는 256·512에서 thinking을 추적했고, 반증된
것은 **과금 대상 합계**에 대한 상한이다. 옛 이름은 thinking이 (관측 범위에서는)
bound된 실행에 대해 "thinking을 bound하지 않는다"고 보고했을 것이다.

**`summary.json`의 `verdictAsEmitted`는 옛 이름을 그대로 유지한다.** 실행 당시
스크립트가 실제로 낸 문자열이고, 기록을 나중 이름으로 고쳐 쓰면 그것은 더 이상
그 실행의 기록이 아니다.
