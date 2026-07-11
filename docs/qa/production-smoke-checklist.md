# Production Smoke Checklist

Run this checklist only after the full local release gate passes.

## Environment

- Production URL: `https://tomverse.app`
- Build/commit:
- Tester:
- Date:
- QA account:

## Smoke Checks

- [ ] Use only the dedicated QA account.
- [ ] Confirm OAuth callback remains on `https://tomverse.app`.
- [ ] Upload one image and one small valid PDF through R2.
- [ ] Send one short prompt to every enabled production model.
- [ ] Confirm provider errors show only a safe message and trace ID.
- [ ] Create a share URL and confirm the `https://tomverse.app/share/` origin.
- [ ] Confirm the share is read-only and `noindex`.
- [ ] Revoke the share and confirm it becomes unavailable.
- [ ] Lock a QA conversation and verify read/share/download enforcement.
- [ ] Confirm CSP, HSTS, `nosniff`, referrer, permissions, and frame headers.
- [ ] Delete QA conversations and uploaded QA objects.
- [ ] Record Blocker, High, Medium, and Low findings separately.

## Header Verification

Record the observed production response headers.

| Header | Expected result | Observed | Result |
|---|---|---|---|
| `Content-Security-Policy` | Enforced policy, no localhost report URL |  | Not run |
| `Strict-Transport-Security` | Present for HTTPS |  | Not run |
| `X-Content-Type-Options` | `nosniff` |  | Not run |
| `Referrer-Policy` | Restrictive policy present |  | Not run |
| `Permissions-Policy` | Present and restrictive |  | Not run |
| `X-Frame-Options` or `frame-ancestors` | Framing restricted |  | Not run |
| `X-Powered-By` | Not exposed |  | Not run |

## Provider Verification

Use a short, low-cost prompt for each enabled production model.

| Provider/model | Expected result | Result | Trace ID / evidence |
|---|---|---|---|
| OpenAI models | Response returns or safe provider error appears | Not run | - |
| Anthropic models | Response returns or safe provider error appears | Not run | - |
| Google models | Response returns or safe provider error appears | Not run | - |
| Groq models | Response returns or safe provider error appears | Not run | - |
| xAI/Grok models | Response returns or safe provider error appears | Not run | - |
| DeepSeek models | Response returns or safe provider error appears | Not run | - |
| Moonshot/Kimi models | Response returns or safe provider error appears | Not run | - |
| Qwen models | Response returns or safe provider error appears | Not run | - |
| Perplexity models | Response returns or safe provider error appears | Not run | - |

## Findings Summary

| Severity | Count | Launch rule | Notes |
|---|---:|---|---|
| Blocker | 0 | Must be 0 |  |
| High | 0 | Must be 0 |  |
| Medium | 0 | Fixed or explicitly accepted |  |
| Low | 0 | Triage before or after launch |  |

## Sign-Off

- QA owner:
- Engineering owner:
- Product owner:
- Launch decision: Not ready
- Notes:
