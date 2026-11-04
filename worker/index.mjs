
const FRONTEND_URL =
  "https://peachworks-ini.github.io/ACCS-Voting-Portal/";

const CALLBACK_URL =
  "https://accs-voting-api.peachworks001.workers.dev/auth/discord/callback";

const API_ORIGIN = "https://peachworks-ini.github.io";
const COOKIE_NAME = "discord_oauth_state";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const corsHeaders = {
  "Access-Control-Allow-Origin": API_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

function json(data, status = 200) {
  return Response.json(data, { status, headers: corsHeaders });
}

function randomToken(bytes = 32) {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);

  return Array.from(array, b =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );

  return Array.from(new Uint8Array(digest), b =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

function redirectError(message) {
  const url = new URL(FRONTEND_URL);
  url.searchParams.set("discord_error", message);
  return Response.redirect(url.toString(), 302);
}

function getCookie(request, name) {
  const cookies = request.headers.get("Cookie") || "";

  const entry = cookies
    .split(";")
    .map(v => v.trim())
    .find(v => v.startsWith(`${name}=`));

  return entry ? entry.slice(name.length + 1) : null;
}

function clearStateCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/auth/discord; Max-Age=0`;
}

function handleName(discordUser) {
  return discordUser.global_name || discordUser.username;
}

async function exchangeCode(code, env) {
  const response = await fetch(
    "https://discord.com/api/v10/oauth2/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: CALLBACK_URL,
      }),
    }
  );

  if (!response.ok) {
    const result = await response.json().catch(() => ({}));

    console.error("Discord token exchange details:", {
      status: response.status,
      error: result.error || "unknown_error",
      errorDescription:
        result.error_description || "No description provided",
    });

    throw new Error("Discord token exchange failed");
  }

  return response.json();
}

async function getDiscordUser(accessToken) {
  const response = await fetch(
    "https://discord.com/api/v10/users/@me",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    console.error(
      "Discord profile request returned HTTP",
      response.status
    );
    throw new Error("Could not retrieve Discord profile");
  }

  return response.json();
}

async function createUserSession(discordId, env) {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + SESSION_TTL_SECONDS;

  await env.DB.prepare(
    "DELETE FROM user_sessions WHERE expires_at <= ?"
  ).bind(now).run();

  await env.DB.prepare(
    `INSERT INTO user_sessions (token_hash, discord_id, created_at, expires_at)
     VALUES (?, ?, ?, ?)`
  ).bind(tokenHash, discordId, now, expiresAt).run();

  return { token, expiresAt: expiresAt * 1000 };
}

function normalizeUser(user) {
  return {
    discordId: user.discord_id,
    discordHandle: user.discord_handle,
    mcUsername: user.minecraft_username,
    isAdmin: user.is_admin === 1,
  };
}

async function createLoginResponse(user, env) {
  const session = await createUserSession(user.discord_id, env);
  return json({ success: true, user: normalizeUser(user), session });
}

async function restoreUserSession(request, env) {
  const body = await request.json();
  const token = String(body.token || "").trim();
  if (!token) {
    return json({ error: "Session token is required." }, 400);
  }

  const tokenHash = await sha256(token);
  const now = Math.floor(Date.now() / 1000);
  const user = await env.DB.prepare(
    `SELECT u.discord_id, u.discord_handle, u.minecraft_username, u.is_admin,
            s.expires_at
     FROM user_sessions s
     JOIN users u ON u.discord_id = s.discord_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(tokenHash, now).first();

  if (!user) {
    await env.DB.prepare(
      "DELETE FROM user_sessions WHERE token_hash = ?"
    ).bind(tokenHash).run();
    return json({ error: "Session expired or invalid. Please log in again." }, 401);
  }

  return json({
    success: true,
    user: normalizeUser(user),
    session: { token, expiresAt: user.expires_at * 1000 },
  });
}

async function revokeUserSession(request, env) {
  const body = await request.json();
  const token = String(body.token || "").trim();
  if (token) {
    await env.DB.prepare(
      "DELETE FROM user_sessions WHERE token_hash = ?"
    ).bind(await sha256(token)).run();
  }
  return json({ success: true });
}

async function isGuildMember(discordId, env) {
  const response = await fetch(
    `https://discord.com/api/v10/guilds/${env.DISCORD_GUILD_ID}/members/${discordId}`,
    {
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      },
    }
  );

  if (response.status === 404) {
    return false;
  }

  if (!response.ok) {
    console.error(
      "Discord membership check returned HTTP",
      response.status
    );
    throw new Error("Could not verify Discord server membership");
  }

  return true;
}

