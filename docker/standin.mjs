// Stand-in for the two things outside n8n: the API the sync reads, and the
// place the error workflow notifies.
//
//   GET  /records        -> [{ id, name }, ...]   five records
//   GET  /records/:id    -> { id, name, email }
//   POST /control        how the API behaves from now on:
//                          { listFailures: 2 }      the next 2 list requests fail, then it works
//                          { listFailures: -1 }     the list fails every time
//                          { listStatus: 503 }      status of a failing list request
//                          { badIds: ["r3"], badStatus: 404 }   these records cannot be read
//   GET  /hits           -> { hits: [{ at, path, status }] }   every API request received
//   POST /notify         where the error workflow posts. Same body as a Slack
//                        incoming webhook: { "text": "..." }
//   GET  /notifications  -> { notifications: [{ at, text }] }
//   POST /reset          forget hits and notifications, API healthy again

import { createServer } from 'node:http';

const RECORDS = [
  { id: 'r1', name: 'Ada', email: 'ada@example.com' },
  { id: 'r2', name: 'Grace', email: 'grace@example.com' },
  { id: 'r3', name: 'Linus', email: 'linus@example.com' },
  { id: 'r4', name: 'Margaret', email: 'margaret@example.com' },
  { id: 'r5', name: 'Dennis', email: 'dennis@example.com' },
];

const healthy = () => ({ listFailures: 0, listStatus: 503, badIds: [], badStatus: 404 });
let rule = healthy();
let hits = [];
let notifications = [];

const read = (request) =>
  new Promise((resolve) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => {
      try {
        resolve(JSON.parse(text || '{}'));
      } catch {
        resolve({});
      }
    });
  });

const send = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

createServer(async (request, response) => {
  const url = new URL(request.url, 'http://standin');
  const body = request.method === 'POST' ? await read(request) : {};
  const route = `${request.method} ${url.pathname}`;
  const api = (status, answer) => {
    hits.push({ at: new Date().toISOString(), path: url.pathname, status });
    return send(response, status, answer);
  };

  if (route === 'GET /records') {
    if (rule.listFailures !== 0) {
      if (rule.listFailures > 0) rule.listFailures -= 1;
      return api(rule.listStatus, { error: 'the stand-in was told to fail' });
    }
    return api(200, RECORDS.map(({ id, name }) => ({ id, name })));
  }
  if (request.method === 'GET' && url.pathname.startsWith('/records/')) {
    const record = RECORDS.find((entry) => entry.id === url.pathname.slice('/records/'.length));
    if (!record || rule.badIds.includes(record.id)) return api(rule.badStatus, { error: 'this record cannot be read' });
    return api(200, record);
  }
  if (route === 'POST /control') {
    rule = { ...healthy(), ...body };
    return send(response, 200, rule);
  }
  if (route === 'GET /hits') return send(response, 200, { hits });
  if (route === 'POST /notify') {
    notifications.push({ at: new Date().toISOString(), text: String(body.text ?? '') });
    return send(response, 200, { ok: true });
  }
  if (route === 'GET /notifications') return send(response, 200, { notifications });
  if (route === 'POST /reset') {
    rule = healthy();
    hits = [];
    notifications = [];
    return send(response, 200, { ok: true });
  }
  return send(response, 404, { error: 'not found' });
}).listen(8080, () => console.log('stand-in listening on 8080'));
