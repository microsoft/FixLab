import { workItemsRequest } from "./work-item-intake.js";

const stageNames = [
  "intake",
  "diagnosis",
  "reproduce",
  "fix",
  "review",
  "local-stack",
  "live-test",
  "pr"
];

function summaryText(value) {
  const result = String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, 2000);
  if (/(?:password|passwd|secret|token|authorization|bearer|cookie|connection.?string|private.?key)/iu.test(result)) {
    return "[Sensitive detail omitted]";
  }
  return result.replace(/https?:\/\/\S+/giu, "[Link omitted]") || "Not verified";
}

function jobSummarySections(job) {
  const gates = job.validation?.gates ?? [];
  const unresolved = stageNames.filter((name) => job.stages?.[name]?.status !== "passed");
  const evidence = job.testEvidence;
  const detail = job.engineeringSummary;
  const interim = ["running", "queued", "holding"].includes(job.status);
  const stage = (name) => {
    const recorded = job.stages?.[name];
    return `${name}: ${summaryText(recorded?.status)} - ${summaryText(recorded?.message)}`;
  };
  return [
    { heading: interim ? "Interim outcome" : "Recorded outcome", lines: [
      `Job: ${summaryText(job.id)} | Status: ${summaryText(job.status)}`,
      `Request: ${summaryText(job.request)}`,
      ...(detail ? [
        `Bug: ${summaryText(detail.problem)}`,
        `Expected behavior: ${summaryText(detail.expectedBehavior)}`,
        `Actual behavior: ${summaryText(detail.actualBehavior)}`
      ] : []),
      `Environment: ${summaryText(job.targetEnvironment)} | Mode: ${summaryText(job.mode)}`,
      "Job completion is not a claim of complete regression coverage."
    ] },
    { heading: detail ? "Bug-to-code-fix explanation" : "Investigation and changes (agent-reported)", lines: [
      ...(detail ? [
        `Explanation source: ${summaryText(job.engineeringSummaryOrigin)}`,
        `Root cause: ${summaryText(detail.rootCause)}`,
        `Code fix: ${summaryText(detail.codeFix)}`,
        ...(detail.changedFiles ?? []).map((file) => `Changed file: ${summaryText(file)}`),
        `Commit reference: ${summaryText(detail.commit)}`
      ] : ["Detailed code-change explanation was not retained for this job. Stage messages below are not a substitute for that evidence."]),
      stage("intake"), stage("diagnosis"), stage("reproduce"), stage("fix"), stage("review"),
      "Code references above are recorded explanations, not newly executed verification."
    ] },
    { heading: "Tests and regression", lines: [
      ...(detail?.regression ?? []).map((item) => `Recorded regression detail: ${summaryText(item)}`),
      ...gates.map((gate) => `${summaryText(gate.id)}: ${summaryText(gate.status)}${gate.required ? " (required)" : " (optional or not applicable)"}${Number.isFinite(gate.durationMs) ? ` | ${gate.durationMs} ms` : ""}${gate.summary ? ` | ${summaryText(gate.summary)}` : ""}`),
      ...(gates.length ? [] : ["No executor-backed gate results recorded."]),
      `Gate scope: ${summaryText(job.validation?.scope)}. Only the listed configured gates are accounted for.`,
      `Agent-reported scenario: ${evidence?.reported ? summaryText(evidence.scenario) : "Not verified"}`,
      `Data source: ${summaryText(evidence?.source)} | Mutation mode: ${summaryText(evidence?.mutationMode)}`,
      stage("local-stack"), stage("live-test"),
      "Agent stage/scenario messages are not independent runner proof. Synthetic or intercepted tests do not prove real backend writes."
    ] },
    { heading: "Findings and must-know", lines: [
      ...(job.bugs ?? []).map((bug) => `${summaryText(bug.id)}: ${summaryText(bug.outcome)} | Owner: ${summaryText(bug.owner)} | ${summaryText(bug.summary)}`),
      ...((job.bugs ?? []).length ? [] : ["Per-bug findings: Not verified."]),
      `Publication: ${stage("pr")}`,
      `PR readiness: ${summaryText(job.pullRequestReadiness?.message)}`,
      "Deployed-system checks do not verify unpublished local code. Publication does not establish merge or deployment."
    ] },
    { heading: "Workarounds and maintenance traps", lines: [
      ...(detail?.workarounds ?? []).map((item) => `Workaround: ${summaryText(item)}`),
      ...(detail?.risks ?? []).map((item) => `Risk / must-know: ${summaryText(item)}`),
      ...((detail?.workarounds?.length || detail?.risks?.length) ? [] : [
        "Validated workaround, tradeoffs and fix-induced side effects: Not verified unless explicitly recorded in the findings above."
      ]),
      "Do not infer that no risks exist merely because no finding was recorded."
    ] },
    { heading: "Remaining gaps and next actions", lines: [
      ...unresolved.map(stage),
      ...gates.filter((gate) => gate.status !== "passed").map((gate) => `Check ${summaryText(gate.id)}: ${summaryText(gate.status)}${gate.reason ? ` | ${summaryText(gate.reason)}` : ""}`),
      ...(job.error ? [`Recorded error: ${summaryText(job.error)}`] : []),
      "Review unverified scenarios, missing evidence and recorded blockers before claiming full coverage. No checks were run by opening this summary."
    ] }
  ];
}

const form = document.querySelector("#job-form");
const startButton = document.querySelector("#start-button");
const formError = document.querySelector("#form-error");
const readinessElement = document.querySelector("#readiness");
const modelControl = document.querySelector("#model-control");
const modelSelect = document.querySelector("#model");
let modelConfigured = false;
const stagesElement = document.querySelector("#stages");
const validationPanel = document.querySelector("#validation-panel");
const validationSummary = document.querySelector("#validation-summary");
const validationGatesElement = document.querySelector("#validation-gates");
const validationControls = document.querySelector("#validation-controls");
const validationSelection = document.querySelector("#validation-selection");
const validationRunSelection = document.querySelector("#validation-run-selection");
const validationComplete = document.querySelector("#validation-complete");
const validationControlMessage = document.querySelector("#validation-control-message");
let validationControlBusy = false;

async function controlValidation(action) {
  const job = observedJobs.get(selectedJobId) ?? activeJob;
  if (!job || job.id !== activeJob?.id || (validationControlBusy && action !== "complete")) {return;}
  const identity = { instanceId: dashboardInstanceId, jobId: job.id, repository: dashboardRepository };
  const [selection, value] = validationSelection.value.split(":");
  if (!window.confirm(action === "complete"
    ? "Complete this scoped job and advance the queue after owned checks stop? Failed and deferred checks remain unverified; this does not approve a PR."
    : `Run ${validationSelection.selectedOptions[0].textContent} for this stopped job and checkout?`)) {return;}
  validationControlBusy = true;
  validationRunSelection.disabled = true;
  try {
    await fetchJson("/api/job/checks", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...identity, action, selection, value, confirmed: true })
    });
    if (dashboardInstanceId === identity.instanceId && activeJob?.id === identity.jobId) {
      validationControlMessage.textContent = action === "complete" ? "Scoped job completed; evidence retained." : "Selected checks settled. Inspect their actual outcomes.";
      await refresh();
    }
  } catch (error) {
    if (dashboardInstanceId === identity.instanceId && activeJob?.id === identity.jobId) {
      validationControlMessage.textContent = error.message;
    }
  } finally {
    validationControlBusy = false;
    validationRunSelection.disabled = false;
  }
}
validationRunSelection.addEventListener("click", () => controlValidation("run"));
validationComplete.addEventListener("click", () => controlValidation("complete"));
const jobStatusElement = document.querySelector("#job-status");
const testEvidenceElement = document.querySelector("#test-evidence");
const testEvidenceScenario = document.querySelector(
  "#test-evidence-scenario"
);
const testDataSource = document.querySelector("#test-data-source");
const testMutationMode = document.querySelector("#test-mutation-mode");
const queuePanel = document.querySelector("#queue-panel");
const queueCount = document.querySelector("#queue-count");
const queueList = document.querySelector("#queue-list");
const jobLifecycleStatus = document.querySelector("#job-lifecycle-status");
const holdJobButton = document.querySelector("#hold-job");
const resumeHeldJobButton = document.querySelector("#resume-held-job");
const restartJobButton = document.querySelector("#restart-job");
const historyRetentionDays = document.querySelector(
  "#history-retention-days"
);
const purgeJobHistoryButton = document.querySelector("#purge-job-history");
const jobControlsMessage = document.querySelector("#job-controls-message");
const bugResultsPanel = document.querySelector("#bug-results-panel");
const bugResultsElement = document.querySelector("#bug-results");
const agentActivityPanel = document.querySelector("#agent-activity-panel");
const agentActivityElement = document.querySelector("#agent-activity");
const logsElement = document.querySelector("#logs");
const azureDevOpsIntake = document.querySelector("#azure-devops-intake");
const workItemInput = document.querySelector("#work-item");
const loadWorkItemButton = document.querySelector("#load-work-item");
const workItemSummary = document.querySelector("#work-item-summary");
const workItemCount = document.querySelector("#work-item-count");
const workItemList = document.querySelector("#work-item-list");
const requestInput = document.querySelector("#request");
const screenshotInput = document.querySelector("#screenshots");
const screenshotList = document.querySelector("#screenshot-list");
const screenshotMessage = document.querySelector("#screenshot-message");
const targetEnvironmentSelect = document.querySelector(
  "#target-environment"
);
const allowPostRequestsInput = document.querySelector("#allow-post-requests");
const allowDevWritesInput = document.querySelector("#allow-dev-writes");
let postUiBlocked = true;
let postRuntimeAvailable = false;
let postCheckboxEnvironment = null;
let postCheckboxScope = null;
let repositoryReadiness = null;

function updatePostRequestsOption() {
  const configured = [...targetEnvironmentSelect.options].map((option) => option.value).filter(Boolean);
  const environment = (targetEnvironmentSelect.value ||
    (configured.length === 1 ? configured[0] : "")).toLowerCase();
  const available = postRuntimeAvailable && !postUiBlocked && ["dev", "sit", "uat", "ppe"].includes(environment) &&
    !document.querySelector('[name="testMutationMode"]').value;
  const key = available ? environment : "";
  const scope = repositoryReadiness?.postBaseEnvironments?.includes(environment) ? "base" : "endpoint";
  if (postCheckboxEnvironment !== key || postCheckboxScope !== scope) {
    allowPostRequestsInput.checked = false;
    postCheckboxScope = scope;
  }
  if (postCheckboxEnvironment !== key) {
    allowDevWritesInput.checked = key === "ppe" && repositoryReadiness?.ppeWriteConfigured === true;
    postCheckboxEnvironment = key;
  }
  allowDevWritesInput.disabled = !available || !["dev", "ppe"].includes(environment);
  document.querySelector("#origin-writes-label").textContent =
    `Allow all ${environment === "ppe" ? "PPE" : "DEV"} API writes for this job`;
  document.querySelector("#post-writes-label").textContent = scope === "base"
    ? `Allow all ${environment.toUpperCase()} POST requests, including writes, for this job`
    : "Allow POST writes for this job in the selected environment";
  allowPostRequestsInput.disabled = !available || allowDevWritesInput.checked;
  updateIntegrationOptions();
}

function updateIntegrationOptions() {
  const codeWork = form.querySelector('[name="mode"]:checked')?.value === "fix-and-validate";
  const explicitLive = form.querySelector('[name="manualLocalhostTest"]').checked ||
    form.querySelector('[name="runAllUiScenarios"]').checked;
  for (const name of ["deferValidation", "skipLiveTests"]) {
    const input = form.querySelector(`[name="${name}"]`);
    input.disabled = !codeWork || explicitLive;
    if (input.disabled) { input.checked = false; }
  }
  if (form.querySelector('[name="deferValidation"]').checked ||
      form.querySelector('[name="skipLiveTests"]').checked) {
    form.querySelector('[name="prestartFrontend"]').checked = false;
  }
}

for (const name of ["mode", "deferValidation", "skipLiveTests", "manualLocalhostTest", "runAllUiScenarios"]) {
  for (const input of form.querySelectorAll(`[name="${name}"]`)) {
    input.addEventListener("change", () => {
      updateIntegrationOptions();
      if (repositoryReadiness) { renderReadiness(repositoryReadiness); }
    });
  }
}

allowDevWritesInput.addEventListener("change", () => {
  if (allowDevWritesInput.checked) { allowPostRequestsInput.checked = false; }
  updatePostRequestsOption();
});
targetEnvironmentSelect.addEventListener("change", updatePostRequestsOption);
document.querySelector('[name="testMutationMode"]').addEventListener("change", updatePostRequestsOption);
const jobInputPanel = document.querySelector("#job-input-panel");
const jobInputTitle = document.querySelector("#job-input-title");
const jobInputCount = document.querySelector("#job-input-count");
const jobInputGuidance = document.querySelector("#job-input-guidance");
const jobInputAction = document.querySelector("#job-input-action");
const jobInputDetails = document.querySelector("#job-input-details");
const jobInputSubmit = document.querySelector("#job-input-submit");
const jobInputMessage = document.querySelector("#job-input-message");
const jobInputActionLabel = document.querySelector(
  "label[for='job-input-action']"
);
const jobInputDetailsLabel = document.querySelector(
  "label[for='job-input-details']"
);
const permissionPanel = document.querySelector("#permission-panel");
const permissionDirectory = document.querySelector("#permission-directory");
const permissionReview = document.querySelector("#permission-review");
const permissionApprove = document.querySelector("#permission-approve");
const permissionScope = document.querySelector("#permission-scope");
const permissionMessage = document.querySelector("#permission-message");
const permissionHelper = document.querySelector("#permission-helper");
let permissionSelection = null;
const workspaceRecoveryPanel = document.querySelector("#workspace-recovery-panel");
const workspaceRecoveryReview = document.querySelector("#workspace-recovery-review");
const workspaceRecoverySummary = document.querySelector("#workspace-recovery-summary");
const workspaceRecoveryStart = document.querySelector("#workspace-recovery-start");
const workspaceRecoveryCancel = document.querySelector("#workspace-recovery-cancel");
const workspaceRecoveryMessage = document.querySelector("#workspace-recovery-message");
const workspaceStashResult = document.querySelector("#workspace-stash-result");
let workspaceRecoverySelection = null;
let workspaceRecoveryBusy = false;

function clearWorkspaceRecovery() {
  workspaceRecoverySelection = null;
  workspaceRecoverySummary.hidden = true;
  workspaceRecoveryStart.hidden = true;
  workspaceRecoveryCancel.hidden = true;
}

function renderWorkspaceRecovery(job, isActive) {
  const available = isActive && Boolean(job?.workspaceReview) &&
    ["blocked", "failed"].includes(job.status) && !job.executorStopping &&
    !job.permissionRequest && !job.runtimeRequests?.length;
  workspaceRecoveryPanel.hidden = !available;
  if (!available || (workspaceRecoverySelection &&
      (workspaceRecoverySelection.jobId !== job.id ||
        workspaceRecoverySelection.instanceId !== dashboardInstanceId))) {
    clearWorkspaceRecovery();
  }
  workspaceRecoveryReview.disabled = workspaceRecoveryBusy;
  workspaceRecoveryCancel.disabled = workspaceRecoveryBusy;
  workspaceRecoveryStart.disabled = workspaceRecoveryBusy ||
    !workspaceRecoverySelection?.workspaceReview.freshBranch?.available;
  workspaceStashResult.hidden = !isActive || !job?.workspaceStash?.stashRef;
  workspaceStashResult.textContent = workspaceStashResult.hidden ? "" :
    `Preserved stash: ${job.workspaceStash.stashRef}. Restore it separately when needed.`;
}

