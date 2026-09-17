# Prompt Refiner admission-readiness evidence v1

이 디렉터리의 `admission-readiness-v1` 네 파일은 provider-free 합성 shadow의 고정
증거다. source commit은 `f1e1b0c23fd93cfa9dbaa0a68abe603d989c3830`, canonical bundle
digest는
`sha256:61d66909a0d493c9b0bfae5faaa3e79ad827a6cba8598f39167ecf506176a159`다.
검증 통과 시 생성되는 content-free proposal의 canonical digest는
`sha256:75198565b0bcc1e481c89c6ac8946d11793d28b7afbd96e18d36a03a27f06cc2`다.

- `*.report.json`: content-free aggregate
- `*.journal.jsonl`: append-only 실행 chain
- `*.journal.jsonl.witness.jsonl`: 별도 terminal registration chain
- `*.manifest.json`: 세 artifact의 filename·size·SHA-256과 source/corpus/terminal 결속

이 자료는 checked-in 합성 fixture 16개의 구조·parser 회귀만 증명한다. 실제 모델을
호출하지 않았고 provider call과 cost는 0이다. 모델 품질, paid shadow, PLANNER, release,
rollout 또는 제품 활성화의 승인이 아니며 stage 생성이나 실행 권한도 부여하지 않는다.
또한 이 bundle은 위 source commit에서 만든 **과거 snapshot**만 검증한다. 현재 checkout이나
실행 environment를 검증하지 않으며, 미래 writer는 승인 직전에 현재 source·manifest·
environment를 exact-byte 기준으로 다시 검증해야 한다.
