import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = readFileSync(new URL('../worker/index.mjs', import.meta.url), 'utf8');
const sql = new DatabaseSync(':memory:');
for (const file of ['0001_discord_announcements.sql','0002_admin_review_reminders.sql']) sql.exec(readFileSync(new URL('../worker/migrations/'+file, import.meta.url),'utf8'));
const DB = { prepare(query) {
  const bound = args => ({ bind: (...values) => bound(values),
    first: async () => sql.prepare(query).get(...args) || null,
    run: async () => sql.prepare(query).run(...args),
    all: async () => ({results: sql.prepare(query).all(...args)}) });
  return bound([]);
}, async batch(statements) {
  sql.exec('BEGIN');
  try { const results=[]; for(const stmt of statements) results.push(await stmt.run()); sql.exec('COMMIT');return results; }
  catch(error) {sql.exec('ROLLBACK');throw error;}
}};
let sends = 0;
let pages;
let fetchError = false;
let lastPayload;
const ctx = { console, crypto:webcrypto, TextEncoder, URL, URLSearchParams, Response, Request, Headers, AbortSignal, atob, btoa,
  fetch: async (url, options) => {
    if(url.includes(':runQuery')) {
      if(fetchError) return new Response('{}',{status:403});
      return Response.json(pages.shift() || []);
    }
    if(url.endsWith('/messages')) { sends++;lastPayload=JSON.parse(options.body);return Response.json({id:'sent-id'}); }
    return Response.json({guild_id:'1466505553042739363',type:0});
  }
};
vm.createContext(ctx);
vm.runInContext(source.replace('export default ', 'const worker = ').replace(/export /g,'') + '\nreviewFirestoreToken = async()=>"read-only-test-token"; this.api={reviewReminderSlot,reviewReminderPayload,queueReviewReminder,loadPendingReviews};',ctx);
const api=ctx.api;
assert.equal(api.reviewReminderSlot(new Date('2026-11-03T16:00:00Z')),'2026-11-03-08');
assert.equal(api.reviewReminderSlot(new Date('2026-11-04T04:00:00Z')),'2026-11-03-20');
assert.equal(api.reviewReminderSlot(new Date('2026-07-03T15:00:00Z')),'2026-07-03-08');
assert.equal(api.reviewReminderSlot(new Date('2026-07-04T03:00:00Z')),'2026-07-03-20');
assert.equal(api.reviewReminderSlot(new Date('2026-11-03T15:00:00Z')),null);
assert.equal(api.reviewReminderSlot(new Date('2027-03-14T15:00:00Z')),'2027-03-14-08');
assert.equal(api.reviewReminderSlot(new Date('2026-11-01T16:00:00Z')),'2026-11-01-08');
const doc=(id,finalized=false)=>({document:{name:'projects/accs-voting/databases/(default)/documents/artifacts/accs-voting-portal/public/data/suggestions/'+id,fields:{title:{stringValue:'Review @everyone **test**'},status:{stringValue:'passed'},reviewStatus:{stringValue:finalized?'finalized':'pending'},createdAt:{integerValue:'123'}}}});
const env={DB,ADMIN_REVIEW_REMINDERS_ENABLED:'true',FIREBASE_REVIEW_SERVICE_ACCOUNT:'configured',DISCORD_ANNOUNCEMENT_BOT_TOKEN:'test-token'};
pages=[[doc('one'),doc('two',true)]];
await api.queueReviewReminder(env,new Date('2026-11-03T16:00:00Z'));
assert.equal(sends,1);
assert.ok(lastPayload.embeds[0].description.includes('1 suggestion needs'));
assert.ok(!lastPayload.embeds[0].description.includes('@everyone'));
assert.equal(lastPayload.allowed_mentions.parse.length,0);
assert.equal(sql.prepare('SELECT channel_id FROM discord_announcements').get().channel_id,'1497835434355720242');
await api.queueReviewReminder(env,new Date('2026-11-03T16:05:00Z'));
assert.equal(sends,1,'Repeated five-minute triggers must not repeat a reminder');
pages=[[]];
await api.queueReviewReminder(env,new Date('2026-11-04T04:00:00Z'));
assert.equal(sends,1,'Empty queue must not post');
assert.equal(sql.prepare("SELECT pending_count FROM admin_review_reminder_runs WHERE slot='2026-11-03-20'").get().pending_count,0);
fetchError=true;
await assert.rejects(()=>api.queueReviewReminder(env,new Date('2026-11-04T16:00:00Z')),/403/);
assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM admin_review_reminder_runs WHERE slot='2026-11-04-08'").get().n,0,'Read failure must not be recorded as an empty queue');
fetchError=false;pages=[[doc('retry')]];
await api.queueReviewReminder(env,new Date('2026-11-04T16:05:00Z'));
assert.equal(sends,2,'Failed reads can retry within the scheduled hour');
pages=[Array.from({length:100},(_,i)=>doc('page1-'+i)),[doc('page2')]];
assert.equal((await api.loadPendingReviews(env)).length,101);
const large=api.reviewReminderPayload('2026-11-05-08',Array.from({length:20},()=>({title:'A'.repeat(200)})));
assert.ok(JSON.stringify(large).length<6000);
assert.ok(large.embeds[0].description.includes('10 more'));
assert.ok(large.nonce.length<=25);
assert.equal(large.components[0].components[0].url,'https://peachworks-ini.github.io/ACCS-Voting-Portal/?view=admin-view');
await api.queueReviewReminder({...env,ADMIN_REVIEW_REMINDERS_ENABLED:'false'},new Date('2026-11-05T16:00:00Z'));
assert.equal(sends,2,'Disabled feature must not send');
// Exercise the service-account signing flow with an ephemeral test key.
const keyPair = await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const pkcs8=await webcrypto.subtle.exportKey('pkcs8',keyPair.privateKey);
const privateKey='-----BEGIN PRIVATE KEY-----\n'+Buffer.from(pkcs8).toString('base64')+'\n-----END PRIVATE KEY-----';
let exchanges=0;
const signingCtx={...ctx,fetch:async(url,options)=>{
  assert.equal(url,'https://oauth2.googleapis.com/token');
  const jwt=options.body.get('assertion');
  const parts=jwt.split('.');
  const claims=JSON.parse(Buffer.from(parts[1],'base64url').toString());
  assert.equal(claims.iss,'test@accs-voting.iam.gserviceaccount.com');
  assert.equal(claims.scope,'https://www.googleapis.com/auth/datastore');
  assert.ok(await webcrypto.subtle.verify('RSASSA-PKCS1-v1_5',keyPair.publicKey,Buffer.from(parts[2],'base64url'),new TextEncoder().encode(parts[0]+'.'+parts[1])));
  exchanges++;return Response.json({access_token:'signed-test-token',expires_in:3600});
}};
vm.createContext(signingCtx);
vm.runInContext(source.replace('export default ','const worker = ').replace(/export /g,'')+'\nthis.getToken=reviewFirestoreToken;',signingCtx);
const signingEnv={FIREBASE_REVIEW_SERVICE_ACCOUNT:JSON.stringify({project_id:'accs-voting',client_email:'test@accs-voting.iam.gserviceaccount.com',private_key:privateKey})};
assert.equal(await signingCtx.getToken(signingEnv),'signed-test-token');
assert.equal(await signingCtx.getToken(signingEnv),'signed-test-token');
assert.equal(exchanges,1,'Cache access tokens until refresh is required');
sql.close();
console.log('Admin reminder tests passed: Pacific/DST schedule, deduplication, empty queue, read failure/retry, pagination, finalized exclusion, mention suppression, and channel.');
