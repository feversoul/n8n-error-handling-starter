// Builds workflows/*.json.
//
// The workflows are plain n8n exports: import them and they run, no build
// needed. This script exists so the notes and the repeated Data Table nodes
// are readable. After changing it, run:
//   node scripts/build.mjs

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const IDS = { setup: 'esSetup000000001', sync: 'esSync0000000001', errors: 'esErrors00000001' };

const RECORDS = 'starter_records';
const RECORD_COLUMNS = [
  ['record_id', 'string'], // the id the API gives the record: the key of the upsert
  ['name', 'string'],
  ['email', 'string'],
  ['status', 'string'], // ok | failed
  ['error', 'string'], // why it failed, empty when ok
  ['synced_at', 'date'],
];

const ERROR_LOG = 'starter_error_log';
const ERROR_COLUMNS = [
  ['workflow', 'string'],
  ['node', 'string'],
  ['message', 'string'],
  ['execution_url', 'string'],
  ['failed_at', 'date'],
  ['throttle_key', 'string'], // workflow | node | message | time window
];

const uuid = (seed) => {
  const hex = createHash('sha1').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const table = (name) => ({ __rl: true, mode: 'name', value: name });
const mapped = (columns, values) => ({
  mappingMode: 'defineBelow',
  value: values,
  matchingColumns: [],
  schema: columns
    .filter(([column]) => column in values)
    .map(([column, type]) => ({ id: column, displayName: column, required: false, defaultMatch: false, display: true, type: type === 'date' ? 'dateTime' : type, canBeUsedToMatch: true })),
  attemptToConvertTypes: false,
  convertFieldsToString: false,
});
const where = (keyName, keyValue) => ({ matchType: 'allConditions', filters: { conditions: [{ keyName, condition: 'eq', keyValue }] } });

function workflow(id, name, settings, build) {
  const nodes = [];
  const connections = {};
  const w = {
    node(nodeName, type, typeVersion, position, parameters, extra = {}) {
      nodes.push({ parameters, id: uuid(`${id}/${nodeName}`), name: nodeName, type: `n8n-nodes-base.${type}`, typeVersion, position, ...extra });
      return nodeName;
    },
    note(nodeName, lines, position, width, height, color = 4) {
      return w.node(nodeName, 'stickyNote', 1, position, { content: lines.join('\n'), width, height, color });
    },
    link(from, to, output = 0) {
      connections[from] ??= { main: [] };
      while (connections[from].main.length <= output) connections[from].main.push([]);
      connections[from].main[output].push({ node: to, type: 'main', index: 0 });
    },
    hook(nodeName, path, position, responseMode = 'onReceived') {
      return w.node(nodeName, 'webhook', 2, position, { httpMethod: 'POST', path: `error-starter/${path}`, responseMode, options: {} }, { webhookId: uuid(`${id}/webhook/${path}`) });
    },
    rows(nodeName, position, tableName, operation, parameters, extra = {}) {
      return w.node(nodeName, 'dataTable', 1.1, position, { resource: 'row', operation, dataTableId: table(tableName), ...parameters }, extra);
    },
    createTable(nodeName, position, tableName, columns) {
      return w.node(nodeName, 'dataTable', 1.1, position, {
        resource: 'table',
        operation: 'create',
        tableName,
        columns: { column: columns.map(([column, type]) => ({ name: column, type })) },
        options: { createIfNotExists: true },
      });
    },
  };
  build(w);
  return { name, nodes, pinData: {}, connections, active: false, settings: { executionOrder: 'v1', ...settings }, id };
}

// --- 0. Setup ----------------------------------------------------------------

const setup = workflow(IDS.setup, 'Error starter · 0 Setup', {}, (w) => {
  w.note(
    'About',
    [
      '## Error starter · Setup',
      `Run this once: press **Execute workflow**. It creates two data tables: \`${RECORDS}\` (what the sync writes) and \`${ERROR_LOG}\` (what the error workflow writes).`,
      '',
      'The webhook does the same for scripted installs. You can delete it.',
    ],
    [-40, -240],
    620,
    180,
  );
  w.node('Run once', 'manualTrigger', 1, [0, 0], {});
  w.hook('Or call', 'setup', [0, 180], 'lastNode');
  w.createTable('Create records table', [240, 0], RECORDS, RECORD_COLUMNS);
  w.createTable('Create error log table', [480, 0], ERROR_LOG, ERROR_COLUMNS);
  w.link('Run once', 'Create records table');
  w.link('Or call', 'Create records table');
  w.link('Create records table', 'Create error log table');
});

// --- 1. Sync records ---------------------------------------------------------

const API = "{{ $('Settings').first().json.api_url }}";
const RETRY = { retryOnFail: true, maxTries: 3, waitBetweenTries: 1000 };

const sync = workflow(IDS.sync, 'Error starter · 1 Sync records', { errorWorkflow: IDS.errors }, (w) => {
  w.note(
    'About',
    [
      '## Error starter · Sync records',
      'Reads a list of records from an API, reads each record, and saves it to a data table.',
      '',
      '**Fetch records**: Settings > Retry On Fail, 3 tries, 1000 ms apart. On Error is left at "Stop Workflow": if all 3 tries fail, the run fails and the error workflow is called (Workflow settings > Error workflow).',
      '',
      '**Fetch one record**: Settings > On Error = "Continue (using error output)". A record that cannot be read leaves by the lower output and is saved with status `failed`. The other records go on. The run ends green and the error workflow is NOT called. Retry On Fail is off here on purpose: together with the error output it only retried when the first item failed (see README). The next run tries the record again.',
      '',
      '**Save record / Save as failed**: Upsert with `record_id` as the condition. A second run updates the same rows; it does not add rows.',
    ],
    [-40, -440],
    900,
    350,
  );
  w.node('Every hour', 'scheduleTrigger', 1.2, [0, 0], { rule: { interval: [{ field: 'hours' }] } });
  w.hook('Run now', 'sync', [0, 180]);
  w.node('Settings', 'set', 3.4, [220, 0], {
    assignments: { assignments: [{ id: uuid('sync/api_url'), name: 'api_url', value: 'https://api.example.com', type: 'string' }] },
    options: {},
  });
  w.node('Fetch records', 'httpRequest', 4.2, [440, 0], { url: `=${API}/records`, options: {} }, RETRY);
  w.node('Fetch one record', 'httpRequest', 4.2, [660, 0], { url: `=${API}/records/{{ $json.id }}`, options: {} }, { onError: 'continueErrorOutput' });
  w.rows('Save record', [900, -100], RECORDS, 'upsert', {
    ...where('record_id', '={{ $json.id }}'),
    columns: mapped(RECORD_COLUMNS, { record_id: '={{ $json.id }}', name: '={{ $json.name }}', email: '={{ $json.email }}', status: 'ok', error: '', synced_at: '={{ $now.toISO() }}' }),
    options: {},
  });
  // An item on the error output is the input item plus `error`.
  w.rows('Save as failed', [900, 100], RECORDS, 'upsert', {
    ...where('record_id', '={{ $json.id }}'),
    columns: mapped(RECORD_COLUMNS, { record_id: '={{ $json.id }}', name: '={{ $json.name }}', status: 'failed', error: '={{ $json.error?.message ?? $json.error }}', synced_at: '={{ $now.toISO() }}' }),
    options: {},
  });
  w.link('Every hour', 'Settings');
  w.link('Run now', 'Settings');
  w.link('Settings', 'Fetch records');
  w.link('Fetch records', 'Fetch one record');
  w.link('Fetch one record', 'Save record', 0);
  w.link('Fetch one record', 'Save as failed', 1);
});

// --- 2. Error handler --------------------------------------------------------

const errors = workflow(IDS.errors, 'Error starter · 2 Error handler', {}, (w) => {
  w.note(
    'About',
    [
      '## Error starter · Error handler',
      'Runs when a workflow that names this one under **Workflow settings > Error workflow** fails in a production run (schedule, webhook, any trigger). It does not run for test runs started in the editor. Publish it.',
      '',
      `Every failure becomes one row in \`${ERROR_LOG}\`. A notification is sent only for the first row with the same workflow, node and message in the current time window (60 minutes, see **Build log row**). The row is written first and the first row is read afterwards, so a burst of failures at the same moment still gives one notification.`,
      '',
      '**Notify** posts `{ "text": "..." }` to `NOTIFY_URL`, the body a Slack incoming webhook takes. Swap it for a Slack or Gmail node and use `{{ $(\'Build log row\').first().json.text }}` as the message.',
    ],
    [-40, -360],
    900,
    270,
  );
  w.node('Error Trigger', 'errorTrigger', 1, [0, 0], {});
  w.node('Build log row', 'code', 2, [220, 0], {
    jsCode: [
      "const NOTIFY_URL = 'https://example.com/your-webhook';",
      'const THROTTLE_MINUTES = 60;',
      '',
      '// A failed run arrives with `execution`; a trigger that could not start',
      '// arrives with `trigger` instead.',
      'const event = $input.first().json;',
      'const error = event.execution?.error ?? event.trigger?.error ?? {};',
      "const workflow = event.workflow?.name ?? '';",
      "const node = event.execution?.lastNodeExecuted ?? error.node?.name ?? '';",
      "const message = error.message ?? 'Unknown error';",
      "const execution_url = event.execution?.url ?? '';",
      '',
      '// Same workflow, node and message in the same window: same key.',
      'const window = Math.floor(Date.now() / (THROTTLE_MINUTES * 60000));',
      "const throttle_key = [event.workflow?.id ?? '', node, message, window].join('|');",
      '',
      'const text = `n8n: "${workflow}" failed at "${node}": ${message}${execution_url ? ` ${execution_url}` : \'\'}`;',
      'return [{ json: { workflow, node, message, execution_url, failed_at: new Date().toISOString(), throttle_key, text, notify_url: NOTIFY_URL } }];',
    ].join('\n'),
  });
  const row = Object.fromEntries(ERROR_COLUMNS.map(([column]) => [column, `={{ $json.${column} }}`]));
  w.rows('Log error', [440, 0], ERROR_LOG, 'insert', { columns: mapped(ERROR_COLUMNS, row), options: {} });
  w.rows(
    'First row for this error',
    [660, 0],
    ERROR_LOG,
    'get',
    { ...where('throttle_key', "={{ $('Build log row').first().json.throttle_key }}"), returnAll: false, limit: 1, orderBy: true, orderByColumn: 'id', orderByDirection: 'ASC' },
    { alwaysOutputData: true },
  );
  w.node('Is it mine?', 'if', 2.2, [880, 0], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{ id: uuid('errors/mine'), leftValue: "={{ $json.id === $('Log error').first().json.id }}", rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
      combinator: 'and',
    },
    options: { looseTypeValidation: true },
  });
  w.node('Notify', 'httpRequest', 4.2, [1100, -20], {
    method: 'POST',
    url: "={{ $('Build log row').first().json.notify_url }}",
    sendBody: true,
    specifyBody: 'json',
    jsonBody: "={{ JSON.stringify({ text: $('Build log row').first().json.text }) }}",
    options: {},
  });
  w.link('Error Trigger', 'Build log row');
  w.link('Build log row', 'Log error');
  w.link('Log error', 'First row for this error');
  w.link('First row for this error', 'Is it mine?');
  w.link('Is it mine?', 'Notify', 0);
});

