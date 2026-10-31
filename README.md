# ACCS Voting Portal

A web-based voting portal for ACCS community suggestions, polls, and proposals.

## Features

- Submit suggestions
- Vote on proposals
- Community participation and moderation

## Copyright

Copyright © 2026 peachworks. All rights reserved.

## v0.0.12

- Suggestions support six optional tag choices: Quality of Life, Client-side, Building, Visuals, Adventure, and Fun. Select any combination using checkboxes. Authors can edit tags; Suggestion Vote can filter by tag. Existing suggestions work without tags.
- The Notifications button beside the welcome text counts unread threads: new active suggestions and replies after you comment on or create a suggestion. Your own replies do not generate alerts.
- Open a thread to mark its current activity as read, or use Mark all as read. Read status is stored per Minecraft account in the current browser, persists across sign-ins, and does not sync between devices. Existing active suggestions initially appear unread.
- Closed threads remain accessible from reply notifications, with comments read-only.
- Discord integration is deferred; existing Discord sign-in is unchanged.

Run feature checks with `node tests/features.test.mjs`. Live Firestore submission and permissions should be checked in a signed-in staging session before release; this repository does not include Firestore rules or the authentication worker.