workspaceRecoveryReview.addEventListener("click", async () => {
  clearWorkspaceRecovery();
  workspaceRecoveryBusy = true;
  workspaceRecoveryReview.disabled = true;
  workspaceRecoveryMessage.textContent = "Reviewing the current branch and files...";
  try {
    const body = await fetchJson("/api/conversation");
    if (body.instanceId !== dashboardInstanceId || body.job?.id !== activeJob?.id ||
        body.repository !== dashboardRepository || body.question?.kind !== "workspace" ||
        !body.workspaceReview?.freshBranch) {
      throw new Error("The job or workspace changed. Refresh and review again.");
    }
    workspaceRecoverySelection = {
      instanceId: body.instanceId, jobId: body.job.id,
      repository: body.repository, workspaceReview: body.workspaceReview
    };
    const plan = body.workspaceReview.freshBranch;
    workspaceRecoverySummary.textContent =
      `Folder: ${body.repository}\nCurrent branch: ${body.workspaceReview.branch}\nNew base: ${plan.remote}/${plan.baseBranch}\nFiles to stash:\n${plan.files.length ? plan.files.join("\n") : "None"}`;
    workspaceRecoverySummary.hidden = false;
    workspaceRecoveryStart.textContent = plan.files.length ? "Stash files and start fresh" : "Start fresh from base";
    workspaceRecoveryStart.hidden = false;
    workspaceRecoveryStart.disabled = !plan.available;
    workspaceRecoveryCancel.hidden = false;
    workspaceRecoveryMessage.textContent = plan.reason || "Review complete. No files or jobs have changed.";
  } catch (error) {
    clearWorkspaceRecovery();
    workspaceRecoveryMessage.textContent = error.message;
  } finally {
    workspaceRecoveryBusy = false;
    workspaceRecoveryReview.disabled = false;
  }
});

workspaceRecoveryCancel.addEventListener("click", () => {
  if (workspaceRecoveryBusy) {return;}
  clearWorkspaceRecovery();
  workspaceRecoveryMessage.textContent = "The job remains stopped. No files were changed.";
});

workspaceRecoveryStart.addEventListener("click", async () => {
  const selection = workspaceRecoverySelection;
  if (!selection || workspaceRecoveryBusy || selection.jobId !== activeJob?.id ||
      selection.instanceId !== dashboardInstanceId || !selection.workspaceReview.freshBranch?.available) {
    workspaceRecoveryMessage.textContent = "Review the current workspace before starting.";
    return;
  }
  const plan = selection.workspaceReview.freshBranch;
  if (!window.confirm(`Save ${plan.files.length} reviewed file(s) in a stash and start a NEW job from ${plan.remote}/${plan.baseBranch} in this folder? The old branch ${selection.workspaceReview.branch} and job are preserved. No reset, deletion or automatic stash restore.`)) {
    return;
  }
  workspaceRecoveryBusy = true;
  workspaceRecoveryStart.disabled = true;
  workspaceRecoveryReview.disabled = true;
  workspaceRecoveryCancel.disabled = true;
  workspaceRecoveryMessage.textContent = "Preserving files and preparing the new branch...";
  try {
    const body = await fetchJson("/api/jobs/restart", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmed: true, instanceId: selection.instanceId, jobId: selection.jobId,
        repository: selection.repository,
        workspaceRecovery: {
          branch: selection.workspaceReview.branch, fingerprint: selection.workspaceReview.fingerprint
        }
      })
    });
    selectedJobId = body.restartedJob?.id ?? body.job?.id ?? null;
    clearWorkspaceRecovery();
    await refresh();
  } catch (error) {
    clearWorkspaceRecovery();
    workspaceRecoveryMessage.textContent = error.message;
  } finally {
    workspaceRecoveryBusy = false;
    workspaceRecoveryReview.disabled = false;
    workspaceRecoveryCancel.disabled = false;
  }
});

let runtimeHelperDirectory = "";
let permissionBusy = false;
let permissionEdited = false;
let dashboardInstanceId = null;
let dashboardRepository = "";
let runtimeSelection = null;
let runtimeBusy = false;
let composerQuestionSelection = null;
const composerQuestion = document.querySelector("#composer-question");
const composerReplyResult = document.querySelector("#composer-reply-result");
const runtimePanel = document.querySelector("#runtime-request-panel");
const runtimeGuidance = document.querySelector("#runtime-request-guidance");
const runtimeDetails = document.querySelector("#runtime-request-details");
const runtimeChoices = document.querySelector("#runtime-request-choices");
const runtimeAnswer = document.querySelector("#runtime-request-answer");
const runtimeAnswerLabel = document.querySelector("#runtime-request-answer-label");
const runtimeActions = document.querySelector("#runtime-request-actions");
const runtimeMessage = document.querySelector("#runtime-request-message");
const runtimeBatchReview = document.querySelector("#runtime-batch-review");
const runtimeBatchSummary = document.querySelector("#runtime-batch-summary");
const runtimeBatchRequests = document.querySelector("#runtime-batch-requests");
const runtimeBatchAllow = document.querySelector("#runtime-allow-pending");
const runtimeBatchResult = document.querySelector("#runtime-batch-result");
let runtimeBatchSelection = null;
const budgetPanel = document.querySelector("#job-budget-panel");
const budgetToggle = document.querySelector("#show-input-budget");
const budgetLimit = document.querySelector("#job-budget-limit");
const budgetSummary = document.querySelector("#job-budget-summary");
const budgetMessage = document.querySelector("#job-budget-message");
const budgetSave = document.querySelector("#job-budget-save");
let budgetSelection = null;
let budgetBusy = false;
const fileAccessPanel = document.querySelector("#job-file-access-panel");
const fileAccessMode = document.querySelector("#job-file-access-mode");
const fileAccessGates = document.querySelector("#job-file-access-gates");
const fileAccessSummary = document.querySelector("#job-file-access-summary");
const fileAccessMessage = document.querySelector("#job-file-access-message");
const fileAccessSave = document.querySelector("#job-file-access-save");
let fileAccessSelection = null;
let fileAccessBusy = false;
const sourceEditReviewPanel = document.querySelector("#source-edit-review");
const sourceEditReviewSummary = document.querySelector("#source-edit-review-summary");
const sourceEditReviewOpen = document.querySelector("#source-edit-review-open");
let sourceEditReviewSelection = null;
let sourceEditAuthorizationSelection = null;

function prepareSourceEditAuthorization(job) {
  const review = job.sourceEditReview;
  jobInputDetails.value = review.authorization;
  jobInputAction.value = job.status === "running" ? "comment" : "continue";
  sourceEditAuthorizationSelection = {
    instanceId: dashboardInstanceId, jobId: job.id, requestId: review.requestId,
    authorization: review.authorization
  };
  sourceEditReviewSelection = null;
  fileAccessMessage.textContent = "File trust is reviewed. Read the fresh authorization below and send it to continue. No edit has been replayed.";
  openWorkspaceSection("job-input-panel");
  jobInputDetails.focus();
}

async function reviewSourceEditAccess() {
  const job = activeJob;
  const review = job?.sourceEditReview;
  if (!review || job.mode !== "fix-and-validate" || runtimeBusy || fileAccessBusy) { return; }
  const selection = {
    instanceId: dashboardInstanceId, jobId: job.id, requestId: review.requestId
  };
  if (job.status === "running" &&
      !window.confirm("Stop only this job's executor to review source-edit access? Pending operations are not approved or replayed. File trust and a fresh attempt require separate explicit confirmation.")) {
    return;
  }
  sourceEditReviewSelection = selection;
  setRuntimeBusy(true);
  try {
    if (job.status === "running") {
      const body = await fetchJson("/api/job/source-edit-review", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...selection, confirmed: true })
      });
      if (dashboardInstanceId !== selection.instanceId || activeJob?.id !== selection.jobId) {
        throw new Error("The job changed while stopping. Refresh before reviewing access.");
      }
      activeJob = body.job;
      rememberJob(body.job);
      renderJob(body.job, body.job);
    } else {
      renderFileAccess(job, true);
    }
    if (sourceEditReviewSelection) { openWorkspaceSection("job-file-access-panel"); }
  } catch (error) {
    sourceEditReviewSelection = null;
    runtimeMessage.textContent = error.message;
    fileAccessMessage.textContent = error.message;
  } finally {
    setRuntimeBusy(false);
  }
}

sourceEditReviewOpen.addEventListener("click", () => void reviewSourceEditAccess());

function renderFileAccess(job, isActive) {
  fileAccessPanel.hidden = !job || job.runtime !== "copilot";
  if (fileAccessPanel.hidden) {
    fileAccessSelection = null;
    sourceEditReviewSelection = null;
    sourceEditAuthorizationSelection = null;
    return;
  }
  const mode = job.fileAccess?.mode ?? "manual";
  const key = `${dashboardInstanceId}:${job.id}:${mode}:${job.fileAccess?.allowValidationGates === true}`;
  if (fileAccessSelection?.key !== key) {
    fileAccessSelection = {
      key, instanceId: dashboardInstanceId, jobId: job.id,
      repository: job.fileAccess?.repository ?? dashboardRepository
    };
    fileAccessMode.value = mode;
    fileAccessGates.checked = job.fileAccess?.allowValidationGates === true;
    fileAccessMessage.textContent = "";
  }
  fileAccessSummary.textContent = mode === "manual" ? "Individual file approvals are active."
    : `${mode === "source-read-write" ? "Read and edit" : "Read"} non-sensitive source/test files for this job and checkout, including resumes. ${job.fileAccess?.allowValidationGates ? "Dashboard-owned validation gates are also trusted; other commands remain manual." : "Commands remain separately reviewed."}`;
  const editable = isActive && ["blocked", "failed", "passed"].includes(job.status);
  const review = isActive && job.mode === "fix-and-validate" && job.status !== "passed"
    ? job.sourceEditReview : null;
  sourceEditReviewPanel.hidden = !review;
  if (sourceEditReviewSelection &&
      (sourceEditReviewSelection.instanceId !== dashboardInstanceId ||
        sourceEditReviewSelection.jobId !== job.id ||
        sourceEditReviewSelection.requestId !== review?.requestId)) {
    sourceEditReviewSelection = null;
  }
  if (sourceEditAuthorizationSelection &&
      (sourceEditAuthorizationSelection.instanceId !== dashboardInstanceId ||
        sourceEditAuthorizationSelection.jobId !== job.id ||
        sourceEditAuthorizationSelection.requestId !== review?.requestId)) {
    sourceEditAuthorizationSelection = null;
  }
  if (review) {
    sourceEditReviewSummary.textContent =
      `${review.fileName}: ${review.reviewCharacters.toLocaleString()} review characters exceed inline approval's 8,192-character limit. ` +
      "Nothing was approved. Review job-wide source/test access, then explicitly authorize a fresh attempt; creating another job or reinstalling does not remove this limit.";
    sourceEditReviewOpen.hidden = job.runtimeRequests?.some((item) =>
      item.id === review.requestId && item.sourceEditReview) ?? false;
    sourceEditReviewOpen.disabled = runtimeBusy || fileAccessBusy || job.executorStopping;
    if (sourceEditReviewSelection && sourceEditReviewSelection.instanceId === dashboardInstanceId &&
        sourceEditReviewSelection.jobId === job.id &&
        sourceEditReviewSelection.requestId === review.requestId && editable && !fileAccessBusy) {
      if (mode === "source-read-write") {
        prepareSourceEditAuthorization(job);
      } else if (!sourceEditReviewSelection.trustPrepared) {
        sourceEditReviewSelection = { ...sourceEditReviewSelection, trustPrepared: true };
        fileAccessMode.value = "source-read-write";
        fileAccessMessage.textContent = "Review source/test edit access for this job and checkout, not just this file. Update stopped job file trust to confirm; this does not approve or replay the hidden operation.";
      }
    }
  }
  fileAccessMode.disabled = fileAccessBusy || !editable;
  fileAccessSave.disabled = fileAccessBusy || !editable;
  fileAccessGates.disabled = fileAccessBusy || !editable || fileAccessMode.value === "manual";
  fileAccessMode.querySelector('option[value="source-read-write"]').disabled = job.mode !== "fix-and-validate";
}
fileAccessMode.addEventListener("change", () => {
  fileAccessGates.disabled = fileAccessBusy || fileAccessMode.disabled || fileAccessMode.value === "manual";
  if (fileAccessMode.value === "manual") {
    fileAccessGates.checked = false;
  }
});

fileAccessSave.addEventListener("click", async () => {
  const selection = fileAccessSelection;
  const mode = fileAccessMode.value;
  if (!selection || fileAccessBusy) {return;}
  const allowValidationGates = mode !== "manual" && fileAccessGates.checked;
  if (!window.confirm(`Set repository file trust to ${mode} for this job and checkout, including resumes? Dashboard-owned validation gates: ${allowValidationGates ? "also trusted" : "manual"}. Other commands, sensitive files, configuration edits and organization-policy exceptions are never granted. This does not resume the job.`)) {return;}
  fileAccessBusy = true;
  fileAccessSave.disabled = true;
  try {
    const body = await fetchJson("/api/job/file-access", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...selection, mode, allowValidationGates, confirmed: true })
    });
    if (dashboardInstanceId === selection.instanceId && fileAccessSelection?.jobId === selection.jobId) {
      activeJob = body.job;
      rememberJob(body.job);
      renderJob(body.job, body.job);
      fileAccessMessage.textContent = "File trust updated for this job only. Resume separately when ready.";
    }
  } catch (error) {
    if (dashboardInstanceId === selection.instanceId && fileAccessSelection?.jobId === selection.jobId) {
      fileAccessMessage.textContent = error.message;
    }
  } finally {
    fileAccessBusy = false;
    const job = observedJobs.get(selectedJobId) ?? activeJob;
    renderFileAccess(job, job?.id === activeJob?.id);
  }
});

function renderBudget(job, isActive) {
  budgetPanel.hidden = !budgetToggle.checked || !job || job.runtime !== "copilot";
  if (budgetPanel.hidden) {
    budgetSelection = null;
    return;
  }
  const key = `${dashboardInstanceId}:${job.id}:${job.inputTokenLimit ?? 0}`;
  if (budgetSelection?.key !== key) {
    budgetSelection = { key, jobId: job.id, instanceId: dashboardInstanceId };
    budgetLimit.value = String(job.inputTokenLimit ?? 0);
    budgetMessage.textContent = "";
  }
  const input = job.usage?.inputTokens ?? 0;
  const cached = job.usage?.cachedInputTokens ?? 0;
  budgetSummary.textContent = `${input.toLocaleString()} input tokens (${cached.toLocaleString()} cached; ${Math.max(0, input - cached).toLocaleString()} uncached). Ceiling: ${job.inputTokenLimit ? job.inputTokenLimit.toLocaleString() : "unlimited"}. ${job.budgetExceeded ? "Paused: explicitly update the budget, then resume. " : ""}An in-flight model call can exceed a positive ceiling; it is not a hard billing cap.`;
  const editable = isActive && ["blocked", "failed", "passed"].includes(job.status) &&
    (job.canResume || job.budgetExceeded);
  budgetLimit.disabled = budgetBusy || !editable;
  budgetSave.disabled = budgetBusy || !editable;
}

budgetToggle.addEventListener("change", () => {
  document.querySelector("#input-budget-control").hidden =
    !budgetToggle.checked || document.querySelector("#input-token-limit").disabled;
  const job = observedJobs.get(selectedJobId) ?? activeJob;
  renderBudget(job, job?.id === activeJob?.id);
});

budgetSave.addEventListener("click", async () => {
  const selection = budgetSelection;
  const inputTokenLimit = Number(budgetLimit.value);
  if (!selection || budgetBusy || !Number.isSafeInteger(inputTokenLimit) || inputTokenLimit < 0) {
    budgetMessage.textContent = "Enter a non-negative safe integer; 0 means unlimited.";
    return;
  }
  if (!window.confirm(`Set this stopped job's input-token ceiling to ${inputTokenLimit || "unlimited"}? Usage is preserved. This does not resume the job or grant any tool permissions.`)) {
    return;
  }
  budgetBusy = true;
  budgetSave.disabled = true;
  try {
    const body = await fetchJson("/api/job/budget", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instanceId: selection.instanceId, jobId: selection.jobId,
        inputTokenLimit, confirmed: true
      })
    });
    if (budgetSelection?.jobId === selection.jobId && dashboardInstanceId === selection.instanceId) {
      activeJob = body.job;
      rememberJob(body.job);
      renderJob(body.job, body.job);
      budgetMessage.textContent = "Budget updated. Usage is preserved; resume separately when ready.";
    }
  } catch (error) {
    if (budgetSelection?.jobId === selection.jobId && dashboardInstanceId === selection.instanceId) {
      budgetMessage.textContent = error.message;
    }
  } finally {
    budgetBusy = false;
    const job = observedJobs.get(selectedJobId) ?? activeJob;
    renderBudget(job, job?.id === activeJob?.id);
  }
});

