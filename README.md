# n8n error handling starter

[![test](https://github.com/feversoul/n8n-error-handling-starter/actions/workflows/test.yml/badge.svg)](https://github.com/feversoul/n8n-error-handling-starter/actions/workflows/test.yml)

A small n8n example to import, run and break. One workflow reads records from an API and saves them to a Data Table. One error workflow logs every failure, sends one notification per error per hour, and stays quiet for the rest. Built-in nodes and **Data Tables** only.

It came out of [this forum thread](https://community.n8n.io/t/327698), where a beginner asked four questions. Each answer below was run on a real n8n 2.47.7 against a stand-in API that can be told to fail.

| Asked in the thread                                              | What you get                                                                                                                                                                                          |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| When an API request fails, how do you retry it automatically?    | **Fetch records** has Retry On Fail: 3 tries, 1000 ms apart. The API failed twice, the third try worked, the run ended green. See [1. Retries](#1-retries).                                           |
| How do you use the Error Trigger in production?                  | `2-error-handler.json`, named under the sync's **Settings > Error workflow**. It ran for a failed production run. It did not run for a test run in the editor, nor while it was unpublished.          |
| How do you prevent duplicate data when a workflow runs again?    | **Save record** is an Upsert on `record_id`. After a failure, a second run and a retry of the failed execution both left the same five rows. See [3. Duplicates](#3-duplicates) for where that stops. |
| How do you log errors and notify?                                | Every failure is a row in `starter_error_log` (workflow, node, message, execution link, time). Seven failures with the same error in one window gave seven rows and one notification.                 |
| One bad record should not stop the others (asked in the replies) | **Fetch one record** uses the error output. One record answered 404: it was saved with status `failed`, the other four with `ok`, the run ended green.                                                |

## The workflows

- **0 Setup** creates the two data tables. Run it once.
- **1 Sync records**: every hour, or when you call its **Run now** webhook.
- **2 Error handler**: starts with an Error Trigger.
- **Lab: retry with error output** is only there for one measurement. Optional.

```text
1 Sync records
  Every hour / Run now
    -> Settings            api_url
    -> Fetch records       GET /records        Retry On Fail: 3 tries, 1000 ms
    -> Fetch one record    GET /records/{id}   On Error: Continue (using error output)
         success -> Save record      Upsert where record_id = id, status "ok"
         error   -> Save as failed   Upsert where record_id = id, status "failed", error text

2 Error handler
  Error Trigger
    -> Build log row              workflow, node, message, execution_url, failed_at, throttle_key
    -> Log error                  insert into starter_error_log
    -> First row for this error   oldest row with the same throttle_key
    -> Is it mine?                yes -> Notify   POST { "text": "..." } to NOTIFY_URL
```

## The four answers, as measured

### 1. Retries

Open the node, **Settings > Retry On Fail**, then **Max Tries** and **Wait Between Tries (ms)**.

- **Max Tries 3 means three requests in total**, not one plus three. The API answered 503 twice and then 200: three requests, 1024 ms and 1012 ms apart, one green run, nothing sent to the error workflow.
- **When all tries fail, the node fails.** With On Error left at "Stop Workflow" the run ends red and the error workflow is called once, after the last try.
- **Values above 5 tries and 5000 ms are cut down to those**, and Retry On Fail does not read a `Retry-After` header. Measured in [n8n-retry-after](https://github.com/feversoul/n8n-retry-after#what-retry-on-fail-does), which also has a retry loop for rate limits.
- **A retry sends every item of the node again**, not only the one that failed. Measured in [n8n-retry-effects](https://github.com/feversoul/n8n-retry-effects#what-was-measured). For a read that is harmless. For a call that creates or sends something, see [3. Duplicates](#3-duplicates).
- **Retry On Fail together with "Continue (using error output)" does not do what you expect.** Measured with five items on one HTTP Request node, 3 tries:

  | Which item failed | Requests the API received                 |
  | ----------------- | ----------------------------------------- |
  | item 3 (503)      | 5. No retry.                              |
  | item 5 (500)      | 5. No retry.                              |
  | item 1 (503)      | 15. All five items three times.           |
  | the only item     | 3. A 404 is retried like any other error. |

  So it retried only when the first item was the one that failed. That is why **Fetch one record** has Retry On Fail off: a record that fails is saved as `failed`, and the next hourly run tries it again.

### 2. The Error Trigger

1. Build a workflow that starts with an **Error Trigger** and publish it.
2. In the workflow you want watched: **Settings > Error workflow**, pick it.

What a beginner trips over, each one measured:

- **A test run in the editor does not call the error workflow.** The sync was started with "Execute workflow" while the API was down: the run failed (`mode: manual`, `status: error`) and nothing was logged or sent. The same failure through the webhook (`mode: webhook`) was logged and sent. To test your error workflow, publish both and let a real trigger start the run.
- **An unpublished error workflow is skipped without a word in the editor.** The failed run looks the same. Only the n8n log has a line: `Calling Error Workflow for "esSync0000000001". Workflow "esErrors00000001" is not active and cannot be executed`. Published again, it was called for the next failure.
- **An error caught by the error output is not an error for n8n.** The run with the bad record ended with status `success` and the error workflow was not called. Whatever you send down an error output, you have to store or report yourself. Here it is the `failed` row.
- **The run of the error workflow has `mode: error`** in the executions list.

What the Error Trigger receives in 2.47.7, from the failed run of the test (long values cut):

```json
{
  "execution": {
    "id": "10",
    "url": "http://localhost:55691/workflow/esSync0000000001/executions/10",
    "error": {
      "name": "NodeApiError",
      "level": "warning",
      "shouldReport": true,
      "description": "the stand-in was told to fail",
      "tags": {},
      "timestamp": 1794599823135,
      "context": { "itemIndex": 0, "request": { "method": "GET", "uri": "http://standin:8080/records", "...": "..." } },
      "functionality": "regular",
      "node": { "name": "Fetch records", "type": "n8n-nodes-base.httpRequest", "parameters": { "...": "..." }, "retryOnFail": true, "maxTries": 3, "waitBetweenTries": 1000 },
      "messages": ["503 - \"{\\\"error\\\":\\\"the stand-in was told to fail\\\"}\""],
      "httpCode": "503",
      "message": "Service unavailable - try again later or consider setting this node to retry automatically (in the node settings)",
      "stack": "NodeApiError: Service unavailable - try ..."
    },
    "lastNodeExecuted": "Fetch records",
    "mode": "webhook",
    "executionContext": {
      "version": 1,
      "establishedAt": 1794599821080,
      "source": "webhook",
      "triggerNode": { "name": "Run now", "type": "n8n-nodes-base.webhook" },
      "redaction": { "version": 2, "production": false, "manual": false }
    }
  },
  "workflow": { "id": "esSync0000000001", "name": "Error starter · 1 Sync records" }
}
```

The fields worth using: `workflow.name`, `execution.lastNodeExecuted`, `execution.error.message` (n8n's wording), `execution.error.description` (what the API said), `execution.error.httpCode`, `execution.url`, `execution.mode`. The error also carries the whole failed node with its parameters and the request it made, so do not forward the raw payload to a client.

`execution.url` starts with the address n8n believes it has. The test stack sets `N8N_EDITOR_BASE_URL`. The n8n documentation describes a second shape, for a trigger that could not start: `trigger` instead of `execution`, and no `id` or `url`. **Build log row** reads both, but only the shape above was produced in the tests.

### 3. Duplicates

**Save record** is the Data Table operation **Upsert** with the condition `record_id` equals the record's id. If a row matches it is updated, otherwise one is added.

- First run: five rows. Second run: the same five row ids.
- A run with one bad record wrote that record as `failed`. The next run turned the same row to `ok`.
- The run that failed at **Fetch records** was retried from the executions list (through the API, `POST /executions/{id}/retry`) once the API was back: it started at the failed node, ended green, and left the same five rows.

Where this stops:

- **A Data Table has no unique constraint.** Upsert is a lookup and then a write. When two runs handle the same record at the same instant, both can add a row: [n8n-webhook-dedupe](https://github.com/feversoul/n8n-webhook-dedupe#what-was-measured) measured two rows per key with n8n on PostgreSQL, and has a pattern that holds. An hourly sync does not overlap with itself, a webhook that gets the same event twice does.
- **Upsert protects the table, not the outside world.** If a step sends a mail or creates an order, a retry does it again, as @neerajbhakta and @kartike said in the thread. What exactly is repeated, and a guard for it, is in [n8n-retry-effects](https://github.com/feversoul/n8n-retry-effects).

### 4. Logging and notifying

Every call of the error workflow adds one row to `starter_error_log`:

| Column          | Example                                                          |
| --------------- | ---------------------------------------------------------------- |
| `workflow`      | Error starter · 1 Sync records                                   |
| `node`          | Fetch records                                                    |
| `message`       | Service unavailable - try again later or consider setting ...    |
| `execution_url` | `http://localhost:55691/workflow/esSync0000000001/executions/10` |
| `failed_at`     | 2026-11-13T19:57:03.184Z                                         |
| `throttle_key`  | workflow id, node, message and the number of the time window     |

The throttle, suggested in the thread by @AnthonyAtXRay: the row is written first, then the oldest row with the same `throttle_key` is read. Only the run that finds its own row sends the notification. Measured: one failure gave one row and one notification. Six more at the same moment gave six more rows and no notification. A failure with another message was notified at once. In the next window the first failure was notified again.

The window is a fixed slot (`THROTTLE_MINUTES = 60` in **Build log row**), so two failures at 10:59 and 11:01 both notify. The key contains the message: an error text with a changing part, an id or a timestamp, gets a new key each time. Take the message out of the key if that happens to you.

The notification is a POST with `{ "text": "..." }`:

```text
n8n: "Error starter · 1 Sync records" failed at "Fetch records": Service unavailable - try again later or consider setting this node to retry automatically (in the node settings) http://localhost:55691/workflow/esSync0000000001/executions/10
```

- **Slack**: a Slack incoming webhook takes exactly this body, so its address can go into `NOTIFY_URL`. Or replace **Notify** with a Slack node and use `{{ $('Build log row').first().json.text }}` as the message.
- **Gmail or Send Email**: replace **Notify** with that node, same expression as the body.
- **A client**: this workflow tells you, not your client. Add a second node after **Is it mine?** with your own wording, without the node name and the link.

Only the stand-in was notified in the tests, not Slack or a mail server.

## Add it to your n8n

Works on any n8n with Data Tables. Not tested on n8n Cloud.

1. Import `workflows/0-setup.json`, `1-sync-records.json` and `2-error-handler.json` (Workflows > Import from File).
2. Open **0 Setup** and press **Execute workflow** once.
3. Open **2 Error handler**, set `NOTIFY_URL` in **Build log row**, and publish it.
4. Open **1 Sync records** and set `api_url` in **Settings**. Then **Settings > Error workflow**: check that **Error starter · 2 Error handler** is selected. An imported workflow gets a new id, so pick it again.
5. Publish **1 Sync records**. Start a production run: `curl -X POST https://<your n8n>/webhook/error-starter/sync`.

The example expects `GET /records` to answer a list of `{ id, name }` and `GET /records/{id}` to answer `{ id, name, email }`. For your own API, change the two HTTP Request nodes and the columns in the two Save nodes. The **Run now** webhook has no authentication. It can only start a sync, but delete it if you do not want it.

## Run it and break it

```sh
git clone https://github.com/feversoul/n8n-error-handling-starter
cd n8n-error-handling-starter
cp .env.example .env      # set N8N_ENCRYPTION_KEY to any long string
docker compose up -d      # n8n on :5678, the stand-in API on :8080
```

Open `http://localhost:5678` and create the owner. The workflows are published and the tables exist. Then:

```sh
# a healthy run: five rows in starter_records
curl -X POST localhost:5678/webhook/error-starter/sync

# the API fails twice, then works: Retry On Fail saves the run
curl -X POST localhost:8080/control -d '{"listFailures":2}'
curl -X POST localhost:5678/webhook/error-starter/sync

# one record cannot be read: one row with status "failed"
curl -X POST localhost:8080/control -d '{"badIds":["r3"]}'
curl -X POST localhost:5678/webhook/error-starter/sync

# the API is down: a row in starter_error_log and one notification
curl -X POST localhost:8080/control -d '{"listFailures":-1}'
curl -X POST localhost:5678/webhook/error-starter/sync
curl localhost:8080/notifications

# healthy again
curl -X POST localhost:8080/control -d '{}'
```

Then press **Execute workflow** in the editor while the API is down and see that nothing is logged. The stand-in and the webhooks have no authentication. Keep them on a local stack.

After changing `scripts/build.mjs`, run `npm run build` to write `workflows/*.json` again.

## What was tested

`npm run test:e2e` (Docker and Node 20 or newer, about four minutes) from a fresh stack, n8n 2.47.7, regular mode, SQLite: **12 of 12 passed**. In the test stack the throttle window is one minute, so the test can wait for the next one.

| Test                                                                                                                | Result |
| ------------------------------------------------------------------------------------------------------------------- | ------ |
| Healthy API: five records saved, one row each                                                                       | passed |
| API fails twice: three requests about 1 s apart, run green, five rows, error workflow not called                    | passed |
| One record answers 404: saved as `failed`, the other four `ok`, run green, error workflow not called                | passed |
| Run again after that: the same five row ids, the failed row is `ok`                                                 | passed |
| Retry On Fail with the error output: retried only when item 1 failed (15 requests), not for item 3 or 5 (5 each)    | passed |
| API down: three requests, run red, one log row with workflow, node, message, execution link, time; one notification | passed |
| The Error Trigger payload has the fields quoted above                                                               | passed |
| Six more failures at once: seven rows, still one notification; an error with another message notifies at once       | passed |
| Next window: the same error notifies again                                                                          | passed |
| Failed execution retried through the API after the API is back: green, the same five rows, one request              | passed |
| A manual run that fails: no log row, no notification, the error workflow did not run                                | passed |
| Error workflow unpublished: not called, log line in n8n; published again: called                                    | passed |

## What was not tested, and other limits

- Any real API, Slack, Gmail or mail server. The stand-in plays the API and receives the notification.
- n8n Cloud, queue mode, n8n on PostgreSQL, and any version other than 2.47.7.
- A 60 minute window. The tests ran with one minute; the code path is the same.
- The second payload shape, for a trigger that fails to start, and a run that is not saved to the database.
- Importing through the editor. The tests import with the n8n CLI, which keeps the workflow ids.
- Two syncs of the same record at the same instant. See [3. Duplicates](#3-duplicates).
- Timeouts. Every failure in the tests was an HTTP status (404, 500, 503).
- The error log grows without limit. Nothing deletes old rows.
- If the error workflow itself fails, for example because `NOTIFY_URL` is wrong, the row is still written (it comes first) but nobody is told.
- A workflow that stops running produces no error, so no Error Trigger sees it, as @nikoada said in the thread. [n8n-workflow-watchdog](https://github.com/feversoul/n8n-workflow-watchdog) checks from the outside, and measured that failed runs do not unpublish a workflow.
- The throttle with many failures at the same instant on several n8n workers. The same "write first, then read the oldest row" pattern held for 40 calls at once on one n8n in [n8n-webhook-dedupe](https://github.com/feversoul/n8n-webhook-dedupe#what-was-measured), which also notes its limit with several workers.

## License

MIT
