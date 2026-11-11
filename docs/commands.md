# FixLab commands

New editing jobs use efficient delivery automatically: focused regression
checks and reviewed diff, then an authorized draft PR. Broader local unit tests
and optional builds are not automatically requested. Repository Settings saves
`workflow.mode` (`efficient` or `strict`), `workflow.publication` (`draft` by
default in efficient mode, `ready` by default in strict mode),
`workflow.unitTestsAfterPr` (default `false`) and `workflow.optionalBuilds`
(default `false`) once. Marking a draft ready requires a separate reviewed
decision. No per-stage workflow selection is needed.
Required local `validation.gates` remain publication-blocking in efficient
mode. For editing jobs with saved `publication: "draft"` (efficient or strict),
unavailable live integration does not block authorized frontend/backend code work
or the reviewed draft after required local checks pass. Record unavailable
startup, API authentication and browser checks as deferred, never passed; keep
actual gate outcomes and disclose unverified integration in the draft.
Ready/merge, explicit manual/all-UI and production-backed approval gates remain
unchanged. Optional gates remain runnable and keep their actual status; neither
publication nor `advisory` implies validation passed. Existing saved jobs retain
strict behavior unless explicitly migrated while stopped.

The browser reproduction/result-check mode (`playwright-only`) is the light
path for explicit reproduction-only and deployed browser-result requests. It
first reuses an approved existing application/validation session when supported,
skips irrelevant local-stack setup, and does not run broad unit/build gates or
create a PR. Missing browser runner/authentication prerequisites still block.
Local-fix and PR claims still require the matching checkout and application.

## Interactive repository shell

```text
fixlab <repository> [--runtime <agency|copilot>]
```

Opens an interactive FixLab agent in the selected repository, retaining context
for onboarding, diagnosis, scoped changes, validation, and authorized PR work.

Use `fixlab run <repository> -- <request>` when the complete request is already
known and should execute without first entering the interactive conversation.

## Repository onboarding

```text
fixlab onboard [repository] [--yes] [--authenticate] [--start-dashboard] [--runtime <agency|copilot>]
```

The first run creates the repository profile and stops before using generic
placeholder paths. After the profile is configured, a plan-only run prints the
repository-owned restore and Playwright commands. `--yes` approves those
commands, `--authenticate` runs the repository-owned interactive browser login,
and `--start-dashboard` starts the dashboard only after Doctor passes.

`fixlab init` installs these prompt files under `.github/prompts` without
overwriting repository-owned versions.

| Command | Purpose | Completion gate |
|---|---|---|
| `/fixlab.bugfix` | Run the full VS Code reproduce, repair, and verification loop for one bug | The root cause is fixed and every affected gate has explicit evidence |
| `/fixlab.intake` | Capture the defect, expected behavior, scope, and safe data | The request is measurable and missing inputs are explicit |
| `/fixlab.diagnose` | Trace the affected code and establish the root cause | The cause is supported by repository evidence |
| `/fixlab.reproduce` | Create or run the smallest failing check | The original symptom is reproduced or a blocker is recorded |
| `/fixlab.fix` | Implement the smallest complete correction | Only required production and test files are changed |
| `/fixlab.validate` | Run focused tests, lint, type-check, and builds | Every required check passes or is explicitly skipped with risk |
| `/fixlab.live-test` | Start owned applications and run the browser journey | The running application proves the expected behavior |
| `/fixlab.pr` | Prepare the evidence-backed pull-request outcome | The PR contains the exact change, evidence, and remaining risks |
| `/fixlab.summary` | Optionally summarize an existing job in the conversation | Actual outcomes, regression gaps, findings, workarounds and must-know items are explicit; no execution or file changes |

The commands read `.github/fixlab/repository-profile.json` and repository
instructions before acting. They never replace repository-owned commands,
environment controls, or approval requirements.

For an optional engineering handoff, run `/fixlab.summary` in the VS Code
conversation containing the job evidence. It is never added to the automatic
bug-fix lifecycle. The prompt returns Markdown without rerunning checks,
changing job status, creating files or publishing changes. Active-job summaries
are interim; unavailable results are marked "Not verified". It distinguishes
runner-confirmed results from agent claims, local from deployed validation, and
known findings from suspected side effects. A folder or ZIP is a separate request.

Existing repositories can rerun `fixlab init` after updating FixLab to add the
missing prompt without replacing their profile, agents or customized prompts.
Other conversation hosts can paste the packaged
[`fixlab.summary.prompt.md`](../prompts/fixlab.summary.prompt.md) into the
same evidence-bearing conversation; this is a prompt file, not a new CLI
subcommand or a dashboard export button.

