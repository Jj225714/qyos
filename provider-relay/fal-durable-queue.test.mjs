import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { FalJobService, JsonJobStore } from './job-service.mjs';

const key = Buffer.alloc(32, 17), credential = 'fake-fal-secret-only';
const input = (id, model = 'flux-fill') => ({ model, credential, idempotencyKey: id, payload: { prompt: 'private-test-prompt', image_url: 'data:image/png;base64,private-image' } });
const until = async fn => { for (let i = 0; i < 500; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('condition timed out'); };
async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fal-durable-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'jobs.json'), calls = [];
  const provider = {
    submit: async (model, payload, auth) => { calls.push({ model, payload, auth }); return { request_id: `p${calls.length}` }; },
    status: async () => ({ status: 'COMPLETED' }), result: async () => ({ images: [] }), cancel: async () => ({}),
    ...options.provider,
  };
  const make = extra => new FalJobService({ store: new JsonJobStore(path), provider, queueKey: key, pollDelayMs: 1, ...options, provider, ...extra });
  return { path, calls, make, provider };
}

test('five waiting jobs respect channel/model caps, cancel locally and deduplicate', async t => {
  const gates = [];
  const f = await setup(t, { modelLimits: { 'flux-fill': 1 }, provider: { status: () => new Promise(r => gates.push(r)) } });
  const s = f.make(); s.schedule = () => {};
  const jobs = [];
  for (let i = 0; i < 5; i++) jobs.push(await s.create(input(`k${i}`, i === 3 ? 'esrgan' : 'flux-fill')));
  assert.equal(f.calls.length, 0);
  assert.equal((await s.create(input('k0'))).job_id, jobs[0].job_id);
  await assert.rejects(s.create({ ...input('k0'), payload: {} }), { status: 409 });
  await assert.rejects(s.cancel(jobs[4].job_id, 'other'), { status: 404 });
  await s.cancel(jobs[4].job_id, credential);
  assert.equal((await s.create(input('k4'))).status, 'canceled');
  const raw = await readFile(f.path, 'utf8');
  for (const secret of [credential, 'private-test-prompt', 'private-image']) assert.ok(!raw.includes(secret));
  assert.ok(!JSON.stringify(await s.list(credential)).includes('sealed'));
  delete s.schedule; s.schedule();
  await until(() => gates.length === 2);
  assert.deepEqual(f.calls.map(c => c.model), ['flux-fill', 'esrgan']);
  const pending = await s.cancel(jobs[0].job_id, credential);
  assert.notEqual(pending.status, 'canceled');
  assert.equal(pending.progress.stage, 'cancel_requested');
  gates.splice(0).forEach(r => r({ status: 'COMPLETED' }));
  await until(() => gates.length === 1); gates.shift()({ status: 'COMPLETED' });
  await until(() => gates.length === 1); gates.shift()({ status: 'COMPLETED' });
  await s.waitForIdle(); assert.equal(f.calls.length, 4);
});

test('restart runs waiting only, queries existing ID, and never replays submission intent', async t => {
  const f = await setup(t);
  const old = f.make(); old.schedule = () => {};
  const waiting = await old.create(input('waiting'));
  const intent = await old.create(input('intent'));
  const accepted = await old.create(input('accepted'));
  Object.assign(old.store.jobs.get(intent.job_id), { status: 'running', queueState: 'submitting' });
  Object.assign(old.store.jobs.get(accepted.job_id), { status: 'running', queueState: 'submitting', providerJobId: 'existing-provider-id' });
  await old.store.flush();
  const ids = []; f.provider.status = async (_, id) => { ids.push(id); return { status: 'COMPLETED' }; };
  const s = f.make(); await s.init(); await s.waitForIdle();
  assert.equal(f.calls.length, 1);
  assert.ok(ids.includes('existing-provider-id'));
  assert.equal((await s.get(waiting.job_id, credential)).status, 'succeeded');
  assert.equal((await s.get(intent.job_id, credential)).status, 'uncertain');
  assert.equal((await s.create(input('intent'))).job_id, intent.job_id);
});

test('query failure is recovered once per startup without a retry loop', async t => {
  let reads = 0;
  const f = await setup(t, { provider: { status: async () => { reads++; throw new Error('offline'); } } });
  const s = f.make(); const j = await s.create(input('query')); await s.waitForIdle();
  assert.equal(reads, 1); assert.equal(f.calls.length, 1);
  const restarted = f.make(); await restarted.init(); await restarted.waitForIdle();
  assert.equal(reads, 2); assert.equal(f.calls.length, 1);
  assert.equal((await restarted.get(j.job_id, credential, { resume: false })).status, 'recoverable');
  await restarted.resume(j.job_id, credential); assert.equal(reads, 3); assert.equal(f.calls.length, 1);
});

test('disconnect after submit stays uncertain; provider cancel failure never marks canceled', async t => {
  const f = await setup(t, { provider: { submit: async () => { throw new Error('connection lost'); } } });
  const s = f.make(); const j = await s.create(input('broken')); await s.waitForIdle();
  assert.equal((await s.get(j.job_id, credential)).status, 'uncertain');
  await assert.rejects(s.resume(j.job_id, credential), { status: 409 });
  const restarted = f.make(); await restarted.init(); await restarted.waitForIdle();
  assert.equal((await restarted.get(j.job_id, credential)).status, 'uncertain');
  let finish;
  const g = await setup(t, { provider: { status: () => new Promise(r => { finish = r; }), cancel: async () => { throw new Error('offline'); } } });
  const q = g.make(); const a = await q.create(input('cancel')); await until(() => finish);
  const result = await q.cancel(a.job_id, credential); assert.notEqual(result.status, 'canceled'); assert.equal(result.error.code, 'cancel_unconfirmed');
  finish({ status: 'COMPLETED' }); await q.waitForIdle();
  assert.equal((await q.get(a.job_id, credential)).status, 'succeeded');
});

