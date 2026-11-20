# FixLab setup with Copilot: feeds, Microsoft Edge, and corporate SSO

Use this guide to set up a React and .NET repository with FixLab and the
Copilot runtime. Inspect the actual checkout, show the plan, and ask before
applying setup changes. Complete genuine sign-in/MFA yourself.

This guide is not an installer or blanket permission grant. Do not start a
bug-fixing job, commit, push, publish packages, or create a pull request.

## Option 1: paste one prompt

Open Copilot in the target checkout and paste:

```text
Onboard the actual repository with --runtime copilot. Follow:
https://github.com/microsoft/FixLab/blob/main/docs/FIXLAB-SETUP.md
If unavailable, use the manual installation guide:
https://github.com/microsoft/FixLab/blob/main/docs/installation.md
Inspect first, show the plan, and ask before changes or when details are missing.
Reuse compatible installed tools and preserve application code and edits.
Resolve npm/Yarn and NuGet feed authentication separately using approved
repository helpers and genuine human sign-in. Use Microsoft Edge by default
for required browser validation, not bundled Chromium. For corporate SSO,
use a dedicated persistent Edge profile, not a private context or my normal
browser profile. Keep authentication state ignored, inside the browser
working directory, excluded from development-server watching, and denied
by its file server. Verify genuine authentication proof, Doctor, and the
dashboard authentication-status endpoint. Ask before starting or reusing
the matching idle dashboard and do not start a job.
```

## Option 2: give Copilot this Markdown file

Copy this file into the target checkout root without overwriting an existing
guide. Alternatively, attach it or provide its actual path, then say:

```text
Read @FIXLAB-SETUP.md and set up FixLab for this repository.
Show the plan and ask before applying changes.
```

## If the guide is unavailable

