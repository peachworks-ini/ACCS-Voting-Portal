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

## v0.0.13

Adds new-suggestion Discord announcements through the existing authentication Worker, 100-character embed previews, and direct View & Vote thread links. See `worker/README.md` for the D1 migration, secret, Cron Trigger, rollout order, and delivery limitations. The Worker configuration must be deployed before the frontend.

Adds optional private-admin-channel pending-review reminders at 8 AM and 8 PM America/Los_Angeles. Requires a read-only Firestore service-account secret and the new D1 reminder-run table; see `worker/ADMIN-REMINDERS.md`. The reminder's Pending Reviews link survives login and preserves existing admin access checks.

## v0.0.14

Added light blue background differentiators for admin posts/comments. Regular members are in light gray. ADMIN labels are now in red. Visible content is automatically marked red after viewing in an active tab.

## v0.0.14a

Added a new banner, finally. Refined the color of the navy color, and changed sidebar buttons to a light blue.

## v0.0.14b

Simplified the home cards to show only titles and final verdicts, and stylized them with inspiration from classic AA.com design. Added red GO buttons to entice navigation, and added differentiation between fonts by including Tahoma, with Verdana fallback for buttons, dropdowns, and status badges. Menu heading has been removed from sidebar. Web links are clickable. Site is now left-orientated with a 3:2 proportion. RSS is being experimented on, and sitemap + FAQ will be considered for v0.0.15.