async function discordCallback(request, env) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const savedState = getCookie(request, COOKIE_NAME);

  console.log("Discord OAuth state check:", {
    hasState: Boolean(state),
    hasSavedCookie: Boolean(savedState),
    stateMatches: Boolean(
      state && savedState && state === savedState
    ),
    hasCode: Boolean(code),
  });

  if (!state || !savedState || state !== savedState || !code) {
    return redirectError("discord_login_invalid");
  }

  try {
    const token = await exchangeCode(code, env);
    const discordUser = await getDiscordUser(token.access_token);

    if (!(await isGuildMember(discordUser.id, env))) {
      return redirectError("discord_server_required");
    }

    const exchangeCodeValue = randomToken();
    const codeHash = await sha256(exchangeCodeValue);
    const expiresAt = Math.floor(Date.now() / 1000) + 300;

    await env.DB.prepare(
      `INSERT INTO discord_oauth_codes
       (code_hash, discord_id, discord_handle, expires_at)
       VALUES (?, ?, ?, ?)`
    )
      .bind(
        codeHash,
        discordUser.id,
        handleName(discordUser),
        expiresAt
      )
      .run();

    const destination = new URL(FRONTEND_URL);
    destination.searchParams.set("discord_code", exchangeCodeValue);

    return new Response(null, {
      status: 302,
      headers: {
        Location: destination.toString(),
        "Set-Cookie": clearStateCookie(),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error(
      "Discord callback failed:",
      error instanceof Error ? error.message : "Unknown error"
    );

    return redirectError("discord_login_failed");
  }
}

async function exchangeLoginCode(request, env) {
  const body = await request.json();
  const code = String(body.code || "").trim();

  if (!code) {
    return json({ error: "Login code is required." }, 400);
  }

  const codeHash = await sha256(code);
  const now = Math.floor(Date.now() / 1000);

  const ticket = await env.DB.prepare(
    `SELECT discord_id, discord_handle, expires_at
     FROM discord_oauth_codes
     WHERE code_hash = ? AND expires_at > ?`
  )
    .bind(codeHash, now)
    .first();

  if (!ticket) {
    return json(
      { error: "Login code expired or invalid. Please try again." },
      401
    );
  }

  const user = await env.DB.prepare(
    `SELECT discord_handle, minecraft_username, is_admin
     FROM users WHERE discord_id = ?`
  )
    .bind(ticket.discord_id)
    .first();

  if (!user) {
    return json({ needsRegistration: true });
  }

  const consumed = await env.DB.prepare(
    `DELETE FROM discord_oauth_codes
     WHERE code_hash = ? AND expires_at > ?
     RETURNING code_hash`
  )
    .bind(codeHash, now)
    .first();

  if (!consumed) {
    return json(
      { error: "Login code already used. Please try again." },
      401
    );
  }

  return createLoginResponse({
    discord_id: ticket.discord_id,
    discord_handle: user.discord_handle,
    minecraft_username: user.minecraft_username,
    is_admin: user.is_admin,
  }, env);
}

async function registerUser(request, env) {
  const body = await request.json();
  const code = String(body.code || "").trim();
  const minecraft = String(body.minecraft || "").trim();

  if (!code || !minecraft) {
    return json(
      { error: "Login code and Minecraft username are required." },
      400
    );
  }

  if (
    minecraft.length > 32 ||
    !/^[A-Za-z0-9_]+$/.test(minecraft)
  ) {
    return json(
      { error: "Please enter a valid Minecraft username." },
      400
    );
  }

  const codeHash = await sha256(code);
  const now = Math.floor(Date.now() / 1000);

  const ticket = await env.DB.prepare(
    `DELETE FROM discord_oauth_codes
     WHERE code_hash = ? AND expires_at > ?
     RETURNING discord_id, discord_handle`
  )
    .bind(codeHash, now)
    .first();

  if (!ticket) {
    return json(
      {
        error:
          "Registration code expired or already used. Please log in again.",
      },
      401
    );
  }

  const existing = await env.DB.prepare(
    `SELECT discord_handle, minecraft_username, is_admin
     FROM users WHERE discord_id = ?`
  )
    .bind(ticket.discord_id)
    .first();

  if (existing) {
    return json(
      {
        error:
          "This Discord account is already registered. Please log in again.",
      },
      409
    );
  }

  try {
    await env.DB.prepare(
      `INSERT INTO users
       (discord_handle, minecraft_username, discord_id, is_admin)
       VALUES (?, ?, ?, 0)`
    )
      .bind(ticket.discord_handle, minecraft, ticket.discord_id)
      .run();
  } catch (error) {
    console.error(
      "User registration failed:",
      error instanceof Error ? error.message : "Unknown error"
    );

    return json(
      {
        error:
          "Could not register this account. An administrator may need to link an existing record.",
      },
      409
    );
  }

  return createLoginResponse({
    discord_id: ticket.discord_id,
    discord_handle: ticket.discord_handle,
    minecraft_username: minecraft,
    is_admin: 0,
  }, env);
}

// Announcement delivery is independent of the OAuth application's credentials.
const FIREBASE_PROJECT = 'accs-voting';
const FIREBASE_PUBLIC_API_KEY = 'AIzaSyCvHwtJJJDF1fpQ2ipDOLRBPjUahhpfUn0';
const ANNOUNCEMENT_GUILD = '1466505553042739363';
const ANNOUNCEMENT_CHANNEL = '1562476088163172423';
const ALLOWED_TAGS = ['Quality of Life', 'Client-side', 'Building', 'Visuals', 'Adventure', 'Fun'];

class AnnouncementError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function excerpt(value, max = 100) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if ([...text].length <= max) return text;
  let cut = [...text].slice(0, max - 1).join('');
  const boundary = cut.lastIndexOf(' ');
  if (boundary > 0) cut = cut.slice(0, boundary);
  return cut.trimEnd() + '…';
}

function discordText(value, max) {
  // Suppress user-authored Markdown and mention syntax inside embeds.
  return excerpt(String(value || '').replace(/[\\`*_~|<>\[\]]/g, '').replace(/@/g, '＠'), max);
}

export function announcementPayload(id, suggestion, user) {
  const link = new URL(FRONTEND_URL);
  link.searchParams.set('suggestion', id);
  const tags = ALLOWED_TAGS.filter(tag => suggestion.tags.includes(tag));
  return {
    allowed_mentions: { parse: [] },
    nonce: `vote-${id}`, enforce_nonce: true,
    embeds: [{
      color: 0x8064f4,
      author: { name: 'ACCS Voting Portal' },
      title: `💡 ${discordText(suggestion.title, 100)}`,
      description: discordText(suggestion.body, 100),
      fields: [
        { name: 'Submitted by', value: discordText(user.discord_handle || user.minecraft_username, 100), inline: true },
        { name: 'Tags', value: tags.join(' · ') || 'No tags', inline: true },
        { name: 'Voting closes', value: `<t:${Math.floor((suggestion.createdAt + 604800000) / 1000)}:R>`, inline: false }
      ],
      footer: { text: 'ACCSVotePortal • New community suggestion' }
    }],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: 'View & Vote', url: link.toString() }] }]
  };
}

function firestoreValue(value) {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(firestoreValue);
  return null;
}

async function announcementSession(token, env) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new AnnouncementError('Please log in again.', 401);
  const user = await env.DB.prepare(
    `SELECT u.discord_id, u.discord_handle, u.minecraft_username, u.is_admin
     FROM user_sessions s JOIN users u ON u.discord_id = s.discord_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(await sha256(token), Math.floor(Date.now() / 1000)).first();
  if (!user) throw new AnnouncementError('Please log in again.', 401);
  return user;
}

async function savedSuggestion(id, firebaseToken) {
  if (typeof firebaseToken !== 'string' || firebaseToken.length > 8192) throw new AnnouncementError('Firebase sign-in is required.', 401);
  const identity = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_PUBLIC_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: firebaseToken }), signal: AbortSignal.timeout(10000)
  });
  if (!identity.ok) throw new AnnouncementError('Firebase sign-in could not be verified.', 401);
  const uid = (await identity.json()).users?.[0]?.localId;
  if (!uid) throw new AnnouncementError('Firebase sign-in could not be verified.', 401);
  // Firestore validates the token and applies the existing project's security rules.
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/artifacts/accs-voting-portal/public/data/suggestions/${id}`, {
    headers: { Authorization: `Bearer ${firebaseToken}` }, signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new AnnouncementError('The saved suggestion could not be read.', response.status === 404 ? 404 : 403);
  const document = await response.json();
  const suggestion = Object.fromEntries(Object.entries(document.fields || {}).map(([key, value]) => [key, firestoreValue(value)]));
  return { suggestion, uid };
}

export function validateSuggestion(suggestion, uid, user, now = Date.now()) {
  if (suggestion.authorUid !== uid || suggestion.authorAccountKey !== user.minecraft_username.trim().toLowerCase()) {
    throw new AnnouncementError('You can only announce your own saved suggestion.', 403);
  }
  if (suggestion.status !== 'active' || !Number.isFinite(suggestion.createdAt) || suggestion.createdAt > now + 60000 || now - suggestion.createdAt > 604800000) {
    throw new AnnouncementError('Only current active suggestions can be announced.', 409);
  }
  if (typeof suggestion.title !== 'string' || !suggestion.title.trim() || suggestion.title.length > 100 || typeof suggestion.body !== 'string' || !suggestion.body.trim()) {
    throw new AnnouncementError('The saved suggestion has invalid content.');
  }
  if (!Array.isArray(suggestion.tags)) suggestion.tags = [];
}

export async function queueAnnouncement(request, env) {
  if (request.headers.get('Origin') !== API_ORIGIN) throw new AnnouncementError('Origin not allowed.', 403);
  if (!env.DISCORD_ANNOUNCEMENT_BOT_TOKEN) throw new AnnouncementError('Discord announcements are not configured yet.', 503);
  const raw = await request.text();
  if (raw.length > 16384) throw new AnnouncementError('Request too large.', 413);
  let body;
  try { body = JSON.parse(raw); } catch { throw new AnnouncementError('Invalid request.'); }
  const id = body.suggestionId;
  if (typeof id !== 'string' || !/^[A-Za-z0-9]{20}$/.test(id)) throw new AnnouncementError('Invalid suggestion ID.');
  const user = await announcementSession(body.token, env);
  if (!(await isGuildMember(user.discord_id, env))) throw new AnnouncementError('Discord server membership is required.', 403);
  let row = await env.DB.prepare('SELECT * FROM discord_announcements WHERE suggestion_id = ?').bind(id).first();
  if (row && row.discord_id !== user.discord_id) throw new AnnouncementError('This suggestion belongs to another account.', 403);
  if (!row) {
    const { suggestion, uid } = await savedSuggestion(id, body.firebaseToken);
    validateSuggestion(suggestion, uid, user);
    const channel = await fetch(`https://discord.com/api/v10/channels/${ANNOUNCEMENT_CHANNEL}`, {
      headers: { Authorization: `Bot ${env.DISCORD_ANNOUNCEMENT_BOT_TOKEN}` }, signal: AbortSignal.timeout(10000)
    });
    if (!channel.ok) throw new AnnouncementError('The announcement channel is unavailable.', 503);
    const info = await channel.json();
    if (info.guild_id !== ANNOUNCEMENT_GUILD || ![0, 5].includes(info.type)) throw new AnnouncementError('Announcement channel configuration is invalid.', 503);
    const now = Date.now();
    const payload = JSON.stringify(announcementPayload(id, suggestion, user));
    // One atomic statement enforces deduplication and a per-Discord-account cap.
    await env.DB.prepare(`INSERT OR IGNORE INTO discord_announcements
      (suggestion_id, discord_id, channel_id, payload, state, created_at, updated_at, next_attempt_at)
      SELECT ?, ?, ?, ?, 'pending', ?, ?, ?
      WHERE (SELECT COUNT(*) FROM discord_announcements WHERE discord_id = ? AND created_at > ?) < 6`
    ).bind(id, user.discord_id, ANNOUNCEMENT_CHANNEL, payload, now, now, now, user.discord_id, now - 3600000).run();
    row = await env.DB.prepare('SELECT * FROM discord_announcements WHERE suggestion_id = ?').bind(id).first();
    if (!row) throw new AnnouncementError('Announcement limit reached. Try again later.', 429);
    if (row.discord_id !== user.discord_id) throw new AnnouncementError('This suggestion belongs to another account.', 403);
  }
  if (row.state === 'pending') await deliverAnnouncement(id, env);
  row = await env.DB.prepare('SELECT state FROM discord_announcements WHERE suggestion_id = ?').bind(id).first();
  if (row.state === 'failed' || row.state === 'uncertain') {
    return json({ success: false, state: row.state, error: 'Suggestion saved. Discord delivery needs administrator attention.' }, 409);
  }
  return json({ success: true, state: row.state }, row.state === 'sent' ? 200 : 202);
}

