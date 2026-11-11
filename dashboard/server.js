import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:http";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep
} from "node:path";
import {
  createAzureDevOpsLoader,
  loadRepositoryProfile,
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOT_TOTAL_BYTES,
  MAX_SCREENSHOTS,
  pruneArtifactDirectories,
  removeArtifactDirectory,
  storeScreenshots
} from "./intake.js";
import { formatPreflightFailure } from "./preflight.js";
import { createSessionRegistry } from "./sessions.js";
import { inspectBrowserProfileOwnership } from "./browser-ownership.js";
import { canonicalExecutionRepository, createExecutorLease } from "./executor-lease.js";
import { spawnWindowsExecutor } from "./windows-executor.js";
import { createRuntimeRequestBridge, MAX_RUNTIME_FRAME_BYTES, recordedSourceEditReview, runtimeConversationQuestion, safeRuntimeText, sourceEditAuthorization, validateRuntimeUsage, validateToolApprovalMode } from "./runtime-requests.js";
import { validateJobFileAccess } from "./runtime-permission-policy.js";
import { configuredWorkflow, efficientWorkflowGuidance, allowsDraftIntegrationDeferral, allowsUnverifiedDraft, UNVERIFIED_DRAFT_GUIDANCE, OPTIONAL_INTEGRATION_GUIDANCE, AUTONOMOUS_RECOVERY_GUIDANCE, DRAFT_INTEGRATION_GUIDANCE, COPILOT_EXECUTION_GUIDANCE, RUNTIME_RECOVERY_GUIDANCE, READ_ONLY_POST_GUIDANCE, EXISTING_APPLICATION_GUIDANCE, API_ONLY_PLAYWRIGHT_GUIDANCE, UNIT_TEST_ONLY_GUIDANCE, TRANSIENT_PLAYWRIGHT_GUIDANCE, PORTAL_SCREENSHOT_GUIDANCE, CONCISE_PR_GUIDANCE, PR_LEARNING_GUIDANCE } from "./workflow-policy.js";
import { componentRetrievalGuidance } from "./affected-surface.js";
import { apiAuthenticationConfiguration } from "./api-authentication.js";
import { createDevWriteApproval, createPpeWriteApproval, createPostBaseApproval, createPostWriteApproval, inspectPpeWriteConfiguration, inspectPostBaseConfiguration, isOriginWriteApproval } from "./dev-post.js";
import { browserConfigurationErrors } from "./repository-setup.js";
import { applyRepositorySettings, inspectRepositorySettings, localRepository, planRepositorySettings } from "./repository-settings.js";
import { configuredLinkedApplications, resolveLinkedApplications } from "./linked-applications.js";
import { linkedApiProofPlan } from "./linked-api-proof.js";
import { portalApiProofRevision } from "./portal-api-proof.js";
import { prepareSharedWorktree, reviewSharedWorktree, sharedWorktreeConfig, sharedWorktreeGuidance, stashReviewedSharedWorktree, verifySharedWorktreeBranch } from "./shared-worktree.js";
import { compactControlResult, conversationOperations } from "./conversation-operations.js";
const windowsOwnedTrees = new WeakMap();
import { ValidationSession, validationGates, selectedValidationGates, defaultValidationIntent } from "./validation-gates.js";
import { repositoryState } from "../bin/structured-command.js";
import {
  newPermissionRequest,
  permissionRequest,
  PERMISSION_BLOCKED_MESSAGE,
  reviewPermissionDirectory,
  runtimePermissionDenialLine,
  verifyPermissionDirectory
} from "./runtime-permissions.js";

export const DASHBOARD_HOST = "127.0.0.1";
export const DEFAULT_DASHBOARD_PORT = 4317;
export const MAX_JOB_LOG_ENTRIES = 1000;
export const MAX_JOB_ACTIVITY_ENTRIES = 40;
export const MAX_CACHE_ENTRIES = 20;
export const MAX_CACHE_BYTES = 64 * 1024;
export const MAX_METRICS_ENTRIES = 500;
export const MAX_DASHBOARD_HISTORY_ENTRIES = 20;
export const MAX_QUEUED_JOBS = 20;
export const MAX_PLAYWRIGHT_ARTIFACTS = 20;

function sameExistingRepository(value, root) {
  try {
    return realpathSync.native(value) === root;
  } catch (error) {
    if (error.code === "ENOENT") { return false; }
    throw error;
  }
}

function validatedManualLocalhostUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("manual localhost URL is required");
  }
  const trimmed = value.trim();
  const url = new URL(trimmed);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "manual localhost URL must use credential-free HTTP(S) on loopback"
    );
  }
  return trimmed;
}

export function openLocalUrl(
  value,
  { platform = process.platform, spawnImpl = spawn } = {}
) {
  const url = new URL(validatedManualLocalhostUrl(value));

  const launchers = {
    win32: ["explorer.exe", [url.href]],
    darwin: ["open", [url.href]],
    linux: ["xdg-open", [url.href]]
  };
  const launcher = launchers[platform];
  if (!launcher) {
    throw new Error(`opening a browser is not supported on ${platform}`);
  }
  return new Promise((resolveLaunch, rejectLaunch) => {
    const child = spawnImpl(launcher[0], launcher[1], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.once("spawn", () => {
      child.unref?.();
      resolveLaunch();
    });
    child.once("error", rejectLaunch);
  });
}
export const MAX_PLAYWRIGHT_VIDEO_BYTES = 50 * 1024 * 1024;
export const DEFAULT_EXECUTION_IDLE_TIMEOUT_MS = 20 * 60 * 1000;
export const DEFAULT_EXECUTION_HEARTBEAT_MS = 2 * 60 * 1000;
export const FIXLAB_RUNTIMES = ["agency", "copilot"];
export const HYDRAFUSION_MODEL = "hydrafusion";

export function validateCopilotModel(value, runtime = "copilot") {
  if (value !== null && value !== undefined && typeof value !== "string") {
    throw new Error("model must be a string");
  }
  const model = String(value ?? "").trim();
  if (!model) {
    return "";
  }
  if (runtime !== "copilot") {
    throw new Error("model selection requires the copilot runtime");
  }
  if (model.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(model)) {
    throw new Error("model must be 1-128 letters, numbers, dots, underscores, slashes, or hyphens");
  }
  return model.toLowerCase() === HYDRAFUSION_MODEL ? HYDRAFUSION_MODEL : model;
}

export function copilotModelArguments(model) {
  const selectedModel = validateCopilotModel(model);
  return selectedModel
    ? [...(selectedModel === HYDRAFUSION_MODEL ? ["--experimental"] : []), "--model", selectedModel]
    : [];
}
export const FIXLAB_STAGES = [
  "intake",
  "diagnosis",
  "reproduce",
  "fix",
  "review",
  "local-stack",
  "live-test",
  "pr"
];

const terminalStatuses = new Set(["passed", "skipped", "blocked", "failed"]);
const allStatuses = new Set(["pending", "running", ...terminalStatuses]);
const bugOutcomeStatuses = new Set([
  "fixed",
  "already-fixed",
  "external",
  "no-change",
  "expected",
  "duplicate",
  "blocked",
  "failed"
]);
const testDataSources = new Set([
  "synthetic-intercepted",
  "local-fixture",
  "non-production-read-only",
  "production-read-only",
  "non-production-approved",
  "profile-defined"
]);
const mutationModes = new Set([
  "intercepted",
  "none",
  "approved-write",
  "profile-defined"
]);
const profileRelativePath = join(
  ".github",
  "fixlab",
  "repository-profile.json"
);
const staticFiles = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/app.js", "app.js"],
  ["/work-item-intake.js", "work-item-intake.js"],
  ["/repository-workspace.js", "repository-workspace.js"],
  ["/styles.css", "styles.css"]
]);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};

export function validatePort(value) {
  const text = String(value);
  if (!/^\d+$/.test(text)) {
    throw new Error("dashboard port must be an integer between 1 and 65535");
  }
  const port = Number(text);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("dashboard port must be an integer between 1 and 65535");
  }
  return port;
}

export function validateLiveTestProfile(profile, repository) {
  const missing = [];
  let gates;
  if (repository) {
    missing.push(...browserConfigurationErrors(profile, repository));
  }
  try {
    gates = validationGates(profile ?? {}, "validate-only");
    configuredLinkedApplications(profile);
  } catch (error) {
    missing.push(error.message);
  }
  const browserAutomation = profile?.browserAutomation;
  const apiOnly = browserAutomation?.mode === "api";
  const applicationName = apiOnly ? "backend" : "frontend";
  const application = profile?.applications?.[applicationName];
  const authentication = browserAutomation?.authentication;
  const dataSafety = browserAutomation?.dataSafety;
  const testSynthesis = browserAutomation?.testSynthesis;
  const agentIdleTimeoutMinutes =
    profile?.validation?.agentIdleTimeoutMinutes;
  const requiredString = (value) =>
    typeof value === "string" && Boolean(value.trim());

  if (profile?.validation?.liveTestsRequired !== undefined &&
      typeof profile.validation.liveTestsRequired !== "boolean") {
    missing.push("validation.liveTestsRequired (boolean)");
  }
  if (
    agentIdleTimeoutMinutes !== undefined &&
    (!Number.isInteger(agentIdleTimeoutMinutes) ||
      agentIdleTimeoutMinutes < 1 ||
      agentIdleTimeoutMinutes > 120)
  ) {
    missing.push(
      "validation.agentIdleTimeoutMinutes (integer from 1 to 120)"
    );
  }

  if (profile?.validation?.liveTestsRequired === false) {
    if (!requiredString(profile.validation.liveTestsDeferredReason) ||
        profile.validation.liveTestsDeferredReason.length > 500) {
      missing.push("validation.liveTestsDeferredReason (1-500 characters)");
    }
    if (browserAutomation !== undefined) {
      missing.push("unit-test-only profiles must omit browserAutomation");
    }
    if (!gates?.some((gate) => gate.required && gate.kind === "tests" && gate.stage !== "live-test")) {
      missing.push("unit-test-only validation requires a required local tests gate");
    }
    if (gates?.some((gate) => gate.stage === "live-test")) {
      missing.push("unit-test-only validation cannot configure live-test gates");
    }
    return {
      ok: missing.length === 0,
      detail: missing.length ? `missing or invalid: ${missing.join(", ")}`
        : "local unit-test gates configured; live tests explicitly deferred"
    };
  }

  if (browserAutomation?.mode !== undefined &&
      !["browser", "api"].includes(browserAutomation.mode)) {
    missing.push("browserAutomation.mode (browser or api)");
  }

  if (!application || typeof application !== "object" || Array.isArray(application)) {
    missing.push(`applications.${applicationName}`);
  } else {
    if (!requiredString(application.workingDirectory)) {
      missing.push(`applications.${applicationName}.workingDirectory`);
    }
    if (!requiredString(application.command)) {
      missing.push(`applications.${applicationName}.command`);
    }
    if (
      !Number.isInteger(application.port) ||
      application.port < 1 ||
      application.port > 65535
    ) {
      missing.push(`applications.${applicationName}.port`);
    }
    if (!requiredString(application.healthUrl)) {
      missing.push(`applications.${applicationName}.healthUrl`);
    } else {
      try {
        validatedManualLocalhostUrl(application.healthUrl);
      } catch {
        missing.push(
          `applications.${applicationName}.healthUrl (credential-free loopback URL required)`
        );
      }
    }
  }

  if (!browserAutomation || typeof browserAutomation !== "object") {
    missing.push("browserAutomation");
  } else {
    for (const field of ["workingDirectory", "package", ...(!apiOnly ? ["browser"] : []), "testCommand"]) {
      if (!requiredString(browserAutomation[field])) {
        missing.push(`browserAutomation.${field}`);
      }
    }

    if (typeof authentication?.required !== "boolean") {
      missing.push("browserAutomation.authentication.required");
    } else if (authentication.required) {
      if (!requiredString(authentication.command)) {
        missing.push("browserAutomation.authentication.command");
      }
      if (apiOnly && !requiredString(authentication.proofCommand)) {
        missing.push("browserAutomation.authentication.proofCommand (fresh API proof required)");
      }
      if (
        !Array.isArray(authentication.statusPaths) ||
        authentication.statusPaths.length === 0 ||
        authentication.statusPaths.some((value) => !requiredString(value))
      ) {
        missing.push("browserAutomation.authentication.statusPaths");
      } else if (repository) {
        const authenticationRoot = resolve(
          repository,
          browserAutomation.workingDirectory
        );
        const missingStatusPaths = authentication.statusPaths.filter(
          (statusPath) => !existsSync(resolve(authenticationRoot, statusPath))
        );
        if (missingStatusPaths.length > 0) {
          missing.push(
            `browserAutomation authentication is not ready (${missingStatusPaths.join(", ")})`
          );
        }
      }
    }

    if (!requiredString(dataSafety?.policy)) {
      missing.push("browserAutomation.dataSafety.policy");
    }
    if (dataSafety?.productionAllowed !== false) {
      missing.push("browserAutomation.dataSafety.productionAllowed=false");
    }
    if (apiOnly) {
      const origins = dataSafety?.allowedOrigins;
      if (!Array.isArray(origins) || origins.length < 1 || origins.length > 16 ||
          origins.some((value) => {
            try {
              const url = new URL(value);
              return typeof value !== "string" || url.origin !== value ||
                !(url.protocol === "https:" ||
                  (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)));
            } catch {
              return true;
            }
          })) {
        missing.push("browserAutomation.dataSafety.allowedOrigins (1-16 credential-free HTTPS or loopback HTTP origins)");
      }
      const methods = dataSafety?.allowedMethods;
      if (!Array.isArray(methods) || methods.length < 1 ||
          methods.some((value) => !["GET", "HEAD", "OPTIONS"].includes(value))) {
        missing.push("browserAutomation.dataSafety.allowedMethods (read-only GET, HEAD, OPTIONS)");
      }
      const productionDatabaseReadOnly = browserAutomation.apiAuthentication?.productionDatabaseReadOnly === true;
      if (!(productionDatabaseReadOnly ? ["production-read-only"] : ["non-production-read-only", "local-fixture"])
        .includes(testSynthesis?.defaultDataSource) ||
          testSynthesis?.mutationMode !== "none") {
        missing.push("API-only validation requires accurately labeled read-only data and mutationMode=none");
      }
      if (productionDatabaseReadOnly) {
        try {
          const api = apiAuthenticationConfiguration(repository ?? "", browserAutomation.apiAuthentication, { requireHelper: false });
          if (origins?.length !== 1 || origins[0] !== new URL(api.url).origin ||
              new URL(application.healthUrl).origin !== new URL(api.url).origin ||
              authentication?.required !== true) {
            throw new Error("Production database reads require authenticated proof and only the approved local API origin.");
          }
        } catch (error) {
          missing.push(error.message);
        }
      }
    }
    if (testSynthesis === undefined) {
      missing.push("browserAutomation.testSynthesis");
    } else {
      if (testSynthesis?.enabled !== true) {
        missing.push("browserAutomation.testSynthesis.enabled=true");
      }
      if (!testDataSources.has(testSynthesis?.defaultDataSource)) {
        missing.push(
          "browserAutomation.testSynthesis.defaultDataSource"
        );
      }
      if (!mutationModes.has(testSynthesis?.mutationMode)) {
        missing.push("browserAutomation.testSynthesis.mutationMode");
      }
      for (const key of ["devReadOnly", "ppeReadOnly"]) {
        if (testSynthesis?.[key] !== undefined && typeof testSynthesis[key] !== "boolean") {
          missing.push(`browserAutomation.testSynthesis.${key} (boolean)`);
        }
      }
      if (testSynthesis?.requireScenarioEvidence !== true) {
        missing.push(
          "browserAutomation.testSynthesis.requireScenarioEvidence=true"
        );
      }
    }
  }

  return {
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? `${apiOnly ? "API-only backend" : "startup"}, health, Playwright, authentication, and data-safety settings configured`
        : `missing or invalid: ${missing.join(", ")}`
  };
}

export function configuredTestSynthesis(profile, selectedMutationMode = "", allowPostRequests, targetEnvironment = "") {
  if (allowPostRequests !== undefined && typeof allowPostRequests !== "boolean") {
    throw new Error("allowPostRequests must be a boolean.");
  }
  if (allowPostRequests === true &&
      (selectedMutationMode || profile?.validation?.liveTestsRequired === false ||
        profile?.browserAutomation?.mode === "api" ||
        profile?.browserAutomation?.apiAuthentication?.productionDatabaseReadOnly === true)) {
    throw new Error("POST requests cannot override explicit read-only/intercepted, API-only, unit-only or production-backed policy.");
  }
  if (profile?.validation?.liveTestsRequired === false) {
    if (selectedMutationMode) {
      throw new Error("Unit-test-only validation does not permit live mutation-mode selection.");
    }
    return {
      unitTestsOnly: true,
      liveTestsDeferredReason: profile.validation.liveTestsDeferredReason,
      enabled: false,
      source: "profile-defined",
      mutationMode: "none",
      requireScenarioEvidence: false,
      reported: false,
      scenario: ""
    };
  }
  const configuration = profile?.browserAutomation?.testSynthesis;
  for (const key of ["devReadOnly", "ppeReadOnly"]) {
    if (configuration?.[key] !== undefined && typeof configuration[key] !== "boolean") {
      throw new Error(`browserAutomation.testSynthesis.${key} must be a boolean.`);
    }
  }
  const defaultReads = configuration?.enabled !== false && profile?.browserAutomation?.mode !== "api" &&
    !profile?.browserAutomation?.apiAuthentication?.productionDatabaseReadOnly &&
    configuration?.defaultDataSource === "synthetic-intercepted" && configuration?.mutationMode === "intercepted";
  const devReadOnly = defaultReads && configuration?.devReadOnly === true && /^(dev|development)$/i.test(targetEnvironment);
  const ppeReadOnly = defaultReads && configuration?.ppeReadOnly === true && /^ppe$/i.test(targetEnvironment);
  const result = {
    ...(devReadOnly ? { devReadOnly: true } : {}),
    ...(ppeReadOnly ? { ppeReadOnly: true } : {}),
    ...(profile?.browserAutomation?.mode === "api" ? { apiOnly: true } : {}),
    ...(profile?.browserAutomation?.mode === "api" &&
      profile.browserAutomation.apiAuthentication?.productionDatabaseReadOnly === true
      ? { productionDatabaseReadOnly: true } : {}),
    enabled: configuration?.enabled !== false,
    source: devReadOnly || ppeReadOnly ? "non-production-read-only" : testDataSources.has(configuration?.defaultDataSource)
      ? configuration.defaultDataSource
      : "profile-defined",
    mutationMode: mutationModes.has(configuration?.mutationMode)
      ? configuration.mutationMode
      : "profile-defined",
    requireScenarioEvidence:
      configuration?.requireScenarioEvidence !== false,
    reported: false,
    scenario: "",
    ...(typeof allowPostRequests === "boolean" ? { allowPostRequests } : {}),
    ...(selectedMutationMode ? { selectedMutationMode } : {})
  };
  if ((result.source === "production-read-only") !== (result.productionDatabaseReadOnly === true) ||
      (result.productionDatabaseReadOnly && result.mutationMode !== "none")) {
    throw new Error("Production database evidence requires an explicitly approved local API-only read-only profile.");
  }
  if (!["", "intercepted", "none"].includes(selectedMutationMode)) {
    throw new Error("testMutationMode must be empty, intercepted or none. This selector never authorizes real writes.");
  }
  if (result.apiOnly && selectedMutationMode === "intercepted") {
    throw new Error("API-only Playwright validation requires read-only requests; page interception does not protect APIRequestContext.");
  }
  if (selectedMutationMode) {
    const allowed = configuration?.allowedMutationModes;
    if (allowed !== undefined &&
        (!Array.isArray(allowed) || !allowed.includes(selectedMutationMode))) {
      throw new Error("The repository profile does not allow the selected per-run mutation mode.");
    }
    if (selectedMutationMode === "none" &&
        !["non-production-read-only", "non-production-approved",
          ...(result.apiOnly ? ["local-fixture"] : []),
          ...(result.productionDatabaseReadOnly ? ["production-read-only"] : [])].includes(result.source)) {
      throw new Error("Live read-only mode requires a profile that permits non-production backend reads.");
    }
    result.mutationMode = selectedMutationMode;
    if (result.source === "non-production-approved") {
      result.source = "non-production-read-only";
    }
  }
  return result;
}

export function configuredValidationEnvironments(profile) {
  const configured = Array.isArray(profile?.environments)
    ? profile.environments
    : Object.keys(profile?.environments ?? {});
  const environments = [];
  const seen = new Set();
  for (const value of configured) {
    if (typeof value !== "string") {
      continue;
    }
    const environment = value.trim();
    const normalized = environment.toLowerCase();
    if (
      !environment ||
      environment.length > 64 ||
      ["prod", "prd", "production"].includes(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }
    seen.add(normalized);
    environments.push(environment);
  }
  return environments;
}

export function validateTargetEnvironment(value, environments) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  if (typeof value !== "string") {
    throw new Error("targetEnvironment must be a string");
  }
  const requested = value.trim();
  if (["prod", "prd", "production"].includes(requested.toLowerCase())) {
    throw new Error("targetEnvironment must be a non-production environment");
  }
  const selected = environments.find(
    (environment) =>
      environment.toLowerCase() === requested.toLowerCase()
  );
  if (!selected) {
    throw new Error(
      "targetEnvironment must be one of the repository profile environments"
    );
  }
  return selected;
}

function publicQueue(jobs) {
  return jobs.map((job, index) => ({
    id: job.id,
    position: index + 1,
    request: safeSummary(job.request),
    requestType: job.requestType,
    engineeringSummary: job.engineeringSummary ?? null,
    engineeringSummaryOrigin: job.engineeringSummaryOrigin ?? null,
    model: job.model,
    runtime: job.runtime,
    pullRequestStrategy: job.pullRequestStrategy,
    runAllUiScenarios: job.runAllUiScenarios,
    targetEnvironment: job.targetEnvironment,
    sharedWorkspace: job.sharedWorkspace ?? null,
    workspaceReview: job.workspaceReview ?? null,
    workspaceStash: job.workspaceStash ?? null,
    validationIntent: job.validationIntent ?? "full",
    workflow: job.workflow ?? { mode: "strict" },
    prestartFrontend: job.prestartFrontend ?? false,
    deferValidation: job.deferValidation === true,
    skipLiveTests: job.skipLiveTests === true,
    useDeployedBackend: job.useDeployedBackend === true,
    setupRecovery: job.setupRecovery ?? [],
    inputTokenLimit: job.inputTokenLimit ?? 0,
    toolApprovalMode: job.toolApprovalMode ?? "ask",
    postWriteApproved: Boolean(job.postWriteApproval?.revision) &&
      (!isOriginWriteApproval(job.postWriteApproval) || job.postWriteApproval.mode === "post-base"),
    devWriteApproved: Boolean(job.postWriteApproval?.revision) && job.postWriteApproval.mode === "dev-origin",
    ppeWriteApproved: Boolean(job.postWriteApproval?.revision) && job.postWriteApproval.mode === "ppe-origin",
    fileAccess: job.fileAccess ?? null,
    sourceEditReview: recordedSourceEditReview(job.sourceEditReview),
    recordPlaywrightVideo: job.recordPlaywrightVideo,
    manualLocalhostTest: job.manualLocalhostTest,
    manualLocalhostUrl: job.manualLocalhostUrl,
    manualLocalhostOpenedAt: job.manualLocalhostOpenedAt,
    manualLocalhostPending: job.manualLocalhostPending,
    manualLocalhostResult: job.manualLocalhostResult,
    testEvidence: job.testEvidence,
    intakeSource: job.intakeSource,
    mode: job.mode,
    status: job.status,
    bugCount: job.bugs.length,
    bugs: job.bugs,
    screenshotCount: job.screenshots.length,
    stages: job.stages,
    validation: job.validationSession?.summary() ?? null,
    pullRequestReadiness: getPullRequestReadiness(job),
    createdAt: job.createdAt
  }));
}

function publicHeld(jobs) {
  return jobs.map((job) => ({
    ...publicJob(job),
    activity: [],
    logs: []
  }));
}

function publicHistory(jobs) {
  return jobs.map((job) => ({
    ...publicJob(job),
    activity: [],
    logs: []
  }));
}

function safePersistedSummary(value) {
  return safeSummary(value).replace(/https?:\/\/\S+/giu, "[omitted URL]");
}

export function normalizeEngineeringSummary(value) {
  const strings = ["problem", "expectedBehavior", "actualBehavior", "rootCause", "codeFix", "commit"];
  const lists = ["changedFiles", "regression", "risks", "workarounds"];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => ![...strings, ...lists].includes(key))) {
    throw new Error("Engineering summary must contain only the documented bug, fix and evidence fields.");
  }
  const result = {};
  const sanitize = (field, limit) => safeRuntimeText(field, limit)
    ? safeSummary(field, limit).replace(/https?:\/\/\S+/giu, "[omitted URL]")
    : "[Sensitive detail omitted]";
  for (const key of strings) {
    const field = value[key] ?? "";
    if (typeof field !== "string" || field.length > 2000 ||
        (["problem", "rootCause", "codeFix"].includes(key) && !field.trim())) {
      throw new Error(`Engineering summary ${key} must be a bounded string; problem, rootCause and codeFix are required.`);
    }
    if (key === "commit" && field && !/^[a-f0-9]{7,64}$/u.test(field)) {
      throw new Error("Engineering summary commit must be a hexadecimal commit reference.");
    }
    result[key] = sanitize(field, 2000);
  }
  for (const key of lists) {
    const fields = value[key] ?? [];
    if (!Array.isArray(fields) || fields.length > 20 ||
        fields.some((field) => typeof field !== "string" || !field.trim() || field.length > 500)) {
      throw new Error(`Engineering summary ${key} must contain at most 20 bounded strings.`);
    }
    if (key === "changedFiles" && fields.some((field) =>
      /^[\\/]/u.test(field.trim()) || /[:*?"\0\r\n]/u.test(field) ||
      field.trim().replace(/\\/gu, "/").split("/").some((part) =>
        !part.trim() || part.trim() === "." || part.trim() === ".."))) {
      throw new Error("Engineering summary files must be relative paths without traversal.");
    }
    result[key] = fields.map((field) => sanitize(field, 500));
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 16384) {
    throw new Error("Engineering summary exceeds 16 KiB.");
  }
  return result;
}

const ENGINEERING_SUMMARY_GUIDANCE =
  '- At the reviewed fix checkpoint and before finishing, emit FIXLAB_SUMMARY| followed by one-line JSON: problem, expectedBehavior, actualBehavior, rootCause, codeFix (explain the actual change and why), changedFiles[], regression[], risks[], workarounds[], commit (hex or empty). Required: problem, rootCause, codeFix. Use relative file paths, bounded strings, no secrets/private URLs. Preserve the original bug-to-fix explanation across retries; update only for new evidence. Separate historical, skipped and unverified tests from actual passes; report no-change outcomes honestly.';

function dashboardSnapshot(job) {
  return {
    id: job.id,
    request: safePersistedSummary(job.request),
    requestType: job.requestType,
    model: job.model,
    runtime: job.runtime,
    pullRequestStrategy: job.pullRequestStrategy,
    runAllUiScenarios: job.runAllUiScenarios,
    targetEnvironment: job.targetEnvironment,
    prestartFrontend: job.prestartFrontend ?? false,
    deferValidation: job.deferValidation === true,
    skipLiveTests: job.skipLiveTests === true,
    useDeployedBackend: job.useDeployedBackend === true,
    setupRecovery: job.setupRecovery ?? [],
    recordPlaywrightVideo: job.recordPlaywrightVideo,
    manualLocalhostTest: job.manualLocalhostTest,
    manualLocalhostUrl: "",
    manualLocalhostOpenedAt: job.manualLocalhostOpenedAt,
    manualLocalhostPending: job.manualLocalhostPending,
    manualLocalhostResult: job.manualLocalhostResult,
    testEvidence: {
      enabled: job.testEvidence.enabled,
      ...(job.testEvidence.unitTestsOnly === true ? {
        unitTestsOnly: true,
        liveTestsDeferredReason: safePersistedSummary(job.testEvidence.liveTestsDeferredReason)
      } : {}),
      ...(job.testEvidence.apiOnly === true ? { apiOnly: true } : {}),
      ...(job.testEvidence.devReadOnly === true ? { devReadOnly: true } : {}),
      ...(job.testEvidence.ppeReadOnly === true ? { ppeReadOnly: true } : {}),
      ...(job.testEvidence.productionDatabaseReadOnly === true ? { productionDatabaseReadOnly: true } : {}),
      source: job.testEvidence.source,
      mutationMode: job.testEvidence.mutationMode,
      ...(job.testEvidence.selectedMutationMode
        ? { selectedMutationMode: job.testEvidence.selectedMutationMode }
        : {}),
      ...(typeof job.testEvidence.allowPostRequests === "boolean"
        ? { allowPostRequests: job.testEvidence.allowPostRequests }
        : {}),
      requireScenarioEvidence: job.testEvidence.requireScenarioEvidence,
      reported: job.testEvidence.reported,
      scenario: safePersistedSummary(job.testEvidence.scenario)
    },
    branchNaming: job.branchNaming ?? null,
    sharedWorkspace: job.sharedWorkspace ?? null,
    workspaceReview: job.workspaceReview ?? null,
    workspaceStash: job.workspaceStash ?? null,
    validationIntent: job.validationIntent ?? "full",
    validationBaseline: job.validationBaseline ?? null,
    validationHistory: job.validationSession?.executedGates() ?? job.validationHistory ?? null,
    workflow: job.workflow ?? { mode: "strict" },
    intakeSource: job.intakeSource,
    workItem: persistedWorkItem(job.workItem),
    workItems: job.workItems.map(persistedWorkItem),
    mode: job.mode,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    heldAt: job.heldAt ?? null,
    finishedAt: job.finishedAt,
    lastActivityAt: job.lastActivityAt,
    usage: job.usage,
    inputTokenLimit: job.inputTokenLimit ?? 0,
    budgetExceeded: job.budgetExceeded === true,
    toolApprovalMode: "ask",
    fileAccess: job.fileAccess ?? null,
    sourceEditReview: recordedSourceEditReview(job.sourceEditReview),
    browserPreflightBlocked: job.browserPreflightBlocked === true,
    browserSessionNotStarted: job.browserSessionNotStarted === true,
    browserBlocker: job.browserBlocker ?? null,
    error: job.error ? safePersistedSummary(job.error) : null,
    permissionBlocked: Boolean(job.permissionRequest),
    permissionPreflight: job.permissionPreflight === true,
    permissionPreflightReviewed: job.permissionPreflightReviewed === true,
    permissionPreflightPending: job.permissionRequest?.preflight === true,
    stages: Object.fromEntries(
      FIXLAB_STAGES.map((stage) => [
        stage,
        {
          status: job.stages[stage].status,
          message: safePersistedSummary(job.stages[stage].message)
        }
      ])
    ),
    bugs: job.bugs.map((bug) => ({
      id: bug.id,
      outcome: bug.outcome,
      owner: safePersistedSummary(bug.owner),
      summary: safePersistedSummary(bug.summary)
    })),
    engineeringSummary: job.engineeringSummary ?? null,
    engineeringSummaryOrigin: job.engineeringSummaryOrigin ?? null,
    canResume: false,
    canComment: false
  };
}

function initializeJobValidation(job, repository) {
  job.validationSession ??= new ValidationSession(
    repository,
    loadRepositoryProfile(repository),
    job.mode,
    {
      validationIntent: job.validationIntent,
      advisory: job.mode === "fix-and-validate" && job.workflow?.mode === "efficient",
      baseCommit: job.validationBaseline ?? job.sharedWorkspace?.baseCommit ??
        (job.validationRecovered ? null : undefined),
      history: job.validationHistory ?? (job.validationRecovered ? null : undefined)
    }
  );
  job.validationSession.validationIntent =
    job.runAllUiScenarios || job.manualLocalhostTest ? "full" : job.validationIntent;
  job.validationBaseline = job.validationSession.baseCommit;
}

function restoreDashboardJob(snapshot, repository) {
  const profile = loadRepositoryProfile(repository);
  let manualLocalhostUrl = "";
  let manualLocalhostProfileError = false;
  try {
    manualLocalhostUrl = validatedManualLocalhostUrl(
      profile.applications?.frontend?.healthUrl
    );
  } catch {
    manualLocalhostProfileError =
      snapshot.manualLocalhostTest ??
      snapshot.holdForManualLiveTest ??
      false;
  }
  const restored = {
    ...snapshot,
    sourceEditReview: recordedSourceEditReview(snapshot.sourceEditReview),
    ...(profile.browserAutomation?.mode === "api"
      ? { testEvidence: { ...snapshot.testEvidence, apiOnly: true } }
      : {}),
    validationRecovered: true,
    toolApprovalMode: "ask",
    postWriteApproval: null,
    permissionRequest: snapshot.permissionBlocked
      ? newPermissionRequest({ preflight: snapshot.permissionPreflightPending === true })
      : permissionRequest(snapshot.stages),
    runtimeDirectoryGrants: [],
    workflow: configuredWorkflow({ workflow: snapshot.workflow
      ? { publication: "ready", ...snapshot.workflow }
      : { mode: "strict" } }),
    model: snapshot.model ?? "",
    runtime: snapshot.runtime ?? (snapshot.model ? "copilot" : ""),
    manualLocalhostTest:
      snapshot.manualLocalhostTest ??
      snapshot.holdForManualLiveTest ??
      false,
    manualLocalhostUrl,
    manualLocalhostOpenedAt: snapshot.manualLocalhostOpenedAt ?? null,
    manualLocalhostPending:
      snapshot.manualLocalhostPending ??
      (Boolean(
        snapshot.manualLocalhostTest ??
        snapshot.holdForManualLiveTest
      ) &&
        snapshot.stages?.["live-test"]?.status === "blocked" &&
        !snapshot.manualLocalhostResult),
    manualLocalhostResult: snapshot.manualLocalhostResult ?? null,
    workItem: snapshot.workItem ?? null,
    workItems: snapshot.workItems ?? [],
    screenshots: [],
    artifactDirectory: null,
    inputs: [],
    pendingInputs: [],
    usage: retainedUsage(snapshot.usage),
    activity: [],
    logs: [],
    droppedLogs: 0,
    nextLogIndex: 0,
    cacheContext: createCacheContext(repository),
    partial: { stdout: "", stderr: "" }
  };
  if (restored.permissionRequest && restored.status !== "held") {
    restored.status = "blocked";
    restored.error = PERMISSION_BLOCKED_MESSAGE;
  }
  restored.heldAt = snapshot.heldAt ?? null;
  restored.holdRequested = false;
  restored.resumeSession = false;
  if (manualLocalhostProfileError) {
    restored.resumeDisabled = true;
    restored.manualLocalhostPending = false;
    if (!restored.manualLocalhostResult) {
      const message =
        "Manual localhost validation cannot resume because the profile frontend health URL is no longer a safe credential-free loopback URL.";
      restored.status = "failed";
      restored.error = message;
      restored.stages["live-test"] = { status: "failed", message };
    }
  }
  restored.initialPrompt = buildJobPrompt({
    request: restored.request,
    workflow: restored.workflow,
    mode: restored.mode,
    requestType: restored.requestType,
    pullRequestStrategy: restored.pullRequestStrategy,
    runAllUiScenarios: restored.runAllUiScenarios,
    targetEnvironment: restored.targetEnvironment,
    recordPlaywrightVideo: restored.recordPlaywrightVideo,
    manualLocalhostTest: restored.manualLocalhostTest,
    deferValidation: restored.deferValidation === true,
    skipLiveTests: restored.skipLiveTests === true,
    useDeployedBackend: restored.useDeployedBackend === true,
    setupRecovery: restored.setupRecovery ?? [],
    manualLocalhostUrl: restored.manualLocalhostUrl,
    testEvidence: restored.testEvidence,
    branchNaming: restored.branchNaming,
    intakeSource: restored.intakeSource,
    workItem: restored.workItem,
    workItems: restored.workItems,
    screenshotPaths: [],
    cacheSummary: loadCacheSummary(restored.cacheContext)
  });
  return restored;
}

