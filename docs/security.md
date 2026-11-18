# Security model

FixLab can execute source-control, build, test, browser, and pull request
operations. Treat every runner as privileged engineering infrastructure.

## Identity and authorization

- Authenticate users with the organization's identity provider.
- Authorize by repository, environment, operation, and runner.
- Separate permission to validate from permission to modify code.
- Require explicit permission for pull request creation and deployment.
- Use short-lived credentials and workload identities where possible.

## Secrets

- Never store secrets in repository profiles, prompts, screenshots, or logs.
- Retrieve secrets at runtime from an approved secret store.
- Redact authorization headers, cookies, tokens, and connection strings.
- Keep browser profiles and authentication state outside Git.
- Azure DevOps intake uses the locally authenticated Azure CLI identity. The
  resource token exists only during the outbound HTTPS request and is excluded
  from browser responses, errors, logs, job state, prompts, and caches.
- Work-item response bodies are not included in authentication errors, and
  private Azure DevOps attachments are not downloaded automatically.

## Process isolation

- Optional ticket watching is an explicitly started local Agency or Copilot CLI session, not
  an onboarding side effect. Its fresh `--yes --allow-all-tools` consent binds
  the checkout's ADO origin, configured area subtrees, exact tag, target branch,
  non-production environment and installed helper directory. This is a
  privileged tool session, not an OS sandbox. Agent instructions restrict
  business access to existing read-only guards; tool grants do not technically
  prevent a privileged runtime from issuing other commands. Organization
  controls and normal human MFA remain authoritative.
- The watcher serializes investigations, stores a bounded Git-private
  revision journal, acquiring its exclusive lock before reading any state,
  and verifies draft status, repository,
  target branch and work-item linkage before publishing a canonical PR URL.
  Feedback is escaped and posted only to the bound work item's Discussion.
  Pending feedback is deduplicated after uncertain network acknowledgements.
  Any interrupted job blocks new investigations across the entire journal,
  even when its work item is untagged, missing or reordered. Owner inspection
  is required; an unverified owned-executor stop
  retains the lock instead of admitting another investigation. Ticket executors
  also acquire the dashboard's canonical repository lease across linked worktrees;
  that lease is released only after verified termination. Executor output is
  bounded and line-buffered for credential suppression before display, independently
  of raw structured-result parsing.
- A reviewed `ticketAutomation.migrations` entry permits a dedicated migration
  for one exact work-item ID within validated, existing non-linked source
  directories. This is agent-enforced change scope, not a filesystem sandbox or
  data-access grant. Unapproved migrations remain analysis-only. Profile changes
  invalidate the watcher session; historical approval hashes are deduplication
  metadata, never continuing authority after revocation. Required checks, draft
  verification, repository instructions and read-only business-data controls remain.
- Recovery review is read-only. Dashboard recovery requires the exact loopback
  host/origin; CLI decisions require `--yes` and a matching review token.
  Reconciliation holds both ownership locks, rechecks the journal/profile/ticket,
  linked PRs and matching branches, and preserves a bounded decision audit.
  Retained or uncertain ownership remains blocked; recovery never clears it or
  kills a process. Missing results and changed ticket content cannot be accepted.
  Active linked PRs prevent retry; draft acceptance re-verifies provider linkage.
  Recovery neither publishes feedback nor changes work-item state or Git.
- Ticket content is credential-screened before prompt construction or executor
  handoff, including descriptions, all comments and credential-bearing URLs.
  Rejected content is not copied into diagnostics or journal entries.
  The selected POST and broad-write safety helpers and the API authentication
  helper are bound by contained real path and content revision, then revalidated
  before launch and feedback; changing a helper requires a fresh scope review.
- Completed-attempt handoff requires exact dashboard host/origin, an explicit
  confirmation bound to its instance and a fresh ticket/profile/helper/PR review
  token. It prepares normal canonical intake and preserves durable attempt
  provenance; duplicate retained handoffs are rejected. No watcher state is
  replayed or tool, write, data or deferred-validation grant transferred.
