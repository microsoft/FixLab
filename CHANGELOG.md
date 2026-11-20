# Changelog

All notable changes to FixLab are documented in this file.

## 0.7.4 - Unreleased

- Add an optional plan-first Agency watcher for explicitly tagged ADO tickets
  under reviewed area paths, with draft-PR-or-Discussion outcomes, verified
  PR linkage and restart deduplication. Onboarding never starts the watcher.
- Recover stopped permission requests with fresh, single-executor tool
  consent, either alongside reviewed folder access or without new folders.
  Bind approval to the exact instance/job/request and expire it on stop.
- Keep persistent browser-profile directories in ownership checks without
  rejecting authenticated readiness proof. Require a regular status file and
  a successful signed-in browser check; directory existence is never login proof.
- Make browser-only reproduction and deployed-result checks existing-application
  first, with mode-aware runner/authentication preflight instead of unused
  backend toolchain requirements. Preserve target, commit and data-safety
  boundaries and native Copilot reasoning/tools across entry points.
- Default new editing jobs to focused checks and a ready-for-review PR, with
  broader local unit tests afterward and optional builds saved once in
  Repository Settings. Preserve explicit required checks and strict delivery.
- Keep optional validation pending, failed or stale honestly; retain legacy
  saved-job policy until an explicitly confirmed stopped-job migration.
- Add reviewed, persistent job-bound source/test read-write trust and narrowly
  owned validation-gate/output access without granting secrets, arbitrary shell
  commands, other jobs or managed-approval exceptions.
- Classify JavaScript/TypeScript `auth.spec` and `auth.test` source as tests
  under reviewed file trust, without admitting saved authentication state,
  sensitive directories, credential markers or configured protected paths.
- Keep the permission display limit from invalidating reviewed source-edit
  trust; larger writes require bounded full-content safety scanning and retain
  all job, checkout, path, managed-policy and sandbox boundaries.
- Hide input-token budget controls by default behind a Show budget checkbox;
  preserve existing limits, usage reporting and stopped-job review.
- Simplify the dashboard around chat, with advanced controls in Run options and
  the sidebar, responsive navigation, and preserved unsent messages.
- Limit fullscreen header requests to two visible lines while retaining the
  complete title on hover and keeping the exit control accessible.
- Recover stopped shared-worktree jobs through an explicitly reviewed,
  fingerprint-bound stash of eligible untracked source files and a new job
  branch from the latest configured base. Preserve the previous branch, job,
  and verified stash without automatically restoring files or reusing grants.

- Keep managed frontend input open so React-style development servers do not
  stop on EOF; preserve one-shot helper behavior and owned process cleanup.

- Add approved, configuration-only worktree onboarding with `--from`, preserved
  custom files, missing-browser-config preflight, and reviewed exact-directory
  grants for linked dependencies; keep credentials and MFA human-controlled.
- Make chat detect incomplete profiles, open an explicit interactive setup
  request, and verify Doctor before launching a new dashboard.

- Give Windows tooling descendants one inherited hidden console while retaining
  captured input/output, Job Object containment, and termination proofs.
- Publish authorized pull requests after required local validation and approval,
  verify draft status is cleared, and leave publication-triggered remote builds
  pending rather than waiting for them before publication.

## 0.7.3 - 2026-10-05

- Wait for the native keep-awake inhibitor to become ready before reporting
  success, and fail explicitly when Windows cannot acquire or release its
  execution-state request.

## 0.7.2 - 2026-10-05

- Add a bounded `fixlab keep-awake --minutes <minutes>` command and
  `dashboard --keep-awake-minutes <minutes>` option that prevent system sleep
  without permanently changing the machine power plan.

## 0.7.1 - 2026-10-05

- Refresh plugin discovery metadata for the GitHub Copilot marketplace with
  product-neutral React/.NET positioning and focused agent-tooling keywords.

## 0.7.0 - 2026-10-05

- Add an Agency-like `fixlab <repository>` interactive entry point for
  conversational setup, diagnosis, repair, and validation.
