// End-to-end tests: the real workflows on a real n8n (npm run test:e2e).
//
// A stand-in API (docker/standin.mjs) is told how to fail. Each test starts
// the sync through its "Run now" webhook, a production run, and then reads
// what the stand-in received, what is in the two data tables, and what the
// executions list says.
//
// The tests run in order and build on each other.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.N8N_URL ?? 'http://localhost:55691';
const SERVICE = process.env.STANDIN_URL ?? 'http://localhost:58091';
const SYNC = 'esSync0000000001';
const ERRORS = 'esErrors00000001';
const OWNER = { email: 'owner@example.com', firstName: 'Lab', lastName: 'Owner', password: 'Lab-owner-1234' };
const COMPOSE = ['compose', '--env-file', 'test/test.env', '-f', 'docker-compose.yml', '-f', 'test/docker-compose.yml', '-p', 'errstarter-test'];
const UNAVAILABLE = 'Service unavailable - try again later or consider setting this node to retry automatically (in the node settings)';

let apiKey = '';
let cookie = '';
let tables = {};
const findings = [];
const finding = (what, measured) => findings.push({ what, measured });

const json = async (response) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
};

async function until(check, timeoutMs = 30_000, what = 'the condition') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(300);
  }
}

// --- the stand-in -------------------------------------------------------------

const service = {
  control: (rule) => fetch(`${SERVICE}/control`, { method: 'POST', body: JSON.stringify(rule) }),
  reset: () => fetch(`${SERVICE}/reset`, { method: 'POST' }),
  hits: async (path) => (await json(await fetch(`${SERVICE}/hits`))).hits.filter((hit) => !path || hit.path === path),
  notifications: async () => (await json(await fetch(`${SERVICE}/notifications`))).notifications,
};

// --- n8n ----------------------------------------------------------------------

