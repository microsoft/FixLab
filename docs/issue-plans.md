# Issue-driven trace and browser execution

FixLab can generate a validated JSON plan from an issue and repository evidence,
then compile it into bounded Application Insights KQL or a transient Playwright
test. Ticket text is input, not code or permission. No arbitrary KQL, JavaScript,
CSS selectors, mocks, sleeps or skipped scenarios are accepted by the plan API.

```powershell
# Print current policy revisions; no live access.
fixlab issue-plan . --environment dev
# Review the generated query or test; still no live access.
fixlab issue-plan . --environment dev --plan .fixlab\issue-plan.json
# Execute only after the current job's normal access approval.
fixlab issue-plan . --environment dev --plan .fixlab\issue-plan.json --execute
# Any DEV record: explicit DEV-write approval and a write-capable fixture required.
fixlab issue-plan . --environment dev --plan .fixlab\issue-plan.json --execute --allow-dev-writes
```

Plans may also be supplied with `--plan -` on stdin. Files are repository-relative,
regular, unlinked and at most 64 KiB. Keep incident inputs and results ignored and
private. Neither this command nor a profile installs dependencies, grants Azure
roles, signs in, copies browser state, or bypasses unit-only/deferred-live policy.
The host still reviews normal tool execution. Existing fixed-incident readers
and their exact ticket/correlation/hash checks remain unchanged.

## Reviewed trace policy

The profile's `analysis.traceQueries` is an array of at most ten entries:

```json
{
  "id": "application-traces",
  "environment": "dev",
  "subscriptionId": "11111111-1111-1111-1111-111111111111",
  "applicationId": "22222222-2222-2222-2222-222222222222",
  "maxWindowMinutes": 30,
  "maxRows": 50
}
```

These are illustrative GUIDs, not usable resources. The application ID is an
Application Insights app ID, not a Log Analytics workspace ID. A production
policy uses the exact environment `production` and is unavailable without
separately approved `--allow-production-evidence`. Application/browser validation
remains in the selected non-production environment. Watcher grants never transfer
to a dashboard job or another user.

A trace plan has `version: 1`, `kind: "trace"`, positive `workItemId`,
`environment`, `source` (policy ID), current `policyRevision`, explicit UTC `start`
and `end`, `table`, `filter` and `limit`. Supported tables are `traces`, `requests`,
`dependencies` and `exceptions`. A filter is `{ "all": [...] }`, `{ "any": [...] }`
or a predicate such as:

```json
{ "field": "payload.RequestId", "op": "eq", "value": "source-grounded-request-id" }
```

Supported operators: `eq`, `ne`, `has`, `contains`, `in`, `gt`, `ge`, `lt`, `le`.
String matching is case-sensitive. Membership accepts at most 50 strings;
filters allow depth four and 32 nodes. Ground `payload.*`, `customDimensions.*`
and standard telemetry fields in actual logging. `payload.*` reads the reviewed
`customDimensions.Payload` JSON convention.

The compiler always adds timestamp bounds, reviewed projection, timestamp
ordering and a `limit + 1` overflow probe. Policies are capped at 60 minutes and
200 rows. Each request uses the developer's Azure CLI token for
the exact subscription/application, a 20-second timeout, no redirects,
and a 256 KiB response limit. The reader may make one retry for a recognized
timeout, connection reset, temporary DNS failure, or HTTP 429/502/503/504.
Both attempts use the same query, UTC window, row limit, source and in-memory
token; the CLI rechecks the reviewed profile and compiler before dispatch.
Backoff is 250 ms unless a valid `Retry-After` requests up to two seconds.
Longer or invalid retry timing stops rather than retrying early.
Authentication/authorization failures, TLS failures, redirects, unknown
transport failures and response-validation failures are not retried. Failed
HTTP responses are released before retry; cleanup failure stops recovery.
Successful recovery returns `recovery` with its attempt count and sanitized
reason. Exhaustion returns a sanitized reason and actual attempt count, never
raw network errors or response text. This allowance applies only to the
compiled read-only query POST, not uploads, feedback, application writes or
agent-managed retry loops. Partial/schema-changed responses are rejected;
overflow returns `partial` and a failing exit code. This is not a persistent
cross-invocation query budget. Empty results mean lookup succeeded, not that the
issue is absent. A lookup's `passed` status never proves a root cause.