In the dashboard, select a current or saved job and click **View summary** in
the header. This separate read-only view assembles recorded investigation,
changes, gate results, scenario claims, findings and remaining gaps without an
AI call or job mutation. It refreshes that same job's evidence while open.
Detailed engineering records show the original bug, expected/actual behavior,
root cause, actual code correction, changed files, commit, regression details
and risks. They survive retries and restart instead of being replaced by a
"retained fix" stage message. Older jobs without a record explicitly identify
the missing explanation; reviewed notes can be imported by a confirmed local
client bound to that stopped job. Neither agent explanations nor reviewed notes
are new runner proof. Missing facts stay unverified; the view does not infer
them from a passed status or parse raw logs. For an AI-written
handoff with richer context, use the optional prompt in its original conversation.

## Executor-backed dashboard checks

`fixlab gate --port <port> --job <id> --gate <id> --repository <worktree>`
runs a required `validation.gates` entry through the dashboard-owned compact
executor. The dashboard supplies this command with the correct job and port.
It returns a nonzero exit code for failed, cancelled, timed-out, or stale
validation. It does not accept arbitrary commands or an arbitrary repository.
The repository must be the checkout selected when starting that dashboard.
For an isolated checkout, onboard it and start its dashboard before the job;
an agent-created sibling cannot substitute evidence for the assigned source.

Configure each gate in the repository profile:

```json
{
  "validation": {
    "gates": [
      {
        "id": "frontend-typecheck",
        "command": "npm",
        "args": ["run", "type-check"],
        "workingDirectory": "frontend",
        "timeoutSeconds": 300
      }
    ]
  }
}
```

Use focused, repository-owned commands and finite timeouts. By default every configured
gate is required; agent markers and ordinary `fixlab exec` runs cannot replace
its evidence. A profile may explicitly set `reuse: true` on eligible
deterministic local gates; reuse is off by default and must never be enabled
for live/browser checks or mutations. Source edits require revalidation.
Legacy profiles without gates
remain runnable but cannot establish executor-backed PR readiness. These
checks do not intercept all agent tools or enforce external PR permissions.

`stage: "live-test"` classifies a gate as integration-dependent by default.
Set the optional boolean `requiresLiveIntegration: true` for other commands
that genuinely require live services, such as backend health/Key Vault checks.
Use `requiresLiveIntegration: false` to retain a live-stage offline check as
draft-blocking. Local builds, type-checks and unit tests remain local gates;
do not relabel them to bypass failures. This classification affects only
eligible draft publication: all applicable gates keep their outcomes and
remain required for full validation. Missing or stale local evidence blocks
the draft, and profile/source changes require fresh verification.

### API-only validation

To avoid running unrelated frontend checks for internal API changes, add an
opt-in policy alongside the existing `validation.gates`:

```json
{
  "apiOnly": {
    "baseRef": "origin/main",
    "paths": ["backend/src", "backend/tests"],
    "fullValidationPaths": ["backend/src/Contracts", "backend/src/Controllers"],
    "gateIds": ["backend-build", "backend-tests"]
  }
}
```

This object belongs at `validation.apiOnly`. Adapt every path, the target
reference, and gate ID to the repository. All listed gates must already exist.
Paths are literal repository-relative files or directory prefixes, not globs;
include every API contract or consumer-impacting surface in
`fullValidationPaths`. A path policy cannot prove semantic compatibility.
Request full validation whenever public behavior or frontend impact is uncertain.
Keep the policy absent until it has been reviewed; the template does not
automatically enable exclusions.

New jobs use `validationIntent: "affected"` by default only when this policy
exists. The dashboard's **Validation coverage** selector can explicitly choose
change-aware checks or **All configured checks**. API/MCP callers can select
`"affected"`, `"full"`, or `"scoped"` at job creation or on an authorized resume.
`"full"` always requires all configured gates; `"scoped"` still defers readiness.
Explicit all-UI or manual localhost requests also retain full coverage.

Change-aware validation compares committed changes, index changes, worktree
changes, deletions, both sides of renames, and new non-ignored files against a
pinned Git baseline. Shared checkout jobs use their assigned base commit;
other jobs pin the merge base with `baseRef`. Saved jobs retain that baseline.
Empty, unclassifiable, contract, shared, frontend, or unreadable change sets
require all configured gates. Older saved jobs without a verified baseline
cannot acquire API-only scope on resume.
This also applies when recovery starts a fresh runtime instead of reusing its
old session. Executed-gate history survives dashboard restarts: failed and
cancelled gates stay required, while saved passes become stale and must run
again. Missing legacy history retains full coverage; invalid history requires
a new reviewed job.