const api = async (method, path, body) => {
  const response = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { 'x-n8n-api-key': apiKey, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await json(response) };
};
const rest = async (method, path, body, headers = { cookie }) => {
  const response = await fetch(`${BASE}/rest${path}`, {
    method,
    headers: { 'browser-id': 'lab', 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await json(response), headers: response.headers };
};

const rows = async (table) => (await api('GET', `/data-tables/${tables[table]}/rows?limit=250`)).body.data;
const records = () => rows('starter_records');
const errorLog = () => rows('starter_error_log');
const runs = async (id, limit = 20) => (await api('GET', `/executions?workflowId=${id}&limit=${limit}`)).body.data;
const newest = async (id) => Number((await runs(id, 1))[0]?.id ?? 0);
const ended = (run) => run.stoppedAt && run.status !== 'running' && run.status !== 'new';

// Starts the sync `count` times at once through its webhook (production
// runs) and waits until those runs have ended. Returns them, oldest first.
async function sync(count = 1) {
  const before = await newest(SYNC);
  const answers = await Promise.all(Array.from({ length: count }, () => fetch(`${BASE}/webhook/error-starter/sync`, { method: 'POST' })));
  for (const answer of answers) assert.equal(answer.status, 200, 'the webhook took the call');
  return until(
    async () => {
      const fresh = (await runs(SYNC)).filter((run) => Number(run.id) > before);
      return fresh.length === count && fresh.every(ended) ? fresh.reverse() : null;
    },
    40_000,
    `${count} sync run(s) to end`,
  );
}

// The error workflow runs after the failed run has ended. Waits for the log
// to reach `count` rows, then a little longer so a late row or notification
// would be seen.
async function logged(count) {
  await until(async () => (await errorLog()).length >= count, 20_000, `${count} rows in the error log`);
  await sleep(2_500);
  return errorLog();
}

// Notifications are throttled per minute in the test stack. Makes sure the
// next `seconds` seconds are inside one minute, and not across the full hour
// (the sync's own schedule fires then).
async function sameMinute(seconds) {
  const left = 60 - (Date.now() / 1000) % 60;
  if (left < seconds + 3) await sleep((left + 1.5) * 1000);
}

// Waits until no row of the error log is in the current window, so the next
// failure is the first of its window.
async function freshWindow(seconds) {
  const last = Number((await errorLog()).at(-1)?.throttle_key.split('|').at(-1) ?? 0);
  await until(async () => Math.floor(Date.now() / 60_000) > last, 70_000, 'the next minute');
  await sleep(1_500);
  await sameMinute(seconds);
}

before(async () => {
  await until(async () => (await fetch(`${BASE}/healthz/readiness`)).status === 200, 180_000, 'n8n to be ready');

  // Owner and API key through n8n's own endpoints, the ones the first-run
  // screen and Settings > n8n API use.
  let response = await rest('POST', '/owner/setup', OWNER, {});
  if (response.status !== 200) response = await rest('POST', '/login', { emailOrLdapLoginId: OWNER.email, password: OWNER.password }, {});
  assert.equal(response.status, 200, 'owner setup or login');
  cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const scopes = (await rest('GET', '/api-keys/scopes')).body.data;
  const key = await rest('POST', '/api-keys', { label: `harness-${Date.now()}`, expiresAt: null, scopes });
  assert.equal(key.status, 200, JSON.stringify(key.body).slice(0, 300));
  apiKey = key.body.data.rawApiKey;

  // bootstrap.sh creates the tables after n8n is up.
  await until(
    async () => {
      const list = (await api('GET', '/data-tables')).body.data;
      tables = Object.fromEntries(list.map((table) => [table.name, table.id]));
      return tables.starter_records && tables.starter_error_log;
    },
    120_000,
    'the two data tables',
  );
  await service.reset();
});

after(() => {
  if (findings.length === 0) return;
  console.log('\nMeasured on this run:');
  for (const { what, measured } of findings) console.log(`- ${what}: ${measured}`);
});

// --- 1. retries -----------------------------------------------------------------

test('healthy API: five records are saved, one row each', async () => {
  const [run] = await sync();
  assert.equal(run.status, 'success');
  const saved = await records();
  assert.deepEqual(saved.map((row) => row.record_id).sort(), ['r1', 'r2', 'r3', 'r4', 'r5']);
  assert.ok(saved.every((row) => row.status === 'ok' && row.email.endsWith('@example.com')));
});

test('transient failure: Retry On Fail recovers inside the same run, no duplicates, error workflow not called', async () => {
  await service.reset();
  await service.control({ listFailures: 2 });
  const [run] = await sync();
  assert.equal(run.status, 'success', 'the run ends green');

  const list = await service.hits('/records');
  assert.deepEqual(list.map((hit) => hit.status), [503, 503, 200], 'two failed tries, the third works');
  const gaps = [Date.parse(list[1].at) - Date.parse(list[0].at), Date.parse(list[2].at) - Date.parse(list[1].at)];
  assert.ok(gaps.every((gap) => gap >= 950 && gap < 2_500), `about 1000 ms between tries, got ${gaps}`);
  finding('Retry On Fail, Max Tries 3, Wait Between Tries 1000 ms, API fails twice', `3 requests, ${gaps.join(' ms and ')} ms apart, run status "${run.status}"`);

  assert.equal((await records()).length, 5, 'still five rows');
  await sleep(2_500);
  assert.equal((await errorLog()).length, 0, 'nothing logged');
  assert.equal((await service.notifications()).length, 0, 'nothing sent');
});

// --- 2. one bad item ----------------------------------------------------------------

test('one bad record: it goes down the error output, the other four are saved, the run ends green', async () => {
  await service.reset();
  await service.control({ badIds: ['r3'], badStatus: 404 });
  const [run] = await sync();
  assert.equal(run.status, 'success', 'an error caught by the error output does not fail the run');

  const saved = await records();
  assert.equal(saved.length, 5, 'five rows, the failed one is updated in place');
  const bad = saved.find((row) => row.record_id === 'r3');
  assert.equal(bad.status, 'failed');
  assert.match(bad.error, /404/);
  assert.ok(saved.filter((row) => row.record_id !== 'r3').every((row) => row.status === 'ok'));
  assert.equal((await service.hits('/records/r3')).length, 1);
  finding('error text saved for the bad record', bad.error);

  const full = (await api('GET', `/executions/${run.id}?includeData=true`)).body;
  const item = full.data.resultData.runData['Fetch one record'][0].data.main[1][0].json;
  assert.deepEqual(Object.keys(item).sort(), ['error', 'id', 'name'], 'the item on the error output is the input item plus `error`');
  finding('item on the error output', `keys ${JSON.stringify(Object.keys(item))}, error keys ${JSON.stringify(Object.keys(item.error))}`);

  await sleep(2_500);
  assert.equal((await errorLog()).length, 0, 'the error workflow was not called');
  assert.equal((await service.notifications()).length, 0);
});

test('running again after that failure: the same five rows, the failed one is ok now', async () => {
  const idsBefore = (await records()).map((row) => row.id).sort();
  await service.reset();
  const [run] = await sync();
  assert.equal(run.status, 'success');
  const saved = await records();
  assert.deepEqual(saved.map((row) => row.id).sort(), idsBefore, 'the same row ids: nothing was added');
  const fixed = saved.find((row) => row.record_id === 'r3');
  assert.equal(fixed.status, 'ok');
  assert.equal(fixed.error, '');
});

test('Retry On Fail together with the error output: it only retries when the first item fails', async () => {
  const address = (id) => `http://standin:8080/records/${id}`;
  const five = ['r1', 'r2', 'r3', 'r4', 'r5'];
  // Runs the lab node (Retry On Fail 3 tries + error output) on these
  // records and answers the requests the API received, in order.
  const lab = async (ids, bad, badStatus) => {
    await service.reset();
    await service.control({ badIds: [bad], badStatus });
    const answer = await fetch(`${BASE}/webhook/error-starter/lab/retry-with-error-output`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ urls: ids.map(address) }),
    });
    assert.equal(answer.status, 200);
    await sleep(3_000);
    return (await service.hits()).map((hit) => hit.path.split('/').at(-1));
  };

  const third = await lab(five, 'r3', 503);
  finding('Retry On Fail (3 tries) + error output, 5 items, item 3 answers 503', `${third.length} requests: ${third.join(' ')}`);
  assert.deepEqual(third.slice().sort(), five, 'item 3 fails: no retry at all');

  const last = await lab(five, 'r5', 500);
  assert.deepEqual(last.slice().sort(), five, 'item 5 fails: no retry at all');

  const first = await lab(five, 'r1', 503);
  finding('same, item 1 answers 503', `${first.length} requests: ${first.join(' ')}`);
  assert.equal(first.length, 15, 'item 1 fails: all five items are sent three times');
  assert.equal(first.filter((id) => id === 'r2').length, 3, 'the items that worked are repeated too');

  const notFound = await lab(['r3'], 'r3', 404);
  finding('same, a single item that answers 404', `${notFound.length} requests`);
  assert.equal(notFound.length, 3, 'a 404 is retried like any other error');
});