test('missing/wrong encryption keys never submit old waiting entries', async t => {
  const f = await setup(t); const s = f.make(); s.schedule = () => {};
  const j = await s.create(input('locked'));
  const locked = f.make({ queueKey: null }); await locked.init(); await locked.waitForIdle(); assert.equal(f.calls.length, 0);
  assert.equal((await locked.get(j.job_id, credential)).status, 'queued');
  const wrong = f.make({ queueKey: Buffer.alloc(32, 18) }); await wrong.init(); await wrong.waitForIdle();
  assert.equal(f.calls.length, 0); assert.equal((await wrong.get(j.job_id, credential)).error.code, 'queue_decryption_failed');
});

test('submission claim blocks cancellation before network and storage failure fails closed', async t => {
  const f = await setup(t); const s = f.make(); s.schedule = () => {};
  const j = await s.create(input('race'));
  let release;
  const original = s.store.flush.bind(s.store);
  s.store.flush = () => new Promise(r => { release = () => original().then(r); });
  delete s.schedule; s.schedule(); await until(() => release);
  await assert.rejects(s.cancel(j.job_id, credential), { status: 409 }); assert.equal(f.calls.length, 0);
  s.store.flush = original; await release(); await s.waitForIdle(); assert.equal(f.calls.length, 1);
  const g = await setup(t); const q = g.make(); q.schedule = () => {};
  await q.create(input('disk')); q.store.flush = async () => { throw new Error('disk failure'); };
  // Storage failure fails closed (no submit, admission refused) but is recoverable rather than a permanent stop.
  delete q.schedule; q.schedule(); await q.waitForIdle(); assert.equal(g.calls.length, 0); assert.equal(q.storageHealthy, false);
  await assert.rejects(q.create(input('disk-2')), { status: 503 }); assert.equal(g.calls.length, 0);
});

test('byte cap rejects before admission; expired result retains durable identity', async t => {
  const f = await setup(t); const small = f.make({ maxQueueBytes: 1 });
  await assert.rejects(small.create(input('large')), { status: 429 }); assert.equal(small.store.jobs.size, 0);
  const s = f.make(); const j = await s.create(input('retain')); await s.waitForIdle();
  s.store.jobs.get(j.job_id).finishedAt = 0; await s.store.cleanup();
  const same = await s.create(input('retain')); assert.equal(same.job_id, j.job_id); assert.equal(same.result_expired, true); assert.equal(f.calls.length, 1);
});

test('real process kill restores waiting and provider reads without replaying either active submit', async t => {
  const f = await setup(t), children = [], submissions = [], queries = [];
  const script = `import { FalJobService, JsonJobStore } from ${JSON.stringify(new URL('./job-service.mjs', import.meta.url).href)};
    const first = process.env.FAL_TEST_FIRST === '1';
    const provider = {
      submit: async (_, payload) => { process.send({submit:payload.n}); if(first && payload.n===1) return new Promise(()=>{}); return {request_id:'provider-'+payload.n}; },
      status: async (_, id) => { process.send({query:id}); if(first) return new Promise(()=>{}); return {status:'COMPLETED'}; },
      result: async()=>({images:[]})
    };
    const s=new FalJobService({store:new JsonJobStore(process.env.FAL_TEST_PATH),provider,queueKey:Buffer.alloc(32,17)});
    await s.init();
    if(first) for(let n=0;n<5;n++) await s.create({model:'flux-fill',idempotencyKey:'kill-'+n,credential:'fake-fal-secret-only',payload:{n,prompt:'private-test-prompt'}});
    process.on('message',async()=>{await s.store.write;process.send({states:[...s.store.jobs.values()].map(j=>({status:j.status,queue:j.queueState,id:j.providerJobId}))});});
    process.send({ready:true});setInterval(()=>{},1000);`;
  const kill = async c => { if (c.exitCode !== null || c.signalCode !== null) return; const end = once(c, 'exit'); c.kill('SIGKILL'); await end; };
  t.after(async () => { for (const c of children) await kill(c); });
  const start = async first => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, FAL_TEST_FIRST: first ? '1' : '0', FAL_TEST_PATH: f.path }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    children.push(c); let ready = false;
    c.on('message', m => { if (m.ready) ready = true; if (m.submit !== undefined) submissions.push(m.submit); if (m.query) queries.push(m.query); if (m.states) c.states = m.states; });
    await until(() => ready); return c;
  };
  const first = await start(true); await until(() => submissions.length === 2 && queries.length === 1);
  first.send('state'); await until(() => first.states);
  assert.equal(first.states.filter(s => s.queue === 'waiting').length, 3);
  await kill(first);
  const raw = await readFile(f.path, 'utf8'); assert.ok(!raw.includes(credential)); assert.ok(!raw.includes('private-test-prompt'));
  const second = await start(false);
  for (let i = 0; i < 100; i++) {
    second.states = null; second.send('state'); await until(() => second.states);
    if (second.states.filter(s => s.status === 'succeeded').length === 4) break;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(second.states.filter(s => s.status === 'succeeded').length, 4);
  assert.equal(second.states.filter(s => s.status === 'uncertain').length, 1);
  assert.deepEqual([...submissions].sort(), [0, 1, 2, 3, 4]);
  assert.equal(queries.filter(id => id === 'provider-0').length, 2);
  await kill(second);
});
