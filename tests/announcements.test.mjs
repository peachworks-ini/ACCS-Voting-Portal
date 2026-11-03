import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

const workerSource = readFileSync(new URL('../worker/index.mjs', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../worker/migrations/0001_discord_announcements.sql', import.meta.url), 'utf8');
async function fixture(mode = 'ok') {
  const sql = new DatabaseSync(':memory:');
  sql.exec(migration + `
    CREATE TABLE users(discord_id TEXT PRIMARY KEY, discord_handle TEXT, minecraft_username TEXT, is_admin INTEGER);
    CREATE TABLE user_sessions(token_hash TEXT, discord_id TEXT, expires_at INTEGER);
    INSERT INTO users VALUES ('member','Alex','AlexMC',0);
  `);
  const DB = { prepare(query) { return { bind(...args) {
    const stmt = sql.prepare(query);
    return {
      first: async () => stmt.get(...args) || null,
      all: async () => ({ results: stmt.all(...args) }),
      run: async () => ({ meta: { changes: stmt.run(...args).changes } })
    };
  }, async all() { return { results: sql.prepare(query).all() }; } }; } };
  const id = 'AbCdEfGhIjKlMnOpQrSt';
  const suggestion = { authorUid: 'uid', authorAccountKey: 'alexmc', title: 'Beginner training', body: 'A small training area near spawn would help new players learn battle mechanics, practice battles, and prepare for tournaments.', tags: ['Quality of Life', 'Building'], status: 'active', createdAt: Date.now() };
  const encoded = value => typeof value === 'string' ? { stringValue: value } : Array.isArray(value) ? { arrayValue: { values: value.map(encoded) } } : { integerValue: String(value) };
  let sends = 0;
  let lastPayload;
  const context = { crypto: webcrypto, TextEncoder, Response, Request, Headers, URL, URLSearchParams, AbortSignal, console,
    fetch: async (url, options) => {
      if (url.includes('/members/')) return new Response('{}', { status: mode === 'nonmember' ? 404 : 200 });
      if (url.includes('accounts:lookup')) return Response.json({ users: [{ localId: 'uid' }] });
      if (url.includes('firestore.googleapis.com')) return Response.json({ fields: Object.fromEntries(Object.entries(suggestion).map(([k, v]) => [k, encoded(v)])) });
      if (url.endsWith('/messages')) {
        sends++;
        lastPayload = JSON.parse(options.body);
        if (mode === 'timeout') throw new Error('Timeout');
        if (mode === 'rate') return Response.json({ retry_after: 60 }, { status: 429 });
        if (mode === 'forbidden') return new Response('{}', { status: 403 });
        return Response.json({ id: 'message-id' });
      }
      return Response.json({ guild_id: '1466505553042739363', type: 0 });
    }
  };
  vm.createContext(context);
  vm.runInContext(workerSource.replace('export default ', 'const worker = ').replace(/export /g, '') + '\nthis.api = {worker,queueAnnouncement,deliverAnnouncement,drainAnnouncements,sha256,excerpt,announcementPayload,validateSuggestion};', context);
  const token = 'a'.repeat(64);
  sql.prepare('INSERT INTO user_sessions VALUES(?,?,?)').run(await context.api.sha256(token), 'member', Math.floor(Date.now() / 1000) + 3600);
  const env = { DB, DISCORD_BOT_TOKEN: 'existing-login-token', DISCORD_GUILD_ID: '1466505553042739363', DISCORD_ANNOUNCEMENT_BOT_TOKEN: 'test-secret' };
  const request = (overrides = {}, origin = 'https://peachworks-ini.github.io') => new Request('https://example.com/suggestions/announce', { method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ token, firebaseToken: 'firebase-token', suggestionId: id, ...overrides }) });
  return { ...context.api, sql, env, suggestion, id, request, sends: () => sends, payload: () => lastPayload, setMode: value => { mode = value; } };
}

let f = await fixture();
let response = await f.worker.fetch(f.request(), f.env);
assert.equal(response.status, 200);
assert.equal((await response.json()).state, 'sent');
assert.equal(f.sends(), 1);
assert.ok(f.payload().embeds[0].description.length <= 100);
assert.ok(f.payload().embeds[0].description.endsWith('…'));
assert.equal(new URL(f.payload().components[0].components[0].url).searchParams.get('suggestion'), f.id);
assert.deepEqual(f.payload().allowed_mentions.parse, []);
await f.worker.fetch(f.request(), f.env);
assert.equal(f.sends(), 1, 'Repeated request must not resend');
f.sql.close();

f = await fixture();
await Promise.all([f.worker.fetch(f.request(), f.env), f.worker.fetch(f.request(), f.env)]);
assert.equal(f.sends(), 1, 'Concurrent requests must only claim one delivery');
f.sql.close();

for (const [mode, state] of [['timeout', 'uncertain'], ['forbidden', 'failed'], ['rate', 'pending']]) {
  f = await fixture(mode);
  await f.worker.fetch(f.request(), f.env);
  assert.equal(f.sql.prepare('SELECT state FROM discord_announcements').get().state, state);
  await f.worker.fetch(f.request(), f.env);
  assert.equal(f.sends(), 1, 'No immediate repeat after a failure or rate limit');
  if (mode === 'rate') {
    f.sql.prepare('UPDATE discord_announcements SET next_attempt_at = 0').run();
    f.setMode('ok');
    await f.drainAnnouncements(f.env);
    assert.equal(f.sends(), 2);
    assert.equal(f.sql.prepare('SELECT state FROM discord_announcements').get().state, 'sent');
  }
  f.sql.close();
}

f = await fixture('nonmember');
assert.equal((await f.worker.fetch(f.request(), f.env)).status, 403);
assert.equal(f.sends(), 0);
f.sql.close();

f = await fixture();
assert.equal((await f.worker.fetch(f.request({ token: 'bad' }), f.env)).status, 401);
assert.equal((await f.worker.fetch(f.request({}, 'https://attacker.example'), f.env)).status, 403);
f.suggestion.authorAccountKey = 'someone-else';
assert.equal((await f.worker.fetch(f.request(), f.env)).status, 403);
assert.equal(f.sends(), 0);
f.sql.close();

f = await fixture();
f.suggestion.authorUid = 'other-firebase-user';
assert.equal((await f.worker.fetch(f.request(), f.env)).status, 403);
f.suggestion.authorUid = 'uid';
f.suggestion.status = 'failed';
assert.equal((await f.worker.fetch(f.request(), f.env)).status, 409);
assert.equal(f.sends(), 0);
f.sql.close();

f = await fixture();
for (let i = 0; i < 6; i++) f.sql.prepare("INSERT INTO discord_announcements(suggestion_id,discord_id,channel_id,payload,state,created_at,updated_at,next_attempt_at) VALUES(?,?,?,'{}','sent',?,?,?)").run(`old-${i}`, 'member', 'channel', Date.now(), Date.now(), Date.now());
assert.equal((await f.worker.fetch(f.request(), f.env)).status, 429);
assert.equal(f.sends(), 0);
f.sql.close();
console.log('Announcement tests passed: auth, ownership, membership, rate cap, concurrent deduplication, delivery states, retry, embed, and direct link.');
