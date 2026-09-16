/**
 * The eight jurisdiction profiles, as data.
 *
 * Contract: docs/policy/email-notifications.md §5.2, §8.7, §12.5.
 *
 * ## Why this is a seed and not a constant the renderer reads
 *
 * §8.7 draws a line: a profile changes **values** without a deploy, and only a
 * new *kind* of requirement needs one. That is only true if the values live in
 * rows an operator can edit. So this module is the starting content of the
 * first policy version -- what the profiles were on the day they were written
 * down -- and not the running configuration. Once a version is active, the rows
 * are the source of truth and this file is history.
 *
 * ## Every value carries where it came from
 *
 * `notes` is not documentation. §12.5 requires the edit screen to show the
 * source and the confirmation date beside each field, because an operator
 * asked to change a subject prefix has no way to judge the change without
 * knowing what the current value is based on. The sentences below are the ones
 * §4.3 already researched, kept in the row rather than in a document nobody
 * opens while editing.
 *
 * ## What is deliberately absent
 *
 * No expressions, no conditions, no per-template overrides. §8.7's boundary is
 * that a profile changes values and a deploy changes shapes; a profile that
 * could express "prefix if the recipient is a business" would be a program
 * running outside review, which is more dangerous than the deploy it saves.
 */

import { RENDERABLE_FOOTER_BLOCKS } from "@/lib/emailFooterRenderer";
import { parseQuietHours } from "@/lib/emailQuietHoursCore";
import {
  JURISDICTION_PROFILES,
  JURISDICTION_MAPPED_COUNTRY_CODES,
  profileForCountry,
  type JurisdictionProfileKey,
} from "@/lib/emailJurisdictionCore";

/**
 * The version string the seed currently describes.
 *
 * This is the idempotency key of `ensureJurisdictionPolicyDraft()`: a policy
 * version row already carrying it is returned as it stands and never edited,
 * because an active version is what some delivery was already rendered under.
 *
 * So editing a profile below reaches nobody until this string moves. The send
 * path reads the `JurisdictionProfile` row (`lib/standardEmailLane.ts`), not
 * this file, and a tree that names one set of footer blocks while the row
 * names another is the failure this constant exists to prevent -- the symptom
 * is a footer that is silently dropped, or a marketing message held, for a
 * rule nobody can find in the source.
 *
 * Bump it in the same commit as any profile edit that has already been
 * created as a row, and say what moved in the summary. While no row carries it
 * yet -- which was true in production until 2026-09-15, where the only active
 * version was the bootstrap one with no profiles at all -- editing a profile
 * in place is correct and bumping would mint a second version describing the
 * same thing.
 *
 * Either way the deploy is only half of it: somebody still creates the draft
 * and activates it (docs/policy/email-notifications.md §12.3,
 * `/admin/email-policy`). Old versions stay where they are.
 */
export const JURISDICTION_POLICY_SEED_VERSION = "2026-09-16.jurisdictions.2";

export const JURISDICTION_POLICY_SEED_SUMMARY =
  "Jurisdiction profiles for KR, US, CA, AU, GB, SG, EU, CH and the ZZ fallback, from the sources confirmed on 2026-08-21 and the EEA/Swiss review of 2026-09-14. KR names no registration numbers: the sender is not a Korean 통신판매업자, so those values do not exist and naming them would discard the whole footer. CH is its own profile rather than resolving through EU. EU and CH footers name abn. KR carries no quiet hours from 2026-09-16: the Network Act's night-time rule names media prescribed by decree and electronic mail is excluded from them (open question Q4, resolved).";

/**
 * A footer block identifier.
 *
 * Re-exported from the renderer rather than declared here. The renderer owns
 * what each block prints; the profile owns which ones appear and in what
 * order. Two lists would let a profile name a block nobody renders, which is a
 * footer with a hole in it discovered at send time.
 */
export const FOOTER_BLOCKS = RENDERABLE_FOOTER_BLOCKS;

export type FooterBlock = (typeof RENDERABLE_FOOTER_BLOCKS)[number];