- Optional `analysis.evidenceSources` is discovery metadata, not a connector or
  read-only capability. Entries select only configured non-production
  environments and bounded, unlinked repository-owned JavaScript helpers.
  Discovery never executes them. Helpers still require normal authorization,
  authentication and independently established read-only enforcement; privileged
  tool execution is not sandboxed. Production helpers, credential files and
  automatic host-session MCP inheritance are not supported by this configuration.
- Dashboard watcher monitoring is read-only and bound to the checkout's
  reviewed journal scope. It retains bounded sanitized structured progress,
  not raw output, credentials or browser state. Check messages remain
  agent-reported; completed feedback is never proof of passing validation.
  Explicit `--resolve-on-completion` or reviewed profile opt-in additionally
  permits only the documented `Resolved` investigation handoff, after verified
  draft linkage or a confirmed cause with evidence/next steps. The watcher
  checks workflow support and fresh revision, verifies the returned project/state,
  and persists the submission revision and intended state before sending a PATCH.
  Recovery only reconciles uncertain submissions; it never submits another PATCH
  against a human's newer revision. Blocked,
  inconclusive, out-of-scope and legacy completed attempts cannot trigger it.
- Profile/helper changes require a new scope review. Watcher approval never
  grants ready/merge/deploy operations, production or business writes, and
  does not persist an allow-all grant into ordinary dashboard jobs.
  Optional configured team-approval comments belong to the authorized PR
  workflow, separate from watcher-owned work-item Discussion feedback. They
  do not approve, merge, or change a PR's draft status.
- The reusable dashboard binds only to `127.0.0.1`; it is not a team service or
  public network endpoint.
- Installation never starts a listener. `fixlab dashboard` is an explicit,
  foreground local command.
- The dashboard accepts one job at a time and executes the selected runtime with the
  repository as its working directory.
- Validate-only dashboard jobs prohibit edits, commits, pushes, and pull
  request creation or updates.
- Use one worktree per job.
- Record every process identifier started by the runner.
- Stop only verified descendants of the job's runner process.
- Never terminate a process by name or broad wildcard.
- Use documented local ports and report conflicts safely. The dashboard
  defaults to port 4317 but accepts an explicit alternate port.
- The CI failure-containment workflow runs from `workflow_run` with no source
  checkout and never executes pull-request code with its write-capable token.
  It may preserve artifacts and post a fixed diagnostic link only.
- The separate rollback workflow is limited to failed `push` runs on `main`.
  It checks out the trusted default branch, creates a single `git revert`
  commit on a new branch, and opens a pull request. It never runs the failed
  source, pushes to `main`, or bypasses required review and status checks.
- Scheduled learned-rule review grants Copilot request and read-only contents
  permissions. The direct review disables shell, write, and built-in MCP tools;
  its response is retained as an artifact and cannot modify the repository.

## Data handling

- Use synthetic or approved non-production test data.
- Avoid production unless a separately governed workflow explicitly allows it.
- Sanitize screenshots and API evidence.
- Apply retention limits to logs, screenshots, and temporary worktrees.
- Dashboard screenshots are restricted to five PNG/JPEG/WebP files, 2 MiB each
  and 8 MiB total. Names, extensions, MIME types, base64, and file signatures
  are validated before generated files are written outside tracked source.
- Screenshot artifacts are removed when replaced or on clean shutdown.
  Directories older than seven days are pruned at startup; an abrupt process
  termination may retain files until the next pruning pass.
- The local dashboard's Git cache stores only bounded profile shape, result
  metadata, and sanitized stage summaries under `.git\fixlab`. It excludes
  request text, raw logs, credentials, screenshots, screenshot paths, and
  source contents.
- Cache reuse is keyed by repository identity, `HEAD`, and profile-content
  hash. Current diffs and repository instructions remain authoritative.
- Structured command evidence is written under the repository's Git-private
  `fixlab/command-evidence` path. Credential-like values and credential-bearing
  URLs are redacted before stdout, stderr, summaries, or metadata are written.
- Each structured stdout/stderr stream is capped at 50 MiB. Evidence and
  successful-result cache records are retained for at most seven days and 100
  entries. Failed commands are never reusable.