// --- Lab ---------------------------------------------------------------------

const lab = workflow('esLab00000000001', 'Error starter · Lab: retry with error output', {}, (w) => {
  w.note(
    'About',
    [
      '## Error starter · Lab',
      'Only for the tests, you do not need it. One HTTP Request node with **Retry On Fail** (3 tries) and **On Error = Continue (using error output)** at the same time. The test gives it a list of addresses, some of which fail, and counts the requests.',
    ],
    [-40, -200],
    620,
    140,
  );
  w.hook('Call', 'lab/retry-with-error-output', [0, 0]);
  w.node('Items', 'code', 2, [220, 0], { jsCode: 'return $input.first().json.body.urls.map((url) => ({ json: { url } }));' });
  w.node('Request', 'httpRequest', 4.2, [440, 0], { url: '={{ $json.url }}', options: {} }, { retryOnFail: true, maxTries: 3, waitBetweenTries: 200, onError: 'continueErrorOutput' });
  w.link('Call', 'Items');
  w.link('Items', 'Request');
});

mkdirSync(join(root, 'workflows'), { recursive: true });
const files = { '0-setup.json': setup, '1-sync-records.json': sync, '2-error-handler.json': errors, 'lab-retry-with-error-output.json': lab };
for (const [file, content] of Object.entries(files)) writeFileSync(join(root, 'workflows', file), `${JSON.stringify(content, null, 2)}\n`);
console.log(`wrote ${Object.keys(files).length} workflows`);
