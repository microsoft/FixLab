export function configuredWorkflow(profile = {}) {
  const value = profile.workflow ?? {};
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (value.mode !== undefined && !["efficient", "strict"].includes(value.mode)) ||
      (value.publication !== undefined && !["draft", "ready"].includes(value.publication)) ||
      ["unitTestsAfterPr", "optionalBuilds", "askBeforeLiveTests"].some((key) =>
        value[key] !== undefined && typeof value[key] !== "boolean")) {
    throw new Error("workflow must declare efficient or strict mode, draft or ready publication, and boolean unitTestsAfterPr/optionalBuilds/askBeforeLiveTests preferences.");
  }
  const reviewTeams = configuredReviewTeams({ pullRequests: {
    reviewTeams: profile.pullRequests?.reviewTeams === undefined
      ? value.reviewTeams : profile.pullRequests.reviewTeams
  } });
  return {
    mode: value.mode ?? "efficient",
    unitTestsAfterPr: value.unitTestsAfterPr ?? false,
    publication: value.publication ?? (value.mode === "strict" ? "ready" : "draft"),
    optionalBuilds: value.optionalBuilds ?? false,
    askBeforeLiveTests: value.askBeforeLiveTests ?? false,
    ...(reviewTeams.length ? { reviewTeams } : {})
  };
}

