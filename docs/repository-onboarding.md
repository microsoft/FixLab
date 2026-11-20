# Repository onboarding

FixLab must not assume that every React and .NET repository has the same layout.
The target repository owns a versioned profile.

## Optional tagged-ticket automation

New profiles include `ticketAutomation` defaults for the `FixLab` tag,
five-minute polling and `draft-pr-or-discussion` outcomes. Before enabling the
watcher, configure one to eight `areaPaths` below the checkout's ADO project,
the existing PR target branch and a non-production environment:

```json
{
  "ticketAutomation": {
    "tag": "FixLab",
    "areaPaths": ["Example Project\\Application"],
    "pollSeconds": 300,
    "outcome": "draft-pr-or-discussion"
  }
}
```

The empty default area list intentionally does not authorize an entire shared
ADO project. Installing or onboarding never starts the watcher or grants its
session access. `fixlab watch` prints the plan; starting it separately requires
`--yes --allow-all-tools`. While running, the exact tag triggers eligible ADO
bugs/stories/features in those areas, including IcM represented by a linked ADO
item. A justified fix produces a draft PR and Discussion feedback; analysis,
already-fixed and blocked outcomes update the existing Discussion only.
See [watcher commands and limitations](commands.md#tagged-ticket-watcher).

## Dashboard chat setup

Choose **Add local repository** in the repository sidebar and enter the absolute
root of an existing local Git working tree. A deterministic chat asks about
application folders, commands and loopback health URLs, browser tests, sign-in
configuration, non-production environments and branch ownership. It makes no
model calls and never asks for credentials or authentication-file contents.

Review the proposed settings and exact file list before **Apply reviewed setup**.
Only the profile and missing packaged FixLab prompts/agent files are written;
existing custom scaffolding is not overwritten. No dependencies are installed,
commands executed, authentication performed or jobs started. Configuration alone
is not a passed Doctor or browser check. Failed multi-file scaffolding can leave
some newly created files; reload and review again rather than blindly retrying.

**Open repository workspace** reuses a verified local owner or opens an idle
loopback workspace in the same dashboard host. The original repository job keeps
running when you switch workspaces. The host owns at most eight additional
workspaces; shutting down that host closes its owned workspaces and resources,
not independently started dashboard processes.

Under **Settings & usage**, **Load repository settings** exposes the supported
repository-level fields without returning environment-variable values or a raw
profile. Preview and confirm every save. Unshown configuration is preserved,
including structured environment definitions; add new structured definitions
in the repository profile before enabling them through the editor. Production
operation policy cannot be enabled here. An executor lease or active owned
frontend/sign-in session prevents saving, without stopping those resources.
Only the selected repository's ownership scopes are checked for setup writes
and workspace opening. An unreachable or identity-mismatched registered owner
in those scopes blocks the operation unless safe automatic registration recovery
is possible. An unreachable port alone is not evidence that resources stopped.
Unrelated unavailable dashboard registrations do not block setup.
Plans expire after ten minutes and are invalidated by concurrent profile edits.
Setup paths reject traversal and symbolic links.

### Obsolete dashboard registrations

New dashboards persist their process ID and a resource checkpoint before
starting work. An idle checkpoint is written only when no owned job, frontend,
sign-in helper, setup, pending operation or execution/testing reservation remains.
Scoped owner discovery automatically archives a registration only when that
checkpoint is quiescent, the recorded process definitively no longer exists, and
the endpoint refuses connections or belongs to a different session. Process
permission errors, timeouts, HTTP errors, active/unknown resources and legacy
records do not qualify. A reused PID is treated conservatively as a live process.
Global repository discovery does not recover other repositories' records.

For old records or an interrupted busy dashboard, review:

```powershell
fixlab recover-sessions C:\source\application
```

The preview identifies live owners, obsolete candidates, ambiguous owners and
remaining repository/worktree reservations, with a snapshot-bound review token.
It does not archive files. Verify that every listed old dashboard and its child
executors, tests, frontends and sign-in helpers has stopped. Then explicitly
confirm that reviewed snapshot:

```powershell
fixlab recover-sessions C:\source\application --review-token <value> --confirm-quiescent --yes
```

Confirmation reinspects the owners and refuses changed snapshots, live or
ambiguous owners, linked paths and remaining execution/testing reservations,
including reservations in linked worktrees. It never uses age or a closed port
as permission to stop a process or clear a reservation. Original registration
bytes and a receipt are retained under a unique `.recovered-*` directory in the
same private ownership scope. A partial filesystem failure reports how many
registrations were archived; inspect again rather than replaying an old token.

Recovery changes only obsolete registration files. Job history, configuration,
authentication, runtime grants and actual stage/test outcomes stay unchanged.
Retry or continue the stopped job separately through its normal controls.
Missing stage markers or bug outcomes are not repaired by declaring success.

## Linked local applications in separate repositories

An API-only repository can reference a separately onboarded frontend without
moving its source, startup command or browser ownership into the API repository:

```json
{
  "linkedApplications": [
    {
      "id": "web-client",
      "repository": "C:\\source\\web-client",
      "application": "frontend",
      "url": "http://localhost:3001",
      "environment": "local"
    }
  ]
}
```

Add this optional field to the API repository's existing profile. References
support only local frontends, unique lowercase IDs and absolute Git working-tree
roots, with at most eight entries. Each target must have its own profile and
repository-contained frontend command/directory, matching port and health URL
protocol. URLs must be credential-free loopback origins with explicit ports.
Both profiles must include the `local` environment and explicitly declare
`browserAutomation.dataSafety.productionAllowed: false`.

Under **Connections**, choose **Load linked applications**, review the owner and
URL, and confirm **Open ... workspace**. FixLab reuses a verified owner or opens
an idle separate workspace; changed source/target profiles invalidate the review.
The host ownership and shutdown rules above still apply. The linked metadata
does not expose startup commands, environment-variable values or browser state.

Start the backend in its API workspace and the frontend in its own workspace.
Separately review the frontend's API base URL, local CORS, authentication and
browser request policy to target the intended backend checkout. Run real
integration assertions through the frontend and retain evidence of both commits.
Links do not rewrite URLs or policies, transfer edit permissions, copy login
state, start jobs or commands, orchestrate cross-repository tests, or prove that
either service is ready. API-only admission and required backend validation
remain unchanged; a missing backend readiness proof still blocks API jobs.
Keep changes and pull requests in their respective repositories.

## Required information

### Explicitly deferred live tests

For a repository approved for local unit tests only, set
`validation.liveTestsRequired: false` and a nonempty
`validation.liveTestsDeferredReason` (at most 500 characters). Omit
`browserAutomation` and live-test gates, and retain at least one explicitly
required gate with `kind: "tests"` for the offline unit suite. Other required
local checks and CI/merge policies remain authoritative.

The dashboard then admits ordinary fix/validation jobs without browser sign-in,
API proof or application startup. Browser-only jobs and live/UI run options are
rejected. Record local-stack and live-test as skipped with the saved reason,
not passed; unit results do not prove integration or production access. This
opt-in affects only that repository; omitted/true retains existing live-test
requirements. Start a newly reviewed job after changing this policy.

### Repository

- Default branch
- Allowed pull request target branches
- Developer user ID and branch prefix template
- Working directories
- Dependency restore commands
- Build and test commands

### Components

For each component, identify:

- Source paths
- Test paths
- Shared dependencies
- Maintainer or code owner
- User-visible validation requirements

### Applications

Declare:

- Startup command
- Health endpoint
- Owned local port
- Required environment variables
- Whether a deployed dependency or local dependency is required

### Browser journeys

Each journey should specify:

- Route or entry point
- Required role
- Safe test-data requirements
- User actions
- Exact observable assertion
- Cleanup behavior

The profile must also declare:

- `browserAutomation.testCommand`, which runs the repository-owned Playwright suite.
- `browserAutomation.testSynthesis`, which enables focused scenario generation,
  declares the default test-data source and mutation mode, and requires
  scenario evidence.
- `browserAutomation.authentication.required`, explicitly stating whether login is needed.
- An authentication command and status paths when authentication is required.
- A reviewed `browserAutomation.authentication.proofCommand` for authenticated
  browser readiness. It must exercise a read-only signed-in assertion against
  `FIXLAB_TARGET_ENVIRONMENT`, fail for expired/unauthenticated state, and close
  its owned browser. A helper exit or state-file existence is not login proof.
  Dashboard proof is memory-only and bound to the job, selected environment,
  configuration and unchanged regular status-file identities; new jobs and
  changed state require a fresh proof. No browser-state contents are inspected
  or copied by this check.
  Include the persistent browser-profile directory in `statusPaths` as well
  when ownership checks must detect another browser using it. Directory identity
  is checked without treating browser lock-file updates as credential changes;
  at least one regular status file is still required for authenticated proof.
- `browserAutomation.dataSafety.policy`, describing mock, read-only, or intercepted-mutation behavior.
- `browserAutomation.dataSafety.productionAllowed: false`.

Optionally, declare `trustedDependencyRoots`, a list of absolute directories, when a
working directory's `node_modules` is a link to a shared install outside the
repository. Non-interactive agents cannot answer path-permission prompts, so FixLab
passes `--add-dir` only for `node_modules` links under these roots, in the profile's
working directories. Without this field, no external path is granted. Filesystem roots
are ignored.
Synthesized scenario source is transient by default. The agent must remove
generated test files and validation-only configuration changes before the
product pull request. A repository can require a permanent generated browser
test through its instructions, or the user can request one explicitly;
otherwise newly created authenticated `*.auth.spec.ts` files are validation
artifacts rather than product changes.

### Real DEV reads and writes for React applications

In repository settings, enable **real DEV API reads and all writes** and provide
the real DEV API origins, full API scope and existing repository-relative `.mjs`
authentication helper. Review and apply the preview once. This config is shared
through the repository profile; each developer still authenticates independently.
Setup validates configuration without executing the helper, signing in or sending
a request. No job permission prompt is needed afterward.

For example, inside `browserAutomation.dataSafety`:

```json
{
  "productionAllowed": false,
  "devWrite": {
    "allowAll": true,
    "origins": ["https://api.dev.example.test"],
    "scope": "api://example-service/access",
    "sessionHelper": "tools/dev-session.mjs",
    "browserProxyPaths": ["/api"]
  }
}
```

Declare `dev` in `environments`, configure the frontend health URL and use an
existing helper exporting `withApiToken({ scope, interactive }, callback)` for
native API authentication. Use only reviewed DEV HTTPS origins. If the React app
calls the API directly, omit `browserProxyPaths`; if it uses an owned loopback
frontend proxy, first verify those prefixes really target the listed DEV origins.
Setup does not rewrite the application's API URL, CORS or proxy implementation.
Keep its existing normal browser authentication and environment configuration.

Configured DEV uses real GET/HEAD/OPTIONS, search POST and
POST/PUT/PATCH/DELETE create/update/submit flows, not a read-only or intercepted
default. The dashboard hides the per-job write permission controls. Other
environments and explicit stricter selections remain unchanged.

Dashboard gates and CLI-launched workers receive `FIXLAB_HELPER_ROOT`,
`FIXLAB_REPOSITORY` and `FIXLAB_DEV_API_ENVIRONMENT`. Repository-owned Playwright
journeys can import the packaged guard without installing FixLab in the app:

```js
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { createDevBrowserContext } = await import(pathToFileURL(
  join(process.env.FIXLAB_HELPER_ROOT, "dashboard", "dev-browser.js")
).href);
const session = await createDevBrowserContext(browser, {
  contextOptions: { storageState: ".auth/dev.json" }
});
try {
  const page = await session.context.newPage();
  await page.goto(frontendUrl);
  // Exercise the real workflow and assert its UI/API outcomes here.
  await session.assertHealthy();
} finally {
  await session.close();
}
```

Reuse a genuine authenticated state through the existing application sign-in
flow; the guard does not invent cookies or tokens. Complete sign-in before the
guarded context and refresh it separately if the application needs an external
identity provider. Do not add mocks, page-route overrides or direct
`APIRequestContext` traffic to this browser path. HTTP success alone does not
prove the business scenario passed. Missing authentication/API access remains
blocked, not a synthetic pass. See [the DEV access contract](security.md#persistent-dev-browser-and-api-access).

### Existing restricted defaults

Without persistent DEV setup, new installations default `browserAutomation.testSynthesis.devReadOnly` and
`ppeReadOnly` to `true` for new portal profiles. Selecting `dev`, `development`
or `ppe` uses real
read-only backend data while mutations remain intercepted. Unselected/local,
SIT/UAT and other environments retain `defaultDataSource`; dedicated API-only,
unit-only and production contracts are not overridden. Existing profiles are
preserved. Set `devReadOnly: false` to retain synthetic-only DEV validation;
changing either policy requires a fresh reviewed job. During onboarding, configure
browser/auth guards for all verified read-only queries on the reviewed DEV/PPE
HTTPS API origins, not only a feature-specific subset. Include GET/HEAD/OPTIONS
and verified read-only POST searches; classify POST from its contract,
implementation and payload rather than the verb or route name. Once that read
scope is approved, no per-query human confirmation is required. Preserve
identity-only authentication/proof defaults and all business-write controls.

For an existing adapter that still permits only a feature-specific subset, run
the dedicated query-setup operation in the application checkout:

```shell
fixlab setup-queries REPOSITORY --environment dev --runtime copilot
fixlab setup-queries REPOSITORY --environment dev --runtime copilot --yes
```

The first invocation starts an interactive, read-only setup review. It inventories
the full verified query scope from contracts and implementation and reports the
exact policy/adapter files and proposed offline guard tests. On Windows, the
launcher quotes the generated arguments so both runtimes receive the complete
setup prompt as one argument. After reviewing that
plan, `--yes` authorizes only the setup repair and focused guard tests. Existing
adapters must consume the shared query policy; adding one profile path alone is
not sufficient. No business API calls, authentication, business writes, product
source changes or PR operations are authorized. Runtime permissions remain
interactive and independent. An existing approved non-production browser read
scope is required; API-only, unit-only, synthetic-only and production policies
cannot be expanded by this command.

Finish setup before starting a fresh reviewed validation job. Do not repair
configuration inside a validation-only job or reuse stale helper/write approvals.
This operation does not turn all POSTs into reads or replace the separate
POST/DEV/PPE write-approval flow.

Use `defaultDataSource: "synthetic-intercepted"` with
`mutationMode: "intercepted"` when Playwright should fulfill reads locally and
capture mutation intent without changing an external record. Repositories may
instead declare `local-fixture`, `non-production-read-only`, or
`non-production-approved`; outside persistent DEV configuration, approved writes
still require the normal human unsafe-data approval.

With `non-production-read-only`, the explicitly selected profile-approved
environment is tried first. Profiles can offer DEV, SIT, Test, UAT, or other
repository-specific non-production systems so users are not required to have
access to one shared environment. If that backend is unavailable or cannot
provide a safe record required for the assertion, FixLab may fall back to
`synthetic-intercepted`/`intercepted` and must report that the backend was not
validated. Expected empty-state scenarios must remain against the selected
backend and must not be replaced by synthetic results.

Do not place real credentials, tokens, user identities, customer records, or
internal service URLs in the profile.

Configure repository branch ownership explicitly:

```json
{
  "pullRequests": {
    "branchNaming": {
      "userId": "developer-alias",
      "prefixTemplate": "users/{userId}"
    }
  }
}
```

FixLab replaces `{userId}` with the configured value and instructs the agent to
create branches beneath the resolved prefix. It never substitutes `copilot`,
`fixlab`, or another runtime name for the repository user's ID.

### Automatic PR approval-request comments

Configure up to eight review teams in the reviewed repository profile:

```json
{
  "pullRequests": {
    "reviewTeams": ["@example-org/review-team"]
  }
}
```

GitHub entries use `@org/team` handles. For Azure DevOps, use team identity
GUIDs verified in the PR's organization/project; FixLab resolves their native
mentions rather than guessing from display names. Omit the setting or use `[]`
to disable approval-request comments. Existing profiles need no migration.
This setting is edited in the profile, not the dashboard Settings form.
Configured teams are captured in the saved job workflow; a profile change
requires fresh review and never restores runtime permissions.

After authorized PR creation or update, the existing agent-driven PR workflow
verifies each configured team against the actual PR scope, then posts an
approval-request comment with the PR link and accurate validation status.
It reads comments first and reuses only its own `<!-- fixlab:team-review -->`
comment so retries do not repeatedly notify reviewers. Provider readback is
required before it reports the request posted. Missing permissions, unresolved
teams or uncertain acknowledgements are reported as unconfirmed, not blindly
retried; an already-created PR remains available.

This applies to dashboard, direct CLI and tagged-ticket code jobs in both
runtimes. It does not post in validation-only jobs, bypass runtime permissions,
assign reviewers, approve or merge, change draft status, or waive required
checks. The watcher still owns work-item Discussion feedback separately.

## API-only Playwright validation

For a backend-only repository, keep its real `applications.backend` startup
command, working directory, loopback health URL and port. Do not add a dummy
frontend. Use an isolated repository-local Playwright workspace and configure:

```json
{
  "browserAutomation": {
    "mode": "api",
    "workingDirectory": "api-tests",
    "package": "@playwright/test",
    "testCommand": "npm test",
    "authentication": {
      "required": false
    },
    "dataSafety": {
      "policy": "Only reviewed read-only API paths on the allowlisted local backend.",
      "productionAllowed": false,
      "allowedOrigins": ["http://127.0.0.1:5087"],
      "allowedMethods": ["GET", "HEAD", "OPTIONS"]
    },
    "testSynthesis": {
      "enabled": true,
      "defaultDataSource": "non-production-read-only",
      "mutationMode": "none",
      "requireScenarioEvidence": true
    }
  }
}
```

Set `authentication.required: true` for protected APIs, with the real
repository-owned authentication `command`, fresh read-only API `proofCommand`,
and `statusPaths`. Status files can be non-sensitive authentication receipts;
never fabricate them or put tokens, cookies or browser state into copied
worktree configuration. A helper exit, receipt or Azure CLI login is not proof
of a valid API token for the intended audience. Obtain credentials through
the approved human-controlled flow and verify authenticated API access afresh.

Run `fixlab setup-playwright <repository>` to review the package-only plan;
`--yes` installs the package when missing, never a browser in API mode.
`fixlab doctor` verifies the API request runtime without contacting the backend.
It does not prove the backend is healthy or authenticated. Existing profiles
without `mode` retain browser validation.
API-only jobs retain their mode across dashboard restart and resume, including
older saved contexts restored against an explicitly API-only profile. Selecting
a CLI environment preserves the same read-only API contract; it does not enable
browser mutation interception or synthetic UI fallback.

Use the normal `playwright-only` job mode for read-only API validation.
The repository runner must use `APIRequestContext` and enforce the origin and
read-only operation allowlists before every request. Reject or disable
redirects (`maxRedirects: 0`) so credentials cannot reach another origin.
`page.route` interception does not apply to API requests. This initial API mode
does not authorize mutation testing or UI-intercepted simulation. Safe local
API fixtures may use `defaultDataSource: "local-fixture"`; they must not be
reported as validation of a deployed backend.

Preserve sanitized method/path/status and schema assertions with `FIXLAB_TEST`
scenario evidence. Do not retain authorization headers, cookies, sensitive
bodies or credential-bearing traces. API-only jobs need no screenshots,
browser profile, video or manual React gate. Missing startup, configuration,
permissions or API authentication blocks live testing, not a synthetic pass.

## Worktree setup

### Reusing one checkout for sequential jobs

For an already configured dedicated checkout, review and enable reuse without
recreating its setup:

```powershell
fixlab onboard C:\source\application-runner --reuse-setup --runtime copilot
fixlab onboard C:\source\application-runner --reuse-setup --runtime copilot --yes
```

The plan preserves existing commands, helper files, dependencies and browser
state in place. It requires the profile's real remote, base branch and branch
naming settings; it does not guess them, start a job or switch branches.
Approval enables shared mode and runs Playwright/configuration checks without
running restore commands. Changed branch manifests still need validation and,
when necessary, an explicit `fixlab prepare` restore.

Add `--authenticate` to the approved command to verify an existing browser
session with its configured `proofCommand` when all contained `statusPaths`
exist. A failed proof is reported, not silently retried as login or treated as
success. Use the existing `fixlab authenticate ... --yes` operation for human
sign-in when needed. API authentication keeps its separate fresh-job contract.

If the local profile already has `validation.expectedCommit`, reuse enables
`worktreeSetup.bindExpectedCommit` and refreshes that pin after owned branch
acquisition or resume. This requires a Git-ignored local profile; tracked
profiles are never rewritten. Keep a reusable template separately. Changed
profile revisions still invalidate prior authentication/write approvals.
Neither a refreshed pin nor a directory's presence proves authenticated access.

Repair a legacy browser guard once through reviewed `fixlab setup-queries`,
including required read-only bootstrap APIs, local assets, UI fonts and identity
resources in the repository's shared policy. Do not copy a one-off journey's
allowlist into every future test or broadly allow an origin to avoid a blocker.

Opt in to shared mode in a dedicated runner checkout's repository profile:

```json
{
  "worktreeSetup": {
    "mode": "shared",
    "remote": "origin",
    "baseBranch": "develop",
    "files": ["frontend/playwright.local.config.ts"]
  },
  "pullRequests": {
    "defaultTargetBranch": "develop",
    "branchNaming": {
      "userId": "developer-alias",
      "prefixTemplate": "users/{userId}"
    }
  }
}
```

Start `fixlab dashboard` against this checkout, or connect with `fixlab chat`.
Shared fix-and-validate jobs use that same folder, dependencies and local
browser profile; they do not create a folder per bug. Each new job refreshes
the configured remote base and creates a separate `users/<alias>/fixlab-<job-id>`
branch from its fetched commit, not from the previous fix branch. Omit
`baseBranch` to use `pullRequests.defaultTargetBranch`; the default remote is
`origin`. No network fetch is performed merely by installing or inspecting
the profile.

The existing repository executor lease fences preparation and execution.
Another job can reuse the folder after execution has verifiably stopped,
even while its earlier PR is pending. Use **Hold** to release a blocked job
to the queue, and **Resume** to reacquire its saved branch and session.
Resumption never fetches, rebases or resets that branch. Restarting a job
creates a new session and branch from the refreshed base. Saved shared
ownership survives dashboard restarts; legacy jobs without a saved branch
must be resumed using their original workspace policy.

Branch changes require a clean index and working tree, including untracked
files, and no merge/rebase/cherry-pick in progress. Stop owned frontend and
authentication processes before selecting a different branch. By default, preserve
dirty files separately before starting another job. Set
`worktreeSetup.autoStash: true` to automatically preserve eligible tracked
(including staged) and untracked source changes in a verified stash before each
new shared editing job acquires its new branch. The previous branch and its
commits remain intact. The job records the stable stash commit, including if
later base refresh fails; restore it separately using `git stash apply --index <commit>`.
It is never automatically applied to the new job. Resuming an existing job and
validation-only jobs never auto-stash or acquire a new branch.

Automatic preservation rejects sensitive, linked, non-source, unresolved,
oversized or excessive changes before stashing anything. Ignored credentials,
browser state and dependencies are not stashed. A blocked preservation step
stops the job rather than discarding or silently excluding changed files.
FixLab never resets, deletes files, overwrites ignored files, or force-switches
another worktree's branch. A failed fetch blocks the new job instead of using
a stale base. The Git refresh is noninteractive and has a 30-second timeout;
authenticate to the remote separately if necessary.

Keep this checkout's reusable profile/configuration available on the base
branch or locally ignored; uncommitted setup files must be committed or
explicitly ignored before starting. Branch-dependent dependencies must still
be checked after acquisition. Existing browser state can be reused only after
authenticated access is verified for the selected environment. Ignore browser
state and dependencies in Git; never copy credentials between checkouts.

Shared mode is opt-in; omitted mode or `"isolated"` preserves existing
behavior. Direct interactive bug-fix and `fixlab run` execution are blocked in
shared mode because they do not have the dashboard's branch-resume contract.
Validation-only jobs do not switch branches or refresh the base.

### Preparing another worktree

Dashboard editing jobs with `worktreeSetup.mode: "isolated"` automatically
create or recover a receipt-bound checkout and keep the same job ID. Detached
source checkouts also get this recovery unless shared mode is explicit.
Declared configuration, dependency restore and Playwright setup run before
execution; no routine request to create a checkout is needed. A failed restore
is reported and dependent validation stays unverified while independent code
work can continue. Stop cancels that job's owned setup. Existing edits,
branches and unrelated worktrees are never reset, deleted or adopted by name.
Different isolated jobs can implement concurrently; shared local testing
queues and resumes automatically. Browser identity, runtime grants and prior
passing validation do not transfer. Manual preparation remains available:

A Git worktree does not inherit ignored profiles, untracked browser
configuration, restored dependencies, or authenticated browser state. Declare
only the non-sensitive configuration files needed by another checkout:

```json
{
  "worktreeSetup": {
    "files": ["frontend/playwright.local.config.ts"]
  }
}
```

Start with the configured source checkout and review the plan:

```powershell
fixlab onboard C:\source\application-worktree --from C:\source\application --runtime copilot
fixlab onboard C:\source\application-worktree --from C:\source\application --runtime copilot --yes
```

`--from` requires another checkout of the same Git repository. Without `--yes`,
it changes no files and runs no commands. Approval copies the profile and only
the declared files, initializes missing FixLab prompts, runs the profile's
restore and Playwright setup, and checks readiness. Matching files are
preserved; differing configuration requires a manual merge. Only a profile
that exactly matches the packaged unchanged example can be replaced
automatically. All file paths must stay within their checkout, without
symlink/junction escapes. Dependency folders, credential files and browser
state are excluded.

An explicit `--config` file in the profile's browser test command must exist
in the target checkout or be included in the copy plan. Missing configuration
blocks setup and dashboard readiness instead of silently skipping live testing.
After provisioning, rerun onboarding without `--from` if the target profile
has been customized.

When `node_modules` links outside the checkout, onboarding lists the exact
resolved dependency directories. `--yes` approves adding only those paths
to `trustedDependencyRoots`; runtime adapters pass them through `--add-dir`.
Doctor reports unapproved links before a non-interactive job starts. This
does not grant all filesystem paths, approve URLs, or override runtime deny
rules. Explicit runtime denial remains a blocker, not a reason to repeat
unchanged approvals.

For required browser sign-in, add `--authenticate` after reviewing the
repository-owned authentication command. Sign-in/MFA must be completed by the
user in this checkout's own browser profile. A profile directory existing is
not proof of a valid application session. Add `--start-dashboard` only when
all Doctor checks can pass; serve this worktree's actual code, not a healthy
server from another checkout.

### Frontend-owned authentication for an API-only repository

The dashboard's **Onboard repository** and **Repository Settings** flows offer
**Configure portal-backed API authentication**. Setup collects the approved
local HTTPS read endpoint and full API scope.

For a portal and backend in the **same repository**, keep the real frontend
configuration in `applications.frontend` and select that repository as the
permitted consumer. API-only profiles retain `browserAutomation.mode: "api"`
and their API test command; the portal supplies sign-in only, not a portal UI
test suite. Setup uses `portal-api-proof` directly and never links a repository
to itself.

For a portal in **another repository**, backend-only API profiles additionally
select the linked portal repository, origin and ID; the portal owner selects
the permitted consumer and its repository-owned session helper. Each setup
changes only the current repository. Configure the portal's matching grant
separately before connecting the API consumer.

The portal helper is an existing, contained JavaScript module with two exports:

```javascript
export async function withApiToken({ scope, interactive }, check) {
  const session = await openRepositorySession({ interactive });
  try {
    const token = await session.acquireApiToken(scope);
    await check(token);
  } finally {
    await session.close();
  }
}

export function assertApiResponse(body) {
  return Array.isArray(body); // Replace with this endpoint's real contract.
}
```

`openRepositorySession` above represents the repository's normal MSAL/OIDC
browser-session implementation, not a FixLab API. Implement/import the actual
portal helper; FixLab does not guess SDKs, client IDs, tenants or token stores.
`withApiToken` must honor the requested API scope, use only its own authenticated
browser, await the callback exactly once, close its owned session, and never
persist/log the token. `assertApiResponse` must return `true` only for the actual
expected response schema and behavior. Neither export may synthesize auth or
API responses.

On approval, setup configures separate API sign-in/proof commands with the
`portal-api-proof` runner and adds a required read-only live-test gate. Normal
portal sign-in/proof commands stay unchanged: connecting the portal does not
require a running local API. Linked API consumers explicitly request the
separate API proof from the idle portal owner. Existing
builds, tests and authentication checks remain. The runner uses the in-memory
token in Playwright's `APIRequestContext`, validates TLS, refuses redirects,
checks anonymous 401 and authenticated 200 plus the helper's response contract,
and persists only a non-sensitive readiness receipt. **Connect Playwright**
still performs real sign-in/MFA. A saved portal session alone never passes API
readiness. Scope/helper/profile changes invalidate the previous proof.
Existing API-only gate selections also include the new required gate. For
change-aware policies, setup adds it to scopes matching the configured backend
directory, not frontend scopes. An ambiguous backend mapping blocks setup until
the repository's scope policy is reviewed.

The API proof origin must match the consumer's configured local backend origin.
The initial onboarding bridge supports local HTTPS APIs only, not arbitrary
deployed hosts or writes. For backend changes, build/start the changed checkout
and select that local backend; proving a deployed baseline is not validation
of a local fix. Focused API tests may reuse the repository session adapter;
they do not require a complete portal UI test suite. Disabling the onboarding
option restores the previous authentication commands and removes its generated
gate/grant; unrelated validation remains untouched.

Opening a linked frontend does not prove API readiness. To use its normal
browser sign-in for an API check, set the API profile's
`browserAutomation.authentication.linkedApplication` to an existing link ID.
Configure its backend `healthUrl` as the exact approved loopback HTTPS GET
endpoint and include that origin/method in its data-safety allowlist.
The authentication working directory must exist and declare one non-secret
JSON status receipt beneath `.auth`.

The frontend profile must explicitly grant the consumer under
`browserAutomation.authentication.apiProofFor`:

```json
{
  "repository": "C:\\source\\api",
  "origin": "https://localhost:50443",
  "method": "GET",
  "path": "/protected-read"
}
```

`apiProofFor` is an array of at most eight such entries. The frontend's own
reviewed authentication and proof commands must acquire/use the correct API
token inside their owned browser context, assert anonymous rejection and a
real authenticated response/schema, and return no private response data.
Do not export tokens, copy browser state, mock the API or weaken its gates.
Grants default to the exact consumer checkout and reviewed endpoint. An explicit
`"includeWorktrees": true` additionally permits Git worktrees of that same
canonical repository, so isolated API jobs need no copied credentials. Their
individual profile revisions and workspace identities still bind each proof.

Start the frontend's own idle dashboard workspace, then review and execute:

```powershell
fixlab linked-api-proof C:\source\api
fixlab linked-api-proof C:\source\api --authenticate --yes
fixlab linked-api-proof C:\source\api --proof --yes
fixlab portal-api-proof C:\source\portal --proof --yes
```

Without `--yes`, `linked-api-proof` only describes the configured request;
`portal-api-proof` requires explicit confirmation. Authentication
runs the frontend's configured sign-in followed by fresh proof; proof-only
does not launch its interactive sign-in command. A unique run ID prevents
accepting another run's result. Profile, workspace or job changes invalidate
the request. Failed/unreachable/busy owners never create readiness receipts.
Use repository-owned wrappers in the API profile's authentication and required
API-test commands; all other backend build, test and publication gates remain
unchanged. This read-only proof is not evidence that a new write endpoint or
changed backend commit has passed integration testing.

### Local API backed by a production database

This is a **default-off exception**, not general production access. In the
portal-backed API setup, select **Allow this local API to read a production database?**
only after approving the actual database target and effective backend identity.
The profile then sets
`browserAutomation.apiAuthentication.productionDatabaseReadOnly: true`.
For separate repositories, approve it independently in both profiles and in
the portal's exact-endpoint `apiProofFor` grant:

```json
{
  "repository": "C:\\source\\api",
  "origin": "https://localhost:50443",
  "method": "GET",
  "path": "/protected-read",
  "productionDatabaseReadOnly": true
}
```

The portal's session adapter must additionally implement
`assertReadOnlyDatabase({ apiUrl, method, dataEnvironment })`. It must verify
the **actual datasource and effective database identity**, including
database-enforced read-only permissions, and return `true` only when verified.
Missing, false or throwing checks block before API contexts, token acquisition
or sign-in. A hardcoded success, GET method, localhost URL, DEV label,
application read-only setting or connection read-intent alone is not proof.
FixLab does not discover credentials, alter connections, grant permissions or
choose a production datasource.

The adapter's `withApiToken({ interactive: true }, check)` must handle sign-in
after this preflight. Production mode deliberately does not prepend the older
normal portal sign-in command, which could read business data before the
safety check. On a browser-mode portal owner, ordinary portal authentication
and UI jobs are blocked; only explicitly selected API-purpose proof is allowed.

Run production-backed jobs from the **API-only dashboard** against the exact
approved loopback HTTPS backend. Jobs block before executor launch until fresh,
job-bound portal/API proof succeeds. Direct `run`/`validate` commands cannot
bypass that requirement; the dedicated CLI proof commands remain available.
Receipts and scenario evidence must say `production-read-only` and
`mutationMode: "none"`, never non-production or intercepted. The general
`dataSafety.productionAllowed` setting remains `false`. Deployed production
portal/API targets, writes, synthetic success and broad production access
remain prohibited.

Changed production approval requires a newly reviewed job, including after
restart. Disabling the option restores saved testing configuration, **not the
database connection**: independently verify that the backend no longer targets
production before using a non-production profile.

## Optional private adapters

Some organizations keep data-handling or policy helpers (for example, validation
of security work-item data) in a private package. Public FixLab does not name,
bundle, or install such packages. The owning team makes them discoverable:

- Publish a short onboarding page in the private repository or internal wiki
  that states the package name, the feed that hosts it, how to request access,
  and who approves its use.
- Authenticate to that feed with the owner's supported credential provider
  before running `fixlab prepare`. FixLab never creates, copies, or persists
  feed credentials.
- Link the onboarding page from the repository's own `README` or contributor
  guide so a first-time developer finds it without asking.
- Keep the adapter's name, feed URL, and access instructions out of public
  FixLab files and out of the profile's shared defaults; they belong in the
  private repository.

An adapter must not bypass approval gates. Publication approval, unsafe-data
approval, and the no-automatic-closure rules for findings still apply.

## Profile review checklist

- Commands run non-interactively.
- Paths are repository-relative.
- Tests are focused and deterministic.
- Full builds have a bounded timeout.
- Local processes have explicit ownership markers.
- Production is excluded unless the narrowly approved local-API read-only
  exception above is configured and its database-enforced safety check passes.
- Browser profiles are stored outside Git.
- Screenshots are sanitized before sharing.
- Pull request creation requires authorization.
- Deployment is a separate, explicitly approved capability.

`fixlab doctor` and the dashboard both block startup when the frontend startup
command, loopback health URL, Playwright command, authentication intent, or
data-safety policy is missing. This prevents a job from reaching the live-test
stage before the repository has a runnable, non-mutating browser-validation
contract. When authentication is required, every configured status path must
also exist; the authentication command should create its final status marker
only after sign-in succeeds.