- Add `fixlab chat` as a terminal client for the active dashboard session,
  including live output, status, evidence, PR, resume, retry, and owned-executor
  stop commands.
- Let `fixlab chat` select the repository and start the loopback dashboard
  automatically when no dashboard is already running.
- Keep the interactive `fixlab>` input visible and preserve partially typed
  text while dashboard activity and logs stream.
- Confirm the connected repository when chat starts and allow an alternate
  repository to launch automatically on the next available loopback port.
- Recognize common chat operations in plain English so dashboard, status, logs,
  evidence, pull-request, help, and repository switching do not require slash
  syntax.
- Let `new bug <details>` and `add a bug: <details>` create a separate
  dashboard job instead of commenting on the active job.
- Let users remove waiting jobs by queue position or job ID from terminal chat
  or the dashboard while preserving cancelled history and cleaning queued
  screenshot artifacts.
- Buffer background activity while the user is typing so Windows terminal
  redraws cannot split one instruction into repeated partial comments.
- Document the simplified chat-first installation, onboarding, UI-bug, API-bug,
  end-to-end validation, recovery, and pull-request workflow.
- Show periodic dashboard activity heartbeats while long-running builds,
  tests, and browser validation are quiet without resetting the idle watchdog.
- Add a packaged, plan-first `fixlab onboard` command so users can initialize,
  review, prepare, authenticate, verify, and start a repository without a
  machine-specific helper script.
- Add a plan-first, checksum-verified portable Node.js repair for incoherent
  NVM installations without changing NVM or the permanent system `PATH`.
- Refuse to execute unowned portable runtimes, verify `npm.cmd` with a real
  operation, and keep portable-repair fallback commands directly runnable.
- Add `fixlab dashboard --stop` with an instance-specific local control token
  and symlink-safe control record so users can gracefully stop only the
  FixLab-owned dashboard.
- Keep the Node 18 compatibility test suite runnable on the declared minimum
  runtime while using a newer supported runtime for development Playwright.
- Keep backend-first validation and transient synthesized-Playwright cleanup
  guidance aligned across dashboard, CLI, packaged-agent, and initialized-agent
  entry points.
- Promote a scoped learned rule and regression gate for cross-runtime
  behavioral guidance parity.
- Forward CLI requests to Agency over standard input and verify that
  backend-first guidance appears only when both an approved environment and
  non-production read-only data are selected.
- Keep request-free runs interactive in both runtimes by reserving stdin
  forwarding and autonomous invocation flags for runs that carry a request,
  and preserve inherited terminal input for interactive use.
- Require code-owner approval for non-admin contributors while retaining an
  administrator bypass for the repository owner's own validated changes.
- Clarify that request-bearing CLI runs forward prompts through stdin while
  request-free runs inherit terminal input and remain interactive.
- Add command-aware Node/TAP summaries with persisted context metrics so
  agents receive compact results while redacted raw evidence remains available.
- Sanitize command labels, report exact emitted-summary bytes, and keep timeout
  enforcement reliable when a child process never closes its output streams.
- Replace pilot-specific documentation and test fixtures with reusable
  React/.NET examples suitable for the public repository.

## 0.6.1 - 2026-09-21

- Keep synthesized authenticated Playwright scenarios out of product pull
  requests unless permanent browser-test coverage is explicitly requested or
  required by repository instructions.

## 0.6.0 - 2026-09-21

- Refresh installation, release, marketplace, availability, and team-rollout
  guidance to distinguish current GitHub distribution from pending npm,
  marketplace, and hosted-service work.
- Identify MonaDevAI as the plugin publisher in marketplace-facing metadata.
- Warn when `fixlab init` preserves an older profile that requires newly
  mandatory fields, and document the explicit test-synthesis upgrade.
- Explain directly in the dashboard how to correct and resume a failed active
  job before its paused queue can continue.
- Add an explicit, confirmed failed-job dismissal that preserves the failed
  history entry and advances the queue without resuming repository work.
- Clear and refocus the bug input after every successful submission, including
  jobs added to the running queue.