- Structured-result reuse is opt-in and limited to deterministic local
  validation. Its fingerprint includes command, arguments, stage, working
  directory, platform, Git `HEAD`, tracked/untracked content and status, and
  profile content. Startup, authentication, network/live-browser checks, installation,
  deployment, and mutating commands are excluded.

## Supply chain

- Pin and review package dependencies.
- Scan release artifacts.
- Sign distributed binaries or packages.
- Publish checksums and release notes.
- Protect release workflows with code owners and environment approvals.

## Prompt and tool safety

- Treat issue text, repository content, and web content as untrusted input.
- Allowlist tools, paths, domains, repositories, and commands.
- Require confirmation for destructive or externally visible operations.
- Preserve an audit trail of decisions and tool execution.

## Background permission review

The dashboard's workflow and PR approvals are not runtime permission grants.
Direct Copilot jobs use the official SDK's permission and user-input callbacks.
Human responses are scoped to the current live instance, job and one-use request.
The endpoint requires the exact loopback Host and browser Origin, JSON and
explicit confirmation. It is not exposed as an agent/MCP self-approval operation.
No permanent grant is offered, and managed organization policies
are not overridden. The dashboard offers an explicit **Allow all tool commands
for this run** opt-in, off by default, and **Allow all for this run** on eligible
live Copilot permission requests. These authorize reviewable tool requests without
individual prompts for the current executor only. This is privileged execution:
commands can modify files and contact services; it is not a sandbox or a guarantee
that arbitrary shell commands are safe. Authentication, repository instructions,
read-only/data-safety restrictions, publication consent, required checks and
deployment approvals remain authoritative.

Native Allow all excludes sensitive/unsupported requests, managed human approval,
sandbox escalation, warnings, and the recognized publication-checkpoint commands.
Those requests retain their existing separate review. Questions are never answered
automatically. Choosing Allow all requires explicit confirmation and the exact
dashboard origin. It expires on executor termination, stop, hold, failure or
completion; snapshots, retries, recovered queues and restarted jobs default back
to individual approval. Fresh queued jobs retain only their explicitly selected
choice while the current dashboard stays alive.

A stopped permission-blocked job also offers fresh tool opt-in for one retry,
either alongside exact-folder approval or without adding any folders. This
requires the current dashboard instance, job and request nonce, exact browser
origin and explicit confirmation. Review alone never authorizes tools.
Previously granted folders are revalidated at launch; new folder or URL access
is not implied. A failed launch clears tool opt-in, and another denial pauses
with a new nonce instead of automatically inheriting approval. The MCP control
operations do not expose tool self-approval.

Agency's background CLI receives `--allow-all-tools` only after this explicit
opt-in; its CLI, not the SDK bridge, mediates requests. Without opt-in, unsupported
interactive tool approvals can block a background Agency job. Use direct Copilot
for native dashboard permission review. Do not use Allow all where organization
policy prohibits broad tool authorization.

Native creation and resume enable the SDK's managed-policy
enforcement using the runtime's signed-in authentication. Before sending the
job prompt, the host checks the session's resolved policy and blocks execution
if policy is unresolved or the runtime cannot report it. Policy-loading errors
are not retried without enforcement. Credentials and policy documents are not
forwarded through the dashboard.
Sandbox bypass/permissive requests are explicitly displayed
for review. Sensitive, oversized and unsupported request details disable approval.
Passwords, tokens and MFA must stay in the normal authentication browser.
Pending prompts and answers are memory-only, are omitted from dashboard history,
and are invalidated by stop, hold, shutdown or runtime disconnect. A job retains
its executor lease while a human is answering. This local interface, like other
dashboard controls, is not an authorization boundary against another process
running as the same OS user.

Blocked native requests explain unsupported input, size limits, credential-like
text, credential paths and control characters without exposing original details.
Eligible requests offer **Deny and request safe recovery**. This sends a rejection
with fixed guidance to reuse existing reviewed tests/helpers in the same stage;
it never approves, hides or replays the rejected operation. Managed escalation
and sensitive-path requests do not offer recovery. Existing evidence and failed
checks remain authoritative; a missing safe prerequisite still blocks the stage.

