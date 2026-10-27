# Android browser sign-in domain association

Android Auth Tab uses an HTTPS callback at `/auth/mobile/callback`. The browser
must verify the website-to-app association before returning the result to the
app. A missing or access-gated `/.well-known/assetlinks.json` prevents that check.

`public/.well-known/assetlinks.json` delegates link handling only to
`app.tomverse.shell`. It does not delegate stored sign-in credentials. The
Android manifest limits HTTPS link enrollment to the mobile auth callback.

The two public certificate fingerprints are:

- Google Play signing certificate: `8B:86:07:CF:60:7A:9C:81:C4:FE:13:86:49:5C:EE:13:D5:B8:3F:4E:A2:D2:7F:41:80:4A:20:8F:D3:F9:59:6E`.
  Verified against Play Console and the generated APK metadata for version code 4
  on 2026-10-27. This is the certificate used for the internal test release.
  Its version code is applied by the release build profile; the checked-in
  Gradle default is not the published bundle's version code.
- Direct-install release APK certificate: `0B:07:15:6B:5A:0F:47:ED:7E:F8:42:F6:21:FF:17:51:83:61:08:DC:4D:04:67:84:F8:80:B6:C4:22:5F:0F:FD`.
  Verified with `apksigner` on the signed release APK. Play calls it the upload
  certificate, but direct-install APKs are also signed with this key.

Deployment and domain association activation require owner approval. Each
enabled callback origin must serve this file anonymously with HTTP 200,
`application/json`, and no redirect. On staging, exempt only this file from
Cloudflare Access; the browser sign-in page can retain its existing Access
policy. Do not replace HTTPS verification with an unverified callback scheme.
After deployment, verify both certificate entries through Digital Asset Links
and retry browser sign-in on a physical device. Existing browser verification
caches may delay a successful retry.

References: [Chrome Auth Tab](https://developer.chrome.com/docs/android/custom-tabs/guide-auth-tab),
[Android website association](https://developer.android.com/training/app-links/verify-applinks).