export type JurisdictionProfileSeed = {
  profileKey: JurisdictionProfileKey;
  marketingBasis: "opt_in" | "opt_out";
  subjectPrefix: string | null;
  footerBlocks: FooterBlock[];
  unsubscribeSlaBusinessDays: number;
  consentNoticeIntervalMonths: number | null;
  quietHours: { start: string; end: string; tz: string } | null;
  impliedConsentDays: { transaction: number; enquiry: number } | null;
  notes: string;
};

/**
 * The blocks every marketing footer carries, in the order they print (C4).
 *
 * Written once and spread rather than repeated per profile: the common part is
 * common because C4 made it common, and eight hand-copied lists would drift the
 * first time somebody edits seven of them.
 */
const COMMON_FOOTER: FooterBlock[] = [
  "legal_name",
  "postal_address",
  "contact_email",
  "unsubscribe_link",
  "unsubscribe_reason",
];

export const JURISDICTION_PROFILE_SEED: readonly JurisdictionProfileSeed[] = [
  {
    profileKey: "KR",
    marketingBasis: "opt_in",
    subjectPrefix: "(광고)",
    footerBlocks: [
      "legal_name",
      "postal_address",
      "contact_email",
      "unsubscribe_link",
      "unsubscribe_reason",
    ],
    unsubscribeSlaBusinessDays: 1,
    consentNoticeIntervalMonths: 24,
    quietHours: null,
    impliedConsentDays: null,
    notes: [
      "정보통신망법 제50조. 영리목적 광고성 정보는 사전 동의(제1항), 제목 앞 `(광고)` 표시(제4항 및 시행령 제61조), 수신거부 방법 명시(시행령 별표 6). 확인일 2026-08-21.",
      "E3 footerBlocks에서 business_registration·mail_order_registration을 뺐습니다(2026-09-14). 시행령 별표 6이 요구하는 것은 전송자의 명칭·연락처·수신거부 방법이고 등록번호는 여기 없습니다. 두 번호는 전자상거래법상 통신판매업자의 표시 의무에서 온 항목인데, 발송 주체는 호주 법인이고 한국 통신판매업 신고 대상이 아님을 확인했으므로(운영 확인 2026-09-14) 그 번호가 존재하지 않습니다. renderJurisdictionFooter()는 이름 붙은 block 중 하나라도 값이 없으면 footer 전체를 버리므로, 존재하지 않는 번호를 계속 이름 대면 한국 수신자 marketing이 영구히 거부됩니다. 신고 대상이 되면 블록을 되살리는 것은 새 EmailPolicyVersion 하나입니다.",
      "E7 consentNoticeIntervalMonths=24: 제50조제8항 + 시행령 제62조의3. 2년마다 수신자에게 동의 사실을 *알릴* 의무이며 동의가 만료되는 것이 아닙니다(§5.5). 답이 없는 수신자의 동의는 그대로 유지됩니다.",
      "E5 quietHours=null (2026-09-16, Q4 해소). 제50조제3항의 야간 전송 제한은 단서와 시행령 제61조제2항이 전자우편을 제외합니다 — 전자우편은 수신확인의 즉시성이 낮아 이용자 통제가 쉽다는 이유이며, 방송미디어통신위원회·KISA 「불법스팸 방지를 위한 정보통신망법 안내서」(KISA-GD-2025-0037, 2025.12)가 그렇게 적습니다. 같은 내용을 SMS·푸시로 보내면 그쪽은 여전히 별도 동의 대상이고, 그 판정은 이 profile이 아니라 그 채널의 것입니다. 창을 되살리는 것은 새 EmailPolicyVersion 하나입니다(§5.2 E5).",
      "unsubscribeSlaBusinessDays=1 is copy only: 법은 즉시 처리와 결과 통지를 요구하고, 실제 처리는 모든 관할권에서 동기적입니다(C3).",
    ].join("\n"),
  },
  {
    profileKey: "US",
    marketingBasis: "opt_out",
    subjectPrefix: null,
    footerBlocks: COMMON_FOOTER,
    unsubscribeSlaBusinessDays: 10,
    consentNoticeIntervalMonths: null,
    quietHours: null,
    impliedConsentDays: null,
    notes: [
      "CAN-SPAM Act, 15 U.S.C. 7701 et seq. and 16 CFR 316. Confirmed 2026-08-21.",
      "marketingBasis is recorded as opt_out because that is what the statute provides. We send opt-in anyway (C1); the column describes the jurisdiction, not our behaviour, so that a profile can be cited as evidence of what was understood.",
      "unsubscribeSlaBusinessDays=10: 15 U.S.C. 7704(a)(4)(A)(i). The mechanism must also keep working for at least 30 days after sending (C14).",
      "postal_address is not optional here: 15 U.S.C. 7704(a)(5)(A)(iii) requires a valid physical postal address in every commercial message.",
      "15 U.S.C. 7707(b) preempts state anti-spam statutes except for falsity and deception, so no state profile is needed for the subject or the unsubscribe mechanism.",
    ].join("\n"),
  },
  {
    profileKey: "CA",
    marketingBasis: "opt_in",
    subjectPrefix: null,
    footerBlocks: COMMON_FOOTER,
    unsubscribeSlaBusinessDays: 10,
    consentNoticeIntervalMonths: null,
    quietHours: null,
    impliedConsentDays: { transaction: 730, enquiry: 183 },
    notes: [
      "CASL (S.C. 2010, c. 23) and the CRTC's guidance. Confirmed 2026-08-21.",
      "unsubscribeSlaBusinessDays=10: s. 11(3) requires an unsubscribe request to be given effect within 10 business days.",
      "impliedConsentDays records the 2-year post-transaction and 6-month post-enquiry windows. E6: unused, because C8 declines implied consent everywhere. The field is present so the profile describes CASL truthfully rather than describing us.",
      "The CRTC places the burden of proving consent on the sender, which is why every consent write records time, source, policy version, jurisdiction and evidence (C6).",
    ].join("\n"),
  },
  {
    profileKey: "AU",
    marketingBasis: "opt_in",
    subjectPrefix: null,
    footerBlocks: [
      "legal_name",
      "abn",
      "postal_address",
      "contact_email",
      "unsubscribe_link",
      "unsubscribe_reason",
    ],
    unsubscribeSlaBusinessDays: 5,
    consentNoticeIntervalMonths: null,
    quietHours: null,
    impliedConsentDays: null,
    notes: [
      "Spam Act 2003 (Cth) and ACMA guidance. Confirmed 2026-08-21.",
      "unsubscribeSlaBusinessDays=5 is the shortest deadline of any jurisdiction surveyed (Sch. 2 cl. 4), which is why C3 sets the global ceiling there rather than at the American 10.",
      "abn: s. 17 requires the message to identify the sender accurately, and an ABN is how an Australian business is identified. Sender details must stay accurate for 30 days after sending (C13).",
      "The unsubscribe facility may not require the recipient to log in or to pay, which is where C2 comes from.",
    ].join("\n"),
  },
  {
    profileKey: "GB",
    marketingBasis: "opt_in",
    subjectPrefix: null,
    footerBlocks: COMMON_FOOTER,
    unsubscribeSlaBusinessDays: 5,
    consentNoticeIntervalMonths: null,
    quietHours: null,
    impliedConsentDays: null,
    notes: [
      "UK GDPR and PECR reg. 22, as amended by the Data (Use and Access) Act 2025. Confirmed 2026-08-21.",
      "PECR names no number of days -- it requires the request to be honoured without undue delay. unsubscribeSlaBusinessDays=5 is the global ceiling from C3, quoted so the copy says something specific rather than something vague.",
      "reg. 22(3A), the charity soft opt-in, is in force from 2026-02-05. Not used: C8 declines soft opt-in in every jurisdiction, and we are not a charity.",
    ].join("\n"),
  },
  {
    profileKey: "SG",
    marketingBasis: "opt_out",
    subjectPrefix: "<ADV> ",
    footerBlocks: COMMON_FOOTER,
    unsubscribeSlaBusinessDays: 10,
    consentNoticeIntervalMonths: null,
    quietHours: null,
    impliedConsentDays: null,
    notes: [
      "Spam Control Act 2007 and the PDPA. Confirmed 2026-08-21.",
      "E2 subjectPrefix '<ADV> ': the Second Schedule requires the title of the message to start with <ADV>. The trailing space is part of the value because the prefix is concatenated, not joined -- the schedule requires it to precede the subject, and a subject reading '<ADV>Welcome' is harder to read without being any more compliant.",
      "This prefix and Korea's are why §6.3 refuses to resolve a jurisdiction conflict by choosing the stricter one: applied together they produce a third subject that satisfies neither schedule.",
      "unsubscribeSlaBusinessDays=10: Second Schedule, 10 business days.",
      "marketingBasis opt_out describes the Spam Control Act. The PDPA still requires consent for the processing itself, and C1 sends opt-in regardless.",
    ].join("\n"),
  },
  {
    profileKey: "EU",
    marketingBasis: "opt_in",
    subjectPrefix: null,
    footerBlocks: [
      "legal_name",
      "abn",
      "postal_address",
      "contact_email",
      "unsubscribe_link",
      "unsubscribe_reason",
    ],
    unsubscribeSlaBusinessDays: 5,
    consentNoticeIntervalMonths: null,
    quietHours: null,
    impliedConsentDays: null,
    notes: [
      "ePrivacy Directive 2002/58/EC art. 13 together with the GDPR; EDPB Opinion 5/2019 on the interplay. Confirmed 2026-08-21.",
      "One profile for thirty countries is a decision, not a claim that their national implementations agree. The Q1 review of 2026-09-14 read Germany, France and Austria and found the divergence sits in ground C1 and C8 already gave up -- France's B2B relaxation does not reach a B2C sender, and the German and Austrian existing-customer exceptions are ones C8 declines. What is left (proof of consent, and not concealing the sender) applies everywhere, so it is not a profile. The other twenty-six were not read individually: docs/policy/email-eea-marketing-review-2026-09-14.md section 5 says so, and requires a per-country note before a first send there.",
      "Switzerland was mapped here until 2026-09-14 and now has its own profile: it is not in the EEA, its rule is Swiss UWG art. 3(1)(o) rather than the Directive, and the revFADP applies with its own supervisory authority. See docs/policy/email-eea-marketing-review-2026-09-14.md section 4.5.",
      "abn joins the footer on 2026-09-14. No EU instrument asks for it; DDG section 6 and CPCE L.34-5 ask that the sender not be concealed, and for an Australian company the ABN is the shortest identifier that makes the name checkable. Same review, section 6.1.",
      "The Directive says 'without undue delay' rather than a number of days; unsubscribeSlaBusinessDays=5 is C3's global ceiling, quoted for the copy.",
      "art. 13(2) soft opt-in is available and not used (C8).",
    ].join("\n"),
  },
  {
    profileKey: "CH",
    marketingBasis: "opt_in",
    subjectPrefix: null,
    footerBlocks: [
      "legal_name",
      "abn",
      "postal_address",
      "contact_email",
      "unsubscribe_link",
      "unsubscribe_reason",
    ],
    unsubscribeSlaBusinessDays: 5,
    consentNoticeIntervalMonths: null,
    quietHours: null,
    impliedConsentDays: null,
    notes: [
      "Swiss UWG art. 3(1)(o): mass advertising by email requires prior consent, the sender must be correctly identified and may not be concealed, and every message must carry a free and easy way to refuse further ones. Confirmed 2026-09-14.",
      "The values match the EU profile and the sources do not, which is the whole reason this row exists. Switzerland is outside the EEA, the revFADP applies alongside the GDPR with the FDPIC as its authority, and the transfer analysis is its own. Sharing a row would mean a change justified by one body of law silently moving the other.",
      "art. 3(1)(o) has an existing-customer exception in the same shape as the Directive's. C8 declines it, as everywhere else.",
      "unsubscribeSlaBusinessDays=5 is C3's global ceiling quoted for the copy; Swiss law states no number.",
      "Recorded in docs/policy/email-eea-marketing-review-2026-09-14.md section 4.5 and section 6.2.",
    ].join("\n"),
  },
  {
    profileKey: "ZZ",
    marketingBasis: "opt_in",
    subjectPrefix: null,
    footerBlocks: COMMON_FOOTER,
    unsubscribeSlaBusinessDays: 5,
    consentNoticeIntervalMonths: null,
    quietHours: null,
    impliedConsentDays: null,
    notes: [
      "The fallback for a country with no profile, and for every case where the jurisdiction could not be resolved with confidence.",
      "It is a complete profile rather than an empty one because transactional and legal mail still go out under it and still need a business identity footer. What it does not do is authorise marketing: marketingJurisdictionVerdict() refuses anything that is not high confidence, so no advertising is ever sent under ZZ (§6.3 rule 1).",
      "marketingBasis is opt_in because that is what C1 does everywhere. It is not a finding about any jurisdiction -- there is no jurisdiction here to have one.",
    ].join("\n"),
  },
];

