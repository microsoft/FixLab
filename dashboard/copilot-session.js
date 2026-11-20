import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AUTOMATIC_PERMISSION_RECOVERY_GUIDANCE,
  MAX_RUNTIME_FRAME_BYTES,
  MAX_RUNTIME_REQUESTS,
  PERMISSION_RECOVERY_GUIDANCE,
  runtimePermissionPrompt,
  runtimeQuestionPrompt,
  runtimeRequestId,
  validateToolApprovalMode
} from "./runtime-requests.js";
import { createRuntimePermissionPolicy, validateJobFileAccess } from "./runtime-permission-policy.js";
import { createPublicationPermissions, publicationCommand } from "./publication-permissions.js";
import { createNonProductionPostAccess } from "./dev-post.js";
import { clearBrowserPostEnvironment, startBrowserPostBridge } from "./browser-post.js";

export function extensionLaunchProvider(bootstrap) {
  return {
    async resolve({ modulePath }) {
      if (typeof modulePath !== "string" || !isAbsolute(modulePath) ||
          !modulePath.endsWith(".mjs")) {
        throw new Error("Copilot supplied an unsupported extension entrypoint.");
      }
      return {
        launch: {
          executable: process.execPath,
          args: [bootstrap],
          env: { EXTENSION_PATH: modulePath }
        }
      };
    }
  };
}

function extensionBootstrapPath() {
  const platform = process.platform === "linux" &&
      !process.report.getReport().header.glibcVersionRuntime ? "linuxmusl" : process.platform;
  const require = createRequire(import.meta.resolve("@github/copilot-sdk"));
  const root = dirname(require.resolve(`@github/copilot-sdk-${platform}-${process.arch}/package.json`));
  return join(root, "preloads", "extension_bootstrap.mjs");
}