For a verified API-only change, `gate` reports excluded entries as
**NOT APPLICABLE**, without executing their commands or creating pass evidence.
The dashboard and conversation status show their reasons and label completion
**API-scope validation passed**, not full validation. Previously executed failures
are never rewritten as exclusions. Later edits can expand required coverage,
and final source verification still invalidates stale results.

Changing a policy requires a new reviewed job. Installing this feature does
not waive failures, change profiles, or upgrade a running dashboard in place.

## Reviewed component validation and permission preflight

### Component validation

For changes beyond the API-only case, a repository can instead configure
`validation.changeAware`. Do not combine it with `validation.apiOnly`.

```json
{
  "changeAware": {
    "baseRef": "origin/main",
    "fullValidationPaths": ["shared", "backend/Contracts", "package.json"],
    "scopes": [
      {
        "paths": ["backend/src", "backend/tests"],
        "gateIds": ["backend-build", "backend-tests"]
      },
      {
        "paths": ["web/src", "web/e2e"],
        "gateIds": ["web-types", "web-tests", "web-build", "web-browser"]
      }
    ]
  }
}
```

Every gate ID must already exist in `validation.gates`. A path can match more
than one scope: the union of all matching gate sets is required. Include shared
mandatory checks in each applicable gate set. Policies support 1-100 scopes,
each with 1-100 literal path prefixes, and require full-validation paths.
This policy uses the same pinned baseline, complete Git change discovery,
recovery safeguards, evidence invalidation and explicit full/scoped behavior
as API-only validation. Unknown paths, an empty change set or any matching
full-validation path require all gates. Previously executed gates remain
required, including failures. Exclusions mean **not applicable**, never passed.

The dashboard defaults a new policy-enabled job to affected validation.
Component-scope completion is labelled separately from full validation; it is
not permission to omit repository-mandated browser, build, or other checks.
Do not enable the policy in a consuming repository until its mapping has been
reviewed.

### Pre-launch permission handoff

The dashboard job form does not enable an optional pre-launch folder review.
Normal runtime permission requests still require review when they occur.
For a known external-folder prerequisite, an API/control client can explicitly
pass `permissionPreflight: true` to the existing job-start API/control.
That job pauses before any executor launch, workspace acquisition, or frontend
warmup. Review an exact required folder, then separately confirm its resolved
scope through the existing job/request-bound approval flow. Review is not
approval. The first launch is fresh, not a resume of a nonexistent session.
The normal folder restrictions, nonce/origin checks and job-local grant expiry
still apply; restarts do not inherit authorization.

Dashboard recovery remembers that preflight completed so an existing runtime
session resumes with the new user instruction rather than restarting its
initial request. Folder grants are still cleared. Restarting as a new job ID
resets preflight and requires fresh approval. If the first approved launch is
blocked by workspace admission, the job keeps its already approved folder and
exposes a separate workspace review. Explicit workspace approval preserves
the reviewed work and starts the first runtime session fresh.
To avoid resuming that job, use **Review workspace**, inspect the proposed
base and untracked-file list, then confirm **Stash files and start fresh**.
FixLab keeps the same folder, saves eligible files in a retained stash, refreshes
the configured base (for example, `origin/develop`), and creates a new job branch.
The old job and branch remain preserved. Restore the reported stash separately;
it is never automatically applied to the clean new branch.
This separately confirmed Git recovery can prepare the branch before a new
job's external-folder preflight. It grants no folder or tool access; the fresh
executor still waits for any required approval.
If the approved folder changes before that first launch, FixLab clears the
invalid grant and requires a replacement review and approval while preserving
the fresh initial prompt and non-resume launch.

This is opt-in and does not preapprove a tool, URL, authentication step, or
organization-policy restriction. It cannot eliminate all noninteractive
permission denials. Status reports grants already present so an unclassified
denial does not trigger repeated grants or speculative widening.

## Visual Studio Code bugfix agent

`fixlab init` also installs `.github/agents/fixlab-autofix.agent.md`. Open the
onboarded repository in Visual Studio Code, open Copilot Chat, select
`fixlab-autofix` from the agent picker, and provide one bug description. You
can also run `/fixlab.bugfix` to start the same focused workflow.

