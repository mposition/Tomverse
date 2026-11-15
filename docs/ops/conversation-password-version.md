# Conversation unlock grant versions

Unlock grants sign the owner, resource type, resource ID, expiry and persisted
`passwordVersion`, never password material. The cookie retains its three-part
shape for existing native clients, with a non-secret integer in the middle.

The additive migration installs a row trigger on Conversation and
ExternalConversation. Every password set, change, clear or legacy rewrite
increments the version in the same write; unrelated updates preserve it.
The trigger also covers old app instances and maintenance scripts during a
rolling deployment and prevents direct counter resets.

Deploy the migration before the new app. Existing fingerprint-based grants are
deliberately invalidated once: owners must unlock their conversations again.
Password hashes and conversations are preserved. Removing the new app does not
require dropping the additive columns or triggers. Production migration and
deployment remain separate operator actions.