/**
 * The country map, derived from the same function the resolver uses.
 *
 * Deliberately not hand-written. The resolver decides a profile in code today
 * (`profileForCountry`), and these rows are what an operator will edit later;
 * seeding them from anywhere else would let the two disagree on day one, and a
 * disagreement between them is a footer that says one thing while the send
 * decision was made on another.
 *
 * Only countries that resolve to a real profile are listed. Everything else
 * resolves to `ZZ` by absence, which is the same answer with one fewer row to
 * maintain -- and, more to the point, means the map never has to claim to
 * enumerate every country in the world.
 */
export const jurisdictionCountryMapSeed = (): Array<{
  countryCode: string;
  profileKey: JurisdictionProfileKey;
}> => {
  const rows: Array<{ countryCode: string; profileKey: JurisdictionProfileKey }> = [];
  for (const country of JURISDICTION_MAPPED_COUNTRY_CODES) {
    const profileKey = profileForCountry(country);
    if (profileKey === "ZZ") continue;
    rows.push({ countryCode: country, profileKey });
  }
  return rows;
};

/**
 * What is wrong with the seed, in the same terms the database would use.
 *
 * The migration's CHECK constraints are the real gate; this exists so a broken
 * seed is a readable list at the point of authorship rather than a constraint
 * violation halfway through a transaction, and so the pure tests can assert on
 * it without a database.
 */
