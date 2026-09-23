/**
 * The digest of every approved string, pinned.
 *
 * Contract: docs/policy/email-consent-copy-draft.md section 9.
 *
 * ## Why a second list of hashes exists
 *
 * Because the first guard was not one. `tests/emailConsentCopy.test.mjs` asked
 * whether each string in the code appears in the approved document -- and an
 * editor who changed both, as anybody fixing wording naturally would, left it
 * green. The version name stayed `2026-09-23`, so
 * `consentCopy(key, language, "2026-09-23")` began answering with the new
 * sentence as though it had been on the screen all along, and every
 * `copyHash` already stored against that version resolved to nothing.
 *
 * That is precisely the failure section 9 forbids, and nothing in CI could
 * see it. A pinned digest can: changing an approved byte changes the digest,
 * and the test that compares them fails with the key and language that moved.
 *
 * ## Changing this file
 *
 * You do not, for a version that already exists. A wording change adds a new
 * version to `CONSENT_COPY_VERSIONS` and its digests here, and the old rows
 * stay exactly as they are, for as long as any consent points at them.
 */

export const CONSENT_COPY_DIGESTS: Readonly<Record<string, string>> =
  Object.freeze({
    "2026-09-23/signupOptIn/ko":
      "sha256:352b10442cb6e690dc1b416991ee4eb63935904422cd77332a102f1cd9e04008",
    "2026-09-23/signupOptIn/en":
      "sha256:ead87b5adcc1869a69fdd2834b79b2f50fbddb039c5cbba67ee3561e236c92d3",
    "2026-09-23/signupOptIn/de":
      "sha256:74584a4c47df446727379e5de59185634a54ad3880c5cea1a780dde91b8535cb",
    "2026-09-23/signupOptIn/es":
      "sha256:b7d65c4d7a6c1c103bcfe1d46d4e2be10c47860a98bbf11b2eec772995f842d8",
    "2026-09-23/signupOptIn/fr":
      "sha256:841238fc0fd8826b029a13632eac68a118e5e898c080f01a5362b8aeb99d5e5f",
    "2026-09-23/signupOptIn/pt":
      "sha256:8fd9b47a819b6476ee022f7ef43551814852b7d5d7d14fb0e8778ff37b5532a5",
    "2026-09-23/signupOptIn/zh":
      "sha256:e4cd6f5b40a1b40142050fec14ca5629e77e513bdaa4a2389c8080e754704a05",
    "2026-09-23/signupNotice/ko":
      "sha256:65809c622d125c8e43e84e9441c884ace528f35a671276c8122d9d50477590b3",
    "2026-09-23/signupNotice/en":
      "sha256:34a4d153e9f1310dd6dec614d7fe957dace366d38d8d6418021b2b66eb39f06b",
    "2026-09-23/signupNotice/de":
      "sha256:0145d7ed8a336cd69eefa447b979d2061e073c220b4f15307fe8e5ad7e647dc1",
    "2026-09-23/signupNotice/es":
      "sha256:5217fd2dbaed99e12a5212e43f47115907916b0dcc292445efea3c37b624a504",
    "2026-09-23/signupNotice/fr":
      "sha256:a5f84116d70053b769438e518dcd9c49139fa8905d7947cb4d725d2451b65442",
    "2026-09-23/signupNotice/pt":
      "sha256:b34bc8e2b0f0d6d260721a5e1f51f2c098b2f09b5ea94436b9b1d51efae7b4ef",
    "2026-09-23/signupNotice/zh":
      "sha256:10b403a2e3d416a9d1d80dab7ac4a11b2ade9812ab0f73024b926f878027cd8e",
    "2026-09-23/signupRefuse/ko":
      "sha256:6c917cc200cc76b66571655c4a6ebe2ae141fe123e7b0a4049be060cd3a66484",
    "2026-09-23/signupRefuse/en":
      "sha256:ed2e9f12f6b7c4f0ae5b141ef0f5fc3cec4fde052e0c0954eb2587a7e2d23800",
    "2026-09-23/signupRefuse/de":
      "sha256:8dfdeca2ef95a022f7fe5b4e49cbb357bd4402ac1cb2be83ee544bd6aced4a83",
    "2026-09-23/signupRefuse/es":
      "sha256:ddf812035fbf987ac8427b2a5454c92ada25c845bbc19b703add319eff979d38",
    "2026-09-23/signupRefuse/fr":
      "sha256:d97c87085c52373f60dd6b86a549ad2620d0c2fddb64fdcfb62e3263a7626c0a",
    "2026-09-23/signupRefuse/pt":
      "sha256:4e357534155615c67e721af89031f08566528f9ebb57adf5b998f7d2ba3f72f8",
    "2026-09-23/signupRefuse/zh":
      "sha256:402f5521806555c77d8e9a9b4322abf7c74a1bb970129456bf4e0c38e0197465",
    "2026-09-23/noticeTitle/ko":
      "sha256:7573245fb51bf7670cd40af45dab15a5daec45ff370454497e5a296462d12745",
    "2026-09-23/noticeTitle/en":
      "sha256:d1a4b616dc7b4f9ee9bd7bf18e20fd70ce45d49dc3f18d02b62d3d7e78402558",
    "2026-09-23/noticeTitle/de":
      "sha256:bdeb59fa94a78c01d6c65e6a836dd6b77301cb5058bea603ab47bb1dd3b857d0",
    "2026-09-23/noticeTitle/es":
      "sha256:1c9d2c9819cd16436e7f0c8ade6c9756778d99dc257e08da99e5beef93ad7839",
    "2026-09-23/noticeTitle/fr":
      "sha256:8cb0e58fc811acfe0d06a1cc6c8dafa71a1583609c07cac156ac5ff81bf4842b",
    "2026-09-23/noticeTitle/pt":
      "sha256:9a01a5ea6e9443275c88353b91dbe8e1bab5c994b7b123d2355c4cc2799b7ffe",
    "2026-09-23/noticeTitle/zh":
      "sha256:b09cf842b81b272dcc930d3e9fc7f010d7d467d18fbfaf631bdf04c5daac7147",
    "2026-09-23/noticeBody/ko":
      "sha256:24c205ce97c3ca29f0d7bf744db35c8cee1d5d3deaecc05dc9c11429ef6c867b",
    "2026-09-23/noticeBody/en":
      "sha256:8d8837386969053337277c65e74db2bba1dc537da6a9a197d027be4ef43e40fa",
    "2026-09-23/noticeBody/de":
      "sha256:2ed53507dece5b949110cf733d6355f9f97a7468ed15aec9f8a7cbf47c8d075d",
    "2026-09-23/noticeBody/es":
      "sha256:ead0ef26b9ccb105c58d14f358ae37caffd968ce944c69534497455220f1eb4b",
    "2026-09-23/noticeBody/fr":
      "sha256:432f47e6ca1e30f19e86d0d046105fd46f57ed3faf14d64c14c23b0f3d2ecb95",
    "2026-09-23/noticeBody/pt":
      "sha256:ef253a8073602c3d906ce80864e8b8e68be7c06d765a6488f702247ffe2b3082",
    "2026-09-23/noticeBody/zh":
      "sha256:11b83cf360175242fcf8760579b6ed45770c59fee5f33298399ff0868ad98099",
    "2026-09-23/noticeAccept/ko":
      "sha256:f3dc2d4849b8ea206313cb81b7e314f1c6972457dc8dfeefe64df2410ee9a37a",
    "2026-09-23/noticeAccept/en":
      "sha256:78ace78b76f8279dfbf957087c61dd176467305fb2379fab42b87fa0bfcf2fe1",
    "2026-09-23/noticeAccept/de":
      "sha256:9353c2bcb2988ec7397158de0624fb098a8bb3188ab7be40e5808f74afa806e4",
    "2026-09-23/noticeAccept/es":
      "sha256:b30bc8366cb4f3bfba5e40eb2b5cb0dcf656bcf921719502941f62857a1280bf",
    "2026-09-23/noticeAccept/fr":
      "sha256:84f0154be78a502163bb58701f93f103a2d8ac993057c82b2011773bb4563329",
    "2026-09-23/noticeAccept/pt":
      "sha256:e8eb6a31846fcd1c22186b776351e4e512fd5ed80d67abdd9b29889eddcd2c0f",
    "2026-09-23/noticeAccept/zh":
      "sha256:aeb595b9e34c4a7e351291d37e2010e968221cbcc9a9d5f6f1ab2e9a792b99ad",
    "2026-09-23/noticeRefuse/ko":
      "sha256:660ee1cd6c39a4673f0e6ac709405aece1ac8cbf00f196408125c4e86ab72d8b",
    "2026-09-23/noticeRefuse/en":
      "sha256:9da885af3bbf1a37dfea465b7f5f5c941ed72c1d9444b046287247e067397b9b",
    "2026-09-23/noticeRefuse/de":
      "sha256:489936c2f99c8b5d3c8863b8a5a2b20f3210bdd460833d3c374cd3616439c532",
    "2026-09-23/noticeRefuse/es":
      "sha256:e8baf8903b65d43fae47b8b1bb33eac7c3fc732618a93a3037012605903ac9d4",
    "2026-09-23/noticeRefuse/fr":
      "sha256:e4e545b022b0a8676cfe4689bf55ce29b2127ec6114561df0c9312fdf85b5a54",
    "2026-09-23/noticeRefuse/pt":
      "sha256:83015e24b5e94b4a323056407ca1270b4ac61b2bb9f7cdaaf8ec7e1a359896f7",
    "2026-09-23/noticeRefuse/zh":
      "sha256:f31fbd1401fe48d423494fbe0c4fa03e0eeaa3dfa57ec183b0e4ced857f62ca0",
    "2026-09-23/noticeDismiss/ko":
      "sha256:e215db0f80ddf4cc3cf1a9309d2cf5205bbf04b11082545e164c0ee7ff85ccbb",
    "2026-09-23/noticeDismiss/en":
      "sha256:48d3887ac27da8f341beb9524e0a9f393eec45c04767890d0d4c808df3f77a2f",
    "2026-09-23/noticeDismiss/de":
      "sha256:b13e668452bc10fa02511bf23ce3b06d7596087051e3d68614c41194b8af3a81",
    "2026-09-23/noticeDismiss/es":
      "sha256:ec6b44414fd031f0ec4c7108fa51ec5f7b9c1afa019057d603f1c050b3d7977c",
    "2026-09-23/noticeDismiss/fr":
      "sha256:6bce480cf5404fb63266ce3839c1c85977618baf8e9d98ee9da213c934b0395f",
    "2026-09-23/noticeDismiss/pt":
      "sha256:69a1cc215285fed0feda2e4315eb9b09ba29358eb3659632dc8c08bca95e8f3d",
    "2026-09-23/noticeDismiss/zh":
      "sha256:ef2189c3ea8f19a8f35d9fc79c6b5605ee829a5a2b1b990ef2025265030b9104",
  });

export const consentCopyDigestKey = (
  version: string,
  key: string,
  language: string
): string => `${version}/${key}/${language}`;