export async function deliverAnnouncement(id, env) {
  const now = Date.now();
  const row = await env.DB.prepare(`UPDATE discord_announcements SET state = 'sending', updated_at = ?, attempts = attempts + 1
    WHERE suggestion_id = ? AND state = 'pending' AND next_attempt_at <= ? RETURNING *`).bind(now, id, now).first();
  if (!row) return;
  let response;
  try {
    response = await fetch(`https://discord.com/api/v10/channels/${row.channel_id}/messages`, {
      method: 'POST', headers: { Authorization: `Bot ${env.DISCORD_ANNOUNCEMENT_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: row.payload, signal: AbortSignal.timeout(10000)
    });
  } catch {
    // A timeout may occur after Discord accepted the post. Do not blindly resend.
    await env.DB.prepare("UPDATE discord_announcements SET state = 'uncertain', last_error = 'Network outcome unknown', updated_at = ? WHERE suggestion_id = ? AND state = 'sending'").bind(Date.now(), id).run();
    return;
  }
  if (response.ok) {
    const message = await response.json();
    if (!message.id) throw new Error('Discord response missing message ID');
    await env.DB.prepare("UPDATE discord_announcements SET state = 'sent', message_id = ?, updated_at = ?, last_error = NULL WHERE suggestion_id = ? AND state = 'sending'").bind(message.id, Date.now(), id).run();
  } else if (response.status === 429 && row.attempts < 6) {
    const data = await response.json().catch(() => ({}));
    const delay = Math.max(1000, Number(data.retry_after || 60) * 1000);
    await env.DB.prepare("UPDATE discord_announcements SET state = 'pending', next_attempt_at = ?, updated_at = ?, last_error = 'Discord rate limit' WHERE suggestion_id = ? AND state = 'sending'").bind(Date.now() + delay, Date.now(), id).run();
  } else {
    const state = response.status >= 500 ? 'uncertain' : 'failed';
    await env.DB.prepare("UPDATE discord_announcements SET state = ?, last_error = ?, updated_at = ? WHERE suggestion_id = ? AND state = 'sending'").bind(state, `Discord HTTP ${response.status}`, Date.now(), id).run();
  }
}

export async function drainAnnouncements(env) {
  if (!env.DISCORD_ANNOUNCEMENT_BOT_TOKEN) return;
  // An interrupted send has an unknown outcome; leave it for operator review.
  await env.DB.prepare("UPDATE discord_announcements SET state = 'uncertain', last_error = 'Interrupted delivery', updated_at = ? WHERE state = 'sending' AND updated_at < ?").bind(Date.now(), Date.now() - 60000).run();
  const rows = await env.DB.prepare("SELECT suggestion_id FROM discord_announcements WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY created_at LIMIT 10").bind(Date.now()).all();
  for (const row of rows.results || []) await deliverAnnouncement(row.suggestion_id, env);
}

// Admin review reminders use read-only server credentials, never browser sessions.
const ADMIN_REVIEW_CHANNEL = '1497835434355720242';
let reviewAccessToken = null;

export function reviewReminderSlot(at = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(at).map(part => [part.type, part.value]));
  if (!['08', '20'].includes(parts.hour)) return null;
  return `${parts.year}-${parts.month}-${parts.day}-${parts.hour}`;
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export async function reviewFirestoreToken(env) {
  if (reviewAccessToken && reviewAccessToken.until > Date.now() + 60000) return reviewAccessToken.token;
  const account = JSON.parse(env.FIREBASE_REVIEW_SERVICE_ACCOUNT || '{}');
  if (account.project_id !== FIREBASE_PROJECT || !account.client_email || !account.private_key) throw new Error('Configure the read-only FIREBASE_REVIEW_SERVICE_ACCOUNT secret.');
  const encode = value => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const now = Math.floor(Date.now() / 1000);
  const unsigned = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({
    iss: account.client_email, scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  });
  const pem = account.private_key.replace(/-----[^-]+-----|\s/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + base64url(new Uint8Array(signature)) }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`Review credentials rejected: HTTP ${response.status}`);
  const data = await response.json();
  if (!data.access_token) throw new Error('Review credentials returned no access token.');
  reviewAccessToken = { token: data.access_token, until: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return reviewAccessToken.token;
}

export async function loadPendingReviews(env) {
  const token = await reviewFirestoreToken(env);
  const pending = [];
  let cursor;
  for (let page = 0; page < 100; page++) {
    const structuredQuery = {
      select: { fields: ['title', 'status', 'reviewStatus', 'moderatorFinalizedAt', 'createdAt', 'reviewStartedAt', 'resolvedAt'].map(fieldPath => ({ fieldPath })) },
      from: [{ collectionId: 'suggestions' }],
      where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'passed' } } },
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }], limit: 100,
      ...(cursor ? { startAt: { values: [{ referenceValue: cursor }], before: false } } : {})
    };
    const response = await fetch(`https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/artifacts/accs-voting-portal/public/data:runQuery`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery }), signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`Pending review read failed: HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('Unexpected pending review response.');
    const docs = data.filter(row => row.document).map(row => row.document);
    for (const document of docs) {
      const s = Object.fromEntries(Object.entries(document.fields || {}).map(([key, value]) => [key, firestoreValue(value)]));
      if (s.status === 'passed' && s.reviewStatus !== 'finalized' && !s.moderatorFinalizedAt) pending.push({ id: document.name.split('/').at(-1), ...s });
    }
    if (docs.length < 100) return pending.sort((a,b) => Number(a.reviewStartedAt || a.resolvedAt || a.createdAt || 0) - Number(b.reviewStartedAt || b.resolvedAt || b.createdAt || 0));
    const next = docs.at(-1).name;
    if (next === cursor) throw new Error('Pending review pagination did not advance.');
    cursor = next;
  }
  throw new Error('Pending review page limit exceeded; reminder not sent.');
}

export function reviewReminderPayload(slot, reviews) {
  return {
    allowed_mentions: { parse: [] }, nonce: `review-${slot.replace(/-/g, '')}`, enforce_nonce: true,
    embeds: [{ color: 0x8064f4, title: '📋 Suggestions awaiting admin review',
      description: `**${reviews.length} ${reviews.length === 1 ? 'suggestion needs' : 'suggestions need'} moderator review.**\n\n` +
        reviews.slice(0, 10).map(s => `• ${discordText(s.title, 100)}`).join('\n') +
        (reviews.length > 10 ? `\n\nAnd ${reviews.length - 10} more in Pending Reviews.` : ''),
      footer: { text: 'ACCSVotePortal • 8 AM / 8 PM Pacific reminder' }
    }],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Open Pending Reviews', url: FRONTEND_URL + '?view=admin-view' }] }]
  };
}

export async function queueReviewReminder(env, at = new Date()) {
  if (env.ADMIN_REVIEW_REMINDERS_ENABLED !== 'true') return;
  const slot = reviewReminderSlot(at);
  if (!slot) return;
  if (!env.DISCORD_ANNOUNCEMENT_BOT_TOKEN || !env.FIREBASE_REVIEW_SERVICE_ACCOUNT) throw new Error('Admin review reminder secrets are missing.');
  const id = `admin-review-${slot}`;
  if (await env.DB.prepare('SELECT slot FROM admin_review_reminder_runs WHERE slot = ?').bind(slot).first()) return;
  const reviews = await loadPendingReviews(env);
  const now = Date.now();
  if (!reviews.length) {
    await env.DB.prepare('INSERT OR IGNORE INTO admin_review_reminder_runs(slot, checked_at, pending_count) VALUES (?, ?, 0)').bind(slot, now).run();
    return;
  }
  const channel = await fetch(`https://discord.com/api/v10/channels/${ADMIN_REVIEW_CHANNEL}`, {
    headers: { Authorization: `Bot ${env.DISCORD_ANNOUNCEMENT_BOT_TOKEN}` }, signal: AbortSignal.timeout(10000)
  });
  if (!channel.ok) throw new Error(`Admin reminder channel unavailable: HTTP ${channel.status}`);
  const info = await channel.json();
  if (info.guild_id !== ANNOUNCEMENT_GUILD || ![0, 5].includes(info.type)) throw new Error('Admin reminder channel is not in the configured server.');
  const payload = JSON.stringify(reviewReminderPayload(slot, reviews));
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO discord_announcements
      (suggestion_id, discord_id, channel_id, payload, state, created_at, updated_at, next_attempt_at)
      VALUES (?, 'scheduled-admin-reminder', ?, ?, 'pending', ?, ?, ?)`)
      .bind(id, ADMIN_REVIEW_CHANNEL, payload, now, now, now),
    env.DB.prepare('INSERT OR IGNORE INTO admin_review_reminder_runs(slot, checked_at, pending_count) VALUES (?, ?, ?)').bind(slot, now, reviews.length)
  ]);
  await deliverAnnouncement(id, env);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.allSettled([
      drainAnnouncements(env),
      queueReviewReminder(env, new Date(event.scheduledTime || Date.now()))
    ]).then(results => {
      results.forEach((result, index) => {
        if (result.status === 'rejected') console.error(index === 0 ? 'Announcement queue check failed.' : 'Admin reminder check failed: ' + String(result.reason?.message || 'Unknown error'));
      });
    }));
  },
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    if (request.method === "POST" && url.pathname === "/suggestions/announce") {
      try { return await queueAnnouncement(request, env); }
      catch (error) {
        if (error instanceof AnnouncementError) return json({ error: error.message }, error.status);
        console.error('Announcement request failed. Inspect delivery state before retrying.');
        return json({ error: 'Suggestion saved, but the announcement could not be confirmed.' }, 503);
      }
    }

    if (
      request.method === "GET" &&
      url.pathname === "/auth/discord/start"
    ) {
      const state = randomToken();
      const authorize = new URL(
        "https://discord.com/oauth2/authorize"
      );

      authorize.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("redirect_uri", CALLBACK_URL);
      authorize.searchParams.set("scope", "identify");
      authorize.searchParams.set("state", state);

      return new Response(null, {
        status: 302,
        headers: {
          Location: authorize.toString(),
          "Set-Cookie":
            `${COOKIE_NAME}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/auth/discord; Max-Age=600`,
          "Cache-Control": "no-store",
        },
      });
    }

    if (
      request.method === "GET" &&
      url.pathname === "/auth/discord/callback"
    ) {
      const response = await discordCallback(request, env);
      const headers = new Headers(response.headers);

      headers.append("Set-Cookie", clearStateCookie());

      return new Response(response.body, {
        status: response.status,
        headers,
      });
    }

    if (
      request.method === "POST" &&
      url.pathname === "/auth/discord/exchange"
    ) {
      try {
        return await exchangeLoginCode(request, env);
      } catch (error) {
        console.error(
          "Login code exchange failed:",
          error instanceof Error ? error.message : "Unknown error"
        );

        return json({ error: "Could not complete login." }, 500);
      }
    }

    if (
      request.method === "POST" &&
      url.pathname === "/auth/discord/register"
    ) {
      try {
        return await registerUser(request, env);
      } catch (error) {
        console.error(
          "Registration request failed:",
          error instanceof Error ? error.message : "Unknown error"
        );

        return json({ error: "Could not register account." }, 500);
      }
    }

    if (
      request.method === "POST" &&
      url.pathname === "/auth/session"
    ) {
      try {
        return await restoreUserSession(request, env);
      } catch (error) {
        console.error(
          "Session restore failed:",
          error instanceof Error ? error.message : "Unknown error"
        );
        return json({ error: "Could not restore session." }, 500);
      }
    }

    if (
      request.method === "POST" &&
      url.pathname === "/auth/session/logout"
    ) {
      try {
        return await revokeUserSession(request, env);
      } catch (error) {
        console.error(
          "Session revocation failed:",
          error instanceof Error ? error.message : "Unknown error"
        );
        return json({ error: "Could not revoke session." }, 500);
      }
    }

    return json({ error: "Not found" }, 404);
  },
};