export function recoverInterruptedDashboardJob(
  snapshot,
  recoveredAt = new Date().toISOString()
) {
  if (snapshot?.status === "holding") {
    return {
      ...snapshot,
      status: "held",
      heldAt: snapshot.heldAt ?? recoveredAt,
      finishedAt: null,
      error: null
    };
  }
  if (snapshot?.status !== "running") {
    return snapshot;
  }

  const stages = Object.fromEntries(
    FIXLAB_STAGES.map((stage) => [
      stage,
      snapshot.stages?.[stage] ?? { status: "pending", message: "" }
    ])
  );
  const failedStages = FIXLAB_STAGES.filter(
    (stage) => stages[stage].status === "failed"
  );
  const blockedStages = FIXLAB_STAGES.filter(
    (stage) => stages[stage].status === "blocked"
  );
  const incompleteStages = FIXLAB_STAGES.filter(
    (stage) => !terminalStatuses.has(stages[stage].status)
  );
  const unresolvedBugs = (snapshot.bugs ?? []).filter(
    (bug) => bug.outcome === "pending"
  );
  if (
    failedStages.length === 0 &&
    blockedStages.length > 0 &&
    incompleteStages.length === 0 &&
    unresolvedBugs.length === 0
  ) {
    return {
      ...snapshot,
      status: "blocked",
      stages,
      error: snapshot.error ?? null,
      finishedAt: recoveredAt
    };
  }

  const interruptedStage =
    FIXLAB_STAGES.find((stage) => stages[stage].status === "running") ??
    FIXLAB_STAGES.find((stage) => !terminalStatuses.has(stages[stage].status));
  const message =
    "Dashboard restarted without an owned executor process; resume this interrupted job.";
  if (interruptedStage) {
    stages[interruptedStage] = { status: "failed", message };
  }

  return {
    ...snapshot,
    status: "failed",
    stages,
    error: snapshot.error ? `${snapshot.error}; ${message}` : message,
    finishedAt: recoveredAt
  };
}

function getPullRequestReadiness(job) {
  if (job.permissionRequest) {
    return { status: "blocked", ready: false, message: job.permissionRequest.preflight
      ? "External-folder review is pending before executor launch. No permission has been granted."
      : PERMISSION_BLOCKED_MESSAGE };
  }
  const draftDeferral = allowsDraftIntegrationDeferral(job);
  const unverifiedDraft = allowsUnverifiedDraft(job);
  if ((job.workflow?.mode === "efficient" && job.mode === "fix-and-validate") || draftDeferral) {
    const validation = job.validationSession?.summary();
    if (!unverifiedDraft && (!validation || !["passed", "advisory",
      ...(job.workflow?.mode === "efficient" ? ["unconfigured"] : [])].includes(validation.status) &&
        !(draftDeferral && validation.draftReady))) {
      return { status: "blocked", ready: false, message: "Explicitly required local validation is pending, failed or stale." };
    }
    if (job.manualLocalhostPending || job.manualLocalhostResult === "failed" || job.testEvidence?.modeViolation) {
      return { status: "blocked", ready: false, message: "An explicitly requested manual check or data-safety requirement is unresolved." };
    }
    if (job.stages?.pr?.status === "passed") {
      return { status: "created", ready: false, message: `${job.stages.pr.message || "Pull request created or updated."} ${unverifiedDraft ? "Unverified draft: local and live checks retain their actual not-run, pending or failed status." : draftDeferral ? "Draft publication does not verify live integration; pending or failed checks remain explicit." : "Optional/remote checks retain their actual status; ready for review does not mean fully validated."}` };
    }
    if (job.stages?.fix?.status !== "passed" || job.stages?.review?.status !== "passed" ||
        ["held", "holding"].includes(job.status)) {
      return { status: "blocked", ready: false, message: "Waiting for the focused fix, regression checks and diff review." };
    }
    return { status: job.stages?.pr?.status === "blocked" ? "approval-required" : "ready",
      ready: true, message: unverifiedDraft
        ? "Diff reviewed. An authorized unverified draft PR may proceed without local or live checks; ready/merge requirements remain unchanged."
        : draftDeferral
        ? "Focused checkpoint and required local checks reviewed. An authorized draft PR may proceed; live integration remains unverified until its gates pass."
        : "Focused checkpoint reviewed. The authorized PR can be ready for review before optional broad validation; pending checks are not passed." };
  }
  if (job.validationIntent === "scoped") {
    return { status: "blocked", ready: false, message: "Full regression is explicitly deferred during scoped iteration, not passed." };
  }
  const prStage = job.stages?.pr ?? { status: "pending", message: "" };
  const validation = job.validationSession?.summary() ?? {
    status: "unconfigured",
    message: "Executor-backed validation is not available; resume with configured validation.gates."
  };
  if (validation && validation.status !== "passed") {
    return {
      status: "blocked",
      ready: false,
      message: validation.status === "unconfigured"
        ? validation.message
        : "Required executor-backed validation is pending, failed, or stale."
    };
  }
  if (["running", "holding", "held"].includes(job.status)) {
    return {
      status: "blocked",
      ready: false,
      message: "Waiting for job completion and final source verification."
    };
  }
  if (prStage.status === "passed") {
    return {
      status: "created",
      ready: false,
      message: prStage.message || "Pull request created or updated."
    };
  }
  const fixedBugs = (job.bugs ?? []).filter((bug) => bug.outcome === "fixed");
  const hasCodeChange =
    fixedBugs.length > 0 ||
    ((job.bugs ?? []).length === 0 && job.stages?.fix?.status === "passed");
  if (!hasCodeChange && job.status !== "running") {
    return {
      status: "not-applicable",
      ready: false,
      message: "No confirmed FixLab code change requires a pull request."
    };
  }
  const blockers = FIXLAB_STAGES.slice(0, -1).filter((stage) =>
    ["pending", "running", "blocked", "failed"].includes(
      job.stages?.[stage]?.status ?? "pending"
    )
  );
  if (blockers.length > 0) {
    return {
      status: "blocked",
      ready: false,
      message: `Waiting for: ${blockers.join(", ")}.`
    };
  }
  if (prStage.status === "blocked") {
    return {
      status: "approval-required",
      ready: true,
      message: prStage.message || "Pull-request approval is required."
    };
  }
  return {
    status: "ready",
    ready: true,
    message: validation.scope === "api-only"
      ? "API-scope validation passed; frontend checks are not applicable. The pull request can be created."
      : validation.scope === "affected"
        ? "Reviewed component-scope validation passed; excluded checks are not applicable. The pull request can be created."
      : "Required validation gates are complete; the pull request can be created."
  };
}

export function inspectRepository(repository) {
  const resolvedRepository = resolve(repository);
  pruneArtifactDirectories(resolvedRepository);
  if (
    !existsSync(resolvedRepository) ||
    !statSync(resolvedRepository).isDirectory()
  ) {
    return {
      repository: resolvedRepository,
      repositoryReady: false,
      profileReady: false,
      profilePath: join(resolvedRepository, profileRelativePath),
      profileName: null,
      error: "repository does not exist or is not a directory"
    };
  }

  const profilePath = join(resolvedRepository, profileRelativePath);
  if (!existsSync(profilePath)) {
    return {
      repository: resolvedRepository,
      repositoryReady: true,
      profileReady: false,
      profilePath,
      profileName: null,
      error: "repository profile is missing; run fixlab init"
    };
  }

  try {
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      throw new Error("profile root must be a JSON object");
    }
    const liveTestProfile = validateLiveTestProfile(profile, resolvedRepository);
    sharedWorktreeConfig(profile, resolvedRepository);
    if (!liveTestProfile.ok) {
      return {
        repository: resolvedRepository,
        repositoryReady: true,
        profileReady: false,
        draftOnlyReady: true,
        playwrightMode: profile.browserAutomation?.mode ?? "browser",
        profilePath,
        profileName:
          typeof profile.name === "string" && profile.name.trim()
            ? profile.name.trim()
            : null,
        error: `live-test profile is incomplete: ${liveTestProfile.detail}`
      };
    }
    const ppeWrites = inspectPpeWriteConfiguration(resolvedRepository);
    const postBases = inspectPostBaseConfiguration(resolvedRepository);
    return {
      repository: resolvedRepository,
      repositoryReady: true,
      profileReady: true,
      unitTestsOnly: profile.validation?.liveTestsRequired === false,
      ppeWriteConfigured: ppeWrites.configured,
      ppeWriteSetupError: ppeWrites.error,
      postBaseEnvironments: postBases.environments,
      postBaseSetupErrors: postBases.errors,
      playwrightMode: profile.browserAutomation?.mode ?? "browser",
      profilePath,
      environments: configuredValidationEnvironments(profile),
      profileName:
        typeof profile.name === "string" && profile.name.trim()
          ? profile.name.trim()
          : null,
      error: null
    };
  } catch (error) {
    return {
      repository: resolvedRepository,
      repositoryReady: true,
      profileReady: false,
      profilePath,
      profileName: null,
      error: `repository profile is invalid JSON: ${error.message}`
    };
  }
}

export function buildJobPrompt({
  request,
  mode,
  requestType = "bug-fix",
  pullRequestStrategy = "common",
  runAllUiScenarios = false,
  targetEnvironment = "",
  recordPlaywrightVideo = false,
  manualLocalhostTest = false,
  deferValidation = false,
  skipLiveTests = false,
  useDeployedBackend = false,
  setupRecovery = [],
  manualLocalhostUrl = "",
  testEvidence = {
    enabled: true,
    source: "profile-defined",
    mutationMode: "profile-defined",
    requireScenarioEvidence: true
  },
  branchNaming = null,
  cacheSummary = null,
  intakeSource = "manual",
  workItem = null,
  workItems = [],
  screenshotPaths = [],
  workflow = null
}) {
  const validateOnly = mode === "validate-only";
  const playwrightOnly = mode === "playwright-only";
  const readOnly = validateOnly || playwrightOnly;
  const apiOnly = testEvidence.apiOnly === true;
  const efficient = !readOnly && workflow?.mode === "efficient";
  const unverifiedDraft = allowsUnverifiedDraft({
    mode, workflow, deferValidation, manualLocalhostTest, runAllUiScenarios, testEvidence
  });
  const smallEnhancement = requestType === "small-enhancement";
  const intakeWorkItems =
    workItems.length > 0 ? workItems : workItem ? [workItem] : [];
  const intakeSummary = intakeWorkItems.map(
    ({
      id,
      title,
      state,
      workItemType,
      acceptanceCriteria,
      webUrl,
      comments,
      commentCount,
      commentsWarning
    }) => ({
      id,
      title,
      state,
      workItemType,
      acceptanceCriteria,
      webUrl,
      commentCount: Array.isArray(comments)
        ? comments.length
        : Number.isSafeInteger(commentCount)
          ? commentCount
          : 0,
      commentsWarning
    })
  );
  const bugResults = extractBugResults(request, intakeWorkItems);
  const outputProtocol = `FixLab output protocol (follow before any tool call):
- First emit FIXLAB_STAGE|intake|running|Accepted the request and starting intake.
- Emit running before each stage's tools, then its terminal outcome before advancing. Never defer or batch stage markers.
- FIXLAB_STAGE|stage|status|message. Stages: ${FIXLAB_STAGES.join(", ")}. Statuses: pending, running, passed, skipped, blocked, failed. Unmarked/skipped never means passed.
- Markers are literal assistant response lines. Never generate markers through shell, files, tools, code blocks or tables.
- FIXLAB_ACTIVITY|stage|summary: evidence/decisions, not hidden chain-of-thought; at most two per stage unless a new blocker. No credentials/private data.
- FIXLAB_TEST|source|mutation-mode|scenario: emit on scenario selection and data/mutation changes. Sources: ${[...testDataSources].join(", ")}. Mutation modes: ${[...mutationModes].join(", ")}.
- FIXLAB_BUG|id|outcome|owner|summary: required machine-readable output for each expected bug before the terminal pr stage. Expected IDs: ${bugResults.map((bug) => bug.id).join(", ") || "none"}. Outcomes: ${[...bugOutcomeStatuses].join(", ")}. Owner: application, upstream-system, data, deployment or unknown. Use outcome external with owner upstream-system for correctly surfaced upstream errors requiring no correction.
- Preserve exact command errors. Do not call task_complete or return the final response until every expected FIXLAB_BUG line and every terminal FIXLAB_STAGE line has been emitted.`;
  const pullRequestGuidance = readOnly
    ? "- Pull-request strategy is informational in read-only mode; do not create or update pull requests."
    : efficient
      ? `- Use ${pullRequestStrategy === "per-bug" ? "a separate branch and PR for each bug; never combine unrelated changes" : "one common PR for the reviewed combined change"}. Publish after the focused checkpoint, then run saved post-PR checks.`
    : pullRequestStrategy === "per-bug"
      ? "- Process each selected bug as an isolated delivery unit: separate code, focused tests, browser evidence, commit and authorized draft PR. Apply the delivery policy below per bug; never combine unrelated changes."
      : "- Treat all selected bugs as one common-PR batch: implement every required fix and protect the combined diff with focused regression checks. Apply the delivery policy below to one authorized PR.";
  const uiScenarioGuidance = apiOnly
    ? "- Run the smallest repository-defined Playwright API journey that proves the selected behavior."
    : runAllUiScenarios
    ? `- After implementation and non-browser validation are complete, run every repository-defined Playwright/UI scenario at the end, not only the focused defect journey.
- Start the required applications once when safe, preserve each scenario result, and attach non-sensitive screenshot evidence for the complete UI run.`
    : "- Run the smallest repository-defined Playwright journey that proves the selected behavior.";
  const environmentGuidance = targetEnvironment
    ? `- The user selected ${targetEnvironment} as the validation environment. Use exactly that repository-approved environment for profile-defined application startup and Playwright live testing.
- Do not silently fall back to local or another environment. If ${targetEnvironment} is unavailable, unauthenticated, or cannot be used safely, block the affected stage with the exact prerequisite.
- Focused tests, type-checks, and builds still run locally unless the repository profile explicitly defines otherwise.`
    : "- No environment override was selected. Use the repository profile's safe default and never select production.";
  const testDataGuidance = testEvidence.productionDatabaseReadOnly
    ? "- This local API reads a PRODUCTION database under an explicit read-only exception. Run the required portal-backed API gate and its assertReadOnlyDatabase permission check before business reads. Require a database-enforced read-only identity; GET alone does not prove safety. Use only the approved loopback HTTPS API, never a deployed production URL or a different database. Do not write, change database settings or permissions, bypass guards, or fall back to synthetic data. Label evidence FIXLAB_TEST|production-read-only|none|...; never describe these reads as non-production."
    : apiOnly
    ? "- Use only allowlisted read-only API operations and real approved data for live validation. No synthetic fallback, redirected request outside the allowlist, or business-data write is authorized."
    : testEvidence.allowPostRequests === true
    ? `- Use the selected ${targetEnvironment} backend for real business reads and explicitly approved write scenarios. A POST method alone does not distinguish a read-only query from a mutation.
- Use only the current mediated tool/private browser relay within its reviewed endpoint/API-base/origin scope and existing authentication. Job-scoped consent avoids repeat confirmation only for that scope; without it, each write still requires exact individual confirmation.
- Do not intercept an authorized mutation merely because the profile's default is synthetic or read-only. Report actual FIXLAB_TEST evidence after the real action; approval and HTTP success alone are not passed scenario assertions.
- Keep other origins, explicit read-only/intercepted selections and production restrictions intact. Missing authentication, configuration or request-policy approval blocks dependent scenarios, not a synthetic substitute for live write proof.`
    : targetEnvironment &&
    testEvidence.source === "non-production-read-only"
      ? `- Use the selected ${targetEnvironment} backend and API as the primary business-data source. Keep all backend access read-only and intercept every mutating request.
- Do not fulfill or intercept business-data reads while the selected backend is available and returns safe records that can prove the required assertions.
- If the selected backend is unreachable, authentication or backend service access prevents the read, or it returns no safe records capable of exercising the required behavior, preserve that exact backend limitation and then fall back to synthetic-intercepted data for the focused UI journey. A query allowlist rejection is not a backend limitation and must not trigger this fallback.
- Do not replace an expected empty-state assertion with synthetic data. Use fallback only when records are required to exercise the reported behavior and the selected backend cannot supply them.
- When fallback occurs, emit a FIXLAB_ACTIVITY line explaining why, intercept all mutations, and emit FIXLAB_TEST with source synthetic-intercepted and mutation mode intercepted. A synthetic pass proves the UI behavior only; do not claim the selected backend or its data was validated.`
      : "- Use the configured test data source and mutation mode. For synthetic-intercepted tests, fulfill business-data reads locally, intercept every mutating request, and assert the intended request count and payload without changing an external record.";
  const videoGuidance = apiOnly
    ? "- Preserve sanitized API assertion results, not browser screenshots, videos or credential-bearing traces."
    : recordPlaywrightVideo
    ? `- Record the focused Playwright journey as non-sensitive video evidence using repository-supported Playwright video recording.
- Save the recording as WebM or MP4 under the repository-owned test-results, playwright-report, or artifacts directory. Keep it under 50 MiB and capture only the application surface: no credentials, browser profiles, personal windows, or unrelated data.
- Keep the required screenshot evidence as the lightweight review artifact. If recording is unavailable, report that limitation explicitly instead of claiming video evidence exists.`
    : "- Playwright video recording was not requested. Preserve the required screenshot evidence and any repository-default traces.";
  const manualLocalhostGuidance = manualLocalhostTest
    ? `- Manual React localhost validation is enabled independently of Playwright. After required automated validation finishes, start or reuse only the profile-defined frontend and wait for its health check at ${manualLocalhostUrl || "the profile-defined local health URL"}.
${process.platform === "win32" ? "- Windows executor children are job-contained and terminated when the agent exits. For a manual gate, use a dashboard-managed frontend outside the executor; the user can start it with Start React. Verify that it serves the validated checkout. If no independently managed server serves that checkout, block with that exact prerequisite instead of retaining an executor child or validating a baseline checkout.\n" : ""}- Dashboard-managed frontends remain under dashboard session controls; do not terminate them from the agent.
- Emit local-stack passed only after the React frontend is healthy. The dashboard will then open the localhost URL in the user's default browser.
- After every required automated browser gate is terminal, emit FIXLAB_MANUAL|localhost|pending immediately before live-test blocked. Keep the FixLab-owned frontend running and request that the user confirm Passed or Failed. Do not emit this marker for a Playwright, authentication, test-data, or other automated blocker.
- Do not run or rerun Playwright solely because this manual option is enabled.
- If an authorized draft PR already exists, keep it draft with the manual gate pending; otherwise emit pr skipped because manual confirmation is pending.
- When the dashboard resumes this session with the user's manual result, mark live-test passed or failed accordingly, stop only frontend processes owned by the current job (not a dashboard-managed server), and continue to the gated PR outcome.`
    : "- Stop FixLab-owned applications after automated browser validation unless another explicit workflow requirement needs them.";
  const branchNamingGuidance = branchNaming
    ? `- Repository branch naming is configured as ${branchNaming.prefix}. Create or reuse only branches beneath this prefix. Do not substitute a runtime, bot, or agent name for the configured user ID.`
    : "- Follow the repository's existing branch naming policy; do not invent a bot-specific prefix.";
  const requestGuidance = smallEnhancement
    ? `- Generate a concise acceptance contract before changing code.
- Check the affected surface and bound the file scope before editing.
- Do not manufacture a failing defect reproduction. Use the smallest existing focused test that proves the acceptance contract.
- Skip broad test suites and full builds unless the repository profile requires them or user-visible/risk evidence makes them necessary.
- Preserve review, live-test, and pull-request evidence, and make no unrelated changes.`
    : `- Generate a concise fix contract from the reported behavior and expected outcome.
- Diagnose and reproduce with repository evidence. Do not claim a cause or reproduction without evidence.
- Use the smallest focused reproduction that demonstrates the reported defect.`;
  if (playwrightOnly) {
    return `FixLab output protocol (follow before any tool call):
- First emit FIXLAB_STAGE|intake|running|Accepted the request and starting intake.
- Before each stage emit FIXLAB_STAGE|stage|running|next action and its terminal outcome before the next stage. Never defer or batch stage markers.
- Markers are literal assistant response lines, never shell, files, tool results or code blocks.
- Stages: ${FIXLAB_STAGES.join(", ")}. Terminal statuses: passed, skipped, blocked, failed. Finish every stage; never report skipped checks as passed.
- FIXLAB_ACTIVITY|stage|summary: meaningful evidence/blockers only, at most twice per stage unless a new blocker changes the plan. No secrets or private data.
- Emit FIXLAB_TEST|source|mutation-mode|scenario on scenario selection and data/mutation changes. Sources: ${[...testDataSources].join(", ")}. Mutation modes: ${[...mutationModes].join(", ")}.
- Expected bug IDs: ${bugResults.map((bug) => bug.id).join(", ") || "none"}. For each, emit FIXLAB_BUG|id|outcome|owner|summary before finishing. Outcomes: ${[...bugOutcomeStatuses].join(", ")}. Attribute upstream limitations honestly.

Run a FixLab playwright-only job.
Playwright-only mode: ${apiOnly ? "API" : "browser"} validation, not implementation.
Request type: ${requestType}
Selected validation environment: ${targetEnvironment || "profile-defined"}
Record Playwright video evidence: ${recordPlaywrightVideo ? "yes" : "no"}
Open React localhost for manual validation: ${manualLocalhostTest ? "yes" : "no"}
Run all UI scenarios at end: ${runAllUiScenarios ? "yes" : "no"}
Configured test data source: ${testEvidence.source}
Configured mutation mode: ${testEvidence.mutationMode}
Test synthesis: ${testEvidence.enabled ? "enabled" : "disabled"}
Scenario evidence required: ${testEvidence.requireScenarioEvidence ? "yes" : "no"}
${intakeSummary.length ? `Loaded work items: ${JSON.stringify(intakeSummary)}\n` : ""}${screenshotPaths.length ? `User-provided screenshots: ${JSON.stringify(screenshotPaths)}. Inspect only these; do not download additional attachments.\n` : ""}${cacheSummary ? `Verified same-repository cache metadata: ${JSON.stringify(cacheSummary)}. Verify task-specific facts; this is not source evidence.\n` : ""}
Repository requirements:
- Read .github/fixlab/repository-profile.json and all applicable repository instructions; preserve safety, authentication, environment and process ownership.
${COPILOT_EXECUTION_GUIDANCE}
${RUNTIME_RECOVERY_GUIDANCE}
${!apiOnly && !testEvidence.unitTestsOnly ? READ_ONLY_POST_GUIDANCE : ""}
${apiOnly ? API_ONLY_PLAYWRIGHT_GUIDANCE : EXISTING_APPLICATION_GUIDANCE}
${apiOnly && useDeployedBackend ? "useDeployedBackend=true: use the configured deployed API; never start local .NET/Key Vault." : ""}
- Skip source diagnosis, separate reproduction, implementation, diff review and unrelated non-browser gates. The diagnosis, reproduce, fix, review, and pr stages must be explicitly skipped unless their own required prerequisite fails.
- Do not edit files other than job-owned transient Playwright journeys and runner evidence. Do not commit, push, create or update pull requests, or change repository configuration.
- Never overwrite pre-existing tests.
- Derive the focused Playwright journey from the request. Batch-read profile, browser configuration, fixture and nearest test; prefer an existing journey or retained script. Inspect implementation only for missing selectors/prerequisites.
- Generate one parameterized deterministic Playwright script for repeated rows/scenarios; use the repository runner, not per-row/field model round-trips.
- Keep the same-job script/results through retries and human waits; change only failing steps. Never delete running artifacts. Remove transient source after validation and continuations finish; permanent coverage needs authorization.
- Preserve forms and human-entered values; never replay stale snapshots or successful mutations. Do not copy browser state or credentials; sign-in/MFA remain human-controlled.
- Do not reinstall dependencies that are already available. Run only minimum setup required by the repository profile: verify browser authentication, required applications and the focused Playwright journey. State files alone do not prove sign-in.
${uiScenarioGuidance}
${environmentGuidance}
${testDataGuidance}
${testEvidence.allowPostRequests === true
  ? "- Save, Submit, Approve, autosave and other writes require the current mediated native approval and its exact scope. Use the private browser relay only when available; do not intercept an authorized write or bypass other guards."
  : "- No Save, Submit, Approve, autosave or external write is authorized by this request or interception selector. Profile safety remains authoritative; writes require separate native approval."}
${videoGuidance}
${manualLocalhostGuidance}
- ${PORTAL_SCREENSHOT_GUIDANCE}
- Run verbose commands through fixlab exec --stage live-test -- <command> [args...]; quote '--' in Windows PowerShell. Keep compact results and bounded failure diagnostics. Never reuse cached live-browser, authentication or external-data results.
- Continue independent safe steps after unrelated failures, never across failed prerequisites. Mark required full regression deferred, not passed.
- Do not delegate one continuous journey or rescan the repository; batch reads and bound output.
- Missing decisions/authentication/authorization block only the affected stage. Use native live questions below; never infer approval, waive policy or collect credentials.
- Finish with exact passed/failed assertions, skipped gates, blockers and risks before task_complete.

Request:
${request}`;
  }
  return `${outputProtocol}

Run a FixLab ${mode} job.
Request type: ${requestType}
Pull request strategy: ${pullRequestStrategy}
Run all UI scenarios at end: ${runAllUiScenarios ? "yes" : "no"}
Selected validation environment: ${targetEnvironment || "profile-defined"}
Record Playwright video evidence: ${recordPlaywrightVideo ? "yes" : "no"}
Open React localhost for manual validation: ${manualLocalhostTest ? "yes" : "no"}
Test synthesis: ${testEvidence.enabled ? "enabled" : "disabled"}
Configured test data source: ${testEvidence.source}
Configured mutation mode: ${testEvidence.mutationMode}
Intake source: ${intakeSource}
${intakeSummary.length > 0 ? `Loaded Azure DevOps selection:
${JSON.stringify(intakeSummary, null, 2)}
The bounded bug evidence is included in the request below.
` : ""}
${screenshotPaths.length > 0 ? `User-provided screenshots stored locally for this job:
${screenshotPaths.map((path) => `- ${path}`).join("\n")}
Inspect only these local files. Do not search for or download additional Azure DevOps attachments.
` : ""}
${cacheSummary ? `
Verified same-repository cache summary for the current HEAD and profile:
${JSON.stringify(cacheSummary, null, 2)}
Use this concise metadata only to avoid repeated discovery. Verify task-specific facts against the current diff and relevant files; do not treat it as source evidence.
` : ""}

Repository requirements:
- Read .github/fixlab/repository-profile.json and all repository-owned instructions before acting.
${COPILOT_EXECUTION_GUIDANCE}
${RUNTIME_RECOVERY_GUIDANCE}
${!apiOnly && !testEvidence.unitTestsOnly ? READ_ONLY_POST_GUIDANCE : ""}
${apiOnly ? API_ONLY_PLAYWRIGHT_GUIDANCE : ""}
${!unverifiedDraft && allowsDraftIntegrationDeferral({ mode, workflow, manualLocalhostTest, runAllUiScenarios, testEvidence }) ? DRAFT_INTEGRATION_GUIDANCE : ""}
${skipLiveTests || useDeployedBackend ? `${OPTIONAL_INTEGRATION_GUIDANCE}\nSelected job choices: skipLiveTests=${skipLiveTests}; useDeployedBackend=${useDeployedBackend}; deferValidation=${deferValidation}.` : ""}
${!readOnly && !unverifiedDraft ? AUTONOMOUS_RECOVERY_GUIDANCE : ""}
${setupRecovery.length ? `Offline setup diagnostics to repair when needed for this task:\n${JSON.stringify(setupRecovery)}` : ""}
- For a fix request, begin with the smallest known reproduction, using an approved existing application when appropriate; prepare the local stack only when needed to exercise changed code. Do not claim a deployed baseline proves an unpublished fix.
- Before validation in a new isolated worktree, plan \`fixlab onboard WORKTREE --from SOURCE --runtime RUNTIME\`. After scoped setup approval, add \`--yes\`. The source profile declares non-sensitive configuration in \`worktreeSetup.files\`. Never copy credentials or browser state. Missing configuration, authentication or denied runtime access is a blocker for the dependent check; do not retry unchanged approvals or grant blanket path access. Sign-in and MFA remain human-controlled. In read-only modes, do not provision or alter configuration; report missing prerequisites as blocked.
- Inspect current git status and effective diff; search task-relevant symbols and files, not the whole repository.
- Reuse this job/session context. Do not reread unchanged files, repeat diagnosis, reinstall available dependencies or rerun broad checks without new evidence.
- Treat commit changes and repository-profile or instruction changes as invalidation boundaries.
${readOnly ? "" : requestGuidance}
${readOnly ? "" : pullRequestGuidance}
${uiScenarioGuidance}
${environmentGuidance}
${videoGuidance}
${manualLocalhostGuidance}
${readOnly ? "" : branchNamingGuidance}
- ${readOnly ? "Do not edit files other than job-owned transient Playwright journeys and runner evidence. Do not create commits, push branches, create pull requests, or update pull requests." : "Make the smallest complete change that resolves the request. Make no code change when the evidence shows none is required."}
${readOnly ? "" : ENGINEERING_SUMMARY_GUIDANCE}
${readOnly ? TRANSIENT_PLAYWRIGHT_GUIDANCE : ""}
- Autonomously complete the lifecycle without asking the user to direct routine engineering steps.
${readOnly ? "" : `- Saved delivery workflow: ${unverifiedDraft ? "explicit unverified draft; local and live checks are deferred, not passed" : efficient ? `efficient; focused checks before the ${workflow.publication === "ready" ? "ready-for-review" : "draft"} PR, broader checks only by saved preference or explicit selection` : "strict; all applicable configured gates remain required for full validation and ready publication"}. This recorded job policy takes precedence over the product default.`}
- Use fixlab_dashboard_control for user-authorized dashboard operations. Read status first and bind its instance and current job. Do not ask again for routine steps already authorized; ask only for missing decisions or required approvals. For "test this PR", verify the assigned checkout matches the PR source commit, then start playwright-only using the repository's Playwright configuration, selected environment and human-controlled authentication. Do not change code or use another checkout's evidence. Normal guards apply.
- For a connected host conversation, use fixlab_dashboard_status and fixlab_dashboard_reply to surface a recovery question using the host's question UI and submit only the user's explicit answer to the same instance and job. Never infer approval. Honor user-selected scoped iteration: full regression is explicitly deferred, not passed${allowsDraftIntegrationDeferral({ mode, workflow, manualLocalhostTest, runAllUiScenarios, testEvidence }) ? "; draft publication follows verified local checks; full integration remains unverified" : efficient ? "; publication follows the saved efficient workflow and explicitly required gates" : ", and PR readiness stays blocked"}. Continue independent safe checks after unrelated failures without bypassing dependencies. Reviewed workspace reuse must preserve the current branch, uncommitted work and existing PR; a changed fingerprint requires a new review. Runtime permissions and human authentication remain separate approvals.
- For known external-folder prerequisites, offer permissionPreflight before executor launch; it only opens review, never grants access. Use reviewed component path-to-gate policies for change-aware validation; unknown paths, full-validation paths, explicit full coverage, and previously executed gates retain their required checks.
- Do not delete or edit transient test artifacts while validation is discovering or executing them; wait for owned validation to finish before cleanup.
- ${playwrightOnly ? "Skip source diagnosis, separate reproduction, implementation, diff review, and non-browser validation. Mark diagnosis, reproduce, fix, and review skipped with the reason Playwright-only mode was selected." : "Inspect the affected surface, implement the smallest required code when edits are allowed, and self-review the effective diff for correctness, scope, and unrelated changes."}
- ${unverifiedDraft ? "Do not run local checks or live tests for this explicitly unverified draft. Preserve every gate as not run or its actual previous outcome." : playwrightOnly ? "Run only setup commands strictly required to launch the profile-defined applications and focused Playwright journey. Do not reinstall dependencies that are already available." : "Run the focused repository-owned tests, type-checks, and builds needed for the affected surface and risk. Preserve exact results."}
- Run verbose repository-owned tests, builds, linters, type checks, and package validation through \`fixlab exec --stage <stage> -- <command> [args...]\`. In Windows PowerShell quote the separator (\`'--'\`) because an unquoted \`--\` is dropped, and never wrap \`fixlab exec\` in \`cmd /c\`; that wrapper is denied in non-interactive sessions. Keep its compact result in context and inspect the private evidence path only when an exact diagnostic is needed.
- Add \`--reuse\` only for deterministic local validation when command, arguments, Git state, working directory, profile, and stage are unchanged. Never reuse startup, health, authentication, Playwright or live-environment validation, external-data checks, dependency installation, deployments, or mutating commands.
- Do not skip Playwright merely because an unrelated non-browser test, build, or backend startup is failed or blocked. If frontend startup, authentication, safe data, and the selected browser journey are independently ready, run the live-test gate and preserve the other blocker separately.
- Use local-stack only for profile-defined application startup and health. Do not mark local-stack failed because a separate test, type-check, lint, or production build reports unrelated baseline diagnostics; preserve that exact validation limitation separately and continue browser execution when startup is healthy.
- Before browser execution, synthesize the smallest focused Playwright scenario and measurable assertions from the reported behavior and expected outcome when an equivalent repository-owned scenario does not already exist.
- Treat a synthesized Playwright scenario as a transient validation artifact by default. Remove its source file and any validation-only configuration edits before diff review, commit, push, or pull-request creation.
- Do not add a newly generated authenticated test such as \`*.auth.spec.ts\` to the product change unless the user explicitly requests permanent browser-test coverage or repository instructions require that exact persisted test.
- Existing repository-owned Playwright tests may be changed only when the reported product behavior directly requires that regression update; do not broaden the pull request to repair unrelated or stale browser journeys.
${testDataGuidance}
${readOnly ? "" : unverifiedDraft ? UNVERIFIED_DRAFT_GUIDANCE : efficient ? efficientWorkflowGuidance(workflow) : `- After focused regression, transient-artifact cleanup and diff review, commit/push the authorized checkpoint and create or update a draft pull request before remaining independent validation completes.
- Start long-running independent validation commands in parallel when supported. Update the same draft PR with actual passed/pending checks, risks and later reviewed checkpoints; never create duplicates.
- Keep the pull request draft and clearly marked validation-in-progress while required validation/approval is pending, blocked, failed or skipped with unaccepted risk. Mark ready/pr passed only after required gates pass or repository policy explicitly accepts the outcome.`}
- ${readOnly ? "Do not publish a pull request or change its draft status in read-only mode." : workflow?.publication === "draft" ? "Keep the published PR draft and read back provider isDraft=true before reporting publication passed. Marking ready requires a separate reviewed decision. Strict required checks remain mandatory." : "After required local validation and approval gates pass or have an explicitly accepted outcome, publish the authorized PR by marking it ready for review. Do not wait for remote PR CI or build completion before publication; publication can trigger those checks. Verify the PR is no longer draft before reporting the PR stage passed. Report remote checks as pending, not passed, and leave merge policies intact. Use `gh pr ready <number>` for GitHub or `az repos pr update --id <id> --draft false` for Azure DevOps, then read back `isDraft` from the provider to confirm it is false. If publication or state verification fails, report the PR stage blocked or failed, not passed."}
${readOnly ? "" : "- Prefix FixLab-created pull-request titles with FLAB: followed by a concise description of the coding change. Format the body with the repository's PR template, clear Markdown sections for the problem, changes, validation and risks, and accurate validation checkboxes."}
${readOnly ? "" : CONCISE_PR_GUIDANCE}
${readOnly ? "" : PR_LEARNING_GUIDANCE}
- Start only the applications defined by the repository profile, then execute the repository-defined live test against the allowed required system or environment from that profile. Do not invent or hardcode environment choices.
- ${PORTAL_SCREENSHOT_GUIDANCE}
- ${playwrightOnly ? "Collect evidence for required setup, authentication readiness, application startup, the focused Playwright result, skipped gates, blockers, and remaining risks." : "Collect evidence for diagnosis or surface inspection, the effective diff, review, local validation, application startup, live testing, skipped gates, and remaining risks."}
- Human interaction is limited to authentication, unsafe-data approval, deployment or pull-request approval, and genuine blockers that cannot be resolved from repository evidence.
- When one of those human actions is required, emit FIXLAB_STAGE|stage|blocked|exact action needed, emit blocked outcomes for affected bugs when applicable, mark later stages skipped because of the blocker, and exit. The dashboard will collect user input and resume this same session.
- Keep stage messages and retained logs concise. Summarize relevant command evidence and preserve exact errors, but do not feed unbounded raw output back into prompts.
- Keep all execution local unless the repository profile and existing authorization explicitly require an allowed external action.
- Do not create an empty pull request. When every bug is external, no-change, expected, duplicate, or already-fixed, explicitly skip the fix and pr stages and explain the per-bug outcomes.
${validateOnly ? "- The fix and pr stages must be explicitly skipped unless they fail for another reason." : ""}
${playwrightOnly ? "- The diagnosis, reproduce, fix, review, and pr stages must be explicitly skipped unless a required setup or browser-validation blocker makes the applicable stage blocked or failed." : ""}
${testEvidence.unitTestsOnly ? `\nRepository unit-test-only override:\n${UNIT_TEST_ONLY_GUIDANCE}\nRecorded reason: ${testEvidence.liveTestsDeferredReason}` : ""}

Request:
${request}`;
}

