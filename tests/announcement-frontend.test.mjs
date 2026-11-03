import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const messages = [];
const requests = [];
let fail = false;
const context = { window: {}, console: { warn() {} }, AbortSignal,
  auth: { currentUser: { getIdToken: async () => 'firebase-token' } },
  fetch: async (url, options) => {
    requests.push({url, body: JSON.parse(options.body)});
    return { ok: !fail, json: async () => fail ? { error: 'Unavailable' } : { success: true, state: 'sent' } };
  }
};
vm.createContext(context);
vm.runInContext(html.slice(html.indexOf('window.app = {'), html.indexOf('    const app = window.app;')) + '\nvar app = window.app;', context);
const app = context.app;
app.readSavedSession = () => ({ token: 'portal-session' });
app.msg = (title, body) => messages.push({title, body});
assert.equal(await app.announceSuggestion('test-id', true), true);
assert.equal(messages.length, 0, 'Automatic success should not interrupt navigation');
assert.equal(requests[0].body.suggestionId, 'test-id');
assert.equal(requests[0].body.firebaseToken, 'firebase-token');
assert.equal(requests[0].body.token, 'portal-session');
assert.ok(!('body' in requests[0].body), 'Browser must not supply announcement text');
await app.announceSuggestion('test-id');
assert.equal(messages.at(-1).title, 'Discord Announcement');
fail = true;
assert.equal(await app.announceSuggestion('test-id', true), false);
assert.equal(messages.at(-1).title, 'Suggestion Saved', 'Delivery failure must preserve submission success');
context.auth.currentUser = null;
const count = requests.length;
assert.equal(await app.announceSuggestion('test-id'), false);
assert.equal(requests.length, count, 'No request without Firebase sign-in');
console.log('Frontend announcement checks passed: payload, success, failure isolation, and missing credentials.');