export async function runCopilotSession(config, { client, ask, output, onUsage = () => {},
  publicationContext = async (verify) => {
    if (!Number.isInteger(config.dashboardPort) || config.dashboardPort < 1 || config.dashboardPort > 65535) {
      throw new Error("Publication consent requires the owning dashboard.");
    }
    const response = await fetch(`http://127.0.0.1:${config.dashboardPort}/api/job/publication-context`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: config.sessionId, repository: config.repository, verify }),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) { throw new Error("The owning dashboard could not verify publication readiness."); }
    return response.json();
  }
}) {
  clearBrowserPostEnvironment();
  let allowAllTools = validateToolApprovalMode(config.toolApprovalMode) === "allow-all";
  const inputTokenLimit = config.inputTokenLimit ?? 0;
  if (!Number.isSafeInteger(inputTokenLimit) || inputTokenLimit < 0) {
    throw new Error("inputTokenLimit must be a non-negative safe integer.");
  }
  const fileAccess = validateJobFileAccess(config.fileAccess, config.repository, config.sessionId, config.mode);
  if (fileAccess?.allowValidationGates && (!Number.isInteger(config.dashboardPort) ||
      config.dashboardPort < 1 || config.dashboardPort > 65535)) {
    throw new Error("Reviewed validation-gate trust requires the owning dashboard's current port.");
  }
  const permissions = createRuntimePermissionPolicy(config.repository, config.protectedPaths, fileAccess,
    config.dashboardPort, config.sessionId);
  const publication = createPublicationPermissions(config.repository, config.protectedPaths);
  let publicationGranted = false;
  let policyReady = false;
  let automaticRecoveryAvailable = true;
  let automaticRecoveryAttempted = false;
  const usage = {
    inputTokens: config.usage?.inputTokens ?? 0,
    cachedInputTokens: config.usage?.cachedInputTokens ?? 0,
    cacheWriteTokens: config.usage?.cacheWriteTokens ?? 0,
    outputTokens: config.usage?.outputTokens ?? 0
  };
  let streamed = false;
  let budgetReached = false;
  let interruptForBudget;
  const budget = new Promise((resolve) => { interruptForBudget = resolve; });
  const budgetError = () => {
    const error = new Error(`Input-token ceiling reached (${usage.inputTokens}/${inputTokenLimit}, cached input included). Review the budget before resuming; no additional work was authorized.`);
    error.code = "INPUT_TOKEN_LIMIT";
    return error;
  };
  const postAccess = createNonProductionPostAccess({
    repository: config.repository, targetEnvironment: config.targetEnvironment, ask,
    mutationMode: config.testMutationMode,
    selectedMutationMode: config.selectedTestMutationMode,
    allowPostRequests: config.allowPostRequests,
    postWriteApproval: config.postWriteApproval,
    jobId: config.sessionId,
    isReady: () => policyReady && !budgetReached
  });
  const options = {
    sessionId: config.sessionId,
    workingDirectory: config.repository,
    agent: "fixlab:fixlab",
    enableConfigDiscovery: true,
    enableManagedSettings: true,
    toolSearch: { enabled: true, deferThreshold: 1 },
    largeOutput: { enabled: true, maxSizeBytes: 8192 },
    infiniteSessions: {
      enabled: true, backgroundCompactionThreshold: 0.25, bufferExhaustionThreshold: 0.4
    },
    extensionSdkPath: config.extensionSdkPath,
    streaming: true,
    additionalDirectories: config.additionalDirs,
    ...(postAccess ? { tools: [postAccess.tool] } : {}),
    ...(config.model ? { model: config.model } : {}),
    ...(config.model === "hydrafusion" ? { enableExperimentalMode: true } : {}),
    onPermissionRequest: async (request) => {
      const prompt = runtimePermissionPrompt(request);
      if (budgetReached) {
        return { kind: "reject" };
      }
      const canAllowAll = policyReady && prompt.canApprove &&
        request.canOfferSessionApproval !== false && !request.managedApprovalRequired &&
        !request.requestSandboxBypass && !request.requestSandboxPermissive &&
        !request.sandboxPathGrant && !request.warning && !request.hasWriteFileRedirection &&
        !(request.kind === "shell" && publicationCommand(request.fullCommandText));
      const automatic = policyReady ? permissions.automaticApproval(request, prompt) : null;
      if (automatic) {
        output("stdout", `\nApplied a built-in read-only permission: ${automatic}. No persistent, broad shell, escalation or managed-policy grant was created.\n`);
        return { kind: "approve-once", approvedInteractively: false };
      }
      if (policyReady && permissions.allows(request, prompt)) {
        output("stdout", "\nApplied an explicitly reviewed job-scoped permission. Sensitive paths, changed commands, escalation and managed human approval remain outside this grant.\n");
        return { kind: "approve-once", approvedInteractively: false };
      }
      let publicationReview = null;
      if (policyReady && publication.eligible(request, prompt)) {
        try {
          const readiness = await publicationContext(!publicationGranted);
          if (publication.allows(request, readiness)) {
            output("stdout", "\nApplied the reviewed publication scope for this exact checkout, tree, branches and destination. Managed approvals remain manual.\n");
            return { kind: "approve-once", approvedInteractively: false };
          }
          publicationReview = publication.review(request, readiness);
        } catch (error) {
          output("stderr", `\nPublication scope unavailable: ${error.message} Review this request manually.\n`);
        }
      }
      if (allowAllTools && canAllowAll) {
        output("stdout", "\nApplied the user's Allow all tool-approval choice for this executor. Required policies and workflow approvals remain in effect.\n");
        return { kind: "approve-once", approvedInteractively: false };
      }
      const reviewedGrant = publicationReview ??
        (policyReady && request.kind !== "write" ? permissions.review(request, prompt) : null);
      const grantScope = reviewedGrant?.scope;
      if (grantScope) {
        prompt.details = JSON.stringify({
          ...JSON.parse(prompt.details),
          jobGrant: {
            repository: config.repository,
            ...(grantScope === "publication-batch"
              ? { publication: JSON.parse(reviewedGrant.key) }
              : grantScope === "exact-test-command"
              ? { workingDirectoryWithinRepository: relative(config.repository, request.resolvedWorkingDirectory) || "." }
              : { files: "Non-sensitive source, documentation and selected project files only; never directories." })
          }
        }, null, 2);
      }
      const sourceEditReview = policyReady && config.mode === "fix-and-validate"
        ? permissions.reviewSourceEdit(request, prompt) : null;
      if (policyReady && prompt.canRecover === true && !sourceEditReview &&
          automaticRecoveryAvailable && request.canOfferSessionApproval !== false &&
          !request.hasWriteFileRedirection) {
        automaticRecoveryAvailable = false;
        automaticRecoveryAttempted = true;
        output("stderr", `\nFixLab rejected an unreviewable operation (${prompt.blockedReasons.join(", ")}); requesting one automatic safe recovery using already-authorized helpers. No permission was granted or operation replayed. A remaining blocker requires manual review.\n`);
        return { kind: "reject", feedback: AUTOMATIC_PERMISSION_RECOVERY_GUIDANCE };
      }
      if (automaticRecoveryAttempted && prompt.canRecover === true) {
        prompt.automaticRecoveryAttempted = true;
        prompt.details += "\nAutomatic safe recovery was already attempted once. Resolve the remaining prerequisite using the guidance above; further recovery requires an explicit dashboard decision.";
      }
      const response = await ask({
        ...prompt, ...(grantScope ? { grantScope } : {}), ...(canAllowAll ? { canAllowAll: true } : {}),
        ...(sourceEditReview ? { sourceEditReview } : {})
      });
      if (budgetReached) {
        return { kind: "reject" };
      }
      if (response.action === "deny") {
        automaticRecoveryAvailable = false;
      }
      if (response.action === "allow" && !prompt.canApprove) {
        throw new Error("An unreviewable permission request cannot be approved.");
      }
      if (response.recover !== undefined) {
        if (response.recover !== true || response.action !== "deny" || prompt.canRecover !== true) {
          throw new Error("Guided recovery was not offered for this request.");
        }
        return { kind: "reject", feedback: PERMISSION_RECOVERY_GUIDANCE };
      }
      if (response.scope !== undefined) {
        if (response.action !== "allow" || (response.scope === "all-tools"
          ? !canAllowAll
          : response.scope !== grantScope)) {
          throw new Error("The selected job-scoped permission was not offered.");
        }
        if (response.scope === "all-tools") {
          allowAllTools = true;
        } else if (response.scope === "publication-batch") {
          const fresh = publication.review(request, await publicationContext(true));
          if (!fresh || fresh.key !== reviewedGrant.key) {
            throw new Error("Publication scope changed during review; no grant was created.");
          }
          publication.grant(fresh);
          publicationGranted = true;
        } else {
          permissions.grant(request, prompt, response.scope, reviewedGrant);
        }
        output("stdout", "\nThe user explicitly granted a reviewed runtime scope for this job's current executor only. The grant expires on completion, stop, hold, failure or restart.\n");
      }
      return response.action === "allow"
        ? { kind: "approve-once", approvedInteractively: true }
        : { kind: "reject" };
    },
    onUserInputRequest: async (request) => {
      if (budgetReached) {
        throw budgetError();
      }
      const response = await ask(runtimeQuestionPrompt(request));
      if (budgetReached) {
        throw budgetError();
      }
      if (response.action !== "answer") {
        throw new Error("The user cancelled the runtime question.");
      }
      return { answer: response.answer, wasFreeform: response.wasFreeform };
    }
  };
  let browserPost;
  try {
    onUsage({ ...usage });
    if (inputTokenLimit > 0 && usage.inputTokens >= inputTokenLimit) {
      throw budgetError();
    }
    if (postAccess?.browserPost) {
      browserPost = await startBrowserPostBridge({
        send: postAccess.browserRequest ?? postAccess.browserPost,
        serializeRequests: Boolean(postAccess.browserRequest),
        revoke: postAccess.revoke, jobId: config.sessionId,
        environment: config.targetEnvironment.toLowerCase()
      });
    }
    await client.start();
    const session = config.resume
      ? await client.resumeSession(config.sessionId, options)
      : await client.createSession(options);
    const policy = await session.rpc.managedSettings.get();
    if (policy?.failClosed !== false) {
      throw new Error("Enterprise policy could not be determined; execution is blocked.");
    }
    policyReady = true;
    session.on((event) => {
      permissions.observeToolEvent(event);
      if (event.type === "assistant.message_delta") {
        streamed = true;
        output("stdout", event.data.deltaContent);
      } else if (event.type === "assistant.message") {
        if (!streamed && event.data.content) {
          output("stdout", event.data.content);
        }
        streamed = false;
        output("stdout", "\n");
      } else if (event.type === "assistant.usage") {
        for (const [target, source] of [
          ["inputTokens", "inputTokens"], ["cachedInputTokens", "cacheReadTokens"],
          ["cacheWriteTokens", "cacheWriteTokens"], ["outputTokens", "outputTokens"]
        ]) {
          if (Number.isFinite(event.data[source]) && event.data[source] >= 0) {
            usage[target] += event.data[source];
          }
        }
        onUsage({ ...usage });
        if (inputTokenLimit > 0 && usage.inputTokens >= inputTokenLimit) {
          budgetReached = true;
          interruptForBudget();
        }
      }
    });
    if (config.resume) {
      const model = await session.rpc.model.getCurrent();
      if (typeof model.modelId !== "string" || !model.modelId) {
        throw new Error("The resumed session has no selected model for context measurement.");
      }
      const context = await session.rpc.metadata.recomputeContextTokens({ modelId: model.modelId });
      if (!Number.isSafeInteger(context.messagesTokenCount) || context.messagesTokenCount < 0) {
        throw new Error("The resumed session's context size could not be measured.");
      }
      if (context.messagesTokenCount > 24000) {
        output("stdout", "\nFIXLAB_ACTIVITY|intake|Compacting oversized retained job history before continuing; no approvals or browser actions are inferred.\n");
        const result = await session.rpc.history.compact({
          customInstructions: "Preserve the exact user request and latest explicit business decisions, scope, environment, mutation restrictions, denied and pending permissions, human authentication requirements, existing browser/form state, completed and remaining assertions, current blocker, and retained script/config/evidence paths. Preserve branch/checkout ownership, changed files, exact completed test commands and results, baseline failures, deferred required gates, input-token ceiling and remaining work. Never include credentials or raw browser state. Summarize successful discovery and repeated tool output once. Do not infer approvals, rerun completed checks without changed inputs, or replay stale form values. Keep selectors and reusable script details needed to continue the same job safely. Runtime grants are host-owned and must be reviewed again after executor termination."
        });
        if (!result.success || !Number.isFinite(result.tokensRemoved) || result.tokensRemoved <= 0) {
          throw new Error("Oversized job history could not be compacted; continuation is blocked to avoid repeating expensive context.");
        }
        output("stdout", `\nFIXLAB_ACTIVITY|intake|Retained job history compacted: ${result.tokensRemoved} context tokens removed. Existing safety policy and explicit permission review remain required.\n`);
      }
    }
    if (budgetReached) {
      throw budgetError();
    }
    const interrupted = await Promise.race([
      session.sendAndWait({ prompt: config.prompt + (browserPost
        ? "\nBrowser POST integration: a private job-bound relay is inherited by runtime child processes. In a reviewed Node/Playwright business-request guard, import process.env.FIXLAB_BROWSER_POST_HELPER and call forwardApprovedBrowserPost(route, { environment: the selected environment, purpose: a non-sensitive test purpose }). It uses the same configured endpoint/test-record or API-base approval, authentication helper and failure revocation as the POST tool. Never print or persist FIXLAB_BROWSER_POST_* values. Do not copy tokens or browser state. Keep authentication, read-only query guards and unapproved mutations separate. Inherit the executor environment when starting the reviewed runner; do not create approval contract files. Response data stays private in browser memory; report only sanitized status and focused assertions. HTTP success alone does not prove persistence." +
          (postAccess.browserRequest
            ? " This PPE job also supports complete read/write browser journeys through forwardApprovedBrowserRequest from the same helper: GET, POST, PUT, PATCH and DELETE only on the exact reviewed dataSafety.ppeWrite origins. Route only approved PPE business requests through it, not identity, portal assets or unrelated APIs. Concurrent browser requests are serialized without replay. Use actual response data privately for scenario and persistence assertions; do not stop at HTTP status or claim all scenarios passed without running them. Preserve configured read-only and authentication guards outside this explicit grant."
            : "")
        : "") }, 24 * 60 * 60 * 1000).then(() => false),
      budget.then(() => true)
    ]);
    if (interrupted || budgetReached) {
      throw budgetError();
    }
  } finally {
    policyReady = false;
    permissions.clear();
    publication.clear();
    try {
      await browserPost?.close();
    } finally {
      const errors = await client.stop();
      if (errors.length > 0) {
        throw new Error("Copilot runtime shutdown failed; owned process containment must complete before resuming.");
      }
    }
  }
}