function setRuntimeBusy(busy) {
  runtimeBusy = busy;
  runtimePanel.querySelectorAll("button, textarea").forEach((element) => {
    element.disabled = busy;
  });
  if (composerQuestionSelection) {
    startButton.disabled = busy;
  }
}

function renderRuntimeBatch(job, isActive) {
  const requests = isActive
    ? (job?.runtimeRequests ?? []).filter((request) => request.kind === "permission" && request.canApprove === true && request.perAction !== true)
    : [];
  runtimeBatchReview.hidden = requests.length < 2;
  runtimeBatchAllow.disabled = runtimeBusy;
  if (runtimeBatchResult.dataset.jobId !== job?.id || !isActive) {
    runtimeBatchResult.hidden = true;
  }
  if (requests.length < 2) {
    runtimeBatchSelection = null;
    return;
  }
  const key = JSON.stringify([dashboardInstanceId, job.id, requests.map((request) => request.id)]);
  if (runtimeBatchSelection?.key === key) {
    return;
  }
  runtimeBatchSelection = {
    key, instanceId: dashboardInstanceId, jobId: job.id,
    requests: requests.map(({ id, title, details }) => ({ id, title, details }))
  };
  runtimeBatchReview.open = false;
  runtimeBatchSummary.textContent = `Review all ${requests.length} pending permissions`;
  runtimeBatchRequests.replaceChildren();
  for (const request of requests) {
    const article = document.createElement("article");
    const title = document.createElement("h3");
    const details = document.createElement("pre");
    title.textContent = request.title;
    details.textContent = request.details;
    article.append(title, details);
    runtimeBatchRequests.append(article);
  }
}

async function allowPendingPermissions() {
  const selection = runtimeBatchSelection;
  if (!selection || runtimeBusy || !window.confirm(
    `Allow only the ${selection.requests.length} permission requests listed in this review once? This can run their commands and access or change their listed files and URLs. Questions and future requests still require a separate response. Organization policy and business-action restrictions remain in effect.`
  )) {
    return;
  }
  setRuntimeBusy(true);
  runtimeBatchResult.dataset.jobId = selection.jobId;
  runtimeBatchResult.hidden = false;
  runtimeBatchResult.classList.remove("error");
  runtimeBatchResult.textContent = "Checking the reviewed permission requests before sending approvals...";
  let approved = 0;
  let attempted = false;
  try {
    const current = await fetchJson("/api/status");
    if (current.instanceId !== selection.instanceId || current.job?.id !== selection.jobId ||
        current.job.status !== "running" || !Array.isArray(current.job.runtimeRequests) ||
        !selection.requests.every((reviewed) => current.job.runtimeRequests.some((request) =>
          request.id === reviewed.id && request.kind === "permission" && request.canApprove === true && request.perAction !== true &&
          request.title === reviewed.title && request.details === reviewed.details))) {
      throw new Error("The reviewed permissions or live job changed. Review the current requests again.");
    }
    for (const request of selection.requests) {
      attempted = true;
      const body = await fetchJson("/api/job/runtime-response", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instanceId: selection.instanceId, jobId: selection.jobId,
          requestId: request.id, action: "allow", confirmed: true
        })
      });
      approved++;
      activeJob = body.job;
      observedJobs.set(body.job.id, body.job);
      runtimeBatchResult.textContent = `Confirmed ${approved} of ${selection.requests.length} one-time approvals.`;
    }
    renderJob(activeJob, activeJob);
    runtimeBatchResult.textContent = `Allowed ${approved} reviewed permission requests once. New requests still require approval.`;
  } catch (error) {
    runtimeBatchResult.hidden = false;
    runtimeBatchResult.classList.add("error");
    runtimeBatchResult.textContent = attempted
      ? `Batch stopped after ${approved} confirmed approval(s) out of ${selection.requests.length}: ${error.message} No automatic retry was made; review the remaining requests.`
      : `No approvals were sent. ${error.message}`;
  } finally {
    setRuntimeBusy(false);
  }
}

runtimeBatchAllow.addEventListener("click", () => void allowPendingPermissions());

async function respondToRuntime(action, choice, scope, answer = runtimeAnswer.value, recover = false) {
  const selection = runtimeSelection;
  if (!selection || runtimeBusy) {
    return false;
  }
  if (recover && !window.confirm("Deny this exact operation and request safe recovery of the blocked stage? Copilot must reuse existing reviewed tests and helpers, preserve completed evidence and failures, and stop if a safe prerequisite is unavailable. No hidden operation or new permission is approved.")) {
    return false;
  }
  if (action === "allow" && !window.confirm(scope === "all-tools"
    ? "Allow all reviewable tool commands for this executor? Commands can access or change files and contact services without individual approval prompts. This is privileged execution, not a sandbox. Organization policy, sensitive/escalated requests, sign-in, publication consent and required checks remain separate. The choice expires when the executor stops."
    : scope === "repository-reads"
    ? "Allow non-sensitive source, documentation and selected project-file reads within this job's repository for this executor? Directories, hidden/sensitive files, browser state, outside paths, symbolic links, escalation and managed human approval remain manual. The grant expires when the executor ends."
    : scope === "exact-test-command"
      ? "Allow this exact reviewed test command for this executor? Its working directory, reported paths and package.json are bound to this grant. Tests can have side effects: review the script before approving. Changed commands, network requests, sandbox escalation, business writes and managed human approvals are not separately authorized. The grant expires when the executor ends."
      : scope === "publication-batch"
        ? "Allow the reviewed staged checkpoint's routine commit, non-force origin push and explicit-provider PR creation for this executor? Review every listed path (including deletions), destination, source/target and draft policy above. Only one unchanged tree and its single-parent commit transition qualify. Untracked scratch is not staged or published. Changed content, destinations, required readiness, managed approvals, merge and deployment remain outside this grant."
      : selection.perAction
        ? "Send this exact real non-production POST once? Review the selected environment, complete destination and every payload field above. This may change test data. Approval is single-use, expires after five minutes and cannot be reused for redirects, retries or other actions."
        : "Allow only this exact Copilot permission request once? Review its command, files, URLs and any sandbox escalation above. This does not override organization policy."
  )) {
    return false;
  }
  setRuntimeBusy(true);
  try {
    const body = await fetchJson("/api/job/runtime-response", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instanceId: selection.instanceId,
        jobId: selection.jobId,
        requestId: selection.requestId,
        confirmed: true,
        action,
        ...(recover ? { recover: true } : {}),
        ...(scope ? { scope } : {}),
        ...(choice === undefined ? { answer } : { choice })
      })
    });
    activeJob = body.job;
    observedJobs.set(body.job.id, body.job);
    runtimeAnswer.value = "";
    renderJob(body.job, body.job);
    return true;
  } catch (error) {
    runtimeMessage.textContent = error.message;
    return false;
  } finally {
    setRuntimeBusy(false);
  }
}

function renderComposerQuestion(job, isActive) {
  const pending = isActive ? job?.runtimeRequests?.[0] : null;
  const question = pending?.kind === "question" && pending.allowFreeform ? pending : null;
  const key = question ? `${dashboardInstanceId}:${job.id}:${question.id}` : null;
  if (composerQuestionSelection && composerQuestionSelection.key !== key && requestInput.value) {
    requestInput.value = "";
    composerReplyResult.hidden = false;
    composerReplyResult.classList.remove("error");
    composerReplyResult.textContent = "The question context changed. Its unsent reply was cleared; review the current question before answering.";
  }
  composerQuestionSelection = question ? {
    key, instanceId: dashboardInstanceId, jobId: job.id, requestId: question.id
  } : null;
  composerQuestion.hidden = !question;
  composerQuestion.textContent = question?.details ?? "";
  document.querySelector('label[for="request"]').textContent = question
    ? "Reply to Copilot's question" : "Bug or required enhancement";
  requestInput.maxLength = question ? 4000 : 10000;
  requestInput.placeholder = question
    ? "Reply to the question above. Never enter passwords, tokens or MFA codes."
    : "Describe what you want to fix or check.";
  if (question) {
    document.querySelector(".composer-heading span").textContent = "Reply to current job";
    startButton.textContent = "Send reply";
    startButton.disabled = runtimeBusy;
  }
}

function renderRuntimeRequest(job, isActive) {
  renderRuntimeBatch(job, isActive);
  const pending = isActive ? job?.runtimeRequests?.[0] : null;
  runtimePanel.hidden = !pending;
  if (!pending) {
    runtimeSelection = null;
    runtimeAnswer.value = "";
    return;
  }
  runtimeGuidance.textContent = pending.perAction === true
    ? "This is a real non-production POST action without current job-scoped write approval. Review its environment, exact destination and complete payload. It requires single-use confirmation; Allow all does not approve it."
    : pending.kind === "permission" && !pending.canApprove
      ? "This operation cannot be approved here. Read the specific reasons below. Safe recovery denies the operation; it never overrides a restriction or replays hidden details."
    : pending.kind === "question"
    ? "This is a question, not a tool permission. Choose an answer below or reply from Message FixLab when freeform input is available. Allow all never supplies answers for you."
    : job.toolApprovalMode === "allow-all"
      ? pending.canAllowAll === true
        ? "Allow all is active for this executor. Review this pending request; future eligible requests use that choice."
        : "Allow all is active for this executor, but this request is not eligible for automatic approval. Review this exact request; approving once does not disable Allow all."
      : "Individual approvals are active. Allow once approves only this request. Eligible requests also offer Allow all for this run with a separate confirmation.";
  const key = `${dashboardInstanceId}:${job.id}:${pending.id}`;
  if (runtimeSelection?.key === key) {
    return;
  }
  runtimeSelection = { key, instanceId: dashboardInstanceId, jobId: job.id, requestId: pending.id, perAction: pending.perAction === true };
  runtimeAnswer.value = "";
  runtimeMessage.textContent = "";
  document.querySelector("#runtime-request-heading").textContent = pending.title;
  runtimeDetails.textContent = pending.details;
  runtimeChoices.replaceChildren();
  runtimeActions.replaceChildren();
  runtimeAnswer.hidden = pending.kind !== "question" || !pending.allowFreeform;
  runtimeAnswerLabel.hidden = runtimeAnswer.hidden;
  const button = (parent, label, action, choice, scope, recover = false) => {
    const element = document.createElement("button");
    element.type = "button";
    element.disabled = runtimeBusy;
    element.textContent = label;
    element.addEventListener("click", () => void respondToRuntime(action, choice, scope, runtimeAnswer.value, recover));
    parent.append(element);
  };
  if (pending.kind === "permission") {
    if (pending.canApprove) {
      button(runtimeActions, "Allow once", "allow");
      if (pending.canAllowAll === true) {
        button(runtimeActions, "Allow all for this run", "allow", undefined, "all-tools");
      }
      if (pending.grantScope === "repository-reads") {
        button(runtimeActions, "Allow repository-file reads for this job", "allow", undefined, pending.grantScope);
      } else if (pending.grantScope === "exact-test-command") {
        button(runtimeActions, "Allow this test command for this job", "allow", undefined, pending.grantScope);
      } else if (pending.grantScope === "publication-batch") {
        button(runtimeActions, "Allow this reviewed publication checkpoint", "allow", undefined, pending.grantScope);
      }
    }
    if (pending.canRecover === true) {
      button(runtimeActions, "Deny and request safe recovery", "deny", undefined, undefined, true);
    }
    if (pending.sourceEditReview && job.mode === "fix-and-validate") {
      const review = document.createElement("button");
      review.type = "button";
      review.textContent = "Review source-edit access";
      review.disabled = runtimeBusy;
      review.addEventListener("click", () => void reviewSourceEditAccess());
      runtimeActions.append(review);
    }
    button(runtimeActions, "Deny", "deny");
  } else {
    pending.choices.forEach((choice, index) => {
      button(runtimeChoices, choice, "answer", index);
    });
    if (pending.allowFreeform) {
      button(runtimeActions, "Send answer", "answer");
    }
    button(runtimeActions, "Cancel question", "cancel");
  }
}

function renderPermission(job, isActive) {
  const pending = isActive ? job?.permissionRequest : null;
  permissionPanel.hidden = !pending;
  if (!pending) {
    permissionSelection = null;
    return;
  }
  const key = `${job.id}:${pending.id}`;
  if (permissionSelection?.key !== key) {
    permissionDirectory.value = pending.scope?.requested ?? "";
    permissionMessage.textContent = "";
    permissionEdited = false;
  }
  permissionSelection = { key, jobId: job.id, requestId: pending.id, scope: pending.scope };
  permissionHelper.textContent = runtimeHelperDirectory
    ? `${pending.preflight ? "Pre-launch review: approve only a folder this job actually needs." : "The runtime supplied no structured denial scope; do not infer folder access is the cause."} FixLab helper: ${runtimeHelperDirectory}. Already granted for this job: ${(job.runtimeDirectoryGrants ?? []).join(", ") || "none"}. Repeating a grant cannot approve tools, URLs, or organization policy.`
    : "";
  permissionScope.hidden = !pending.scope || permissionEdited;
  permissionScope.textContent = pending.scope
    ? `Review: read/write access to ${pending.scope.directory} and its descendants for this job only. This approval is not retained after a dashboard restart.`
    : "";
  permissionApprove.hidden = !pending.scope || permissionEdited;
  permissionApprove.textContent = pending.preflight ? "Grant this folder and start" : "Grant this folder and resume";
  const stopped = job.canReviewPermissions && job.status === "blocked";
  permissionDirectory.disabled = permissionBusy || !stopped;
  permissionReview.disabled = permissionBusy || !stopped;
  permissionApprove.disabled = permissionBusy || !stopped;
}

permissionDirectory.addEventListener("input", () => {
  permissionEdited = true;
  permissionApprove.hidden = true;
  permissionScope.hidden = true;
});

async function submitPermission(action) {
  const selection = permissionSelection;
  if (!selection || permissionBusy) {
    return;
  }
  const directory = action === "review-directory"
    ? permissionDirectory.value
    : selection.scope?.directory;
  if (action === "approve-directory" && !window.confirm(
    `Grant this job read/write access to ${directory} and its descendants, and resume its background executor? This does not approve tools, URLs, or production changes.`
  )) {
    return;
  }
  permissionBusy = true;
  permissionDirectory.disabled = true;
  permissionReview.disabled = true;
  permissionApprove.disabled = true;
  try {
    const body = await fetchJson("/api/job/permissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        jobId: selection.jobId,
        requestId: selection.requestId,
        directory,
        confirmed: action === "approve-directory"
      })
    });
    activeJob = body.job;
    observedJobs.set(body.job.id, body.job);
    renderJob(body.job, activeJob);
    permissionMessage.textContent = action === "review-directory"
      ? "Review the resolved folder above. Nothing has been authorized yet."
      : "The scoped executor launch was requested. A successful grant is not proof that a command or validation passed.";
  } catch (error) {
    permissionMessage.textContent = error.message;
  } finally {
    permissionBusy = false;
    renderPermission(activeJob, true);
  }
}

permissionReview.addEventListener("click", () => void submitPermission("review-directory"));
permissionApprove.addEventListener("click", () => void submitPermission("approve-directory"));
const retryLiveTestButton = document.createElement("button");
retryLiveTestButton.id = "retry-live-test";
retryLiveTestButton.type = "button";
retryLiveTestButton.textContent = "Retry Playwright live test";
retryLiveTestButton.hidden = true;
const connectRetryLiveTestButton = document.createElement("button");
connectRetryLiveTestButton.id = "connect-and-retry-live-test";
connectRetryLiveTestButton.type = "button";
connectRetryLiveTestButton.textContent =
  "Connect Playwright, then retry live test";