- Use an explicitly selected DEV or SIT read-only backend as the primary data
  source, with visible synthetic fallback only when required data is
  unavailable and without claiming backend validation.

## 0.5.4 - 2026-09-18

- Create tagged GitHub releases independently of optional npm publication and
  require an explicit repository opt-in before publishing to the npm registry.

## 0.5.3 - 2026-09-18

- Install the Playwright Chromium runtime before the tagged release validation
  gate so browser tests can run on a fresh GitHub-hosted runner.

## 0.5.2 - 2026-09-18

- Recover persisted running jobs as interrupted and resumable after dashboard
  restart.
- Stop an owned executor after a configurable no-output interval and display
  the latest output age so stalled jobs do not appear active indefinitely.
- Add first-class Playwright test synthesis with repository-configured
  synthetic/intercepted data, structured scenario evidence, and a highlighted
  dashboard summary of data source and mutation behavior.
- Keep unrelated test, lint, type-check, and production-build diagnostics out
  of the local application-startup stage so independently ready Playwright
  validation can continue.
- Add an optional direct GitHub Copilot CLI runtime for the CLI and dashboard
  while retaining Agency as the default compatibility runtime.
- Add repository-configured Playwright authentication status/connect controls
  and same-session comments for running dashboard jobs.
- Highlight the inferred active roadmap step while a running agent is between
  explicit stage updates.
- Load bounded Azure DevOps comments and images, support clipboard-pasted
  screenshot evidence, and expose access warnings without discarding bugs.
- Add a visible 20-job running queue with same-session blocker handling.
- Add privacy-safe period statistics for bugs, execution time, exact Copilot
  token usage, and input cache reuse.
- Add a repository-installed `fixlab-autofix` Visual Studio Code agent and
  `/fixlab.bugfix` prompt for one-bug reproduce, repair, and verification
  workflows.
- Add versioned autofix/evidence specifications, enforced repository policy
  checks, a scheduled GitHub agentic learned-rule review, and automatic revert
  pull-request proposals for failed trusted pushes.
- Add executable proof-of-bug/proof-of-fix coverage for flaky containment and
  multi-commit rollback restoration, plus a scheduled proof drill.
- Require code-owner review, stale-approval dismissal, and passing CI/CodeQL
  checks for normal changes to `main`.
- Add Agent Plugins 1.0 marketplace release guidance, correct the documented
  GitHub Copilot agent identifier, and provide a concrete private vulnerability
  reporting route.

## 0.5.1

- Add the reusable FixLab logo to the public repository and packaged assets.
- Display the product identity prominently in the GitHub README.

## 0.5.0

- Add manual or Azure DevOps work-item intake.
- Add bounded local screenshot evidence without storing tokens, request
  attachments, or screenshot paths in the repository metadata cache.
- Sanitize loaded work-item content and use the developer's local Azure
  authentication without persisting bearer tokens.

## 0.4.0

- Add an explicit, dependency-free local dashboard command for any onboarded
  repository.
- Add bug-fix and risk-scaled small-enhancement request types.
- Add token-efficiency guidance, bounded dashboard logs, and a safe,
  metadata-only same-repository cache.
- Show repository readiness, staged job progress, and polled local logs.
- Enforce single-job execution, validate-only protections, complete terminal
  stage markers, safe static serving, and owned-child shutdown.
- Package the dashboard UI and add integration coverage with a fake executor.

## 0.3.1

- Fix `fixlab run` and `fixlab validate` to use Agency's resolved `FixLab`
  plugin qualifier.
- Add regression coverage for launching the packaged FixLab agent.

## 0.3.0

- Add repository-installed FixLab prompt commands.
- Add GitHub Actions for continuous integration and npm releases.
- Add MIT licensing and GitHub contribution templates.
- Add React/.NET onboarding examples and release documentation.

## 0.2.0

- Add guided repository-local Playwright setup.
- Support npm, pnpm, Yarn, and configured browser channels.
- Verify the configured browser with a real headless launch.

## 0.1.0

- Package the FixLab CLI and Agency Copilot plugin.
- Add repository profiles, validation-only workflows, and onboarding guides.