The agent provides a reusable bugfix workflow: it reads the target
repository's profile instead of hard-coding product components. It classifies the
smallest allowed component, reproduces the defect, traces React or .NET data
flow, makes a surgical fix, adds focused regression coverage, runs configured
validation, and reports evidence for developer review.

## MCP server

FixLab ships a repository-local stdio MCP server:

```shell
fixlab-mcp
```

The `.vscode/mcp.json` configuration starts it over standard input/output. It
exposes read-only tools to summarize FixLab profile readiness and discover
repository validation commands. These tools do not execute commands or make
network requests.

`fixlab_dashboard_status` and `fixlab_dashboard_reply` additionally connect an
existing conversation to a running loopback dashboard using an explicit
repository and port. Status returns a compact question and gate summary,
without raw logs. Reply requires the user's explicit answer and matching
instance/job IDs, and may queue a comment or resume that same job. It does not
start a replacement job or grant runtime permissions. The dashboard retains
execution, process ownership and validation authority. See
[Copilot dashboard chat setup](installation.md#chat-with-an-existing-dashboard-from-copilot).

### Copilot dashboard control

`fixlab_dashboard_control` accepts `repository`, loopback `port`, current
`instanceId`, current `jobId` (or `null` when none), `operation` and a
`parameters` object containing the normal dashboard API payload.
Mutations require `confirmed: true` representing actual user authorization.
Read status again after a conflict or timeout; do not blindly replay an
operation that may already have started.

| Operations | Parameters / behavior |
|---|---|
| `sessions`, `onboarding-status`, `frontend-status`, `authentication-status` | `{}`; reads existing configuration/session status |
| `metrics` | Optional `period`; reads aggregate metrics |
| `job-start` | `request`, `mode`, optional `targetEnvironment`, model and existing job options; creates/queues a job |
| `job-stop`, `job-dismiss` | `{}`; acts on the bound current job |
| `job-hold`, `job-resume`, `job-restart`, `queue-cancel` | `jobId` identifies the existing current/held/queued job; restart explicitly creates a new job, unlike recovery reply |
| `history-purge` | Existing dashboard purge payload and confirmation; never removes code or untracked source |
| `frontend-start`, `frontend-stop` | `{}`; uses profile settings and tracked process ownership |
| `authentication-start` | `{}`; opens configured human sign-in, never supplies credentials or completes MFA |
| `session-control` | `ownerId`, `jobId`, `action`, `resource`, and `confirmed` where required by normal session controls |
| `permission-review` | `jobId`, `requestId`, `directory`; reviews the exact existing folder request |
| `permission-approve` | Reviewed `jobId`, fresh `requestId`, exact `directory`, `confirmed: true`; never grants tools or URLs |
| `validation-run` | `jobId`, `gateId`, `repository`; runs only a configured required gate on the assigned checkout |
| `onboarding-configure` | Existing Azure DevOps organization/project settings; preserves onboarding validation |
| `work-items-load` | Existing Azure DevOps intake selection; preserves authenticated read-only loading |

Control uses an explicit route allow-list, not arbitrary URLs or shell
commands. The server checks instance/repository/job identity before dispatch
and again after reading a request body. Responses contain only bounded
operational metadata, not raw logs, credentials, screenshots or browser-state
files; full evidence remains in the dashboard. A start/stop acceptance is not
proof that a test passed. Ordinary operations have a ten-second deadline;
configured validation gates retain the bounded gate execution deadline.

For example, after status verifies the correct PR checkout, start browser-only
testing with `operation: "job-start"` and:

```json
{
  "request": "Test this PR using the configured Playwright settings; do not change code.",
  "mode": "playwright-only",
  "targetEnvironment": "dev"
}
```

Use only an environment allowed by that repository's profile. An already
running or blocked job can cause this request to queue; inspect the returned
job/queue state rather than assuming immediate execution.

## Change-only Copilot notifications

```text
fixlab notifications [repository] [--yes]
```

Plan the installation first, then use `--yes` to add a project-local Copilot
extension loader referencing this installation. Existing custom code is never
overwritten. Reload extensions and explicitly start one job-bound monitor
using `fixlab_watch_start`; installation alone starts nothing.

| Extension tool | Behavior |
| --- | --- |
| `fixlab_watch_start` | Requires repository, port, instance/job IDs and explicit `confirmed: true` consent to event-triggered model turns |
| `fixlab_watch_status` | Refreshes compact state for that same watched identity |
| `fixlab_watch_stop` | Stops notifications, not the dashboard job |

Unchanged status checks make no model calls. Only new blockers, completion or
watch termination enqueue Copilot turns, which still consume tokens. No event
approves an action or passes a validation gate. See
[installation and lifecycle limits](installation.md#change-only-copilot-notifications).

## Local dashboard command

```text
fixlab dashboard [repository] [--port <number>] [--open|--no-open] [--keep-awake-minutes <minutes>]
```

The command starts the packaged local UI on `127.0.0.1:4317` by default without
opening the browser. Open the printed URL manually, request `open dashboard`
in chat, or explicitly supply `--open`. `--no-open` remains supported.
Onboarding and reconnecting do not automatically open browser tabs.
The dashboard does not run during installation or `fixlab init`.

### Per-run request interception

The new-job form's **Request interception for this run** selector supports
**Profile default**, **Intercept mutating requests**, and **Live read-only
(no added interception)**. The API equivalent is `testMutationMode` with an
empty value, `intercepted`, or `none`. Selecting a mode does not edit the profile
or affect other jobs. The selection is retained for that job's recovery/restart.

Intercepted validation can retain real permitted backend reads, including
semantically read-only POST searches. It is not validation of persisted backend
mutations. Live read-only requires a profile permitting non-production reads,
prohibits actual mutations and automatic draft persistence, and never disables
repository-required guards. If the journey cannot safely run without writes,
it remains blocked instead of sending them. An optional profile
`browserAutomation.testSynthesis.allowedMutationModes` array can further limit
per-run choices. Synthetic-only profiles cannot silently switch to live reads.

Neither choice authorizes Save, Submit, Approve or real writes. Those require a
separate reviewed repository workflow and explicit authorization. Conflicting
reported browser evidence fails validation; it cannot silently broaden the
selected mode. Interception is implemented by repository-owned browser automation,
not a blanket network proxy installed by the dashboard.

### Verified read-only POST searches

The default browser workflow treats a verified, approved POST query as a read,
independently of **Allow POST requests**. Use genuine returned records when the
profile permits backend reads, including when actual writes are intercepted.
Verification must cover the query implementation, request shape, exact
environment/origin/path, redirects, and the repository guard's existing allowlist.
A name such as "search" is not sufficient.

For writes, the separate **Allow POST writes for this job** checkbox is off by
default. Selecting it authorizes configured DEV/SIT/UAT endpoint/test-record
writes without repeat confirmation in a native Copilot dashboard job. Unchecked
or recovered jobs still confirm each action. Approval is job-, environment- and
revision-bound; it expires on stop, hold, completion or restart. No browser guard
is disabled and no production, API-only or explicit read-only restriction is
waived. See [POST configuration and approval](security.md#individually-confirmed-non-production-post).

With reviewed `dataSafety.post.<environment>.baseUrls`, the POST checkbox offers
**all selected-environment POST requests, including writes**, using those
API bases and the existing helper, separately for DEV, SIT, UAT or PPE.
It requires no endpoint/test-record list or repeated confirmation, but authorizes
POST only. Other methods require the separate broader write approval. Old
endpoint-scoped API clients do not inherit this wider scope.

Connected `job-start` supports these explicit POST confirmations together with
`toolApprovalMode: "allow-all"` and `allowAllConfirmed: true`. It uses the current
instance/repository/job identity rather than a browser Origin. Native permission
decisions and human authentication remain separate.

A missing allowlist entry is a policy blocker, not an unavailable backend.
Offer `fixlab setup-queries REPOSITORY --environment ENV --runtime copilot`
for a separate plan-first review of the full verified query scope. After the
user reviews the proposed files and offline tests, `--yes` authorizes the scoped
policy/adapter repair, not product changes, live API calls or business writes.
See [query setup](repository-onboarding.md) for setup boundaries.
Do not disable the guard, allow all POSTs,
use another client to bypass it, or silently substitute synthetic records.
Read-only jobs cannot edit configuration; approved changes need a fresh reviewed
context/job. Save, Submit, Approve and autosave retain their write controls.
Synthetic-only, API-only, unit-only and production restrictions are unchanged.

This is workflow guidance, not a global network permission: the repository-owned
guard still enforces the approved scope.

### Background runtime permissions

Direct `--runtime copilot` dashboard jobs display structured runtime requests
in **Copilot needs your response**. Review the command, paths, diff, URL or tool
arguments and any sandbox escalation, then choose **Allow once** or **Deny**.
For agent questions, choose an offered option or send a non-sensitive answer if
freeform input is enabled. Complete sign-in in the normal browser; never paste
passwords, tokens or MFA codes into FixLab.

When the selected current job is waiting for a freeform answer, **Message FixLab**
shows the question and **Send reply** answers that exact live request instead of
creating another job. **New conversation** explicitly starts a separate job.
Failed replies keep their text and report the error; changed questions clear
unsent replies with a notice rather than delivering them to a different request.

The request card distinguishes questions from tool permissions and shows whether
**Allow all** is active. This separately confirmed choice applies only to eligible
requests in the current executor. Ineligible requests still need an explicit
response, and questions always need the user's answer.

The same executor waits for your response, retains its repository lease, and
suspends its idle timer. No restart or generic Resume is needed. Multiple requests
are shown one at a time. When two or more approvable permission requests are
pending, expand **Review all pending permissions**, inspect every listed scope,
then choose **Allow all pending once** and confirm. This sends individual
one-time responses only for that reviewed snapshot. Questions, requests whose
approval is unavailable, and requests arriving afterward remain unanswered.
The dashboard rechecks the snapshot before sending; a stale request or delivery
failure stops the batch and reports confirmed partial progress without retrying.
Already delivered approvals cannot be rolled back. The batch itself creates no
grant for future requests or another job.
Stop/hold/shutdown cancels unanswered requests. Responses
are live-only and are not saved in dashboard history or copied to another job.
Unknown, sensitive or oversized permission details offer **Deny**, not approval.
Organization policy remains authoritative; an approval is not a passed test or
permission for unrelated production operations. The dashboard does not offer
permanent approvals; the separate Allow all choice expires with its executor.

Native filename-only discovery in canonical, non-sensitive checkout directories
and the exact `node <this-installed-fixlab.js> --help` command are built-in
read-only exceptions: they do not prompt or create a reusable grant. Discovery
does not read file contents; protected filenames may appear, but reading them
still requires their own permission check. Generic directory reads, content
search and other CLI commands are not included. Help must target the running
package's canonical CLI file, without extra arguments, shell composition,
redirects, reported external paths or URLs. Both exceptions retain managed human
approval, warning and sandbox-escalation checks.

Eligible native requests also offer **Allow repository-file reads for this job**
or **Allow this test command for this job**, each with a separate confirmation.
Dashboard intake enables **Allow routine source access and checks for this job**
by default. Submitting a fix-and-validate job grants non-sensitive source/test
editing and dashboard-owned validation gates for that job and checkout.
Validation-only modes receive read access, never source/test editing.
Uncheck the option before submission to retain individual approvals. Connected
MCP `job-start` uses the same default; `routineFileAccess: false` opts out.
Direct HTTP callers must still explicitly send `routineFileAccess: true`;
omitted or false values grant no routine access. This default does not enable Allow all tool commands,
override earlier denials, or change existing jobs.
Separately, a stopped native job's **Repository file trust** editor can review
source/test reads or source/test reads and edits for that exact job and canonical
checkout, including resumes and dashboard restart. This setting is not inherited
by another job, a fresh restart-as-new-job, a copied job or another checkout.
Change or revoke it while the executor is stopped; applying it never resumes.
Edit trust is available only in fix-and-validate mode. It allows new source/test
files under existing canonical directories, not directory creation, links,
hard-linked files, sensitive files, build/safety configuration, profile writes,
shell commands, external access or managed-policy exceptions.
The exact `.github/fixlab/repository-profile.json` is an eligible read after
bounded valid-profile and sensitive-content checks; other JSON is not added.
Configured authentication paths remain protected regardless of their names.
JavaScript/TypeScript test-source names such as `auth.spec.ts` and
`scenario.auth.test.ts` are eligible under reviewed file trust; the `auth`
test marker is not saved authentication state. Hidden files, authentication
directories and other sensitive filename markers remain excluded.
Manual permission review remains limited to 8,192 characters. Separately
reviewed source-edit trust can cover larger write requests when their complete
serialized review payload is at most 1 MiB and passes the full sensitive-content
scan. Display size never replaces the job/checkout, protected-path, source-file,
managed-approval or sandbox checks. Without reviewed edit trust, oversized writes
still cannot be approved through the dashboard.
Eligible oversized source edits offer **Review source-edit access**, including
after safe recovery denies the old request and no live approval remains.
The guided flow stops only the owned executor with confirmation, opens the
stopped job's file-trust review, then prepares a separately submitted fresh
authorization. Reviewing trust alone never resumes or replays an edit.
Only the relative filename, size and request identity are retained, not the
hidden diff. Fresh authorization remains instance/job/review-bound; full
scanning and all existing restrictions still apply. Do not truncate, split or
repackage the edit to evade the inline limit.

The active Copilot session's direct `checkpoints/*.md` regular files are
automatically readable without a repeated permission prompt. This bounded,
read-only exception excludes other sessions, links, directories, configuration,
writes, protected paths and managed/sandbox exceptions.

For a new native PPE job, **Allow all PPE API writes** defaults on only when
the repository's reviewed `dataSafety.ppeWrite` origins and authentication helper
pass configuration checks. Uncheck it to opt out. Connected MCP starts explicitly
targeting PPE use the same default; `allowPpeWrites: false`, explicit read-only or
intercepted modes, or a separately selected scoped POST option suppress it.
Invalid optional write setup is reported in readiness and does not default on.
Direct HTTP starts still require explicit write fields and confirmation.
DEV/SIT/UAT, production and existing jobs are unchanged. Each new job receives
its own revision-bound grant, which is not recovered after stop or restart.

Read trust also covers bounded, non-sensitive `stdout.log`/`stderr.log` under
this checkout's `.git/fixlab/command-evidence`, only with a canonical, regular
`job.json` receipt binding the gate to this exact job and repository. New
dashboard gate executions write that receipt. Other Git metadata, older
unowned logs, linked files and output containing detected secrets remain manual.
The review can also explicitly opt into dashboard-owned validation gates.
Only `node <this-installed-fixlab.js> gate` with this exact job, canonical
checkout and current dashboard port is matched, with four known options and
no extra arguments, shell composition or external URLs. The dashboard still
verifies gate membership, assigned checkout, profile freshness and job state.
Unknown or arbitrary shell commands remain separately reviewed.
Reads cover non-sensitive source, documentation and selected project files in
this checkout, never whole directories, hidden/sensitive files, browser state,
outside paths or symbolic links. Commands cover only the exact reviewed test
invocation in its canonical repository working directory, with the same reported
paths and package manifests. Shell composition, unknown commands, outside paths,
network permission requests, escalation and managed human approvals remain
manual. Missing command metadata means allow-once only. Tests can have side
effects: review their scripts; a command grant does not separately authorize
production/business writes. Grants are in-memory and expire whenever this
executor ends, including stop, hold, failure, restart or automatic continuation.
Ordinary **Allow once** and **Allow all pending once** never create these grants.

Agency and older text-only jobs cannot forward native prompts. When one reports
a non-interactive permission denial, FixLab stops the owned
executor and shows **Copilot permission required** in the browser. Do not use
ordinary Resume or PR approval to grant runtime access.

Inspect the raw logs first. If a specific external folder is needed, enter its
absolute path, select **Review folder access**, verify the resolved folder and
read/write scope, then select **Grant this folder and resume** and confirm.
This adds only that folder and its descendants to this job's runtime access.
It can also load trusted agent configuration from that folder. It does not
approve tools, URLs, credentials, production operations, or organization-policy
exceptions. The grant expires when the dashboard restarts and is never copied
to a new job.

If the denial's scope is unclear, leave the job paused. The runtime's text output
does not identify structured permission scopes, and a folder grant cannot fix
every permission denial. Another denial pauses the job again without repeated
automatic retries; a separate terminal is not needed for this folder review.
After owned termination is verified, **Dismiss blocked job and continue queue**
also remains available without granting permissions or enabling ordinary Resume.
If an already approved folder target changes, its grants are cleared and a new
permission review is required; a failed restart cannot restore the stale grants.

### Token controls

Native Copilot jobs in every mode use earlier context compaction, not just
Playwright-only jobs. Resumes measure retained context and compact above 24,000
conversation tokens, preserving decisions, safety restrictions, exact results
and remaining work instead of replaying discovery.

Under run options, **Input-token ceiling** defaults to `0` (unlimited). A positive
integer pauses once cumulative SDK-reported input, including cached input and
compaction, reaches it. A running model call can overshoot; it is not a hard
billing cap or dollar-cost estimate. Retries retain consumed usage. The
**Input-token budget** panel separates cached and uncached input; after verified
executor termination, explicitly update the ceiling above consumed input (or
choose `0`) and resume separately. A comment or retry cannot reset usage or bypass
an exhausted ceiling. Agency does not support positive SDK token ceilings.
Connected conversation status reports the exhausted budget and directs the user
to its separate browser review instead of suggesting an ineffective retry.

The UI starts one selected-runtime job at a time
and displays the intake, diagnosis, reproduce, fix, review, local-stack,
live-test, and pull-request stages with polled logs.

Use `--keep-awake-minutes` to prevent system sleep temporarily while the
dashboard is running:

```text
fixlab dashboard C:\source\application --keep-awake-minutes 180
```

For a standalone timer without starting the dashboard:

```text
fixlab keep-awake --minutes 180
```

The timer releases automatically when its duration ends or its FixLab process
stops. It does not change permanent power-plan settings or unlock the desktop;
interactive browser and authentication steps may still require an unlocked
screen.

The user supplies only the bug or required enhancement. The agent loads
validation context from the repository profile and autonomously owns contract
generation, diagnosis or affected-surface inspection, the smallest required
change, effective-diff review, focused local validation, profile-defined
application startup and live testing, evidence, and the gated pull-request
outcome. It never hardcodes environment choices. Human interaction is reserved
for authentication, unsafe-data approval, deployment or pull-request approval,
and genuine blockers.

Attach an interactive terminal to the active dashboard job with:

```text
fixlab chat [repository] [--port <number>] [--runtime <agency|copilot>]
```

Free text is sent to the same runtime session. `/status`, `/logs`,
`/evidence`, and `/pr` inspect the current job; `/retry`, `/continue`, and
`/skip` resume it with explicit guidance; `/stop` terminates only the
FixLab-owned executor and leaves the job resumable; `/exit` closes the shell
without stopping the job. Streamed activity redraws the `fixlab>` input line
instead of overwriting partially typed text. While the input line contains
text, background activity is buffered and displayed only after the line is
submitted, preventing typed fragments from becoming duplicate comments.

If no dashboard is listening, chat uses the current directory when it contains
a ready FixLab profile. Otherwise it asks for the local repository path and
opens the interactive onboarding agent. It initializes a missing profile,
requires onboarding to finish with a ready profile, starts the loopback
dashboard in the background, and connects automatically. The optional
repository argument supports non-interactive path selection.

When a dashboard is already listening, interactive chat displays its
repository before attaching. Press Enter to keep it or enter another local
repository path. FixLab starts the alternate repository on the next available
loopback port and connects to that dashboard instead.

Common operations do not require slash syntax. Natural phrases such as
`start dashboard`, `show status`, `show logs 50`, `show pull request`,
`show evidence`, and `switch repository to C:\source\application` execute
immediately. Other free text remains guidance for the active FixLab agent and
is queued after its current turn when the job is already running.

Create a separate bug job without opening the browser:

```text
new bug Product search returns duplicate rows
add a bug: Save remains disabled after validation succeeds
```

The new bug starts immediately when FixLab is idle or enters the dashboard
queue when another job is active. Use ordinary free text without the
`new bug` prefix when the instruction belongs to the current job.

Remove a waiting job without interrupting the active job:

```text
cancel waiting job 2
remove job 253ef92a-7bdf-47bd-b944-cdb0e6297580 from the queue
/cancel-job 2
```

The removed job remains visible as cancelled in dashboard history. FixLab
deletes its queued screenshot artifacts and renumbers the remaining jobs.

Manual entry is the default intake path. The dashboard can also load a full
Azure DevOps work-item URL or use a numeric ID with this optional profile
section:

```json
{
  "azureDevOps": {
    "organization": "your-organization",
    "project": "your-project"
  }
}
```

Azure DevOps loading uses the local developer's authenticated Azure CLI
identity and never exposes or stores the bearer token. It loads safe work-item
text and metadata without downloading private attachments. Both intake paths
can add up to five validated PNG/JPEG/WebP screenshots (2 MiB each, 8 MiB
total). Generated files remain outside tracked source, are sent to the agent
only as local paths, and are excluded from the durable metadata cache.

Within one job/session, the prompt requires profile/instruction-first reading,
git status and effective-diff inspection, task-relevant symbol searches, and
focused risk-scaled validation. It avoids unchanged-file rereads, repeated
diagnosis, dependency reinstalls, and unjustified broad checks. Stage summaries
are concise and the dashboard raw-log view is bounded. Git repositories use a
metadata-only cache under `.git/fixlab`, keyed by repository identity, `HEAD`,
worktree inputs, profile hash, and discovered instruction hashes. It reuses
only profile shape, prior result, fixed stage/status summaries, and gate
statuses, with 20-entry, 64-KiB, and seven-day limits. It retains no
agent-authored messages or source contents and cannot pass a gate. Current
instructions are reread; recurring lessons require review before promotion.
Non-Git repositories skip durable reuse.