connectRetryLiveTestButton.hidden = true;
const skipLiveTestButton = document.createElement("button");
skipLiveTestButton.id = "skip-live-test";
skipLiveTestButton.type = "button";
skipLiveTestButton.className = "secondary";
skipLiveTestButton.textContent = "Skip Playwright live test";
skipLiveTestButton.hidden = true;
const openManualLocalhostButton = document.createElement("button");
openManualLocalhostButton.id = "open-manual-localhost";
openManualLocalhostButton.type = "button";
openManualLocalhostButton.textContent = "Open React localhost";
openManualLocalhostButton.hidden = true;
const passManualLocalhostButton = document.createElement("button");
passManualLocalhostButton.id = "pass-manual-localhost";
passManualLocalhostButton.type = "button";
passManualLocalhostButton.textContent = "Passed";
passManualLocalhostButton.hidden = true;
const failManualLocalhostButton = document.createElement("button");
failManualLocalhostButton.id = "fail-manual-localhost";
failManualLocalhostButton.type = "button";
failManualLocalhostButton.className = "secondary";
failManualLocalhostButton.textContent = "Failed";
failManualLocalhostButton.hidden = true;
const approvePullRequestButton = document.createElement("button");
approvePullRequestButton.id = "approve-pull-request";
approvePullRequestButton.type = "button";
approvePullRequestButton.textContent = "Approve and create PR";
approvePullRequestButton.hidden = true;
const dismissFailedJobButton = document.createElement("button");
dismissFailedJobButton.id = "dismiss-failed-job";
dismissFailedJobButton.type = "button";
dismissFailedJobButton.className = "secondary";
dismissFailedJobButton.textContent = "Dismiss failed job and continue queue";
dismissFailedJobButton.hidden = true;
const cancelQueuedJobButton = document.createElement("button");
cancelQueuedJobButton.id = "cancel-queued-job";
cancelQueuedJobButton.type = "button";
cancelQueuedJobButton.className = "secondary";
cancelQueuedJobButton.textContent = "Remove from queue";
cancelQueuedJobButton.hidden = true;
jobInputSubmit.before(
  openManualLocalhostButton,
  passManualLocalhostButton,
  failManualLocalhostButton,
  retryLiveTestButton,
  connectRetryLiveTestButton,
  skipLiveTestButton,
  approvePullRequestButton,
  dismissFailedJobButton,
  cancelQueuedJobButton
);
const playwrightStatus = document.querySelector("#playwright-status");
const playwrightGuidance = document.querySelector("#playwright-guidance");
const playwrightCheck = document.querySelector("#playwright-check");
const playwrightConnect = document.querySelector("#playwright-connect");
const frontendStatusBadge = document.querySelector("#frontend-status");
const frontendGuidance = document.querySelector("#frontend-guidance");
const frontendStart = document.querySelector("#frontend-start");
const frontendStop = document.querySelector("#frontend-stop");
const sessionsList = document.querySelector("#sessions-list");
const sessionsMessage = document.querySelector("#sessions-message");
const sessionsRefresh = document.querySelector("#sessions-refresh");
const onboardingStatus = document.querySelector("#onboarding-status");
const onboardingOrganization = document.querySelector(
  "#onboarding-organization"
);
const onboardingProject = document.querySelector("#onboarding-project");
const onboardingSave = document.querySelector("#onboarding-save");
const onboardingMessage = document.querySelector("#onboarding-message");
const playwrightEvidence = document.createElement("div");
playwrightEvidence.className = "playwright-evidence";
playwrightEvidence.innerHTML = `
  <div class="section-heading">
    <h3 id="playwright-evidence-title">Selected job Playwright evidence</h3>
    <button id="playwright-evidence-refresh" type="button">Refresh evidence</button>
  </div>
  <p id="playwright-evidence-guidance" class="guidance">Select a job to view its browser evidence.</p>
  <div id="playwright-evidence-list" class="evidence-gallery"></div>
`;
stagesElement.after(playwrightEvidence);
const playwrightEvidenceRefresh = document.querySelector(
  "#playwright-evidence-refresh"
);
const playwrightEvidenceGuidance = document.querySelector(
  "#playwright-evidence-guidance"
);
const playwrightEvidenceTitle = document.querySelector(
  "#playwright-evidence-title"
);
const playwrightEvidenceList = document.querySelector(
  "#playwright-evidence-list"
);
const metricsPeriod = document.querySelector("#metrics-period");
const metricBugs = document.querySelector("#metric-bugs");
const metricCompleted = document.querySelector("#metric-completed");
const metricDuration = document.querySelector("#metric-duration");
const metricCacheReuse = document.querySelector("#metric-cache-reuse");
const metricStatuses = document.querySelector("#metric-statuses");
let loadedWorkItems = [];
let selectedScreenshots = [];
let activeJob = null;
const currentJobDialog = document.querySelector("#current-job-dialog");
const currentJobFullscreen = document.querySelector("#current-job-fullscreen");
const currentJobDetails = document.querySelector("#details-view");
let previousJobView = null;

currentJobFullscreen.addEventListener("click", () => {
  if (!activeJob || currentJobDialog.open) {
    return;
  }
  previousJobView = { selectedJobId, draftingConversation };
  selectedJobId = activeJob.id;
  draftingConversation = false;
  document.querySelector("#current-job-fullscreen-content").append(currentJobDetails);
  renderJob(activeJob, activeJob);
  currentJobDialog.showModal();
  void refreshPlaywrightEvidence();
});
document.querySelector("#current-job-fullscreen-close").addEventListener("click", () => currentJobDialog.close());
currentJobDialog.addEventListener("close", () => {
  document.querySelector("#details-group").append(currentJobDetails);
  if (previousJobView) {
    selectedJobId = previousJobView.selectedJobId;
    draftingConversation = previousJobView.draftingConversation;
    previousJobView = null;
  }
  renderJob(draftingConversation ? null : observedJobs.get(selectedJobId) ?? activeJob, activeJob);
  void refreshPlaywrightEvidence();
  currentJobFullscreen.focus();
});
let selectedJobId = null;
let pendingRetryAfterConnectJobId = null;
let playwrightAuthenticationRunning = false;
const observedJobs = new Map();
const summaryButton = document.querySelector("#job-summary-open");
const summaryDialog = document.querySelector("#job-summary-dialog");
const summaryContent = document.querySelector("#job-summary-content");
let summarySelection = null;

function renderSummary() {
  summaryContent.replaceChildren();
  const job = summarySelection?.instanceId === dashboardInstanceId
    ? observedJobs.get(summarySelection.jobId) : null;
  if (!job) {
    summaryContent.textContent = "This job's evidence is unavailable or the dashboard changed. Close and reopen the summary for the selected job.";
    return;
  }
  for (const section of jobSummarySections(job)) {
    const heading = document.createElement("h3");
    heading.textContent = section.heading;
    const list = document.createElement("ul");
    for (const line of section.lines) {
      const item = document.createElement("li");
      item.textContent = line;
      list.append(item);
    }
    summaryContent.append(heading, list);
  }
}

summaryButton.addEventListener("click", () => {
  if (draftingConversation || !observedJobs.has(selectedJobId)) {return;}
  summarySelection = { instanceId: dashboardInstanceId, jobId: selectedJobId };
  renderSummary();
  summaryDialog.showModal();
});
document.querySelector("#job-summary-close").addEventListener("click", () => summaryDialog.close());
summaryDialog.addEventListener("close", () => {
  summarySelection = null;
  summaryContent.replaceChildren();
  summaryButton.focus();
});
const expandedJobIds = new Set();
let renderedEvidenceJobId = null;
let playwrightEvidenceRequestId = 0;
let repositoryCatalog = [];
let workspaceSignature = "";
let memorySignature = "";
let draftingConversation = false;
const chatThread = document.querySelector("#chat-thread");
const conversationTitle = document.querySelector("#conversation-state-title");
const conversationDetail = document.querySelector("#conversation-state-detail");
const needsResponse = document.querySelector("#needs-response");
const workspaceTools = document.querySelector("#workspace-tools");
const navigationToggle = document.querySelector("#navigation-toggle");
const repositorySidebar = document.querySelector(".repository-sidebar");

function setNavigationExpanded(expanded) {
  repositorySidebar.classList.toggle("navigation-open", expanded);
  navigationToggle.setAttribute("aria-expanded", String(expanded));
}

navigationToggle.addEventListener("click", () => {
  setNavigationExpanded(navigationToggle.getAttribute("aria-expanded") !== "true");
});

for (const panel of document.querySelectorAll("[data-area]")) {
  document.getElementById(panel.dataset.area).append(panel);
}
document.querySelector("#chat-panels").append(document.querySelector("#new-job-panel"));
document.querySelector("#details-view").prepend(queuePanel);
chatThread.before(runtimePanel, runtimeBatchResult, permissionPanel);

export function openWorkspaceSection(id) {
  const section = document.getElementById(id);
  if (!section) {
    throw new Error(`Unknown workspace section: ${id}`);
  }
  if (workspaceTools.contains(section)) {
    workspaceTools.hidden = false;
  }
  for (let ancestor = section; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor instanceof HTMLDetailsElement) {
      ancestor.open = true;
    }
  }
  const navigationId = workspaceTools.contains(section)
    ? id === "queue-panel" ? id : section.closest(".inspector-group")?.id
    : "chat-view";
  for (const button of document.querySelectorAll(".workspace-navigation [data-open]")) {
    if (button.dataset.open === navigationId) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  }
  if (window.matchMedia("(max-width: 760px)").matches) {
    setNavigationExpanded(false);
  }
  const focusTarget = section instanceof HTMLDetailsElement
    ? section.querySelector(":scope > summary") : section;
  if (focusTarget.tabIndex < 0 && !focusTarget.hasAttribute("tabindex")) {
    focusTarget.setAttribute("tabindex", "-1");
  }
  focusTarget.focus({ preventScroll: true });
  section.scrollIntoView({ behavior: "smooth", block: "start" });
}

document.querySelector("#close-workspace-tools").addEventListener("click", () => {
  workspaceTools.hidden = true;
  for (const group of workspaceTools.querySelectorAll(".inspector-group")) {
    group.open = false;
  }
  openWorkspaceSection("chat-view");
  requestInput.focus();
});
document.querySelector("#welcome-add-repository").addEventListener("click", () => {
  document.querySelector("#add-local-repository").click();
});
document.querySelector("#add-local-repository").addEventListener("click", () => {
  setNavigationExpanded(false);
});
document.querySelectorAll("[data-open]").forEach((button) => {
  button.addEventListener("click", () => openWorkspaceSection(button.dataset.open));
});
document.querySelector("#new-conversation").addEventListener("click", () => {
  draftingConversation = true;
  renderJob(null, activeJob);
  openWorkspaceSection("new-job-panel");
  requestInput.focus();
});
document.querySelectorAll("[data-suggestion]").forEach((button) => {
  button.addEventListener("click", () => {
    requestInput.value = button.dataset.suggestion === "browser"
      ? "Validate this browser workflow: "
      : "Investigate this bug: ";
    form.elements.mode.value = button.dataset.suggestion === "browser"
      ? "playwright-only" : "fix-and-validate";
    openWorkspaceSection("new-job-panel");
    requestInput.focus();
  });
});
needsResponse.addEventListener("click", () => {
  const panel = [runtimePanel, permissionPanel, jobInputPanel].find((element) => !element.hidden);
  if (panel) {
    openWorkspaceSection("chat-view");
    panel.scrollIntoView({ behavior: "smooth", block: "center" });
    panel.querySelector("button:not([hidden]):not(:disabled), textarea:not([hidden])")?.focus();
  }
});

function renderRepositoryCatalog() {
  const list = document.querySelector("#repository-list");
  list.replaceChildren();
  const repositories = new Map();
  for (const entry of repositoryCatalog) {
    if (!repositories.has(entry.repository) || entry.id === dashboardInstanceId) {
      repositories.set(entry.repository, entry);
    }
  }
  for (const entry of [...repositories.values()].sort((a, b) =>
    Number(b.id === dashboardInstanceId) - Number(a.id === dashboardInstanceId))) {
    const url = new URL(entry.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
        !url.port || url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
      throw new Error("A registered repository has an invalid local dashboard URL.");
    }
    const link = document.createElement("a");
    link.href = url.href;
    link.className = "repository-link";
    link.title = entry.repository;
    if (entry.id === dashboardInstanceId) {
      link.setAttribute("aria-current", "page");
    }
    const name = document.createElement("strong");
    name.textContent = entry.repository.split(/[\\/]/u).filter(Boolean).pop();
    const status = document.createElement("small");
    status.textContent = entry.id === dashboardInstanceId ? "Current workspace" : entry.status;
    link.append(name, status);
    list.append(link);
  }
}