### Broad DEV and PPE API writes

Native Copilot dashboard jobs provide a separate, off-by-default **Allow all DEV
API writes for this job** checkbox. Select DEV, leave explicit read-only or
intercepted modes unselected, then check it when starting a newly reviewed job.
It authorizes `fixlab_dev_write` to send POST, PUT, PATCH and DELETE to **any path
and any record accessible to your account** on the configured DEV HTTPS origins.
You do not enumerate APIs or test records. This is separate from **Allow all
tools** and mutually exclusive with the scoped POST checkbox.

PPE uses its own **Allow all PPE API writes** choice, `fixlab_ppe_write` tool and
`dataSafety.ppeWrite` configuration with the same fields. Declare `ppe` in
`environments` and configure reviewed origins such as
`https://api.ppe.example.test`. PPE grants never inherit DEV configuration or
consent. Neither choice enables broad SIT/UAT or production writes.
For future native PPE jobs only, the dashboard preselects this choice after
the existing origin/helper configuration checks pass. Users can uncheck it;
explicit read-only/intercepted selections suppress it. Identity-bound,
user-authorized MCP `job-start` targeting PPE applies the same default and
accepts `allowPpeWrites: false` to opt out. A scoped POST selection also takes
precedence. The server revalidates configuration at grant creation and use;
readiness is not a grant. Invalid optional PPE setup is reported, not enabled.
Direct HTTP callers still need the exact browser origin and explicit write
confirmation fields. These defaults never modify existing jobs or recover
expired grants. DEV remains off by default.

In `.github/fixlab/repository-profile.json`, declare DEV in `environments`, keep
`productionAllowed: false`, and add this inside `browserAutomation.dataSafety`:

```json
{
  "productionAllowed": false,
  "devWrite": {
    "origins": ["https://api.dev.example.test"],
    "scope": "api://example-service/access",
    "sessionHelper": "tools/dev-session.mjs"
  }
}
```

Review the actual deployment before configuring 1-16 exact HTTPS origins
(scheme, hostname and optional port; no trailing slash, path or wildcard).
Hostnames must contain a `dev` or `development` label, separated by dots or
hyphens; PPE hosts must instead contain `ppe`. Reject conflicting environment
labels, including mixed DEV/PPE names and SIT/UAT/staging/production. These checks
and the explicit profile are an operator assertion, not deployment attestation;
they cannot prove that a misleading DNS alias reaches DEV. Do not list aliases
for another environment.

The existing reviewed `.mjs` helper must export
`withApiToken({ scope, interactive }, callback)` and use genuine authentication.
Complete sign-in separately; the tool neither collects credentials nor bypasses
SSO. JSON object/array payloads are optional, credential-screened and limited to
4,000 characters; URLs and purposes must also be non-sensitive. Response bodies
are not returned. For example, an approved `PUT` to
`https://api.dev.example.test/items/ordinary-record` needs no endpoint or
test-record configuration. HTTP success still requires scenario assertions.

Fresh confirmation requires the dashboard's exact loopback Host and Origin.
Approval uses the same memory-only job/environment/profile/helper-revision grant
and native worker protocol as scoped POST. It expires on executor end, stop,
hold, completion or restart; recovered and later jobs never inherit it.
Configuration changes and unsuccessful or ambiguous attempts require a newly
reviewed job. No redirects or automatic retries. Other environments, API-only,
unit-only, production-backed and explicit read-only/intercepted contracts remain
blocked. Browser guards stay intact: use the mediated tool, not a shell/browser
write substitute. This is not a same-user OS network sandbox.

### Individually confirmed non-production POST

