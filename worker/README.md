# Discord announcements for ACCSVotePortal

This is the supplied existing authentication Worker plus announcement delivery. Existing OAuth/session routes and credentials are preserved. Announcement credentials are separate.

## Configure Cloudflare before releasing the frontend

1. Back up the current `accs-voting-api` Worker code and D1 database.
2. In the existing D1 database bound to the Worker as `DB`, execute `migrations/0001_discord_announcements.sql` through the D1 console. It creates only the announcement table and indexes; do not replace the database or the users/session tables.
3. Under Workers & Pages → accs-voting-api → Settings → Variables and Secrets, add an encrypted secret named `DISCORD_ANNOUNCEMENT_BOT_TOKEN` with ACCSVotePortal's token. Never put it in frontend HTML, source control, or chat. Leave `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, and `DISCORD_GUILD_ID` unchanged: these still serve existing login/membership verification.
4. Replace the existing Worker's code with `index.mjs` and deploy it. Preserve the existing `DB` binding and all other settings.
5. Add a Cron Trigger `*/5 * * * *` to this Worker. It processes queued rate-limit retries. Submission normally attempts delivery immediately.
6. ACCSVotePortal must be in server `1466505553042739363`, with View Channel, Send Messages, and Embed Links in channel `1566952692855742624`.
7. Release the matching `index.html` frontend after the Worker is configured. Create ONE genuine test suggestion in the portal. Check the embed and View & Vote link; that link should restore the selected thread through login. Use My Suggestions → Share to Discord to confirm that a second request does not send another post.

No Firebase service-account key, always-running Discord client, or new Firebase Functions deployment is required. The Worker uses the submitting browser's Firebase ID token to read the saved document under the existing Firestore rules, verifies its UID, and compares the saved author with the D1 session's Minecraft account. Tokens are not stored in the announcement table. If the Firebase public API key has HTTP referrer restrictions that prevent Worker use, configure a separate appropriate key in the same Firebase project and restrict it to the needed Firebase Authentication API; do not loosen unrelated project settings.

## Behavior

- Only verified members can request announcements for their own saved, active suggestions. The destination is fixed on the backend. The endpoint accepts a session token, Firebase ID token, and document ID, not user-supplied Discord payloads.
- Description previews are capped at 100 Unicode characters, cut at a word boundary, and end in an ellipsis when shortened. Mentions are disabled; untrusted Markdown and mention syntax are neutralized. Tags come from the six configured choices.
- Accepted requests persist an immutable message snapshot in D1. A primary key and atomic claim prevent concurrent/repeated submissions from resending. A six-per-hour cap applies per Discord account, including admins.
- Successful delivery records the Discord message ID. Rate limits are retried according to Discord's delay by the Cron Trigger. Permanent permission errors become `failed`.
- Timeouts, interrupted sends, and Discord server errors become `uncertain`, because Discord may already have created the message. These are not blindly retried. The nonce also reduces repeats in Discord's recent deduplication window; this is not a claim of permanent exactly-once delivery.
- A failed announcement never rolls back the saved suggestion. If the browser closes or loses connection before enqueueing, use Share to Discord from My Suggestions. There is no independent scan of Firestore and no replay of old suggestions at installation.
- The first enqueue requires the same Firebase identity that created the post; after that, the same portal account can check its queued/sent result across sessions. After signing out before enqueueing, the anonymous Firebase identity may change; an administrator should investigate rather than bypass ownership validation.
- Editing, resolving, or deleting a suggestion does not alter an already accepted announcement snapshot. Edits do not generate another announcement.

## Check delivery state

In D1 console:

```sql
SELECT suggestion_id, state, attempts, message_id, last_error, updated_at
FROM discord_announcements ORDER BY created_at DESC LIMIT 20;
```

After correcting a permission/configuration error, an administrator may requeue only a row confirmed to be undelivered:

```sql
UPDATE discord_announcements
SET state = 'pending', next_attempt_at = 0, last_error = NULL
WHERE suggestion_id = 'EXACT_SUGGESTION_ID' AND state = 'failed';
```

For `uncertain`, inspect the channel first. If the post exists, record its message ID and set the row to `sent`. If it does not exist and non-delivery is confirmed, requeue that specific row manually. Never bulk-reset delivery state.

## Tests

On Node.js 22+ with built-in SQLite:

```sh
node tests/features.test.mjs
node tests/announcements.test.mjs
node tests/announcement-frontend.test.mjs
```

The announcement tests use isolated SQLite and simulated Discord/Firebase responses. They never post to Discord. Live Cloudflare, Firestore rules, secret configuration, and Discord permissions still require the one-post staging check described above.