async function refreshRepositories() {
  const button = document.querySelector("#repositories-refresh");
  const message = document.querySelector("#repositories-message");
  button.disabled = true;
  try {
    const body = await fetchJson("/api/repositories");
    repositoryCatalog = body.repositories;
    renderRepositoryCatalog();
    message.textContent = body.unavailableCount
      ? `Local dashboards only. ${body.unavailableCount} unavailable registration(s); no repository scan or model calls.`
      : "";
  } catch (error) {
    message.textContent = `Repository list unavailable: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}
document.querySelector("#repositories-refresh").addEventListener("click", refreshRepositories);

function renderConversation(job, isActive) {
  document.querySelector("#chat-welcome").hidden = Boolean(job);
  document.querySelector("#conversation-state").hidden = !job;
  const pending = isActive ? job?.runtimeRequests?.[0] : null;
  const waiting = Boolean(pending || (isActive && (job?.permissionRequest ||
    job?.status === "blocked" || job?.status === "failed")));
  document.querySelector("#conversation-state").classList.toggle("waiting", waiting);
  needsResponse.hidden = !waiting;
  if (!job) {
    conversationTitle.textContent = "Ready when you are";
    conversationDetail.textContent = "Describe an outcome. Run options control the mode and environment; nothing runs until you send it.";
  } else if (pending) {
    conversationTitle.textContent = pending.kind === "permission" ? "Waiting for your permission" : "Waiting for your answer";
    conversationDetail.textContent = pending.title;
  } else if (job.permissionRequest) {
    conversationTitle.textContent = "Access review required";
    conversationDetail.textContent = "The executor is paused. Review the exact folder scope; no access has been granted.";
  } else if (job.browserBlocker) {
    conversationTitle.textContent = "Browser launch blocked; no retry running";
    conversationDetail.textContent = job.browserBlocker.message;
  } else {
    conversationTitle.textContent = {
      running: "Working on your request",
      blocked: "Paused until you choose to continue",
      failed: "Stopped with a reported failure",
      passed: "Run passed its required gates",
      queued: "Waiting in the queue",
      held: "On hold",
      cancelled: "Cancelled"
    }[job.status] ?? job.status;
    const stage = Object.entries(job.stages ?? {}).find(([, value]) =>
      ["running", "blocked", "failed"].includes(value.status));
    conversationDetail.textContent = job.error || stage?.[1].message ||
      (job.status === "running"
        ? "Progress below comes from this job's evidence, not additional AI polling."
        : "Selecting saved work does not run it. Use an explicit lifecycle action to continue.");
  }
  const messages = [
    ...(job ? [{ role: "You", message: job.request }] : []),
    ...(job?.activity ?? []).slice(-20).map((entry) => ({
      role: "FixLab", message: entry.message, stage: entry.stage
    }))
  ];
  const signature = JSON.stringify([job?.id, messages]);
  if (signature !== workspaceSignature) {
    workspaceSignature = signature;
    chatThread.replaceChildren();
    for (const entry of messages) {
      const article = document.createElement("article");
      article.className = `chat-message ${entry.role === "You" ? "user-message" : "assistant-message"}`;
      const name = document.createElement("strong");
      name.textContent = entry.stage ? `${entry.role} / ${entry.stage}` : entry.role;
      const message = document.createElement("p");
      message.textContent = entry.message;
      article.append(name, message);
      chatThread.append(article);
    }
  }
}

function renderRepositoryMemory() {
  const jobs = [...observedJobs.values()].filter((job) =>
    !["queued", "running", "holding"].includes(job.status)).slice(0, 20);
  const signature = JSON.stringify(jobs.map((job) => [job.id, job.request, job.status, job.stages]));
  if (signature === memorySignature) {
    return;
  }
  memorySignature = signature;
  const list = document.querySelector("#repository-memory-list");
  const conversations = document.querySelector("#sidebar-conversations");
  list.replaceChildren();
  conversations.replaceChildren();
  document.querySelector("#repository-memory-empty").hidden = jobs.length > 0;
  for (const job of jobs) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "memory-entry";
    const title = document.createElement("strong");
    title.textContent = job.request;
    const result = document.createElement("span");
    const completed = Object.values(job.stages ?? {}).filter((stage) => stage.status === "passed").length;
    result.textContent = `${job.status} / ${completed} passed stage(s)${job.targetEnvironment ? ` / ${job.targetEnvironment}` : ""}`;
    button.append(title, result);
    button.addEventListener("click", () => {
      selectJob(job.id);
      openWorkspaceSection("chat-view");
    });
    item.append(button);
    list.append(item);
    if (conversations.childElementCount < 6) {
      const recent = document.createElement("button");
      recent.type = "button";
      recent.className = "recent-conversation";
      recent.textContent = job.request;
      recent.title = `${job.status}: ${job.request}`;
      recent.addEventListener("click", () => {
        selectJob(job.id);
        openWorkspaceSection("chat-view");
      });
      conversations.append(recent);
    }
  }
}

const maxScreenshots = 5;
const maxScreenshotBytes = 2 * 1024 * 1024;
const maxScreenshotTotalBytes = 8 * 1024 * 1024;
const allowedScreenshotTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp"
]);

function escapeText(value) {
  return String(value ?? "");
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) {
    return "—";
  }
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function renderReadiness(readiness) {
  repositoryReadiness = readiness;
  dashboardRepository = readiness.repository;
  document.querySelector("#workspace-title").textContent = readiness.profileName || "FixLab";
  document.querySelector("#workspace-repository").textContent = readiness.repository;
  const draftOnly = readiness.draftOnlyReady &&
    form.querySelector('[name="mode"]:checked')?.value === "fix-and-validate" &&
    form.querySelector('[name="deferValidation"]').checked;
  const ready = readiness.repositoryReady && (readiness.profileReady || draftOnly);
  const apiOnly = readiness.playwrightMode === "api";
  const unitTestsOnly = readiness.unitTestsOnly === true;
  const noUi = apiOnly || unitTestsOnly;
  postUiBlocked = noUi;
  for (const name of ["prestartFrontend", "manualLocalhostTest", "recordPlaywrightVideo", "runAllUiScenarios"]) {
    const input = document.querySelector(`[name="${name}"]`);
    if (input) {
      input.disabled = noUi;
      if (noUi) { input.checked = false; }
    }
  }
  const mutationSelect = document.querySelector('[name="testMutationMode"]');
  if (mutationSelect) {
    mutationSelect.disabled = unitTestsOnly;
    if (unitTestsOnly) { mutationSelect.value = ""; }
  }
  const browserOnlyMode = document.querySelector('[name="mode"][value="playwright-only"]');
  if (browserOnlyMode) {
    browserOnlyMode.disabled = unitTestsOnly;
    if (unitTestsOnly && browserOnlyMode.checked) {
      browserOnlyMode.checked = false;
      document.querySelector('[name="mode"][value="fix-and-validate"]').checked = true;
    }
  }
  const interceptedOption = mutationSelect?.querySelector('option[value="intercepted"]');
  if (interceptedOption) { interceptedOption.disabled = apiOnly; }
  if (apiOnly && mutationSelect?.value === "intercepted") {
    mutationSelect.value = "";
  }
  document.querySelector("#welcome-add-repository").hidden = ready;
  document.querySelector("#welcome-guidance").textContent = ready
    ? `Describe a bug, change, or ${unitTestsOnly ? "local unit-test" : apiOnly ? "API" : "browser"} check.`
    : "Set up a repository to get started.";
  readinessElement.className = `readiness ${ready ? "ready" : "blocked"}`;
  readinessElement.textContent = ready
    ? "Ready"
    : `Not ready: ${readiness.error}`;
  startButton.disabled = !ready;
  const selectedEnvironment = targetEnvironmentSelect.value;
  const environments = Array.isArray(readiness.environments)
    ? readiness.environments
    : [];
  targetEnvironmentSelect.replaceChildren(
    new Option("Profile default", ""),
    ...environments.map(
      (environment) =>
        new Option(environment.toUpperCase(), environment)
    )
  );
  if (
    environments.some(
      (environment) => environment === selectedEnvironment
    )
  ) {
    targetEnvironmentSelect.value = selectedEnvironment;
  }
  updatePostRequestsOption();
}

function renderRuntime(runtime) {
  postRuntimeAvailable = runtime?.name === "copilot";
  runtimeHelperDirectory = runtime?.helperDirectory ?? "";
  const supported = runtime?.supportsModelSelection === true;
  document.querySelector("#input-budget-visibility").hidden = !supported;
  document.querySelector("#input-budget-control").hidden = !supported || !budgetToggle.checked;
  document.querySelector("#input-token-limit").disabled = !supported;
  modelControl.hidden = !supported;
  modelSelect.disabled = !supported;
  if (!supported) {
    modelSelect.value = "";
    modelConfigured = false;
    return;
  }
  if (!modelConfigured) {
    const defaultModel = runtime.defaultModel ?? "";
    if (![...modelSelect.options].some((option) => option.value === defaultModel)) {
      modelSelect.add(new Option(defaultModel, defaultModel));
    }
    modelSelect.value = defaultModel;
    modelConfigured = true;
  }
}

function labelTestEvidence(value) {
  return String(value ?? "profile-defined")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function refreshOnboarding() {
  try {
    const body = await fetchJson("/api/onboarding");
    onboardingOrganization.value = body.azureDevOps.organization;
    onboardingProject.value = body.azureDevOps.project;
    const configured =
      Boolean(body.azureDevOps.organization) &&
      Boolean(body.azureDevOps.project);
    onboardingStatus.className = `badge ${configured ? "passed" : "blocked"}`;
    onboardingStatus.textContent = configured ? "Configured" : "Required";
    onboardingMessage.textContent = configured
      ? "Numeric Azure DevOps work item IDs can be loaded."
      : "Enter the organization and project to enable numeric work item loading.";
  } catch (error) {
    onboardingStatus.className = "badge blocked";
    onboardingStatus.textContent = "Unavailable";
    onboardingMessage.textContent = error.message;
  }
}

function inferActiveStageFromLogs(logs = []) {
  const stagePatterns = [
    ["live-test", /\b(live[- ]test|browser validation|run(?:ning)? playwright)\b/i],
    ["local-stack", /\b(start(?:ing)? (?:the )?(?:local )?(?:stack|app|server)|local-stack)\b/i],
    ["review", /\b(self-review|code-review|review(?:ing)? (?:the )?(?:effective )?diff)\b/i],
    ["fix", /\b(edit|apply(?:ing)? patch|implement(?:ing)?|correct(?:ing)?|fix(?:ing)?)\b/i],
    ["reproduce", /\b(reproduc(?:e|ing)|focused test|run(?:ning)? tests?)\b/i],
    ["diagnosis", /\b(diagnos(?:e|ing|is)|root cause|trac(?:e|ing)|inspect(?:ing)? the affected)\b/i]
  ];
  for (const entry of [...logs].reverse()) {
    const message = String(entry?.message ?? "");
    const match = stagePatterns.find(([, pattern]) => pattern.test(message));
    if (match) {
      return match[0];
    }
  }
  return null;
}

function renderJob(job, currentActiveJob = job) {
  summaryButton.disabled = !job;
  if (summaryDialog.open) {renderSummary();}
  currentJobFullscreen.disabled = !currentActiveJob;
  currentJobFullscreen.hidden = !currentActiveJob;
  const currentJobTitle = document.querySelector("#current-job-dialog-title");
  currentJobTitle.textContent = currentActiveJob
    ? `Current job: ${currentActiveJob.request}` : "No current job";
  currentJobTitle.title = currentJobTitle.textContent;
  const running = job?.status === "running";
  const isActive = Boolean(job?.id && job.id === currentActiveJob?.id);
  renderBudget(job, isActive);
  renderFileAccess(job, isActive);
  renderWorkspaceRecovery(job, isActive);
  const activeNeedsQueue =
    currentActiveJob &&
    ["running", "blocked", "failed"].includes(currentActiveJob.status);
  document.querySelector(".composer-heading span").textContent = activeNeedsQueue
    ? "Queues a new job"
    : "New job";
  startButton.disabled = readinessElement.classList.contains("blocked");
  startButton.textContent =
    activeNeedsQueue
      ? "Add to queue"
      : "Start job";
  renderComposerQuestion(job, isActive);
  const lastActivityAge =
    running && job?.lastActivityAt
      ? Date.now() - Date.parse(job.lastActivityAt)
      : null;
  jobStatusElement.textContent = job
    ? `${job.runtimeRequests?.length ? "waiting for your response" : job.status} · ${job.requestType}${job.model ? ` · ${job.model}` : ""} · ${
        job.targetEnvironment || "profile default"
      }${job.sharedWorkspace ? ` · shared: ${job.sharedWorkspace.branch}` : ""} · ${formatDuration(job.durationMs)}${
        lastActivityAge === null
          ? ""
          : ` · last output ${formatDuration(lastActivityAge)} ago`
      }`
    : "Not started";
  jobStatusElement.className = `badge ${job?.status ?? ""}`;
  const testEvidence = job?.testEvidence;
  testEvidenceElement.hidden = !job;
  testEvidenceElement.classList.toggle(
    "reported",
    Boolean(testEvidence?.reported)
  );
  testEvidenceScenario.textContent =
    testEvidence?.scenario ||
    "FixLab will synthesize the smallest focused Playwright scenario from the expected behavior.";
  testDataSource.textContent =
    `Data: ${labelTestEvidence(testEvidence?.source)}`;
  testMutationMode.textContent =
    `Mutations: ${labelTestEvidence(testEvidence?.mutationMode)}`;
  const bugIdentity =
    job?.bugs?.length === 1
      ? `Bug #${job.bugs[0].id}`
      : job?.request
        ? escapeText(job.request).slice(0, 80)
        : "Selected job";
  if (renderedEvidenceJobId !== job?.id) {
    renderedEvidenceJobId = job?.id ?? null;
    playwrightEvidenceTitle.textContent =
      `${bugIdentity} · Playwright evidence`;
    playwrightEvidenceGuidance.textContent = job?.id
      ? "Checking this job's safe Playwright screenshots and videos."
      : "Select a job to view its browser evidence.";
    playwrightEvidenceList.replaceChildren();
    void refreshPlaywrightEvidence();
  }

  const stageValues = stageNames.map(
    (name) => job?.stages?.[name] ?? { status: "pending", message: "" }
  );
  const inferredActiveStage =
    running &&
    !stageValues.some((stage) =>
      ["running", "blocked", "failed"].includes(stage.status)
    )
      ? inferActiveStageFromLogs(job?.logs) ??
        stageNames[
          stageValues.findIndex((stage) => stage.status === "pending")
        ]
      : null;
  stagesElement.replaceChildren();
  for (const name of stageNames) {
    const reportedStage =
      job?.stages?.[name] ?? { status: "pending", message: "" };
    const inferred = name === inferredActiveStage;
    const stage = inferred
      ? {
          status: "running",
          message:
            reportedStage.message ||
            "Agent is working in this step; waiting for its next stage update."
        }
      : reportedStage;
    const card = document.createElement("article");
    card.className = `stage ${stage.status}`;
    if (inferred) {
      card.classList.add("inferred");
    }
    const heading = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = name;
    const status = document.createElement("span");
    status.textContent = inferred ? "active now" : stage.status;
    heading.append(title, status);
    const message = document.createElement("p");
    message.textContent = escapeText(stage.message) || "Waiting";
    card.append(heading, message);
    stagesElement.append(card);
  }

  const validation = job?.validation;
  validationControls.hidden = !job || job.id !== activeJob?.id || !["passed", "blocked", "failed"].includes(job.status);
  const savedSelection = validationSelection.value;
  validationSelection.replaceChildren();
  const selections = [["all", "All configured checks"], ["tests", "Tests only"], ["builds", "Builds only"],
    ...(validation?.gates ?? []).map((gate) => [`gate:${gate.id}`, `Gate: ${gate.id}`]),
    ...[...new Set((validation?.gates ?? []).map((gate) => gate.stage).filter(Boolean))].map((stage) => [`stage:${stage}`, `Stage: ${stage}`])];
  for (const [value, label] of selections) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    validationSelection.append(option);
  }
  if (selections.some(([value]) => value === savedSelection)) {validationSelection.value = savedSelection;}
  validationPanel.hidden = !validation;
  validationSummary.textContent = validation?.message ?? "";
  validationGatesElement.replaceChildren();
  for (const gate of validation?.gates ?? []) {
    const card = document.createElement("article");
    card.className = `stage ${gate.status === "not-applicable" ? "skipped" : gate.status}`;
    const heading = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = gate.id;
    const status = document.createElement("span");
    status.textContent = gate.status === "not-applicable" ? "Not applicable" : gate.status;
    heading.append(title, status);
    const reason = document.createElement("p");
    reason.textContent = gate.reason ?? (gate.required === false ? "Not required by the reviewed policy." : "Required validation gate.");
    card.append(heading, reason);
    validationGatesElement.append(card);
  }

  bugResultsElement.replaceChildren();
  const bugs = job?.bugs ?? [];
  bugResultsPanel.hidden = bugs.length === 0;
  for (const bug of bugs) {
    const row = document.createElement("tr");
    row.className = `bug-outcome ${bug.outcome}`;
    const identity = document.createElement("td");
    const identifier = bug.url
      ? document.createElement("a")
      : document.createElement("strong");
    if (bug.url) {
      identifier.href = bug.url;
      identifier.target = "_blank";
      identifier.rel = "noreferrer";
    }
    identifier.textContent = `#${bug.id}`;
    const title = document.createElement("span");
    title.textContent = bug.title;
    identity.append(identifier, title);
    const outcome = document.createElement("td");
    outcome.textContent = bug.outcome;
    const owner = document.createElement("td");
    owner.textContent = bug.owner || "Pending";
    const summary = document.createElement("td");
    summary.textContent = bug.summary || "Waiting for diagnosis";
    const pullRequest = document.createElement("td");
    const readiness = job.pullRequestReadiness ?? {
      status: "blocked",
      message: "Waiting for workflow evidence."
    };
    pullRequest.textContent = readiness.status;
    pullRequest.title = readiness.message;
    row.append(identity, outcome, owner, summary, pullRequest);
    bugResultsElement.append(row);
  }

  const activity = job?.activity ?? [];
  agentActivityPanel.hidden = activity.length === 0;
  agentActivityElement.replaceChildren();
  for (const entry of activity) {
    const item = document.createElement("li");
    const heading = document.createElement("div");
    const stage = document.createElement("strong");
    const timestamp = document.createElement("time");
    const message = document.createElement("p");
    stage.textContent = entry.stage;
    timestamp.dateTime = entry.timestamp;
    timestamp.textContent = new Date(entry.timestamp).toLocaleTimeString();
    message.textContent = entry.message;
    heading.append(stage, timestamp);
    item.append(heading, message);
    agentActivityElement.append(item);
  }

  const logLines = job?.logs?.map(
    (entry) => `[${entry.timestamp}] ${entry.stream}: ${entry.message}`
  );
  if (job?.droppedLogs > 0) {
    logLines.unshift(
      `[dashboard] ${job.droppedLogs} older log entries omitted from the bounded local view.`
    );
  }
  logsElement.textContent =
    logLines?.length > 0 ? logLines.join("\n") : "No job output yet.";
  logsElement.scrollTop = logsElement.scrollHeight;
  formError.textContent = job?.error ?? "";

  renderPermission(job, isActive);
  renderRuntimeRequest(job, isActive);
  const canResume = isActive && Boolean(job?.canResume) && !job?.permissionRequest && !job?.workspaceReview;
  const canComment = isActive && Boolean(job?.canComment) && !job?.permissionRequest;
  const canRetryLiveTest =
    canResume &&
    job?.status === "blocked" &&
    job?.stages?.["live-test"]?.status === "blocked" &&
    !job?.manualLocalhostPending;
  const canConfirmManualLocalhost =
    canResume &&
    job?.status === "blocked" &&
    job?.manualLocalhostPending &&
    job?.stages?.["live-test"]?.status === "blocked";
  const canApprovePullRequest =
    canResume &&
    job?.pullRequestReadiness?.status === "approval-required";
  const canDismissFailedJob =
    isActive && Boolean(job?.canDismiss ?? job?.canResume) &&
    ["failed", "blocked"].includes(job?.status);
  const dismissOnly = canDismissFailedJob && !canResume && !canComment;
  dismissFailedJobButton.textContent =
    job?.status === "blocked"
      ? "Dismiss blocked job and continue queue"
      : "Dismiss failed job and continue queue";
  const canCancelQueuedJob =
    !isActive && job?.status === "queued";
  const canHoldJob =
    Boolean(job?.id) && !job?.permissionRequest &&
    ((isActive && ["running", "blocked", "failed"].includes(job.status)) ||
      (!isActive && job.status === "queued"));
  const canResumeHeldJob = !isActive && job?.status === "held";
  const canRestartJob =
    Boolean(job?.id) &&
    ["passed", "failed", "blocked", "cancelled"].includes(job.status) &&
    !(isActive && running);
  holdJobButton.hidden = !canHoldJob;
  holdJobButton.disabled = !canHoldJob;
  resumeHeldJobButton.hidden = !canResumeHeldJob;
  resumeHeldJobButton.disabled = !canResumeHeldJob;
  restartJobButton.hidden = !canRestartJob;
  restartJobButton.disabled = !canRestartJob;
  jobInputPanel.hidden = Boolean(job?.workspaceReview) ||
    !(canResume || canComment || canCancelQueuedJob || canDismissFailedJob);
  jobInputSubmit.disabled = !(canResume || canComment);
  jobInputSubmit.hidden = canCancelQueuedJob || canConfirmManualLocalhost || dismissOnly;
  jobInputAction.hidden = canCancelQueuedJob || canConfirmManualLocalhost || dismissOnly;
  jobInputActionLabel.hidden =
    canCancelQueuedJob || canConfirmManualLocalhost || dismissOnly;
  jobInputDetails.hidden = canCancelQueuedJob || canConfirmManualLocalhost || dismissOnly;
  jobInputDetailsLabel.hidden =
    canCancelQueuedJob || canConfirmManualLocalhost || dismissOnly;
  openManualLocalhostButton.hidden = !canConfirmManualLocalhost;
  openManualLocalhostButton.disabled = !canConfirmManualLocalhost;
  passManualLocalhostButton.hidden = !canConfirmManualLocalhost;
  passManualLocalhostButton.disabled = !canConfirmManualLocalhost;
  failManualLocalhostButton.hidden = !canConfirmManualLocalhost;
  failManualLocalhostButton.disabled = !canConfirmManualLocalhost;
  retryLiveTestButton.hidden = !canRetryLiveTest;
  connectRetryLiveTestButton.hidden = !canRetryLiveTest;
  updateLiveTestRetryAvailability();
  skipLiveTestButton.hidden = !canRetryLiveTest;
  skipLiveTestButton.disabled = !canRetryLiveTest;
  approvePullRequestButton.hidden = !canApprovePullRequest;
  approvePullRequestButton.disabled = !canApprovePullRequest;
  dismissFailedJobButton.hidden = !canDismissFailedJob;
  dismissFailedJobButton.disabled = !canDismissFailedJob;
  cancelQueuedJobButton.hidden = !canCancelQueuedJob;
  cancelQueuedJobButton.disabled = !canCancelQueuedJob;
  jobInputCount.textContent = job
    ? `${job.inputCount} update(s) · ${job.pendingInputCount} pending`
    : "";
  if (canComment) {
    jobInputTitle.textContent = "Add comment to current job";
    jobInputGuidance.textContent =
      "The comment will be delivered to this same session automatically after its current agent turn finishes.";
    jobInputAction.value = "comment";
    jobInputAction.disabled = true;
    jobInputSubmit.textContent = "Queue comment";
  } else if (canResume) {
    jobInputAction.disabled = false;
    if (jobInputAction.value === "comment") {
      jobInputAction.value = "continue";
    }
    jobInputSubmit.textContent = "Resume FixLab";
    if (job.status === "blocked") {
      jobInputTitle.textContent = "Action needed";
      jobInputGuidance.textContent =
        canApprovePullRequest
          ? "All required validation gates passed. Explicit approval is required before FixLab creates or updates the pull request."
          : job?.manualLocalhostPending &&
              job?.stages?.["live-test"]?.status === "blocked"
            ? `The React app is running at ${job.manualLocalhostUrl || "the profile-defined localhost URL"}. Validate it in the browser, then confirm Passed or Failed before FixLab closes the job.`
          : job?.stages?.["live-test"]?.status === "blocked"
          ? "The browser gate could not finish. If authentication is needed, choose Connect Playwright, then retry: sign in in the Edge window and FixLab retries automatically. Retry reuses saved authentication and runs only Playwright; Skip records the missing browser evidence and continues under repository PR policy."
          : "Provide the missing authentication, safe data, approval, or manual result, then resume the same FixLab session.";
    } else if (job.status === "failed") {
      jobInputTitle.textContent = "Retry or correct this job";
      jobInputGuidance.textContent =
        "Review the failure above. To preserve and resume this job, choose Retry with the available prerequisite, enter the correction, then select Resume FixLab. If the job is obsolete, dismiss it as failed to start the next queued job without resuming or changing its repository work.";
    } else {
      jobInputTitle.textContent = "Add details or update the existing PR";
      jobInputGuidance.textContent =
        "Continue this completed session with one focused addition. FixLab reuses its evidence, branch, and pull request.";
    }
  } else if (dismissOnly) {
    jobInputTitle.textContent = job.permissionRequest
      ? "Permission-blocked job"
      : "Stopped job";
    jobInputGuidance.textContent = job.permissionRequest
      ? "The executor has stopped. Review folder access above if appropriate, or dismiss this job as blocked and continue the queue without granting access or resuming it."
      : "This stopped job cannot be resumed through the current dashboard. Dismiss it to preserve its outcome and continue the queue without resuming it.";
  } else if (canCancelQueuedJob) {
    jobInputTitle.textContent = "Remove waiting job";
    jobInputGuidance.textContent =
      "Removing this waiting job prevents it from starting, records it as cancelled in history, and deletes its queued screenshot artifacts.";
  }
  renderConversation(job, isActive);
}

