# Installation

For code-work jobs, the dashboard offers an explicit unverified draft option
without local checks or live tests, plus a separate live-test deferral option.
Select the deployed-backend option to use a reviewed DEV/SIT/UAT/PPE API without
starting .NET locally. Unrun checks remain unverified; merge rules are unchanged.
CLI equivalents are `fixlab run REPOSITORY --draft-without-checks`,
`--skip-live-tests` and `--deployed-backend --environment dev`, followed by the
request. See [job architecture](architecture.md) for the boundaries.

New users: start with [Copilot-first setup](FIXLAB-SETUP.md), or
[First installation](../installation.md) for prerequisites and machine changes.
This guide provides the detailed fallback when Copilot or the setup file is
unavailable, plus setup for Agency Copilot and direct GitHub Copilot CLI execution.

For known CLI, package-manager, private-feed, Playwright, authentication, and
runtime failures, see [Troubleshooting](troubleshooting.md).

The [Word installation quickstart](FixLab-Installation-Guide-Quickstart.docx)
is a downloadable convenience copy for fresh Windows setup and common
installation problems. These Markdown instructions remain the maintained
source of truth for updates.

Choose the setup path you need:

- [First installation with Copilot](#first-installation-with-copilot)
- [Fresh Windows dev box](#fresh-windows-dev-box)
- [What installation changes](#what-installation-changes)
- [Enterprise-managed GitHub accounts](#enterprise-managed-github-accounts)
- [Guided CLI setup](#recommended-path-install-then-run)
- [Copy-paste Copilot installation prompt](#copy-paste-installation-prompt)
- [Visual Studio Code custom agent](#install-and-use-in-visual-studio-code)
- [Existing Copilot CLI session](#starting-from-an-existing-copilot-session)
- [Optional dashboard MCP connection](#chat-with-an-existing-dashboard-from-copilot)
- [Windows bootstrap](#intelligent-windows-bootstrap)

After setup, use [Getting started](getting-started.md) for your first job.

## First installation with Copilot

**Option 1: paste one prompt (fastest).** Open Copilot in the application
checkout, then paste:

```text
Install or reuse FixLab, register its MCP server, and onboard this repository
with --runtime copilot. Review the real repository profile and setup plan
with me before applying changes. Use Microsoft Edge by default for required
browser validation. Review package-feed authentication separately from
browser SSO and protect private state. Run Doctor, then ask before starting
or reusing the matching dashboard. Preserve my code and do not start a job.
```

**Option 2: give Copilot a Markdown file.** For reusable, reviewable instructions,
copy [FIXLAB-SETUP.md](FIXLAB-SETUP.md) into the checkout root without
overwriting an existing guide, then paste:

```text
Read @FIXLAB-SETUP.md and set up FixLab for this repository.
Show the plan and ask before applying changes.
```

If it is elsewhere, attach it or provide its actual path. In both paths,
approve reviewed operations and complete application sign-in/MFA yourself.
Copilot reports remaining requirements; the guide is not an automatic installer
or a permission grant. The [Word quickstart](FixLab-Installation-Guide-Quickstart.docx)
is also available. If Copilot or the file is unavailable, use the detailed
installation steps and command reference below.

For approved scaffolding, separate npm/Yarn and NuGet feed authentication,
dedicated Edge SSO, protected private state, and dashboard proof checks, follow
the [reviewed setup instructions](FIXLAB-SETUP.md#instructions-for-copilot).
The setup guide defaults browser UI profiles to Microsoft Edge, not bundled
Chromium; this does not change standalone CLI or existing profile defaults.

## Recommended path: install, then run

This is the manual fallback when Copilot or the setup guide is unavailable.
First-run onboarding may create scaffolding without `--yes`; review and approve
those files first. Once your supported runtime is installed and signed in:

```powershell
npm install --global github:microsoft/FixLab
fixlab onboard C:\source\application --runtime copilot
```

If a new example profile is created, configure the actual application paths and
commands, then rerun `onboard` to inspect its setup plans. For browser UI setup,
select `"browser": "chromium"` with `"channel": "msedge"` before approving the
browser plan; this launches Microsoft Edge. Preserve an explicitly reviewed
repository alternative. After reviewing and approving the actual plans:

```powershell
fixlab onboard C:\source\application --runtime copilot --yes
fixlab doctor C:\source\application --runtime copilot
```

Resolve every Doctor blocker, then start chat:

```powershell
fixlab chat C:\source\application --runtime copilot
```

Replace the path with your clone. For Agency, replace `copilot` with `agency`.
If setup is incomplete, chat opens a guided interactive setup with an explicit
onboarding request. Review the real profile paths and commands, approve the
scoped restore/browser setup, and complete any required feed sign-in and
application MFA yourself. FixLab checks readiness before starting the dashboard.
If setup fails, it reports the prerequisite rather than starting a broken job.

The remaining sections are alternatives, not a checklist. A PR-only feature
needs its approved commit installed until it reaches the default branch.

## Prerequisites

The machine running FixLab needs:

- Agency with GitHub Copilot CLI support, or GitHub Copilot CLI directly
- Git
- Node.js 20.19+ in the 20.x line, or 22.12+ (required by the bundled Copilot SDK)
- PowerShell 7
- The .NET SDK required by the target repository
- A repository-local `@playwright/test` or `playwright` package
- Microsoft Edge or another repository-approved Playwright browser
- Access to the source repository and its allowed validation environments

Azure CLI is optional. It is required only when the local dashboard loads
Azure DevOps work items. Authenticate with `az login` using the developer
identity that already has access to the requested organization and project.
FixLab does not persist the resulting Azure DevOps resource token.

Agency remains the default compatibility runtime. Use your organization's
supported installation and authentication instructions, then verify:

```powershell
agency --version
agency copilot
```

For direct mode, install and authenticate GitHub Copilot CLI, then verify
`copilot --help`. Select direct mode with `--runtime copilot` or
`FIXLAB_RUNTIME=copilot`.

FixLab does not install Agency or the standalone Copilot CLI, or manage sign-in.
Run `fixlab chat` after installation for guided onboarding and a dashboard
connection once the profile is ready.

### Fresh Windows dev box

Install only missing tools using your organization's approved software source.
First check any repository-pinned Node.js version; do not replace a working
NVM-managed runtime with another installation. When WinGet is permitted, these
commands install common prerequisites:

```powershell
winget install --id Git.Git --exact
winget install --id OpenJS.NodeJS.LTS --exact
winget install --id Microsoft.PowerShell --exact
winget install --id GitHub.Copilot --exact
```

Node.js includes npm; a separate npm installation is not normally needed.
Choose a Node release compatible with FixLab and the application rather than
assuming that the newest LTS meets the application's version pin. Follow
installer elevation prompts and organization policy; an Administrator terminal
is not a universal prerequisite for these commands.

Close and reopen the terminal after installation so it sees the updated `PATH`.
Open PowerShell 7 (`pwsh`), then verify the tools in that same shell:

```powershell
git --version
node --version
npm --version
pwsh --version
copilot --version
```

For direct Copilot mode, run `copilot` and complete the normal login flow with
the identity authorized by your organization. Copilot access and CLI enablement
must already be permitted by your enterprise. Follow the
[official Copilot CLI installation guide](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli)
for current supported installers and authentication steps. For Agency mode,
use the organization's Agency setup instead of installing an unnecessary
second runtime.

Install the [.NET SDK](https://learn.microsoft.com/en-us/dotnet/core/install/windows)
required by the application, not just the .NET runtime. Check `global.json`
and the projects' `TargetFramework` or `TargetFrameworks`; .NET 9 is not a
universal FixLab requirement. Verify SDK resolution from the application root:

```powershell
Set-Location C:\source\application
dotnet --list-sdks
dotnet --version
```

After installing FixLab, configure the real checkout layout before restoring
dependencies or installing Playwright. `fixlab init` copies an example profile;
it does not create an application, install its dependencies, or discover its
actual frontend directory. Edit these fields in
`.github\fixlab\repository-profile.json` as applicable:

| Field | Set it to |
| --- | --- |
| `applications.frontend.workingDirectory` | The existing frontend package directory, relative to the repository root |
| `applications.backend.workingDirectory` | The existing backend project directory |
| `browserAutomation.workingDirectory` | The existing package/test directory that owns the Playwright setup |
| `validation.commands` and `validation.gates[].workingDirectory` | The repository's actual commands and their working directories |
| `browserAutomation.testCommand` | The repository-owned browser or API test command |

Do not create an empty `frontend` folder or run a generic Playwright project
generator to make an example path pass. If Playwright is missing after the
paths are corrected, review `fixlab setup-playwright` before approving
`fixlab setup-playwright --yes`. This installs into the configured checkout,
not globally. Restore existing dependencies with the reviewed `fixlab prepare`
plan and complete any required private-feed sign-in first.

Default this guided browser-mode setup to Microsoft Edge with
`browserAutomation.browser: "chromium"` and `browserAutomation.channel: "msedge"`;
do not silently install or fall back to bundled Chromium. Review an alternative
only when required by the repository. API-only
profiles use `browserAutomation.mode: "api"` and do not install or launch a
browser. An explicit unit-test-only profile skips Playwright; do not disable
required live coverage merely to get a green Doctor result.

For an example-path error, see
[Playwright working directory is missing](troubleshooting.md#playwright-working-directory-is-missing).

### Enterprise-managed GitHub accounts

Some enterprise-managed accounts cannot access or work with repositories
outside their enterprise. A Copilot subscription does not override those
source-access or installation policies. Do not switch to a personal account
or bypass an organization restriction to install FixLab.

Ask the enterprise administrator or an approved maintainer for an authorized
internal mirror or a reviewed FixLab npm tarball produced with `npm pack`.
After verifying its approved source, version and integrity, install the supplied
artifact, for example:

```powershell
npm install --global "C:\approved-packages\fixlab-cli-<version>.tgz"
fixlab --help
```

Use the actual supplied filename in place of the example. FixLab is not
published to the public npm registry; `npm install --global @fixlab/cli` is
not an available distribution path. An internal mirror or registry must be
provisioned and approved by the organization, not assumed to exist.

A tarball is not a fully offline installer: npm still resolves FixLab's
dependencies unless an approved package source supplies them. Copilot
installation/sign-in, plugin loading, application feeds and Playwright
downloads have their own network and policy requirements. Use the approved
sources and normal authentication for each; do not embed credentials in
installation commands, profiles or redistributed packages.

## What installation changes

| Action | Machine or repository changes |
| --- | --- |
| `npm install --global github:microsoft/FixLab` | Installs FixLab, its dashboard/plugin/templates/docs, npm dependencies, and `fixlab` / `fixlab-mcp` launchers in the global npm prefix |
| SDK dependency | Includes the Copilot SDK's bundled dashboard runtime, not a standalone authenticated Copilot CLI or Agency installation |
| `fixlab init` | Adds missing profile, prompts, and custom agent under the application's `.github`; preserves existing files |
| `fixlab prepare --yes` | Executes configured restore commands; review the plan for their actual effects |
| `fixlab setup-playwright --yes` | Adds a missing project-local test dependency and installs the configured browser/channel; API-only mode installs no browser |
| `fixlab chat` / `fixlab dashboard` | Starts or connects to a local dashboard; jobs can create worktrees, evidence, and Git-private state |

Use `npm prefix --global` and `npm root --global` to locate the installation.
Installing FixLab alone does not install Git, Node.js, PowerShell, .NET, Agency,
the standalone Copilot CLI, application dependencies, or Playwright browsers.
It does not start an operating-system service or dashboard, register MCP, or
change application files. Optional setup commands require their own review.

Playwright browser binaries normally use a user cache; branded browser/channel
installers can change the machine's browser installation. Installing tools does
not grant authentication, write, deployment, or publication permission.

## Install directly from GitHub

The package installation is machine-wide; repository/worktree preparation is
separate. For another checkout of a configured repository, use plan-first
`fixlab onboard C:\path\to\worktree --from C:\path\to\application --runtime copilot`,
then add `--yes` after reviewing the source profile and declared files.
See [worktree preparation](repository-onboarding.md#preparing-another-worktree)
for scoped dependency grants and interactive authentication.

FixLab is not currently published to the public npm registry. Install the
public GitHub repository with npm:

```powershell
npm install --global github:microsoft/FixLab
fixlab --help
```

### Copy-paste installation prompt

Paste this into Copilot Chat in the application checkout instead of manually
executing the setup steps. It requests reviewed shell operations, not a slash
command or blanket permission grant.

```text
Set up FixLab for this checkout using --runtime copilot.
Use FIXLAB-SETUP.md if I supplied it. If unavailable, follow the complete
fallback steps below without requesting the file again.

1. Read repository instructions and git status. Preserve my branch, edits,
   running applications, and existing dashboards.
2. Check Git, supported Node/npm, PowerShell 7, the repository's .NET SDK
   when required, and the selected Copilot runtime. Report missing tools
   and ask before installing them.
3. Reuse an approved FixLab installation. If installation or an update is
   needed, propose this command and ask for approval before executing it:
   npm install --global github:microsoft/FixLab
   Verify fixlab --help afterward. Do not silently uninstall anything.
4. Inspect the real repository layout and existing profile. Propose the
   onboarding plan and profile/scaffolding changes. Do not assume the
   example frontend/backend directories exist.
5. After approval, create missing workspace files with fixlab init.
   Verify .github\agents\fixlab-autofix.agent.md exists. Configure actual
   paths, commands, ports, safe environments, and authentication intent.
   For required browser UI coverage, default to Microsoft Edge using
   browser: chromium and channel: msedge before approving browser setup.
6. Ask before restoring dependencies, installing Playwright, accessing
   private feeds, authenticating, or starting services. I will complete
   genuine sign-in and MFA myself. Keep npm/Yarn and NuGet feed access
   separate from application authentication. Review a dedicated persistent
   Edge profile, contained ignored state, and development-server exclusions.
7. Run fixlab doctor --runtime copilot. Report every remaining blocker.
   Register MCP only when dashboard coordination is requested and its
   configuration has been reviewed.
8. Start or reuse the matching dashboard only after readiness and my
   approval. Verify the exact repository, dashboard identity and
   authentication-status; do not start a job to make readiness green.

Do not modify application UI or business logic, start a bug job, copy browser state,
disable TLS, publish a PR, or grant blanket permissions.
```

The CLI, optional Copilot plugin/MCP connection, VS Code agent discovery,
browser setup, and application sign-in are separate. A successful package
installation is not evidence that the application is ready.

### Install and use in Visual Studio Code

FixLab uses its CLI and a repository custom agent; these steps do not require
a separate FixLab Marketplace extension or VSIX.

1. Install or enable GitHub Copilot in VS Code and sign in with an authorized
   account. Open the actual application clone with **File > Open Folder** and
   review Workspace Trust before enabling repository tools.
2. Open **Terminal > New Terminal** at the application repository root. Reuse
   an approved installation, or review and run:

```powershell
npm install --global github:microsoft/FixLab
fixlab --help
fixlab init
```

3. Review `.github\fixlab\repository-profile.json` and
   `.github\agents\fixlab-autofix.agent.md`. Initialization creates missing
   files and preserves existing ones; configure the real application paths
   and commands. Approve only the required setup, then run
   `fixlab doctor --runtime copilot` for CLI/dashboard readiness.
4. Open Copilot Chat and select **fixlab-autofix** from the agent selector.
   If it is missing, verify the file is in the open workspace, run
   **Developer: Reload Window**, and check workspace trust and agent visibility.
   Typing an `@` mention does not register a custom agent.
5. Start with a read-only readiness request:

```text
Read the FixLab profile and repository instructions.
Explain readiness and missing validation prerequisites.
Do not edit source, restore dependencies, start services, commit, push,
or create a pull request.
```

After readiness and authentication are proven, submit one bounded defect with
expected versus actual behavior. VS Code agent execution uses VS Code's own
tools and permissions; it does not automatically connect to a dashboard job.
CLI runtime sign-in, optional plugin installation, and MCP controls remain
separate. See the official
[VS Code custom-agent documentation](https://code.visualstudio.com/docs/agent-customization/custom-agents)
and the [FixLab agent reference](commands.md#visual-studio-code-bugfix-agent).

### Starting from an existing Copilot session

No separate terminal is required: Copilot can run installation/setup shell
commands after you approve them. Do not paste shell commands as though they
were Copilot slash commands; ask Copilot to execute them.

1. Open Copilot in the application checkout. Use `/login` if prompted to sign
   in, and `/cwd` to verify the selected repository. For long local validation,
   use `/keep-alive` when offered by your Copilot version; otherwise keep the
   machine awake until validation finishes. Manual sleep or closing the lid can
   still interrupt a run.
2. Ask Copilot to check Git, Node.js, npm, PowerShell, the repository's .NET SDK,
   and `copilot --help`. Review the findings before installing missing tools.
   Then ask it to run the following installation commands, approving each
   requested operation:

```powershell
npm install --global github:microsoft/FixLab
copilot plugin install microsoft/FixLab
fixlab --help
```

The agent plugin and executable CLI are separate installations. Plugin
installation does not run npm, add `fixlab` to `PATH`, restore application
dependencies, or authenticate the application. CLI installation does not start
the dashboard. Direct GitHub plugin installation currently emits a deprecation
warning; use the marketplace form only after FixLab is actually available
there, as described below.

3. Restart Copilot after plugin installation and select `/agent fixlab:fixlab`.
   If `fixlab` is not recognized, reopen Copilot so it receives the updated
   environment and follow [PATH troubleshooting](troubleshooting.md#fixlab-is-not-recognized).
4. Ask the agent to onboard this checkout using the
   [installation prompt](#copy-paste-installation-prompt). Review and approve
   proposed profile edits before allowing setup.

Generated profiles are examples, not automatic repository detection. Configure
the actual component paths, validation working directories and commands,
frontend startup, browser configuration and required authentication in
`.github\fixlab\repository-profile.json`. If Doctor points at a nonexistent
`frontend` directory, correct the profile; reinstalling FixLab will not fix it.
An existing application's HTTP 200 is not evidence that its UI/API flows or the
repository's required validation gates passed.

5. Complete sign-in/MFA yourself when the approved authentication flow opens.
   Return to Copilot to verify Doctor and ask it to start the dashboard for
   the same checkout. Plugin installation, profile approval, runtime tool
   authorization and application sign-in are separate steps.

For a background permission blocker, review an exact external folder only when
that is the confirmed missing access. A workflow approval does not transfer the
host session's permissions to a background executor. The adapter currently
uses `--allow-all-tools` only when the user explicitly chooses Allow all for that
run. Direct Copilot defaults to native dashboard permission review. Folder
approval does not make a broad flag acceptable to a policy that forbids blanket
tool authorization. Keep background jobs blocked
in that case rather than widening permissions or bypassing the policy.
Unknown tool or organization-policy denials also remain blocked;
see [permission troubleshooting](troubleshooting.md#a-validation-command-is-denied-before-execution).

Existing users normally update without uninstalling. Ask Copilot to run:

```powershell
npm install --global github:microsoft/FixLab
copilot plugin update fixlab
```

Restart Copilot afterward. A running dashboard still uses its loaded code:
review its active jobs and request a controlled restart separately. Do not
stop an existing app or dashboard merely because installation completed.
An unmerged PR is not included in a default-branch install; test its reviewed
CLI commit with `npm install --global "github:microsoft/FixLab#<reviewed-commit>"`.
The package version alone may not distinguish GitHub commits.

### Chat with an existing dashboard from Copilot

Keep the dashboard running. In Copilot CLI, open `/mcp` and add a local stdio
server using `fixlab-mcp` from the same updated FixLab installation. If it is
not on `PATH`, use command `node` with one argument: the absolute installed
`mcp/server.js` path (on Windows, for example
`C:\tools\fixlab\node_modules\@fixlab\cli\mcp\server.js`).
Do not point it at a different preview version accidentally. This registers
the bridge; it does not launch another dashboard or agent job.

Ask Copilot to call `fixlab_dashboard_status` with your explicit repository
path and dashboard port, then show any pending question using its question
UI. After your answer, it calls `fixlab_dashboard_reply` with `confirmed:
true`, the returned `instanceId` and `jobId`, your selected action and details.
Conflicts require reading status again rather than retrying an old answer.
Replies continue the same dashboard-owned job, not a replacement job.

`fixlab_dashboard_control` exposes the existing dashboard operations through
that same identity-bound connection. Your explicit request authorizes routine
steps; Copilot should not ask again for every command. Missing decisions,
folder grants, sign-in/MFA, unsafe-data approvals and deployment approvals
still require their normal review. See the
[operation reference](commands.md#copilot-dashboard-control).

You can ask: "FixLab, test this PR using the configured Playwright settings;
do not change code." Copilot must first verify the assigned checkout matches
the PR source commit, then use `job-start` with `mode: "playwright-only"`,
the request and selected environment. This uses the repository's configured
browser journey and authentication instead of guessing an E2E command or
running full regression. It must not label mock results as live backend
validation. If the checkout or required authenticated session is missing, it
reports that exact prerequisite rather than testing an unrelated branch.

For a workspace blocker, review `git status` and the effective diff first.
Explicitly approving reuse sends the reviewed branch and fingerprint; FixLab
rechecks them under its executor lease and keeps the current branch, existing
PR and uncommitted work. Only the configured user's FixLab job branches are
eligible. No reset, stash, base refresh or branch switch is performed.

Choose `validationIntent: "scoped"` to run only affected tests during
iteration. Full regression stays explicitly deferred and PR readiness blocked.
Choose `"full"` later to run the required gates; this does not mark any gate
passed by itself. Independent safe checks can proceed after unrelated
failures, without bypassing their own prerequisites.
For repositories with a reviewed
[API-only validation policy](commands.md#api-only-validation), choose
`"affected"` for change-aware required gates. `"full"` still runs all configured
checks; installing a newer CLI does not enable exclusions in an old profile or
retroactively waive an existing job's failed frontend checks.

The bridge uses loopback HTTP only, bounded responses and a ten-second
deadline. It does not expose raw logs or browser state, grant blanket folder/tool
permissions, complete sign-in, or approve unsafe data access. Permission
questions include the current request identifier and reviewed folder. Use the
existing scoped review and approval operations, or review them in the dashboard;
ordinary conversation replies cannot grant permissions.
It is request/response, not background injection into an idle Copilot chat:
ask for status when you want progress or have Copilot check at workflow
boundaries. A separate background dashboard cannot create native prompts in
an unconnected conversation.

### Change-only Copilot notifications

For a Copilot CLI version supporting extensions and the `joinSession` SDK,
FixLab can monitor one job without a scheduled Copilot polling loop:

```powershell
fixlab notifications C:\source\application
fixlab notifications C:\source\application --yes
```

The first command only prints the installation plan. `--yes` installs trusted
local extension code under the repository's `.github/extensions` directory.
It does not start a dashboard, watcher or model turn. The loader references the
current FixLab installation: keep it untracked, keep that installation present,
and review any existing extension before replacing it. Nested repository paths
resolve to the Git root; linked extension paths and overwrites are rejected.

Reload Copilot extensions, then ask Copilot to read `fixlab_dashboard_status`
and start `fixlab_watch_start` with its exact repository, port, `instanceId`
and `jobId`. Explicitly consent to event-triggered Copilot turns; the tool's
`confirmed: true` must represent that consent. The existing MCP bridge remains
the path for answering blockers and controlling the job.

The extension polls the compact loopback status every ten seconds using local
Node.js code, with no AI call for unchanged status. A new actionable blocker,
completion or stopped watch queues one Copilot message. These event-triggered
turns still consume tokens. Repeated identical blockers do not create repeated
turns; permission request nonces distinguish new permission reviews. Copilot
reads fresh state and asks through the host's question UI, never treating an
event as approval.

Use `fixlab_watch_status` to refresh the exact watched job and
`fixlab_watch_stop` to stop notifications without stopping the job. Monitoring
ends after completion, hold/cancellation, a changed instance/current job, three
consecutive status-read failures, or ambiguous host-delivery failure. It never
automatically attaches another job or retries an ambiguously delivered prompt.
Closing/replacing the Copilot session loses its in-memory watch; reconnect and
consent again. Polling can miss short-lived states; a replacement-job event
does not claim that the old job succeeded.

This extension does not install a permanent operating-system service, run
outside the connected Copilot session, read raw logs/browser state, or grant
runtime, authentication, publication or deployment permissions. Older
dashboards that mark scoped success blocked retain that limitation; a
notification does not turn their deferred gates into passes.

### Intelligent Windows bootstrap

An npm-based installer cannot recover when the shell resolves a damaged or
mismatched Node/npm pair. From a FixLab clone, use the plan-first PowerShell
bootstrap to locate NVM for Windows and select a coherent runtime:

```powershell
pwsh -File scripts/install-fixlab.ps1 -Repository C:\path\to\application
pwsh -File scripts/install-fixlab.ps1 -Repository C:\path\to\application -Yes
```

The bootstrap:

- Discovers NVM through `NVM_HOME`, the standard roaming/local directories,
  and NVM's `settings.txt`.
- Reads an exact Node version from `-NodeVersion`, `.nvmrc`,
  `.node-version`, exact `package.json` `engines.node`, or the repository
  profile's optional `toolchain.nodeVersion`.
- Requires `node.exe` and `npm.cmd` from the same NVM version directory.
- Runs an offline `npm pack --dry-run` probe before selecting a runtime.
- Uses the selected `npm.cmd` by absolute path instead of changing the
  machine's permanent `PATH`.
- Verifies the installed `fixlab.cmd`.

The default command only prints the plan. `-Yes` approves changes. If the exact
Node version is absent, both `-InstallNode` and `-Yes` are required before the
bootstrap invokes `nvm install`; it verifies the runtime files afterward and
fails if NVM reports success without installing them.

```powershell
pwsh -File scripts/install-fixlab.ps1 `
  -Repository C:\path\to\application `
  -NodeVersion 22.23.3 `
  -InstallNode `
  -Yes
```

The bootstrap never uninstalls or repairs NVM, silently replaces Node, or
modifies the system `PATH`.

### Repair an incoherent Node runtime

If NVM reports an exact version but the version directory launches another
Node release, or npm is absent or internally inconsistent, use the plan-first
portable repair:

```powershell
pwsh -File scripts/repair-node-runtime.ps1 `
  -Repository C:\path\to\application

pwsh -File scripts/repair-node-runtime.ps1 `
  -Repository C:\path\to\application `
  -Yes
```

The repair script:

- Reads the exact Node version from the repository profile, `.nvmrc`,
  `.node-version`, or exact `package.json` `engines.node`.
- Downloads the official Windows archive and `SHASUMS256.txt` only from
  `nodejs.org`.
- Verifies the archive SHA-256 checksum before extraction.
- Validates the extracted `node.exe` version and npm CLI.
- Marks the portable root as FixLab-owned and refuses to replace an existing
  runtime in an unowned directory.
- Replaces only the exact FixLab-owned portable runtime directory after
  checksum and runtime validation.
- Does not uninstall NVM, change the permanent `PATH`, or modify the system
  Node installation.

Use the printed temporary `PATH` command in the current PowerShell session,
then rerun `fixlab doctor`, `fixlab prepare`, or `fixlab authenticate`.

This installs the CLI, dashboard assets, and packaged FixLab plugin. The
selected runtime remains a separate prerequisite.

Direct GitHub repository plugin installation is supported for development and
pre-release verification:

```powershell
copilot plugin install microsoft/FixLab
```

GitHub Copilot CLI warns that direct repository plugin installs are deprecated.
FixLab is not yet listed in the official marketplace. After its separate
marketplace pull request is reviewed and merged, use the stable marketplace
form:

```powershell
copilot plugin install fixlab@copilot-plugins
```

The installed custom agent is selected as `fixlab:fixlab`.

After `fixlab init` and profile configuration, review and run the target
repository's own dependency restore commands:

```powershell
fixlab prepare
fixlab prepare --yes
```

`fixlab prepare` executes only the configured `frontendRestore` and
`backendRestore` commands, and only after `--yes`. This keeps a fresh
installation reproducible without hard-coding npm or .NET assumptions into
FixLab.

Authenticate to repository-owned private package feeds before approving the
plan. Use the organization's supported credential provider (for example, the
Azure Artifacts **Connect to feed** instructions for local development or
`npmAuthenticate` in Azure Pipelines). Credentials belong in the developer or
runner credential store, never in the repository profile or a committed
`.npmrc`.

FixLab can inspect the repository profile and prepare the repository-local
Playwright installation commands:

```powershell
fixlab setup-playwright
```

This first prints the detected package manager and exact commands without
changing the repository. Review them, then approve execution:

```powershell
fixlab setup-playwright --yes
```

The command:

- Detects npm, pnpm, or Yarn from the repository lock file
- Installs the configured Playwright package as a development dependency when
  it is missing
- Installs the configured browser or browser channel
- Performs a real headless launch to verify the installation
- Stops with an explicit failure if installation or verification fails

You can also install Playwright manually. For example:

```powershell
Set-Location <application-repository>\frontend
npm install --save-dev @playwright/test
npx playwright install chromium
```

Use the package and browser required by the application repository. Playwright
and its browser binaries remain on the developer or registered runner machine.
FixLab never installs them silently; `--yes` is required before setup commands
are executed.

## Install from a Git checkout

Clone the FixLab repository and install its CLI globally:

```powershell
git clone <fixlab-repository-url>
Set-Location FixLab
npm install --global .
fixlab --help
```

This installs the `fixlab` command. The CLI retains the packaged Agency plugin
and launches it through the existing `agency` executable.

## Onboard an application repository

Open the React and .NET application repository, then create its FixLab profile:

```powershell
Set-Location <application-repository>
fixlab init
```

Edit:

```text
.github\fixlab\repository-profile.json
```

Open the file in your editor:

```powershell
code .github\fixlab\repository-profile.json
```

Use the [current profile template](../templates/repository-profile.json), not a
second copy of its JSON. Replace example component paths, restore/validation
commands, startup commands, ports, environments, PR target, and developer alias.
Paths are repository-relative; commands must run non-interactively.
If browser authentication is required, set
`authentication.required` to `true` and configure the repository-owned login
command and status paths as described below.

Save the file, then validate both the machine and profile with the selected
runtime:

```powershell
fixlab doctor --runtime agency
```

Resolve every `FAIL` before running a job. Never add credentials, tokens,
cookies, browser-state contents, private endpoints, customer records, or
sensitive test data to the profile.

### Upgrade an existing repository profile

`fixlab init` preserves an existing profile and never overwrites repository
policy. After updating FixLab, run:

```powershell
fixlab init
fixlab doctor --runtime copilot
```

The first command reports fields that require a manual profile upgrade. The
doctor command validates the resulting profile before the dashboard starts.

Profiles created before test synthesis became required must add an explicit
policy. Use the repository's actual data-safety model rather than copying an
environment choice blindly:

```json
{
  "browserAutomation": {
    "testSynthesis": {
      "enabled": true,
      "defaultDataSource": "synthetic-intercepted",
      "mutationMode": "intercepted",
      "requireScenarioEvidence": true
    }
  }
}
```

Use `synthetic-intercepted` when reads and writes should remain local. A
repository that intentionally reads approved DEV or SIT data can use
`non-production-read-only`; retain `intercepted` unless external writes have a
separately reviewed approval policy.

New profiles created by CLI or dashboard onboarding additionally set
`browserAutomation.testSynthesis.devReadOnly: true` and `ppeReadOnly: true`.
This permits real read-only portal queries when DEV/development or PPE is explicitly selected, with
mutations still intercepted; other environments keep the configured default.
Existing profiles and browser/auth guards are not silently rewritten. Opting
an existing profile in requires reviewing its DEV/PPE read configuration and
starting a fresh job; set the corresponding flag to false to retain synthetic data.
Installation/onboarding configures repository adapters for all verified read-only
queries on reviewed DEV/PPE HTTPS API origins, including read-only POST searches,
not only one feature's endpoints. Verification uses the query contract,
implementation and payload; this never admits arbitrary POST writes.
Authentication/proof remains identity-only unless the validation helper explicitly
opts into the reviewed query scope. Keep business writes separately authorized.

## Check the machine and repository

Run:

```powershell
fixlab doctor
```

The command checks:

- Git
- Node.js
- The frontend package manager configured by `frontendRestore`, including a
  successful `npm`, `pnpm`, or Yarn version check
- The .NET SDK selected by the target repository, including any
  `global.json` requirement
- PowerShell
- The selected Agency or GitHub Copilot CLI runtime
- Repository-local Playwright package
- A successful headless launch of the configured Playwright browser
- The FixLab repository profile
- Git repository initialization

Resolve every failed prerequisite before starting a FixLab session.
The .NET check runs `dotnet --version` from the target repository so the normal
SDK resolver validates `global.json`, rather than accepting an unrelated SDK
installed elsewhere on the machine.

If Doctor reports that the frontend package manager cannot start, run the
reported version command in the same shell:

```powershell
node --version
npm --version
npm pack --dry-run --ignore-scripts --json
where.exe node
where.exe npm
```

`npm --version` alone is insufficient because a damaged npm installation can
print its version while operational commands fail internally. Node.js and npm
must resolve from one compatible, internally consistent installation. NVM
users should activate the intended version before retrying. FixLab also repeats
this preflight immediately before an approved `fixlab prepare --yes` and stops
before dependency restoration when the package manager is broken.

A package manager that starts successfully can still fail restore with `E401`
or `E403` when the repository uses a private feed. Authenticate with the
repository owner's supported credential provider, then rerun preparation.
FixLab does not create, copy, or persist private-feed credentials.

For a long local batch, run `/keep-alive` in GitHub Copilot CLI before starting
the job, or start a bounded FixLab timer:

```powershell
fixlab keep-awake --minutes 180
fixlab dashboard C:\source\application --keep-awake-minutes 180
```

The FixLab timer prevents system sleep without changing permanent power-plan
settings and releases when the duration ends or the owning process stops.
Locking the screen does not stop ordinary commands, but hibernation, process
termination, and network loss can interrupt a local runner. Interactive browser
or authentication steps may still require an unlocked desktop.

The repository profile controls the Playwright check:

```json
{
  "browserAutomation": {
    "workingDirectory": "frontend",
    "package": "@playwright/test",
    "browser": "chromium",
    "channel": "msedge",
    "authentication": {
      "command": "npm run test:e2e:auth",
      "environment": {
        "E2E_START": "npm start"
      },
      "statusPaths": [
        "e2e/.auth/user.json"
      ]
    }
  }
}
```

`browser` selects the Playwright browser API; `"chromium"` does not by itself
mean Microsoft Edge. Set `"channel": "msedge"` to launch Edge, the default for
this reviewed setup guide. Omit the channel only for an explicitly reviewed
repository requirement to use bundled Chromium, not as a silent fallback.

The optional `authentication` block enables the dashboard's **Check status**
and **Connect Playwright** controls. `statusPaths` are checked for existence
only; FixLab never reads or returns their browser-state contents.

## Run FixLab

Start chat from an onboarded repository:

```powershell
fixlab chat
fixlab chat --runtime copilot
```

When the current directory is not an onboarded repository, chat asks for the
repository path. It can also be supplied directly:

```powershell
fixlab chat C:\source\application
```

Use `fixlab dashboard` to start the local UI server without opening a browser:

```powershell
fixlab dashboard
fixlab dashboard --runtime copilot
```

Open the printed URL manually, request `open dashboard` in terminal chat, or
opt in explicitly with `fixlab dashboard --open`. Onboarding and dashboard
reconnections do not automatically open another tab.

It binds only to `127.0.0.1` and uses port `4317` by default. Browser opening
requires explicit opt-in. Select another repository or port:

```powershell
fixlab dashboard C:\source\application --port 4318 --no-open
```

The dashboard requires `.github\fixlab\repository-profile.json` before a job
can start. It permits one local job at a time and invokes the packaged
`fixlab:fixlab` plugin with the selected repository as its working directory.

Start an interactive FixLab session:

```powershell
fixlab run
```

Start with a specific request:

```powershell
fixlab run . -- "Reproduce the reported defect and validate the smallest safe fix."
```

Validate a pull request without changing it:

```powershell
fixlab validate --pr 123
```

Agency mode launches:

```powershell
agency copilot --plugin-dir <installed-fixlab-package> --agent fixlab:fixlab
```

Direct mode launches:

```powershell
copilot --plugin-dir <installed-fixlab-package> --agent fixlab:fixlab
```

The dashboard uses the same plugin resolution and streams long prompts through
standard input. Closing it terminates only its tracked runtime and Playwright
authentication handles; it does not terminate unrelated repository, browser,
or developer processes.

## Run the plugin without installing the CLI

From a FixLab checkout:

```powershell
agency copilot --plugin-dir . --agent fixlab:fixlab
copilot --plugin-dir . --agent fixlab:fixlab
```

## Update or uninstall

From a newer checkout:

```powershell
npm install --global .
```

To remove the CLI:

```powershell
npm uninstall --global @fixlab/cli
```

FixLab does not remove Agency, GitHub Copilot CLI, repository profiles,
worktrees, evidence, or application dependencies when the CLI is uninstalled.