function extractBugResults(request, workItems = []) {
  const bugs = new Map();
  const lines = String(request ?? "").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^Azure DevOps (?:Bug|User Story|Task|Feature|Work Item) (\d+):\s*(.+)$/i);
    if (!match) {
      continue;
    }
    const nextLine = lines[index + 1]?.trim() ?? "";
    const url = nextLine.match(/^URL:\s*(https:\/\/dev\.azure\.com\/\S+)$/i);
    bugs.set(match[1], {
      id: match[1],
      title: safeSummary(match[2]),
      url: url?.[1] ?? "",
      outcome: "pending",
      owner: "",
      summary: ""
    });
  }
  for (const workItem of workItems) {
    if (workItem?.id && !bugs.has(String(workItem.id))) {
      bugs.set(String(workItem.id), {
        id: String(workItem.id),
        title: safeSummary(workItem.title),
        url: workItem.webUrl ?? "",
        outcome: "pending",
        owner: "",
        summary: ""
      });
    }
  }
  return [...bugs.values()];
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runGit(repository, args) {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function safeSummary(value, maximumLength = 300) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maximumLength);
  if (
    /(?:password|passwd|secret|token|authorization|bearer|cookie|connection.?string|private.?key|client.?secret|dashboard[-\\/]+artifacts)/i.test(
      text
    )
  ) {
    return "[omitted potentially sensitive summary]";
  }
  return text;
}

function parseTokenCount(value) {
  const match = String(value).trim().match(/^([\d.]+)\s*([kmb]?)$/i);
  if (!match) {
    return null;
  }
  const multiplier = {
    "": 1,
    k: 1_000,
    m: 1_000_000,
    b: 1_000_000_000
  }[match[2].toLowerCase()];
  const count = Number(match[1]) * multiplier;
  return Number.isFinite(count) ? Math.round(count) : null;
}

function parseUsageLine(line) {
  const match = line.match(
    /^\s*Tokens\s+↑\s*([\d.]+\s*[kmb]?)\s+\(([\d.]+\s*[kmb]?)\s+cached,\s*([\d.]+\s*[kmb]?)\s+written\)\s+•\s+↓\s*([\d.]+\s*[kmb]?)\s*$/i
  );
  if (!match) {
    return null;
  }
  const values = match.slice(1).map(parseTokenCount);
  if (values.some((value) => value === null)) {
    return null;
  }
  const [inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens] =
    values;
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    cacheReusePercent:
      inputTokens > 0
        ? Math.round((cachedInputTokens / inputTokens) * 1000) / 10
        : 0
  };
}

function readMetrics(path) {
  if (!path || !existsSync(path)) {
    return { records: [], warning: null };
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(value?.jobs)) {
      throw new Error("metrics history has an invalid shape");
    }
    return {
      records: value.jobs.slice(-MAX_METRICS_ENTRIES),
      warning: null
    };
  } catch {
    return {
      records: [],
      warning:
        "The existing dashboard metrics history could not be read and was ignored."
    };
  }
}

function updateJobMetrics(records, job) {
  const record = {
    id: job.id,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    status: job.status,
    bugCount: job.bugs.length,
    durationMs: job.finishedAt
      ? Math.max(
          0,
          Date.parse(job.finishedAt) -
            Date.parse(job.startedAt ?? job.createdAt)
        )
      : null,
    queueWaitMs: job.startedAt
      ? Math.max(0, Date.parse(job.startedAt) - Date.parse(job.createdAt))
      : null,
    ...job.usage
  };
  const next = [
    ...records.filter((candidate) => candidate.id !== job.id),
    record
  ].slice(-MAX_METRICS_ENTRIES);
  return next;
}

function writeMetrics(path, records) {
  if (!path) {
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(
    temporaryPath,
    JSON.stringify({ version: 1, jobs: records }),
    { mode: 0o600 }
  );
  renameSync(temporaryPath, path);
}

function retainedUsage(value) {
  const counters = Object.fromEntries(
    ["inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens"]
      .map((key) => [key, value?.[key] ?? 0])
  );
  if (Object.values(counters).some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new Error("Saved dashboard token usage contains invalid counters.");
  }
  return {
    ...counters,
    cacheReusePercent: counters.inputTokens > 0
      ? Math.round(counters.cachedInputTokens / counters.inputTokens * 1000) / 10
      : 0
  };
}

function readDashboardHistory(path, metricsRecords) {
  if (!path || !existsSync(path)) {
    return { jobs: [], warning: null };
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(value?.jobs)) {
      throw new Error("dashboard history has an invalid shape");
    }
    return {
      jobs: value.jobs
        .filter(
          (job) =>
            job &&
            typeof job.id === "string" &&
            typeof job.request === "string" &&
            typeof job.status === "string"
        )
        .slice(0, MAX_DASHBOARD_HISTORY_ENTRIES)
        .map((job) => ({
          ...job,
          usage: retainedUsage(job.usage ?? metricsRecords.find((record) => record.id === job.id)),
          canResume: false,
          canComment: false,
          logs: []
        })),
      warning: null
    };
  } catch {
    return {
      jobs: [],
      warning: "Saved dashboard job history could not be read."
    };
  }
}

function writeDashboardHistory(path, jobs) {
  if (!path) {
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(
    temporaryPath,
    JSON.stringify({
      version: 1,
      jobs: jobs.slice(0, MAX_DASHBOARD_HISTORY_ENTRIES)
    }),
    { mode: 0o600 }
  );
  renameSync(temporaryPath, path);
}

function inferAzureDevOpsSettings(repository) {
  const remote = spawnSync(
    "git",
    ["-C", repository, "remote", "get-url", "origin"],
    { encoding: "utf8", windowsHide: true }
  );
  const match = remote.stdout
    ?.trim()
    .match(
      /^https:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/[^/]+\/?$/i
    );
  return match
    ? {
        organization: decodeURIComponent(match[1]),
        project: decodeURIComponent(match[2])
      }
    : null;
}

function azureDevOpsProfile(repository, profile) {
  if (profile.azureDevOps?.organization && profile.azureDevOps?.project) {
    return profile;
  }
  const inferred = inferAzureDevOpsSettings(repository);
  return inferred
    ? {
        ...profile,
        azureDevOps: {
          ...profile.azureDevOps,
          ...inferred
        }
      }
    : profile;
}

function summarizeMetrics(records, period) {
  const durations = {
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000
  };
  const cutoff = durations[period] ? Date.now() - durations[period] : 0;
  const selected = records.filter(
    (record) => Date.parse(record.createdAt) >= cutoff
  );
  const completed = selected.filter((record) => record.finishedAt);
  const usageJobs = completed.filter(
    (record) => Number.isFinite(record.inputTokens) && record.inputTokens > 0
  );
  const totalInputTokens = usageJobs.reduce(
    (total, record) => total + record.inputTokens,
    0
  );
  const totalCachedInputTokens = usageJobs.reduce(
    (total, record) => total + record.cachedInputTokens,
    0
  );
  return {
    period,
    queued: selected.length,
    completed: completed.length,
    passed: completed.filter((record) => record.status === "passed").length,
    failed: completed.filter((record) => record.status === "failed").length,
    blocked: completed.filter((record) => record.status === "blocked").length,
    cancelled: completed.filter((record) => record.status === "cancelled").length,
    bugs: selected.reduce((total, record) => total + record.bugCount, 0),
    averageDurationMs:
      completed.length > 0
        ? Math.round(
            completed.reduce(
              (total, record) => total + (record.durationMs ?? 0),
              0
            ) / completed.length
          )
        : null,
    usageJobs: usageJobs.length,
    totalInputTokens,
    totalCachedInputTokens,
    totalCacheWriteTokens: usageJobs.reduce(
      (total, record) => total + record.cacheWriteTokens,
      0
    ),
    totalOutputTokens: usageJobs.reduce(
      (total, record) => total + record.outputTokens,
      0
    ),
    cacheReusePercent:
      totalInputTokens > 0
        ? Math.round((totalCachedInputTokens / totalInputTokens) * 1000) / 10
        : null
  };
}

export function createCacheContext(repository) {
  try {
    const profilePath = join(repository, profileRelativePath);
    if (!existsSync(profilePath)) {
      return null;
    }
    const commonGitDirectory = runGit(repository, [
      "rev-parse",
      "--git-common-dir"
    ]);
    const head = runGit(repository, ["rev-parse", "HEAD"]);
    if (!commonGitDirectory || !head) {
      return null;
    }

    const gitDirectoryPath = isAbsolute(commonGitDirectory)
      ? commonGitDirectory
      : resolve(repository, commonGitDirectory);
    const repositoryIdentity = realpathSync.native(gitDirectoryPath);
    const profileContent = readFileSync(profilePath);
    const profile = JSON.parse(profileContent.toString("utf8"));
    const profileSummary = {
      name: safeSummary(profile.name ?? ""),
      sections: Object.keys(profile).sort().slice(0, 30),
      applications: Object.keys(profile.applications ?? {})
        .sort()
        .slice(0, 30)
    };
    const profileHash = hash(profileContent);
    const state = repositoryState(repository);
    const stateHash = hash(JSON.stringify(state));
    const instructionHash = state.instructionHash;
    return {
      key: hash(`${repositoryIdentity}\0${head}\0${profileHash}\0${stateHash}\0${instructionHash}`),
      repository,
      repositoryIdentityHash: hash(repositoryIdentity),
      head,
      profileHash,
      instructionHash,
      stateHash,
      profileSummary,
      cachePath: join(gitDirectoryPath, "fixlab", "dashboard-cache.json")
    };
  } catch {
    return null;
  }
}

function readCache(cachePath) {
  if (!existsSync(cachePath)) {
    return { version: 1, entries: [] };
  }
  try {
    const content = readFileSync(cachePath);
    if (content.length > MAX_CACHE_BYTES) {
      return { version: 1, entries: [] };
    }
    const cache = JSON.parse(content.toString("utf8"));
    if (cache?.version !== 1 || !Array.isArray(cache.entries)) {
      return { version: 1, entries: [] };
    }
    return cache;
  } catch {
    return { version: 1, entries: [] };
  }
}

export function loadCacheSummary(context) {
  if (!context) {
    return null;
  }
  const cache = readCache(context.cachePath);
  const entry = cache.entries.find((candidate) => candidate.key === context.key);
  if (!entry || Date.now() - Date.parse(entry.updatedAt) > 7 * 24 * 60 * 60 * 1000 ||
      !Number.isFinite(Date.parse(entry.updatedAt))) {
    return null;
  }
  return {
    profile: entry.profile,
    priorJob: entry.priorJob
  };
}

function writeCacheSummary(context, job) {
  if (!context) {
    return;
  }
  try {
    context = createCacheContext(job.validationSession?.target ?? context.repository);
    if (!context) {
      throw new Error("Current repository inputs could not be fingerprinted.");
    }
    const cache = readCache(context.cachePath);
    const entry = {
      key: context.key,
      repositoryIdentityHash: context.repositoryIdentityHash,
      head: context.head,
      profileHash: context.profileHash,
      instructionHash: context.instructionHash,
      stateHash: context.stateHash,
      updatedAt: new Date().toISOString(),
      profile: context.profileSummary,
      priorJob: {
        result: job.status,
        mode: job.mode,
        requestType: job.requestType,
        stages: Object.fromEntries(
          FIXLAB_STAGES.map((stage) => [
            stage,
            {
              status: job.stages[stage].status,
              summary: `${stage}: ${job.stages[stage].status}`
            }
          ])
        ),
        validation: job.validationSession?.summary().gates.map(
          ({ id, status }) => ({ id, status })
        ) ?? []
      }
    };
    cache.entries = [
      entry,
      ...cache.entries.filter((candidate) =>
        candidate.key !== context.key &&
        Date.parse(candidate.updatedAt) >= Date.now() - 7 * 24 * 60 * 60 * 1000
      )
    ].slice(0, MAX_CACHE_ENTRIES);

    mkdirSync(dirname(context.cachePath), { recursive: true });
    let content = JSON.stringify(cache);
    while (
      Buffer.byteLength(content) > MAX_CACHE_BYTES &&
      cache.entries.length > 1
    ) {
      cache.entries.pop();
      content = JSON.stringify(cache);
    }
    if (Buffer.byteLength(content) > MAX_CACHE_BYTES) {
      return;
    }
    writeFileSync(context.cachePath, content, { mode: 0o600 });
  } catch {
    job.memoryWarning = "Repository memory could not be updated; current execution evidence remains authoritative.";
    pushActivity(job, {
      timestamp: new Date().toISOString(),
      stage: "review",
      message: job.memoryWarning
    });
  }
}

// Linked dependency folders (for example a node_modules junction) resolve outside
// the repository, and non-interactive agents cannot answer the path prompt they raise.
// Discovery is only for a reviewed setup plan; runtime callers use the default,
// which grants only targets inside profile-declared trustedDependencyRoots.
export function linkedDependencyDirectories(repository, { discover = false } = {}) {
  let root;
  let profile;
  try {
    root = realpathSync(repository);
    profile = loadRepositoryProfile(root);
  } catch {
    return [];
  }

  const trustedRoots = (
    Array.isArray(profile?.trustedDependencyRoots)
      ? profile.trustedDependencyRoots
      : []
  )
    .filter((value) => typeof value === "string" && isAbsolute(value))
    .flatMap((value) => {
      try {
        const resolved = realpathSync(value);
        return resolved === parse(resolved).root ? [] : [resolved];
      } catch {
        return [];
      }
    });
  if (trustedRoots.length === 0 && !discover) {
    return [];
  }

  const isInside = (parent, child) => {
    const relation = relative(parent, child);
    return (
      relation === "" ||
      (!relation.startsWith("..") && !isAbsolute(relation))
    );
  };
  const workingDirectories = new Set([root]);
  for (const configured of [
    profile.browserAutomation?.workingDirectory,
    ...Object.values(profile.applications ?? {}).map(
      (application) => application?.workingDirectory
    )
  ]) {
    if (typeof configured !== "string") {
      continue;
    }
    try {
      const directory = realpathSync(resolve(root, configured));
      if (isInside(root, directory)) {
        workingDirectories.add(directory);
      }
    } catch {
      // A missing working directory has no dependency link to grant.
    }
  }

  const found = new Set();
  for (const directory of workingDirectories) {
    const candidate = join(directory, "node_modules");
    try {
      if (!lstatSync(candidate).isSymbolicLink()) {
        continue;
      }
      const target = realpathSync(candidate);
      if (
        !isInside(root, target) &&
        target !== parse(target).root &&
        (discover || trustedRoots.some((trusted) => isInside(trusted, target)))
      ) {
        found.add(target);
      }
    } catch {
      // Missing or unreadable dependency folders need no extra access.
    }
  }
  return [...found];
}

const additionalDirectoryArguments = (additionalDirs) =>
  additionalDirs.flatMap((directory) => ["--add-dir", directory]);

export function buildAgencyInvocation({
  packageRoot,
  prompt,
  sessionId,
  resume = false,
  additionalDirs = [],
  toolApprovalMode = "ask"
}) {
  if (!sessionId) {
    throw new Error("Agency invocation requires a session ID");
  }
  return {
    args: [
      "copilot",
      "--plugin-dir",
      packageRoot,
      "--agent",
      "fixlab:fixlab",
      ...(validateToolApprovalMode(toolApprovalMode) === "allow-all" ? ["--allow-all-tools"] : []),
      ...additionalDirectoryArguments(additionalDirs),
      "--no-ask-user",
      "--stream",
      "on",
      ...(resume ? [`--resume=${sessionId}`] : ["--session-id", sessionId])
    ],
    input: prompt
  };
}

export function buildCopilotInvocation({
  packageRoot,
  prompt,
  sessionId,
  resume = false,
  additionalDirs = [],
  model = "",
  toolApprovalMode = "ask"
}) {
  if (!sessionId) {
    throw new Error("Copilot invocation requires a session ID");
  }
  return {
    args: [
      "--plugin-dir",
      packageRoot,
      "--agent",
      "fixlab:fixlab",
      ...copilotModelArguments(model),
      ...(validateToolApprovalMode(toolApprovalMode) === "allow-all" ? ["--allow-all-tools"] : []),
      ...additionalDirectoryArguments(additionalDirs),
      "--no-ask-user",
      "--autopilot",
      "--stream",
      "on",
      ...(resume ? [`--resume=${sessionId}`] : ["--session-id", sessionId])
    ],
    input: prompt
  };
}

function findDirectExecutable(command) {
  const lookup = spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    [command],
    { encoding: "utf8", shell: false, windowsHide: true }
  );
  const candidates = lookup.stdout
    ?.split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  return process.platform === "win32"
    ? candidates?.find((value) => /\.exe$/i.test(value))
    : candidates?.[0];
}

function createExecutor({ command, packageRoot, buildInvocation, defaultModel = "", native = false }) {
  return ({
    repository,
    artifactDirectories = [],
    runtimeDirectories = [],
    prompt,
    sessionId,
    resume,
    model,
    mode,
    usage,
    inputTokenLimit,
    toolApprovalMode = "ask",
    fileAccess,
    dashboardPort,
    targetEnvironment,
    testMutationMode,
    selectedTestMutationMode,
    allowPostRequests,
    postWriteApproval,
    protectedPaths,
    onOutput,
    onUsage = () => {},
    onRuntimeRequests = () => {}
  }) => {
    const executable = native ? process.execPath : findDirectExecutable(command);
    if (!executable) {
      const error = new Error(
        `${command} executable is unavailable or is not a directly executable binary`
      );
      error.executorNotStarted = true;
      throw error;
    }
    let invocation;
    try {
      invocation = buildInvocation({
        packageRoot,
        prompt,
        sessionId,
        resume,
        toolApprovalMode,
        model: model ?? defaultModel,
        additionalDirs: [
          ...linkedDependencyDirectories(repository),
          ...artifactDirectories,
          ...runtimeDirectories
        ]
      });
    } catch (error) {
      error.executorNotStarted = true;
      throw error;
    }
    if (native) {
      invocation = {
        args: [join(packageRoot, "dashboard", "copilot-session.js")],
        input: JSON.stringify({
          type: "start", packageRoot, repository, prompt, sessionId, resume, usage, mode, inputTokenLimit, toolApprovalMode, protectedPaths, fileAccess, dashboardPort, targetEnvironment, testMutationMode, selectedTestMutationMode, allowPostRequests, postWriteApproval,
          model: model ?? defaultModel,
          additionalDirs: [
            ...linkedDependencyDirectories(repository), ...artifactDirectories, ...runtimeDirectories
          ]
        }) + "\n"
      };
    }
    const containment = process.platform === "win32"
      ? spawnWindowsExecutor({ executable, args: invocation.args, repository })
      : null;
    const child = containment?.child ?? spawn(executable, invocation.args, {
      cwd: repository,
      env: { ...process.env, BROWSER: "none" },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });

    let protocolError = null;
    let terminationError = null;
    let nativeUsage = retainedUsage(usage);
    let buffer = "";
    const stop = () => {
      try {
        if (containment) {
          containment.terminate();
        } else {
          stopProcessTree(child);
        }
      } catch (error) {
        terminationError = error;
        onOutput("stderr", `Owned executor termination is unverified; retaining its lease: ${error.message}\n`);
      }
    };
    const bridge = native ? createRuntimeRequestBridge({
      send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
      onChange: onRuntimeRequests
    }) : null;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (!native) {
        onOutput("stdout", chunk);
        return;
      }
      try {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (Buffer.byteLength(line) > MAX_RUNTIME_FRAME_BYTES) {
            throw new Error("Copilot runtime output exceeded its size limit.");
          }
          const message = JSON.parse(line);
          if (message.type === "request") {
            bridge.receive(message);
          } else if (message.type === "usage") {
            nativeUsage = validateRuntimeUsage(message.usage, nativeUsage);
            onUsage(nativeUsage);
          } else if (message.type === "output" && typeof message.text === "string" &&
              ["stdout", "stderr"].includes(message.stream)) {
            onOutput(message.stream, message.text);
          } else {
            const error = new Error(message.type === "error"
              ? message.message : "Copilot sent an unsupported runtime message.");
            if (message.type === "error" && message.code === "INPUT_TOKEN_LIMIT") {
              error.code = message.code;
            }
            throw error;
          }
        }
        if (Buffer.byteLength(buffer) > MAX_RUNTIME_FRAME_BYTES) {
          throw new Error("Copilot runtime output exceeded its size limit.");
        }
      } catch (error) {
        protocolError = error;
        onOutput("stderr", `${error.message}\n`);
        bridge.cancel(false);
        stop();
      }
    });
    child.stderr.on("data", (chunk) => onOutput("stderr", chunk.toString()));
    child.stdin.on("error", (error) => {
      onOutput("stderr", `Could not send the FixLab prompt: ${error.message}\n`);
      if (native) {
        protocolError = error;
        bridge.cancel(false);
        stop();
      }
    });
    if (native) {
      child.stdin.write(invocation.input);
    } else {
      child.stdin.end(invocation.input);
    }

    const completion = createProcessCompletion(child, onOutput).then(async (result) => {
      if (!containment && child.pid) {
        stop();
        const started = Date.now();
        try {
          while (ownedTreeRunning(child)) {
            if (Date.now() - started >= 7000) {
              throw new Error("Owned process group did not settle after force termination.");
            }
            if (Date.now() - started >= 5000) {
              process.kill(-child.pid, "SIGKILL");
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        } catch (error) {
          if (error.code !== "ESRCH") {
            terminationError = error;
            onOutput("stderr", `Owned executor settlement is unverified; retaining its lease: ${error.message}\n`);
          }
        }
      }
      if (native && buffer.trim() && !protocolError) {
        protocolError = new Error("Copilot runtime exited with an incomplete protocol message.");
      }
      bridge?.cancel(false);
      return protocolError || terminationError
        ? { code: null, error: protocolError ?? terminationError }
        : result;
    });

    return {
      pid: child.pid,
      completion,
      respondToRuntimeRequest(id, decision) {
        if (!bridge || protocolError) {
          throw new Error("The native runtime connection is unavailable.");
        }
        bridge.respond(id, decision);
      },
      hasStopped() {
        if (terminationError) {
          return false;
        }
        if (containment) {
          return containment.hasStopped();
        }
        if (!child.pid) {
          return true;
        }
        if (child.exitCode === null && child.signalCode === null) {
          return false;
        }
        if (process.platform !== "win32") {
          try {
            process.kill(-child.pid, 0);
            return false;
          } catch (error) {
            if (error.code !== "ESRCH") {
              throw error;
            }
          }
        }
        return true;
      },
      terminate() {
        bridge?.cancel();
        stop();
      }
    };
  };
}

export function createProcessCompletion(
  child,
  onOutput,
  outputDrainTimeoutMs = 500
) {
  return new Promise((resolveCompletion) => {
    let settled = false;
    let outputDrainTimer = null;
    const settle = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(outputDrainTimer);
      resolveCompletion(result);
    };

    child.once("error", (error) => {
      onOutput("stderr", `${error.message}\n`);
      settle({ code: null, error });
    });
    child.once("exit", (code, signal) => {
      outputDrainTimer = setTimeout(
        () => settle({ code, signal }),
        outputDrainTimeoutMs
      );
    });
    child.once("close", (code, signal) => {
      settle({ code, signal });
    });
  });
}

export function createAgencyExecutor({ packageRoot }) {
  return createExecutor({
    command: "agency",
    packageRoot,
    buildInvocation: buildAgencyInvocation
  });
}

export function createCopilotExecutor({ packageRoot, model = "" }) {
  const selectedModel = validateCopilotModel(model);
  return createExecutor({
    command: "copilot",
    packageRoot,
    buildInvocation: buildCopilotInvocation,
    defaultModel: selectedModel,
    native: true
  });
}

export function createRuntimeExecutor({ packageRoot, runtime = "agency", model = "" }) {
  if (!FIXLAB_RUNTIMES.includes(runtime)) {
    throw new Error(
      `FixLab runtime must be one of: ${FIXLAB_RUNTIMES.join(", ")}`
    );
  }
  const selectedModel = validateCopilotModel(model, runtime);
  return runtime === "copilot"
    ? createCopilotExecutor({ packageRoot, model: selectedModel })
    : createAgencyExecutor({ packageRoot });
}

