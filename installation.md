# Install FixLab

## Copilot-first setup (recommended)

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

**Option 2: use a Markdown file.** Copy
[FIXLAB-SETUP.md](docs/FIXLAB-SETUP.md) into the checkout root without
overwriting an existing guide, then paste:

```text
Read @FIXLAB-SETUP.md and set up FixLab for this repository.
Show the plan and ask before applying changes.
```

If it is elsewhere, attach it or provide its actual path. In either path,
approve each reviewed setup change and complete genuine sign-in/MFA yourself.
The guide is not an automatic installer or a permission grant.
The [Word quickstart](docs/FixLab-Installation-Guide-Quickstart.docx) remains
available as a download.

If Copilot or the file is unavailable, continue with the complete manual steps
below. Use the [detailed installation guide](docs/installation.md) for enterprise
distribution, additional setup paths, updates, and troubleshooting.
The [reviewed setup guide](docs/FIXLAB-SETUP.md#instructions-for-copilot)
includes separate npm/Yarn and NuGet authentication, dedicated Edge SSO,
private-state protection, and dashboard authentication-status checks.

## 1. Prerequisites: install separately

FixLab does not install these tools or provide their licenses or sign-in.

| Prerequisite | Verify in PowerShell 7 |
| --- | --- |
| Git | `git --version` |
| Node.js 20.19+ (20.x), or 22.12+; npm is included | `node --version` and `npm --version` |
| PowerShell 7 | `pwsh --version` |
| GitHub Copilot CLI or Agency, with authorized access | `copilot --version` or `agency --version`; complete the runtime's normal sign-in |
| .NET SDK, not just the runtime | From the application root: `dotnet --version`; match `global.json` and the target framework |
| Application checkout and access to its approved package feeds/environments | Confirm access before setup |

Respect the application's Node version pin. Doctor currently checks the .NET
SDK for every profile; .NET 9 is not a universal requirement.
Missing tools? Follow the
[fresh Windows checklist](docs/installation.md#fresh-windows-dev-box), then
reopen the terminal.

## 2. Install FixLab

FixLab is now hosted at [`microsoft/FixLab`](https://github.com/microsoft/FixLab).
The repository transfer does not update existing installations; rerun the
installation command below when you want to update your installed copy.

If public GitHub access is restricted, use an
[organization-approved package](docs/installation.md#enterprise-managed-github-accounts)
instead; do not bypass enterprise policy. Otherwise:

```powershell
npm install --global github:microsoft/FixLab
fixlab --help
```

### What this adds to the machine

- The FixLab CLI, dashboard assets, plugin, templates, and documentation.
- npm dependencies, including the Copilot SDK and its bundled dashboard runtime.
- The `fixlab` and `fixlab-mcp` command launchers in the global npm prefix.

Check the installation locations with `npm prefix --global` and
`npm root --global`. This does **not** install the standalone Copilot CLI or
Agency, start a service/dashboard, register MCP, or change application files.

## 3. Set up an application

The first onboarding run can create scaffolding even without `--yes`.
Review and approve missing profile, agent, and prompt files before running:

```powershell
fixlab onboard C:\source\application --runtime copilot
```

Replace the path with the actual checkout; use `--runtime agency` for Agency.
Set any new example profile to the real application paths and commands, then
rerun `onboard` to review the setup plans. For browser UI setup, default to
Microsoft Edge by setting `browserAutomation.browser` to `"chromium"` and
`browserAutomation.channel` to `"msedge"` before approving browser installation.
The browser field selects Playwright's engine; the channel launches Edge,
not bundled Chromium. Preserve an explicitly approved repository alternative.
After approving the actual restore and browser plans:

```powershell
fixlab onboard C:\source\application --runtime copilot --yes
fixlab doctor C:\source\application --runtime copilot
```

Resolve Doctor blockers before starting chat:

```powershell
fixlab chat C:\source\application --runtime copilot
```

| Later action | What it changes |
| --- | --- |
| `fixlab init` | Adds missing profile, agent, and prompts under `.github`; preserves existing files |
| `fixlab prepare --yes` | Runs the profile's restore commands; review their working directories and effects first |
| `fixlab setup-playwright --yes` | Adds a missing test package to the configured project and installs the configured browser/channel when needed |
| Ready `fixlab chat` / `fixlab dashboard` | Starts a local loopback dashboard; running jobs can create worktrees, evidence, and Git-private metadata |

Playwright browsers normally use a user cache; branded browser installers can
change the machine's browser installation. API-only setup installs no browser;
explicit unit-only validation does not require Playwright.

Set `.github\fixlab\repository-profile.json` to real application/test paths.
Do not create empty `frontend` or `backend` folders to satisfy example paths.
Run `fixlab doctor --runtime copilot` after configuration and resolve blockers.
Complete sign-in and MFA yourself; installation does not approve data writes,
deployment, or PR publication.

Continue with [your first job](docs/getting-started.md), use
[troubleshooting](docs/troubleshooting.md), or download the
[Word quickstart](docs/FixLab-Installation-Guide-Quickstart.docx).