function updateLiveTestRetryAvailability() {
  retryLiveTestButton.disabled =
    retryLiveTestButton.hidden || playwrightAuthenticationRunning;
  connectRetryLiveTestButton.disabled =
    connectRetryLiveTestButton.hidden ||
    playwrightAuthenticationRunning ||
    Boolean(pendingRetryAfterConnectJobId);
  const reason = playwrightAuthenticationRunning
    ? "Finish sign-in and close its browser window before retrying the live test."
    : "";
  retryLiveTestButton.title = reason;
  connectRetryLiveTestButton.title = reason;
}

function renderPlaywrightStatus(status) {
  playwrightAuthenticationRunning = Boolean(status.running);
  updateLiveTestRetryAvailability();
  playwrightStatus.className = `badge ${
    status.running ? "running" : status.ready ? "passed" : "blocked"
  }`;
  playwrightStatus.textContent = status.running
    ? status.ready
      ? "Connected · helper running"
      : "Authentication open"
    : status.ready
      ? "Connected"
      : status.configured
        ? "Not connected"
        : "Not configured";
  playwrightConnect.disabled = status.running || !status.configured;
  void resumeAfterConnect(status);
  const pathSummary = status.paths
    .map((entry) => `${entry.ready ? "ready" : "missing"}: ${entry.path}`)
    .join(" · ");
  playwrightGuidance.textContent =
    status.running
      ? "Authentication is still running. Finish sign-in and close its browser window if it stays open; live-test retries wait until the helper exits."
      : status.error ||
        status.lastResult?.message ||
        pathSummary ||
        "Add browserAutomation.authentication to the repository profile.";
}

async function resumeAfterConnect(status) {
  if (!pendingRetryAfterConnectJobId || status.running) {
    return;
  }
  const jobId = pendingRetryAfterConnectJobId;
  const result = status.lastResult;
  if (!result) {
    return;
  }
  pendingRetryAfterConnectJobId = null;
  if (!result.ok || !status.ready) {
    formError.textContent = `${result.message} Authenticated browser readiness is unverified; the live test was not retried.`;
    return;
  }
  if (activeJob?.id === jobId && activeJob.status === "blocked") {
    await retryLiveTest();
  }
}

function renderFrontendStatus(status) {
  frontendStatusBadge.textContent = !status.configured
    ? "Not configured"
    : status.healthy
      ? "Ready"
      : status.running
        ? "Starting…"
        : "Stopped";
  frontendStart.disabled =
    !status.configured || status.running || status.healthy;
  frontendStop.disabled = !status.running;
  frontendGuidance.textContent = status.error
    ? status.error
    : status.healthy
      ? `React is answering at ${status.healthUrl}. Playwright authentication and live tests reuse it.`
      : status.running
        ? "React is compiling. The first start can take several minutes; this updates automatically."
        : status.lastResult && !status.lastResult.ok
          ? status.lastResult.message
          : "Start the profile-defined React frontend ahead of time so Playwright authentication and live tests reuse it instead of waiting for a cold compile.";
}

async function refreshFrontendStatus() {
  try {
    renderFrontendStatus(await fetchJson("/api/frontend/status"));
  } catch (error) {
    frontendGuidance.textContent = error.message;
  }
}

async function startFrontend() {
  try {
    renderFrontendStatus(
      await fetchJson("/api/frontend/start", { method: "POST" })
    );
  } catch (error) {
    formError.textContent = error.message;
    await refreshFrontendStatus();
  }
}

frontendStart.addEventListener("click", () => {
  formError.textContent = "";
  frontendStart.disabled = true;
  void startFrontend();
});

async function refreshSessions() {
  try {
    const body = await fetchJson("/api/sessions");
    sessionsList.replaceChildren();
    for (const session of body.sessions) {
      const row = document.createElement("article");
      const description = document.createElement("p");
      description.className = "guidance";
      description.textContent = session.available
        ? `${session.id === body.ownerId ? "This dashboard" : "Other FixLab dashboard"} · ${session.id} · Job ${session.job?.id ?? "none"} (${session.job?.status ?? "not started"}) · React ${session.frontend.running ? `running (PID ${session.frontend.pid})` : "stopped"}`
        : `Owner ${session.id} is unavailable: ${session.error}. No process will be stopped.`;
      row.append(description);
      if (session.available) {
        const controls = document.createElement("div");
        controls.className = "button-row";
        const reconnect = document.createElement("a");
        reconnect.href = session.url;
        reconnect.textContent = "Reconnect to live dashboard";
        controls.append(reconnect);
        const actions = [
          { label: "Resume job", action: "resume", resource: "job", enabled: session.job?.canResume || session.job?.running },
          { label: "Stop agent", action: "stop", resource: "job", enabled: session.job?.running },
          { label: "Start / resume React", action: "resume", resource: "frontend", enabled: !session.frontend.running },
          { label: "Stop React", action: "stop", resource: "frontend", enabled: session.frontend.running },
          { label: "Shutdown sessions", action: "shutdown", resource: "all", enabled: session.job?.running || session.frontend.running || session.authentication.running }
        ];
        for (const control of actions) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "secondary";
          button.textContent = control.label;
          button.disabled = !control.enabled;
          button.addEventListener("click", async () => {
            const destructive = control.action !== "resume";
            if (destructive && !window.confirm(
              `${control.label} for FixLab owner ${session.id} at ${session.url}, job ${session.job?.id ?? "none"}? Only this owner's processes will be stopped; saved job context remains resumable.`
            )) {
              return;
            }
            button.disabled = true;
            try {
              await fetchJson("/api/sessions/control", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  ownerId: session.id,
                  jobId: session.job?.id ?? null,
                  action: control.action,
                  resource: control.resource,
                  confirmed: destructive
                })
              });
              sessionsMessage.textContent = `${control.label} accepted for owner ${session.id}.`;
              await refreshSessions();
              await refresh();
              await refreshFrontendStatus();
            } catch (error) {
              sessionsMessage.textContent = error.message;
              button.disabled = false;
            }
          });
          controls.append(button);
        }
        row.append(controls);
      }
      sessionsList.append(row);
    }
  } catch (error) {
    sessionsMessage.textContent = error.message;
  }
}

sessionsRefresh.addEventListener("click", refreshSessions);

frontendStop.addEventListener("click", async () => {
  frontendStop.disabled = true;
  try {
    const owner = await fetchJson("/api/session");
    if (!window.confirm(`Stop React owned by FixLab dashboard ${owner.id}? Only its frontend process tree will be stopped.`)) {
      await refreshFrontendStatus();
      return;
    }
    renderFrontendStatus(
      await fetchJson("/api/frontend/stop", { method: "POST" })
    );
  } catch (error) {
    formError.textContent = error.message;
    await refreshFrontendStatus();
  }
});

async function refreshPlaywrightStatus() {
  try {
    renderPlaywrightStatus(await fetchJson("/api/playwright/status"));
  } catch (error) {
    playwrightGuidance.textContent = error.message;
  }
}

async function refreshPlaywrightEvidence() {
  const requestId = ++playwrightEvidenceRequestId;
  const jobId = selectedJobId ?? activeJob?.id;
  playwrightEvidenceRefresh.disabled = true;
  try {
    if (!jobId) {
      playwrightEvidenceGuidance.textContent =
        "Select a job to view its browser evidence.";
      playwrightEvidenceList.replaceChildren();
      return;
    }
    const body = await fetchJson(
      `/api/playwright/artifacts?jobId=${encodeURIComponent(jobId)}`
    );
    if (requestId !== playwrightEvidenceRequestId || jobId !== (selectedJobId ?? activeJob?.id)) {
      return;
    }
    playwrightEvidenceList.replaceChildren();
    playwrightEvidenceGuidance.textContent =
      body.artifacts.length > 0
        ? `${body.artifacts.length} evidence artifact(s) for this job`
        : "No safe screenshot or video exists for this job yet. This updates automatically while Playwright runs.";
    for (const artifact of body.artifacts) {
      const item = artifact.kind === "video"
        ? document.createElement("div")
        : document.createElement("a");
      if (artifact.kind === "video") {
        item.className = "evidence-item";
        const media = document.createElement("video");
        media.src = artifact.url;
        media.controls = true;
        media.preload = "metadata";
        media.setAttribute(
          "aria-label",
          `Playwright video evidence: ${artifact.name}`
        );
        item.append(media);
      } else {
        item.href = artifact.url;
        item.target = "_blank";
        item.rel = "noreferrer";
        const media = document.createElement("img");
        media.src = artifact.url;
        media.alt = `Playwright evidence: ${artifact.name}`;
        item.append(media);
      }
      const caption = document.createElement("span");
      caption.textContent = artifact.relativePath;
      item.append(caption);
      playwrightEvidenceList.append(item);
    }
  } catch (error) {
    if (requestId === playwrightEvidenceRequestId && jobId === (selectedJobId ?? activeJob?.id)) {
      playwrightEvidenceGuidance.textContent = error.message;
    }
  } finally {
    if (requestId === playwrightEvidenceRequestId) {
      playwrightEvidenceRefresh.disabled = false;
    }
  }
}

function queuedJobView(job) {
  return {
    ...job,
    status: job.status ?? "queued",
    startedAt: null,
    finishedAt: null,
    error: null,
    canResume: false,
    canComment: false,
    inputCount: 0,
    pendingInputCount: 0,
    durationMs: 0,
    usage: {},
    stages:
      job.stages ??
      Object.fromEntries(
        stageNames.map((stage) => [
          stage,
          { status: "pending", message: "" }
        ])
      ),
    bugs: job.bugs ?? [],
    logs: [],
    activity: [],
    droppedLogs: 0
  };
}

function rememberJob(job) {
  if (job?.id) {
    observedJobs.set(job.id, job);
  }
}

function selectJob(jobId) {
  draftingConversation = false;
  selectedJobId = jobId;
  const selectedJob = observedJobs.get(jobId);
  if (selectedJob) {
    renderJob(selectedJob, activeJob);
  }
}