async function main() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Map();
  const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  let started = false;
  let task;
  let client;
  const cancel = () => {
    for (const { reject } of pending.values()) {
      reject(new Error("The dashboard disconnected or cancelled this request."));
    }
    pending.clear();
  };
  try {
    for await (const line of lines) {
      if (Buffer.byteLength(line) > MAX_RUNTIME_FRAME_BYTES) {
        throw new Error("Runtime input exceeded its size limit.");
      }
      const message = JSON.parse(line);
      if (!started) {
        if (message.type !== "start" || !message.sessionId || !message.repository ||
            typeof message.prompt !== "string" || !message.packageRoot) {
          throw new Error("A valid runtime start message is required.");
        }
        started = true;
        const { CopilotClient, RuntimeConnection } = await import("@github/copilot-sdk");
        message.extensionSdkPath = dirname(fileURLToPath(import.meta.resolve("@github/copilot-sdk")));
        client = new CopilotClient({
          connection: RuntimeConnection.forStdio({
            args: message.model === "hydrafusion" ? ["--experimental"] : []
          }),
          workingDirectory: message.repository,
          builtinPluginDirectories: [message.packageRoot],
          extensionLaunchProvider: extensionLaunchProvider(extensionBootstrapPath()),
          logLevel: "error"
        });
        task = runCopilotSession(message, {
          client,
          output: (stream, text) => emit({ type: "output", stream, text }),
          onUsage: (usage) => emit({ type: "usage", usage }),
          ask(request) {
            if (pending.size >= MAX_RUNTIME_REQUESTS) {
              return Promise.reject(new Error("Too many pending runtime requests."));
            }
            const id = runtimeRequestId();
            return new Promise((resolve, reject) => {
              pending.set(id, { resolve, reject });
              emit({ type: "request", ...request, id });
            });
          }
        }).then(() => {
          cancel();
          lines.close();
        }, (error) => {
          process.exitCode = 1;
          emit({ type: "error", message: error.message, code: error.code });
          cancel();
          lines.close();
        });
      } else if (message.type === "response" && pending.has(message.id)) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (message.action === "cancel") {
          request.reject(new Error("The user cancelled the runtime request."));
        } else {
          request.resolve(message);
        }
      } else {
        throw new Error("Unknown or stale runtime response.");
      }
    }
    cancel();
    await task;
  } catch (error) {
    process.exitCode = 1;
    emit({ type: "error", message: error.message });
    cancel();
    if (client) {
      await client.forceStop();
    }
  } finally {
    lines.close();
    process.stdin.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
