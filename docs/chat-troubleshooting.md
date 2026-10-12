# Chat troubleshooting logs

Chat diagnostics go to server stdout/stderr, so Vercel captures them in runtime logs. No new service, environment variable, or database migration is required.

Every browser and worker chat API response includes a server-generated `X-Chat-Request-Id`. For an API failure, copy this header from the browser Network panel and search the Vercel runtime logs for that ID. Caller-supplied correlation headers are ignored. The response body stays generic; diagnostic details remain server-only.

JSON events:

| Event | Meaning |
| --- | --- |
| `chat_request_failed` | API exception resulting in a 5xx response, or a 429 throttle; includes surface, static operation, method, status, duration, request ID, and an allowlisted diagnostic code. |
| `chat_database_pool_failed` | An idle database connection failed; includes data/queue pool and a safe code. |
| `chat_run_failed` | A worker failure event or failed/interrupted coordinator finalization was accepted; includes fixed failure code and the worker request ID. Duplicate request retries are quiet. |
| `chat_runs_reaped` | Lease/session cleanup closed one or more queued/running runs; includes only the count. |

Startup failures retain the existing `chat_runtime_initialization_failed phase=... code=...` format. Use the phase to distinguish configuration, database role preflight, and authority construction. `UNKNOWN` means the error had no allowlisted code; raw exception text is deliberately excluded.

Common codes: `28P01` indicates database authentication failure, `42501` insufficient database privileges, `ECONNREFUSED`/`ECONNRESET` connection failures, `runner_start_failed` a remote runner start failure, `worker_timeout` a deadline failure, and `inference_unavailable` a worker-reported inference failure.

From the linked repository, inspect recent production errors:

```powershell
npx vercel@latest logs --environment production --since 1h --level error -x
```

For cleanup warnings, omit `--level error`. Search for the event name or request ID in Vercel's runtime log view. Ordinary successful polling and routine 4xx rejections are quiet.

Logs never include chat text, record content, user/patient/conversation/run identifiers, credentials, URLs, query strings, headers, error messages, or stacks. Keep additions to this policy: use fixed operation labels and allowlisted codes instead of serializing an exception or request.

This is failure diagnostics, not a patient access audit trail or an alerting system. Run failures are recorded at the web authority boundary; their worker request IDs differ from the browser submission request ID. Cleanup logs are aggregate counts. Failures before a worker can report to the web API still require VPS/Iggy investigation. Log retention follows the hosting configuration; this change does not configure a log drain or longer retention.