function sendJson(response, statusCode, body) {
  if (response.fixlabCompact) {
    body = compactControlResult(body);
  }
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

function publicJob(job) {
  if (!job) {
    return null;
  }
  return {
    id: job.id,
    request: job.request,
    requestType: job.requestType,
    engineeringSummary: job.engineeringSummary ?? null,
    engineeringSummaryOrigin: job.engineeringSummaryOrigin ?? null,
    deferValidation: job.deferValidation === true,
    skipLiveTests: job.skipLiveTests === true,
    useDeployedBackend: job.useDeployedBackend === true,
    setupRecovery: job.setupRecovery ?? [],
    model: job.model,
    runtime: job.runtime,
    pullRequestStrategy: job.pullRequestStrategy,
    runAllUiScenarios: job.runAllUiScenarios,
    targetEnvironment: job.targetEnvironment,
    sharedWorkspace: job.sharedWorkspace ?? null,
    workspaceReview: job.workspaceReview ?? null,
    workspaceStash: job.workspaceStash ?? null,
    validationIntent: job.validationIntent ?? "full",
    workflow: job.workflow ?? { mode: "strict" },
    recordPlaywrightVideo: job.recordPlaywrightVideo,
    manualLocalhostTest: job.manualLocalhostTest,
    manualLocalhostUrl: job.manualLocalhostUrl,
    manualLocalhostOpenedAt: job.manualLocalhostOpenedAt,
    manualLocalhostPending: job.manualLocalhostPending,
    manualLocalhostResult: job.manualLocalhostResult,
    testEvidence: job.testEvidence,
    intakeSource: job.intakeSource,
    workItem: publicWorkItem(job.workItem),
    workItems: job.workItems.map(publicWorkItem),
    screenshots: job.screenshots.map(({ name, mimeType, bytes }) => ({
      name,
      mimeType,
      bytes
    })),
    mode: job.mode,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    lastActivityAt: job.lastActivityAt,
    error: job.error,
    permissionRequest: job.permissionRequest ?? null,
    browserBlocker: job.browserBlocker ?? null,
    runtimeRequests: job.runtimeRequests ?? [],
    executionState: job.runtimeRequests?.length
      ? job.runtimeRequests[0].kind === "question" ? "waiting-for-input" : "waiting-for-permission"
      : job.permissionRequest ? "waiting-for-permission" : job.status,
    fileAccess: job.fileAccess ?? null,
    sourceEditReview: job.sourceEditReview ? {
      ...recordedSourceEditReview(job.sourceEditReview),
      authorization: sourceEditAuthorization(job.sourceEditReview)
    } : null,
    inputTokenLimit: job.inputTokenLimit ?? 0,
    toolApprovalMode: job.toolApprovalMode ?? "ask",
    postWriteApproved: Boolean(job.postWriteApproval?.revision) &&
      (!isOriginWriteApproval(job.postWriteApproval) || job.postWriteApproval.mode === "post-base"),
    devWriteApproved: Boolean(job.postWriteApproval?.revision) && job.postWriteApproval.mode === "dev-origin",
    ppeWriteApproved: Boolean(job.postWriteApproval?.revision) && job.postWriteApproval.mode === "ppe-origin",
    budgetExceeded: job.budgetExceeded === true,
    runtimeDirectoryGrants: (job.runtimeDirectoryGrants ?? []).map((scope) => scope.directory),
    canResume:
      !job.resumeDisabled &&
      !job.executorStopping &&
      !job.budgetExceeded &&
      !job.permissionRequest &&
      ["blocked", "failed", "passed", "held"].includes(job.status),
    canReviewPermissions:
      Boolean(job.permissionRequest) &&
      !job.resumeDisabled &&
      !job.executorStopping &&
      job.status === "blocked",
    canDismiss:
      !job.executorStopping &&
      ["blocked", "failed"].includes(job.status),
    canComment: job.status === "running" && !job.permissionRequest && !job.runtimeRequests?.length,
    inputCount: job.inputs.length,
    pendingInputCount: job.pendingInputs.length,
    durationMs: Math.max(
      0,
      job.startedAt
        ? Date.parse(
            job.finishedAt ?? job.heldAt ?? new Date().toISOString()
          ) -
            Date.parse(job.startedAt)
        : 0
    ),
    usage: job.usage,
    stages: job.stages,
    validation: job.validationSession?.summary() ?? null,
    memoryWarning: job.memoryWarning ?? null,
    pullRequestReadiness: getPullRequestReadiness(job),
    bugs: job.bugs,
    activity: job.activity,
    logs: job.logs,
    droppedLogs: job.droppedLogs
  };
}

function publicWorkItem(workItem) {
  if (!workItem) {
    return null;
  }
  const {
    id,
    title,
    state,
    workItemType,
    webUrl,
    comments,
    commentCount,
    commentsWarning
  } = workItem;
  return {
    id,
    title,
    state,
    workItemType,
    webUrl,
    commentCount: Array.isArray(comments)
      ? comments.length
      : Number.isSafeInteger(commentCount)
        ? commentCount
        : 0,
    commentsWarning
  };
}

function persistedWorkItem(workItem) {
  const summary = publicWorkItem(workItem);
  if (!summary) {
    return null;
  }
  return {
    ...summary,
    title: safePersistedSummary(summary.title),
    webUrl: "",
    commentsWarning: safePersistedSummary(summary.commentsWarning)
  };
}

async function readJsonBody(request, maxBytes = 64 * 1024) {
  if (request.verifyConversation) {
    maxBytes = Math.min(maxBytes, 64 * 1024);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error(`request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    throw new Error("request body is required");
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("request body must be valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("request body must be a JSON object");
  }
  request.verifyConversation?.();
  if (request.fixlabControlAction && body.action !== request.fixlabControlAction) {
    throw new Error("The control payload action does not match the authorized operation.");
  }
  return body;
}

function validateWorkItemSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Azure DevOps intake requires a loaded work item");
  }
  const textFields = [
    "title",
    "description",
    "reproduction",
    "acceptanceCriteria",
    "state",
    "workItemType",
    "webUrl"
  ];
  const result = {};
  if (!Number.isSafeInteger(value.id) || value.id < 1) {
    throw new Error("loaded work item ID is invalid");
  }
  result.id = value.id;
  for (const field of textFields) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error(`loaded work item ${field} must be a string`);
    }
    const maximum = [
      "description",
      "reproduction",
      "acceptanceCriteria"
    ].includes(field)
      ? 20000
      : 1000;
    result[field] = (value[field] ?? "").trim().slice(0, maximum);
  }
  if (value.comments !== undefined && !Array.isArray(value.comments)) {
    throw new Error("loaded work item comments must be an array");
  }
  result.comments = (value.comments ?? []).slice(0, 20).map((comment) => {
    if (!comment || typeof comment !== "object" || Array.isArray(comment)) {
      throw new Error("loaded work item comments must be objects");
    }
    for (const field of ["author", "createdAt", "text"]) {
      if (comment[field] !== undefined && typeof comment[field] !== "string") {
        throw new Error(`loaded work item comment ${field} must be a string`);
      }
    }
    return {
      author: (comment.author ?? "").trim().slice(0, 200),
      createdAt: (comment.createdAt ?? "").trim().slice(0, 100),
      text: (comment.text ?? "").trim().slice(0, 2000)
    };
  });
  if (
    value.commentsWarning !== undefined &&
    typeof value.commentsWarning !== "string"
  ) {
    throw new Error("loaded work item comments warning must be a string");
  }
  result.commentsWarning = (value.commentsWarning ?? "")
    .trim()
    .slice(0, 500);
  if (
    result.webUrl &&
    !/^https:\/\/dev\.azure\.com\//i.test(result.webUrl)
  ) {
    throw new Error("loaded work item URL must use https://dev.azure.com");
  }
  return result;
}

function validateLoadedScreenshots(value, state) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("loaded Azure DevOps screenshots must be an array");
  }
  const result = [];
  for (const screenshot of value) {
    if (state.count >= MAX_SCREENSHOTS) {
      throw new Error(
        `loaded Azure DevOps screenshots exceed the ${MAX_SCREENSHOTS}-image limit`
      );
    }
    if (!screenshot || typeof screenshot !== "object") {
      throw new Error("loaded Azure DevOps screenshots must be objects");
    }
    const name =
      typeof screenshot.name === "string" ? screenshot.name.trim() : "";
    const mimeType =
      typeof screenshot.mimeType === "string"
        ? screenshot.mimeType.toLowerCase()
        : "";
    const base64 =
      typeof screenshot.base64 === "string" ? screenshot.base64 : "";
    if (
      !name ||
      name !== basename(name) ||
      name.includes("..") ||
      !["image/png", "image/jpeg", "image/webp"].includes(mimeType) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        base64
      )
    ) {
      throw new Error("loaded Azure DevOps screenshot metadata is invalid");
    }
    const bytes = Buffer.from(base64, "base64").length;
    if (bytes > MAX_SCREENSHOT_BYTES) {
      throw new Error("loaded Azure DevOps screenshot exceeds 2 MiB");
    }
    state.totalBytes += bytes;
    if (state.totalBytes > MAX_SCREENSHOT_TOTAL_BYTES) {
      throw new Error("loaded Azure DevOps screenshots exceed 8 MiB total");
    }
    state.count += 1;
    result.push({ name, mimeType, base64 });
  }
  return result;
}

function appendOutput(job, stream, text) {
  const normalized = text.replace(/\r\n/g, "\n");
  job.partial[stream] += normalized;
  const lines = job.partial[stream].split("\n");
  job.partial[stream] = lines.pop();
  for (const line of lines) {
    for (const segment of splitRenderedMarkers(line)) {
      appendLine(job, stream, segment);
    }
  }
}

function splitRenderedMarkers(line) {
  const summaryIndex = line.indexOf("FIXLAB_SUMMARY|");
  if (summaryIndex > 0 && /^FIXLAB_(?:STAGE|ACTIVITY|BUG|TEST)(?:\||\s)/u.test(line)) {
    return [...splitRenderedMarkers(line.slice(0, summaryIndex)), ...splitRenderedMarkers(line.slice(summaryIndex))];
  }
  if (summaryIndex === 0) {
    if (!line.slice("FIXLAB_SUMMARY|".length).trimStart().startsWith("{")) {
      return [line];
    }
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = "FIXLAB_SUMMARY|".length; index < line.length; index += 1) {
      const character = line[index];
      if (quoted) {
        if (escaped) {escaped = false;}
        else if (character === "\\") {escaped = true;}
        else if (character === '"') {quoted = false;}
      } else if (character === '"') {quoted = true;}
      else if (character === "{") {depth += 1;}
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            JSON.parse(line.slice("FIXLAB_SUMMARY|".length, index + 1));
          } catch {
            return [line];
          }
          const remainder = line.slice(index + 1).trim();
          if (remainder && !/^FIXLAB_(?:STAGE|ACTIVITY|BUG|TEST|SUMMARY)(?:\||\s)/u.test(remainder)) {
            return [line];
          }
          return [line.slice(0, index + 1), ...(remainder ? splitRenderedMarkers(remainder) : [])];
        }
      }
    }
    return [line];
  }
  if (!/^FIXLAB_(?:STAGE|ACTIVITY|BUG|TEST)(?:\||\s)/u.test(line)) {
    return [line];
  }
  return line
    .split(/(?=FIXLAB_(?:STAGE|ACTIVITY|BUG|TEST|SUMMARY)(?:\||\s))/u)
    .filter(Boolean);
}

function appendLine(job, stream, line) {
  if (line.startsWith("FIXLAB_SUMMARY|")) {
    try {
      if (job.permissionRequest || Buffer.byteLength(line) > 16384) {
        throw new Error("Summary is blocked by pending permission review or exceeds 16 KiB.");
      }
      job.engineeringSummary = normalizeEngineeringSummary(JSON.parse(line.slice("FIXLAB_SUMMARY|".length)));
      job.engineeringSummaryOrigin = "agent-reported";
    } catch (error) {
      pushLog(job, { index: job.nextLogIndex, timestamp: new Date().toISOString(),
        stream: "dashboard", message: `Engineering summary rejected: ${error instanceof SyntaxError ? "Invalid JSON." : error.message}` });
    }
    return;
  }
  const usage = parseUsageLine(line);
  if (usage) {
    if (job.runtime !== "copilot") {
      job.usage = usage;
    }
    return;
  }
  pushLog(job, {
    index: job.nextLogIndex,
    timestamp: new Date().toISOString(),
    stream,
    message: line
  });
  if (runtimePermissionDenialLine(line)) {
    job.permissionRequest ??= newPermissionRequest();
  }
  if (job.permissionRequest) {
    return;
  }
  const activityMarker = line.match(/^FIXLAB_ACTIVITY\|([^|]+)\|(.*)$/);
  if (activityMarker) {
    const [, stage, message] = activityMarker;
    if (!FIXLAB_STAGES.includes(stage)) {
      pushLog(job, {
        index: job.nextLogIndex,
        timestamp: new Date().toISOString(),
        stream: "dashboard",
        message: `Ignored invalid activity marker: ${line}`
      });
      return;
    }
    pushActivity(job, {
      timestamp: new Date().toISOString(),
      stage,
      message: safeSummary(message)
    });
    return;
  }
  const bugMarker = line.match(
    /^FIXLAB_BUG\|(\d+)\|([^|]+)\|([^|]+)\|(.*)$/
  );
  if (bugMarker) {
    const [, id, outcome, owner, summary] = bugMarker;
    const bug = job.bugs.find((candidate) => candidate.id === id);
    if (!bug || !bugOutcomeStatuses.has(outcome)) {
      pushLog(job, {
        index: job.nextLogIndex,
        timestamp: new Date().toISOString(),
        stream: "dashboard",
        message: `Ignored invalid bug outcome marker: ${line}`
      });
      return;
    }

    bug.outcome = outcome;
    bug.owner = safeSummary(owner);
    bug.summary = safeSummary(summary);
    return;
  }

  const testMarker = line.match(
    /^FIXLAB_TEST\|([^|]+)\|([^|]+)\|(.*)$/
  );
  if (testMarker) {
    const [, source, mutationMode, scenario] = testMarker;
    if (!testDataSources.has(source) || !mutationModes.has(mutationMode)) {
      pushLog(job, {
        index: job.nextLogIndex,
        timestamp: new Date().toISOString(),
        stream: "dashboard",
        message: `Ignored invalid test evidence marker: ${line}`
      });
      return;
    }
    const selectedMode = job.testEvidence.selectedMutationMode;
    if ((source === "production-read-only") !== (job.testEvidence.productionDatabaseReadOnly === true)) {
      job.testEvidence.modeViolation = true;
      pushLog(job, { index: job.nextLogIndex, timestamp: new Date().toISOString(), stream: "dashboard",
        message: "Rejected evidence that mislabels the approved database environment." });
      return;
    }
    if (job.testEvidence.apiOnly &&
        (mutationMode !== "none" || !(job.testEvidence.productionDatabaseReadOnly
          ? ["production-read-only"] : ["non-production-read-only", "local-fixture"]).includes(source))) {
      job.testEvidence.modeViolation = true;
      pushLog(job, {
        index: job.nextLogIndex,
        timestamp: new Date().toISOString(),
        stream: "dashboard",
        message: "Rejected API-only evidence that claims synthetic interception or mutations."
      });
      return;
    }
    if (selectedMode && (mutationMode !== selectedMode ||
        (selectedMode === "none" && source === "synthetic-intercepted"))) {
      job.testEvidence.modeViolation = true;
      pushLog(job, {
        index: job.nextLogIndex,
        timestamp: new Date().toISOString(),
        stream: "dashboard",
        message: "Rejected browser evidence that conflicts with this run's explicit request-interception choice."
      });
      return;
    }
    job.testEvidence = {
      ...job.testEvidence,
      source,
      mutationMode,
      reported: true,
      scenario: safeSummary(scenario)
    };
    return;
  }

  if (line === "FIXLAB_MANUAL|localhost|pending") {
    if (!job.manualLocalhostTest) {
      pushLog(job, {
        index: job.nextLogIndex,
        timestamp: new Date().toISOString(),
        stream: "dashboard",
        message: "Ignored manual localhost marker for a job without that option."
      });
      return;
    }
    job.manualLocalhostPending = true;
    job.manualLocalhostResult = null;
    return;
  }

  const marker =
    line.match(/^FIXLAB_STAGE\|([^|]+)\|([^|]+)\|(.*)$/) ??
    line.match(/^FIXLAB_STAGE\s+(\S+)\s+(\S+)\s+-\s+(.*)$/);
  if (!marker) {
    return;
  }
  const [, stage, status, message] = marker;
  if (!FIXLAB_STAGES.includes(stage) || !allStatuses.has(status)) {
    pushLog(job, {
      index: job.nextLogIndex,
      timestamp: new Date().toISOString(),
      stream: "dashboard",
      message: `Ignored invalid stage marker: ${line}`
    });
    return;
  }
  job.stages[stage] = { status, message: message.trim() };
  if (status === "failed" && !job.error) {
    job.error = message.trim() || `${stage} failed`;
  }
}

function pushLog(job, entry) {
  job.nextLogIndex += 1;
  job.logs.push(entry);
  if (job.logs.length > MAX_JOB_LOG_ENTRIES) {
    job.logs.shift();
    job.droppedLogs += 1;
  }
}

function pushActivity(job, entry) {
  job.activity.push(entry);
  if (job.activity.length > MAX_JOB_ACTIVITY_ENTRIES) {
    job.activity.shift();
  }
}

function finishJob(job, result) {
  job.toolApprovalMode = "ask";
  job.postWriteApproval = null;
  flushPartialOutput(job);

  if (result.error?.workspaceReview) {
    job.workspaceReview = result.error.workspaceReview;
    job.stages.intake = { status: "blocked", message: result.error.message };
    for (const stage of FIXLAB_STAGES.slice(1)) {
      if (["pending", "running"].includes(job.stages[stage].status)) {
        job.stages[stage] = { status: "skipped", message: "Waiting for an explicit workspace recovery decision." };
      }
    }
    job.status = "blocked";
    job.error = result.error.message;
    job.finishedAt = new Date().toISOString();
    return;
  }

  if (job.permissionRequest) {
    const activeStage = FIXLAB_STAGES.find(
      (stage) => job.stages[stage].status === "running"
    ) ?? FIXLAB_STAGES.find(
      (stage) => job.stages[stage].status === "blocked"
    ) ?? "diagnosis";
    job.stages[activeStage] = {
      status: "blocked",
      message: PERMISSION_BLOCKED_MESSAGE
    };
    for (const stage of FIXLAB_STAGES) {
      if (["pending", "running"].includes(job.stages[stage].status)) {
        job.stages[stage] = {
          status: "skipped",
          message: "Not run while runtime permission is unresolved."
        };
      }
    }
    job.status = "blocked";
    job.error = PERMISSION_BLOCKED_MESSAGE;
    job.finishedAt = new Date().toISOString();
    return;
  }

  if (job.testEvidence.unitTestsOnly) {
    for (const stage of ["local-stack", "live-test"]) {
      if (job.stages[stage].status === "passed") {
        job.stages[stage] = {
          status: "failed",
          message: "Unit-test-only validation must report application startup and live tests skipped, not passed."
        };
        job.error = job.stages[stage].message;
      }
    }
  }
  if (job.testEvidence.modeViolation) {
    job.stages["live-test"] = {
      status: "failed",
      message: job.testEvidence.apiOnly
        ? "API-only evidence must report real read-only API validation, not synthetic interception or mutations."
        : "Browser evidence conflicts with the explicitly selected per-run mutation mode."
    };
    job.error = job.stages["live-test"].message;
  }

  if (
    job.testEvidence.enabled &&
    job.testEvidence.requireScenarioEvidence &&
    job.stages["live-test"].status === "passed" &&
    (!job.testEvidence.reported || !job.testEvidence.scenario)
  ) {
    const message =
      "Live-test passed without required FIXLAB_TEST scenario evidence.";
    job.stages["live-test"] = { status: "failed", message };
    job.error = job.error ? `${job.error}; ${message}` : message;
  }

  if (job.manualLocalhostPending) {
    job.stages["live-test"] = {
      status: "blocked",
      message:
        "Manual React localhost validation requires an explicit Passed or Failed result."
    };
  }
  if (job.manualLocalhostResult === "failed") {
    const message = "Manual React localhost validation failed.";
    job.stages["live-test"] = { status: "failed", message };
    job.error = job.error ? `${job.error}; ${message}` : message;
  }
  if (job.validationIntent === "scoped" &&
      !(job.mode === "fix-and-validate" && job.workflow?.mode === "efficient") &&
      !allowsDraftIntegrationDeferral(job)) {
    job.stages.review = { status: "blocked", message: "Full regression is explicitly deferred during scoped iteration, not passed." };
  }
  if (job.validationSession) {
    try {
      const validation = job.validationSession.verify();
      if (!["passed", "unconfigured", ...(job.workflow?.mode === "efficient" ? ["advisory"] : [])].includes(validation.status) &&
          !(allowsDraftIntegrationDeferral(job) && validation.draftReady) &&
          !allowsUnverifiedDraft(job)) {
        job.stages.review = {
          status: "blocked",
          message: "Required executor-backed validation is missing, failed, or stale."
        };
      }
    } catch (error) {
      job.stages.review = { status: "blocked", message: error.message };
      job.validationSession.error = "Could not verify current validation inputs.";
    }
  }

  const missing = FIXLAB_STAGES.filter(
    (stage) => !terminalStatuses.has(job.stages[stage].status)
  );
  const failed = FIXLAB_STAGES.filter(
    (stage) => job.stages[stage].status === "failed"
  );
  const blocked = FIXLAB_STAGES.filter(
    (stage) => job.stages[stage].status === "blocked"
  );
  const unresolvedBugs = job.bugs.filter(
    (bug) => bug.outcome === "pending"
  );
  if (result?.error && !job.error) {
    job.error = result.error.message;
  }
  if (result?.code !== 0 && !job.error) {
    job.error = `Agency exited with code ${result?.code ?? "unknown"}${
      result?.signal ? ` (${result.signal})` : ""
    }`;
  }
  if (missing.length > 0) {
    const incomplete = `Incomplete stage markers: ${missing.join(", ")}`;
    job.error = job.error ? `${job.error}; ${incomplete}` : incomplete;
  }
  if (failed.length > 0 && !job.error) {
    job.error = `Failed stages: ${failed.join(", ")}`;
  }
  if (unresolvedBugs.length > 0) {
    const incomplete = `Missing bug outcomes: ${unresolvedBugs
      .map((bug) => bug.id)
      .join(", ")}`;
    job.error = job.error ? `${job.error}; ${incomplete}` : incomplete;
  }
  job.status =
    result?.code === 0 &&
    missing.length === 0 &&
    failed.length === 0 &&
    unresolvedBugs.length === 0
      ? blocked.length > 0
        ? "blocked"
        : "passed"
      : "failed";
  if (result?.error?.code === "INPUT_TOKEN_LIMIT") {
    job.budgetExceeded = true;
    job.status = "blocked";
    job.error = result.error.message;
    const stage = FIXLAB_STAGES.find((name) => !terminalStatuses.has(job.stages[name].status));
    if (stage) {
      job.stages[stage] = { status: "blocked", message: job.error };
    }
  }
  job.finishedAt = new Date().toISOString();
  writeCacheSummary(job.cacheContext, job);
}

function flushPartialOutput(job) {
  for (const stream of ["stdout", "stderr"]) {
    if (job.partial[stream]) {
      for (const segment of splitRenderedMarkers(job.partial[stream])) {
        appendLine(job, stream, segment);
      }
      job.partial[stream] = "";
    }
  }
}

function holdJob(job) {
  job.toolApprovalMode = "ask";
  job.postWriteApproval = null;
  flushPartialOutput(job);
  const activeStage =
    FIXLAB_STAGES.find((stage) => job.stages[stage].status === "running") ??
    FIXLAB_STAGES.find((stage) => !terminalStatuses.has(job.stages[stage].status));
  if (activeStage) {
    job.stages[activeStage] = {
      status: "blocked",
      message: "Held by the user; resume continues from this stage."
    };
  }
  job.status = "held";
  job.heldAt = new Date().toISOString();
  job.lastActivityAt = job.heldAt;
  job.finishedAt = null;
  job.error = null;
  job.holdRequested = false;
}

function buildResumePrompt(job, { action, details }) {
  const transientGuidance = ["validate-only", "playwright-only"].includes(job.mode)
    ? TRANSIENT_PLAYWRIGHT_GUIDANCE : "";
  if (job.mode === "playwright-only") {
    return `${job.initialPrompt}

Resume the existing FixLab dashboard session for job ${job.id}.
User action: ${action}
User input:
${details}
${transientGuidance}

Browser-only continuation:
- The original browser-only mode, environment, interception selection and data-safety rules above remain authoritative over generic retry wording.
- Reuse completed browser setup, exact user decisions, retained scripts and evidence. Do not repeat completed assertions or broad investigation.
- Do not perform implementation, review, commits, push, pull-request creation or publication. Report diagnosis, reproduce, fix, review and pr skipped because this is browser-only validation.
- A busy authentication profile is a prerequisite blocker. Do not retry unchanged browser launch, change profile or copy authentication state. Human confirmation alone is not evidence that the owning process exited.
- Keep the same-job test script while a browser prerequisite remains unresolved; do not delete and regenerate it during retries.
- If the prerequisite is still unavailable, report live-test blocked with the exact reason and stop. Never fabricate screenshots, assertions or a pass.
- Emit required FIXLAB_BUG and terminal FIXLAB_STAGE markers before finishing.`;
  }
  const expectedBugs = job.bugs.map((bug) => bug.id).join(", ");
  const manualResult = job.manualLocalhostResult
    ? `Persisted manual React localhost result: ${job.manualLocalhostResult}.
- Preserve this accepted result as job evidence across retries or dashboard restarts.
- Do not ask for another manual result unless a new frontend change invalidates it.`
    : "No persisted manual React localhost result is available.";
  return `Resume the existing FixLab dashboard session for job ${job.id}.
User action: ${action}
User input:
${details}
${manualResult}
${transientGuidance}
${job.mode === "fix-and-validate" && job.engineeringSummary
    ? `Retained bug-to-code-fix explanation (recorded, not new verification):\n${JSON.stringify(job.engineeringSummary)}`
    : ""}

Resume requirements:
${job.mode === "fix-and-validate" ? ENGINEERING_SUMMARY_GUIDANCE : ""}
- Reuse the completed diagnosis, current worktree, validation evidence, branch, and pull request from this session.
- Re-read repository instructions and the effective diff only when the new input changes them.
- Continue from the blocked or failed stage, or treat this as a focused addition to the completed job.
- Do not repeat completed investigation, dependency installation, broad tests, or builds without new risk evidence.
- If the user selected skip, mark only the affected gate skipped, preserve the risk, and continue safe remaining work.
- Emit one updated FIXLAB_BUG line for every expected bug before finishing. Expected IDs: ${expectedBugs || "none"}.
- Emit terminal FIXLAB_STAGE lines for every stage before finishing.
- Do not create a duplicate or empty pull request. Reuse an existing pull request when one belongs to this session.
- Do not call task_complete or return the final response until all required machine-readable lines are emitted.`;
}

function buildFreshRetryPrompt(job, details) {
  return `${job.initialPrompt}

Retry context:
The previous runtime launch failed before FixLab completed any stage or created
a resumable session. Start this job again from intake.

User input:
${details}`;
}

function requiresFreshRetry(job, action) {
  const dashboardOnlyReview = (stage) => stage === "review" &&
    job.stages[stage].status === "blocked" && [
      "Required executor-backed validation is missing, failed, or stale.",
      "Full regression is explicitly deferred during scoped iteration, not passed."
    ].includes(job.stages[stage].message);
  const noRuntimeProgress = FIXLAB_STAGES.every((stage) =>
    job.stages[stage].status === "pending" || dashboardOnlyReview(stage)
  );
  const admissionOnly = job.workspaceReview &&
    job.stages.intake.status === "blocked" &&
    FIXLAB_STAGES.slice(1).every((stage) =>
      job.stages[stage].status === "skipped" || dashboardOnlyReview(stage)
    );
  return (
    action === "retry" &&
    (noRuntimeProgress || admissionOnly || job.browserSessionNotStarted === true) &&
    job.usage.inputTokens === 0 &&
    job.usage.outputTokens === 0
  );
}

function isContainedPath(root, candidate) {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function resolveContainedPath(root, candidate, label, { mustExist = false } = {}) {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(resolvedRoot, candidate);
  if (!isContainedPath(resolvedRoot, resolvedCandidate)) {
    throw new Error(`${label} must stay within ${resolvedRoot}`);
  }
  if (!existsSync(resolvedCandidate)) {
    if (mustExist) {
      throw new Error(`${label} does not exist`);
    }
    return resolvedCandidate;
  }
  const realRoot = realpathSync(resolvedRoot);
  const realCandidate = realpathSync(resolvedCandidate);
  if (!isContainedPath(realRoot, realCandidate)) {
    throw new Error(`${label} resolves outside ${realRoot}`);
  }
  return realCandidate;
}

function playwrightAuthenticationConfig(repository, { apiProof = false } = {}) {
  const profile = loadRepositoryProfile(repository);
  const browserAutomation = profile.browserAutomation ?? {};
  const browserAuthentication = browserAutomation.authentication ?? {};
  if (apiProof && browserAutomation.apiAuthentication?.role !== "portal") {
    throw new Error("API proof requires a configured portal authentication provider.");
  }
  const authentication = apiProof ? {
    ...browserAuthentication, ...browserAutomation.apiAuthentication
  } : browserAuthentication;
  const workingDirectory = resolveContainedPath(
    repository,
    browserAutomation.workingDirectory ??
      profile.applications?.frontend?.workingDirectory ??
      ".",
    "browserAutomation.workingDirectory",
    { mustExist: true }
  );
  const command =
    typeof authentication.command === "string"
      ? authentication.command.trim()
      : "";
  const statusPaths = Array.isArray(authentication.statusPaths)
    ? authentication.statusPaths
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim())
    : [];
  const environment = Object.fromEntries(
    Object.entries(authentication.environment ?? {}).filter(
      ([name, value]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
        typeof value === "string"
    )
  );
  return {
    command,
    mode: browserAutomation.mode ?? "browser",
    proofCommand: typeof authentication.proofCommand === "string" ? authentication.proofCommand.trim() : "",
    linkedProofRevision: authentication.linkedApplication === undefined ? null : linkedApiProofPlan(repository).revision,
    portalProofRevision: apiProof ||
      (browserAutomation.mode === "api" && browserAutomation.apiAuthentication?.role === "portal")
      ? portalApiProofRevision(repository) : null,
    environment,
    statusPaths,
    workingDirectory
  };
}

function frontendStartConfig(repository) {
  const profile = loadRepositoryProfile(repository);
  const frontend = profile.applications?.frontend ?? {};
  const command =
    typeof frontend.command === "string" ? frontend.command.trim() : "";
  if (!command) {
    throw new Error("repository profile must configure applications.frontend.command");
  }
  return {
    command,
    healthUrl: validatedManualLocalhostUrl(frontend.healthUrl),
    workingDirectory: resolveContainedPath(
      repository,
      frontend.workingDirectory ?? ".",
      "applications.frontend.workingDirectory",
      { mustExist: true }
    )
  };
}

async function frontendIsHealthy(healthUrl) {
  try {
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(2000)
    });
    await response.body?.cancel();
    return response.status < 500;
  } catch {
    return false;
  }
}

function ownedTreeRunning(child) {
  if (!child?.pid) {
    return false;
  }
  const containment = windowsOwnedTrees.get(child);
  if (containment) {
    return !containment.hasStopped();
  }
  if (child.exitCode === null && child.signalCode === null) {
    return true;
  }
  if (process.platform === "win32") {
    return false;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
    return false;
  }
}

function spawnOwnedShell(configuration, retainDescendants = false) {
  if (process.platform === "win32") {
    const executable = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
    const containment = spawnWindowsExecutor({
      executable,
      args: [],
      commandLine: `"${executable}" /d /s /c "${configuration.command}"`,
      repository: configuration.workingDirectory,
      environment: configuration.environment,
      retainDescendants
    });
    windowsOwnedTrees.set(containment.child, containment);
    // Dev servers can interpret EOF as shutdown; keep their input alive.
    if (!retainDescendants) {
      containment.child.stdin.end();
    }
    containment.child.stdin.on("error", (error) => {
      containment.child.emit("fixlab-input-error", error);
    });
    containment.child.stdout.resume();
    containment.child.stderr.resume();
    return containment.child;
  }
  const child = spawn(configuration.command, {
    cwd: configuration.workingDirectory,
    env: { ...process.env, ...configuration.environment, BROWSER: "none" },
    shell: true,
    detached: true,
    stdio: retainDescendants ? ["pipe", "ignore", "ignore"] : "ignore"
  });
  child.stdin?.on("error", (error) => {
    child.emit("fixlab-input-error", error);
  });
  return child;
}

function stopProcessTree(child) {
  if (!child?.pid) {
    return;
  }
  const containment = windowsOwnedTrees.get(child);
  if (containment) {
    containment.terminate();
    return containment.waitForStopped();
  }
  if (process.platform === "win32" && child.pid) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true
    });
    if (result.error || result.status !== 0) {
      throw result.error ?? new Error(`could not stop the owned process tree (exit ${result.status})`);
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}

async function frontendStatus(repository, connection) {
  let healthUrl = "";
  try {
    ({ healthUrl } = frontendStartConfig(repository));
  } catch (error) {
    return {
      configured: false,
      running: Boolean(connection.handle) || connection.starting === true,
      healthy: false,
      owned: Boolean(connection.handle) || connection.starting === true,
      error: error.message,
      lastResult: connection.lastResult
    };
  }
  return {
    configured: true,
    running: Boolean(connection.handle) || connection.starting === true,
    healthy: await frontendIsHealthy(healthUrl),
    owned: Boolean(connection.handle) || connection.starting === true,
    healthUrl,
    error: "",
    lastResult: connection.lastResult
  };
}

function authenticationProofIdentity(configuration, job) {
  let stateFiles = 0;
  const paths = configuration.statusPaths.map((path) => {
    const file = resolveContainedPath(configuration.workingDirectory, path, "authentication status path");
    const info = lstatSync(resolve(configuration.workingDirectory, path));
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) ||
        (info.isFile() && info.nlink !== 1)) {
      throw new Error("Authentication status must be an unlinked file or browser-profile directory.");
    }
    if (info.isDirectory()) {
      return [path, file, info.dev, info.ino, "directory"];
    }
    stateFiles += 1;
    return [path, file, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs];
  });
  if (!stateFiles) {
    throw new Error("Authentication proof requires at least one regular status file.");
  }
  return JSON.stringify({
    mode: configuration.mode,
    command: configuration.command,
    proofCommand: configuration.proofCommand,
    linkedProofRevision: configuration.linkedProofRevision,
    portalProofRevision: configuration.portalProofRevision,
    workingDirectory: configuration.workingDirectory,
    environment: configuration.environment,
    jobId: job?.id ?? null,
    targetEnvironment: job?.targetEnvironment ?? null,
    paths
  });
}

function playwrightAuthenticationStatus(repository, connection, job) {
  let configuration;
  try {
    configuration = playwrightAuthenticationConfig(repository, { apiProof: connection.apiProof === true });
  } catch (error) {
    return {
      configured: false,
      ready: false,
      running: Boolean(connection.handle),
      error: error.message,
      lastResult: connection.lastResult,
      paths: []
    };
  }
  const paths = configuration.statusPaths.map((relativePath) => {
    const path = resolveContainedPath(
      configuration.workingDirectory,
      relativePath,
      "browserAutomation.authentication.statusPaths entry"
    );
    return {
      path: relativePath,
      ready: existsSync(path)
    };
  });
  let proofMatches = false;
  if (connection.proof && configuration.proofCommand && paths.every((entry) => entry.ready)) {
    try {
      proofMatches = connection.proof === authenticationProofIdentity(configuration, job);
    } catch (error) {
      return { configured: true, ready: false, running: Boolean(connection.handle),
        error: error.message, lastResult: connection.lastResult, paths };
    }
  }
  return {
    configured: Boolean(
      configuration.command && configuration.statusPaths.length > 0
    ),
    ready:
      Boolean(configuration.command) &&
      paths.length > 0 &&
      paths.every((entry) => entry.ready) && proofMatches,
    statePresent: paths.length > 0 && paths.every((entry) => entry.ready),
    proofConfigured: Boolean(configuration.proofCommand),
    runId: connection.runId ?? null,
    running: Boolean(connection.handle),
    error: "",
    lastResult: connection.lastResult,
    paths
  };
}

function playwrightArtifactRoots(repository) {
  const configuration = playwrightAuthenticationConfig(repository);
  return ["test-results", "playwright-report", "artifacts"]
    .map((directory) =>
      resolveContainedPath(
        configuration.workingDirectory,
        directory,
        `Playwright artifact root ${directory}`
      )
    )
    .filter((directory) => existsSync(directory));
}

function collectPlaywrightArtifacts(root, directory = root, depth = 0) {
  if (depth > 6) {
    return [];
  }
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectPlaywrightArtifacts(root, path, depth + 1));
      continue;
    }
    const extension = extname(entry.name).toLowerCase();
    if (
      ![".png", ".jpg", ".jpeg", ".webp", ".webm", ".mp4"].includes(
        extension
      )
    ) {
      continue;
    }
    const resolvedPath = realpathSync(path);
    const relativePath = relative(root, resolvedPath);
    if (
      relativePath.startsWith("..") ||
      isAbsolute(relativePath)
    ) {
      continue;
    }
    const stats = statSync(resolvedPath);
    const video = [".webm", ".mp4"].includes(extension);
    if (
      stats.size >
      (video ? MAX_PLAYWRIGHT_VIDEO_BYTES : MAX_SCREENSHOT_BYTES)
    ) {
      continue;
    }
    files.push({
      id: createHash("sha256").update(resolvedPath).digest("hex").slice(0, 24),
      path: resolvedPath,
      name: basename(resolvedPath),
      relativePath,
      bytes: stats.size,
      updatedAt: stats.mtime.toISOString(),
      kind: video ? "video" : "image",
      mimeType:
        extension === ".png"
          ? "image/png"
          : extension === ".webp"
            ? "image/webp"
            : extension === ".webm"
              ? "video/webm"
              : extension === ".mp4"
                ? "video/mp4"
                : "image/jpeg"
    });
  }
  return files;
}

function listPlaywrightArtifacts(repository, { since = null } = {}) {
  return playwrightArtifactRoots(repository)
    .flatMap((root) =>
      collectPlaywrightArtifacts(root)
        .map((artifact) => ({
          ...artifact,
          relativePath: join(basename(root), artifact.relativePath)
        }))
    )
    .sort(
      (left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    )
    .filter(
      (artifact) =>
        !since || Date.parse(artifact.updatedAt) >= Date.parse(since)
    )
    .slice(0, MAX_PLAYWRIGHT_ARTIFACTS);
}

function resetJobForResume(job) {
  job.toolApprovalMode = "ask";
  job.postWriteApproval = null;
  const restartIndex =
    job.status === "passed"
      ? FIXLAB_STAGES.indexOf("diagnosis")
      : job.status === "held"
        ? Math.max(
            0,
            FIXLAB_STAGES.findIndex((stage) =>
              ["blocked", "failed", "running", "pending"].includes(
                job.stages[stage].status
              )
            )
          )
      : Math.max(
          0,
          FIXLAB_STAGES.findIndex((stage) =>
            ["blocked", "failed", "running"].includes(
              job.stages[stage].status
            )
          )
        );
  for (const stage of FIXLAB_STAGES.slice(restartIndex)) {
    job.stages[stage] = { status: "pending", message: "" };
  }
  for (const bug of job.bugs) {
    bug.outcome = "pending";
    bug.owner = "";
    bug.summary = "";
  }
  job.status = "running";
  job.heldAt = null;
  job.finishedAt = null;
  job.error = null;
  job.partial = { stdout: "", stderr: "" };
  delete job.testEvidence.modeViolation;
}

export function createDashboardServer({
  repository,
  packageRoot,
  runtime = "agency",
  model = "",
  publicDirectory = join(packageRoot, "dashboard", "public"),
  executor = createRuntimeExecutor({ packageRoot, runtime, model }),
  workItemLoader = createAzureDevOpsLoader(),
  browserOpener = openLocalUrl,
  browserOwnership = inspectBrowserProfileOwnership,
  preflight = null,
  executionIdleTimeoutMs,
  executionHeartbeatMs = DEFAULT_EXECUTION_HEARTBEAT_MS,
  workspaceServers = new Map(),
  ownsWorkspaceServers = true,
  workspaceHostState = { closing: false }
}) {
  const resolvedRepository = resolve(repository);
  const defaultModel = validateCopilotModel(model, runtime);
  let currentJob = null;
  let activeHandle = null;
  let activeTermination = null;
  const queuedJobs = [];
  const heldJobs = [];
  const completedJobs = [];
  const artifactDirectories = new Set();
  const playwrightConnection = { handle: null, lastResult: null };
  const frontendConnection = { handle: null, lastResult: null, starting: false };
  let frontendStartGeneration = 0;
  const playwrightArtifacts = new Map();
  const cacheContext = createCacheContext(resolvedRepository);
  const sessions = createSessionRegistry(
    cacheContext?.repositoryIdentityHash ?? resolvedRepository
  );
  const executorLease = createExecutorLease(resolvedRepository, sessions.id);
  let dashboardUrl = "";
  let closing = false;
  const setupPlans = new Map();

  async function repositoryWorkspaceOwners(root) {
    const common = canonicalExecutionRepository(root).repository;
    const catalog = await sessions.repositories({ scopeIds: [
      createSessionRegistry(root).scopeId,
      createSessionRegistry(hash(common)).scopeId
    ] });
    if (catalog.unavailableCount) {
      throw new Error("Cannot verify every registered owner of this repository. Reconnect to its owner and verify its resources are idle before changing settings or opening another workspace.");
    }
    return catalog.repositories.filter((entry) => sameExistingRepository(entry.repository, root));
  }

  async function openRepositoryWorkspace(root, verify = () => {}) {
    if (!inspectRepositorySettings(root).exists) {
      throw new Error("Apply the reviewed repository setup before opening its workspace.");
    }
    const existing = (await repositoryWorkspaceOwners(root))[0];
    verify();
    if (existing) {
      return { url: existing.url, repository: root, startedJob: false };
    }
    if (closing || workspaceHostState.closing) {
      throw new Error("The dashboard is shutting down.");
    }
    let workspace = workspaceServers.get(root);
    if (!workspace) {
      if (workspaceServers.size >= 8) {
        throw new Error("This host already owns eight additional repository workspaces.");
      }
      const dashboard = createDashboardServer({
        repository: root, packageRoot, runtime, model, executor, preflight, browserOpener, browserOwnership,
        workspaceServers, ownsWorkspaceServers: false, workspaceHostState
      });
      workspace = { dashboard, ready: dashboard.listen({ port: 0 }) };
      workspaceServers.set(root, workspace);
    }
    let address;
    try {
      address = await workspace.ready;
    } catch (error) {
      workspaceServers.delete(root);
      await workspace.dashboard.close();
      throw error;
    }
    if (closing || workspaceHostState.closing) {
      throw new Error("The dashboard is shutting down.");
    }
    verify();
    return { url: address.url, repository: root, startedJob: false };
  }

  async function launchFrontend(verifyConversation = () => {}) {
    const generation = frontendStartGeneration;
    const configuration = frontendStartConfig(resolvedRepository);
    if (frontendConnection.handle || frontendConnection.starting) {
      throw new Error("FixLab already started the frontend");
    }
    frontendConnection.starting = true;
    try {
      const owners = await sessions.list();
      const conflict = owners.find((owner) =>
        owner.id !== sessions.id && owner.available && owner.frontend?.running
      );
      if (conflict) {
        throw new Error(`Frontend is owned by FixLab dashboard ${conflict.id}; reconnect or confirm stopping that owner.`);
      }
      if (closing || generation !== frontendStartGeneration) {
        throw new Error("frontend startup was cancelled");
      }
      if (await frontendIsHealthy(configuration.healthUrl)) {
        return { started: false };
      }
      if (closing || generation !== frontendStartGeneration) {
        throw new Error("frontend startup was cancelled");
      }
      verifyConversation();
      frontendConnection.lastResult = null;
      const child = spawnOwnedShell(configuration, true);
      frontendConnection.handle = child;
      child.once("fixlab-input-error", (error) => {
        frontendConnection.lastResult = {
          ok: false,
          message: `Frontend input failed: ${error.message}`,
          finishedAt: new Date().toISOString()
        };
      });
      child.once("error", (error) => {
        frontendConnection.lastResult = {
          ok: false,
          message: error.message,
          finishedAt: new Date().toISOString()
        };
        if (frontendConnection.handle === child) {
          frontendConnection.handle = null;
        }
      });
      child.once("close", (code) => {
        if (frontendConnection.handle === child) {
          try {
            if (ownedTreeRunning(child)) {
              if (process.platform === "win32") {
                frontendConnection.lastResult = {
                  ok: false,
                  message: "Frontend termination is unverified; ownership is retained.",
                  finishedAt: new Date().toISOString()
                };
              }
              return;
            }
          } catch (error) {
            frontendConnection.lastResult = {
              ok: false,
              message: `Frontend termination is unverified: ${error.message}`,
              finishedAt: new Date().toISOString()
            };
            return;
          }
          frontendConnection.handle = null;
          frontendConnection.lastResult = {
            ok: code === 0,
            message: `Frontend process exited with code ${code ?? "unknown"}.`,
            finishedAt: new Date().toISOString()
          };
        }
      });
      return { started: true };
    } finally {
      frontendConnection.starting = false;
    }
  }

  async function prewarmFrontend(job) {
    try {
      const result = frontendConnection.handle || frontendConnection.starting
        ? { started: false }
        : await launchFrontend();
      pushLog(job, {
        index: job.nextLogIndex,
        timestamp: new Date().toISOString(),
        stream: "dashboard",
        message: result.started
          ? "React warm-up started in parallel with the agent. Live testing must wait for health and verify the server serves the validated checkout."
          : "React warm-up reuses the existing frontend; live testing must verify its health and checkout."
      });
    } catch (error) {
      pushLog(job, {
        index: job.nextLogIndex,
        timestamp: new Date().toISOString(),
        stream: "dashboard",
        message: `React warm-up did not start: ${error.message}. The agent must report any live-test prerequisite that remains blocked.`
      });
    }
  }
  const metricsPath = cacheContext
    ? join(dirname(cacheContext.cachePath), "dashboard-metrics.json")
    : null;
  const dashboardHistoryPath = cacheContext
    ? join(dirname(cacheContext.cachePath), "dashboard-jobs.json")
    : null;
  const loadedMetrics = readMetrics(metricsPath);
  let metricsRecords = loadedMetrics.records;
  let metricsWarning = loadedMetrics.warning;
  const loadedDashboardHistory = readDashboardHistory(dashboardHistoryPath, metricsRecords);
  let persistedJobs = loadedDashboardHistory.jobs.map((job) =>
    recoverInterruptedDashboardJob(job)
  );
  let dashboardHistoryWarning = loadedDashboardHistory.warning;
  for (const snapshot of persistedJobs.filter((job) => job.status === "held")) {
    heldJobs.push(restoreDashboardJob(snapshot, resolvedRepository));
  }
  persistedJobs = persistedJobs.filter((job) => job.status !== "held");
  const resumableSnapshot = persistedJobs.find((job) =>
    ["blocked", "failed", "passed"].includes(job.status) &&
    (job.runtime ?? (job.model ? "copilot" : "")) === runtime
  );
  if (resumableSnapshot) {
    currentJob = restoreDashboardJob(
      resumableSnapshot,
      resolvedRepository
    );
    if (currentJob.runtime !== runtime) {
      currentJob.resumeDisabled = true;
    }
    persistedJobs = persistedJobs.filter(
      (job) => job.id !== resumableSnapshot.id
    );
  }

  function dashboardHistory() {
    const liveIds = new Set([
      currentJob?.id,
      ...queuedJobs.map((job) => job.id),
      ...heldJobs.map((job) => job.id),
      ...completedJobs.map((job) => job.id)
    ]);
    return [
      ...publicHistory(completedJobs),
      ...persistedJobs.filter((job) => !liveIds.has(job.id))
    ].slice(0, MAX_DASHBOARD_HISTORY_ENTRIES);
  }

  function persistDashboardState() {
    const snapshots = [
      ...(currentJob ? [dashboardSnapshot(currentJob)] : []),
      ...queuedJobs.map(dashboardSnapshot),
      ...heldJobs.map(dashboardSnapshot),
      ...completedJobs.map(dashboardSnapshot),
      ...persistedJobs
    ];
    const unique = [];
    const ids = new Set();
    for (const job of snapshots) {
      if (!job?.id || ids.has(job.id)) {
        continue;
      }
      ids.add(job.id);
      unique.push(job);
    }
    persistedJobs = unique.slice(0, MAX_DASHBOARD_HISTORY_ENTRIES);
    try {
      writeDashboardHistory(dashboardHistoryPath, persistedJobs);
      dashboardHistoryWarning = null;
    } catch {
      dashboardHistoryWarning =
        "Dashboard jobs remain visible in memory but could not be persisted.";
    }
  }

  function recordJobMetric(job) {
    metricsRecords = updateJobMetrics(metricsRecords, job);
    try {
      writeMetrics(metricsPath, metricsRecords);
      metricsWarning = null;
    } catch {
      metricsWarning =
        "Dashboard metrics were updated in memory but could not be persisted.";
    }
    persistDashboardState();
  }

  function archiveJob(job) {
    if (!job || completedJobs.some((entry) => entry.id === job.id)) {
      return;
    }
    completedJobs.unshift(job);
    completedJobs.splice(20);
  }

  function retireCurrentJob() {
    if (!currentJob) {
      return;
    }
    if (currentJob.artifactDirectory) {
      removeArtifactDirectory(currentJob.artifactDirectory);
      artifactDirectories.delete(currentJob.artifactDirectory);
    }
    archiveJob(currentJob);
    currentJob = null;
  }

  function retainedJob(jobId) {
    return [
      currentJob,
      ...queuedJobs,
      ...heldJobs,
      ...completedJobs,
      ...persistedJobs
    ].find((job) => job?.id === jobId);
  }

  function createRestartedJob(source, status) {
    const sourceJob = source.screenshots
      ? source
      : restoreDashboardJob(source, resolvedRepository);
    const createdAt = new Date().toISOString();
    const snapshot = {
      ...dashboardSnapshot(sourceJob),
      id: randomUUID(),
      fileAccess: null,
      sourceEditReview: null,
      runtimeDirectoryGrants: [],
      workflow: configuredWorkflow(loadRepositoryProfile(resolvedRepository)),
      status,
      createdAt,
      startedAt: status === "running" ? createdAt : null,
      heldAt: null,
      sharedWorkspace: null,
      workspaceReview: null,
      workspaceStash: null,
      validationBaseline: null,
      validationHistory: { complete: true, gates: [] },
      engineeringSummary: null,
      engineeringSummaryOrigin: null,
      finishedAt: null,
      lastActivityAt: status === "running" ? createdAt : null,
      error: null,
      permissionBlocked: false,
      permissionPreflightReviewed: false,
      permissionPreflightPending: false,
      manualLocalhostOpenedAt: null,
      manualLocalhostPending: false,
      manualLocalhostResult: null,
      testEvidence: configuredTestSynthesis(
        loadRepositoryProfile(resolvedRepository),
        sourceJob.testEvidence.selectedMutationMode ?? "",
        sourceJob.testEvidence.allowPostRequests,
        sourceJob.targetEnvironment
      ),
      stages: Object.fromEntries(
        FIXLAB_STAGES.map((stage) => [
          stage,
          { status: "pending", message: "" }
        ])
      ),
      bugs: (sourceJob.bugs ?? []).map((bug) => ({
        id: bug.id,
        outcome: "pending",
        owner: "",
        summary: ""
      }))
    };
    const restarted = restoreDashboardJob(snapshot, resolvedRepository);
    restarted.validationRecovered = false;
    restarted.pendingPrompt = restarted.initialPrompt;
    return restarted;
  }

  function moveHeldJob(job) {
    holdJob(job);
    if (!heldJobs.some((candidate) => candidate.id === job.id)) {
      heldJobs.unshift(job);
    }
    recordJobMetric(job);
  }

  function purgeableJob(job, cutoff) {
    if (!["passed", "failed", "blocked", "cancelled"].includes(job.status)) {
      return false;
    }
    const timestamp = Date.parse(
      job.finishedAt ?? job.lastActivityAt ?? job.createdAt
    );
    return Number.isFinite(timestamp) && timestamp < cutoff;
  }

  function startJob(job, prompt, resume = false) {
    if (job.inputTokenLimit > 0 && job.usage.inputTokens >= job.inputTokenLimit) {
      const error = new Error("Input-token ceiling already reached. Explicitly review and increase or remove this job's budget before resuming.");
      error.code = "INPUT_TOKEN_LIMIT";
      throw error;
    }
    if (job.browserSessionNotStarted) {
      resume = false;
    }
    if (job.permissionPreflight && !job.permissionPreflightReviewed && !job.permissionRequest) {
      job.permissionRequest = newPermissionRequest({ preflight: true });
      job.status = "blocked";
      job.error = "Review and explicitly approve the required external folder before the first executor starts. No runtime permission has been granted.";
      job.stages.intake = { status: "blocked", message: job.error };
      recordJobMetric(job);
      return;
    }
    if (job.permissionRequest) {
      throw new Error("Runtime permission is unresolved; review its scope in the dashboard before resuming.");
    }
    let runtimeDirectories;
    try {
      runtimeDirectories = (job.runtimeDirectoryGrants ?? []).map(
        (scope) => verifyPermissionDirectory(scope, {
          repository: resolvedRepository,
          packageRoot
        })
      );
    } catch (error) {
      job.permissionRequest = newPermissionRequest({ preflight: !resume });
      job.runtimeDirectoryGrants = [];
      throw new Error(`A previously approved folder changed; review permissions again: ${error.message}`);
    }
    if (job.runtime !== runtime) {
      throw new Error("Saved job runtime does not match this dashboard; reconnect using its originating runtime.");
    }
    const currentProfile = loadRepositoryProfile(resolvedRepository);
    if ((job.testEvidence.unitTestsOnly === true) !==
        (currentProfile.validation?.liveTestsRequired === false)) {
      throw new Error("The repository live-test policy changed; start a newly reviewed job.");
    }
    const currentDevReads = configuredTestSynthesis(currentProfile, "", undefined, job.targetEnvironment).devReadOnly === true;
    if (currentDevReads !== (job.testEvidence.devReadOnly === true)) {
      throw new Error("The DEV portal read policy changed; start a newly reviewed job.");
    }
    const currentPpeReads = configuredTestSynthesis(currentProfile, "", undefined, job.targetEnvironment).ppeReadOnly === true;
    if (currentPpeReads !== (job.testEvidence.ppeReadOnly === true)) {
      throw new Error("The PPE portal read policy changed; start a newly reviewed job.");
    }
    if (currentProfile.browserAutomation?.apiAuthentication?.productionDatabaseReadOnly &&
        currentProfile.browserAutomation.mode !== "api") {
      throw new Error("Production database approval permits dedicated API proof only in a portal workspace; run jobs from an API-only profile.");
    }
    if (job.testEvidence.productionDatabaseReadOnly ||
        (currentProfile.browserAutomation?.mode === "api" &&
          currentProfile.browserAutomation.apiAuthentication?.productionDatabaseReadOnly)) {
      const currentEvidence = configuredTestSynthesis(currentProfile, job.testEvidence.selectedMutationMode ?? "", undefined, job.targetEnvironment);
      if ((currentEvidence.productionDatabaseReadOnly === true) !== (job.testEvidence.productionDatabaseReadOnly === true) ||
          (job.targetEnvironment && job.targetEnvironment !== "local") ||
          job.testEvidence.source !== "production-read-only" || job.testEvidence.mutationMode !== "none") {
        throw new Error("Production database approval or evidence changed; start a newly reviewed local read-only job.");
      }
      if (!validateLiveTestProfile(currentProfile, resolvedRepository).ok) {
        throw new Error("Production database safety configuration changed; correct the profile and start a newly reviewed local read-only job.");
      }
    }
    if (job.testEvidence.productionDatabaseReadOnly &&
        !playwrightAuthenticationStatus(resolvedRepository, playwrightConnection, job).ready) {
      job.status = "blocked";
      job.error = "Complete fresh portal-backed API authentication and its database read-only check for this job before production reads.";
      job.stages["live-test"] = { status: "blocked", message: job.error };
      pushActivity(job, { stage: "live-test", message: job.error, timestamp: new Date().toISOString() });
      persistDashboardState();
      return;
    }
    validateCopilotModel(job.model, runtime);
    const authentication = runtime === "copilot" ? playwrightAuthenticationConfig(resolvedRepository) : null;
    const protectedPaths = authentication?.statusPaths.map((path) =>
      resolveContainedPath(authentication.workingDirectory, path, "browserAutomation.authentication.statusPaths entry")
    ) ?? [];
    if (job.mode === "playwright-only" && !job.manualLocalhostTest &&
        loadRepositoryProfile(resolvedRepository).browserAutomation?.mode !== "api") {
      let blocker;
      try {
        blocker = browserOwnership(playwrightAuthenticationConfig(resolvedRepository));
      } catch (error) {
        blocker = { kind: "browser-preflight-error", message: error.message };
      }
      if (blocker) {
        job.browserBlocker = blocker;
        job.browserPreflightBlocked = true;
        job.browserSessionNotStarted = job.browserSessionNotStarted === true || !resume;
        job.status = "blocked";
        job.error = blocker.message;
        job.stages["live-test"] = { status: "blocked", message: blocker.message };
        for (const stage of ["diagnosis", "reproduce", "fix", "review", "pr"]) {
          job.stages[stage] = { status: "skipped", message: "Not applicable to browser-only validation." };
        }
        job.finishedAt = new Date().toISOString();
        pushActivity(job, { stage: "live-test", message: blocker.message, timestamp: job.finishedAt });
        recordJobMetric(job);
        persistDashboardState();
        return;
      }
      job.browserBlocker = null;
      job.browserPreflightBlocked = false;
      job.browserSessionNotStarted = false;
    }
    if (isOriginWriteApproval(job.postWriteApproval)) {
      configuredTestSynthesis(currentProfile, job.testEvidence.selectedMutationMode ?? "", true, job.targetEnvironment);
      const environment = job.postWriteApproval.environment;
      const postOnly = job.postWriteApproval.mode === "post-base";
      prompt += `\nThe user explicitly authorized all ${environment.toUpperCase()} ${postOnly ? "POST requests, including writes," : "API writes"} for this job within the reviewed ${postOnly ? `dataSafety.post.${environment}.baseUrls HTTPS API bases` : `dataSafety.${environment}Write HTTPS origins`}. Use ${postOnly ? "fixlab_nonproduction_post for POST only" : `fixlab_${environment}_write for ${environment === "ppe" ? "GET, " : ""}POST, PUT, PATCH and DELETE`} without repeat confirmation or endpoint/test-record enumeration. This can change any record accessible to the signed-in account within that scope. The grant binds this job, ${environment.toUpperCase()} and the profile/helper revision, expires with execution, and stops after unsuccessful or ambiguous attempts. No other ${postOnly ? "methods, " : ""}environments, redirects, retries, shell/browser-write substitutes or browser-guard bypass. Existing authentication is required. Report approved-write evidence; HTTP success alone is not scenario success.`;
    } else if (typeof job.testEvidence.allowPostRequests === "boolean") {
      configuredTestSynthesis(currentProfile, job.testEvidence.selectedMutationMode ?? "",
        job.testEvidence.allowPostRequests, job.targetEnvironment);
      prompt += `\n${job.postWriteApproval ? "The user explicitly authorized configured DEV/SIT/UAT POST writes for this job through the POST checkbox. Use fixlab_nonproduction_post without repeat confirmation; its approval is bound to this job, environment and reviewed profile/helper revision and expires when execution ends." : "No current job-scoped POST write approval exists. Every data-changing action still requires separate exact destination/payload confirmation through fixlab_nonproduction_post."} Verified read-only POST searches follow the repository query allowlist independently of this checkbox. Approved per-environment endpoint/test-record configuration and an existing authentication helper are required; if missing, name that prerequisite and block only the action. Explicit read-only/intercepted modes, API-only/unit-only contracts and production remain restricted. Never bypass browser guards or substitute a browser/shell write. Report approved-write evidence honestly after a real action; approval alone is not scenario success.`;
    }
    if (job.testEvidence.selectedMutationMode) {
      const effective = configuredTestSynthesis(
        loadRepositoryProfile(resolvedRepository), job.testEvidence.selectedMutationMode, undefined, job.targetEnvironment
      );
      if (effective.mutationMode !== job.testEvidence.mutationMode) {
        throw new Error("The selected run's data-safety configuration changed; start a newly reviewed job.");
      }
      prompt += job.testEvidence.selectedMutationMode === "intercepted"
        ? "\nThe user explicitly selected intercepted validation for this run only. This supersedes conflicting free-text requests for no interception, but not repository safety rules. Use real permitted reads and lookups, including semantically read-only POST searches; intercept actual mutating requests. Do not classify every POST as a write. Clearly distinguish intercepted behavior from backend mutation validation. This choice grants no real-write permission and does not change shared defaults."
        : `\nThe user explicitly selected live ${job.testEvidence.productionDatabaseReadOnly ? "production-backed local API" : "non-production"} read-only validation without added interception for this run only. Do not perform or send any mutations, including Save, Submit, Approve or automatic draft persistence. Verify an action cannot write before using it; if that cannot be established, stop and ask for a safe mode. Keep repository-required guards and data-safety policy authoritative; this selection cannot waive them. Never claim backend writes were validated or disable a required guard to make the test run. Do not change shared defaults.`;
    }
    if (runtime === "copilot") {
      prompt += `\nNative dashboard interaction replaces the exit-and-resume instruction above for live human requests:
- The runtime forwards actual permission requests to the dashboard. Wait for the user's allow-once or deny response; never infer permission, request blanket grants, or substitute an ask_user answer for a denied runtime permission.
- For a genuine blocker or missing decision, use ask_user with clear safe choices and optional non-sensitive freeform input. The dashboard displays the question and waits while keeping this same executor and its repository lease alive.
- Emit a concise FIXLAB_ACTIVITY update before waiting. Do not mark later stages skipped or exit merely because a supported human question is pending.
- Keep sign-in and MFA in the normal browser. Ask only whether the user has completed that action; never collect passwords, tokens, cookies or verification codes.
- Continue this same workflow after the explicit answer, without rerunning completed work. Denied or unresolved prerequisites remain blocked, never passed.
- Do not use a question to waive repository data-safety policy, required validation, organization restrictions, or unrelated production operations. If policy and the request conflict, explain the conflict and ask for a reviewed compliant decision; do not silently rewrite policy.
- If the native request is unsupported, the user cancels, or the prerequisite remains unavailable, report the exact blocker and exit safely. Ordinary comments, PR approval and conversation replies are not runtime authorization.`;
    }
    if (closing) {
      throw new Error("the dashboard is shutting down");
    }
    if (job.workflow?.mode === "efficient" && job.mode === "fix-and-validate") {
      prompt += "\nThe saved efficient delivery workflow applies to this resume too: publish the authorized reviewed focused checkpoint before optional broad unit tests. Required repository/organization checks remain mandatory. Follow the saved post-PR test/build preferences; do not ask for the same workflow selection again.";
    } else if (job.validationIntent === "scoped") {
      prompt += "\nUser-selected scoped iteration: run only tests covering changed behavior for now. Full regression is explicitly deferred, not passed. Keep required broad gates pending and PR readiness blocked. Continue independent safe checks after an unrelated failure; never bypass dependencies, authentication, runtime permissions or data-safety approvals.";
    }
    job.acceptsValidation = true;
    const profileIdleTimeoutMinutes = Number(
      loadRepositoryProfile(resolvedRepository).validation
        ?.agentIdleTimeoutMinutes
    );
    const idleTimeoutMs =
      executionIdleTimeoutMs ??
      (Number.isFinite(profileIdleTimeoutMinutes) &&
      profileIdleTimeoutMinutes > 0
        ? profileIdleTimeoutMinutes * 60 * 1000
        : DEFAULT_EXECUTION_IDLE_TIMEOUT_MS);
    let idleTimer = null;
    let heartbeatTimer = null;
    let resolveIdleCompletion;
    let leaseMetadataError = null;
    let handle;
    const lease = executorLease.acquire(job.id);
    const pauseForPermission = () => {
      if (!job.permissionRequest || job.permissionStopRequested) {
        return;
      }
      job.permissionStopRequested = true;
      job.executorStopping = true;
      job.acceptsValidation = false;
      clearTimeout(idleTimer);
      pushLog(job, {
        index: job.nextLogIndex,
        timestamp: new Date().toISOString(),
        stream: "dashboard",
        message: "Runtime permission denial detected. Stopping the owned executor without retrying; directory access can be reviewed in the dashboard. Tool and URL denials are not approved by a folder grant."
      });
      try {
        lease.update("stopping");
      } catch (error) {
        pushLog(job, {
          index: job.nextLogIndex,
          timestamp: new Date().toISOString(),
          stream: "dashboard",
          message: `Could not update the permission-paused executor lease: ${error.message}`
        });
      }
      try {
        job.validationSession?.cancel();
      } catch (error) {
        pushLog(job, {
          index: job.nextLogIndex,
          timestamp: new Date().toISOString(),
          stream: "dashboard",
          message: `Could not cancel validation during permission pause: ${error.message}`
        });
      }
      try {
        handle?.terminate?.();
      } catch (error) {
        pushLog(job, {
          index: job.nextLogIndex,
          timestamp: new Date().toISOString(),
          stream: "dashboard",
          message: `Could not stop the permission-paused executor: ${error.message}. Resume remains unavailable until termination is verified.`
        });
      }
    };
    try {
      if (job.mode === "fix-and-validate") {
        job.sharedWorkspace = prepareSharedWorktree({
          repository: resolvedRepository,
          profile: loadRepositoryProfile(resolvedRepository),
          jobId: job.id,
          saved: job.sharedWorkspace,
          reviewedWorkspace: job.reviewedWorkspace,
          onStash(receipt) {
            job.workspaceStash = receipt;
            pushLog(job, {
              index: job.nextLogIndex, timestamp: new Date().toISOString(), stream: "dashboard",
              message: `Automatically preserved ${receipt.files.length} changed file(s) in stash ${receipt.stashRef} before creating this job's fresh branch. Restore the stash separately; it is not applied to the new job.`
            });
            persistDashboardState();
          },
          resume,
          resourcesRunning: Boolean(frontendConnection.handle) ||
            frontendConnection.starting || Boolean(playwrightConnection.handle)
        });
        delete job.reviewedWorkspace;
        job.workspaceReview = null;
        if (job.sharedWorkspace) {
          persistDashboardState();
          const readiness = inspectRepository(resolvedRepository);
          if (!readiness.profileReady &&
              !(readiness.draftOnlyReady && allowsUnverifiedDraft(job))) {
            throw new Error(`Shared checkout configuration is not ready after branch acquisition: ${readiness.error}`);
          }
          pushLog(job, {
            index: job.nextLogIndex,
            timestamp: new Date().toISOString(),
            stream: "dashboard",
            message: `Acquired shared checkout on ${job.sharedWorkspace.branch}; base ${job.sharedWorkspace.remote}/${job.sharedWorkspace.baseBranch} at ${job.sharedWorkspace.baseCommit}.`
          });
        }
      }
      initializeJobValidation(job, resolvedRepository);
      prompt += `\n${componentRetrievalGuidance(loadRepositoryProfile(resolvedRepository), job.request)}`;
      const validation = job.validationSession.summary();
      if (validation.status !== "unconfigured" && validation.gates.length > 0) {
        prompt += `\nDashboard-owned required validation:
- Required gates and code changes must use this job's assigned dashboard checkout. Do not validate a sibling checkout or move gated changes elsewhere.
- For separate isolation, onboard the worktree and start its dashboard before creating a gated job.
- Run each gate using:
  node "${join(packageRoot, "bin", "fixlab.js")}" gate --port ${server.address().port} --job ${job.id} --gate <id> --repository "${resolvedRepository}"
- Required gate IDs: ${validation.gates.filter((gate) => gate.required).map((gate) => gate.id).join(", ") || "none"}.
- Optional gate IDs: ${validation.gates.filter((gate) => !gate.required).map((gate) => gate.id).join(", ") || "none"}. Optional means runnable, not passed.
- These operations return compact structured evidence. Do not run the same required commands separately.
- Validation intent: ${job.validationSession.validationIntent ?? "full"}. ${job.validationSession.advisory ? "Efficient delivery separates applicability from publication requirements. Broad unit tests and optional builds run only by saved preference or explicit selection. Explicit required: true gates still run before publication." : "Full runs every configured gate."} Affected uses explicit profile policies or conservative automatic component mappings; the dashboard, not the agent, determines applicability from the complete Git diff.
- Invoke the configured gates after changes. An excluded gate returns NOT APPLICABLE, never PASS. Do not run its command separately or claim that it passed.
- Report API-scope validation separately from full validation. Recheck scope after edits; frontend, contract, shared or unknown paths require every gate.
- A validation.changeAware component policy combines every gate set matching the changed paths. Frontend paths require their mapped browser/type-check/build gates; unclassified or fullValidationPaths require every gate. Do not guess exclusions or weaken repository-required checks.
- When validation reports automatic affected components, use its applications and browserApplicable metadata to avoid unrelated startup. These are applicability hints, not permission to waive required live gates, profile instructions, authentication, explicit manual localhost or all-UI requests. Recheck after edits and preserve every skipped-stage reason.
- Do not infer that an API path guarantees unchanged public behavior. If requests, responses or frontend consumers may change beyond the policy's declared contract paths, require full validation instead of claiming API-only scope.
- API-only scope does not require frontend startup or browser validation unless the user explicitly requests it or the profile declares applicable browser evidence. Record unnecessary stages skipped with the reason, not passed. Playwright-only mode, manual localhost checks and explicit all-UI requests retain their existing requirements.
- Run required gates before reporting readiness. Stage markers cannot pass these gates.
- Rerun affected gates after source edits. Matching job-local evidence is reused only when the profile opts in for deterministic local validation and inputs are unchanged.
- ${job.validationSession.advisory ? "Missing optional results never establish full validation. Only explicitly required local gates block the reviewed focused checkpoint from publication; keep every optional and CI result honest." : "Unconfigured or stale validation cannot establish pull-request readiness. Never mark a pull request ready outside these checks."}`;
      }
    } catch (error) {
      lease.release();
      throw error;
    }
    const idleCompletion = new Promise((resolveCompletion) => {
      resolveIdleCompletion = resolveCompletion;
    });
    const armIdleWatchdog = () => {
      clearTimeout(idleTimer);
      if (!job.acceptsValidation || job.validationSession.active || job.status !== "running" ||
          job.runtimeRequests?.length) {
        return;
      }
      idleTimer = setTimeout(() => {
        const error = new Error(
          `FixLab agent produced no output for ${Math.round(
            idleTimeoutMs / 60000
          )} minute(s); termination was requested and resume remains blocked until the owned executor exits.`
        );
        pushLog(job, {
          index: job.nextLogIndex,
          timestamp: new Date().toISOString(),
          stream: "dashboard",
          message: error.message
        });
        resolveIdleCompletion({ code: null, error });
        job.executorStopping = true;
        try {
          lease.update("stopping");
        } catch (metadataError) {
          pushLog(job, {
            index: job.nextLogIndex,
            timestamp: new Date().toISOString(),
            stream: "dashboard",
            message: `Could not update the idle executor lease: ${metadataError.message}. Still requesting owned termination.`
          });
        }
        try {
          job.validationSession?.cancel();
          handle?.terminate?.();
        } catch (terminationError) {
          pushLog(job, {
            index: job.nextLogIndex,
            timestamp: new Date().toISOString(),
            stream: "dashboard",
            message: `Could not stop the idle executor: ${terminationError.message}`
          });
        }
      }, idleTimeoutMs);
      idleTimer.unref?.();
    };
    job.refreshIdleWatchdog = armIdleWatchdog;
    const emitHeartbeat = () => {
      if (job.status !== "running" || job.validationSession.active || !job.lastActivityAt ||
          job.runtimeRequests?.length) {
        return;
      }
      const quietMs = Date.now() - Date.parse(job.lastActivityAt);
      if (quietMs < executionHeartbeatMs) {
        return;
      }
      const stage =
        FIXLAB_STAGES.find(
          (candidate) => job.stages[candidate].status === "running"
        ) ?? "intake";
      const quietMinutes = Math.max(1, Math.round(quietMs / 60000));
      const timeoutMinutes = Math.max(1, Math.round(idleTimeoutMs / 60000));
      pushActivity(job, {
        timestamp: new Date().toISOString(),
        stage,
        message:
          `This ${stage.replaceAll("-", " ")} step is still running after ` +
          `${quietMinutes} minute(s) without new output. Long-running builds ` +
          `and tests can remain quiet; FixLab will keep waiting and will stop ` +
          `the executor as resumable after ${timeoutMinutes} idle minute(s).`
      });
    };

    job.lastActivityAt = new Date().toISOString();
    try {
      handle = executor({
        repository: resolvedRepository,
        artifactDirectories: job.artifactDirectory ? [job.artifactDirectory] : [],
        runtimeDirectories,
        prompt: (job.prestartFrontend && job.targetEnvironment.toLowerCase() === "local"
          ? `${prompt}\nReact warm-up is requested in parallel in the dashboard repository. Before live testing, reuse that server only after its profile health check passes and you verify it serves the checkout containing the changes being validated. If using another isolated worktree, start the correct checkout instead; a healthy baseline server does not prove the fix. Never mark local-stack passed merely because warm-up was requested.`
          : prompt) + sharedWorktreeGuidance(job.sharedWorkspace),
        sessionId: job.id,
        resume,
        model: job.model,
        usage: job.usage,
        inputTokenLimit: job.inputTokenLimit ?? 0,
        toolApprovalMode: job.toolApprovalMode ?? "ask",
        fileAccess: validateJobFileAccess(job.fileAccess, resolvedRepository, job.id, job.mode),
        dashboardPort: server.address().port,
        targetEnvironment: job.targetEnvironment,
        testMutationMode: job.testEvidence.mutationMode,
        selectedTestMutationMode: job.testEvidence.selectedMutationMode ?? "",
        allowPostRequests: job.testEvidence.apiOnly || job.testEvidence.unitTestsOnly
          ? undefined : job.testEvidence.allowPostRequests,
        postWriteApproval: job.postWriteApproval ?? undefined,
        protectedPaths,
        mode: job.mode,
        onUsage(usage) {
          job.usage = usage;
          job.lastActivityAt = new Date().toISOString();
          armIdleWatchdog();
        },
        onRuntimeRequests(requests) {
          job.runtimeRequests = requests;
          const review = job.mode === "fix-and-validate"
            ? requests.find((item) => item.sourceEditReview) : null;
          if (review && job.sourceEditReview?.requestId !== review.id) {
            job.sourceEditReview = recordedSourceEditReview({ requestId: review.id, ...review.sourceEditReview });
            recordJobMetric(job);
          }
          job.lastActivityAt = new Date().toISOString();
          armIdleWatchdog();
        },
        onOutput(stream, text) {
          job.lastActivityAt = new Date().toISOString();
          armIdleWatchdog();
          const localStackWasReady =
            job.stages["local-stack"].status === "passed";
          appendOutput(job, stream, text);
          if (job.permissionRequest) {
            queueMicrotask(pauseForPermission);
          }
          if (
            job.manualLocalhostTest &&
            !job.manualLocalhostOpenedAt &&
            !job.manualLocalhostOpening &&
            !localStackWasReady &&
            job.stages["local-stack"].status === "passed"
          ) {
            job.manualLocalhostOpening = true;
            Promise.resolve()
              .then(() => browserOpener(job.manualLocalhostUrl))
              .then(() => {
                job.manualLocalhostOpenedAt = new Date().toISOString();
                pushLog(job, {
                  index: job.nextLogIndex,
                  timestamp: job.manualLocalhostOpenedAt,
                  stream: "dashboard",
                  message: "Opened the React localhost URL for manual validation."
                });
              })
              .catch((error) => {
                pushLog(job, {
                  index: job.nextLogIndex,
                  timestamp: new Date().toISOString(),
                  stream: "dashboard",
                  message: `Could not open React localhost automatically: ${error.message}`
                });
              })
              .finally(() => {
                job.manualLocalhostOpening = false;
              });
          }
        }
      });
    } catch (error) {
      clearTimeout(idleTimer);
      if (error.executorNotStarted === true) {
        lease.release();
      }
      throw error;
    }
    activeHandle = handle;
    job.executorStopping = false;
    if (job.permissionRequest) {
      pauseForPermission();
    }
    if (!handle?.completion || typeof handle.completion.then !== "function") {
      throw new Error("Executor did not provide a termination promise; the repository lease remains reserved.");
    }
    const actualCompletion = Promise.resolve(handle.completion).then(async (result) => {
      job.acceptsValidation = false;
      await job.validationCompletion;
      if (job.validationSession?.terminationUnverified) {
        throw new Error("Validation termination is unverified; the repository lease remains reserved.");
      }
      if (handle.hasStopped && !handle.hasStopped()) {
        throw new Error("Executor exit was observed but owned descendants may still be running; the repository lease remains reserved.");
      }
      let branchError = null;
      try {
        verifySharedWorktreeBranch(resolvedRepository, job.sharedWorkspace);
      } catch (error) {
        branchError = error;
      }
      lease.release();
      return leaseMetadataError || branchError
        ? { code: null, error: leaseMetadataError ?? branchError }
        : result;
    });
    activeTermination = actualCompletion;
    try {
      lease.update(job.executorStopping ? "stopping" : "running", handle.pid);
    } catch (error) {
      leaseMetadataError = error;
      job.executorStopping = true;
      pushLog(job, {
        index: job.nextLogIndex,
        timestamp: new Date().toISOString(),
        stream: "dashboard",
        message: `Executor lease metadata could not be updated: ${error.message}. The reservation is retained while the owned executor stops.`
      });
      resolveIdleCompletion({ code: null, error });
      try {
        handle.terminate?.();
      } catch (terminationError) {
        pushLog(job, {
          index: job.nextLogIndex,
          timestamp: new Date().toISOString(),
          stream: "dashboard",
          message: `Could not stop the executor after its lease metadata failed: ${terminationError.message}. The reservation remains until termination is verified.`
        });
      }
    }
    if (!job.permissionRequest && job.prestartFrontend && job.targetEnvironment.toLowerCase() === "local") {
      void prewarmFrontend(job);
    }
    armIdleWatchdog();
    heartbeatTimer = setInterval(emitHeartbeat, executionHeartbeatMs);
    heartbeatTimer.unref?.();
    Promise.race([actualCompletion, idleCompletion])
      .then(async (result) => {
        await job.validationCompletion;
        if (job.holdRequested) {
          holdJob(job);
        } else if (closing && job.status === "running" && !job.stopRequested) {
          const recovered = recoverInterruptedDashboardJob(dashboardSnapshot(job));
          job.status = recovered.status;
          job.stages = recovered.stages;
          job.error = recovered.error;
          job.finishedAt = recovered.finishedAt;
        } else {
          finishJob(job, result);
        }
        if (job.stopRequested) {
          job.status = "blocked";
          job.error = "Session stopped by the user; resume when ready.";
          delete job.stopRequested;
        }
        recordJobMetric(job);
      })
      .catch((error) => {
        if (job.holdRequested) {
          holdJob(job);
        } else {
          finishJob(job, { code: null, error });
        }
        if (job.stopRequested) {
          job.status = "blocked";
          job.error = "Session stopped by the user; resume when ready.";
          delete job.stopRequested;
        }
        recordJobMetric(job);
      })
      .finally(async () => {
        clearTimeout(idleTimer);
        clearInterval(heartbeatTimer);
        try {
          await actualCompletion;
        } catch (error) {
          job.executorStopping = true;
          pushLog(job, {
            index: job.nextLogIndex,
            timestamp: new Date().toISOString(),
            stream: "dashboard",
            message: `Executor termination or lease release is unverified; retaining the repository lease: ${error.message}`
          });
          recordJobMetric(job);
          return;
        }
        job.executorStopping = false;
        if (activeHandle === handle) {
          activeHandle = null;
          activeTermination = null;
        }
        recordJobMetric(job);
        if (closing) {
          return;
        }
        if (job.status === "held") {
          if (currentJob?.id === job.id) {
            currentJob = null;
          }
          if (!heldJobs.some((candidate) => candidate.id === job.id)) {
            heldJobs.unshift(job);
          }
          persistDashboardState();
          startNextJob();
          return;
        }
        if (job.permissionRequest) {
          return;
        }
        if (job.budgetExceeded) {
          return;
        }
        if (job.pendingInputs.length > 0) {
          const pendingInputs = job.pendingInputs.splice(0);
          const details = pendingInputs
            .map(
              (input, index) =>
                `Comment ${index + 1} (${input.createdAt}):\n${input.details}`
            )
            .join("\n\n");
          const prompt = buildResumePrompt(job, {
            action: "continue",
            details
          });
          resetJobForResume(job);
          recordJobMetric(job);
          try {
            startJob(job, prompt, true);
          } catch (error) {
            finishJob(job, { code: null, error });
            recordJobMetric(job);
            activeHandle = null;
          }
          return;
        }
        return startNextJob();
      });
  }

  async function startNextJob() {
    if (
      closing || workspaceHostState.closing ||
      activeHandle || currentJob?.postValidation ||
      queuedJobs.length === 0 ||
      (currentJob && currentJob.status !== "passed")
    ) {
      return;
    }
    if (currentJob?.artifactDirectory) {
      removeArtifactDirectory(currentJob.artifactDirectory);
      artifactDirectories.delete(currentJob.artifactDirectory);
    }
    archiveJob(currentJob);
    currentJob = queuedJobs.shift();
    currentJob.status = "running";
    currentJob.startedAt ??= new Date().toISOString();
    currentJob.lastActivityAt = new Date().toISOString();
    recordJobMetric(currentJob);
    try {
      const owners = await sessions.list();
      const conflict = owners.find((owner) =>
        owner.id !== sessions.id && owner.available && (
          owner.job?.running ||
          (loadRepositoryProfile(resolvedRepository).worktreeSetup?.mode === "shared" &&
            (owner.frontend?.running || owner.authentication?.running))
        )
      );
      if (conflict) {
        throw new Error(`Queued job cannot start while FixLab dashboard ${conflict.id} owns the repository's agent session. Reconnect or confirm stopping that owner.`);
      }
      startJob(
        currentJob,
        currentJob.pendingPrompt,
        Boolean(currentJob.resumeSession)
      );
      delete currentJob.pendingPrompt;
      delete currentJob.resumeSession;
    } catch (error) {
      finishJob(currentJob, { code: null, error });
      recordJobMetric(currentJob);
      activeHandle = null;
    }
  }

  function conversation() {
    const job = currentJob ? publicJob(currentJob) : null;
    let question = null;
    let workspaceReview = null;
    if (job?.runtimeRequests?.length) {
      question = runtimeConversationQuestion(job.runtimeRequests[0]);
    } else if (job?.permissionRequest) {
      question = { kind: "permission", message: job.permissionRequest.preflight
        ? "Pre-launch folder review is pending. Ask the user for the exact required external folder, then use permission-review and a separate explicit permission-approve bound to this job and request. Review alone grants nothing."
        : PERMISSION_BLOCKED_MESSAGE, actions: [] };
    } else if (job?.budgetExceeded) {
      question = {
        kind: "budget",
        message: "The input-token ceiling was reached. Review and update this stopped job's budget in the dashboard, then explicitly resume. Comments and retries cannot increase the ceiling or reset consumed usage.",
        actions: []
      };
    } else if (job?.manualLocalhostPending) {
      question = { kind: "manual-test", message: "Report the actual manual localhost result.", actions: ["manual-pass", "manual-fail"] };
    } else if (job?.workspaceReview) {
      workspaceReview = reviewSharedWorktree(resolvedRepository, loadRepositoryProfile(resolvedRepository));
      question = {
        kind: "workspace",
        message: "Review the current branch and diff. Explicitly reuse it with its existing PR, or preserve the work and resolve the blocker in the dashboard. No branch switch, reset or stash will be performed.",
        actions: job.canResume && workspaceReview ? ["continue"] : []
      };
    } else if (job?.canResume && ["blocked", "failed"].includes(job.status)) {
      question = {
        kind: "recovery",
        message: safePersistedSummary(job.error || "Choose how to continue this same job."),
        actions: ["continue", "retry"]
      };
    }
    return {
      instanceId: sessions.id,
      repository: resolvedRepository,
      controlProtocol: 1,
      ppeWriteConfigured: runtime === "copilot" && inspectPpeWriteConfiguration(resolvedRepository).configured,
      job: job ? {
        id: job.id, status: job.status, executionState: job.executionState,
        canResume: job.canResume, canComment: job.canComment,
        canReviewPermissions: job.canReviewPermissions,
        runtimeDirectoryGrants: job.runtimeDirectoryGrants,
        permissionRequest: job.permissionRequest ? {
          id: job.permissionRequest.id,
          kind: job.permissionRequest.kind,
          preflight: job.permissionRequest.preflight === true,
          scope: job.permissionRequest.scope ? { directory: job.permissionRequest.scope.directory } : null
        } : null,
        validationIntent: job.validationIntent,
        workflow: job.workflow ?? { mode: "strict" },
        inputTokenLimit: job.inputTokenLimit,
        fileAccess: job.fileAccess ?? null,
        budgetExceeded: job.budgetExceeded,
        inputTokens: job.usage.inputTokens,
        stages: Object.fromEntries(Object.entries(job.stages).map(([stage, value]) => [
          stage, { status: value.status, message: safePersistedSummary(value.message).slice(0, 500) }
        ])),
        validation: job.validation ? {
          status: job.validation.status,
          scope: job.validation.scope,
          reason: job.validation.reason,
          gates: job.validation.gates.map(({ id, status, required, reason }) => ({ id, status, required, reason }))
        } : null,
        pullRequestReadiness: job.pullRequestReadiness
      } : null,
      question, workspaceReview
    };
  }

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(
      request.url,
      `http://${request.headers.host ?? DASHBOARD_HOST}`
    );
    if (request.headers["x-fixlab-operation"] !== undefined) {
      const operation = conversationOperations[request.headers["x-fixlab-operation"]];
      response.fixlabCompact = true;
      request.fixlabControlAction = operation?.action;
      request.verifyConversation = () => {
        if (!operation || operation.path !== requestUrl.pathname ||
            operation.method !== request.method ||
            request.headers.host !== `${DASHBOARD_HOST}:${server.address().port}` ||
            request.headers.origin ||
            request.headers["x-fixlab-instance"] !== sessions.id ||
            request.headers["x-fixlab-job"] !== (currentJob?.id ?? "none") ||
            request.headers["x-fixlab-repository"] !== encodeURIComponent(realpathSync(resolvedRepository)) ||
            (request.method === "POST" && request.headers["x-fixlab-confirmed"] !== "true")) {
          throw new Error("Dashboard control requires an authorized operation matching the current instance, repository and job. Read status again.");
        }
      };
      try {
        request.verifyConversation();
        if (Number(request.headers["content-length"] ?? 0) > 64 * 1024) {
          throw new Error("Dashboard control payload exceeds 64 KiB.");
        }
      } catch (error) {
        sendJson(response, 409, { error: error.message });
        return;
      }
    }

    if (closing && request.method === "POST") {
      sendJson(response, 503, { error: "the dashboard is shutting down" });
      return;
    }
    if (currentJob?.postValidation && request.method === "POST" &&
        !["/api/job/checks", "/api/jobs"].includes(requestUrl.pathname)) {
      sendJson(response, 409, { error: "This job owns optional validation. Complete/cancel those checks and wait for settlement before changing or resuming work." });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/conversation") {
      try {
        sendJson(response, 200, conversation());
      } catch (error) {
        sendJson(response, 409, { error: error.message });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/session") {
      sendJson(response, 200, {
        id: sessions.id,
        scopeId: sessions.scopeId,
        repository: resolvedRepository,
        job: currentJob ? {
          id: currentJob.id,
          status: currentJob.status,
          running: Boolean(activeHandle),
          canResume: publicJob(currentJob).canResume
        } : null,
        frontend: {
          running: Boolean(frontendConnection.handle) || frontendConnection.starting,
          pid: frontendConnection.handle?.pid ?? null
        },
        authentication: { running: Boolean(playwrightConnection.handle) }
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/sessions") {
      try {
        sendJson(response, 200, {
          ownerId: sessions.id,
          sessions: await sessions.list()
        });
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/repositories") {
      try {
        sendJson(response, 200, await sessions.repositories());
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
      return;
    }

    if (
      request.method === "POST" &&
      ["/api/sessions/control", "/api/session/control"].includes(requestUrl.pathname)
    ) {
      try {
        if (!request.headers["content-type"]?.startsWith("application/json")) {
          throw new Error("Content-Type must be application/json");
        }
        const body = await readJsonBody(request);
        if (
          !["stop", "resume", "shutdown"].includes(body.action) ||
          !["job", "frontend", "all"].includes(body.resource) ||
          typeof body.ownerId !== "string"
        ) {
          throw new Error("a session owner, action and resource are required");
        }
        if (body.action !== "resume" && body.confirmed !== true) {
          sendJson(response, 409, { error: "explicit confirmation is required" });
          return;
        }
        if (requestUrl.pathname === "/api/sessions/control") {
          const result = await sessions.control(body.ownerId, body);
          sendJson(response, result.status, result.body);
          return;
        }
        if (body.ownerId !== sessions.id) {
          sendJson(response, 409, { error: "the session owner has changed" });
          return;
        }
        if (
          ["job", "all"].includes(body.resource) &&
          body.jobId !== (currentJob?.id ?? null)
        ) {
          sendJson(response, 409, { error: "the owned job has changed; refresh before continuing" });
          return;
        }
        if (body.action === "resume" && body.resource === "all") {
          throw new Error("resume a job or frontend individually");
        }
        const cleanupFailures = [];
        if (body.action === "shutdown") {
          if (body.resource !== "all") {
            throw new Error("shutdown requires resource all");
          }
          try {
            await stopProcessTree(playwrightConnection.handle);
            playwrightConnection.handle = null;
          } catch (error) {
            cleanupFailures.push(error.message);
          }
        }
        const paths = body.resource === "all"
          ? ["/api/frontend/stop", ...(activeHandle ? ["/api/job/stop"] : [])]
          : body.resource === "frontend"
            ? [body.action === "resume" ? "/api/frontend/start" : "/api/frontend/stop"]
            : body.action === "resume" && activeHandle
              ? []
              : [body.action === "resume" ? "/api/job/input" : "/api/job/stop"];
        for (const path of paths) {
          try {
            const result = await fetch(`${dashboardUrl}${path}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "continue",
                details: "Resume the stopped FixLab session using its saved context and existing evidence."
              }),
              signal: AbortSignal.timeout(10000),
              redirect: "error"
            });
            const resultBody = await result.json();
            if (!result.ok) {
              if (body.resource !== "all") {
                sendJson(response, result.status, resultBody);
                return;
              }
              cleanupFailures.push(resultBody.error ?? `Owned cleanup failed with HTTP ${result.status}`);
            }
          } catch (error) {
            if (body.resource !== "all") {
              throw error;
            }
            cleanupFailures.push(`Owned cleanup ${path} failed: ${error.message}`);
          }
        }
        if (cleanupFailures.length) {
          sendJson(response, 500, { error: cleanupFailures.join("; ") });
          return;
        }
        sendJson(response, 202, { accepted: true, ownerId: sessions.id });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (
      request.method === "POST" &&
      ["/api/jobs", "/api/job/input", "/api/job/permissions", "/api/job/runtime-response", "/api/jobs/resume", "/api/jobs/restart", "/api/frontend/start"].includes(requestUrl.pathname)
    ) {
      try {
        const resource = requestUrl.pathname === "/api/frontend/start" ? "frontend" : "job";
        const owners = await sessions.list();
        const shared = loadRepositoryProfile(resolvedRepository).worktreeSetup?.mode === "shared";
        const conflict = owners.find((owner) =>
          owner.id !== sessions.id && owner.available && (
            owner[resource]?.running ||
            (shared && resource === "job" && (owner.frontend?.running || owner.authentication?.running))
          )
        );
        if (conflict) {
          sendJson(response, 409, {
            error: `Another FixLab dashboard owns the ${resource} session. Reconnect to its dashboard or confirm stopping it in Session controls.`,
            owner: conflict
          });
          return;
        }
      } catch (error) {
        sendJson(response, 503, { error: `Could not verify session ownership: ${error.message}` });
        return;
      }
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/status") {
      persistDashboardState();
      sendJson(response, 200, {
        instanceId: sessions.id,
        readiness: inspectRepository(resolvedRepository),
        runtime: {
          name: runtime,
          defaultModel,
          supportsModelSelection: runtime === "copilot",
          helperDirectory: realpathSync(packageRoot)
        },
        job: publicJob(currentJob),
        queue: publicQueue(queuedJobs),
        held: publicHeld(heldJobs),
        history: dashboardHistory(),
        historyWarning: dashboardHistoryWarning
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/job") {
      persistDashboardState();
      sendJson(response, 200, {
        job: publicJob(currentJob),
        queue: publicQueue(queuedJobs),
        held: publicHeld(heldJobs),
        history: dashboardHistory(),
        historyWarning: dashboardHistoryWarning
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/job/engineering-summary") {
      try {
        const expectedHost = `${DASHBOARD_HOST}:${server.address().port}`;
        if (request.headers.host !== expectedHost || request.headers.origin ||
            !request.headers["content-type"]?.startsWith("application/json")) {
          throw new Error("Engineering notes require a local JSON client without a browser Origin.");
        }
        const body = await readJsonBody(request, 16384);
        if (body.instanceId !== sessions.id || body.repository !== resolvedRepository ||
            body.confirmed !== true || typeof body.jobId !== "string") {
          throw new Error("Engineering notes require the exact instance, repository, job and explicit confirmation.");
        }
        if (!dashboardHistoryPath) {
          throw new Error("Engineering notes require persistable repository history.");
        }
        const job = [currentJob, ...heldJobs, ...completedJobs, ...persistedJobs]
          .find((candidate) => candidate?.id === body.jobId);
        if (closing || !job || job.executorStopping || (job === currentJob && activeHandle) ||
            !["passed", "failed", "blocked", "held", "cancelled"].includes(job.status)) {
          throw new Error("Engineering notes require an existing stopped job with a settled executor.");
        }
        const summary = normalizeEngineeringSummary(body.summary);
        job.engineeringSummary = summary;
        job.engineeringSummaryOrigin = "reviewed-note";
        persistDashboardState();
        if (dashboardHistoryWarning || !persistedJobs.some((snapshot) => snapshot.id === job.id)) {
          sendJson(response, 503, { error: "Engineering notes are retained in memory but could not be persisted." });
          return;
        }
        sendJson(response, 200, { jobId: job.id, engineeringSummary: summary, origin: "reviewed-note" });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/job/publication-context") {
      try {
        if (request.headers.host !== `${DASHBOARD_HOST}:${server.address().port}` ||
            request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          throw new Error("Publication review requires the owning local JSON client.");
        }
        const body = await readJsonBody(request);
        const job = currentJob;
        if (closing || !job || job.executorStopping || job.status !== "running" ||
            !job.acceptsValidation || body.jobId !== job.id || job.mode !== "fix-and-validate" ||
            typeof body.verify !== "boolean" || typeof body.repository !== "string" ||
            realpathSync(body.repository) !== realpathSync(resolvedRepository)) {
          throw new Error("Publication review requires this running editing job and its exact assigned checkout.");
        }
        const profile = loadRepositoryProfile(resolvedRepository);
        if (body.verify) { job.validationSession?.verify(); }
        const branch = spawnSync("git", ["symbolic-ref", "--short", "HEAD"], {
          cwd: resolvedRepository, encoding: "utf8", windowsHide: true, timeout: 2000
        });
        if (branch.error || branch.status !== 0) {
          throw new Error("Publication review could not resolve the source branch.");
        }
        const source = branch.stdout.trim();
        const ready = getPullRequestReadiness({ ...job, status: "completed" }).ready;
        const target = profile.pullRequests?.defaultTargetBranch;
        const prefix = job.branchNaming?.prefix;
        sendJson(response, 200, {
          ready: ready && !job.manualLocalhostPending && job.manualLocalhostResult !== "failed" &&
            !job.testEvidence?.modeViolation && typeof target === "string" && target !== source &&
            typeof prefix === "string" && source.startsWith(`${prefix}/`),
          source, target: target ?? null, publication: job.workflow.publication,
          revision: createHash("sha256").update(JSON.stringify({
            instance: sessions.id, job: job.id, repository: realpathSync(resolvedRepository),
            workflow: job.workflow,
            stages: Object.fromEntries(FIXLAB_STAGES.filter((stage) => stage !== "pr")
              .map((stage) => [stage, job.stages[stage]])),
            validation: job.validationSession?.summary(),
            manual: [job.manualLocalhostPending, job.manualLocalhostResult],
            safety: job.testEvidence?.modeViolation
          })).digest("hex")
        });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/validation/run") {
      try {
        const expectedHost = `${DASHBOARD_HOST}:${server.address().port}`;
        if (
          request.headers.host !== expectedHost ||
          request.headers.origin ||
          !request.headers["content-type"]?.startsWith("application/json")
        ) {
          throw new Error("Validation requires a local JSON client without a browser Origin.");
        }
        const body = await readJsonBody(request);
        const job = currentJob;
        if (closing || !job || job.executorStopping || job.status !== "running" || !job.acceptsValidation || body.jobId !== job.id) {
          throw new Error("Validation requires the current running job ID.");
        }
        if (typeof body.gateId !== "string" || typeof body.repository !== "string") {
          throw new Error("gateId and repository are required.");
        }
        if (realpathSync(body.repository) !== realpathSync(resolvedRepository)) {
          throw new Error("Validation must target the job's assigned checkout.");
        }
        if (job.validationSession.active) {
          throw new Error("A validation gate is already running.");
        }
        const cancel = () => {
          if (!response.writableFinished) {
            job.validationSession.cancel();
          }
        };
        response.once("close", cancel);
        const completion = job.validationSession.run(
          body.gateId,
          body.repository,
          loadRepositoryProfile(resolvedRepository),
          { jobId: job.id }
        );
        job.validationCompletion = completion.catch(() => {});
        job.refreshIdleWatchdog();
        let result;
        try {
          result = await completion;
        } finally {
          response.removeListener("close", cancel);
          job.refreshIdleWatchdog();
        }
        pushLog(job, {
          index: job.nextLogIndex,
          timestamp: new Date().toISOString(),
          stream: "dashboard",
          message: result.summary
        });
        persistDashboardState();
        sendJson(response, 200, result);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/job/checks") {
      try {
        const expectedOrigin = `http://${DASHBOARD_HOST}:${server.address().port}`;
        if (!request.verifyConversation &&
            (request.headers.host !== new URL(expectedOrigin).host || request.headers.origin !== expectedOrigin)) {
          throw new Error("Check controls require this dashboard's exact loopback host and origin.");
        }
        if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
          throw new Error("Content-Type must be application/json.");
        }
        const body = await readJsonBody(request);
        const job = currentJob;
        if (!job || closing || activeHandle || job.executorStopping ||
            !["passed", "failed", "blocked"].includes(job.status) ||
            body.instanceId !== sessions.id || body.jobId !== job.id || body.confirmed !== true ||
            body.repository !== realpathSync.native(resolvedRepository)) {
          throw new Error("Check controls require the exact stopped job, instance and canonical checkout. Stop the executor first.");
        }
        if (body.action === "complete") {
          if (job.postValidation) {
            job.postValidation.cancelled = true;
            job.validationSession.cancel();
            await job.validationCompletion;
          }
          if (job.postValidation || job.executorStopping || activeHandle || currentJob !== job) {
            throw new Error("Owned work has not settled; the job and lease remain reserved.");
          }
          pushLog(job, { index: job.nextLogIndex, timestamp: new Date().toISOString(), stream: "dashboard",
            message: "User completed this scoped job. Failed, deferred and unverified checks retain their actual outcomes; completion is not validation or merge approval." });
          archiveJob(job);
          currentJob = null;
          await startNextJob();
          persistDashboardState();
          sendJson(response, 200, { job: publicJob(currentJob), completed: true });
          return;
        }
        if (body.action !== "run" || job.postValidation || job.validationSession?.active) {
          throw new Error("Select run or complete; overlapping checks are not allowed.");
        }
        initializeJobValidation(job, resolvedRepository);
        const gates = selectedValidationGates(job.validationSession.gates, body.selection, body.value);
        const lease = executorLease.acquire(job.id);
        const operation = { cancelled: false };
        job.postValidation = operation;
        const completion = (async () => {
          try {
            for (const gate of gates) {
              if (operation.cancelled) {break;}
              const result = await job.validationSession.run(gate.id, resolvedRepository,
                loadRepositoryProfile(resolvedRepository), { jobId: job.id });
              pushLog(job, { index: job.nextLogIndex, timestamp: new Date().toISOString(),
                stream: "dashboard", message: result.summary });
              recordJobMetric(job);
            }
          } finally {
            if (job.validationSession.terminationUnverified) {
              job.executorStopping = true;
              throw new Error("Validation termination is unverified; the repository lease remains reserved.");
            }
            lease.release();
            job.postValidation = null;
            recordJobMetric(job);
          }
        })();
        job.validationCompletion = completion;
        await completion;
        sendJson(response, 200, { job: publicJob(currentJob) });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/metrics") {
      const period = requestUrl.searchParams.get("period") ?? "7d";
      if (!["24h", "7d", "30d", "all"].includes(period)) {
        sendJson(response, 400, {
          error: "period must be 24h, 7d, 30d, or all"
        });
        return;
      }
      sendJson(response, 200, {
        metrics: summarizeMetrics(metricsRecords, period),
        warning: metricsWarning
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/linked-applications") {
      try {
        sendJson(response, 200, {
          instanceId: sessions.id,
          repository: realpathSync.native(resolvedRepository),
          applications: resolveLinkedApplications(resolvedRepository, loadRepositoryProfile(resolvedRepository)),
          notice: "Links do not grant repository permissions, start applications or jobs, prove readiness, or change API-only validation. Start and test each application in its owner's workspace."
        });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/repository/configuration") {
      const expectedOrigin = `http://${DASHBOARD_HOST}:${server.address().port}`;
      if (request.headers.host !== new URL(expectedOrigin).host || request.headers.origin !== expectedOrigin) {
        sendJson(response, 403, { error: "Repository setup requires the dashboard's exact loopback host and origin." });
        return;
      }
      try {
        if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
          throw new Error("Content-Type must be application/json.");
        }
        const body = await readJsonBody(request);
        if (closing || workspaceHostState.closing || body.instanceId !== sessions.id) {
          sendJson(response, 409, { error: "The dashboard changed. Reload before configuring a repository." });
          return;
        }
        for (const [id, plan] of setupPlans) {
          if (Date.now() - plan.createdAt > 10 * 60 * 1000) { setupPlans.delete(id); }
        }
        if (body.action === "inspect") {
          sendJson(response, 200, inspectRepositorySettings(body.repository ?? resolvedRepository));
        } else if (body.action === "preview") {
          const plan = planRepositorySettings({
            repository: body.repository, revision: body.revision, values: body.values,
            install: body.install === true, packageRoot, validate: validateLiveTestProfile
          });
          for (const [id, previous] of setupPlans) {
            if (previous.repository === plan.repository) { setupPlans.delete(id); }
          }
          if (setupPlans.size >= 8) { throw new Error("Too many open setup plans. Finish an existing review or wait for it to expire."); }
          setupPlans.set(plan.id, plan);
          sendJson(response, 200, { planId: plan.id, repository: plan.repository, files: plan.files,
            values: plan.values, notice: "Only the listed FixLab configuration files will change. No commands, sign-in, installs or jobs will run. Prerequisites are checked separately." });
        } else if (body.action === "apply") {
          const plan = setupPlans.get(body.planId);
          if (!plan || body.confirmed !== true) {
            throw new Error("An unexpired reviewed plan and explicit confirmation are required.");
          }
          for (const owner of await repositoryWorkspaceOwners(plan.repository)) {
            const checked = await fetch(`${owner.url}/api/session`, { redirect: "error", signal: AbortSignal.timeout(1500) });
            if (!checked.ok) { throw new Error("Cannot verify the repository's resource owner before saving settings."); }
            const state = await checked.json();
            if (state.id !== owner.id || state.repository !== owner.repository) {
              throw new Error("Repository ownership changed. Review its settings again.");
            }
            if (state.job?.running || state.frontend?.running || state.authentication?.running) {
              throw new Error("This repository has an active executor, frontend or sign-in session. Save settings after those resources are idle; nothing was stopped.");
            }
          }
          if (closing || workspaceHostState.closing || setupPlans.get(body.planId) !== plan || Date.now() - plan.createdAt > 10 * 60 * 1000) {
            throw new Error("The setup review changed or expired.");
          }
          if (sameExistingRepository(resolvedRepository, plan.repository) &&
              (activeHandle || activeTermination || frontendConnection.handle ||
               frontendConnection.starting || playwrightConnection.handle)) {
            throw new Error("This repository has an active executor, frontend or sign-in session; nothing was stopped.");
          }
          setupPlans.delete(body.planId);
          sendJson(response, 200, applyRepositorySettings(plan, sessions.id));
        } else if (body.action === "open-linked-application") {
          if (body.confirmed !== true) {
            throw new Error("Confirm opening the linked application's separate repository workspace.");
          }
          const verify = () => {
            if (closing || workspaceHostState.closing || body.instanceId !== sessions.id) {
              throw new Error("The dashboard changed or is shutting down.");
            }
            const link = resolveLinkedApplications(resolvedRepository, loadRepositoryProfile(resolvedRepository))
              .find((entry) => entry.id === body.applicationId);
            if (!link || link.revision !== body.revision) {
              throw new Error("The linked application changed. Reload and review its owner and URL again.");
            }
            return link;
          };
          const link = verify();
          const workspace = await openRepositoryWorkspace(link.repository, verify);
          sendJson(response, 200, { ...workspace, application: link });
        } else if (body.action === "open") {
          if (body.confirmed !== true) { throw new Error("Confirm opening this local repository workspace."); }
          const root = localRepository(body.repository);
          sendJson(response, 200, await openRepositoryWorkspace(root));
        } else {
          throw new Error("Unknown repository configuration action.");
        }
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/onboarding"
    ) {
      try {
        const profile = azureDevOpsProfile(
          resolvedRepository,
          loadRepositoryProfile(resolvedRepository)
        );
        sendJson(response, 200, {
          profileName: profile.name ?? "",
          azureDevOps: {
            organization: profile.azureDevOps?.organization ?? "",
            project: profile.azureDevOps?.project ?? ""
          }
        });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/onboarding/azure-devops"
    ) {
      try {
        if (
          !request.headers["content-type"]
            ?.toLowerCase()
            .startsWith("application/json")
        ) {
          throw new Error("Content-Type must be application/json");
        }
        const body = await readJsonBody(request);
        const organization =
          typeof body.organization === "string"
            ? body.organization.trim()
            : "";
        const project =
          typeof body.project === "string" ? body.project.trim() : "";
        if (
          !organization ||
          !project ||
          organization.length > 100 ||
          project.length > 100
        ) {
          throw new Error(
            "Azure DevOps organization and project are required and must be at most 100 characters"
          );
        }
        const profilePath = join(resolvedRepository, profileRelativePath);
        const profile = loadRepositoryProfile(resolvedRepository);
        profile.azureDevOps = { organization, project };
        const temporaryPath = `${profilePath}.${process.pid}.tmp`;
        writeFileSync(
          temporaryPath,
          `${JSON.stringify(profile, null, 2)}\n`,
          { mode: 0o600 }
        );
        renameSync(temporaryPath, profilePath);
        sendJson(response, 200, {
          saved: true,
          azureDevOps: profile.azureDevOps
        });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/azure-devops/load"
    ) {
      let body;
      try {
        if (
          !request.headers["content-type"]
            ?.toLowerCase()
            .startsWith("application/json")
        ) {
          throw new Error("Content-Type must be application/json");
        }
        body = await readJsonBody(request);
        const readiness = inspectRepository(resolvedRepository);
        if (!readiness.profileReady) {
          throw new Error(readiness.error);
        }
        const profile = azureDevOpsProfile(
          resolvedRepository,
          loadRepositoryProfile(resolvedRepository)
        );
        const inputs = Array.isArray(body.workItems)
          ? body.workItems
          : [body.workItem];
        const uniqueInputs = [
          ...new Set(
            inputs
              .map((value) => String(value ?? "").trim())
              .filter(Boolean)
          )
        ];
        if (uniqueInputs.length < 1 || uniqueInputs.length > 20) {
          throw new Error("provide between 1 and 20 unique work item IDs or URLs");
        }
        const loaded =
          typeof workItemLoader.loadMany === "function"
            ? await workItemLoader.loadMany({
                workItems: uniqueInputs,
                profile
              })
            : await Promise.all(
                uniqueInputs.map((workItem) =>
                  workItemLoader({ workItem, profile })
                )
              );
        const screenshotState = { count: 0, totalBytes: 0 };
        const workItems = loaded.map((item) => {
          const workItem = validateWorkItemSummary(item);
          workItem.screenshots = validateLoadedScreenshots(
            item.screenshots,
            screenshotState
          );
          workItem.imagesWarning =
            typeof item.imagesWarning === "string"
              ? item.imagesWarning.trim().slice(0, 500)
              : "";
          return workItem;
        });
        sendJson(response, 200, {
          workItem: workItems.length === 1 ? workItems[0] : null,
          workItems
        });
      } catch (error) {
        sendJson(response, 400, {
          error: String(error.message).replace(
            /Bearer\s+\S+/gi,
            "Bearer [REDACTED]"
          )
        });
      }
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/job/dismiss"
    ) {
      if (!currentJob) {
        sendJson(response, 404, { error: "no FixLab job is available" });
        return;
      }
      if (activeHandle) {
        sendJson(response, 409, {
          error: "the current FixLab agent is still running or shutting down"
        });
        return;
      }
      if (!["failed", "blocked"].includes(currentJob.status)) {
        sendJson(response, 409, {
          error: "only a failed or blocked FixLab job can be dismissed"
        });
        return;
      }

      const dismissedJob = currentJob;
      pushLog(dismissedJob, {
        index: dismissedJob.nextLogIndex,
        timestamp: new Date().toISOString(),
        stream: "dashboard",
        message: `${dismissedJob.status === "blocked" ? "Blocked" : "Failed"} job dismissed by the user; its ${dismissedJob.status} outcome remains in dashboard history.`
      });
      if (dismissedJob.artifactDirectory) {
        removeArtifactDirectory(dismissedJob.artifactDirectory);
        artifactDirectories.delete(dismissedJob.artifactDirectory);
      }
      archiveJob(dismissedJob);
      currentJob = null;
      await startNextJob();
      persistDashboardState();
      sendJson(response, 202, {
        job: publicJob(currentJob),
        dismissedJob: publicJob(dismissedJob),
        queue: publicQueue(queuedJobs),
        held: publicHeld(heldJobs),
        history: dashboardHistory()
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/job/runtime-response") {
      const expectedOrigin = `http://${DASHBOARD_HOST}:${server.address().port}`;
      if (request.headers.host !== new URL(expectedOrigin).host ||
          request.headers.origin !== expectedOrigin) {
        sendJson(response, 403, { error: "Runtime responses require the dashboard's exact loopback host and origin." });
        return;
      }
      try {
        if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
          sendJson(response, 400, { error: "Content-Type must be application/json." });
          return;
        }
        const body = await readJsonBody(request);
        const pending = currentJob?.runtimeRequests?.find((item) => item.id === body?.requestId);
        if (closing || !currentJob || currentJob.status !== "running" ||
            currentJob.executorStopping || !activeHandle?.respondToRuntimeRequest ||
            body.instanceId !== sessions.id || body.jobId !== currentJob.id || !pending) {
          sendJson(response, 409, { error: "The live runtime request changed. Refresh before responding." });
          return;
        }
        if (body.confirmed !== true) {
          sendJson(response, 400, { error: "Explicit confirmation is required." });
          return;
        }
        if (body.recover !== undefined &&
            (body.recover !== true || body.action !== "deny" || pending.canRecover !== true)) {
          sendJson(response, 400, { error: "Guided recovery is not available for this exact request." });
          return;
        }
        if (body.scope === "all-tools" &&
            (body.action !== "allow" || pending.kind !== "permission" || pending.canAllowAll !== true)) {
          sendJson(response, 400, { error: "Allow all is not available for this runtime request." });
          return;
        }
        activeHandle.respondToRuntimeRequest(body.requestId, body);
        if (body.scope === "all-tools") {
          currentJob.toolApprovalMode = "allow-all";
        }
        pushLog(currentJob, {
          index: currentJob.nextLogIndex,
          timestamp: new Date().toISOString(),
          stream: "dashboard",
          message: body.action === "allow"
            ? body.scope === "all-tools"
              ? "The user explicitly enabled Allow all reviewable tool requests for this executor. Organization policy and required workflow approvals remain in effect; the choice expires when this executor ends."
            : body.scope
              ? "The user explicitly reviewed a job-scoped native permission. It expires when this executor ends; other scopes and managed human approvals remain manual."
              : "The user approved one exact native runtime request. No future or blanket approval was granted."
            : body.action === "deny"
              ? body.recover
                ? "The user denied this exact operation and requested safe recovery of the blocked stage using existing reviewed tests and helpers. No hidden operation or new permission was approved."
                : "The user denied the native runtime permission request. That operation was not authorized."
              : body.action === "cancel"
                ? "The user cancelled the native runtime question. No answer was inferred."
                : "The user answered the live runtime question. The answer is not copied into dashboard logs or history."
        });
        sendJson(response, 200, { job: publicJob(currentJob) });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/job/workflow") {
      const expectedOrigin = `http://${DASHBOARD_HOST}:${server.address().port}`;
      if (request.headers.host !== new URL(expectedOrigin).host || request.headers.origin !== expectedOrigin) {
        sendJson(response, 403, { error: "Workflow review requires the dashboard's exact loopback host and origin." });
        return;
      }
      try {
        if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
          throw new Error("Content-Type must be application/json.");
        }
        const body = await readJsonBody(request);
        if (closing || !currentJob || activeHandle || currentJob.executorStopping ||
            !["blocked", "failed", "passed"].includes(currentJob.status) ||
            body.instanceId !== sessions.id || body.jobId !== currentJob.id) {
          sendJson(response, 409, { error: "Workflow migration requires this exact stopped job." });
          return;
        }
        if (body.confirmed !== true || currentJob.mode !== "fix-and-validate" ||
            typeof body.repository !== "string" || !sameExistingRepository(body.repository, resolvedRepository) ||
            !["efficient", "strict"].includes(body.mode)) {
          sendJson(response, 400, { error: "Explicitly confirm a supported workflow for this exact checkout and editing job." });
          return;
        }
        const profile = loadRepositoryProfile(resolvedRepository);
        const workflow = configuredWorkflow({ workflow: { ...configuredWorkflow(profile), mode: body.mode } });
        if (profile.workflow?.mode === "strict" && workflow.mode !== "strict") {
          throw new Error("The repository explicitly requires strict delivery. Review repository settings before changing that policy.");
        }
        currentJob.workflow = workflow;
        if (currentJob.validationSession) {
          currentJob.validationSession.advisory = workflow.mode === "efficient";
        }
        currentJob.initialPrompt = buildJobPrompt({ ...currentJob,
          screenshotPaths: currentJob.screenshots.map((file) => file.path) });
        pushLog(currentJob, { index: currentJob.nextLogIndex, timestamp: new Date().toISOString(),
          stream: "dashboard", message: `The user reviewed ${workflow.mode} delivery for this existing job. Required repository checks and validation history are preserved. The job has not been resumed.` });
        recordJobMetric(currentJob);
        sendJson(response, 200, { job: publicJob(currentJob) });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/job/file-access") {
      const expectedOrigin = `http://${DASHBOARD_HOST}:${server.address().port}`;
      if (request.headers.host !== new URL(expectedOrigin).host || request.headers.origin !== expectedOrigin) {
        sendJson(response, 403, { error: "File trust requires the dashboard's exact loopback host and origin." });
        return;
      }
      try {
        if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
          throw new Error("Content-Type must be application/json.");
        }
        const body = await readJsonBody(request);
        if (closing || !currentJob || activeHandle || currentJob.executorStopping ||
            !["blocked", "failed", "passed"].includes(currentJob.status) ||
            body.instanceId !== sessions.id || body.jobId !== currentJob.id) {
          sendJson(response, 409, { error: "File trust review requires this exact stopped job. Refresh before changing it." });
          return;
        }
        if (runtime !== "copilot" || body.confirmed !== true ||
            !["manual", "source-read", "source-read-write"].includes(body.mode) ||
            (body.allowValidationGates !== undefined && typeof body.allowValidationGates !== "boolean") ||
            (body.mode === "manual" && body.allowValidationGates === true) ||
            typeof body.repository !== "string" ||
            !sameExistingRepository(body.repository, realpathSync.native(resolvedRepository))) {
          sendJson(response, 400, { error: "Explicitly confirm a supported file mode for this exact canonical checkout." });
          return;
        }
        currentJob.fileAccess = validateJobFileAccess(body.mode === "manual" ? null : {
          mode: body.mode, repository: realpathSync.native(resolvedRepository), jobId: currentJob.id,
          allowValidationGates: body.allowValidationGates === true
        }, resolvedRepository, currentJob.id, currentJob.mode);
        pushLog(currentJob, {
          index: currentJob.nextLogIndex, timestamp: new Date().toISOString(), stream: "dashboard",
          message: `The user reviewed repository file access: ${body.mode}, for this job including resumes only. Sensitive and safety-configuration files, commands and managed human approvals remain separately controlled. The job has not been resumed.`
        });
        recordJobMetric(currentJob);
        sendJson(response, 200, { job: publicJob(currentJob) });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/job/budget") {
      const expectedOrigin = `http://${DASHBOARD_HOST}:${server.address().port}`;
      if (request.headers.host !== new URL(expectedOrigin).host ||
          request.headers.origin !== expectedOrigin) {
        sendJson(response, 403, { error: "Budget changes require the dashboard's exact loopback host and origin." });
        return;
      }
      try {
        if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
          throw new Error("Content-Type must be application/json.");
        }
        const body = await readJsonBody(request);
        if (closing || !currentJob || activeHandle || currentJob.executorStopping ||
            !["blocked", "failed", "passed"].includes(currentJob.status) ||
            body.instanceId !== sessions.id || body.jobId !== currentJob.id) {
          sendJson(response, 409, { error: "Budget review requires this exact stopped job. Refresh before changing it." });
          return;
        }
        if (runtime !== "copilot" || body.confirmed !== true ||
            !Number.isSafeInteger(body.inputTokenLimit) || body.inputTokenLimit < 0 ||
            (body.inputTokenLimit > 0 && body.inputTokenLimit <= currentJob.usage.inputTokens)) {
          sendJson(response, 400, { error: "Explicitly confirm a safe integer ceiling above input already used, or 0 for unlimited." });
          return;
        }
        currentJob.inputTokenLimit = body.inputTokenLimit;
        currentJob.budgetExceeded = false;
        pushLog(currentJob, {
          index: currentJob.nextLogIndex,
          timestamp: new Date().toISOString(),
          stream: "dashboard",
          message: `The user explicitly changed the input-token ceiling to ${body.inputTokenLimit || "unlimited"}. Usage is preserved; the job has not been resumed.`
        });
        recordJobMetric(currentJob);
        sendJson(response, 200, { job: publicJob(currentJob) });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/job/permissions") {
      const expectedOrigin = `http://${DASHBOARD_HOST}:${server.address().port}`;
      if (request.headers.host !== new URL(expectedOrigin).host ||
          (request.headers.origin && request.headers.origin !== expectedOrigin)) {
        sendJson(response, 403, { error: "Permission approval requires the dashboard's exact loopback host and origin." });
        return;
      }
      let body;
      try {
        if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
          throw new Error("Content-Type must be application/json");
        }
        body = await readJsonBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new Error("Permission approval requires a JSON object.");
        }
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      if (closing || activeHandle || currentJob?.executorStopping ||
          !currentJob || currentJob.status !== "blocked" ||
          currentJob.resumeDisabled || body.jobId !== currentJob.id ||
          !currentJob.permissionRequest ||
          body.requestId !== currentJob.permissionRequest.id) {
        sendJson(response, 409, { error: "The permission request changed or its executor is not safely stopped. Refresh before approving." });
        return;
      }
      const job = currentJob;
      const pending = job.permissionRequest;
      try {
        if (body.action === "review-directory") {
          const scope = reviewPermissionDirectory(body.directory, {
            repository: resolvedRepository,
            packageRoot
          });
          if (job.runtimeDirectoryGrants?.some((grant) => grant.directory === scope.directory)) {
            throw new Error("This folder is already granted for this job. Repeating the same grant cannot resolve the remaining runtime denial.");
          }
          job.permissionRequest = {
            ...newPermissionRequest({ preflight: pending.preflight === true }),
            scope
          };
          sendJson(response, 200, { job: publicJob(job) });
          return;
        }
        if (body.action !== "approve-directory" || body.confirmed !== true ||
            !pending.scope || body.directory !== pending.scope.directory) {
          sendJson(response, 400, { error: "Review an exact folder scope and explicitly confirm it before approval." });
          return;
        }
        verifyPermissionDirectory(pending.scope, {
          repository: resolvedRepository,
          packageRoot
        });
        const previousGrants = job.runtimeDirectoryGrants ?? [];
        if (previousGrants.length >= 8) {
          throw new Error("This job already has eight folder grants; review its runtime policy instead of broadening access further.");
        }
        job.runtimeDirectoryGrants = [...previousGrants, pending.scope];
        pushLog(job, {
          index: job.nextLogIndex,
          timestamp: new Date().toISOString(),
          stream: "dashboard",
          message: `The user approved folder access for this job only: ${pending.scope.directory}. The grant is not retained after a dashboard restart and does not approve tools or URLs.`
        });
        job.permissionRequest = null;
        job.permissionStopRequested = false;
        job.permissionPreflightReviewed = true;
        const prompt = pending.preflight ? job.initialPrompt : buildResumePrompt(job, {
          action: "retry",
          details: `The user explicitly approved access to this folder for this job only: ${pending.scope.directory}. The new executor receives that exact --add-dir grant. This does not authorize a denied tool, URL, production data change, or any other folder. Retry only the blocked prerequisite once. If still denied, stop and report the unresolved permission; do not loop or request blanket access.`
        });
        resetJobForResume(job);
        try {
          startJob(job, prompt, !pending.preflight);
        } catch (error) {
          if (pending.preflight && error.workspaceReview) {
            finishJob(job, { code: null, error });
          } else {
            if (!job.permissionRequest) {
              job.runtimeDirectoryGrants = previousGrants;
              job.permissionRequest = pending;
            }
            job.status = "blocked";
            job.error = `Scoped resume could not start: ${error.message}`;
          }
          recordJobMetric(job);
          sendJson(response, 409, { error: job.error, job: publicJob(job) });
          return;
        }
        recordJobMetric(job);
        sendJson(response, 202, { job: publicJob(job) });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (
      request.method === "POST" &&
      ["/api/job/input", "/api/conversation/reply"].includes(requestUrl.pathname)
    ) {
      const connectedReply = requestUrl.pathname === "/api/conversation/reply";
      if (connectedReply && (request.headers.host !== `${DASHBOARD_HOST}:${server.address().port}` || request.headers.origin)) {
        sendJson(response, 403, { error: "Connected replies require the exact loopback host and a non-browser client." });
        return;
      }
      if (!currentJob) {
        sendJson(response, 404, { error: "no FixLab job is available" });
        return;
      }
      if (currentJob.resumeDisabled) {
        sendJson(response, 409, {
          error: currentJob.runtime !== runtime
            ? "Saved job runtime is incompatible or unknown; reconnect using its originating runtime or start a new job."
            : "this FixLab job cannot be resumed safely"
        });
        return;
      }
      if (currentJob.permissionRequest) {
        sendJson(response, 409, {
          error: "Runtime permission is unresolved. Use the scoped permission review; a comment or workflow approval cannot grant runtime access."
        });
        return;
      }
      let running = currentJob.status === "running" && Boolean(activeHandle);
      const inputJobId = currentJob.id;
      if (
        !running &&
        !["blocked", "failed", "passed"].includes(currentJob.status)
      ) {
        sendJson(response, 409, {
          error:
            "user input can be added only to a running, blocked, failed, or completed job"
        });
        return;
      }
      if (!running && activeHandle) {
        sendJson(response, 409, {
          error: "the current FixLab agent is still shutting down"
        });
        return;
      }

      let body;
      try {
        if (
          !request.headers["content-type"]
            ?.toLowerCase()
            .startsWith("application/json")
        ) {
          throw new Error("Content-Type must be application/json");
        }
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      if (!currentJob || currentJob.id !== inputJobId) {
        sendJson(response, 409, { error: "The current job changed while reading the reply. Read status again." });
        return;
      }
      if (connectedReply && (body.confirmed !== true ||
          body.instanceId !== sessions.id || body.jobId !== currentJob.id ||
          typeof body.repository !== "string" ||
          resolve(body.repository) !== resolvedRepository)) {
        sendJson(response, 409, { error: "An explicit answer matching this dashboard instance, repository and job is required. Read status again." });
        return;
      }
      running = currentJob.status === "running" && Boolean(activeHandle);
      if (currentJob.resumeDisabled || currentJob.executorStopping ||
          (!running && (activeHandle || !["blocked", "failed", "passed"].includes(currentJob.status)))) {
        sendJson(response, 409, { error: "This job cannot safely accept a reply while its executor is stopping or incompatible." });
        return;
      }
      const action = body.action ?? "continue";
      if (action === "answer") {
        const pending = currentJob.runtimeRequests?.[0];
        if (!connectedReply || !running || !activeHandle?.respondToRuntimeRequest ||
            !pending || body.requestId !== pending.id ||
            runtimeConversationQuestion(pending).responseChannel !== "conversation") {
          sendJson(response, 409, { error: "Answer only the current live question using its exact request ID. Native permissions and sensitive questions require the dashboard; read status again." });
          return;
        }
        if (typeof body.details !== "string" || body.validationIntent !== undefined ||
            body.reviewedWorkspace !== undefined || body.scope !== undefined || body.recover !== undefined) {
          sendJson(response, 400, { error: "A live question answer cannot change validation, workspace or permission scope." });
          return;
        }
        try {
          const choice = pending.choices.indexOf(body.details);
          activeHandle.respondToRuntimeRequest(pending.id, {
            action: "answer",
            ...(choice >= 0 ? { choice } : { answer: body.details })
          });
          pushLog(currentJob, {
            index: currentJob.nextLogIndex,
            timestamp: new Date().toISOString(),
            stream: "dashboard",
            message: "The user answered the live runtime question. The answer is not copied into dashboard logs or history."
          });
          sendJson(response, 200, conversation());
        } catch (error) {
          sendJson(response, 400, { error: error.message });
        }
        return;
      }
      if (currentJob.runtimeRequests?.length || body.requestId !== undefined) {
        sendJson(response, 409, { error: "A live question or permission decision is pending or changed. Read status; use answer with the exact question request ID, or review native permissions in the dashboard. Comments and retries cannot answer or approve it." });
        return;
      }
      if (currentJob.permissionRequest) {
        sendJson(response, 409, { error: "Runtime permission is unresolved; use the scoped permission review." });
        return;
      }
      if (
        ![
          "comment",
          "continue",
          "retry",
          "skip",
          "manual-pass",
          "manual-fail"
        ].includes(action)
      ) {
        sendJson(response, 400, {
          error:
            "action must be comment, continue, retry, skip, manual-pass, or manual-fail"
        });
        return;
      }
      const manualResult = ["manual-pass", "manual-fail"].includes(action);
      if (
        !running &&
        !manualResult &&
        action !== "skip" &&
        currentJob.stages["live-test"].status === "blocked" &&
        playwrightConnection.handle
      ) {
        sendJson(response, 409, {
          error: "Authentication is still running and owns the repository browser profile. Finish sign-in and close its browser window before resuming the blocked live test."
        });
        return;
      }
      if (manualResult && !currentJob.manualLocalhostPending) {
        sendJson(response, 409, {
          error: "manual localhost confirmation is not pending"
        });
        return;
      }
      if (currentJob.manualLocalhostPending && !manualResult) {
        sendJson(response, 409, {
          error:
            "manual localhost confirmation requires an explicit manual-pass or manual-fail action"
        });
        return;
      }
      if (!running && currentJob.browserPreflightBlocked && !manualResult && action !== "skip") {
        try {
          const blocker = browserOwnership(playwrightAuthenticationConfig(resolvedRepository));
          if (blocker) {
            currentJob.browserBlocker = blocker;
            currentJob.error = blocker.message;
            sendJson(response, 409, { error: blocker.message, job: publicJob(currentJob) });
            return;
          }
        } catch (error) {
          sendJson(response, 409, { error: `Browser preflight remains blocked: ${error.message}` });
          return;
        }
      }
      const submittedDetails =
        typeof body.details === "string" ? body.details.trim() : "";
      const defaultDetails =
        action === "continue"
          ? "Resume the same FixLab session from its retained workflow state and continue the remaining required stages."
          : "";
      const details = manualResult
        ? `The user completed manual React localhost validation and explicitly marked it ${
            action === "manual-pass" ? "passed" : "failed"
          }. Record the live-test stage as ${
            action === "manual-pass" ? "passed" : "failed"
          }, stop only frontend processes owned by the current job (not a dashboard-managed server), preserve this manual result in the job evidence, and continue the remaining gated outcome without rerunning Playwright.`
        : submittedDetails || defaultDetails;
      if (!details || details.length > 10000) {
        sendJson(response, 400, {
          error: "details must be a non-empty string of at most 10000 characters"
        });
        return;
      }
      if (running && action !== "comment") {
        sendJson(response, 400, {
          error: "a running job accepts only comment input"
        });
        return;
      }
      if (body.validationIntent !== undefined && !["scoped", "full", "affected"].includes(body.validationIntent)) {
        sendJson(response, 400, { error: "validationIntent must be scoped, full, or affected." });
        return;
      }
      if (body.sourceEditReviewId !== undefined) {
        const review = currentJob.sourceEditReview;
        const expectedOrigin = `http://${DASHBOARD_HOST}:${server.address().port}`;
        if (request.headers.host !== new URL(expectedOrigin).host || request.headers.origin !== expectedOrigin ||
            body.confirmed !== true || body.instanceId !== sessions.id || body.jobId !== currentJob.id ||
            !review || body.sourceEditReviewId !== review.requestId || currentJob.mode !== "fix-and-validate" ||
            currentJob.fileAccess?.mode !== "source-read-write" ||
            !["continue", "retry", "comment"].includes(action) ||
            details !== sourceEditAuthorization(review)) {
          sendJson(response, 409, { error: "The reviewed source edit or its authorization changed. Refresh and review it again." });
          return;
        }
      }
      if (body.reviewedWorkspace && (running || !currentJob.workspaceReview ||
          !["continue", "retry"].includes(action))) {
        sendJson(response, 409, { error: "Reviewed workspace reuse is available only for a stopped workspace recovery question." });
        return;
      }
      if (body.reviewedWorkspace) {
        let review;
        try {
          review = reviewSharedWorktree(resolvedRepository, loadRepositoryProfile(resolvedRepository));
        } catch (error) {
          sendJson(response, 409, { error: `Workspace review failed: ${error.message}` });
          return;
        }
        if (!review || body.reviewedWorkspace.branch !== review.branch ||
            body.reviewedWorkspace.fingerprint !== review.fingerprint) {
          sendJson(response, 409, { error: "The workspace changed since review. Read status and review the diff again." });
          return;
        }
        currentJob.reviewedWorkspace = review;
      }
      if (body.validationIntent !== undefined) {
        currentJob.validationIntent = body.validationIntent;
      }

      const input = {
        action,
        details,
        createdAt: new Date().toISOString()
      };
      if (body.sourceEditReviewId !== undefined) {
        currentJob.sourceEditReview = null;
      }
      currentJob.inputs.push(input);
      if (manualResult) {
        currentJob.manualLocalhostPending = false;
        currentJob.manualLocalhostResult =
          action === "manual-pass" ? "passed" : "failed";
      }
      if (running) {
        currentJob.pendingInputs.push(input);
        pushLog(currentJob, {
          index: currentJob.nextLogIndex,
          timestamp: new Date().toISOString(),
          stream: "dashboard",
          message: `Comment ${currentJob.inputs.length} queued for the same FixLab session after the current agent turn.`
        });
        sendJson(response, 202, connectedReply ? conversation() : {
          job: publicJob(currentJob),
          queued: true,
          queue: publicQueue(queuedJobs),
          held: publicHeld(heldJobs)
        });
        return;
      }
      pushLog(currentJob, {
        index: currentJob.nextLogIndex,
        timestamp: new Date().toISOString(),
        stream: "dashboard",
        message: `User input ${currentJob.inputs.length} accepted; resuming the same FixLab session.`
      });
      const freshRetry = requiresFreshRetry(currentJob, body.reviewedWorkspace ? "retry" : action);
      const prompt = freshRetry
        ? buildFreshRetryPrompt(currentJob, details)
        : buildResumePrompt(currentJob, { action, details });
      resetJobForResume(currentJob);
      recordJobMetric(currentJob);
      try {
        startJob(currentJob, prompt, !freshRetry);
      } catch (error) {
        finishJob(currentJob, { code: null, error });
        recordJobMetric(currentJob);
        activeHandle = null;
      }
      sendJson(response, 202, connectedReply ? conversation() : {
        job: publicJob(currentJob),
        queue: publicQueue(queuedJobs),
        held: publicHeld(heldJobs)
      });
      return;
    }

    if (
      request.method === "POST" &&
      ["/api/job/stop", "/api/job/source-edit-review"].includes(requestUrl.pathname)
    ) {
      if (
        !currentJob ||
        !activeHandle?.terminate
      ) {
        sendJson(response, 409, {
          error: "no running FixLab-owned executor is available to stop"
        });
        return;
      }
      if (
        !request.headers["content-type"]
          ?.toLowerCase()
          .startsWith("application/json")
      ) {
        sendJson(response, 400, {
          error: "Content-Type must be application/json"
        });
        return;
      }
      if (requestUrl.pathname === "/api/job/source-edit-review") {
        let stopBody;
        try {
          stopBody = await readJsonBody(request);
        } catch (error) {
          sendJson(response, 400, { error: error.message });
          return;
        }
        const expectedOrigin = `http://${DASHBOARD_HOST}:${server.address().port}`;
        if (request.headers.host !== new URL(expectedOrigin).host || request.headers.origin !== expectedOrigin ||
            stopBody.confirmed !== true || stopBody.instanceId !== sessions.id ||
            stopBody.jobId !== currentJob?.id || currentJob?.mode !== "fix-and-validate" ||
            !currentJob.sourceEditReview || stopBody.requestId !== currentJob.sourceEditReview.requestId ||
            !activeHandle?.terminate || currentJob.executorStopping) {
          sendJson(response, 409, { error: "The oversized source-edit review changed. Refresh before stopping its executor." });
          return;
        }
      }
      pushLog(currentJob, {
        index: currentJob.nextLogIndex,
        timestamp: new Date().toISOString(),
        stream: "dashboard",
        message:
          "Stop requested by the user; stopping only the owned executor process tree."
      });
      try {
        currentJob.executorStopping = true;
        currentJob.validationSession?.cancel();
        activeHandle.terminate();
        currentJob.pendingInputs = [];
        currentJob.stopRequested = true;
      } catch (error) {
        sendJson(response, 500, {
          error: `could not stop the FixLab-owned executor: ${error.message}`
        });
        return;
      }
      sendJson(response, 202, {
        job: publicJob(currentJob),
        stopping: true
      });
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/jobs/cancel"
    ) {
      if (
        !request.headers["content-type"]
          ?.toLowerCase()
          .startsWith("application/json")
      ) {
        sendJson(response, 400, {
          error: "Content-Type must be application/json"
        });
        return;
      }
      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      const jobId =
        typeof body.jobId === "string" ? body.jobId.trim() : "";
      const position = Number(body.position);
      if (
        !jobId &&
        (!Number.isInteger(position) ||
          position < 1 ||
          position > queuedJobs.length)
      ) {
        sendJson(response, 400, {
          error: "provide a queued jobId or valid queue position"
        });
        return;
      }
      const queueIndex = jobId
        ? queuedJobs.findIndex((job) => job.id === jobId)
        : position - 1;
      if (queueIndex < 0 || queueIndex >= queuedJobs.length) {
        sendJson(response, 404, {
          error: "queued FixLab job not found"
        });
        return;
      }
      const [cancelledJob] = queuedJobs.splice(queueIndex, 1);
      cancelledJob.status = "cancelled";
      cancelledJob.finishedAt = new Date().toISOString();
      cancelledJob.lastActivityAt = cancelledJob.finishedAt;
      cancelledJob.error = null;
      if (cancelledJob.artifactDirectory) {
        removeArtifactDirectory(cancelledJob.artifactDirectory);
        artifactDirectories.delete(cancelledJob.artifactDirectory);
        cancelledJob.artifactDirectory = null;
        cancelledJob.screenshots = [];
      }
      archiveJob(cancelledJob);
      recordJobMetric(cancelledJob);
      sendJson(response, 202, {
        job: publicJob(currentJob),
        cancelledJob: publicJob(cancelledJob),
        queue: publicQueue(queuedJobs),
        held: publicHeld(heldJobs),
        history: dashboardHistory()
      });
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/jobs/hold"
    ) {
      let body;
      try {
        if (
          !request.headers["content-type"]
            ?.toLowerCase()
            .startsWith("application/json")
        ) {
          throw new Error("Content-Type must be application/json");
        }
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      const jobId =
        typeof body.jobId === "string" ? body.jobId.trim() : "";
      if (!jobId) {
        sendJson(response, 400, { error: "jobId must be a non-empty string" });
        return;
      }
      if (heldJobs.some((job) => job.id === jobId)) {
        sendJson(response, 409, { error: "FixLab job is already held" });
        return;
      }
      if (currentJob?.id === jobId) {
        if (currentJob.status === "running" && activeHandle?.terminate) {
          currentJob.holdRequested = true;
          currentJob.status = "holding";
          pushLog(currentJob, {
            index: currentJob.nextLogIndex,
            timestamp: new Date().toISOString(),
            stream: "dashboard",
            message:
              "Hold requested; stopping only this job's FixLab-owned executor."
          });
          try {
            currentJob.validationSession?.cancel();
            activeHandle.terminate();
          } catch (error) {
            currentJob.holdRequested = false;
            currentJob.status = "running";
            sendJson(response, 500, {
              error: `could not hold the FixLab-owned executor: ${error.message}`
            });
            return;
          }
          persistDashboardState();
          sendJson(response, 202, {
            job: publicJob(currentJob),
            holding: true,
            queue: publicQueue(queuedJobs),
            held: publicHeld(heldJobs)
          });
          return;
        }
        if (!["blocked", "failed"].includes(currentJob.status)) {
          sendJson(response, 409, {
            error: "only running, blocked, failed, or queued jobs can be held"
          });
          return;
        }
        const heldJob = currentJob;
        currentJob = null;
        moveHeldJob(heldJob);
        startNextJob();
        sendJson(response, 202, {
          job: publicJob(currentJob),
          heldJob: publicJob(heldJob),
          queue: publicQueue(queuedJobs),
          held: publicHeld(heldJobs),
          history: dashboardHistory()
        });
        return;
      }
      const queueIndex = queuedJobs.findIndex((job) => job.id === jobId);
      if (queueIndex < 0) {
        sendJson(response, 404, { error: "active or queued FixLab job not found" });
        return;
      }
      const [heldJob] = queuedJobs.splice(queueIndex, 1);
      moveHeldJob(heldJob);
      sendJson(response, 202, {
        job: publicJob(currentJob),
        heldJob: publicJob(heldJob),
        queue: publicQueue(queuedJobs),
        held: publicHeld(heldJobs),
        history: dashboardHistory()
      });
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/jobs/resume"
    ) {
      let body;
      try {
        if (
          !request.headers["content-type"]
            ?.toLowerCase()
            .startsWith("application/json")
        ) {
          throw new Error("Content-Type must be application/json");
        }
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      const jobId =
        typeof body.jobId === "string" ? body.jobId.trim() : "";
      const heldIndex = heldJobs.findIndex((job) => job.id === jobId);
      if (heldIndex < 0) {
        sendJson(response, 404, { error: "held FixLab job not found" });
        return;
      }
      if (queuedJobs.length >= MAX_QUEUED_JOBS) {
        sendJson(response, 409, {
          error: `the FixLab queue already contains ${MAX_QUEUED_JOBS} jobs`
        });
        return;
      }
      const [job] = heldJobs.splice(heldIndex, 1);
      const resumeSession = Boolean(job.startedAt);
      const pendingDetails = job.pendingInputs
        .splice(0)
        .map((input) => input.details)
        .join("\n\n");
      const prompt = resumeSession
        ? buildResumePrompt(job, {
            action: "continue",
            details:
              pendingDetails ||
              "Resume this held job from its retained workflow stage."
          })
        : job.pendingPrompt ?? job.initialPrompt;
      resetJobForResume(job);
      const shouldQueue =
        Boolean(activeHandle) ||
        Boolean(currentJob && currentJob.status !== "passed") ||
        queuedJobs.length > 0;
      if (!shouldQueue) {
        retireCurrentJob();
        currentJob = job;
        currentJob.startedAt ??= new Date().toISOString();
        currentJob.lastActivityAt = new Date().toISOString();
        recordJobMetric(currentJob);
        try {
          startJob(currentJob, prompt, resumeSession);
        } catch (error) {
          finishJob(currentJob, { code: null, error });
          recordJobMetric(currentJob);
          activeHandle = null;
        }
      } else {
        job.status = "queued";
        job.pendingPrompt = prompt;
        job.resumeSession = resumeSession;
        queuedJobs.push(job);
        recordJobMetric(job);
        await startNextJob();
      }
      sendJson(response, 202, {
        job: publicJob(currentJob),
        resumedJob: shouldQueue ? publicQueue([job])[0] : publicJob(job),
        queued: shouldQueue,
        queue: publicQueue(queuedJobs),
        held: publicHeld(heldJobs),
        history: dashboardHistory()
      });
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/jobs/restart"
    ) {
      let body;
      try {
        if (
          !request.headers["content-type"]
            ?.toLowerCase()
            .startsWith("application/json")
        ) {
          throw new Error("Content-Type must be application/json");
        }
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      const jobId =
        typeof body.jobId === "string" ? body.jobId.trim() : "";
      const source = retainedJob(jobId);
      if (!source) {
        sendJson(response, 404, { error: "retained FixLab job not found" });
        return;
      }
      if (!["passed", "failed", "blocked", "cancelled"].includes(source.status)) {
        sendJson(response, 409, {
          error: "only terminal FixLab jobs can be restarted"
        });
        return;
      }
      if (queuedJobs.length >= MAX_QUEUED_JOBS) {
        sendJson(response, 409, {
          error: `the FixLab queue already contains ${MAX_QUEUED_JOBS} jobs`
        });
        return;
      }
      let workspaceStash = null;
      let restartedJob = null;
      if (body.workspaceRecovery) {
        if (body.confirmed !== true || body.instanceId !== sessions.id ||
            typeof body.repository !== "string" || resolve(body.repository) !== resolvedRepository ||
            currentJob?.id !== source.id || !source.workspaceReview ||
            source.mode !== "fix-and-validate" || activeHandle || source.executorStopping ||
            source.postValidation || source.permissionRequest || source.runtimeRequests?.length ||
            queuedJobs.length || frontendConnection.handle || frontendConnection.starting ||
            playwrightConnection.handle) {
          sendJson(response, 409, { error: "Fresh workspace recovery requires this exact stopped job, no pending permissions or queued work, and stopped React/authentication sessions. Nothing was stashed." });
          return;
        }
        let recoveryLease;
        try {
          recoveryLease = executorLease.acquire(`workspace-recovery-${source.id}`);
          workspaceStash = stashReviewedSharedWorktree({
            repository: resolvedRepository, profile: loadRepositoryProfile(resolvedRepository),
            reviewedWorkspace: body.workspaceRecovery
          });
          source.workspaceStash = workspaceStash;
          pushLog(source, {
            index: source.nextLogIndex, timestamp: new Date().toISOString(), stream: "dashboard",
            message: `Fresh workspace recovery preserved ${workspaceStash.files.length} file(s) in stash ${workspaceStash.stashRef ?? "none"}; the old branch remains ${workspaceStash.previousBranch}.`
          });
          persistDashboardState();
          restartedJob = createRestartedJob(source, "running");
          restartedJob.workspaceStash = workspaceStash;
          restartedJob.sharedWorkspace = prepareSharedWorktree({
            repository: resolvedRepository, profile: loadRepositoryProfile(resolvedRepository),
            jobId: restartedJob.id
          });
        } catch (error) {
          sendJson(response, 409, { error: error.message });
          return;
        } finally {
          recoveryLease?.release();
        }
      }
      if (currentJob?.id === source.id) {
        retireCurrentJob();
      }
      const shouldQueue =
        Boolean(activeHandle) ||
        Boolean(currentJob && currentJob.status !== "passed") ||
        queuedJobs.length > 0;
      if (!shouldQueue) {
        retireCurrentJob();
      }
      restartedJob ??= createRestartedJob(
        source,
        shouldQueue ? "queued" : "running"
      );
      recordJobMetric(restartedJob);
      if (shouldQueue) {
        queuedJobs.push(restartedJob);
        await startNextJob();
      } else {
        currentJob = restartedJob;
        try {
          startJob(currentJob, currentJob.pendingPrompt);
          delete currentJob.pendingPrompt;
        } catch (error) {
          finishJob(currentJob, { code: null, error });
          recordJobMetric(currentJob);
          activeHandle = null;
        }
      }
      sendJson(response, 202, {
        job: publicJob(currentJob),
        restartedJob: shouldQueue
          ? publicQueue([restartedJob])[0]
          : publicJob(restartedJob),
        queued: shouldQueue,
        queue: publicQueue(queuedJobs),
        held: publicHeld(heldJobs),
        history: dashboardHistory(),
        workspaceStash
      });
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/history/purge"
    ) {
      let body;
      try {
        if (
          !request.headers["content-type"]
            ?.toLowerCase()
            .startsWith("application/json")
        ) {
          throw new Error("Content-Type must be application/json");
        }
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      const olderThanDays = Number(body.olderThanDays);
      if (
        !Number.isInteger(olderThanDays) ||
        olderThanDays < 1 ||
        olderThanDays > 3650
      ) {
        sendJson(response, 400, {
          error: "olderThanDays must be an integer between 1 and 3650"
        });
        return;
      }
      const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
      let deleted = 0;
      const deletedIds = new Set();
      if (!activeHandle && currentJob && purgeableJob(currentJob, cutoff)) {
        if (currentJob.artifactDirectory) {
          removeArtifactDirectory(currentJob.artifactDirectory);
          artifactDirectories.delete(currentJob.artifactDirectory);
        }
        deletedIds.add(currentJob.id);
        deleted += 1;
        currentJob = null;
        startNextJob();
      }
      for (let index = completedJobs.length - 1; index >= 0; index -= 1) {
        const job = completedJobs[index];
        if (!purgeableJob(job, cutoff)) {
          continue;
        }
        completedJobs.splice(index, 1);
        if (job.artifactDirectory) {
          removeArtifactDirectory(job.artifactDirectory);
          artifactDirectories.delete(job.artifactDirectory);
        }
        deletedIds.add(job.id);
        deleted += 1;
      }
      persistedJobs = persistedJobs.filter((job) => {
        if (deletedIds.has(job.id)) {
          return false;
        }
        if (!purgeableJob(job, cutoff)) {
          return true;
        }
        deletedIds.add(job.id);
        deleted += 1;
        return false;
      });
      persistDashboardState();
      sendJson(response, 200, {
        deleted,
        olderThanDays,
        job: publicJob(currentJob),
        queue: publicQueue(queuedJobs),
        held: publicHeld(heldJobs),
        history: dashboardHistory()
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/jobs") {
      let shouldQueue =
        Boolean(activeHandle || currentJob?.postValidation) ||
        ["running", "blocked", "failed"].includes(currentJob?.status) ||
        queuedJobs.length > 0;
      if (shouldQueue && queuedJobs.length >= MAX_QUEUED_JOBS) {
        sendJson(response, 409, {
          error: `the FixLab queue already contains ${MAX_QUEUED_JOBS} jobs`
        });
        return;
      }

      let body;
      try {
        if (
          !request.headers["content-type"]
            ?.toLowerCase()
            .startsWith("application/json")
        ) {
          throw new Error("Content-Type must be application/json");
        }
        body = await readJsonBody(request, 12 * 1024 * 1024);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }

      const requestText =
        typeof body.request === "string" ? body.request.trim() : "";
      if (!requestText || requestText.length > 10000) {
        sendJson(response, 400, {
          error: "request must be a non-empty string of at most 10000 characters"
        });
        return;
      }
      if (
        !["fix-and-validate", "validate-only", "playwright-only"].includes(
          body.mode
        )
      ) {
        sendJson(response, 400, {
          error:
            "mode must be fix-and-validate, validate-only, or playwright-only"
        });
        return;
      }
      let validationIntent;
      try {
        validationIntent = body.validationIntent ??
          defaultValidationIntent(loadRepositoryProfile(resolvedRepository), body.mode);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      if (!["scoped", "full", "affected"].includes(validationIntent)) {
        sendJson(response, 400, { error: "validationIntent must be scoped, full, or affected." });
        return;
      }
      if (body.permissionPreflight !== undefined && typeof body.permissionPreflight !== "boolean") {
        sendJson(response, 400, { error: "permissionPreflight must be a boolean." });
        return;
      }
      let toolApprovalMode;
      try {
        toolApprovalMode = validateToolApprovalMode(body.toolApprovalMode);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      if (toolApprovalMode === "allow-all") {
        const expectedOrigin = `http://${DASHBOARD_HOST}:${server.address().port}`;
        if (request.headers.host !== new URL(expectedOrigin).host ||
            request.headers.origin !== expectedOrigin) {
          sendJson(response, 403, { error: "Allow all requires the dashboard's exact loopback host and origin." });
          return;
        }
        if (body.allowAllConfirmed !== true) {
          sendJson(response, 400, { error: "Allow all requires explicit confirmation." });
          return;
        }
      }
      for (const [field, confirmation, label, other] of [
        ["allowDevWrites", "devWriteApprovalConfirmed", "DEV", "allowPpeWrites"],
        ["allowPpeWrites", "ppeWriteApprovalConfirmed", "PPE", "allowDevWrites"]
      ]) {
        if ((body[field] !== undefined && typeof body[field] !== "boolean") ||
            (body[confirmation] !== undefined && typeof body[confirmation] !== "boolean")) {
          sendJson(response, 400, { error: `${field} and ${confirmation} must be booleans.` });
          return;
        }
        if (body[field] === true || body[confirmation] === true) {
          if (body[field] !== true || body[confirmation] !== true || body[other] === true ||
              body.allowPostRequests === true || runtime !== "copilot") {
            sendJson(response, 400, { error: `Broad ${label} writes require explicit ${label} write confirmation, native Copilot and no other write checkbox.` });
            return;
          }
          const expectedOrigin = `http://${DASHBOARD_HOST}:${server.address().port}`;
          if (request.headers.host !== new URL(expectedOrigin).host ||
              (request.headers.origin !== expectedOrigin &&
                !(field === "allowPpeWrites" && request.verifyConversation))) {
            sendJson(response, 403, { error: `${label} write approval requires the dashboard's exact loopback host and origin.` });
            return;
          }
        }
      }
      if (body.postWriteApprovalConfirmed !== undefined &&
          typeof body.postWriteApprovalConfirmed !== "boolean") {
        sendJson(response, 400, { error: "postWriteApprovalConfirmed must be a boolean." });
        return;
      }
      if (body.postBaseApprovalConfirmed !== undefined && typeof body.postBaseApprovalConfirmed !== "boolean") {
        sendJson(response, 400, { error: "postBaseApprovalConfirmed must be a boolean." });
        return;
      }
      if (body.postBaseApprovalConfirmed === true &&
          (body.allowPostRequests !== true || body.postWriteApprovalConfirmed !== true ||
            body.allowPpeWrites === true || body.allowDevWrites === true)) {
        sendJson(response, 400, { error: "All-POST requests require explicit POST-only job confirmation and no other write checkbox." });
        return;
      }
      if (body.postWriteApprovalConfirmed === true) {
        if (body.allowPostRequests !== true || runtime !== "copilot") {
          sendJson(response, 400, { error: "Job-scoped POST approval requires the selected POST checkbox and native Copilot runtime." });
          return;
        }
        const expectedOrigin = `http://${DASHBOARD_HOST}:${server.address().port}`;
        if (request.headers.host !== new URL(expectedOrigin).host ||
            request.headers.origin !== expectedOrigin) {
          sendJson(response, 403, { error: "POST write approval requires the dashboard's exact loopback host and origin." });
          return;
        }
      }
      const inputTokenLimit = body.inputTokenLimit ?? 0;
      if (!Number.isSafeInteger(inputTokenLimit) || inputTokenLimit < 0 ||
          (inputTokenLimit > 0 && runtime !== "copilot")) {
        sendJson(response, 400, { error: "inputTokenLimit must be a non-negative safe integer; positive ceilings require the Copilot runtime." });
        return;
      }
      const requestType = body.requestType ?? "bug-fix";
      if (!["bug-fix", "small-enhancement"].includes(requestType)) {
        sendJson(response, 400, {
          error: "requestType must be bug-fix or small-enhancement"
        });
        return;
      }
      const pullRequestStrategy = body.pullRequestStrategy ?? "common";
      let selectedModel;
      try {
        selectedModel = validateCopilotModel(body.model ?? defaultModel, runtime);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      if (!["common", "per-bug"].includes(pullRequestStrategy)) {
        sendJson(response, 400, {
          error: "pullRequestStrategy must be common or per-bug"
        });
        return;
      }
      const runAllUiScenarios = body.runAllUiScenarios ?? false;
      if (typeof runAllUiScenarios !== "boolean") {
        sendJson(response, 400, {
          error: "runAllUiScenarios must be a boolean"
        });
        return;
      }
      const recordPlaywrightVideo = body.recordPlaywrightVideo ?? false;
      if (typeof recordPlaywrightVideo !== "boolean") {
        sendJson(response, 400, {
          error: "recordPlaywrightVideo must be a boolean"
        });
        return;
      }
      const prestartFrontend = body.prestartFrontend ?? false;
      if (typeof prestartFrontend !== "boolean") {
        sendJson(response, 400, { error: "prestartFrontend must be a boolean" });
        return;
      }
      const repositoryProfile = loadRepositoryProfile(resolvedRepository);
      for (const key of ["deferValidation", "skipLiveTests", "useDeployedBackend"]) {
        if (body[key] !== undefined && typeof body[key] !== "boolean") {
          sendJson(response, 400, { error: `${key} must be a boolean` });
          return;
        }
      }
      const deferValidation = body.deferValidation === true;
      const skipLiveTests = deferValidation || body.skipLiveTests === true;
      const useDeployedBackend = body.useDeployedBackend === true;
      if (skipLiveTests && (body.mode !== "fix-and-validate" ||
          body.manualLocalhostTest === true || runAllUiScenarios ||
          repositoryProfile.browserAutomation?.apiAuthentication?.productionDatabaseReadOnly ||
          repositoryProfile.browserAutomation?.testSynthesis?.defaultDataSource === "production-read-only")) {
        sendJson(response, 400, { error: "Deferred checks require a draft code-work job without explicit manual/all-UI or production validation." });
        return;
      }
      let workflow;
      try {
        workflow = configuredWorkflow(repositoryProfile);
        if (skipLiveTests) {
          workflow = { ...workflow, publication: "draft" };
        }
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      const preflightIssues = preflight
        ? preflight({ repository: resolvedRepository, profile: repositoryProfile, mode: body.mode,
          deferValidation, skipLiveTests, useDeployedBackend })
        : [];
      if (preflightIssues.length > 0 && body.mode !== "fix-and-validate") {
        sendJson(response, 400, {
          error: formatPreflightFailure(preflightIssues),
          preflight: preflightIssues
        });
        return;
      }
      const allowedEnvironments =
        configuredValidationEnvironments(repositoryProfile);
      let targetEnvironment;
      try {
        targetEnvironment = validateTargetEnvironment(
          body.targetEnvironment,
          allowedEnvironments
        );
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      const manualLocalhostTest =
        body.manualLocalhostTest ??
        body.holdForManualLiveTest ??
        false;
      if (typeof manualLocalhostTest !== "boolean") {
        sendJson(response, 400, {
          error: "manualLocalhostTest must be a boolean"
        });
        return;
      }
      if (skipLiveTests && manualLocalhostTest) {
        sendJson(response, 400, { error: "Deferred checks cannot be combined with manual localhost validation." });
        return;
      }
      if (useDeployedBackend && (!/^(dev|development|ppe|sit|uat)$/iu.test(targetEnvironment) ||
          repositoryProfile.validation?.liveTestsRequired === false ||
          repositoryProfile.browserAutomation?.apiAuthentication?.productionDatabaseReadOnly ||
          repositoryProfile.browserAutomation?.testSynthesis?.defaultDataSource === "production-read-only")) {
        sendJson(response, 400, { error: "A deployed backend requires an explicitly selected, profile-approved DEV/SIT/UAT/PPE environment and a contract permitting non-production live access." });
        return;
      }
      if (repositoryProfile.validation?.liveTestsRequired === false &&
          (body.mode === "playwright-only" || manualLocalhostTest ||
           prestartFrontend || recordPlaywrightVideo || runAllUiScenarios)) {
        sendJson(response, 400, {
          error: "This repository explicitly defers live tests; browser-only, manual localhost, application warm-up, video and UI-scenario requests are unavailable."
        });
        return;
      }
      if (repositoryProfile.browserAutomation?.mode === "api" &&
          (manualLocalhostTest || prestartFrontend || recordPlaywrightVideo || runAllUiScenarios)) {
        sendJson(response, 400, {
          error: "API-only Playwright validation does not support React startup, manual UI validation, video, or UI scenarios."
        });
        return;
      }
      const manualLocalhostUrl =
        repositoryProfile.applications?.frontend?.healthUrl ?? "";
      let testEvidence;
      try {
        const allowPostRequests = body.allowDevWrites === true || body.allowPpeWrites === true ? true : body.allowPostRequests;
        if (body.allowPostRequests !== undefined && typeof body.allowPostRequests !== "boolean") {
          throw new Error("allowPostRequests must be a boolean.");
        }
        if (allowPostRequests !== undefined && !targetEnvironment &&
            allowedEnvironments.length === 1 &&
            ["dev", "sit", "uat", "ppe"].includes(allowedEnvironments[0].toLowerCase()) &&
            repositoryProfile.browserAutomation?.mode !== "api" &&
            repositoryProfile.validation?.liveTestsRequired !== false) {
          targetEnvironment = allowedEnvironments[0];
        }
        if (body.allowDevWrites === true && targetEnvironment.toLowerCase() !== "dev") {
          throw new Error("Broad DEV writes are available only for an explicitly selected DEV environment.");
        }
        if (body.allowPpeWrites === true && targetEnvironment.toLowerCase() !== "ppe") {
          throw new Error("Broad PPE writes are available only for an explicitly selected PPE environment.");
        }
        if (allowPostRequests === true &&
            !["dev", "sit", "uat", "ppe"].includes(targetEnvironment.toLowerCase())) {
          throw new Error("POST support is available only for an explicitly selected DEV, SIT, UAT or PPE environment.");
        }
        if (repositoryProfile.browserAutomation?.apiAuthentication?.productionDatabaseReadOnly &&
            repositoryProfile.browserAutomation.mode !== "api") {
          throw new Error("Production database approval does not authorize portal UI jobs; use an API-only profile.");
        }
        testEvidence = configuredTestSynthesis(repositoryProfile,
          body.testMutationMode === undefined ? "" : body.testMutationMode,
          allowPostRequests, targetEnvironment);
        if (testEvidence.productionDatabaseReadOnly && targetEnvironment && targetEnvironment !== "local") {
          throw new Error("The production database read-only exception permits only the local API environment.");
        }
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      const configuredBranchNaming =
        repositoryProfile.pullRequests?.branchNaming ??
        repositoryProfile.pullRequest?.branchNaming;
      let branchNaming = null;
      if (configuredBranchNaming) {
        const userId =
          typeof configuredBranchNaming.userId === "string"
            ? configuredBranchNaming.userId.trim()
            : "";
        const prefixTemplate =
          typeof configuredBranchNaming.prefixTemplate === "string"
            ? configuredBranchNaming.prefixTemplate.trim()
            : "";
        if (!/^[A-Za-z0-9._-]+$/.test(userId)) {
          sendJson(response, 400, {
            error:
              "pullRequests.branchNaming.userId must contain only letters, numbers, dot, underscore, or hyphen"
          });
          return;
        }
        if (!prefixTemplate.includes("{userId}")) {
          sendJson(response, 400, {
            error:
              "pullRequests.branchNaming.prefixTemplate must contain {userId}"
          });
          return;
        }
        const prefix = prefixTemplate.replaceAll("{userId}", userId);
        if (
          prefix.startsWith("/") ||
          prefix.endsWith("/") ||
          prefix.includes("..") ||
          prefix.includes("\\") ||
          !/^[A-Za-z0-9._/-]+$/.test(prefix)
        ) {
          sendJson(response, 400, {
            error: "pullRequests.branchNaming resolves to an invalid Git prefix"
          });
          return;
        }
        branchNaming = { userId, prefixTemplate, prefix };
      }
      const intakeSource = body.intakeSource ?? "manual";
      if (!["manual", "azure-devops"].includes(intakeSource)) {
        sendJson(response, 400, {
          error: "intakeSource must be manual or azure-devops"
        });
        return;
      }
      let workItem = null;
      let workItems = [];
      try {
        if (intakeSource === "azure-devops") {
          const values = Array.isArray(body.workItems)
            ? body.workItems
            : body.workItem
              ? [body.workItem]
              : [];
          workItems = values.map(validateWorkItemSummary);
          if (workItems.length < 1 || workItems.length > 20) {
            throw new Error(
              "Azure DevOps intake requires between 1 and 20 loaded work items"
            );
          }
          const ids = workItems.map((item) => item.id);
          if (new Set(ids).size !== ids.length) {
            throw new Error("loaded Azure DevOps work items must be unique");
          }
          workItem = workItems.length === 1 ? workItems[0] : null;
        }
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }

      const readiness = inspectRepository(resolvedRepository);
      if (!readiness.repositoryReady || (!readiness.profileReady &&
          !(readiness.draftOnlyReady && allowsUnverifiedDraft({
            mode: body.mode, workflow, deferValidation, manualLocalhostTest,
            runAllUiScenarios, testEvidence
          })))) {
        sendJson(response, 400, { error: readiness.error, readiness });
        return;
      }

      const jobId = randomUUID();
      let postWriteApproval = null;
      try {
        if (body.allowDevWrites === true) {
          postWriteApproval = createDevWriteApproval(resolvedRepository, targetEnvironment, jobId);
        } else if (body.allowPpeWrites === true) {
          postWriteApproval = createPpeWriteApproval(resolvedRepository, targetEnvironment, jobId);
        } else if (body.postBaseApprovalConfirmed === true) {
          postWriteApproval = createPostBaseApproval(resolvedRepository, targetEnvironment, jobId);
        } else if (body.postWriteApprovalConfirmed === true) {
          postWriteApproval = createPostWriteApproval(resolvedRepository, targetEnvironment, jobId);
        }
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      shouldQueue =
        Boolean(activeHandle || currentJob?.postValidation) ||
        ["running", "blocked", "failed"].includes(currentJob?.status) ||
        queuedJobs.length > 0;
      if (shouldQueue && queuedJobs.length >= MAX_QUEUED_JOBS) {
        sendJson(response, 409, {
          error: `the FixLab queue already contains ${MAX_QUEUED_JOBS} jobs`
        });
        return;
      }
      if (!shouldQueue && currentJob?.artifactDirectory) {
        removeArtifactDirectory(currentJob.artifactDirectory);
        artifactDirectories.delete(currentJob.artifactDirectory);
      }
      if (!shouldQueue) {
        archiveJob(currentJob);
      }
      if (body.routineFileAccess !== undefined && typeof body.routineFileAccess !== "boolean") {
        sendJson(response, 400, { error: "routineFileAccess must be an explicit boolean consent." });
        return;
      }
      const fileAccess = body.routineFileAccess === true ? validateJobFileAccess({
        mode: body.mode === "fix-and-validate" ? "source-read-write" : "source-read",
        jobId, repository: realpathSync.native(resolvedRepository), allowValidationGates: true
      }, resolvedRepository, jobId, body.mode) : null;
      let storedScreenshots;
      try {
        storedScreenshots = storeScreenshots({
          repository: resolvedRepository,
          jobId,
          screenshots: body.screenshots ?? []
        });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      if (storedScreenshots.directory) {
        artifactDirectories.add(storedScreenshots.directory);
      }

      const job = {
        id: jobId,
        createdAt: new Date().toISOString(),
        request: requestText,
        requestType,
        validationIntent,
        workflow,
        deferValidation,
        skipLiveTests,
        useDeployedBackend,
        setupRecovery: preflightIssues.map((issue) =>
          safePersistedSummary(`${issue.check}: ${issue.detail}`)),
        permissionPreflight: body.permissionPreflight === true,
        toolApprovalMode,
        postWriteApproval,
        fileAccess,
        inputTokenLimit,
        budgetExceeded: false,
        model: selectedModel,
        runtime,
        pullRequestStrategy,
        runAllUiScenarios,
        targetEnvironment,
        prestartFrontend: prestartFrontend && !skipLiveTests,
        recordPlaywrightVideo,
        manualLocalhostTest,
        manualLocalhostUrl,
        manualLocalhostOpenedAt: null,
        manualLocalhostOpening: false,
        manualLocalhostPending: false,
        manualLocalhostResult: null,
        testEvidence,
        branchNaming,
        intakeSource,
        workItem,
        workItems,
        screenshots: storedScreenshots.files,
        artifactDirectory: storedScreenshots.directory,
        mode: body.mode,
        status: shouldQueue ? "queued" : "running",
        startedAt: shouldQueue ? null : new Date().toISOString(),
        heldAt: null,
        finishedAt: null,
        lastActivityAt: shouldQueue ? null : new Date().toISOString(),
        error: null,
        inputs: [],
        pendingInputs: [],
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          cacheReusePercent: 0
        },
        stages: Object.fromEntries(
          FIXLAB_STAGES.map((stage) => [
            stage,
            { status: "pending", message: "" }
          ])
        ),
        bugs: extractBugResults(requestText, workItems),
        activity: [],
        logs: [],
        droppedLogs: 0,
        nextLogIndex: 0,
        cacheContext: createCacheContext(resolvedRepository),
        partial: { stdout: "", stderr: "" }
      };
      job.holdRequested = false;
      if (postWriteApproval) {
        pushLog(job, {
          index: job.nextLogIndex, timestamp: new Date().toISOString(), stream: "dashboard",
          message: isOriginWriteApproval(postWriteApproval)
            ? `The user explicitly authorized ${postWriteApproval.mode === "post-base" ? "POST only within reviewed API bases" : "POST/PUT/PATCH/DELETE on reviewed origins"} in ${postWriteApproval.environment.toUpperCase()} for this job, including any record accessible to their account. Approval is revision-bound, memory-only and expires with this executor; other methods/environments and explicit read-only restrictions remain blocked.`
            : "The user explicitly authorized configured POST writes for this job and selected environment without repeat confirmation. Approval is revision-bound, memory-only and expires with this executor; production and read-only restrictions remain in effect."
        });
      }
      if (toolApprovalMode === "allow-all") {
        pushLog(job, {
          index: job.nextLogIndex, timestamp: new Date().toISOString(), stream: "dashboard",
          message: "The user explicitly selected Allow all tool commands for this executor. This choice expires when the executor ends; organization policy and required workflow approvals remain in effect."
        });
      }
      job.resumeSession = false;
      job.initialPrompt = buildJobPrompt({
        request: requestText,
        workflow,
        mode: body.mode,
        deferValidation,
        skipLiveTests,
        useDeployedBackend,
        setupRecovery: job.setupRecovery,
        requestType,
        pullRequestStrategy,
        runAllUiScenarios,
        targetEnvironment,
        recordPlaywrightVideo,
        manualLocalhostTest,
        manualLocalhostUrl,
        testEvidence,
        branchNaming,
        intakeSource,
        workItem,
        workItems,
        screenshotPaths: storedScreenshots.files.map((file) => file.path),
        cacheSummary: loadCacheSummary(job.cacheContext)
      });
      job.pendingPrompt = job.initialPrompt;
      recordJobMetric(job);

      if (shouldQueue) {
        queuedJobs.push(job);
        await startNextJob();
      } else {
        currentJob = job;
        try {
          startJob(currentJob, currentJob.pendingPrompt);
          delete currentJob.pendingPrompt;
        } catch (error) {
          finishJob(currentJob, { code: null, error });
          recordJobMetric(currentJob);
          activeHandle = null;
        }
      }

      sendJson(response, 202, {
        job: publicJob(currentJob),
        queued: shouldQueue,
        queuedJob: shouldQueue ? publicQueue([job])[0] : null,
        queue: publicQueue(queuedJobs),
        held: publicHeld(heldJobs),
        history: dashboardHistory()
      });
      return;
    }

    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/playwright/status"
    ) {
      sendJson(
        response,
        200,
        playwrightAuthenticationStatus(
          resolvedRepository,
          playwrightConnection,
          currentJob
        )
      );
      return;
    }

    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/playwright/artifacts"
    ) {
      const jobId = requestUrl.searchParams.get("jobId");
      const job = [
        currentJob,
        ...queuedJobs,
        ...completedJobs
      ].find((entry) => entry?.id === jobId);
      if (!jobId || !job) {
        sendJson(response, 404, {
          error: "FixLab job not found for Playwright evidence"
        });
        return;
      }
      let artifacts;
      try {
        artifacts = listPlaywrightArtifacts(resolvedRepository, {
          since: job.startedAt ?? job.createdAt
        });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      playwrightArtifacts.clear();
      for (const artifact of artifacts) {
        playwrightArtifacts.set(artifact.id, artifact);
      }
      sendJson(response, 200, {
        artifacts: artifacts.map(
          ({ id, name, relativePath, bytes, updatedAt, kind, mimeType }) => ({
            id,
            name,
            relativePath,
            bytes,
            updatedAt,
            kind,
            mimeType,
            url: `/api/playwright/artifacts/${id}`
          })
        )
      });
      return;
    }

    const artifactMatch = requestUrl.pathname.match(
      /^\/api\/playwright\/artifacts\/([a-f0-9]{24})$/
    );
    if (request.method === "GET" && artifactMatch) {
      const artifact = playwrightArtifacts.get(artifactMatch[1]);
      if (!artifact || !existsSync(artifact.path)) {
        sendJson(response, 404, { error: "Playwright artifact not found" });
        return;
      }
      const range = artifact.kind === "video"
        ? request.headers.range?.match(/^bytes=(\d*)-(\d*)$/)
        : null;
      if (range) {
        const requestedStart = range[1] ? Number(range[1]) : 0;
        const requestedEnd = range[2]
          ? Number(range[2])
          : artifact.bytes - 1;
        const start = Math.max(0, requestedStart);
        const end = Math.min(artifact.bytes - 1, requestedEnd);
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start > end ||
          start >= artifact.bytes
        ) {
          response.writeHead(416, {
            "Content-Range": `bytes */${artifact.bytes}`,
            "Cache-Control": "no-store"
          });
          response.end();
          return;
        }
        response.writeHead(206, {
          "Content-Type": artifact.mimeType,
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${artifact.bytes}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        });
        createReadStream(artifact.path, { start, end }).pipe(response);
        return;
      }
      response.writeHead(200, {
        "Content-Type": artifact.mimeType,
        "Content-Length": artifact.bytes,
        "Accept-Ranges": artifact.kind === "video" ? "bytes" : "none",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      createReadStream(artifact.path).pipe(response);
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/playwright/connect"
    ) {
      let proofOnly = false;
      let apiProof = false;
      if (request.headers["content-type"]?.startsWith("application/json")) {
        const body = await readJsonBody(request);
        if ((body.proofOnly !== undefined && typeof body.proofOnly !== "boolean") ||
            (body.apiProof !== undefined && typeof body.apiProof !== "boolean")) {
          sendJson(response, 400, { error: "proofOnly and apiProof must be booleans" });
          return;
        }
        if (body.proofOnly === true || body.apiProof === true) {
          const expectedOrigin = `http://${DASHBOARD_HOST}:${server.address().port}`;
          if (request.headers.host !== new URL(expectedOrigin).host || request.headers.origin !== expectedOrigin) {
            sendJson(response, 403, { error: "Fresh proof requires the owning dashboard origin" });
            return;
          }
          if (body.instanceId !== sessions.id || body.confirmed !== true) {
            sendJson(response, 409, { error: "Fresh proof requires the confirmed current workspace instance" });
            return;
          }
          proofOnly = body.proofOnly === true;
          apiProof = body.apiProof === true;
        }
      }
      if (playwrightConnection.handle) {
        sendJson(response, 409, {
          error: "Playwright authentication is already running"
        });
        return;
      }
      if (apiProof && currentJob?.running) {
        sendJson(response, 409, { error: "API proof must wait for the portal's owned job to settle" });
        return;
      }
      const authenticationProfile = loadRepositoryProfile(resolvedRepository).browserAutomation;
      if (!apiProof && authenticationProfile?.apiAuthentication?.productionDatabaseReadOnly &&
          authenticationProfile.mode !== "api") {
        sendJson(response, 403, {
          error: "Production database approval permits dedicated API proof only, not ordinary portal UI authentication."
        });
        return;
      }
      let configuration;
      try {
        configuration = playwrightAuthenticationConfig(resolvedRepository, { apiProof });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      if (!configuration.command || configuration.statusPaths.length === 0) {
        sendJson(response, 400, {
          error:
            "repository profile must configure browserAutomation.authentication.command and statusPaths"
        });
        return;
      }
      if (proofOnly && !configuration.proofCommand) {
        sendJson(response, 400, { error: "Fresh proof requires a repository-owned proofCommand" });
        return;
      }
      try {
        const blocker = configuration.mode === "api" ? null : browserOwnership(configuration);
        if (blocker) {
          sendJson(response, 409, { error: blocker.message, blocker });
          return;
        }
      } catch (error) {
        sendJson(response, 409, { error: `Browser preflight failed: ${error.message}` });
        return;
      }
      if (!existsSync(configuration.workingDirectory)) {
        sendJson(response, 400, {
          error: "configured Playwright working directory does not exist"
        });
        return;
      }
      playwrightConnection.lastResult = null;
      playwrightConnection.proof = null;
      playwrightConnection.apiProof = apiProof;
      playwrightConnection.runId = randomUUID();
      const authenticationJob = currentJob;
      const startAuthentication = (proving = false) => {
      const proofIdentity = proving ? authenticationProofIdentity(configuration, authenticationJob) : null;
      const child = spawnOwnedShell({ ...configuration,
        environment: { ...configuration.environment,
          FIXLAB_TARGET_ENVIRONMENT: apiProof ? "local" : authenticationJob?.targetEnvironment ?? "local" },
        command: proving ? configuration.proofCommand : configuration.command });
      playwrightConnection.handle = child;
      child.once("fixlab-input-error", (error) => {
        playwrightConnection.lastResult = {
          ok: false,
          message: `Authentication input failed: ${error.message}`,
          finishedAt: new Date().toISOString()
        };
      });
      child.once("error", (error) => {
        playwrightConnection.lastResult = {
          ok: false,
          message: error.message,
          finishedAt: new Date().toISOString()
        };
        playwrightConnection.handle = null;
      });
      child.once("close", (code, signal) => {
        try {
          if (ownedTreeRunning(child)) {
            playwrightConnection.lastResult = {
              ok: false,
              message: "Authentication descendants remain owned; retry must wait for confirmed termination.",
              finishedAt: new Date().toISOString()
            };
            return;
          }
        } catch (error) {
          playwrightConnection.lastResult = {
            ok: false,
            message: `Authentication termination is unverified: ${error.message}`,
            finishedAt: new Date().toISOString()
          };
          return;
        }
        if (code === 0 && !proving && configuration.proofCommand) {
          try {
            startAuthentication(true);
          } catch (error) {
            playwrightConnection.handle = null;
            playwrightConnection.lastResult = { ok: false, message: `Authentication proof could not start: ${error.message}`,
              finishedAt: new Date().toISOString() };
          }
          return;
        }
        let proofError = "";
        if (code === 0 && proving) {
          try {
            if (currentJob !== authenticationJob) {throw new Error("The authentication job changed; rerun proof for the current job.");}
            if (proofIdentity !== authenticationProofIdentity(configuration, authenticationJob)) {
              throw new Error("Authentication state changed during proof; rerun the owned browser check.");
            }
            playwrightConnection.proof = proofIdentity;
          } catch (error) {
            proofError = error.message;
          }
        }
        playwrightConnection.lastResult = {
          ok: code === 0 && !proofError,
          message:
            code === 0
              ? proofError || (proving ? "Repository-owned authenticated browser proof passed." :
                "Authentication helper completed; sign-in remains unverified without a repository-owned proofCommand.")
              : `Playwright authentication exited with code ${code ?? "unknown"}${
                  signal ? ` (${signal})` : ""
                }.`,
          finishedAt: new Date().toISOString()
        };
        playwrightConnection.handle = null;
      });
      };
      try {
        startAuthentication(proofOnly);
      } catch {
        playwrightConnection.lastResult = { ok: false,
          message: "Authentication could not start; verify the owned helper and authentication state.",
          finishedAt: new Date().toISOString() };
        sendJson(response, 409, { error: playwrightConnection.lastResult.message });
        return;
      }
      sendJson(response, 202, {
        ...playwrightAuthenticationStatus(
          resolvedRepository,
          playwrightConnection,
          currentJob
        ),
        started: true
      });
      return;
    }

    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/frontend/status"
    ) {
      sendJson(
        response,
        200,
        await frontendStatus(resolvedRepository, frontendConnection)
      );
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/frontend/start"
    ) {
      if (frontendConnection.handle || frontendConnection.starting) {
        sendJson(response, 409, { error: "FixLab already started the frontend" });
        return;
      }
      try {
        const result = await launchFrontend(request.verifyConversation);
        sendJson(response, result.started ? 202 : 200, {
          ...(await frontendStatus(resolvedRepository, frontendConnection)),
          ...result
        });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/frontend/stop"
    ) {
      const child = frontendConnection.handle;
      const wasStarting = frontendConnection.starting;
      frontendStartGeneration += 1;
      try {
        await stopProcessTree(child);
      } catch (error) {
        sendJson(response, 500, { error: error.message });
        return;
      }
      frontendConnection.handle = null;
      sendJson(response, 200, {
        ...(await frontendStatus(resolvedRepository, frontendConnection)),
        stopped: Boolean(child) || wasStarting
      });
      return;
    }

    if (request.method === "GET" && staticFiles.has(requestUrl.pathname)) {
      const fileName = staticFiles.get(requestUrl.pathname);
      const filePath = join(publicDirectory, fileName);
      if (!existsSync(filePath)) {
        sendJson(response, 404, { error: "dashboard asset not found" });
        return;
      }
      response.writeHead(200, {
        "Content-Type":
          contentTypes[extname(filePath)] ?? "application/octet-stream",
        "Cache-Control": "no-cache",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer"
      });
      createReadStream(filePath).pipe(response);
      return;
    }

    sendJson(response, 404, { error: "not found" });
  });

  return {
    server,
    async listen({ port = DEFAULT_DASHBOARD_PORT } = {}) {
      const validatedPort = port === 0 ? 0 : validatePort(port);
      await new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(validatedPort, DASHBOARD_HOST, resolveListen);
      });
      const address = server.address();
      dashboardUrl = `http://${DASHBOARD_HOST}:${address.port}`;
      try {
        sessions.register(dashboardUrl);
      } catch (error) {
        await new Promise((resolveClose) => server.close(resolveClose));
        throw error;
      }
      return {
        host: DASHBOARD_HOST,
        port: address.port,
        url: `http://${DASHBOARD_HOST}:${address.port}`
      };
    },
    async close() {
      closing = true;
      currentJob?.validationSession?.cancel();
      frontendStartGeneration += 1;
      const failures = [];
      const attempt = async (action) => {
        try {
          await action();
        } catch (error) {
          failures.push(error);
        }
      };
      if (ownsWorkspaceServers) {
        workspaceHostState.closing = true;
        for (const workspace of workspaceServers.values()) {
          await attempt(async () => {
            try { await workspace.ready; } finally { await workspace.dashboard.close(); }
          });
        }
        workspaceServers.clear();
      }
      await attempt(() => persistDashboardState());
      await attempt(async () => {
        if (currentJob?.postValidation) {
          currentJob.postValidation.cancelled = true;
          await currentJob.validationCompletion;
        }
      });
      await attempt(async () => {
        const handle = activeHandle;
        const termination = activeTermination;
        if (!handle) {
          return;
        }
        handle.terminate?.();
        if (!termination) {
          throw new Error("Executor termination cannot be verified; its reservation is retained.");
        }
        await termination;
      });
      await attempt(async () => {
        await stopProcessTree(playwrightConnection.handle);
        playwrightConnection.handle = null;
      });
      await attempt(async () => {
        await stopProcessTree(frontendConnection.handle);
        frontendConnection.handle = null;
      });
      for (const directory of artifactDirectories) {
        await attempt(() => removeArtifactDirectory(directory));
      }
      artifactDirectories.clear();
      await attempt(async () => {
        server.closeIdleConnections?.();
        await new Promise((resolveClose, reject) => {
          if (!server.listening) {
            resolveClose();
            return;
          }
          server.close((error) => (error ? reject(error) : resolveClose()));
        });
      });
      await attempt(() => sessions.unregister());
      if (failures.length) {
        throw new AggregateError(failures, "FixLab shutdown could not complete every owned cleanup step");
      }
    }
  };
}
