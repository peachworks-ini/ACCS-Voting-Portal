# Twice-daily pending-review reminders

Destination: `1497835434355720242`, in server `1466505553042739363`.
Schedule: 08:00 and 20:00 America/Los_Angeles, including automatic daylight-saving changes.
The existing `*/5 * * * *` Cron Trigger checks the local hour. One slot can enqueue at most one reminder. No message is posted when the queue is empty. No role or user is pinged.

## Cloudflare setup

1. Apply `migrations/0002_admin_review_reminders.sql` in the existing D1 database bound as `DB`. This only adds a reminder-run table. Keep the existing announcement table.
2. Create a dedicated service account in Google Cloud project **accs-voting** for the reminder reader. Grant **Cloud Datastore Viewer** (`roles/datastore.viewer`), not Editor, Owner, or Firebase Admin. This role can read Firestore, including documents outside the review queue; it does not grant database writes. The Worker requests only suggestion metadata and does not read private moderator notes.
3. Create a JSON key for that service account. Add the entire JSON as an encrypted Worker secret named **FIREBASE_REVIEW_SERVICE_ACCOUNT**. Do not paste the key into code, GitHub, or chat. Follow your normal protected-key storage policy; the Worker only needs the secret value.
4. Give **ACCSVotePortal** View Channel, Send Messages, and Embed Links in channel **1497835434355720242**. For a private channel, explicitly allow the bot there.
5. Deploy the updated complete Worker from `index.mjs`, keeping existing bindings and secrets unchanged. It preserves both authentication and announcement delivery.
6. Add a plaintext Worker variable **ADMIN_REVIEW_REMINDERS_ENABLED** with value **true**. Reminders stay disabled when this is absent or false.
7. Keep the existing Cron Trigger ***/5 * * * ***. Do not replace it with a fixed UTC 08:00/20:00 schedule. Cloudflare Cron runs in UTC; the code converts to America/Los_Angeles and handles the two Pacific target hours.
8. Publish the matching website update, which makes the reminder's Pending Reviews button retain its destination through login. The frontend change does not grant non-admins access.

No new Discord token, privileged intent, always-online bot client, or new Firebase Functions deployment is required.

## Reminder content and matching the portal

The reminder lists the total pending count and up to ten titles, oldest first. A button links to the portal's Pending Reviews page. It matches the portal's stored queue: status `passed`, reviewStatus not `finalized`, and no moderatorFinalizedAt. The reminder does not resolve expired voting periods or change suggestion records. Existing website behavior still moves expired suggestions into moderator review when the portal processes them.

No private moderator notes or votes are included. A service-account OAuth access token is signed server-side and cached until near expiry. The private key and access tokens are never logged or stored in D1.

A reminder's queued payload is a snapshot at its scheduled check. If a rate limit delays delivery, its count may no longer be current by the time it is posted. The button opens the latest live queue.

## Verification and troubleshooting

At the next 8 AM or 8 PM Pacific slot, the reminder normally sends within five minutes. A check failing early can retry during that scheduled hour. There is no late catch-up outside the hour.

```sql
SELECT * FROM admin_review_reminder_runs ORDER BY slot DESC LIMIT 10;
SELECT suggestion_id, state, attempts, last_error, message_id
FROM discord_announcements
WHERE suggestion_id LIKE 'admin-review-%'
ORDER BY created_at DESC LIMIT 10;
```

- A run with pending_count=0 is a successful quiet check.
- A run with pending_count>0 should have a queued/sent announcement.
- No run in a due slot: check the Cron Trigger, enabled variable, read-only secret, and Worker logs for `Admin reminder check failed`.
- Discord HTTP 403: correct the admin channel permissions, then requeue only the failed reminder, just as with failed suggestion announcements.
- State `uncertain`: inspect the channel before requeueing. An interrupted send may already have posted; never bulk-reset these records.
- Disable with `ADMIN_REVIEW_REMINDERS_ENABLED=false`. Already queued reminders can still be processed by the shared announcement queue; inspect them before changing state.

Tests: `node tests/admin-reminders.test.mjs` on Node.js 22+ with built-in SQLite. Automated coverage includes DST boundaries, morning/evening slots, duplicate suppression, empty queues, failed reads, pagination, finalized exclusions, Unicode-safe text, suppressed mentions, JWT signatures, and access-token caching.

References:
https://developers.cloudflare.com/workers/configuration/cron-triggers/
https://firebase.google.com/docs/firestore/use-rest-api
https://docs.cloud.google.com/iam/docs/roles-permissions/firestore