Discover candidate operation IDs from issue facts first, then generate a new
bounded plan using observed IDs to inspect requests/dependencies/exceptions.
Do not silently expand scope or equate business request numbers with operation IDs.
By default, results contain only bounded telemetry metadata, not messages or raw payloads.
Correlation IDs accept bounded hierarchical identifiers, including the `|`
separator and Base64 characters used by legacy IDs.
Credential-shaped assignments (including `AccountKey`), recognizable tokens and Basic/Bearer values are
rejected before identifier-format acceptance, including colon/equal-separated
schemes. The same credential screening applies to reviewed diagnostic literals.
Ordinary Base64 and hierarchical correlation IDs remain supported.
Original wire timestamps must be valid UTC calendar dates before normalization,
including rows beyond the ten-row feedback snapshot.
Canonical `true`/`false`
strings from Application Insights are normalized to booleans; numeric values
and arbitrary truthy strings are rejected. Invalid metadata rejects the entire result
and reports only the known column and validation reason, never the rejected
value or raw response. Review that reason before a separately approved retry;
rejection is not evidence that the incident has no matching traces.

### Opt-in diagnostic literals and feedback

A trace policy may additionally declare:

```json
{
  "diagnostics": {
    "endpoints": ["GET /v1/items/lookup"],
    "messages": ["Backend request failed."]
  }
}
```

Review these illustrative literals against the application's source before
adding them to a real policy. Each list accepts at most 50 fixed strings of at
most 200 characters. Endpoint literals are HTTP method plus route template,
never full URLs or query strings. Messages must be fixed, credential-free
summaries, not identities, business data or serialized payloads. Changing
diagnostics invalidates the policy revision and requires a fresh preview.

With that opt-in, requests/dependencies project `endpoint = name`, traces
project `logMessage = message`, and exceptions project `logMessage = outerMessage`.
Only exact, case-sensitive matches to reviewed literals leave the reader.
Unmatched strings become `null`; `omittedDiagnostics` counts omitted non-null
details across returned rows. Raw diagnostic text remains only in the bounded
response-processing memory, never in reader output or saved evidence. Existing
resource, production approval, window, row, timeout and response limits remain
unchanged. A route name that does not match the reviewed template is omitted,
not guessed from a URL.

Nonempty reads also return `traceEvidence`: source ID, policy revision, UTC
start/end, up to ten structured metadata rows with their table, optional
reviewed endpoint/message, `truncated`, and `omittedDiagnostics`. Empty reads
return no row evidence. Query overflow remains a failing, partial read even
when bounded evidence is available. The watcher requests this object in the
agent's final result, validates its fields, window and current source revision,
and checks every diagnostic literal before saving or posting it. Discussion
gets a short trace snapshot: observed failure codes, at most two reviewed
messages (preferring error/critical logs), an approved endpoint if available,
and explicit omission/partial-evidence limits. Full rows and correlation IDs
remain in private history instead of cluttering Discussion. A downstream
failure is labelled correlated only when its operation ID matches an observed
failed request. The summary distinguishes the observed failure chain from an
unconfirmed underlying cause. Approved incident-resolution comments can inform
the summary when actually available; a resolved incident state alone is not
root-cause or deployment evidence. Inaccessible resolution comments stay
explicitly unverified. Full bounded evidence follows normal private history
retention: completed/reconciled details and retained result payloads expire
after 15 days or when outside the latest 20 attempts. Duplicate-prevention
records remain; active, paused and pending-feedback evidence is not expired.
Evidence is agent-reported correlation, not proof
of a cause, deployment identity, successful validation or a source fix.

When diagnostic retrieval still fails, watcher feedback must name the sanitized
failure and the specific missing proof, such as request item count, approved
request-shape metadata, downstream rejection reason or authenticated incident
resolution. Preserve observed status codes and independent checks, but do not
infer a request limit violation or oversized URL from HTTP 404/500 or passing
unit tests. State the next authorized recovery action without widening scope
or bypassing sign-in, permissions, TLS or diagnostic-literal approval.

### Source-guided URL-shape diagnostics

Follow the failing controller/service/outbound client and its telemetry helper
before querying. Check actual logged property names and serialization. A missing
field in the reader's projection is **not requested**, not evidence that it was
never logged. Use an observed operation ID in the same approved UTC window.
Inspect APIM only if outbound client/configuration shows that call traverses it;
the incoming API gateway can be a different hop.

An optional reviewed diagnostic definition exposes only computed numeric metadata:

```json
{
  "diagnostics": {
    "urlShapes": [
      {
        "id": "outbound-lookup",
        "table": "traces",
        "field": "customDimensions.RequestUri",
        "term": "ItemNumber eq '"
      }
    ]
  }
}
```

