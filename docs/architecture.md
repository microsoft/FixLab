# Architecture

Start with [Architecture and benefits](architecture-overview.md) for component
diagrams, job flow, deployment, and trust boundaries. This document is the
detailed operational reference; see the [documentation index](README.md) for
installation and usage guides.

FixLab separates orchestration from repository-specific behavior.

Native runtime request classification supplies redacted, reason-specific
diagnostics. Eligible blocked operations expose **Deny and request safe recovery**:
the runtime receives a rejection with fixed recovery feedback, not a permission
grant or automatic replay. Existing stage evidence remains authoritative.
Connected status distinguishes `executionState` from the retained job outcome:
`waiting-for-input` and `waiting-for-permission` are not active validation.
Non-sensitive native questions expose their exact request ID, question and
choices. An explicitly confirmed `answer` reply is bound to the current
instance, job and first pending request and continues that executor, without
restarting stages or copying the answer into logs/history. Questions containing
URLs remain dashboard-only so redacted destinations cannot be blindly approved.
Credential-entry requests, including API keys, refresh tokens and PINs, are
rejected before either input channel, including direct question transport.
This includes displayed titles, details and choices. Diagnostic questions about
credential-related tests and non-sensitive diagnostic answers remain supported;
credential solicitation and answers containing credential values remain blocked.
Native permissions stay in the browser panel; connected status exposes only
fixed reason codes and recovery guidance, never commands, diffs or grant buttons.
Separately, `fixlab_nonproduction_post` mediates DEV/PPE/SIT/UAT writes through each
environment's existing authentication helper and exact endpoint/test-record
allowlist. The off-by-default job-start checkbox authorizes configured writes
for this job without repeat confirmation. Approval binds the job, environment
and profile/helper revision and expires with execution; it is never recovered.
Unchecked jobs still require exact, expiring, single-use action confirmation.
Allow all and batch approval do not grant writes. This native dashboard capability
does not expand API-only/read-only or other-environment contracts. See the
[security model](security.md#individually-confirmed-non-production-post) for configuration
and the privileged-execution boundary.

Reviewed Playwright business-request guards can use the current native executor's
private browser POST relay. The runner imports `FIXLAB_BROWSER_POST_HELPER` from
its inherited environment and calls `forwardApprovedBrowserPost`. The relay
shares the POST tool's authorization, authentication helper and failure
revocation; no separate approval file or browser token is used. It exists only
with fresh configured job consent and closes on executor shutdown. Bounded API
responses return privately to the browser, never to the model or dashboard
history; status metadata alone does not establish a passed scenario.
Broad PPE-origin jobs also expose `forwardApprovedBrowserRequest` for GET and
CRUD through that same authentication and grant. This supports load/save/reload
journeys without narrowing PPE to reads or treating every POST as a write.
Browser requests are serialized; failed/ambiguous attempts revoke the shared
grant without retrying pending actions. Other environment/POST-only scopes
remain unchanged.

The private relay allows at most 16 pending requests. Its bounded transport
deadline includes queue time (20 seconds per slot, at most 320 seconds total);
the upstream dispatch still has its separate 15-second limit. A slow earlier
request does not consume a later request's dispatch budget.

For broader DEV validation, the separate **Allow all DEV API writes for this job**
checkbox exposes `fixlab_dev_write` for POST/PUT/PATCH/DELETE on exact reviewed
`dataSafety.devWrite` HTTPS origins, without endpoint/test-record enumeration.
It can affect any accessible DEV record and reuses the same revision-bound,
memory-only grant and lifecycle revocation. No other environment or explicit
read-only contract is expanded; browser guards remain intact. See
[DEV/PPE write configuration](security.md#broad-dev-and-ppe-api-writes).

Legacy feature-specific browser guards are repaired through the separate
interactive `fixlab setup-queries` operation. It requires a selected,
profile-approved non-production browser read scope. Planning does not change
files; `--yes` authorizes only reviewed query-policy/adapter changes and focused
offline guard tests. It does not issue business API requests, grant runtime
permissions, change product source or authorize writes. Both runtimes receive
the same setup contract. Guard changes require a fresh reviewed validation job;
validation-only jobs keep configuration read-only.

PPE has an independent `dataSafety.ppeWrite` configuration, per-job confirmation
and `fixlab_ppe_write` tool with the same CRUD methods and grant lifecycle.
DEV grants never authorize PPE or other environments.
For future native PPE jobs, dashboard intake and identity-bound MCP `job-start`
default this choice on only after the reviewed PPE origins/helper pass the
existing configuration checks. Explicit opt-out, read-only/intercepted selections
and scoped POST choices take precedence. Invalid optional setup is reported in
readiness without blocking ordinary read-only work. Direct HTTP starts remain
explicit; existing jobs and grants are unchanged.

Dashboard and MCP starts default routine source/test access and dashboard-owned
validation gates on, with explicit opt-out; validation-only jobs remain read-only.
The active SDK session's bounded regular checkpoint Markdown has a read-only
exception, not general access to Copilot state. Managed and sandbox checks remain.
Eligible source edits exceeding inline review's 8,192 characters retain only
safe filename/size/request metadata. Guided review stops the owned executor,
reviews stopped-job source trust and prepares explicit fresh authorization.
Old denials stay denied; nothing replays automatically. The complete request
still undergoes the existing 1 MiB scan and path/content/policy checks.

Job authors may explicitly select **Create an unverified draft PR without
running checks** (`deferValidation`). This changes draft creation readiness only:
the reviewed nonempty code diff may be published while local and live gates
retain their real not-run, pending or failed outcomes. It never makes full
validation pass or permits ready-for-review/merge. **Defer live/browser/API
tests** (`skipLiveTests`) retains local checks without requiring live integration.
Both choices force draft publication and exclude explicit manual/all-UI or
production validation.

**Use the deployed non-production backend** (`useDeployedBackend`) selects the
reviewed API for the chosen DEV/SIT/UAT/PPE environment instead of starting local
.NET/Key Vault. Existing SSO, read/write guards and target allowlists still apply.
Local API testing is optional for draft creation; unavailable startup is
disclosed, not a passed integration check. A deployed API cannot validate
unpublished backend code.

Code-job preflight findings such as missing npm/.NET tools are passed to Copilot
as setup diagnostics rather than rejecting the job before reasoning starts.
Recovery uses existing repository commands, verifies each distinct repair and
continues independent work. Validation-only jobs retain prerequisite enforcement;
human sign-in and actual permission requirements are never bypassed.

Validation-only and Playwright-only jobs may create focused, job-owned transient
journeys in the configured test directory and retain runner evidence in configured
artifact directories. Existing tests, product source, repository configuration,
authentication helpers and browser state remain unchanged. The journey is kept
for same-job retries while validation is blocked and cleaned up after owned
execution finishes. This exception is included in continuation prompts for older
jobs as well as new jobs; it does not grant runtime permissions, reverse prior
denials or authorize business-data writes.

Dashboard job prompts scope delivery/publication guidance to code jobs and state
the marker protocol once rather than repeating it throughout the workflow.
Validation-only prompts retain authentication, permissions, data-safety and
evidence requirements without instructions to prepare or publish code changes.
Focused tests bound the generated prompt sizes and check those retained contracts.

Code jobs emit a bounded `FIXLAB_SUMMARY|<one-line JSON>` engineering explanation
at their reviewed fix checkpoint and completion. Required fields are `problem`,
`rootCause` and `codeFix`; optional fields capture expected/actual behavior,
relative changed files, a commit reference, regression details, risks and
workarounds. The dashboard sanitizes and preserves this record independently of
short stage messages through retries, history and restart. Invalid/oversized
records are explicitly rejected; neither records nor reviewed notes can mark
tests passed or grant permissions.

For an older stopped job, an explicitly confirmed local JSON client can submit
reviewed notes to `/api/job/engineering-summary`, binding the exact instance,
repository and job. It rejects browser Origins, active/unknown jobs and unsafe
paths. Notes are labeled `reviewed-note`, not runner proof; agent records are
labeled `agent-reported`. Missing details are not invented from current source
or a different job. The summary view does not execute tests or fetch source.

FixLab is distributed and versioned as its own product. It supports Agency
Copilot as the default compatibility runtime and GitHub Copilot CLI as an
optional direct runtime. Both provide agent execution, authentication, plugin
loading, and tools. FixLab does not fork either runtime. Direct Copilot
dashboard execution uses the official SDK and its bundled runtime;
interactive CLI execution uses the selected runtime command.

The package keeps equivalent runtime entry points in `agents/fixlab.md` for
Agency and `com.github.copilot/agents/fixlab.agent.md` for the Agent Plugins
1.0 layout used by direct GitHub Copilot CLI. Repository policy validation
requires those definitions to remain identical.

Direct Copilot execution accepts `--model` or `FIXLAB_MODEL`; Agency rejects
nonempty model overrides. Dashboard jobs retain their selected model through
queueing, retries and saved-context recovery. An omitted model uses the
dashboard's configured default; an explicit empty selection uses Copilot's
own default. HydraFusion adds `--experimental --model hydrafusion` and remains
an account-dependent research preview, not a guaranteed cost or speed saving.
Stage markers are requested before tools and parsed even when adjacent in
rendered output, but model-dependent buffering can still delay visible updates.
Snapshots also retain their originating runtime. A dashboard restores only
compatible jobs; other-runtime or ambiguous legacy contexts remain in history
rather than being silently resumed through a different executor.

```text
Defect or pull request
        |
        v
FixLab dashboard or CLI
        |
        v
Local job queue and private metadata
        |
        v
Owned local executor
  - isolated worktree
  - repository profile
  - tests and builds
  - local applications
  - browser automation
        |
        v
Result, evidence, and pull request status
```

Optional `linkedApplications` profile references connect separately onboarded
local frontend workspaces without extending repository execution boundaries.
The dashboard resolves only configured Git roots and contained frontend
configuration, requires explicit local/non-production policy, and binds opening
to the source instance plus source/target configuration revisions. It reuses the
verified workspace registry and existing owned-workspace lifecycle. Links never
start commands/jobs, transfer credentials or permissions, relax API-only gates,
or count as integration evidence. See [repository onboarding](repository-onboarding.md#linked-local-applications-in-separate-repositories).

Separately approved `linked-api-proof` requests may ask the verified frontend
owner to run its existing authentication and proof commands. Both profiles must
explicitly bind the API-only consumer, linked frontend and exact local HTTPS
GET endpoint. The frontend owns browser execution and token use; only a fresh,
instance/run/configuration-bound result returns to the API consumer. This does
not grant arbitrary commands, endpoint overrides, writes or cross-repository
editing. Existing API-only admission and validation gates remain required.

## Components

### Delivery policy

Generated PR descriptions are concise by default (normally at most 120 words),
with required repository-template fields, a brief summary, compact actual
validation outcomes and material risks/blockers. Failed, skipped, pending and
not-run checks remain explicit; evidence is linked rather than pasted as logs.
Required templates and material risks can justify additional detail.
PR descriptions exclude token/cache counts, AI-credit totals and model-cost
summaries. Repeated runtime token meters are omitted from activity logs;
structured usage metrics, persistence and input-token limits remain active.

Reusable learning is part of the existing **PR** stage, not a separate roadmap
stage. Before committing an authorized change, the runner reviews task-relevant
repository skills and updates a matching skill or creates
`.github/skills/<topic>/SKILL.md` only for verified, non-obvious, reusable
knowledge. The skill includes YAML name/description, when to use it, the
verified solution, file/test references, working directories, validation
commands and pitfalls. It is reviewed in the same PR, with applicable
documentation/skill checks; the concise PR body links it or records that no
new reusable learning was identified. Empty, speculative and duplicate skills
are not created. Read-only jobs cannot write skills; existing instruction
governance, approvals and permissions remain authoritative. Generated skills
must not add tool grants or contain credentials, personal/customer data,
private endpoints or raw transcripts. This versioned repository knowledge is
distinct from the local advisory metadata cache and does not automatically
promote learned rules or share consumer knowledge with other repositories.

`dashboard/workflow-policy.js` supplies product-wide defaults for new jobs:
`workflow: { mode: "efficient", publication: "draft", unitTestsAfterPr: false, optionalBuilds: false }`.
Repository Settings persists overrides once. The reviewed focused checkpoint
precedes an authorized draft PR; ready-for-review publication requires the
explicit `publication: "ready"` preference. Broad unit tests and builds run
only by saved preference or explicit selection. Legacy saved jobs without a
publication field retain their recorded ready-for-review intent. The runtime
also preserves legacy strict-ready intent when no publication preference is
specified. An explicit strict plus draft choice remains draft, with provider
`isDraft: true` verified; strict validation requirements are unchanged.

Editing jobs with saved draft publication separate local checkpoint readiness
from full integration readiness. After focused regression, required local gates
and effective-diff review pass, authorized frontend or backend draft work can
proceed without unavailable API/SSO/browser integration. Declaring a backend
does not itself require local .NET/Key Vault startup for frontend-only work.
Approved deployed DEV reads need legitimate API access, not necessarily a local
backend; identity-only SSO does not authorize business reads, and a deployed
API does not validate unpublished backend changes. Deferred integration stages
are skipped with prerequisites and disclosed in the draft, never passed.
Explicit manual/all-UI, production-read-only, ready/merge and permission gates
remain unchanged.

Portal-backed API authentication is an opt-in repository onboarding/settings
contract. The portal's repository-owned session adapter supplies a scoped token
only to an in-process callback. The generic `portal-api-proof` worker creates a
local HTTPS Playwright `APIRequestContext`, performs anonymous and authenticated
read assertions, disposes it and retains sanitized proof only. API consumers
invoke the separately owned frontend workspace; they never receive its token
or browser state. API proof has separate commands and an explicitly confirmed
connection purpose; normal portal authentication does not run local API checks.
Setup preserves existing browser authentication checks and adds one
required live-test gate without replacing existing validation. Session adapters
and API response schemas remain application-specific and explicitly reviewed.
The runtime
executes these checks through the existing permission-controlled, owned gate
interface; no independent unreviewed shell scheduler is introduced.

A default-off `productionDatabaseReadOnly` exception permits only an approved
local HTTPS API backed by a production database. The repository adapter must
verify the actual target and database-enforced read-only identity through
`assertReadOnlyDatabase` before API or token activity. Separate portal/consumer
profiles and exact-endpoint grants must agree. Dashboard jobs require fresh,
job-bound proof before executor launch; direct CLI jobs cannot bypass it.
Production-backed receipts/evidence remain explicitly labeled
`production-read-only`, with no mutations. Changed approval cannot carry over
to saved jobs. General production access, deployed production targets, portal
UI jobs and writes remain forbidden; FixLab never changes database connections
or permissions. See the [onboarding safety contract](repository-onboarding.md#local-api-backed-by-a-production-database).

Stopped jobs expose identity-bound, explicitly confirmed configured gate
selection: all, tests, builds, one gate, or a stage. Gate `kind` and `stage`
metadata disambiguate repository commands. Runs acquire the canonical executor
lease; overlapping work and queue advancement are blocked until owned execution
settles. Completing a scoped job cancels and waits for owned validation before
advancing the queue, without changing failed, stale or deferred outcomes.
Unverified termination retains the lease for recovery.

Regression slimming removes duplicate expensive setup, not safety assertions.
Value matrices belong in fast pure checks; browser tests cover representative
distinct flows. Jest and Playwright discovery remain separate, and authenticated
projects must be explicitly selected rather than added to broad unit commands.

Gate applicability and publication requirements are separate. In efficient
editing jobs, only applicable gates explicitly marked `required: true` block
publication. Other gates remain executable with honest pending/failed/stale
results. `advisory` is not `passed`, and `fullValidationPassed` reports whether
all applicable configured gates really passed. Read-only jobs and explicit
strict delivery retain the original all-applicable-gates requirement.

Snapshots retain delivery policy. Legacy snapshots restore as strict instead
of silently weakening an existing job. `/api/job/workflow` permits an explicitly
confirmed, exact-origin, identity-bound stopped-job migration without editing
the pinned repository profile, clearing validation history or resuming work.
An explicitly strict repository policy cannot be waived through this route.
Required approvals, repository instructions and remote CI/merge policies remain
authoritative in both modes.

Browser-only reproduction and deployed-result checking use the existing
`playwright-only` read-only scope. The runtime first checks the selected
environment's approved existing application and supported authorized browser
connection. It skips unnecessary stack setup and preserves exact target/version
and assertion evidence. No browser state is copied and profile locks remain
authoritative; an unavailable deployment does not authorize a different target.
Offline job preflight receives the mode and checks only the browser runner and
required authentication tools for this scope, rather than rejecting it for an
unused backend or restore toolchain. Fix/checkout validation retains those
checks. A deployed baseline cannot prove unpublished code or another PR commit.

The SDK continues to load native Copilot configuration, tools and instructions,
without a replacement system prompt or restricted tool list. FixLab supplies
scope, safety, evidence and continuity guidance, not a separate cut-down coding
model. The selected model and environment still affect speed and results.

### Dashboard or CLI

Browser jobs apply the verified read-only POST query policy by default,
independently of the write-request checkbox. Repository guards remain
authoritative; a missing query allowlist entry blocks the live read rather than
triggering synthetic fallback. See [verified query handling](commands.md#verified-read-only-post-searches).

`browserAutomation.mode` defaults to `browser` for existing profiles. Explicit
`api` mode requires backend startup/loopback health, a Playwright package and
test command, authentication intent and a read-only origin/method allowlist.
Doctor creates and disposes an `APIRequestContext` without launching or
installing a browser; that offline probe does not prove API access or sign-in.
API jobs do not inspect browser-profile ownership. React startup, manual UI,
video and full-UI options are rejected. Live scenario evidence remains mandatory
and cannot claim intercepted/synthetic API success. The repository-owned runner
must enforce request/redirect safety, fresh authentication and sanitized API
assertions. Missing live prerequisites remain blocked. Browser profiles keep
their existing frontend, browser, ownership and screenshot requirements.

Collects defect details, screenshots, repository selection, validation mode,
environment choice, and blocker policy. It displays stages, evidence, and
required human actions.

Run options include an explicit, default-off **Allow all tool commands for this
run** choice. It is passed to the executor, not saved as a repository default.
Direct Copilot can also grant it from an eligible live permission card. It skips
individual reviewable tool prompts, not user questions, managed human approvals,
sandbox escalation, sensitive requests or recognized publication checkpoints.
It does not waive authentication, repository/data-safety rules or validation.
The choice is privileged execution and expires with the executor; snapshots and
retries return to `ask`. Agency adds its broad CLI tool flag only after opt-in;
its non-interactive default can block on permissions that require a human.

When the selected current job has a freeform runtime question, the message
composer submits an identity-bound answer through the existing runtime-response
route, never the new-job route. New conversation retains explicit new-job intake.
Changed question identities clear unsent replies with a notice, and failed
delivery preserves the reply without falling back to job creation. Runtime cards
distinguish unanswered questions from permission requests and explain that an
active Allow all choice does not authorize ineligible requests or supply answers.

`fixlab <repository>` is the Agency-like conversational entry point. It opens
the packaged FixLab agent directly in that repository so setup, diagnosis,
implementation, and validation can proceed in one interactive runtime
session. `fixlab chat` is a separate thin terminal client for an already
running dashboard job. When the dashboard is unavailable, chat uses the
current ready repository or prompts for its path. For an incomplete repository
it creates the initial profile when missing and opens the interactive
onboarding agent; after readiness succeeds, it starts the dashboard as a
detached loopback process and reconnects. It polls only the loopback dashboard
API, streams the bounded job output, and sends comments or resume actions back
to the same dashboard-owned runtime session. Exiting the terminal leaves the
job running; an explicit stop request terminates only the executor owned by
that job.

The stdio MCP server also connects an existing host conversation to that
dashboard. `fixlab_dashboard_status` reads a bounded `/api/conversation`
projection containing instance/repository/job identity, stages, gate status
and an actionable recovery question, without raw logs or private inputs.
`fixlab_dashboard_reply` submits an explicit user answer to
`/api/conversation/reply`. The server checks instance, repository and current
job identity after reading the request body, before any state change. Stale
answers conflict instead of targeting a replacement job. Permissions and
authentication retain their separate approval flows. The host must invoke
status and its question UI; MCP does not inject prompts into idle sessions.

An optional Copilot notification extension supplies event-only delivery
separately from that request/response MCP bridge. Its in-process Node.js
monitor reads the same bounded loopback projection without model calls,
bound to one canonical repository, dashboard instance and job. Unchanged
states stay local. New blocker fingerprints, reviewed permission nonces,
completion and monitor termination enqueue a host turn through
`session.send({ mode: "enqueue" })`; those turns still consume tokens.
Messages contain identity and event metadata, not raw blocker instructions,
logs or request bodies. The host refreshes state before presenting a decision
and retains all existing explicit-approval and mutation guards.

Installation and starting a watch are separate opt-ins. The monitor does not
persist configuration or job content, automatically follow replacement jobs,
or continue beyond its Copilot session. Completion, hold/cancellation and
identity replacement end the watch. Consecutive read failures are bounded,
and ambiguous message-delivery failures stop rather than creating duplicate
approval prompts. Private history, required gate evidence and executor process
ownership are unchanged. This monitor observes state, not the runtime itself.

`fixlab_dashboard_control` covers existing job/queue, profile gate, frontend,
authentication, scoped permission, session and intake operations through a
fixed route allow-list. Each request carries the expected instance, canonical
repository and current job; writes also carry explicit user authorization.
The dashboard advertises the identity-bound control protocol; MCP refuses
older dashboards rather than sending requests whose guards could be ignored.
The server verifies these before dispatch and after asynchronous body reads,
then runs the original handler and its existing safety checks. Forwarded
responses use bounded operational metadata rather than raw logs, browser state
or credentials. The bridge does not replace authentication, process ownership,
permission nonces, environment approvals or executor-backed validation.
Browser-only PR requests must verify the assigned source commit and use the
repository's Playwright configuration instead of guessing commands or quietly
expanding to full regression.

Shared-checkout admission failures on an eligible configured-user FixLab
branch expose a reviewed-reuse question instead of misleading incomplete
stage markers. Explicit approval binds the branch, HEAD, profile branch
configuration and tracked/untracked content fingerprint. Admission rechecks
this under the executor lease, preserves the current branch and work, records
the original branch-owner job ID, and does not fetch or switch. Saved ownership
still verifies branch format and base ancestry on subsequent resumes.
In-progress Git operations and unverified executor termination remain blocked.
When admission never started a runtime session, reviewed recovery starts one
with the same job ID rather than attempting to resume a nonexistent session.
Dashboard-generated pending-gate review blockers do not count as agent progress
for a zero-progress launch retry.

User-selected scoped iteration is persisted separately from gate evidence.
Full regression remains deferred and readiness blocked until the user
selects full validation and the required gates pass. Independent safe checks
can continue after unrelated failures; dependencies and approvals still apply.

An opt-in `validation.changeAware` policy generalizes API-only selection to
reviewed component path-to-gate mappings. All matching scope gate sets are
combined, with pinned-baseline and executed-history safeguards unchanged.
Unknown, empty, unreadable and full-validation-path changes retain all gates.
Invalid validation profiles are rejected at job admission with HTTP 400 rather
than escaping the dashboard's asynchronous request handler.

Efficient jobs also infer conservative affected-surface selection automatically
when profiles declare literal component paths, test patterns, gate working
directories and a configured target branch (`worktreeSetup.baseBranch` or
`pullRequests.defaultTargetBranch`). Explicit `changeAware`/`apiOnly` policies
take precedence; strict workflows do not infer a policy. Gates outside component
directories and all explicitly required gates stay applicable. Overlapping
components combine their gate sets. Shared code, contracts, dependency manifests,
project/startup configuration, unknown paths, missing metadata or an unverifiable
target baseline retain broader validation. Explicit full/UI/manual requests,
previous failures and recovered-history safeguards are unchanged.
Dependency restore configuration, including `NuGet.Config`, `packages.config`,
`packages.lock.json` and `.npmrc`, also retains broader validation.

Dashboard job and noninteractive CLI request prompts include bounded component-path/test-pattern retrieval
hints, prioritizing a reported component or file path without caching source
contents or indexing the repository. Hints are advisory: only the complete Git
diff determines gate applicability at validation checkpoints, not report keywords.
An automatically selected component scope also reports applicable applications
and browser applicability, avoiding unrelated startup without waiving required
live gates, authentication or repository instructions. Skipped startup/live work
is never reported as passed.
API-only and unit-only profiles never infer browser startup from a gate's
`live-test` stage; applicable and previously executed gates remain required.
Interactive CLI sessions use the equivalent packaged agent guidance without
adding component metadata to Windows' bounded interactive command line.

The dashboard job form does not request optional folder preflight. An API/control
client can explicitly set job `permissionPreflight` to pause before executor
admission and use the existing exact-folder review/approval flow. It grants nothing by
itself, and the first approved invocation starts a new runtime session rather
than resuming one that never ran. No grants persist across dashboard restart.
Completed preflight lifecycle state does persist so a recovered session is not
misclassified as an unstarted one; restarting as a new job resets that state.
A pre-executor workspace blocker retains the approved job-local folder grant
and surfaces workspace review instead of restoring a conflicting permission
request. The reviewed-workspace retry then starts the first executor fresh.
If a grant becomes invalid before that launch, its replacement review retains
the fresh-launch state; approval never resumes a nonexistent runtime session.

The packaged dashboard is a single-user local implementation using Node.js
built-in HTTP APIs.
It binds to `127.0.0.1`, reads the selected repository profile, invokes the
packaged Agency plugin, and retains one active job plus a bounded 20-job
pending queue and a separate persisted held-job collection. It also writes the
latest 20 private job summaries to the shared Git directory so bug outcomes,
held workflow state, and pull-request readiness remain visible after a
dashboard update or restart. It is not the durable, authenticated team broker
described below.

Same-repository dashboard instances publish private, temporary loopback
ownership records and verify the random instance ID at the live endpoint
before forwarding a session-control request. The session panel reconnects to
live owners or resumes their saved job context; stop and shutdown require
explicit owner confirmation. Shutdown leaves the HTTP dashboard available
and stops only its tracked agent, frontend and authentication processes.
Conflicting reachable owners are reported rather than automatically killed.

Executor admission also acquires one atomic filesystem lease per canonical
repository before invoking a runner. Git worktrees share the Git common
directory; standalone non-Git repositories use their canonical directory.
An acquisition records the owner, job, process generation and a unique nonce.
All new jobs, queue starts, retries and automatic continuations use this same
boundary. A logical timeout or stop request does not release the lease or
enable resume before the executor's termination promise settles. Unverified
termination, partial reservations and owner crashes remain fail-closed; neither
an HTTP timeout nor PID reuse authorizes automatic reclamation.

An opt-in `worktreeSetup.mode: "shared"` profile lets sequential dashboard jobs
reuse the selected checkout. Admission holds that same executor lease while
checking cleanliness, refreshing the configured remote base and acquiring a
job-specific branch. Its branch and base commit are persisted with the job.
Held/resumed jobs reacquire their saved branch without syncing it to the base;
restarted jobs acquire a new branch. PRs can remain pending while another job
uses the folder, but dirty files, in-progress Git operations and owned
frontend/authentication processes prevent branch changes. The executor must
leave its assigned branch selected. See [shared checkout setup](repository-onboarding.md#reusing-one-checkout-for-sequential-jobs).

Windows executors launch suspended, enter a non-breakaway Windows Job Object,
then resume. Each executor has one hidden console that ordinary tooling
descendants inherit, preventing transient PowerShell and command-prompt windows
without sharing shell state between jobs. Input, output and errors remain piped
to the supervisor and dashboard logs. Noninteractive CLI probes and setup
helpers also hide their Windows console windows; interactive agent sessions
continue using the user's terminal.
Direct Copilot executors run a Node.js SDK host inside the same owned process
containment. The official SDK starts its bundled runtime as a contained child.
Bounded JSON-line messages carry output and structured permission/question
requests over the existing pipes; prompts and answers are not process arguments.
The host holds each SDK callback until the dashboard returns the corresponding
response. Up to eight concurrent requests remain in memory, not persisted job
history. The job stays running with its executor lease held, while idle timeout
and heartbeat are suspended until all human requests resolve.

The dashboard offers allow-once/deny or the question's actual choices and optional
freeform answer. Responses require the exact loopback Host and browser Origin,
current instance/job/request IDs, JSON and explicit confirmation. Consumed or
cancelled IDs cannot be replayed. **Allow all pending once** displays a bounded
snapshot of approvable permissions and requires one explicit confirmation.
The client rechecks the instance, live job and exact reviewed request details,
then uses the existing single-use response endpoint for each captured ID.
New requests, questions and non-approvable requests are excluded. Partial delivery
stops immediately and reports confirmed approvals; it never rolls them back,
retries automatically, or grants permission to future requests.
Stop, hold, shutdown and executor loss invalidate
pending requests; no answer or approval is inferred. Sensitive, oversized,
malformed or unsupported permission details cannot be approved. Credentials and
MFA remain in the browser, never question responses. Managed runtime policy
remains authoritative; no blanket or permanent grant is synthesized.
After enterprise policy is available, two built-in read-only exceptions return
one-request, non-interactive approvals: native glob filename discovery under
canonical, non-sensitive checkout directories, and the exact
`node <this-installed-fixlab.js> --help` command. Discovery is identified by the
native glob tool's fixed intention, never a generic directory read or content
search. It may list protected filenames but grants no access to their contents.
Help accepts only the running package's canonical CLI entrypoint, without extra
arguments, composition, redirects, reported external paths or URLs. Neither
exception creates a scope or overrides escalation, warnings or managed human
approval.
Additionally, `/api/job/file-access` reviews source-read or source-read-write
trust for one stopped native job, bound to its canonical checkout and job UUID.
Exact loopback Host/Origin, current instance/job, JSON and explicit confirmation
are required. It neither resumes nor approves pending runtime requests. The
private job snapshot retains this separate grant across same-job resumes and
dashboard restart; creating or copying a job resets it. The native host validates
the identity again; non-fix modes cannot receive edit trust.
The policy checks each path again, including configured authentication paths,
symlinks, hard links, file type and protected configuration names. New files
require canonical existing parents. Source/test trust grants neither commands
nor managed-policy exceptions. The exact repository profile is read-eligible
only with bounded valid JSON and sensitive-content checks; writes and arbitrary
JSON remain outside trust. Stop the executor before changing or revoking it.
Dashboard-owned validation writes an exclusive `job.json` sidecar beside its
sanitized command output. Reviewed file trust can read bounded stdout/stderr
logs inside the checkout's `.git/fixlab/command-evidence` only after matching
that sidecar's job/repository identity and rechecking links and sensitive
content. Older unowned artifacts and other Git metadata remain manual.
An optional `allowValidationGates` flag in that explicit review additionally
matches only the running package's `node ...fixlab.js gate` invocation with
this job UUID, canonical checkout, current owning dashboard port and four
known options. Extra arguments, composition, reported external paths/URLs,
escalation and managed human approval stay manual. The dashboard retains all
gate-membership, checkout, profile-freshness and execution-state checks; this
is not a general shell grant.

Eligible native requests separately offer a reviewed executor-local scope:
non-sensitive repository source/documentation/project-file reads, or an exact
test command bound to its canonical in-repository working directory, reported
paths and package manifests. Directories, hidden/sensitive files, linked paths,
unknown commands, network requests, escalation and managed human approvals stay
manual. Missing canonical command metadata cannot receive a command grant.
Changed package manifests or command identity require review again. These scopes
remain only in the SDK host's memory and expire on every executor termination,
including an automatic continuation; snapshots, retries and new jobs cannot
restore them. Automatic matches still return one-request decisions and never
claim that the matched request itself was interactively approved.
Workflow input and MCP conversation replies cannot approve native requests.
The SDK's Node.js requirement is 20.19+ in the 20.x line or 22.12+.

If a text-only runtime reports that permission was denied because no interactive user
was available, the dashboard stops its owned executor at the first denial and
keeps the lease until termination is verified. It displays a separate permission
panel rather than treating ordinary workflow input or PR approval as runtime
authorization. Current CLI text output does not identify a structured permission
scope; the panel says so and does not infer that a denied command is safe.

For a confirmed external-folder restriction, the user can review an absolute
folder and explicitly grant its resolved path before restarting the same job.
The resumed executor receives only that additional `--add-dir` scope; the grant
includes read/write access and trusted agent configuration beneath that folder.
Roots, home and repository ancestors, broader installation parents, and known
credential/browser-state/configuration folders are rejected. The target is
revalidated at approval and each subsequent launch. Approval is bound to the
current job and request nonce, requires the dashboard's exact loopback host and
same origin, and never survives a restart or transfers to a new job. A late,
stale, or unconfirmed approval cannot start an executor. Ordinary comments,
retries and automatic continuation cannot bypass the pending permission review.
Tool, URL, sandbox and organization-policy restrictions remain authoritative;
a folder grant does not authorize them. Another denial pauses again instead of
automatically retrying or granting blanket access. This is a folder-access
handoff, separate from direct Copilot's native request bridge. A historical text
denial cannot be converted into a live native approval after its executor exits.
Managed long-running frontends keep their input pipe open until owned shutdown;
React-style servers can interpret EOF as a request to exit. One-shot setup and
authentication helpers still receive EOF, and process-tree containment and
termination proofs remain unchanged.
The supervisor terminates remaining descendants after launcher
exit or an owned stop request, and records a nonce-bound proof only after the
job's active process count reaches zero. Lease release requires both supervisor
exit and that proof; a supervisor crash remains fail-closed. This uses built-in
Windows PowerShell and its C# compiler, with no native package dependency.
Unavailable containment or missing proof is an explicit failure, never a
fallback to launcher-only checks. Dedicated Windows CI exercises real detached
descendants, explicit stop, wrapper crash and lease succession.

Manual localhost validation must use a frontend managed outside the Windows
executor, such as the dashboard's React session, and verify it serves the
validated checkout. Dashboard-managed applications remain under session
controls rather than being terminated by an agent. Missing checkout or health
evidence remains a blocker.

Dashboard requests are typed as `bug-fix` or `small-enhancement`. Bug fixes
require evidence-backed diagnosis and reproduction. Small enhancements use a
risk-scaled fast path: a concise acceptance contract, affected-surface and
bounded-file-scope checks, and the smallest existing focused test. They avoid
manufactured defect reproductions and skip broad suites or full builds unless
the profile or user-visible/risk evidence requires them. Unlike a general
coding agent, FixLab retains explicit review, live-test, pull-request, and
skipped-stage evidence while prohibiting unrelated changes.

Playwright-validation-only mode provides a narrower read-only path for fixes
that are already implemented. It skips source diagnosis, separate
reproduction, implementation, effective-diff review, non-browser validation,
and pull-request work. The runner performs only profile-required setup,
browser-authentication readiness, required application startup, and the
focused Playwright journey. Skipped stages remain explicit rather than being
reported as passed.

The dashboard's primary free-text input is only the bug or required
enhancement. Repository/profile-defined context supplies commands,
applications, systems, environments, and live-test journeys. The agent owns
contract generation, diagnosis or surface inspection, the smallest required
implementation, effective-diff self-review, focused local validation,
profile-defined startup and live testing, evidence collection, and the gated
pull-request outcome. It asks for human interaction only for authentication,
unsafe-data approval, deployment or pull-request approval, or genuine blockers.
The job form also exposes the repository profile's allowed non-production
environments. A user can explicitly select environments such as DEV or SIT for
profile-defined application startup and Playwright live testing. The server
rejects values outside the profile allowlist and production aliases. The agent
must use the selected environment exactly or block with the missing
prerequisite; it cannot silently fall back to local or another environment.
Direct CLI runs provide the equivalent
`fixlab run --environment <profile-environment>` option.
An optional manual localhost gate is independent of Playwright. After the
profile-defined React frontend passes its loopback health check, the dashboard
opens that URL in the user's default browser, keeps the FixLab-owned frontend
available, and blocks completion until the user records Passed or Failed. The
resumed session then stops only its owned process and continues the normal
gated outcome.

Repository profiles can enable first-class test synthesis. Before browser
execution, the agent turns the reported behavior and expected result into the
smallest focused Playwright scenario and measurable assertions. A
`synthetic-intercepted` source fulfills business-data reads locally and an
`intercepted` mutation mode captures request counts and payloads without
changing external records. The agent emits structured `FIXLAB_TEST` evidence;
the dashboard highlights the actual data source, mutation behavior, and
scenario beside the job roadmap.

New CLI and dashboard onboarding profiles set `testSynthesis.devReadOnly: true`
and `ppeReadOnly: true`. For an explicitly selected `dev`/`development` or `ppe`
portal run with the default
synthetic/intercepted baseline, the shared resolver selects
`non-production-read-only` and retains mutation interception. Other environments,
API-only/unit-only and production contracts are unchanged. Existing profiles
are never opted in implicitly. The resolved DEV/PPE policy is job-bound and
persisted across queue/recovery; activating or revoking it requires a fresh job.
Repository browser/auth adapters must permit the reviewed reads rather than
disable guards; verified query contracts and legitimate SSO still apply.

Synthesized Playwright source files are transient validation artifacts by
default. FixLab removes them, along with validation-only configuration edits,
before reviewing or creating the product pull request. A generated
authenticated test is persisted only when the user explicitly requests
permanent browser-test coverage or repository instructions require that exact
test. Existing unrelated browser journeys are not changed to make a broad
suite pass.

For an explicitly selected non-production environment whose profile uses
`non-production-read-only`, the selected backend is the primary data source.
FixLab may fall back to `synthetic-intercepted` only when the backend cannot be
reached or cannot provide safe records required to exercise the reported
behavior. Expected empty-state checks remain real-backend checks. A fallback is
reported through activity and test-evidence markers and proves only the focused
UI behavior, not the selected backend or its data.

Jobs can also request local Playwright video evidence. The agent records only
the focused application journey using repository-supported Playwright video
capture, retains the required screenshot, and stores WebM or MP4 output under
the same repository-owned evidence roots. The dashboard serves recordings only
from those allowlisted roots, limits each video to 50 MiB, and never persists
video contents or paths in dashboard history. Recordings must exclude
credentials, browser profiles, personal windows, and unrelated data.

The repository-onboarding panel detects Azure DevOps organization and project
values from an Azure DevOps Git origin and can persist them to the
repository-owned profile. This keeps numeric work-item intake functional after
profile upgrades without exposing credentials or Azure CLI tokens.

### Intake sources

Manual text is the default and permanently available intake path. Azure DevOps
intake accepts a full `dev.azure.com` work-item URL, or an ID when
`azureDevOps.organization` and `azureDevOps.project` are configured in the
repository profile. Up to 20 unique IDs or URLs can be loaded as one batch.
The local server asks Azure CLI for one Azure DevOps resource token using the
developer's authenticated identity, loads the items concurrently, uses the
token only in outbound HTTPS authorization headers, and does not expose it to
the browser, job state, logs, prompts, or cache.

The loader keeps ID, title, description, reproduction or acceptance text,
state, type, web URL, and the newest 20 non-deleted comments after converting
HTML to text. A comment-request failure becomes a bounded explicit warning
without hiding the accessible work item. The loader discovers supported
attached files and authenticated embedded-image URLs, downloads at most five
PNG, JPEG, or WebP images within the shared 2 MiB per-image and 8 MiB total
limits, and skips non-image attachments. Azure-loaded, user-selected, or
clipboard-pasted screenshots are validated by count, declared type, extension,
base64 encoding, signature, per-file size, and total size. Generated local
files live under the Git directory or a repository-specific OS temporary
directory. Only their local paths are placed in the job prompt.

Artifacts belong to active, queued, or held dashboard jobs. Holding a job keeps
its artifacts available while the dashboard remains running. Replacing a
completed active job removes its files, clean shutdown removes registered job
files, and startup prunes directories older than seven days. Abrupt process
termination can retain artifacts until the next pruning pass.

Each job receives a UUID-backed session from the selected runtime. When the
agent reports a
blocked stage, the local dashboard accepts the required user input and resumes
that same session. Failed jobs can retry, and completed jobs can accept a
focused addition while reusing prior evidence, the branch, and an existing
pull request. Running jobs are not interrupted by dashboard input. The
dashboard records the time of the latest executor output and stops only its
owned executor when no output arrives for the profile-defined
`validation.agentIdleTimeoutMinutes` period (20 minutes by default). The job
then fails explicitly and remains resumable instead of appearing to run
forever. Runtime completion normally waits for output streams to close, but
also settles shortly after the runtime process exits because a retained local
application may inherit an output pipe for a manual-test hold. On startup, a
persisted `running` job with complete terminal markers and a blocked manual
gate is restored as blocked and resumable. Other persisted `running` jobs
cannot still own their original process, so the dashboard converts them to an
interrupted, resumable failure.
New requests submitted while a job is running, blocked, or failed enter the
bounded queue. A passed active job starts the next queued job. Blocked and
failed jobs pause queue advancement so the same session remains resumable. A
user may explicitly dismiss a failed job without resuming it; FixLab preserves
the failed outcome in dashboard history, performs no repository mutation for
that job, and starts the next queued job.
Waiting jobs can be removed by queue position or job ID before execution. The
dashboard records the job as cancelled, deletes only its FixLab-owned
screenshot artifacts, renumbers the remaining queue, and never interrupts the
active executor.
An active job can instead be held. The dashboard marks it `holding`, stops only
the executor owned by that job, flushes bounded partial output, persists it as
`held`, and immediately advances the waiting queue. Blocked, failed, and
waiting jobs can be held without launching an executor. Resuming a previously
started held job reuses its UUID runtime session and retained workflow stage;
resuming a held waiting job returns it to normal first-launch queue semantics.
A terminal passed, failed, blocked, or cancelled job can be restarted as a new
job with a new ID and runtime session while the original outcome remains in
history.

Age-based cleanup accepts a whole number of days and removes only terminal
passed, failed, blocked, or cancelled summaries older than that cutoff. It can
remove a terminal current summary as well as retained history, but never
deletes an active, waiting, or held job. FixLab removes only the purged jobs'
owned artifact directories and does not mutate repository source.
During execution, the agent can emit bounded `FIXLAB_ACTIVITY` evidence and
decision summaries. The dashboard shows these summaries in a separate Agent
analysis panel so users can follow what was checked, what the evidence means,
and what happens next without exposing hidden model reasoning, credentials, or
raw private context. When executor output is quiet during a long-running build,
test, or browser step, the dashboard adds periodic heartbeat comments to this
panel so expected command latency is distinguishable from a stalled session.
Heartbeats do not count as executor output and do not reset the profile-defined
idle watchdog. Activity is retained only in the active in-memory job and is
excluded from persisted dashboard history.
The dashboard job list includes active, queued, held, and recently completed
jobs. Selecting a job changes the displayed roadmap and evidence and enables
only lifecycle actions valid for its current state; selection alone never
changes execution. The local server retains up to 20 job summaries in
`.git/fixlab/dashboard-jobs.json` for this view. The private file contains
request summaries, bug identities and outcomes, stage summaries, held state,
and pull-request readiness, but no raw logs, screenshots, credentials,
authentication state, or source content.

The dashboard uses a chat-first workspace with an explicitly local repository
sidebar and inline human-response panels. Run details, memory, connections and
settings are hidden until opened from navigation, rather than occupying a
permanent inspector column. Back to chat collapses those tools and restores
focus to the preserved draft. Mobile navigation uses an explicitly expanded
Menu control. New run options and secondary help remain collapsed until
requested; critical request payloads, errors and approval actions stay visible.
Repository
memory is a read-only view of retained job summaries and reported stage
outcomes; selecting a memory never resumes work or grants permission.
The repository catalog reads bounded local dashboard registrations and verifies
their loopback owner identity before linking to another workspace. It does not
scan repositories, list GitHub access, launch dashboards, or make model calls.
The chat presents existing activity summaries, not generated explanations or
hidden reasoning, so rendering and refreshing it adds no model token usage.
**Current job full screen** moves the existing details/evidence inspector into
an accessible viewport-sized dialog. It follows the current job even when a
history entry was selected, and restores that selection and focus on exit or
Escape. Its header limits the request to two visible lines, retaining the full
text for assistive technology and on hover while keeping the exit button visible.
Opening and closing the inspector never starts, resumes or approves work.
Stale artifact responses cannot replace another selected job's evidence.

Shared-worktree blockers expose **Review workspace** in the chat. A separate
confirmed **Stash files and start fresh** action preserves reviewed untracked
source files in a retained Git stash, fetches the configured remote/base branch,
and creates a new job branch in the same folder. The original job and branch
are retained; no reset, clean, force-switch or automatic stash restore occurs.
Review is bound to the dashboard, job and workspace fingerprint. Tracked changes,
sensitive or linked files, active execution, pending permissions, queued jobs,
and owned React/authentication sessions block automatic recovery. Fresh jobs
do not inherit file trust or external-folder grants.

Local repository setup uses an explicit same-origin, instance-bound API and a
deterministic chat, not an onboarding model session. A bounded, expiring plan
captures the canonical Git working tree, profile fingerprint, supported field
values and non-overwriting scaffold list. Application paths stay inside that
tree; credentials and authentication-state contents are not exposed. Applying
acquires the repository executor lease, rechecks the fingerprint and uses an
exclusive temporary profile file followed by atomic rename. Existing resource
owners must be idle; the editor does not stop them. Opening an onboarded workspace
registers a separate loopback owner in the same host without launching a job.
Host shutdown fences new workspace creation and closes only its tracked children.
The Queue sidebar action opens the jobs list at the top of Run details, with
the waiting count visible without opening the inspector. Navigation never
starts, resumes, or grants access to a job.

Before starting or resuming an automated browser-only executor, the dashboard
checks directory-valued authentication `statusPaths` for a matching same-user
browser process. It reads filesystem/process metadata, not authentication-file
or browser-profile contents. A busy declared profile blocks before acquiring
the execution lease or starting the model. Repeating a retry while that owner
remains returns a conflict without recording another input or starting AI.
The authentication connection endpoint applies the same ownership check.
FixLab never terminates or attaches to an existing browser to release a lock;
the user must first preserve unsaved form data and close the previous test
browser. Ownership inspection errors also block and are shown explicitly.
State-file-only configuration cannot identify a persistent profile, and a
profile acquired after preflight can still require a human-owned recovery;
this is a prerequisite check, not a universal browser lock manager.

## Context and token efficiency

Each job reads the repository profile and existing instructions first, then
uses git status, the effective diff, and task-relevant symbol/file searches to
bound investigation. Work continues in one selected-runtime job/session context.
Unchanged files, completed diagnosis, available dependencies, and broad checks
are not repeated without new risk evidence. Tests and validation are focused
and risk-scaled.

Native Copilot sessions explicitly defer MCP/external tool definitions behind
tool search and move tool output above 8 KiB to runtime-managed evidence files.
This preserves tool availability, repository configuration discovery and managed
policy; it does not replace the runtime's safety prompt or grant permissions.
Playwright-only jobs use a smaller browser-specific contract instead of the
implementation/PR lifecycle. They reuse a parameterized same-job script and
retain it through retries rather than rediscovering selectors for every row.
Browser-only continuation and dashboard retry/skip input keep the original
environment, request, decisions and browser evidence; they do not introduce
implementation or PR lifecycle work. A first launch blocked by browser
preflight has no model session to resume, including after a dashboard restart.

All native Copilot sessions start background compaction at 25% of the model context
allowance and block for compaction at 40%. On resume, the host re-tokenizes
retained conversation using the selected model; above 24,000 conversation
tokens it asks the official runtime to compact history before sending the next
job prompt. The summary must preserve explicit decisions, pending/denied
permissions, form state, safety constraints, script paths and exact evidence.
It also preserves checkout ownership, changed files, completed test commands,
baseline failures, deferred gates, budget and remaining work.
Compaction failure blocks continuation rather than clearing history, inventing
approvals or silently resending oversized context. Numeric compaction outcomes
are visible in activity; raw summaries are not sent to the dashboard.
Cumulative usage is not reset by compaction or dashboard restarts and is not a
dollar-cost estimate. Only numeric counters are retained in job summaries;
older summaries recover counters from the same job's local metrics record
when available.
Native counters arrive in dedicated, validated monotonic protocol frames;
rendered token-summary text cannot overwrite them or reset a resumed budget.
Agency retains its legacy rendered-usage parser.

Native jobs accept an optional `inputTokenLimit` (safe non-negative integer,
default `0`, unlimited). Cumulative SDK usage, including cached input and
compaction, pauses the owned executor when a reported total reaches the ceiling.
The current call may exceed it; this is a soft usage limit, not a billing cap.
Exhausted resumes cannot open another runtime, and queued comments cannot
automatically continue an exhausted job. A stopped-job budget change requires
exact browser origin, current instance/job identity and explicit confirmation;
it preserves usage and neither resumes work nor grants permissions. Agency
rejects positive ceilings rather than pretending to enforce SDK usage.

For fix-and-validate jobs with pull-request publication already authorized,
FixLab follows the selected publication policy. Efficient mode defaults to a
draft PR after the scoped change, focused regression checks, effective-diff
review, and explicitly required pre-publication gates. Transient validation
artifacts are removed before pushing the reviewed checkpoint. A successful
authorized draft publication requires verifying the provider's `isDraft` state
is true; it does not authorize clearing draft status. Marking a draft ready
requires a separate reviewed decision. Explicit ready intent or the legacy
strict-ready policy requires normal review, required fresh validation and
approval gates, and verification that `isDraft` is false before the PR stage
passes. Strict-required gates, freshness checks, provider protections, and
managed approvals remain unchanged.

Later reviewed checkpoints and validation results update the same branch and
PR. Optional broad unit tests and builds are not automatically requested when
disabled; enabled independent checks can continue after publication without
blocking efficient delivery. Every pending, failed, stale, skipped, or not-run
check remains explicit rather than being reported as passed. Publication does
not wait for remote CI or build completion: some providers trigger PR builds
only after publication. Remote checks remain pending until their results are
known, and normal review, build, and merge policies remain enforced. Failed
publication or selected-state verification blocks or fails the PR stage.

Stage summaries remain structured independently of raw output. The dashboard
retains a bounded local log window and reports how many older entries were
omitted; it does not feed unbounded logs back into prompts.
Polled job responses expose only Azure DevOps identity and state summaries,
not the full loaded descriptions and reproduction text.

Dashboard jobs stream the generated agent prompt through standard input rather
than placing it on the process command line. Request-bearing `fixlab run`
commands use the same stdin transport. Request-free CLI runs instead inherit
terminal stdin so Agency or direct Copilot remains interactive; an
environment-only selection is passed as interactive guidance rather than
starting an autonomous session. This keeps long requests below operating-system
command-line limits without breaking terminal interaction.

The dashboard Agency adapter invokes `agency copilot` with the plugin-qualified
`fixlab:fixlab` agent. The direct dashboard adapter uses an owned SDK host,
with the packaged agent selected as `fixlab:fixlab`, explicit UUID session or
resume identity, streaming output, and structured runtime permission/question
handling. It does not silently convert workflow responses into runtime approvals.
Runtime selection changes only execution transport; queueing, marker parsing,
metrics, evidence, validation gates, and pull-request rules remain shared.

Repository profiles may define a Playwright authentication command, non-secret
environment values, and local status paths. The loopback dashboard can start
that command and reports only configured/running/ready state; it never reads or
returns authentication-state contents. The dashboard tracks the owned
authentication process and terminates that handle during clean shutdown.

The loopback dashboard exposes a bounded, selected-job Playwright evidence
gallery. It scans
only repository-owned `test-results`, `playwright-report`, and `artifacts`
directories below the configured browser working directory, ignores symbolic
links and unsupported files, and serves at most 20 images or videos created
after the selected job started. Images use the normal screenshot size limit;
WebM and MP4 videos are limited to 50 MiB each.
Authentication-state paths are outside these allowlisted roots and are never
displayed.

Comments submitted while an agent turn is running are retained only in the
current in-memory job and delivered by resuming the same runtime session after
that turn completes. This preserves the bug batch, branch, evidence, and
existing pull request without interrupting an in-flight tool operation or
creating a second job.

Git repositories also receive a bounded durable metadata cache in
`.git/fixlab/dashboard-cache.json`, using the shared Git directory for
worktrees. Its key combines a hashed repository identity, current `HEAD`,
source/worktree fingerprint, repository-profile hash, and instruction-content
hash. A matching job prompt may reuse the profile shape, prior result, fixed
stage/status summaries, and concise validation gate statuses. Agent-written
messages are not copied into this memory. It never
stores request text, raw logs, credentials, screenshots, screenshot paths,
or source contents.
The file is capped at 20 entries, 64 KiB, and seven days. Memory is advisory;
it cannot pass a validation gate. Recurring lessons still require review in
the existing learned-rules workflow before becoming repository instructions.

The shared Git directory also holds
`.git/fixlab/dashboard-metrics.json`, bounded to 500 job records. Records
contain identifiers, queue/start/finish timestamps, terminal status, bug count,
execution and queue-wait durations, and parsed Copilot token totals. They never
contain request text, comments, screenshots, credentials, raw logs, or source
content. The local API aggregates 24-hour, 7-day, 30-day, or all-retained
periods. Cache reuse is `cached input / total input`; without a defined
comparable baseline it is not represented as exact token reduction or cost
savings.

Changing `HEAD`, worktree inputs, profile content, or discovered repository
instructions causes an automatic cache miss. Current instructions are reread.
Non-Git repositories skip durable reuse. This cache is deliberately not a
repository scan or source-index cache: current diffs and task-relevant files
remain authoritative.

### Broker

This is a future team-service concept, not a component shipped by the local
package.

Stores jobs durably, authenticates callers, assigns work to runners, streams
status, and preserves audit records. A team deployment should host this behind
organizational identity and authorization controls.

### Runner

The current package executes on the local developer or runner machine, with
owned workspaces, ports, logs, and child processes. It must never terminate
unrelated developer processes. A registered managed-runner fleet would be
part of the future team-service design, not an installed local service.

### Repository profile

Defines:

- Component paths and ownership boundaries
- Restore, lint, test, build, and startup commands
- Frontend and backend ports
- Supported validation environments
- Browser test journeys
- Allowed pull request target branches
- Timeout and blocker behavior

### Evidence store

Preserves structured test results, API assertions, screenshots, decisions,
skipped gates, remaining risks, and pull request links.

`fixlab exec` is the command-output boundary between validation tools and the
agent context. It captures stdout and stderr separately, redacts credential
patterns before persistence, and returns only bounded unique diagnostics,
framework-aware test counts, tail failures, timing, and context-reduction
metadata. Node test/TAP, Playwright, Jest, and .NET test summaries retain
passed, failed, skipped, cancelled, and total counts without returning every
successful test line. Full redacted evidence and `result.json` are stored under
the worktree's Git-private
`fixlab/command-evidence` path, never in tracked source.

Each compact summary reports raw and retained line counts, byte counts,
estimated tokens, omitted lines, and the reduction percentage. The same
measurements are persisted in `result.json.context` so reductions can be
compared across commands and repositories without retaining raw output in the
agent prompt. Token counts use the transparent `bytes / 4` estimate and are
directional rather than model-billing measurements.

Successful deterministic local validations may be reused only by explicit
request. Their fingerprint includes platform, command and arguments, stage,
working directory, Git `HEAD`, content hashes for every tracked and untracked
file, worktree status, and repository-profile content. A changed input causes execution;
failed results are never cached. Evidence and cache records are capped at 100
entries and seven days, and each output stream is capped at 50 MiB.
Individual lines exceeding 64 Ki characters are omitted with an explicit
capture notice so an unbroken output stream cannot grow collector memory
without bound. Retained diagnostic and failure-tail lines are limited to
2000 characters; the private evidence retains other lines up to capture limits.

### Dashboard-owned validation gates

Profiles may declare `validation.gates`: between one and 20 required entries
with a unique lowercase `id`, executable `command`, string `args`,
repository-relative `workingDirectory`, and `timeoutSeconds` (1-7200).
Choose the smallest commands that cover the repository contract; gates are
not inferred from restore, startup, authentication, or deployment commands.
The template contains examples and must be adapted during onboarding.

Each gate may declare boolean `requiresLiveIntegration`; it defaults to true
for `stage: "live-test"` and false otherwise. Other genuinely live-dependent
startup/health gates require an explicit true value; local build/test gates
must not be reclassified to hide failures. An explicit false preserves a
live-stage offline gate as local. `draftReady` requires verified applicable
local gates to pass independently of pending/failed integration gates.
Full validation status, gate requirements, exit codes and stale evidence are
unchanged. This readiness is accepted only for authorized editing draft jobs,
never as evidence for ready publication, full validation or merge.

An optional `validation.apiOnly` policy supplies a reviewed base reference,
literal internal-API paths, mandatory full-validation paths, and a subset of
configured gate IDs. It applies only to `validationIntent: "affected"`; profiles
without the policy preserve the existing default, and explicit `"full"` never
excludes a gate. A policy-enabled new job defaults to affected validation.
The dashboard captures the shared checkout's assigned base or the merge base
with the configured reference after checkout admission, then persists that
commit across recovery. Recovery is tracked independently of runtime-session
reuse, so a fresh-runtime retry cannot recapture an unavailable baseline.
Missing saved baselines and Git inspection failures
fall back visibly to all configured gates, never to fewer checks.

The classifier unions committed, staged, unstaged and untracked paths, disables
rename collapsing, and requires every changed path to be in the API allowlist
and outside the declared contract/consumer-impact paths. Unknown, empty or
cross-component changes require all gates. This is reviewed path-based policy,
not semantic proof: uncertain API compatibility requires explicit full coverage.
Applicability is recomputed before execution and at completion; status polling
reuses that checkpoint instead of repeatedly spawning Git. Previously run
gates remain required even if a later edit narrows the path set, retaining their
failure evidence. Excluded gates have `status: "not-applicable"` and a reason,
not a synthetic command result or a passed status. API-scope completion and
full validation remain distinct in dashboard and MCP projections.
Private snapshots retain a bounded executed-gate history with IDs, statuses,
and exit codes, not logs or command contents. Recovery preserves failures and
cancellations, makes saved passes or interrupted executions stale, and keeps
all previously executed gates required. Missing legacy history retains full
coverage for that job; malformed or incompatible history blocks recovery.

Dashboard jobs receive `fixlab gate --port <port> --job <id> --gate <id>
--repository <worktree>` instructions. The loopback endpoint resolves the
executable from the job's reviewed profile, not from request-supplied commands.
It accepts only the current running job, rejects browser-origin requests,
restricts the target to the assigned dashboard checkout, and runs one bounded
gate at a time through the structured executor. This applies in shared and
isolated modes; sharing a Git common directory does not establish assignment.
For isolation, onboard the worktree and start its dashboard before creating a
gated job. Gated jobs cannot switch checkouts through a validation request.
Requests are rejected after owned executor stop or dashboard shutdown begins,
including requests whose bodies were still arriving when shutdown began.
Only executor results can pass these gates; agent stage markers cannot.

Unchanged successful job-local evidence is reused when a gate is requested
again only if the profile explicitly sets `reuse: true` and its command is
eligible deterministic local validation. Reuse defaults to off. Playwright,
live checks, startup, authentication, installation, deployments, and mutations
must not opt in; unsupported command families never reuse. Failed results are
not reused. Source changes during a check make its
result stale. Final job completion fingerprints inputs again and blocks
readiness for missing, failed, cancelled, timed-out, or stale evidence.
Holding and held jobs remain blocked until resumed completion verifies inputs.
Deleted and renamed tracked files are included in source fingerprints.
While a dashboard-owned gate runs, its own timeout replaces agent-output idle
detection; the agent idle watchdog is rearmed after gate success or failure.
Profile changes require a new job. Cancellation and dashboard shutdown stop
the owned validation command. Evidence from a previous dashboard process is
not trusted as a fresh pass after restart.

Legacy profiles without gates can still launch, but dashboard PR readiness
is explicitly blocked as unconfigured. Playwright-only jobs retain their
existing browser-evidence contract and do not acquire non-browser gates.
Gate status is available in the job API; compact command evidence is shown in
dashboard logs. Full evidence remains Git-private. This is validation
enforcement inside FixLab, not interception of every agent shell command or
an authorization boundary against a process running as the same local user.
It does not independently prevent an agent from publishing a PR through an
unmediated external tool. Freshness is verified at job completion; later
external edits require a resumed job and revalidation.

## Workflow stages

1. Intake
2. Diagnosis
3. Reproduction
4. Fix or validation
5. Review
6. Local application startup
7. Live testing
8. Pull request outcome

Every required stage must pass or be explicitly marked skipped with a visible
risk. A skipped gate must never be reported as passed.

## Repository engineering loop

FixLab itself uses the same deterministic loop expected from onboarded
repositories:

1. Repository and module agent instructions define scope and safety invariants.
2. A lock-file-backed development environment installs reproducibly.
3. `npm run validate` runs syntax linting, formatting policy, documentation
   drift checks, focused tests, and package-content validation.
4. Pull-request CI publishes JUnit and documentation-drift evidence.
5. CODEOWNERS and the pull-request template keep a human reviewer on the loop.
6. Scheduled maintenance deletes only GitHub Actions artifacts older than the
   configured retention window, caps deletions per run, and retains a
   machine-readable report.
7. A failed CI run triggers evidence-preserving containment. The follow-up
   workflow never checks out or executes untrusted pull-request code; it
   records the failure and notifies the affected pull request or issue queue.
8. If a trusted push to `main` fails, the rollback workflow proposes a revert
   pull request. The rollback never auto-merges and must pass the normal status
   checks and approving-review policy.
9. The self-healing drill independently exercises the flaky-containment and
   rollback algorithms without forcing a production CI failure.

The documentation drift gate resolves local Markdown links and verifies that
the contributor completion command remains documented. This is intentionally
deterministic; semantic review can add advice but cannot replace the blocking
repository-wide check.

## Blocker handling

FixLab should support both:

- **Strict:** required builds and tests must complete.
- **Continue on owned-process timeout:** after a configured timeout, terminate
  only the verified FixLab-owned process, record the gate as unverified, and
  continue to independent live validation when safe.

Authentication, authorization, data-safety, and unrelated-process conflicts
must continue to block automatically.