The file is optional. Follow FixLab's
[first-installation steps](https://github.com/microsoft/FixLab/blob/main/installation.md)
or [detailed manual setup](https://github.com/microsoft/FixLab/blob/main/docs/installation.md#recommended-path-install-then-run).
Do not substitute an unrelated application's installation guide or repeatedly
request a missing attachment. Keep the same review and authentication safeguards.

## Instructions for Copilot

### 1. Inspect and agree on the plan

- Read contributor instructions and inspect `git status --short`.
- Confirm the repository root, actual frontend/backend/test directories,
  application commands, environment, health URLs, and ports.
- Agree on a free dashboard port. Reuse a verified matching instance when
  appropriate; do not stop unrelated services.
- Inspect version pins, package manifests, lockfiles, dependency junctions,
  existing FixLab files, and installed tools.
- Check Git, supported Node/npm, PowerShell on Windows, the authenticated
  Copilot runtime, and the SDK selected by `global.json` when applicable.
- Run `dotnet --version` from the checkout when .NET is required; listing
  installed SDKs alone does not prove that the repository's SDK can resolve.
- Install a missing compatible SDK alongside existing SDKs after approval.
  Do not rewrite `global.json` or replace a working Node installation merely
  to match a tool's test environment.
- Match the repository's package manager. A Yarn Classic lockfile is not
  permission to switch to npm, drop resolutions, or generate another lockfile.

Use confirmed values for `$Repo`, `$Frontend`, `$BackendProject`, and
`$DashboardPort`. They are not example directories to create.

Review separate scopes before applying them: machine tools/MCP, repository
scaffolding/profile, dependency restores, feed credential refresh, Playwright,
authentication helpers/private state, development-server exclusions, and
dashboard startup.

### 2. Install or reuse FixLab and connect MCP

Inspect `Get-Command fixlab` and `fixlab --help`. Reuse a compatible approved
installation. If absent, request approval before:

```powershell
npm install --global github:microsoft/FixLab
fixlab --help
```

Use an organization-approved distribution when public GitHub access is
restricted. Never disable TLS verification or change feed endpoints to get
around an installation failure.

Inspect `copilot mcp get fixlab`. Reuse a correct registration; otherwise,
review and approve:

```powershell
$FixLabMcp = Join-Path (npm root --global) '@fixlab\cli\mcp\server.js'
if (-not (Test-Path -LiteralPath $FixLabMcp -PathType Leaf)) {
    throw 'FixLab MCP server is missing; verify the approved installation.'
}
copilot mcp add fixlab -- node $FixLabMcp
copilot mcp get fixlab
```

Check `/mcp`; reopen the Copilot session if needed. Registration does not
grant tool permissions, start the dashboard, or authenticate the application.
If npm reports a blocked package install script, verify the affected feature.
Do not globally enable all scripts; review a narrowly scoped remedy only if
a required operation actually fails.

### 3. Approve scaffolding before first-run onboarding

**Important:** first-run `onboard` can create the profile, agent, and prompts
even without `--yes`. Do not describe that first run as read-only.

Before running it, inspect existing files and show the proposed scaffolding
under `.github\fixlab`, `.github\agents`, and `.github\prompts`. Get approval
for creating missing files, then run:

```powershell
fixlab onboard $Repo --runtime copilot
```

Inspect the generated profile before proceeding. Replace example paths,
commands, branch names, ports, and authentication defaults with verified
repository values. Do not create empty `frontend` or `backend` directories.

Default to Microsoft Edge for a new browser UI setup. Before approving a
restore/browser-install plan, merge `"browser": "chromium"` and
`"channel": "msedge"` into `browserAutomation`. The first value selects the
Playwright engine; the channel launches installed Edge, not bundled Chromium.
Do not overwrite a repository's explicitly approved alternative without review.
API-only and explicitly unit-only profiles do not need a browser.

Preserve required tests and validation gates. Check the actual test script
before adding arguments: do not combine Jest's `--runInBand` with an existing
`--maxWorkers` option. Do not invent a `type-check` or `test:e2e` script.

Review restore commands and their working directories. After approving the
actual restore and browser-install plan:

```powershell
fixlab onboard $Repo --yes --runtime copilot
```

`--yes` can execute setup commands; it is not just approval to save a profile.
If the plan includes an unapproved action, do not run it.

### 4. Restore dependencies and handle feed authentication

Treat these as three independent authentication surfaces:

| Surface | What successful authentication proves |
| --- | --- |
| npm/Yarn private feed | Access to frontend packages |
| NuGet private feed | Access to .NET packages |
| Application/browser SSO | Access to the signed-in application |

Neither feed authentication nor `az login` proves browser sign-in.

#### npm or Yarn: 401 Unauthorized

Identify the failing feed from the package-manager error, `.npmrc` source
settings, and lockfile URLs. Report only a sanitized feed description; redact
private organization, project, feed identifiers, credentials, and URL parameters.
Do not print `.npmrc` credentials or tokens.

Search package scripts and repository instructions for an existing approved
authentication helper. If it uses `vsts-npm-auth` and that command is missing,
review and request approval before:

```powershell
npm install --global vsts-npm-auth
```

For a repository that actually defines `refresh:pat`, run its reviewed helper
from the frontend directory after approving credential refresh:

```powershell
Set-Location -LiteralPath $Frontend
npm run refresh:pat
```

The user completes any required sign-in. Do not invent that script for other
repositories or replace their approved authentication mechanism.

Verify access by retrying the original lockfile-respecting restore, for example
`yarn install --frozen-lockfile` for an applicable Yarn Classic repository.
A helper exit code alone is not proof of package access.

Do not change private URLs to public npm, delete lockfiles, use
`--ignore-engines` to hide incompatibility, or run destructive clean/refresh
scripts as an authentication workaround.

#### NuGet: 401, NU1301, or interactive authentication required

`NU1301` can also mean connectivity or TLS failure. Check the underlying
response before treating it as a credential problem.

Inspect the actual NuGet source configuration without displaying credentials.
Reuse the existing approved Azure Artifacts Credential Provider when present.
After approving interactive feed authentication:

```powershell
dotnet restore $BackendProject --interactive
```

The user completes the provider's normal sign-in. Retry the ordinary approved
restore afterward to verify access.

If the credential provider is missing, review its
[official installation instructions](https://github.com/microsoft/artifacts-credprovider)
and ask before installing:

- The documented `dotnet tool` installation method requires SDK 9.0.200 or later.
- For a .NET 8 setup, use the documented compatible NuGet plugin installation
  path instead of upgrading the application's SDK just to install the tool.
- Review downloaded installation scripts before execution; do not blindly pipe
  internet content into a shell.

Keep tokens in the approved user credential store/cache, not committed
`NuGet.Config`, scripts, profiles, or logs. Never turn off TLS checks, remove
private sources, clear all caches, or repeatedly retry unchanged credentials.
If access is denied after valid sign-in, report the permission requirement.

### 5. Prepare Playwright with Microsoft Edge by default

Follow the profile: browser UI, API-only, and explicitly unit-only validation
have different requirements. Do not disable required live coverage to pass
Doctor, or add a browser to an API-only setup.

For browser UI validation, confirm the reviewed profile selects Edge:

```json
{
  "browser": "chromium",
  "channel": "msedge"
}
```

These are fields inside `browserAutomation`, not a complete profile.
Prefer a compatible installed Edge channel. If Edge is unavailable, report the
missing prerequisite and ask before installing it or choosing an approved
alternative. Do not silently fall back to bundled Chromium.

Review:

```powershell
fixlab setup-playwright $Repo
```

For a browser profile, this may propose adding `@playwright/test` to the actual
project and installing the configured channel. Explain manifest/lockfile and
machine changes. After approval:

```powershell
fixlab setup-playwright $Repo --yes
```

Verify an actual Edge launch, not merely the package version or executable
path. Do not install through an unreviewed shared `node_modules` junction.

### Reuse an existing dedicated runner setup

When the user chooses sequential jobs in one configured checkout, review
`fixlab onboard ACTUAL_RUNNER_DIRECTORY --reuse-setup --runtime copilot`.
After approval add `--yes`. Preserve existing frontend/authentication commands
and browser state in place; do not copy credentials into new branch folders.
Review the profile's actual remote, base branch and branch prefix first.
The option enables shared mode, preserves installed dependencies and verifies
Playwright/configuration without unconditional restore. Branch-specific tests
must still detect changed or missing dependencies.

For an existing session, add `--authenticate` to run the repository's fresh
`proofCommand` instead of redoing login when configured state is present.
Failed proof remains a real blocker; human authentication is not bypassed.
Ignored local commit-bound profiles can follow owned branch acquisition;
tracked templates remain unchanged. See [shared setup](repository-onboarding.md#reusing-one-checkout-for-sequential-jobs).

Before calling setup reusable, inventory the actual guard's required read-only
bootstrap API calls, local assets, fonts and Microsoft identity resources.
Repair narrowly through reviewed `fixlab setup-queries` and focused offline
tests. Keep one shared policy, HTTP/transport failures and write restrictions;
do not make each journey rediscover the same missing resources.

### 6. Put private browser state in a valid, protected location

FixLab dashboard authentication `statusPaths` must resolve **inside**
`browserAutomation.workingDirectory`. A path that escapes that directory with
`..` can pass CLI checks yet fail the dashboard's authentication-status check.
Do not bypass containment with symlinks.

For a browser working directory equal to the frontend directory, a suitable
layout is:

```text
ACTUAL_FRONTEND_DIRECTORY\
  .fixlab-local\
    auth-local.json
    edge-profile\
```

`ACTUAL_FRONTEND_DIRECTORY` means the existing application directory.
Keep repository-owned helper code under `.github\fixlab` if desired; the
helper's code location does not determine where credentials belong.

Before writing or moving any state:

- Add a repository ignore rule for the actual frontend's `.fixlab-local`
  directory and verify both file and profile paths with `git check-ignore`.
- Exclude this directory from development-server watching. Edge databases are
  locked while the browser is running; watching them can crash Vite with
  `EBUSY`.
- Explicitly deny serving the directory over HTTP. Git ignore alone is not a
  web-server access control.
- Keep state outside the public directory and every other static-asset or
  build-output directory. Vite's `server.fs.deny` does not protect `publicDir`.
- Preserve existing development-server settings and default deny patterns.

For Vite, review and approve merging this into the existing `server` options:

```typescript
watch: {
  ignored: ['**/.fixlab-local/**']
},
fs: {
  deny: [
    '.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}',
    '.npmrc', '.yarnrc.yml', '**/.git/**', '**/.fixlab-local/**'
  ]
}
```

These are example patterns, not a replacement for the installed version's
defaults or additional custom rules. Preserve all required defaults and review
equivalent exclusions for a different development server. Check alternate
asset/plugin paths too; a deny rule for one URL is not proof that another route
cannot expose the same file.

Verify that requests for the auth state and profile files return HTTP 403
without printing their contents, and that Vite remains responsive while the
browser profile is in use.

Merge real authentication commands and these relative paths into the profile:

```json
{
  "required": true,
  "statusPaths": [
    ".fixlab-local\\auth-local.json",
    ".fixlab-local\\edge-profile"
  ]
}
```

This is the `browserAutomation.authentication` fragment, not a complete
configuration. Real repository-owned `command` and `proofCommand` are also
required, along with a real `browserAutomation.testCommand`.

If relocating state within the same checkout, get approval, close its owned
browser, verify source and destination ignore rules before moving, update
helper paths, and rerun fresh proof. Do not read or print state contents.
Never copy another checkout's state or a user's normal browser profile.

### 7. Use genuine corporate Edge SSO, not a private context

A normal signed-in Edge window loading the application does not establish
authentication in a separate automation context.

For organization-managed Edge SSO, a fresh `browser.newContext()` is private
and may not carry the browser/device identity needed by the organization.
Use an approved, dedicated persistent profile for this checkout instead.
Let the user sign into that browser profile and application normally.

Repository-owned helper code can use this launch pattern:

```javascript
const context = await chromium.launchPersistentContext(profileDirectory, {
  channel: 'msedge',
  headless: false,
  args: ['--enable-automation'],
  ignoreDefaultArgs: [
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages'
  ],
  viewport: { width: 1440, height: 900 },
  serviceWorkers: 'block'
});
```

`profileDirectory` must be the approved dedicated path described above.
Resolve Playwright from the configured browser project's dependencies, not
from an unrelated global installation. Integrate this into a real helper;
the snippet is not a complete authentication implementation.

Keep the automation indicator visible. Explicit `--enable-automation` also
allows a launch-settings check through CDP `Browser.getBrowserCommandLine`;
do not assume every Playwright version adds the flag automatically.
Removing the two extension-disabling flags makes normal managed authentication
components available; it does not guarantee tenant-policy compatibility.
Do not weaken security policy, hide automation, or disable tenant controls.

Keep proof headed too when required by the organization's browser SSO flow.
Only one process may own the dedicated profile at a time. Close it in `finally`
and track its directory in `statusPaths` for ownership checks.

#### ERR_BLOCKED_BY_CLIENT on Microsoft certificate authentication

If the helper has a request guard, check whether it blocked a legitimate
Microsoft identity endpoint before blaming browser installation.

Certificate authentication can use `certauth.login.microsoftonline.com` and
tenant subdomains beneath it. After reviewing the required authentication
flow, permit those endpoints over HTTPS narrowly. Match the exact hostname or
a hostname ending in `.certauth.login.microsoftonline.com`, not any string
containing that text. Do not allow arbitrary Microsoft domains or business
POST requests.

Retain request guards, mutation controls, and production restrictions. Test
both the required identity endpoint and lookalike domains that must remain
blocked.

#### "No certificate detected"

After the identity endpoint is reachable, this is a genuine sign-in requirement,
not proof that Playwright is missing. A dedicated persistent, normally signed-in
Edge profile may satisfy the required browser/device identity.

If Microsoft offers another organization-permitted sign-in method, the user
may choose it. If a certificate is mandatory and unavailable, stop and report
the requirement. Do not export certificates/private keys, copy a personal
profile, change Conditional Access, or manufacture a successful result.

Microsoft documents Edge browser sign-in and private-mode limitations in its
[Conditional Access browser guidance](https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-conditional-access-conditions#supported-browsers).

### 8. Prove real authentication and distinguish its coverage

Review the actual helper, selected environment, state paths, sign-in command,
and proof command before:

```powershell
fixlab authenticate $Repo
# Only after approval of the real authentication plan:
fixlab authenticate $Repo --yes
```

The helper must:

- Use the exact approved origin and environment; reject an unconfigured SIT
  target instead of silently falling back to local.
- Let the user complete genuine browser sign-in/MFA. Identify and foreground
  only the helper-owned window when needed, never another Edge window.
- Capture genuine state locally without logging credentials.
- Handle the application's real cache. Playwright `storageState` alone does
  not preserve MSAL `sessionStorage`; save and restore that state locally for
  the exact approved origin when needed.
- Reopen the dedicated browser and assert an actual signed-in condition plus
  fresh legitimate identity proof using the application's existing scopes.
- Fail for missing/invalid state or an unsuccessful live identity check.
- Close owned browser resources and remove temporary diagnostics.

Run the reviewed `proofCommand` and focused browser test from the configured
working directory with the selected environment.

A helper exit, state-file existence, Doctor PASS, or normal Edge SSO is not a
substitute for fresh proof. A signed-in app-shell check with business APIs
blocked proves identity/shell behavior only, not backend integration or a
business scenario. Keep any required integration gates unresolved until
actually validated.

Do not retain generated validation-only authenticated spec files in product
changes unless permanent coverage was explicitly requested.

Portal journeys default to unmasked full-page screenshots (`fullPage: true`),
with close-ups only as supplements. Include this capture in the reviewed journey
or a job-owned transient wrapper; do not ask a separate screenshot-scope question
for the default. Preserve existing tests, guards and shared configuration.
Explicit privacy policy and genuinely sensitive content still require protection;
never capture credentials, sign-in/MFA screens or private/customer data. Keep
evidence local unless sharing is separately authorized. Native permissions and
human authentication remain separate approvals. Existing stricter repository
policies are not silently changed by installing FixLab.

### 9. Verify Doctor and a stable, matching dashboard

```powershell
fixlab doctor $Repo --runtime copilot
```

Inspect real startup commands and health URLs independently. Doctor does not
prove that a blank/unverified backend startup, missing health endpoint, or
unconfigured SIT target is ready.

Request approval before starting the idle dashboard. Stop temporary
setup-owned servers if the dashboard should manage their lifecycle; leave
unrelated services alone.

```powershell
fixlab dashboard $Repo --port $DashboardPort --no-open --runtime copilot
```

Reuse a verified matching dashboard instead of starting a duplicate. If a
job already exists, preserve it and do not assume the dashboard is idle.

If the dashboard must remain available after the Copilot turn, start it using
the host's supported persistent/background mechanism. A launcher printing a URL
is not proof that the server remained running.

Verify all of these:

- Dashboard UI returns HTTP 200.
- `fixlab_dashboard_status` reports the exact repository and expected port.
- Record its actual instance ID and confirm no job was started by setup.
- Use the actual port/repository/instance/job supplied in executor context, not
  the default port or an older dashboard. Read fresh status before mutations.
- Read `fixlab_dashboard_control` operation `authentication-status`, bound to
  that instance ID and current job ID (`null` when idle).
- Check status again after that request to catch a crash. A basic status
  endpoint alone does not exercise authentication-path containment.

An idle dashboard can report authentication `configured: true` and
`ready: false` despite successful external CLI proof. Dashboard proof is
memory-only and tied to the owning job, environment, configuration, and state
identities. Obtain its own fresh proof when that operation/job is authorized.
Do not start a job just to make the status green.

A live dashboard may be waiting for input or a native permission rather than
stopped. Answer non-sensitive questions against their exact current request ID;
native permission decisions stay in the dashboard browser panel. Do not reinstall
or restart merely to clear these states. Reuse an owned healthy frontend only
after verifying its checkout, environment and source version; a deployed screenshot
does not prove an unpublished commit.

### 10. Finish with actual status

Report installation/MCP, profile, dependency restores, npm/NuGet feed access,
Playwright/Edge launch, genuine authentication proof and its scope,
Doctor, dashboard repository/port/instance, and unresolved prerequisites.

Do not call the whole setup complete if backend startup/health, selected
environment configuration, required live coverage, or job-bound proof remains
unverified. Do not commit credentials, start jobs, change application UI,
publish, or stop unrelated resources as part of setup.

## Troubleshooting summary

| Symptom | Focused recovery |
| --- | --- |
| First onboarding run created files without `--yes` | Approve scaffolding before running; preserve existing files |
| npm/Yarn 401 | Refresh the actual feed through its approved helper, then retry the original restore |
| NuGet 401 / NU1301 | Distinguish auth from network/TLS; use the compatible credential provider and approved interactive restore |
| Playwright package absent | Review the actual project's setup plan; install only after approval |
| Edge unavailable | Report the prerequisite; ask before installation or choosing another browser |
| Normal Edge works but automation does not | Use a dedicated persistent, managed-sign-in-capable Edge profile |
| Certificate-auth endpoint blocked by client | Correct the identity-only request guard narrowly |
| No certificate detected | Complete permitted browser/device sign-in or report the certificate requirement |
| Dashboard authentication path-containment error | Keep ignored state inside the browser working directory |
| Vite EBUSY on Edge Cookies | Exclude private state from watching and deny serving it |
| Dashboard printed a URL then exited | Inspect its error; verify UI and authentication-status, then recheck the same instance |
| Doctor passes but dashboard auth is not ready | Distinguish configuration, external proof, and fresh dashboard/job-bound proof |

## References

- [FixLab installation](https://github.com/microsoft/FixLab/blob/main/installation.md)
- [FixLab detailed setup](https://github.com/microsoft/FixLab/blob/main/docs/installation.md)
- [Azure Artifacts Credential Provider](https://github.com/microsoft/artifacts-credprovider)
- [Playwright persistent contexts](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)
- [Microsoft Entra supported browsers](https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-conditional-access-conditions#supported-browsers)
- [Vite filesystem deny rules](https://vite.dev/config/server-options#server-fs-deny)