// --- 3. the error workflow ------------------------------------------------------------

let failedRun = null;

test('permanent failure: three tries, the run fails, the error workflow logs one row and notifies once', async () => {
  await sameMinute(35);
  await service.reset();
  await service.control({ listFailures: -1 });
  const [run] = await sync();
  failedRun = run;
  assert.equal(run.status, 'error');
  assert.equal((await service.hits('/records')).length, 3, 'Max Tries 3 means three requests in total');

  const log = await logged(1);
  assert.equal(log.length, 1);
  const [row] = log;
  assert.equal(row.workflow, 'Error starter · 1 Sync records');
  assert.equal(row.node, 'Fetch records');
  assert.equal(row.message, UNAVAILABLE);
  assert.equal(row.execution_url, `${BASE}/workflow/${SYNC}/executions/${run.id}`);
  assert.ok(Math.abs(Date.parse(row.failed_at) - Date.now()) < 60_000);

  const sent = await service.notifications();
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes('Fetch records') && sent[0].text.includes(row.execution_url), sent[0].text);
  finding('notification text', sent[0].text);
});

test('what the Error Trigger receives', async () => {
  const [handler] = await runs(ERRORS, 1);
  assert.equal(handler.mode, 'error', 'the error workflow run has mode "error"');
  const full = (await api('GET', `/executions/${handler.id}?includeData=true`)).body;
  const payload = full.data.resultData.runData['Error Trigger'][0].data.main[0][0].json;

  assert.deepEqual(Object.keys(payload).sort(), ['execution', 'workflow']);
  assert.deepEqual(payload.workflow, { id: SYNC, name: 'Error starter · 1 Sync records' });
  assert.deepEqual(Object.keys(payload.execution).sort(), ['error', 'executionContext', 'id', 'lastNodeExecuted', 'mode', 'url']);
  assert.equal(payload.execution.id, failedRun.id);
  assert.equal(payload.execution.mode, 'webhook');
  assert.equal(payload.execution.lastNodeExecuted, 'Fetch records');
  assert.equal(payload.execution.error.message, UNAVAILABLE);
  assert.equal(payload.execution.error.name, 'NodeApiError');
  assert.equal(payload.execution.error.httpCode, '503');
  assert.equal(payload.execution.error.node.name, 'Fetch records');
  assert.equal(typeof payload.execution.error.stack, 'string');

  // The payload as received, with the three long values cut.
  const error = payload.execution.error;
  const shown = structuredClone(payload);
  shown.execution.error.stack = `${error.stack.split('\n')[0].slice(0, 40)}...`;
  shown.execution.error.node = { ...error.node, parameters: '...' };
  shown.execution.error.context = { ...error.context, request: { method: error.context.request.method, uri: error.context.request.uri, '...': '...' } };
  finding('Error Trigger payload', JSON.stringify(shown));
  finding('row in starter_error_log', JSON.stringify((await errorLog())[0]));
});