Native Copilot dashboard jobs expose `fixlab_nonproduction_post` for DEV, PPE, SIT
and UAT. The **Allow POST writes for this job in the selected environment** checkbox
is off by default. Selecting it and starting the job explicitly authorizes writes
to that environment's configured endpoints and test records without repeated
payload confirmations. This is business-write approval, not just tool access.
Unchecked jobs require separate exact-action confirmation when POST is needed.
Only the native Copilot dashboard supports job-scoped write approval.
Approval is bound to the exact job, environment and profile/helper revision.
It is memory-only and expires on executor end, stop, hold, completion or restart.
Recovered jobs and saved legacy POST preferences never inherit it. Fresh queued
jobs retain only their explicit choice while the current dashboard remains alive.
Changing configuration requires a newly reviewed job. Missing configuration
blocks the action; adding it later does not expand the original approval.
The browser/auth guard is not removed or bypassed.
API-only, explicit read-only/intercepted, unit-test-only, production-backed and
other-environment contracts are unchanged.
Agency and interactive CLI sessions do not expose this tool and must block such
actions rather than substituting a shell or browser write.

Configure each environment separately under
`browserAutomation.dataSafety.post.dev`, `.sit` or `.uat`. Missing setup explicitly
blocks the action, not unrelated work. The configuration names an existing
reviewed `.mjs` `sessionHelper` exporting
`withApiToken({ scope, interactive }, callback)`, the approved API `scope`, and
1-16 `actions`. Each action binds an exact credential-free HTTPS `url` and a
`testRecord` containing a top-level payload `field` and exact approved synthetic
test-record `value`. No wildcard URLs, queries, production-named hosts or
credential-like/oversized payloads qualify. For example, inside `dataSafety`:

```json
{
  "productionAllowed": false,
  "post": {
    "dev": {
      "sessionHelper": "tools/dev-session.mjs",
      "scope": "api://example-service/access",
      "actions": [
        {
          "url": "https://api.dev.example.test/items",
          "testRecord": { "field": "name", "value": "FIXLAB_TEST_001" }
        }
      ]
    }
  }
}
```

Add separately approved `ppe`, `sit` and `uat` entries with their own destinations,
test records and authentication configuration; no environment inherits another's
allowlist. The profile must also declare the selected environment. Legacy
`dataSafety.devPost` and `fixlab_dev_post` remain supported for DEV. Old snapshots
do not gain job-scoped write approval automatically; they retain per-action
confirmation.

An endpoint being labeled non-production in configuration is an operator assertion, not
proof of its deployment identity. Review the real destination and test data.
The helper must already exist and use legitimate authentication; the tool never
collects credentials or starts interactive sign-in. Credentials stay in memory.
Credential-sensitive debug logging must be disabled.
Without current job-scoped approval, every exact URL and complete JSON payload
receives separate human review, including while Allow all is active. These
requests are excluded from batch approval and expire after five minutes.
With checkbox approval, payloads still require the exact configured test-record
field/value, credential screening and size limits. Review the endpoint contract:
it must scope the operation to that test record; the marker alone cannot prove
the business meaning of other payload fields.
Profile/helper revisions are rechecked before dispatch in both modes.
Redirects are not followed and failures are not retried. Any unsuccessful or
ambiguous attempt stops job-scoped write approval; inspect its effects and start
a newly reviewed job before another write. Response bodies
and credentials never enter results or job history; only status metadata returns.
An HTTP success is not a passed scenario assertion. Existing arbitrary tool
execution remains privileged: this constrained helper is not an OS network
sandbox and cannot enforce the contract against an unrelated same-user process.

A reported text-only non-interactive denial pauses the owned executor without automatic
retries; approval remains unavailable until its termination is verified.

Folder review requires the exact loopback Host, a matching browser Origin when
present, JSON, the current job and request nonce, and a separate explicit
confirmation of the resolved scope. A reviewed folder becomes a job-local
`--add-dir` grant, including read/write access and trusted agent configuration.
Network/device paths, broad roots and known credential/configuration folders
are rejected, and substituted directory targets require another review.
Users must not select folders containing secrets or browser state.

Grants are not persisted or copied to restarted jobs. Tool, URL, sandbox and
organization-policy restrictions are not overridden by folder approval. Text
denials without a structured scope remain explicitly unclassified; this panel
is not a native runtime permission bridge or an
authorization boundary against other processes running as the same user.