function renderQueue(currentJob, queue = [], held = [], history = []) {
  const visibleIds = new Set([
    currentJob?.id,
    ...queue.map((job) => job.id),
    ...held.map((job) => job.id),
    ...history.map((job) => job.id)
  ]);
  for (const jobId of observedJobs.keys()) {
    if (!visibleIds.has(jobId)) {
      observedJobs.delete(jobId);
      expandedJobIds.delete(jobId);
    }
  }
  if (selectedJobId && !visibleIds.has(selectedJobId)) {
    selectedJobId = currentJob?.id ?? null;
  }
  rememberJob(currentJob);
  for (const job of history) {
    rememberJob(job);
  }
  for (const job of held) {
    rememberJob(job);
  }
  for (const job of queue) {
    if (!observedJobs.has(job.id)) {
      observedJobs.set(job.id, queuedJobView(job));
    }
  }
  const queuedIds = new Set(queue.map((job) => job.id));
  const heldIds = new Set(held.map((job) => job.id));
  const recentJobs = [...observedJobs.values()]
    .filter(
      (job) =>
        job.id !== currentJob?.id &&
        !queuedIds.has(job.id) &&
        !heldIds.has(job.id)
    )
    .reverse();
  const entries = [
    ...(currentJob ? [{ job: currentJob, label: "Current" }] : []),
    ...queue.map((job) => ({
      job: observedJobs.get(job.id),
      label: `Waiting #${job.position}`
    })),
    ...held.map((job) => ({ job, label: "Held" })),
    ...recentJobs.map((job) => ({ job, label: "Recent" }))
  ];

  queuePanel.hidden = false;
  document.querySelector("#queue-nav-count").textContent = String(queue.length);
  queuePanel.querySelector("h3").textContent = "Jobs";
  queueCount.textContent =
    `${queue.length} waiting · ${held.length} held · ${recentJobs.length} recent`;
  jobLifecycleStatus.textContent =
    `${queue.length} waiting · ${held.length} held · ${recentJobs.length} recent`;
  queueList.replaceChildren();
  for (const { job, label } of entries) {
    const item = document.createElement("li");
    item.className = "job-row";
    if (expandedJobIds.has(job.id)) {
      item.classList.add("expanded");
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "job-selector";
    if ((selectedJobId ?? currentJob?.id) === job.id) {
      button.classList.add("selected");
    }
    const summary = document.createElement("strong");
    summary.textContent = `${label} · ${job.status} · ${job.requestType}`;
    const details = document.createElement("span");
    details.className = "job-request";
    details.textContent =
      ` · ${job.bugCount ?? job.bugs?.length ?? 0} bug(s) · ${job.request}`;
    button.append(summary, details);
    button.addEventListener("click", () => {
      selectJob(job.id);
      renderQueue(currentJob, queue, held, history);
    });

    item.append(button);
    if (job.request.length > 160) {
      const expandButton = document.createElement("button");
      const expanded = expandedJobIds.has(job.id);
      expandButton.type = "button";
      expandButton.className = "job-expand";
      expandButton.textContent = expanded ? "⌃" : "⌄";
      expandButton.setAttribute(
        "aria-label",
        `${expanded ? "Collapse" : "Expand"} bug text for ${label}`
      );
      expandButton.setAttribute("aria-expanded", String(expanded));
      expandButton.addEventListener("click", () => {
        const nextExpanded = !expandedJobIds.has(job.id);
        if (nextExpanded) {
          expandedJobIds.add(job.id);
        } else {
          expandedJobIds.delete(job.id);
        }
        item.classList.toggle("expanded", nextExpanded);
        expandButton.textContent = nextExpanded ? "⌃" : "⌄";
        expandButton.setAttribute("aria-expanded", String(nextExpanded));
        expandButton.setAttribute(
          "aria-label",
          `${nextExpanded ? "Collapse" : "Expand"} bug text for ${label}`
        );
      });
      item.append(expandButton);
    }
    queueList.append(item);
  }
  renderRepositoryMemory();
}

function renderMetrics(metrics, warning) {
  metricBugs.textContent = metrics.bugs.toLocaleString();
  metricCompleted.textContent =
    `${metrics.completed.toLocaleString()} / ${metrics.queued.toLocaleString()} jobs`;
  metricDuration.textContent = formatDuration(metrics.averageDurationMs);
  metricCacheReuse.textContent =
    metrics.cacheReusePercent === null
      ? "—"
      : `${metrics.cacheReusePercent.toFixed(1)}%`;
  metricStatuses.textContent =
    warning ||
    `${metrics.passed} passed · ${metrics.failed} failed · ${metrics.blocked} blocked · ${metrics.cancelled} cancelled · exact usage available for ${metrics.usageJobs} completed job(s)`;
}

export async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return body;
}

function selectedIntakeSource() {
  return form.elements.intakeSource.value;
}

function renderWorkItems(workItems) {
  workItemList.replaceChildren();
  workItemCount.textContent = `${workItems.length} work item${workItems.length === 1 ? "" : "s"} loaded`;
  for (const workItem of workItems) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = workItem.webUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = `#${workItem.id}`;
    item.append(
      link,
      ` · ${workItem.workItemType || "Work Item"} · ${workItem.state || "Unknown"} · ${workItem.title} · ${workItem.commentCount || 0} comment(s) · ${workItem.imageCount || 0} image(s)${workItem.commentsWarning ? " · comments unavailable" : ""}${workItem.imagesWarning ? " · some images unavailable" : ""}`
    );
    workItemList.append(item);
  }
  workItemSummary.hidden = false;
}

