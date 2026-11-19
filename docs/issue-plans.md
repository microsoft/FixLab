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

The compiler always adds timestamp bounds, metadata-only projection, timestamp
ordering and a `limit + 1` overflow probe. Policies are capped at 60 minutes and
200 rows. One request per invocation uses the developer's Azure CLI token for
the exact subscription/application, a 20-second timeout, no redirects or retries,
and a 256 KiB response limit. Partial/schema-changed responses are rejected;
overflow returns `partial` and a failing exit code. This is not a persistent
cross-invocation query budget. Empty results mean lookup succeeded, not that the
issue is absent. A lookup's `passed` status never proves a root cause.

Discover candidate operation IDs from issue facts first, then generate a new
bounded plan using observed IDs to inspect requests/dependencies/exceptions.
Do not silently expand scope or equate business request numbers with operation IDs.
Results contain only bounded telemetry metadata, not messages or raw payloads.

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