export const jurisdictionSeedProblems = (): string[] => {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const profile of JURISDICTION_PROFILE_SEED) {
    if (seen.has(profile.profileKey)) {
      problems.push(`${profile.profileKey}: declared twice`);
    }
    seen.add(profile.profileKey);

    if (profile.unsubscribeSlaBusinessDays <= 0) {
      problems.push(`${profile.profileKey}: unsubscribe SLA must be positive`);
    }
    if (
      profile.consentNoticeIntervalMonths !== null &&
      profile.consentNoticeIntervalMonths <= 0
    ) {
      problems.push(
        `${profile.profileKey}: consent notice interval must be positive or absent`
      );
    }
    if (profile.footerBlocks.length === 0) {
      problems.push(`${profile.profileKey}: has no footer blocks`);
    }
    // A window the send lane cannot read holds every marketing message for that
    // profile, so a malformed one is caught here, before a draft is created.
    if (parseQuietHours(profile.quietHours) === "invalid") {
      problems.push(`${profile.profileKey}: quietHours cannot be read (format or zone)`);
    }
    for (const block of profile.footerBlocks) {
      if (!FOOTER_BLOCKS.includes(block)) {
        problems.push(`${profile.profileKey}: unknown footer block ${block}`);
      }
    }
    // C4. A marketing footer without these is a message that cannot lawfully
    // be sent anywhere surveyed, so a profile missing one is not a variation.
    for (const required of [
      "legal_name",
      "postal_address",
      "unsubscribe_link",
    ] as const) {
      if (!profile.footerBlocks.includes(required)) {
        problems.push(`${profile.profileKey}: footer omits ${required} (C4)`);
      }
    }
    if (!profile.notes.trim()) {
      problems.push(`${profile.profileKey}: has no sources (§12.5)`);
    }
  }

  for (const key of JURISDICTION_PROFILES) {
    if (!seen.has(key)) problems.push(`${key}: no profile in the seed`);
  }
  for (const key of seen) {
    if (!(JURISDICTION_PROFILES as readonly string[]).includes(key)) {
      problems.push(`${key}: not a profile the resolver knows`);
    }
  }

  for (const row of jurisdictionCountryMapSeed()) {
    if (!seen.has(row.profileKey)) {
      problems.push(`${row.countryCode}: maps to unseeded profile ${row.profileKey}`);
    }
  }

  return problems;
};
