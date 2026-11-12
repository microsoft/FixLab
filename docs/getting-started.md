# Dashboard user guide

## 1. Ask Copilot to set up FixLab

Open your application checkout in a signed-in Copilot session and paste:

```text
Install or reuse FixLab and onboard this repository with --runtime copilot.
Follow https://github.com/microsoft/FixLab/blob/main/docs/FIXLAB-SETUP.md
Ask me for missing setup details; do not guess paths, commands or environments.
Review the profile and changes with me, then run Doctor.
Ask before starting or reusing the matching dashboard and show its local URL.
I will complete sign-in/MFA. Do not start a job or publish changes.
```

Open the dashboard URL Copilot provides. Resolve required readiness failures
before submitting work. Already set up? Ask Copilot to start or reuse the
matching dashboard instead of reinstalling.

## 2. Submit a request

Check the repository shown in the header. Open **Run options** and choose:

| Mode | Purpose |
| --- | --- |
| Validate only | Check an existing change or PR without edits or publication |
| Fix and validate | Fix a bug or make a small enhancement |
| Playwright validation only | Check a browser/API result without implementation or PR work |

Select a profile-approved environment. For a first run, try **Validate only**:

```text
Validate PR 123 against its actual source commit. Do not edit source or update
the PR. Report evidence and any failed, blocked, skipped or pending checks.
```

Replace `123` with your PR number. For a bug, describe what happens, what
should happen, and how to reproduce it. Enter it manually or load an authorized
Azure DevOps work item, then select **Start job**.

## 3. Respond when needed

Follow the conversation and **Run details**. When **Action needed** appears,
read the blocker, supply the missing information, and use **Resume FixLab**
when offered. Review runtime permission requests separately.

For a live decision, the conversation shows the exact question and **Choose
next step** opens its response panel. Choice-only questions must use an offered
answer; the message composer cannot silently queue a different job as a reply.
Permission waits instead offer **Review permission** and explicit allow/deny
controls. Read-only MCP tools advertise read-only metadata; hosts still apply
their own permission policies.

Connected Copilot status shows whether execution is waiting for input or
permission. For a non-sensitive live question, answer through the host's
question UI; the reply targets that exact question in the same executor.
Do not use retry or comments as an answer. Native permissions and questions
whose details must remain private still require the dashboard browser panel.
When offered, **Deny and request safe recovery** rejects the blocked operation
and lets Copilot try existing reviewed tests/helpers; it does not grant access.

For complete PPE scenarios, select PPE and use the reviewed **Allow all PPE API
writes** option. Its configured PPE origins and existing authentication support
both GET reads and POST actions, plus PUT/PATCH/DELETE when the journey needs
them. Reviewed browser guards use `forwardApprovedBrowserRequest` for that
business traffic. A read-only/intercepted selection or narrower POST grant
remains narrower. Missing configuration or sign-in blocks dependent scenarios;
requesting all scenarios never marks unexecuted ones as passed.

For browser sign-in, open **Connections**, use **Check status** or
**Connect Playwright**, and complete sign-in/MFA in the browser. Never paste
credentials into chat. Backend-only jobs use their configured authentication.

## 4. Review the result

In **Run details**, check the changed source/branch, tests, browser/API evidence,
and any PR link. Failed, blocked, skipped, or pending checks are not passes.
Synthetic checks do not prove the real backend works.

Portal browser evidence uses full-page Playwright screenshots (`fullPage: true`),
with sensitive regions masked. Close-ups are additional evidence, not a substitute.
API-only and unit-test-only jobs do not require browser screenshots.

By default, browser evidence covers the journey, not only its final grid:
search/entry, mode selection, input/import preview, and verified result. Open
**Selected job Playwright evidence** and choose **Refresh evidence**. Numbered
screenshots are shown in step order, with the newest scenario directory first.
Static labels and approved test values stay readable; account details and
unrelated private data remain masked. For imports, evidence identifies the exact
uploaded bytes by filename and SHA-256 and includes a labeled safe input preview;
the original input is retained only when repository policy permits it.
Expected/observed comparisons follow actual assertions. Save/Submit and
persistence are not verified unless separately authorized and exercised.

Fix-and-validate may produce an authorized draft PR while validation continues.
Validate-only produces findings and evidence, not a new PR.

## 5. Continue or start separate work

Select the saved conversation to continue the same job and existing PR.
Use **Hold selected job** / **Resume held job** to pause or continue work.
**Restart selected job** creates a fresh job and keeps the original result.

Use **New conversation** for a separate request. **Queue** shows waiting jobs;
a blocked or failed job needs resolution or explicit dismissal before the queue
advances. On small screens, use **Menu** to reach these controls.

## 6. Stop or replace the dashboard

Closing the browser tab does not stop the dashboard. Press **Ctrl+C in the
dashboard terminal** to stop its server and release the port.
If Copilot started it in the background, ask:

> Shut down FixLab on port 4317 and only its owned processes. Leave other
> applications running.

Ask Copilot to start it again when needed. No reinstall or file deletion is
required; saved jobs remain available.

## Manual fallback and optional terminal chat

If Copilot setup is unavailable, follow [installation](installation.md).
Once ready, start the dashboard and open its printed local URL:

```powershell
fixlab dashboard C:\source\application --port 4317 --runtime copilot
```

Replace the example path with your checkout. Keep that terminal open.
If the port is occupied by another application, choose a free port.

The browser is enough. Optionally connect terminal chat from another terminal,
using the same repository, runtime, and port:

```powershell
fixlab chat C:\source\application --port 4317 --runtime copilot
```

At `fixlab>`, `/stop` stops the job and leaves it resumable; `/exit` disconnects
chat without stopping the dashboard.