test('a burst of the same error: every failure is logged, still one notification; a different error notifies', async () => {
  const [first] = await sync(6);
  assert.ok(first, 'six runs ended');
  const log = await logged(7);
  assert.equal(log.length, 7, 'one row per failed run');
  assert.equal(new Set(log.map((row) => row.throttle_key)).size, 1, 'all in the same window');
  assert.equal((await service.notifications()).length, 1, 'no second notification for the same error');

  // Another status gives another message, so another key.
  await service.control({ listFailures: -1, listStatus: 500 });
  await sync();
  const more = await logged(8);
  assert.notEqual(more.at(-1).message, UNAVAILABLE);
  assert.equal((await service.notifications()).length, 2, 'a different error is notified at once');
  finding('7 failures with the same error inside one window', '7 log rows, 1 notification');
});

test('the next window: the same error notifies again', async () => {
  const windowOf = (row) => row.throttle_key.split('|').at(-1);
  const old = windowOf((await errorLog())[0]);
  await freshWindow(10);
  await service.control({ listFailures: -1 });
  await sync();
  const log = await logged(9);
  assert.notEqual(windowOf(log.at(-1)), old);
  assert.equal(log.at(-1).message, UNAVAILABLE);
  assert.equal((await service.notifications()).length, 3);
});

// --- 4. after the failure -------------------------------------------------------------

test('retrying the failed execution once the API is back: it ends green and adds no rows', async () => {
  const idsBefore = (await records()).map((row) => row.id).sort();
  await service.reset();
  const retry = await api('POST', `/executions/${failedRun.id}/retry`, { loadWorkflow: true });
  assert.equal(retry.status, 200, JSON.stringify(retry.body).slice(0, 300));
  const run = await until(async () => (await runs(SYNC, 5)).find((entry) => entry.retryOf === failedRun.id && ended(entry)), 30_000, 'the retry to end');
  assert.equal(run.status, 'success');
  assert.equal(run.mode, 'retry');
  assert.deepEqual((await records()).map((row) => row.id).sort(), idsBefore, 'the same five rows');
  assert.equal((await service.hits('/records')).length, 1, 'the retry started at the failed node');
});

// --- 5. what a beginner trips over ------------------------------------------------------

test('a manual test run that fails does NOT call the error workflow', async () => {
  await service.reset();
  await service.control({ listFailures: -1 });
  const logBefore = (await errorLog()).length;
  const workflowData = (await rest('GET', `/workflows/${SYNC}`)).body.data;
  // What the editor sends for "Execute workflow".
  const started = await rest('POST', `/workflows/${SYNC}/run`, { workflowData, triggerToStartFrom: { name: 'Every hour' } });
  assert.equal(started.status, 200, JSON.stringify(started.body).slice(0, 300));
  const id = started.body.data.executionId;
  const run = await until(async () => (await runs(SYNC, 5)).find((entry) => entry.id === id && ended(entry)), 30_000, 'the manual run to end');
  assert.equal(run.mode, 'manual');
  assert.equal(run.status, 'error');
  assert.equal((await service.hits('/records')).length, 3, 'it really ran and failed');

  await sleep(5_000);
  assert.equal((await errorLog()).length, logBefore, 'no row');
  assert.equal((await service.notifications()).length, 0, 'no notification');
  assert.ok(!(await runs(ERRORS, 1))[0] || Number((await runs(ERRORS, 1))[0].id) < Number(id), 'the error workflow did not run');
});

test('an error workflow that is not published is not called; published again, it is', async () => {
  await freshWindow(30);
  await service.reset();
  await service.control({ listFailures: -1 });
  const logBefore = (await errorLog()).length;

  assert.equal((await api('POST', `/workflows/${ERRORS}/deactivate`)).status, 200);
  const [run] = await sync();
  assert.equal(run.status, 'error');
  await sleep(5_000);
  assert.equal((await errorLog()).length, logBefore, 'no row while it is unpublished');
  assert.equal((await service.notifications()).length, 0);
  const logs = spawnSync('docker', [...COMPOSE, 'logs', '--tail', '200', 'n8n'], { cwd: root, encoding: 'utf8' });
  const line = `${logs.stdout}${logs.stderr}`.split('\n').find((entry) => entry.includes('is not active and cannot be executed'));
  if (line) finding('n8n log line while the error workflow is unpublished', line.replace(/^\S+\s+\|\s+/, '').trim());

  assert.equal((await api('POST', `/workflows/${ERRORS}/activate`)).status, 200);
  await sync();
  const log = await logged(logBefore + 1);
  assert.equal(log.length, logBefore + 1);
  assert.equal((await service.notifications()).length, 1);
});