export function configuredReviewTeams(profile = {}) {
  const teams = profile.pullRequests?.reviewTeams;
  if (teams === undefined) { return []; }
  if (!Array.isArray(teams) || teams.length > 8 || teams.some((team) =>
    typeof team !== "string" ||
    !/^(?:@[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9-]{0,99}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/iu.test(team))) {
    throw new Error("pullRequests.reviewTeams must contain at most 8 GitHub @org/team handles or Azure DevOps team identity GUIDs.");
  }
  return teams.filter((team, index) =>
    teams.findIndex((other) => other.toLowerCase() === team.toLowerCase()) === index);
}

export const COPILOT_EXECUTION_GUIDANCE =
  "Use normal Copilot reasoning and native tools. Stage markers report work; they are not a recipe. Reuse verified context; do authorized work without asking. Respect instructions, permissions, human authentication and data safety.";

export const DEV_WRITE_GUIDANCE =
  "Native Copilot DEV/PPE: separate consent enables fixlab_dev_write/fixlab_ppe_write POST/PUT/PATCH/DELETE on dataSafety.devWrite/ppeWrite HTTPS origins, any record; job guards.";

export const PPE_POST_GUIDANCE =
  "Native Copilot POST-only consent: fixlab_nonproduction_post covers any POST path/record within reviewed dataSafety.post environment baseUrls; job guards, no repeat prompts.";

export const PERSISTENT_DEV_API_GUIDANCE =
  "Persistent DEV API access: dataSafety.devWrite.allowAll=true authorizes real GET/HEAD/OPTIONS/POST/PUT/PATCH/DELETE on its reviewed DEV origins without per-job permission prompts. This overrides DEV read-only/intercepted defaults, not explicit stricter selections, API-only/unit-only/production restrictions or normal authentication. Use createDevBrowserContext from FIXLAB_HELPER_ROOT/dashboard/dev-browser.js with FIXLAB_REPOSITORY and FIXLAB_DEV_API_ENVIRONMENT=dev, existing authenticated storageState and genuine UI assertions. Reviewed browserProxyPaths may cover the owned loopback frontend's API proxies to those DEV origins; never infer or retarget a proxy. Use fixlab_dev_write for native API writes. Do not mock DEV responses or replace the guard; call assertHealthy and close. Profile/helper changes require fresh validation; redirects, automatic transport retries, unknown outcomes and unrelated API origins are blocked. API success alone is not scenario success. Other environments retain their existing policy.";

export const RUNTIME_RECOVERY_GUIDANCE =
  "Prefer tests over oversized inline scripts. Never replay, encode, conceal, split or repackage the rejected operation to evade review. Deny and request safe recovery: reuse helpers; preserve evidence/failures or block. Except persistent DEV, DEV/PPE/SIT/UAT writes use fixlab_nonproduction_post (legacy fixlab_dev_post) with dataSafety.post environment allowlists (legacy dataSafety.devPost). The default-off POST checkbox permits configured job writes without repeat confirmation. Approval binds the job, environment and profile/helper revision; expires on executor end, stop, hold or restart. Unchecked/recovered jobs need expiring single-use human confirmation; Allow all and batch approval never apply. Changes require a newly reviewed job; unsuccessful or ambiguous attempts stop job-scoped approval. No credentials, bodies, redirects or retries. Keep API-only read-only contracts; never substitute a shell/browser POST for a write outside guarded DEV. Approved-write is not scenario success. " + DEV_WRITE_GUIDANCE + " " + PPE_POST_GUIDANCE;

export const READ_ONLY_POST_GUIDANCE =
  "Verified read-only POST searches: Cover the full verified query scope for approved DEV/PPE reads. Contracts/implementation must prove no business/workflow mutation; names/verbs do not. Match the exact approved environment, origin and path and supported payload, including redirects. Use existing authenticated helpers and genuine returned records for GET/HEAD/OPTIONS and verified POSTs, including intercepted-write jobs. Missing scope is a policy blocker, not backend unavailability. Offer fixlab setup-queries REPOSITORY --environment ENV --runtime RUNTIME as a separate plan-first setup operation: reviewed --yes permits adapter/policy repairs and offline guard tests only, not product edits or business calls. Read-only jobs must not edit configuration; changed helpers need a fresh reviewed job. Do not silently substitute synthetic data, remove guards or grant writes. Keep Save/Submit/Approve/autosave write-controlled; identity-only proof query-disabled. Never override synthetic-only, API-only, unit-only or production policy; synthetic evidence is not live integration.";

export const UNIT_TEST_ONLY_GUIDANCE =
  "When validation.liveTestsRequired is false, this repository explicitly uses unit-test-only validation. This contract overrides live-test, browser and application-startup instructions: run the configured local unit tests and required offline checks, do not start applications, authenticate, send API requests or access remote databases. Mark local-stack and live-test skipped with validation.liveTestsDeferredReason; never mark live validation passed or claim integration coverage. Keep required local gates, PR approvals and CI/merge policies intact.";

export const TRANSIENT_PLAYWRIGHT_GUIDANCE =
  "In validate-only and playwright-only modes, read-only protects product source, existing tests, repository configuration and business data; it does not prohibit job-owned transient Playwright journeys. Reuse an equivalent existing journey first. Otherwise create a new focused journey in the repository's configured test directory, using existing reviewed fixtures and authentication helpers unchanged. You may update or remove only that job's generated journey and retain runner evidence in configured artifact directories. Keep the journey for same-job retries while validation is blocked; clean up only after owned execution finishes. Never overwrite pre-existing tests or change configuration, authentication helpers, credentials or browser state. Normal runtime permissions, prior denials, managed policy, human sign-in and data-safety controls still apply; this exception grants no runtime access or business writes.";

export const SCENARIO_VALIDATION_GUIDANCE =
  "Scenario-first validation: execute the requested feature journey with expected-versus-observed assertions, not a setup check, sign-in or screenshot alone. Write/reuse one parameterized deterministic Playwright script as a discoverable .spec file in a job-owned folder under configured testDir; honor testMatch/project; repair its syntax/selectors. Verify --list before execution; report file path, runner command and assertion results. Try permitted live reads first; if unavailable or no safe records, use approved synthetic/intercepted data only under profile/mutation policy and label synthetic UI coverage separately. Preserve live blockers; no fake HTML, sign-in or guard bypass. Continue independent scenarios despite unrelated PR/build/setup blockers; never use another checkout to prove an unpublished fix. Finish independent scenarios before asking for dependent prerequisites. API-only, unit-only and explicitly deferred checks keep their contracts.";

export const PORTAL_SCREENSHOT_GUIDANCE =
  "Save at least one non-sensitive screenshot. Default to unmasked full-page screenshots: page.screenshot({ path, fullPage: true }); crops extra. No blanket masking or repeat screenshot-scope questions. Add missing capture in a job-owned transient wrapper; preserve original test, shared configuration and guards. Respect explicit privacy rules; no credentials, sign-in/MFA screens or private/customer data. Keep evidence local; sharing needs separate approval. Save a numbered journey per scenario in test-results: search/mode/input/result. Imports: SHA-256 of exact bytes passed to the upload; safe filename/preview, approved originals only. Assert expected versus observed; no fake evidence. Save/Submit and persistence remain unverified without authorized assertions. API-only and unit-test-only runs require no browser screenshot.";

export const API_ONLY_PLAYWRIGHT_GUIDANCE =
  "When browserAutomation.mode is api, use Playwright APIRequestContext without a frontend, browser binary, UI screenshot, video or browser-profile ownership probe. This explicit API-only contract overrides browser-specific setup and evidence wording, not safety or required gates. Start only the profile-defined backend when necessary and verify its health separately from authenticated business endpoints. Require fresh legitimate API authentication for the selected audience/environment; az login or a state file alone is not an API bearer token or proof. Restrict targets and redirects to the repository-approved allowlist and enforce its allowed read-only operations before sending requests; APIRequestContext does not inherit page.route interception. Production-backed data additionally requires the explicit local-API productionDatabaseReadOnly exception, a successful assertReadOnlyDatabase check proving database-enforced read-only access, and production-read-only evidence. This never permits deployed production URLs or writes. Never send a mutation merely because a UI mutation mode says intercepted. Missing API access, safe data or startup prerequisites block live testing; synthetic responses never prove a live API passed. Preserve sanitized method/path/status and response-schema assertions plus FIXLAB_TEST scenario evidence; never persist tokens, authorization headers, cookies, sensitive bodies or credential-bearing traces. Do not fabricate browser artifacts or waive authentication to make Doctor pass.";

export const CONCISE_PR_GUIDANCE =
  "Keep PR descriptions concise, normally at most 120 words unless the repository template or material risk requires more. Preserve every required template heading/field. Use a brief problem/change summary, compact actual validation outcomes, and only material risks or blockers. Keep failed, skipped, pending and not-run checks explicit. Link evidence rather than pasting logs; omit repeated stage narration, full command transcripts and redundant file lists. Exclude token/cache counts, AI-credit totals and model-cost summaries from PR descriptions. Keep the FLAB: title short and specific.";

export const PR_LEARNING_GUIDANCE =
  "Reusable PR learning: within the existing pr stage, only when source edits and PR publication are authorized, inspect task-relevant existing repository skills for verified, non-obvious, reusable knowledge from this change. Prefer to update a matching skill; otherwise create .github/skills/<topic>/SKILL.md with YAML name and description; the name must match the lowercase-hyphenated topic directory. Capture when to use it, the verified solution, repository file/test references, exact working directories and validation commands, and pitfalls. Skills are for future developers and relevant agent tasks, not a diary of the current run. Include the skill in the same reviewed PR before committing/pushing; self-review its instructions and run applicable documentation/skill checks. In the concise PR body, link the added/updated skill or state no new reusable learning when none qualifies; do not create empty, speculative or duplicate skills. Use no separate roadmap stage. Read-only jobs must not write skills, commit or publish. Respect repository instruction governance and existing approval boundaries. Do not add allowed-tools or broaden permissions. Never include credentials, personal/customer data, private endpoints or raw transcripts.";

export const PR_TEAM_REVIEW_GUIDANCE =
  "PR team approval: after authorized PR creation or update, read pullRequests.reviewTeams from the reviewed repository profile. For GitHub use configured @org/team handles; for Azure DevOps resolve configured team identity GUIDs to native mentions. Verify each team in the exact PR provider/repository; never guess recipients. Read existing PR comments and post one approval-request comment with verified mentions, PR link and actual validation status, marked <!-- fixlab:team-review -->. Reuse only the authenticated author's matching comment; do not duplicate notifications on retries or updates. Verify comment readback before claiming success. No configured teams means no comment. Missing permission, unresolved identity or uncertain acknowledgement: report unconfirmed and reconcile, never blindly retry or block an existing PR. Preserve draft status and all readiness/merge gates; never approve or merge. Validation-only jobs must not post.";

export const EXISTING_APPLICATION_GUIDANCE =
  "Existing-application fast path: use the profile app in the selected environment, not report URLs. Reuse healthy apps/authorized browser connections; never copy browser state, take over browsers, bypass locks or equate files with sign-in. No extra clones, restores, stacks or broad gates for deployed UI checks. Mark unnecessary local-stack work skipped, not passed. Unavailable deployments block; never change targets. A baseline/deployed result does not validate unpublished local changes or a PR; match commit/app. Keep target/version/assertions and manual-localhost requirements.";

export function allowsDraftIntegrationDeferral(job) {
  return job.mode === "fix-and-validate" && job.workflow?.publication === "draft" &&
    !job.manualLocalhostTest && !job.runAllUiScenarios &&
    !job.testEvidence?.productionDatabaseReadOnly;
}

export function allowsUnverifiedDraft(job) {
  return job.deferValidation === true && allowsDraftIntegrationDeferral(job);
}

export const UNVERIFIED_DRAFT_GUIDANCE =
  "Explicit unverified draft: when deferValidation is true, create or update the authorized DRAFT PR after implementing and reviewing the nonempty diff, without running local checks or live tests. Skip reproduction execution, application startup and live-test stages with the reason user deferred validation; leave configured gates not run, never passed. Do not install test dependencies, start .NET/Key Vault, authenticate or access live data merely to create the PR. Verify provider isDraft=true. Disclose all not-run, failed and pending checks in the PR and dashboard. This permits draft creation only, never ready-for-review, merge, deployment, waived organization policy or fabricated evidence. Required authorization, authentication for publication, diff review and data-safety controls remain.";

export const OPTIONAL_INTEGRATION_GUIDANCE =
  "Per-job integration choices: useDeployedBackend selects the existing approved DEV/PPE/SIT/UAT API for the selected environment, not a local .NET backend. Resolve targets from reviewed repository configuration; do not start local .NET/Key Vault, invent URLs, change authentication guards or broaden API access. Preserve genuine SSO and existing read/write controls. Record the deployed target/version; it cannot validate unpublished backend code. skipLiveTests defers application startup and browser/API/live-data checks for draft code work, not local checks unless deferValidation is also true. Mark deferred stages skipped and integration unverified. Local API testing is optional for draft publication; if requested but unavailable, report the exact startup/authentication prerequisite without blocking independent code work or an otherwise authorized draft. Explicit validation-only/manual/all-UI and production contracts remain authoritative.";

export const AUTONOMOUS_RECOVERY_GUIDANCE =
  "Autonomous recovery: diagnose and repair recoverable missing dependencies, setup, syntax, build and test errors within the authorized task instead of stopping at the first failure. Reuse repository helpers and existing tools; explain why a missing tool/package is needed before installing it. Verify each distinct repair with the smallest failed check and retain original diagnostics. Never retry an unchanged failure, rewrite credentials, bypass guards or fix unrelated baseline defects. Continue independent work and the authorized unverified draft path when integration is unavailable. Ask only for a genuine missing permission, human sign-in or material decision. Respect read-only modes and never modify product code during validation-only work; report actual failed, skipped and blocked checks.";

export const DRAFT_INTEGRATION_GUIDANCE =
  "Draft integration deferral: for fix-and-validate jobs with saved draft publication only, continue authorized frontend or backend code work and local checks when live integration is unavailable. A configured backend does not require local .NET/Key Vault startup for a frontend-only draft. Verify the complete diff; start only applications needed by the actual checks. Existing approved DEV APIs may support authenticated reads without a local backend; deployed APIs never prove unpublished backend changes. Identity-only SSO does not authorize business reads: preserve its guards and require separately reviewed API access. After focused regression, required local gates and diff review pass, publish only the authorized DRAFT PR. Disclose every unavailable startup, authentication, browser/API check and unverified integration. Mark deferred stages skipped with the exact prerequisite, never passed; retain all gate results. Live-test gates and explicitly marked requiresLiveIntegration gates remain required for full validation, not draft publication. Explicit manual/all-UI requests, production read-only approval, ready/merge gates, repository instructions and runtime permissions remain authoritative. Do not disable guards, change the profile to fake readiness, widen SSO scopes or manufacture live evidence.";

export function allowsPostPrLiveReview(job) {
  return job.workflow?.askBeforeLiveTests === true &&
    job.workflow?.mode === "efficient" && allowsDraftIntegrationDeferral(job) &&
    !job.skipLiveTests && !job.deferValidation && !job.testEvidence?.unitTestsOnly;
}

export const POST_PR_LIVE_REVIEW_GUIDANCE =
  "Prompted draft handoff: only when workflow.askBeforeLiveTests=true, for efficient fix-and-validate jobs with draft publication, finish focused regression, required local gates and diff review, then create or update the authorized draft PR and verify provider isDraft=true. Before optional application startup, browser/API authentication or live testing, share the PR URL and ask whether live testing is possible on the developer's machine and request PR review. Wait for the user's explicit choice; do not infer consent from ticket assignment, available authentication or a running portal. If live testing is unavailable or declined, keep the same PR draft and record live checks as pending or skipped, never passed. If accepted, validate the matching checkout and update that same PR with actual results. Explicit strict/ready, validation-only, manual/all-UI, unit-test-only and per-job validation choices remain authoritative; required gates and merge policy are never waived.";

export const AUTOMATIC_LIVE_TEST_GUIDANCE =
  "Automatic live validation: workflow.askBeforeLiveTests=false is the default. Run needed live tests on the developer's machine without a separate live-test handoff question, within the selected environment and already-reviewed repository scope. For efficient draft jobs, publish the focused checkpoint first, request PR review, then continue the smallest matching real scenario and update the same PR with actual results. Validate code changes from the exact owned checkout on localhost. Reuse valid authenticated sessions and verify fresh proof; stop for genuine expired sign-in, missing access or ownership conflicts. DEV may use configured read-only queries or existing dataSafety.devWrite.allowAll=true read/write scope and guarded helpers without per-job write prompts. Never infer write access from automatic live testing, change a read-only profile, enable another environment or bypass runtime/managed permissions, authentication, production restrictions or mutation guards. Explicit skipLiveTests, deferValidation, unit-test-only, API-only, synthetic-only and stricter per-job choices remain authoritative. Unavailable live checks stay failed, blocked or skipped, never passed; independent draft work and PR review may continue.";

export const WORK_ITEM_VALIDATION_EVIDENCE_GUIDANCE =
  "Work-item validation evidence: in authorized code jobs only, only after approved live browser validation actually runs scenario assertions for the original Azure DevOps work item, use existing authorized Azure DevOps tools to attach an available genuine, reviewed non-sensitive screenshot and comment the actual result and PR link. Verify the exact work-item identity and scenario; verify the attachment relation before claiming publication. Never upload intake images, stale artifacts, login screens, browser state or invented screenshots. If validation cannot run, is skipped or is API/unit-only, do not upload screenshots. Missing capture: comment the actual result and reason without an image. Missing upload permission or an ambiguous result: report the exact limitation locally; never bypass access controls or blindly retry. Missing screenshots or evidence publication must not block the draft PR or change validation outcomes; required validation/merge gates remain authoritative.";

export const USER_FRIENDLY_UPDATE_GUIDANCE =
  "User-friendly updates: explain the issue and its impact in everyday language, what changed, and what was actually checked. State plainly when checks failed, could not run or were skipped, and say what the user needs to do next. Avoid unexplained jargon, stage IDs, stack traces and command dumps. Include a verified clickable PR link containing the fix; if no PR exists, use a verified commit link when available. Never invent links or imply an untested change is verified. For review requests, identify the PR's explicitly assigned reviewers rather than guessing; Teams delivery requires an approved configured connection and verified recipient identities.";

export function workItemValidationEvidenceGuidance(job) {
  return job.mode === "fix-and-validate" && !job.skipLiveTests && !job.deferValidation &&
    !job.testEvidence?.unitTestsOnly && !job.testEvidence?.apiOnly &&
    !job.testEvidence?.productionDatabaseReadOnly
    ? WORK_ITEM_VALIDATION_EVIDENCE_GUIDANCE : "";
}

export function efficientWorkflowGuidance(workflow, {
  dashboard = true, postPrLiveReview = workflow.askBeforeLiveTests === true && workflow.publication === "draft"
} = {}) {
  return `Saved efficient delivery policy (applies without repeated job/stage questions):
- Inspect the effective diff, make the smallest fix, run the focused regression checks that cover it, and self-review the checkpoint.
- Explicitly required repository checks (validation.gates entries with required: true), repository instructions, human PR authorization, managed policy and branch/merge policies remain authoritative. Efficient mode never waives them.
- After that reviewed focused checkpoint and any explicitly required pre-publication checks, create or update the authorized ${workflow.publication === "ready" ? "READY-FOR-REVIEW" : "DRAFT"} pull request now. Do not wait for optional broad local tests or builds. Never create an empty PR or stage unrelated files.
- Verify provider isDraft is ${workflow.publication !== "ready"} before reporting the PR stage passed. Publication is not proof of completed validation or permission to mark ready, merge, deploy or force-push.
${postPrLiveReview ? `- ${POST_PR_LIVE_REVIEW_GUIDANCE}
${dashboard ? "- After verified draft publication and any explicitly requested post-PR local checks, emit local-stack skipped only for unstarted applications, preserve completed startup outcomes, and emit live-test blocked while awaiting the user's live-test choice. Preserve pr passed and exit for same-job input. This is a planned handoff, not a failed browser run. Retry may run the focused live gate; Skip records missing live evidence and keeps the PR draft. Do not repeat completed checks or create another PR.\n" : ""}` : workflow.askBeforeLiveTests !== true ? `- ${AUTOMATIC_LIVE_TEST_GUIDANCE}\n` : ""}
- ${workflow.unitTestsAfterPr ? `After creating the PR, run the broader local unit-test gates against the same checkout through ${dashboard ? "dashboard-owned execution" : "fixlab exec with compact structured evidence"}. Update the same PR with actual results; do not delay PR creation while those tests run.` : "Broader local unit tests are optional and are not automatically requested. Leave their status not run/pending and report required remote CI separately."}
- ${workflow.optionalBuilds ? "The saved repository preference requests optional builds after PR creation; run them and report their actual outcomes." : "Optional builds are not automatically requested. Offer the saved repository Settings preference once when needed, not a question for every job or stage. Never run a full build merely to decide whether a PR may be created."}
- Keep every pending, failed, stale, skipped or not-run check explicit in the PR and dashboard. Never convert an optional check into passed, reuse stale evidence, bypass an explicitly required gate, or disable a CI/merge policy.
- Continue independent safe work without repeating successful discovery or unchanged focused checks. Use the same branch and PR; never create duplicate PRs.
- Reduce redundant regression cases, not correctness: reuse fixtures and existing test files; move punctuation, length and duplicate-value matrices to pure units. Browser cases represent distinct flows. Preserve safety, permissions, lease/queue and real reproduction boundaries. Do not hide repeated expensive work inside one case. Measure comparable baseline/final elapsed time and report actual savings.
- Keep Jest and Playwright discovery separate: bare Jest may collect E2E specs and bare Playwright selects all projects. Inspect configuration, select exact unit paths with an explicit E2E exclusion, and select the focused browser journey and authenticated project explicitly. Do not silently edit consumer configuration.`;
}