These are illustrative source-grounded names, not a grant or an incident finding.
There may be up to five uniquely named definitions. A definition binds one table
and URL property: `url` for requests, `data` for dependencies, or a grounded
`customDimensions.*`/`payload.*` property. The optional fixed predicate is at most
80 credential-free characters. No arbitrary KQL, regular expression, value
projection or raw URL is accepted. A trace plan selects one definition with
`"urlShape": "outbound-lookup"` and the freshly reviewed policy revision; omitting
it preserves metadata-only behavior. Changing the definition invalidates approval.

The service computes `observedUrlLength` and, when configured,
`observedUrlTermCount` after one URL decode. Missing/empty URL properties or
unavailable decoding produce `null`, never a zero-shaped success. Returned
measurements must be null or integers from 0 to 16,777,216; term matches cannot
exceed observed characters. Raw URLs/query values stay at the telemetry service.
Bounded evidence retains `urlShape: {id, characterCount, termCount?}` on the
timestamped row. Feedback and PNGs show these approved numeric observations.

Length means **logged characters**, not encoded wire bytes. A term count means
observed decoded matches, not a verified number of distinct input items.
Logging/ingestion truncation can undercount both, even when no result rows were
truncated. Compare actual request construction, documented limits and correlated
downstream rejection details; neither a long logged URL nor HTTP 404/500 alone
proves why a service rejected the request. Distinguish not requested, not returned,
truncated, absent and access denied. Unapproved fields/sources require review,
not profile edits by the investigating agent or silently widened access.

## Reviewed browser adapter

Enable `browserAutomation.testSynthesis.enabled`, configure a repository-local
Playwright package and a loopback frontend origin, and add:

```json
{
  "issuePlans": {
    "fixture": "e2e/issue-fixture.mjs",
    "config": "e2e/playwright.config.mjs",
    "directory": "e2e/generated",
    "allowDevWrites": true,
    "dependencies": ["e2e/auth.mjs"]
  }
}
```

This object belongs under `browserAutomation.testSynthesis`. The fixture exports
`test` and `expect`, proves genuine authentication/readiness, and enforces the
approved environment and data access. Use reviewed JS/MJS/CJS adapters for
TypeScript suites. List imported policy/authentication modules in `dependencies`
(at most ten). Policy revisions bind the compiler, configuration, fixture and
listed dependencies; changed bytes require a fresh plan.

`allowDevWrites` declares fixture capability, not a grant. After explicit DEV-write
approval for the current job, `--allow-dev-writes` sets
`FIXLAB_ISSUE_DEV_WRITES=1` only in that invocation's child. Otherwise it is
explicitly `0`, overriding inherited values. The reviewed fixture must honor it,
permit any record only under its exact DEV API URL scope, and continue blocking
production/other environments. The flag is rejected for trace, API-only,
unit-only and non-DEV plans. Do not copy it into persistent authentication config.

A browser plan has `version: 1`, `kind: "playwright"`, positive `workItemId`,
`environment`, current `policyRevision`, `title` and one to fifty `steps`:

```json
[
  { "action": "goto", "path": "/requests" },
  { "action": "fill", "target": { "by": "label", "value": "Name" }, "value": "Updated" },
  { "action": "click", "target": { "by": "role", "role": "button", "name": "Apply" } },
  { "action": "assertValue", "target": { "by": "label", "value": "Name" }, "value": "Updated" }
]
```

Selectors use exact role/name, label or test ID, optionally an explicit `index`.
Actions: `goto`, `fill`, `selectOption`, `click`, `check`, `uncheck`, `press`.
Assertions: `assertVisible`, `assertHidden`, `assertEnabled`, `assertDisabled`,
`assertValue`, `assertText`, `assertCount`. Press accepts Enter/Tab/Escape/
ArrowDown/ArrowUp/Space. Values may be empty to test clearing. At least one action
and measurable assertion are required. Navigation stays on the loopback frontend
after reviewed fixture setup; network guards use fallback, not mocked responses.

The runner exclusively creates UUID-named, Git-ignored spec/config/output paths,
uses the local Playwright CLI, disables retries/capture and runs exactly one
test. The reviewed config must provide top-level settings: generated runs do not
inherit a project matrix. A private reporter accepts only one genuinely passed
scenario, never discovery, zero tests or skips. Only status, failed step/setup
category and hashes leave the runner; raw logs and assertion values are discarded.
Owned processes must finish before owned artifacts are removed; existing tests
and output directories are never overwritten. New authenticated generated specs
stay out of product PRs unless permanent coverage is explicitly requested.

Run the same issue plan before and after the fix. Report actual observed results.
Missing browser packages, sign-in, API access or safe execution scope is a blocker,
not a reason to synthesize successful live evidence.
