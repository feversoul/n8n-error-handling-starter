// Used by bootstrap.sh inside the n8n container: copies the workflows for the
// n8n CLI and fills in the addresses of the local stack.
//   node prepare.mjs <workflows dir> <output dir>
//
//   API_URL            the API the sync reads
//   NOTIFY_URL         where the error workflow posts
//   THROTTLE_MINUTES   length of the notification window (default 60)

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [source, out] = process.argv.slice(2);
const env = process.env;

mkdirSync(out, { recursive: true });
for (const file of readdirSync(source).filter((name) => name.endsWith('.json'))) {
  const workflow = JSON.parse(readFileSync(join(source, file), 'utf8'));
  for (const node of workflow.nodes) {
    if (node.name === 'Settings' && env.API_URL) {
      for (const assignment of node.parameters.assignments.assignments) if (assignment.name === 'api_url') assignment.value = env.API_URL;
    }
    if (node.name === 'Build log row') {
      let code = node.parameters.jsCode;
      if (env.NOTIFY_URL) code = code.replace(/const NOTIFY_URL = .*;/, `const NOTIFY_URL = ${JSON.stringify(env.NOTIFY_URL)};`);
      if (Number(env.THROTTLE_MINUTES) > 0) code = code.replace(/const THROTTLE_MINUTES = .*;/, `const THROTTLE_MINUTES = ${Number(env.THROTTLE_MINUTES)};`);
      node.parameters.jsCode = code;
    }
  }
  writeFileSync(join(out, file), JSON.stringify(workflow));
}