function workItemInputs(value) {
  return [
    ...new Set(
      String(value)
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ];
}

function validateSelectedScreenshots() {
  const files = selectedScreenshots;
  if (files.length > maxScreenshots) {
    throw new Error(`Select at most ${maxScreenshots} screenshots.`);
  }
  let total = 0;
  for (const file of files) {
    if (!allowedScreenshotTypes.has(file.type)) {
      throw new Error(`${file.name} is not a PNG, JPEG, or WebP image.`);
    }
    if (file.size > maxScreenshotBytes) {
      throw new Error(`${file.name} exceeds the 2 MiB per-file limit.`);
    }
    total += file.size;
  }
  if (total > maxScreenshotTotalBytes) {
    throw new Error("Selected screenshots exceed the 8 MiB total limit.");
  }
  return files;
}

function renderScreenshots() {
  screenshotList.replaceChildren();
  for (const file of selectedScreenshots) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${file.name} (${Math.ceil(file.size / 1024)} KiB)`;
    item.append(label);
    screenshotList.append(item);
  }
}

function addScreenshots(files) {
  const next = [...selectedScreenshots, ...files];
  selectedScreenshots = next;
  try {
    validateSelectedScreenshots();
  } catch (error) {
    selectedScreenshots = next.slice(0, -files.length);
    throw error;
  }
  renderScreenshots();
}

function showScreenshotResult(message, error = false) {
  screenshotMessage.textContent = message;
  screenshotMessage.className = error ? "error" : "guidance";
}

function normalizeClipboardScreenshot(file, index) {
  if (file.name) {
    return file;
  }
  const extension = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp"
  }[file.type];
  return new File(
    [file],
    `pasted-${Date.now()}-${index + 1}${extension}`,
    {
      type: file.type,
      lastModified: file.lastModified
    }
  );
}

async function convertClipboardScreenshot(file, index) {
  if (allowedScreenshotTypes.has(file.type)) {
    return normalizeClipboardScreenshot(file, index);
  }
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/png")
    );
    if (!blob) {
      throw new Error("The clipboard image could not be converted to PNG.");
    }
    return new File([blob], `pasted-${Date.now()}-${index + 1}.png`, {
      type: "image/png",
      lastModified: Date.now()
    });
  } finally {
    bitmap.close();
  }
}

function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () =>
      reject(new Error(`Could not read ${file.name}.`))
    );
    reader.addEventListener("load", () => {
      const result = String(reader.result);
      const separator = result.indexOf(",");
      if (separator < 0) {
        reject(new Error(`Could not encode ${file.name}.`));
        return;
      }
      resolve({
        name: file.name,
        mimeType: file.type,
        base64: result.slice(separator + 1)
      });
    });
    reader.readAsDataURL(file);
  });
}

function loadedScreenshotFile(screenshot) {
  const binary = atob(screenshot.base64);
  const bytes = Uint8Array.from(
    binary,
    (character) => character.charCodeAt(0)
  );
  return new File([bytes], screenshot.name, {
    type: screenshot.mimeType,
    lastModified: Date.now()
  });
}

document.querySelectorAll("input[name='intakeSource']").forEach((input) => {
  input.addEventListener("change", () => {
    azureDevOpsIntake.hidden = selectedIntakeSource() !== "azure-devops";
  });
});

loadWorkItemButton.addEventListener("click", async () => {
  formError.textContent = "";
  loadWorkItemButton.disabled = true;
  try {
    const inputs = workItemInputs(workItemInput.value);
    if (inputs.length < 1 || inputs.length > 20) {
      throw new Error("Enter between 1 and 20 unique Azure DevOps IDs or URLs.");
    }
    const body = await fetchJson("/api/azure-devops/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItems: inputs })
    });
    const loadedScreenshots = body.workItems.flatMap(
      (workItem) => workItem.screenshots ?? []
    );
    loadedWorkItems = body.workItems.map(
      ({ screenshots = [], ...workItem }) => ({
        ...workItem,
        imageCount: screenshots.length
      })
    );
    addScreenshots(loadedScreenshots.map(loadedScreenshotFile));
    renderWorkItems(loadedWorkItems);
    requestInput.value = workItemsRequest(loadedWorkItems);
  } catch (error) {
    loadedWorkItems = [];
    workItemSummary.hidden = true;
    formError.textContent = error.message;
  } finally {
    loadWorkItemButton.disabled = false;
  }
});

screenshotInput.addEventListener("change", () => {
  formError.textContent = "";
  try {
    const files = [...screenshotInput.files];
    addScreenshots(files);
    showScreenshotResult(
      `${files.length} screenshot(s) attached. ${selectedScreenshots.length} of ${maxScreenshots} selected.`
    );
  } catch (error) {
    formError.textContent = error.message;
    showScreenshotResult(error.message, true);
  } finally {
    screenshotInput.value = "";
  }
});

document.addEventListener("paste", async (event) => {
  const fileItems = [...(event.clipboardData?.items ?? [])].filter(
    (item) => item.kind === "file"
  );
  const items = fileItems.filter(
    (item) => item.kind === "file" && item.type.startsWith("image/")
  );
  if (items.length === 0) {
    if (fileItems.length > 0) {
      showScreenshotResult(
        "The pasted file is not recognized as an image. Paste a PNG, JPEG, or WebP screenshot.",
        true
      );
    }
    return;
  }
  event.preventDefault();
  formError.textContent = "";
  try {
    const files = items
    .map((item) => item.getAsFile())
      .filter(Boolean);
    addScreenshots(
      await Promise.all(files.map(convertClipboardScreenshot))
    );
    showScreenshotResult(
      `${files.length} pasted screenshot(s) attached. ${selectedScreenshots.length} of ${maxScreenshots} selected.`
    );
  } catch (error) {
    const message =
      error.message || "The clipboard image could not be added.";
    formError.textContent = message;
    showScreenshotResult(message, true);
  }
});

async function refresh() {
  try {
    const body = await fetchJson("/api/status");
    const instanceChanged = dashboardInstanceId !== body.instanceId;
    dashboardInstanceId = body.instanceId;
    if (instanceChanged && repositoryCatalog.length) {
      renderRepositoryCatalog();
    }
    activeJob = body.job;
    if (currentJobDialog.open) {
      selectedJobId = activeJob?.id ?? null;
    }
    rememberJob(activeJob);
    for (const queuedJob of body.queue) {
      const existing = observedJobs.get(queuedJob.id);
      observedJobs.set(
        queuedJob.id,
        queuedJobView(existing ? { ...existing, ...queuedJob } : queuedJob)
      );
    }
    for (const historicalJob of body.history ?? []) {
      rememberJob(historicalJob);
    }
    for (const heldJob of body.held ?? []) {
      rememberJob(heldJob);
    }
    if (!selectedJobId || !observedJobs.has(selectedJobId)) {
      selectedJobId = activeJob?.id ?? null;
    }
    renderRuntime(body.runtime);
    renderReadiness(body.readiness);
    renderJob(draftingConversation ? null : observedJobs.get(selectedJobId) ?? activeJob, activeJob);
    renderQueue(activeJob, body.queue, body.held, body.history);
    const memoryEmpty = document.querySelector("#repository-memory-empty");
    memoryEmpty.hidden = !body.historyWarning && document.querySelector("#repository-memory-list").childElementCount > 0;
    memoryEmpty.textContent = body.historyWarning || "Completed work will appear here for this repository.";
  } catch (error) {
    formError.textContent = error.message;
  }
}

async function refreshMetrics() {
  try {
    const body = await fetchJson(
      `/api/metrics?period=${encodeURIComponent(metricsPeriod.value)}`
    );
    renderMetrics(body.metrics, body.warning);
  } catch (error) {
    formError.textContent = error.message;
  }
}

metricsPeriod.addEventListener("change", refreshMetrics);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  formError.textContent = "";
  startButton.disabled = true;
  const replySelection = composerQuestionSelection;
  try {
    if (replySelection) {
      if (runtimeSelection?.key !== replySelection.key ||
          dashboardInstanceId !== replySelection.instanceId ||
          activeJob?.id !== replySelection.jobId) {
        throw new Error("The question changed. Review the current request before replying.");
      }
      if (selectedScreenshots.length) {
        throw new Error("Question replies support text only. Remove the images before replying, or choose New conversation to start a separate job.");
      }
      composerReplyResult.hidden = true;
      if (!await respondToRuntime("answer", undefined, undefined, requestInput.value)) {
        throw new Error(runtimeMessage.textContent || "The reply was not accepted. Review the current question before retrying.");
      }
      composerReplyResult.classList.remove("error");
      composerReplyResult.textContent = "Reply sent to the current run. No new job was created.";
      composerReplyResult.hidden = false;
      return;
    }
    const data = new FormData(form);
    const reviewedPostEnvironment = postCheckboxEnvironment;
    const reviewedPostScope = postCheckboxScope;
    const allowAllTools = data.get("allowAllTools") === "on";
    if (allowAllTools && !window.confirm(
      "Allow all reviewable tool commands for this run? Commands can access or change files and contact services without individual approval prompts. This is privileged execution, not a sandbox. Organization policy, sensitive/escalated requests, sign-in, publication consent and required checks remain separate. Retries and later jobs require a new opt-in."
    )) {
      startButton.disabled = false;
      return;
    }
    const intakeSource = data.get("intakeSource");
    if (intakeSource === "azure-devops" && loadedWorkItems.length === 0) {
      throw new Error("Load one or more Azure DevOps work items before starting.");
    }
    const screenshots = await Promise.all(
      validateSelectedScreenshots().map(fileBase64)
    );
    if (data.get("allowPostRequests") === "on" &&
        (reviewedPostEnvironment !== postCheckboxEnvironment || reviewedPostScope !== postCheckboxScope ||
          allowPostRequestsInput.disabled || !allowPostRequestsInput.checked)) {
      throw new Error("The POST approval scope changed. Review the current environment and approve it again.");
    }
    const body = await fetchJson("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: data.get("request"),
        requestType: data.get("requestType"),
        model: data.get("model") ?? "",
        mode: data.get("mode"),
        validationIntent: data.get("validationIntent") || undefined,
        deferValidation: data.get("deferValidation") === "on",
        skipLiveTests: data.get("skipLiveTests") === "on",
        useDeployedBackend: data.get("useDeployedBackend") === "on",
        toolApprovalMode: allowAllTools ? "allow-all" : "ask",
        allowAllConfirmed: allowAllTools,
        routineFileAccess: data.get("routineFileAccess") === "on",
        inputTokenLimit: Number(data.get("inputTokenLimit") ?? 0),
        pullRequestStrategy: data.get("separatePullRequests") === "on"
          ? "per-bug"
          : "common",
        runAllUiScenarios: data.get("runAllUiScenarios") === "on",
        targetEnvironment: data.get("targetEnvironment"),
        testMutationMode: data.get("testMutationMode") ?? "",
        allowPostRequests: !allowPostRequestsInput.disabled && data.get("allowPostRequests") === "on",
        postWriteApprovalConfirmed: !allowPostRequestsInput.disabled && data.get("allowPostRequests") === "on",
        postBaseApprovalConfirmed: !allowPostRequestsInput.disabled && reviewedPostScope === "base" && data.get("allowPostRequests") === "on",
        allowDevWrites: !allowDevWritesInput.disabled && postCheckboxEnvironment === "dev" && data.get("allowDevWrites") === "on",
        devWriteApprovalConfirmed: !allowDevWritesInput.disabled && postCheckboxEnvironment === "dev" && data.get("allowDevWrites") === "on",
        allowPpeWrites: !allowDevWritesInput.disabled && postCheckboxEnvironment === "ppe" && data.get("allowDevWrites") === "on",
        ppeWriteApprovalConfirmed: !allowDevWritesInput.disabled && postCheckboxEnvironment === "ppe" && data.get("allowDevWrites") === "on",
        prestartFrontend: data.get("prestartFrontend") === "on",
        recordPlaywrightVideo:
          data.get("recordPlaywrightVideo") === "on",
        manualLocalhostTest:
          data.get("manualLocalhostTest") === "on",
        intakeSource,
        workItems: intakeSource === "azure-devops" ? loadedWorkItems : [],
        screenshots
      })
    });
    requestInput.value = "";
    form.querySelector('[name="allowAllTools"]').checked = false;
    for (const name of ["deferValidation", "skipLiveTests", "useDeployedBackend"]) {
      form.querySelector(`[name="${name}"]`).checked = false;
    }
    allowPostRequestsInput.checked = false;
    allowDevWritesInput.checked = false;
    postCheckboxEnvironment = null;
    updatePostRequestsOption();
    requestInput.focus();
    selectedScreenshots = [];
    renderScreenshots();
    showScreenshotResult("");
    draftingConversation = false;
    activeJob = body.job;
    selectedJobId = body.job?.id ?? null;
    rememberJob(body.job);
    renderJob(body.job, activeJob);
    renderQueue(activeJob, body.queue, body.held, body.history);
    await refreshMetrics();
  } catch (error) {
    formError.textContent = error.message;
    if (replySelection) {
      composerReplyResult.textContent = error.message;
      composerReplyResult.classList.add("error");
      composerReplyResult.hidden = false;
    }
    startButton.disabled = false;
  }
});

cancelQueuedJobButton.addEventListener("click", async () => {
  jobInputMessage.textContent = "";
  formError.textContent = "";
  const selectedJob = observedJobs.get(selectedJobId);
  if (!selectedJob || selectedJob.status !== "queued") {
    formError.textContent = "Select a waiting job to remove.";
    return;
  }
  if (
    !window.confirm(
      "Remove this waiting job from the queue? It will not run, its screenshot artifacts will be deleted, and it will remain visible as cancelled in history."
    )
  ) {
    return;
  }
  cancelQueuedJobButton.disabled = true;
  try {
    const body = await fetchJson("/api/jobs/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: selectedJob.id })
    });
    if (body.cancelledJob) {
      rememberJob(body.cancelledJob);
    }
    activeJob = body.job;
    selectedJobId = body.cancelledJob?.id ?? body.job?.id ?? null;
    const history = body.cancelledJob &&
        !(body.history ?? []).some((job) => job.id === body.cancelledJob.id)
      ? [body.cancelledJob, ...(body.history ?? [])]
      : body.history;
    renderJob(
      observedJobs.get(selectedJobId) ?? body.cancelledJob ?? body.job,
      activeJob
    );
    renderQueue(activeJob, body.queue, body.held, history);
    jobInputMessage.textContent = "Waiting job removed from the queue.";
    await refreshMetrics();
  } catch (error) {
    formError.textContent = error.message;
    cancelQueuedJobButton.disabled = false;
  }
});

holdJobButton.addEventListener("click", async () => {
  const selectedJob = observedJobs.get(selectedJobId);
  if (!selectedJob?.id) {
    jobControlsMessage.textContent = "Select a running or waiting job to hold.";
    return;
  }
  if (
    !window.confirm(
      "Hold this job? FixLab will stop only its owned executor, preserve its workflow state, and continue the waiting queue."
    )
  ) {
    return;
  }
  holdJobButton.disabled = true;
  jobControlsMessage.textContent = "";
  try {
    await fetchJson("/api/jobs/hold", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: selectedJob.id })
    });
    selectedJobId = selectedJob.id;
    jobControlsMessage.textContent =
      "Hold accepted. The job remains available under Held jobs.";
    await refresh();
    await refreshMetrics();
  } catch (error) {
    jobControlsMessage.textContent = error.message;
    holdJobButton.disabled = false;
  }
});

resumeHeldJobButton.addEventListener("click", async () => {
  const selectedJob = observedJobs.get(selectedJobId);
  if (!selectedJob?.id || selectedJob.status !== "held") {
    jobControlsMessage.textContent = "Select a held job to resume.";
    return;
  }
  resumeHeldJobButton.disabled = true;
  jobControlsMessage.textContent = "";
  try {
    const body = await fetchJson("/api/jobs/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: selectedJob.id })
    });
    selectedJobId = body.resumedJob?.id ?? selectedJob.id;
    jobControlsMessage.textContent = body.queued
      ? "Held job returned to the waiting queue."
      : "Held job resumed in the same session.";
    await refresh();
    await refreshMetrics();
  } catch (error) {
    jobControlsMessage.textContent = error.message;
    resumeHeldJobButton.disabled = false;
  }
});

restartJobButton.addEventListener("click", async () => {
  const selectedJob = observedJobs.get(selectedJobId);
  if (!selectedJob?.id) {
    jobControlsMessage.textContent = "Select a terminal job to restart.";
    return;
  }
  if (
    !window.confirm(
      "Restart this retained job from intake? FixLab will create a new job and session while preserving the original outcome in history."
    )
  ) {
    return;
  }
  restartJobButton.disabled = true;
  jobControlsMessage.textContent = "";
  try {
    const body = await fetchJson("/api/jobs/restart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: selectedJob.id })
    });
    selectedJobId = body.restartedJob?.id ?? body.job?.id ?? null;
    jobControlsMessage.textContent = body.queued
      ? "Restarted job added to the waiting queue."
      : "Restarted job is running from intake.";
    await refresh();
    await refreshMetrics();
  } catch (error) {
    jobControlsMessage.textContent = error.message;
    restartJobButton.disabled = false;
  }
});

purgeJobHistoryButton.addEventListener("click", async () => {
  const olderThanDays = Number(historyRetentionDays.value);
  if (
    !Number.isInteger(olderThanDays) ||
    olderThanDays < 1 ||
    olderThanDays > 3650
  ) {
    jobControlsMessage.textContent =
      "Enter a whole number of days between 1 and 3650.";
    return;
  }
  if (
    !window.confirm(
      `Delete completed job history older than ${olderThanDays} day(s)? Active, waiting, and held jobs are never deleted.`
    )
  ) {
    return;
  }
  purgeJobHistoryButton.disabled = true;
  jobControlsMessage.textContent = "";
  try {
    const body = await fetchJson("/api/history/purge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ olderThanDays })
    });
    jobControlsMessage.textContent =
      `${body.deleted} completed job(s) deleted from retained history.`;
    await refresh();
  } catch (error) {
    jobControlsMessage.textContent = error.message;
  } finally {
    purgeJobHistoryButton.disabled = false;
  }
});

jobInputSubmit.addEventListener("click", async () => {
  jobInputMessage.textContent = "";
  formError.textContent = "";
  jobInputSubmit.disabled = true;
  try {
    const action = jobInputAction.value;
    const details =
      jobInputDetails.value.trim() ||
      (action === "continue"
        ? "Resume the same FixLab session from its retained workflow state and continue the remaining required stages."
        : "");
    if (!details) {
      throw new Error("Enter the additional details or manual result.");
    }
    const body = await fetchJson("/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        details,
        ...(sourceEditAuthorizationSelection && sourceEditAuthorizationSelection.instanceId === dashboardInstanceId &&
            sourceEditAuthorizationSelection.jobId === activeJob?.id &&
            details === sourceEditAuthorizationSelection.authorization
          ? {
            confirmed: true,
            instanceId: sourceEditAuthorizationSelection.instanceId,
            jobId: sourceEditAuthorizationSelection.jobId,
            sourceEditReviewId: sourceEditAuthorizationSelection.requestId
          } : {})
      })
    });
    sourceEditAuthorizationSelection = null;
    jobInputDetails.value = "";
    jobInputMessage.textContent =
      body.queued
        ? "Comment queued for the current session."
        : "Input accepted. FixLab resumed the same session.";
    renderJob(body.job);
  } catch (error) {
    formError.textContent = error.message;
    jobInputSubmit.disabled = false;
  }
});

dismissFailedJobButton.addEventListener("click", async () => {
  jobInputMessage.textContent = "";
  formError.textContent = "";
  if (
    !window.confirm(
      `Dismiss this ${activeJob?.status === "blocked" ? "blocked" : "failed"} job? It will remain ${activeJob?.status === "blocked" ? "blocked" : "failed"} in dashboard history, its session will not resume, and the next queued job will start.`
    )
  ) {
    return;
  }
  dismissFailedJobButton.disabled = true;
  try {
    const body = await fetchJson("/api/job/dismiss", {
      method: "POST"
    });
    jobInputMessage.textContent = body.job
      ? "Job dismissed. The next queued job has started."
      : "Job dismissed. The queue is empty.";
    if (body.dismissedJob) {
      rememberJob(body.dismissedJob);
    }
    activeJob = body.job;
    selectedJobId = body.job?.id ?? body.dismissedJob?.id ?? null;
    if (body.job) {
      rememberJob(body.job);
    }
    renderJob(body.job, activeJob);
    renderQueue(activeJob, body.queue, body.held, body.history);
    await refreshMetrics();
  } catch (error) {
    formError.textContent = error.message;
    dismissFailedJobButton.disabled = false;
  }
});

openManualLocalhostButton.addEventListener("click", () => {
  formError.textContent = "";
  const url = activeJob?.manualLocalhostUrl;
  if (!url) {
    formError.textContent =
      "The repository profile does not provide a React localhost URL.";
    return;
  }
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) {
    formError.textContent =
      "The browser blocked the localhost tab. Allow pop-ups and try again.";
  }
});

async function submitManualLocalhostResult(passed) {
  jobInputMessage.textContent = "";
  formError.textContent = "";
  passManualLocalhostButton.disabled = true;
  failManualLocalhostButton.disabled = true;
  try {
    const body = await fetchJson("/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: passed ? "manual-pass" : "manual-fail"
      })
    });
    jobInputMessage.textContent = passed
      ? "Manual localhost validation passed. FixLab is closing the gate."
      : "Manual localhost validation failed. FixLab is recording the failure and stopping its frontend.";
    activeJob = body.job;
    selectedJobId = body.job?.id ?? selectedJobId;
    rememberJob(body.job);
    renderJob(body.job, activeJob);
  } catch (error) {
    formError.textContent = error.message;
    passManualLocalhostButton.disabled = false;
    failManualLocalhostButton.disabled = false;
  }
}

passManualLocalhostButton.addEventListener("click", () =>
  submitManualLocalhostResult(true)
);
failManualLocalhostButton.addEventListener("click", () =>
  submitManualLocalhostResult(false)
);

async function retryLiveTest() {
  jobInputMessage.textContent = "";
  formError.textContent = "";
  retryLiveTestButton.disabled = true;
  try {
    const body = await fetchJson("/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "retry",
        details:
          activeJob?.mode === "playwright-only"
            ? "Retry only the browser-validation prerequisite and focused Playwright journey using the retained same-job script, selected environment and existing authentication. Do not retry an unchanged profile lock, copy browser state, delete a script still needed for continuation, change product source, or perform PR work. Report unavailable browser prerequisites as blocked and non-browser stages as skipped."
            : "Reuse the repository-profile-defined browser authentication and all completed diagnosis, fix, review, and local validation evidence. Rerun only the blocked Playwright live-test gate using the profile-defined browser and test command, save at least one non-sensitive screenshot using page.screenshot({ path, fullPage: true }) under the profile-defined working directory's test-results folder after masking sensitive regions, emit the terminal live-test result, and continue to pull-request creation. Do not skip the live-test or PR stage."
      })
    });
    jobInputMessage.textContent =
      "Playwright retry started in the same FixLab session.";
    activeJob = body.job;
    selectedJobId = body.job?.id ?? selectedJobId;
    rememberJob(body.job);
    renderJob(body.job, activeJob);
  } catch (error) {
    formError.textContent = error.message;
    retryLiveTestButton.disabled = false;
  }
}

retryLiveTestButton.addEventListener("click", retryLiveTest);

connectRetryLiveTestButton.addEventListener("click", async () => {
  jobInputMessage.textContent = "";
  formError.textContent = "";
  connectRetryLiveTestButton.disabled = true;
  try {
    pendingRetryAfterConnectJobId = activeJob?.id ?? null;
    await startFrontend();
    renderPlaywrightStatus(
      await fetchJson("/api/playwright/connect", { method: "POST" })
    );
    jobInputMessage.textContent =
      "Sign in in the Edge window that opened. FixLab retries the live test automatically when authentication completes.";
  } catch (error) {
    pendingRetryAfterConnectJobId = null;
    formError.textContent = error.message;
    connectRetryLiveTestButton.disabled = false;
    await refreshPlaywrightStatus();
  }
});

skipLiveTestButton.addEventListener("click", async () => {
  jobInputMessage.textContent = "";
  formError.textContent = "";
  skipLiveTestButton.disabled = true;
  try {
    const body = await fetchJson("/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "skip",
        details:
          activeJob?.mode === "playwright-only"
            ? "The user explicitly chose to skip the blocked browser validation. Mark live-test skipped, retain the exact unverified risk and missing browser evidence, and leave diagnosis, reproduce, fix, review and pr skipped. Do not claim validation passed or perform implementation or PR work."
            : "The user explicitly chose to skip only the blocked authenticated Playwright live-test gate. Mark live-test skipped, preserve the exact unverified browser risk and missing screenshot evidence, do not report it as passed, and continue the safe pull-request outcome according to repository policy without repeating completed work."
      })
    });

    jobInputMessage.textContent =
      "Playwright live test skipped with risk preserved.";
    activeJob = body.job;
    selectedJobId = body.job?.id ?? selectedJobId;
    rememberJob(body.job);
    renderJob(body.job, activeJob);
  } catch (error) {
    formError.textContent = error.message;
    skipLiveTestButton.disabled = false;
  }
});

approvePullRequestButton.addEventListener("click", async () => {
  jobInputMessage.textContent = "";
  formError.textContent = "";
  approvePullRequestButton.disabled = true;
  try {
    const body = await fetchJson("/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "continue",
        details:
          "I explicitly approve creating or updating the pull request for the validated fixes in this FixLab job. Reuse the existing configured user-owned branch and all completed evidence. Do not repeat diagnosis, builds, or Playwright unless a new change requires validation. Create no deployment."
      })
    });
    jobInputMessage.textContent =
      "Pull-request approval accepted. FixLab is creating or updating the PR.";
    activeJob = body.job;
    selectedJobId = body.job?.id ?? selectedJobId;
    rememberJob(body.job);
    renderJob(body.job, activeJob);
  } catch (error) {
    formError.textContent = error.message;
    approvePullRequestButton.disabled = false;
  }
});

playwrightCheck.addEventListener("click", refreshPlaywrightStatus);
playwrightEvidenceRefresh.addEventListener(
  "click",
  refreshPlaywrightEvidence
);

playwrightConnect.addEventListener("click", async () => {
  formError.textContent = "";
  playwrightConnect.disabled = true;
  try {
    await startFrontend();
    renderPlaywrightStatus(
      await fetchJson("/api/playwright/connect", { method: "POST" })
    );
  } catch (error) {
    formError.textContent = error.message;
    await refreshPlaywrightStatus();
  }
});

onboardingSave.addEventListener("click", async () => {
  onboardingSave.disabled = true;
  onboardingMessage.textContent = "";
  try {
    const body = await fetchJson("/api/onboarding/azure-devops", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organization: onboardingOrganization.value,
        project: onboardingProject.value
      })
    });
    onboardingOrganization.value = body.azureDevOps.organization;
    onboardingProject.value = body.azureDevOps.project;
    onboardingStatus.className = "badge passed";
    onboardingStatus.textContent = "Configured";
    onboardingMessage.textContent =
      "Onboarding settings saved. Numeric work item loading is ready.";
  } catch (error) {
    onboardingStatus.className = "badge blocked";
    onboardingStatus.textContent = "Save failed";
    onboardingMessage.textContent = error.message;
  } finally {
    onboardingSave.disabled = false;
  }
});

refresh();
refreshMetrics();
refreshPlaywrightStatus();
refreshFrontendStatus();
refreshPlaywrightEvidence();
refreshOnboarding();
void refreshRepositories();
setInterval(refresh, 1000);
setInterval(refreshMetrics, 5000);
setInterval(refreshPlaywrightStatus, 5000);
setInterval(refreshFrontendStatus, 5000);
void refreshSessions();
setInterval(refreshSessions, 5000);
setInterval(refreshPlaywrightEvidence, 10000);
