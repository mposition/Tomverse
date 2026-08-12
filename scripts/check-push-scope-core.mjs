/**
 * PUSH-01: "Push-notification infrastructure remains out of v1 until a use case
 * is approved." Criterion: `unapproved_push_infrastructure_components_in_v1`
 * equals 0.
 *
 * `npm run report:release-gate-evidence` describes this gate as inverted --
 * it is met by something being *absent*, so there is correctly nothing to point
 * at -- and names what could exist instead: "a check asserting the absence, the
 * way check:shared-packages asserts forbidden imports are absent; today the
 * scope review is the only thing holding it."
 *
 * A scope review is a person reading a diff and remembering a decision. It
 * holds until the week somebody adds a dependency for an unrelated reason and
 * the reviewer does not connect it to a gate written months earlier. That is
 * the entire failure mode this replaces: the gate is about what is in the
 * release, and what is in the release is a fact the repository can state.
 *
 * What counts as push infrastructure, and why each signal rather than the word
 * "push":
 *
 *   - **dependency** -- a delivery SDK is the component itself, and it arrives
 *     in one line of package.json.
 *   - **browser API** -- `PushManager`, `applicationServerKey`,
 *     `Notification.requestPermission`, `showNotification` are the Web Push
 *     surface. Nothing else in this product has a reason to name them.
 *   - **service worker** -- Web Push cannot be received without one, so a
 *     registered worker is the receiving half arriving early.
 *   - **credential** -- a VAPID or FCM server key in the environment is
 *     infrastructure whether or not code reads it yet.
 *   - **schema** -- a device-token or push-subscription table is the stored
 *     half, and it outlives whatever feature motivated it.
 *   - **route** -- `/api/push/...` is the endpoint.
 *
 * The word `push` on its own is deliberately never a signal. `Array.prototype
 * .push` and `git push` are everywhere in this repository, and a check that
 * cried wolf on either would be turned off within a day. Every pattern below
 * is an identifier that only appears when push notifications do.
 *
 * What is explicitly NOT push infrastructure, because the tree already has it:
 * `NotificationDelivery` is the email queue -- one row per source record, an
 * HTTP error kind, a retry schedule -- and `AdminNotificationLog` is an audit
 * trail. Notifying somebody is not push; delivering to a device registration
 * is. Both are covered by a test so the distinction cannot erode.
 */

/** Delivery SDKs. Presence in dependencies is the component arriving. */
export const PUSH_PACKAGES = [
    "web-push",
    "firebase",
    "firebase-admin",
    "@react-native-firebase/messaging",
    "expo-notifications",
    "expo-server-sdk",
    "apn",
    "node-apn",
    "@parse/node-apn",
    "onesignal-node",
    "@onesignal/node-onesignal",
    "next-pwa",
];

/**
 * Identifiers that exist only to send or receive a push notification. Each is
 * matched as a whole word, so `items.push(` and `git push` cannot reach them.
 */
export const PUSH_IDENTIFIERS = [
    "PushManager",
    "pushManager",
    "PushSubscription",
    "applicationServerKey",
    "showNotification",
    "serviceWorker",
    "gcm_sender_id",
];

/**
 * Phrases rather than identifiers, because the identifier alone belongs to
 * something else here.
 *
 * `requestPermission` on its own is the shape of half a dozen unrelated
 * browser APIs, and `getSubscription` reads as Stripe in a product that sells
 * subscriptions -- a check that failed a billing change with a
 * push-notification error would be switched off within a day, which costs more
 * than the coverage it buys. `pushManager` already catches
 * `registration.pushManager.getSubscription()`, so nothing is lost.
 */
export const PUSH_PHRASES = ["Notification.requestPermission"];

/** Server credentials. Infrastructure whether or not code reads them yet. */
export const PUSH_CREDENTIALS = [
    "VAPID_PUBLIC_KEY",
    "VAPID_PRIVATE_KEY",
    "FCM_SERVER_KEY",
    "FIREBASE_SERVER_KEY",
    "APNS_KEY_ID",
    "APNS_TEAM_ID",
    "ONESIGNAL_APP_ID",
];

/**
 * Prisma models that store a device registration. Matched on the model name,
 * not on the word "notification": the product notifies people by email today
 * and that is not what this gate is about.
 */
export const PUSH_MODEL_PATTERN =
    /model\s+(\w*(?:PushSubscription|PushToken|DeviceToken|PushDevice|WebPush)\w*)\s*\{/g;

const wordPattern = (identifier) =>
    new RegExp(`(?<![\\w$])${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`);

/**
 * @param {object} input
 * @param {readonly string[]} input.dependencies  every dependency name in package.json
 * @param {readonly {path: string, text: string}[]} input.sources
 * @param {string} input.prismaSchema
 * @param {readonly string[]} input.paths         repository-relative file paths
 * @param {readonly string[]} input.environmentNames  names referenced in env docs/config
 */
export const findPushInfrastructure = ({
    dependencies = [],
    sources = [],
    prismaSchema = "",
    paths = [],
    environmentNames = [],
}) => {
    const findings = [];

    for (const name of dependencies) {
        if (PUSH_PACKAGES.includes(name)) {
            findings.push({
                kind: "dependency",
                detail: name,
                where: "package.json",
            });
        }
    }

    for (const { path, text } of sources) {
        for (const identifier of PUSH_IDENTIFIERS) {
            if (wordPattern(identifier).test(text)) {
                findings.push({ kind: "browser-api", detail: identifier, where: path });
            }
        }
        for (const phrase of PUSH_PHRASES) {
            if (text.includes(phrase)) {
                findings.push({ kind: "browser-api", detail: phrase, where: path });
            }
        }
    }

    for (const name of environmentNames) {
        if (PUSH_CREDENTIALS.includes(name)) {
            findings.push({ kind: "credential", detail: name, where: "environment" });
        }
    }

    PUSH_MODEL_PATTERN.lastIndex = 0;
    for (const match of prismaSchema.matchAll(PUSH_MODEL_PATTERN)) {
        findings.push({
            kind: "schema",
            detail: match[1],
            where: "prisma/schema.prisma",
        });
    }

    for (const path of paths) {
        if (/^app\/api\/push\//.test(path)) {
            findings.push({ kind: "route", detail: path, where: path });
        }
        if (/^public\/(sw|service-worker)\.js$/.test(path)) {
            findings.push({ kind: "service-worker", detail: path, where: path });
        }
    }

    return findings;
};

export const describeFindings = (findings) =>
    findings.length === 0
        ? "No push-notification infrastructure is present."
        : "PUSH-01 requires that no push infrastructure ships in v1 until a use case " +
          "is approved. Found:\n" +
          findings
              .map((finding) => `  [${finding.kind}] ${finding.detail} (${finding.where})`)
              .join("\n") +
          "\n\nIf this is the approved use case, record the approval on PUSH-01 in " +
          "docs/release-gates/tomverse-chat-v1.yaml first -- the gate is the decision, " +
          "and this check only reports what the tree contains.";
