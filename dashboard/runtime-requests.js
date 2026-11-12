import { randomUUID } from "node:crypto";

export const MAX_RUNTIME_REQUESTS = 8;
export const MAX_RUNTIME_FRAME_BYTES = 1024 * 1024;
export function validateToolApprovalMode(value = "ask") {
  if (!["ask", "allow-all"].includes(value)) {
    throw new Error("toolApprovalMode must be ask or allow-all.");
  }
  return value;
}
const secret = /authorization|bearer\s|(?:password|passwd|secret|token|cookie|api[_-]?key)\s*["':=]|(?:gh[pousr]_|github_pat_|eyJ)[A-Za-z0-9_-]{16,}|https?:\/\/[^/\s]+:[^/\s]+@|[?&](?:sig|code|key|access_token|client_secret)=|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const credentialQuestion = /\b(?:password|passphrase|passwd|passcode|credential|verification\s+code|one[ -]time\s+(?:code|password)|(?:MFA|2FA|security|recovery|backup)\s+code|OTP|TOTP|PIN|(?:access|refresh|id|session|authentication)\s*[_-]?\s*token|API\s*[_-]?\s*key|private\s*[_-]?\s*key|client\s*[_-]?\s*secret|cookie|secret)s?\b/i;
const credentialSolicitation = /\b(?:enter|paste|provide|send|share|supply|submit|type|input|give|tell|what\s+(?:is|are)|required|needed)\b/i;
const credentialTest = new RegExp(`${credentialQuestion.source}(?:[-\\s]+(?:reset|validation|rotation|expiration))?[-\\s]+(?:tests?|specs?)\\b`, "gi");
const credentialValue = new RegExp(`${credentialQuestion.source}\\s*[:=]`, "i");
const credentialPath = /(?:^|[\\/])(?:\.auth|\.edge-profile|\.ssh|\.aws|\.azure|\.env(?:\.[^\\/]*)?|credentials(?:\.[^\\/]*)?)(?:[\\/]|$)/i;
const permissionBlockReasons = {
  unsupported: "The runtime supplied an unsupported or incomplete request.",
  oversized: "The complete review exceeds the 8192-character display limit.",
  "sensitive-path": "The destination may contain credentials or browser state.",
  "sensitive-content": "The details contain credential-like text, which can include authentication-related source code.",
  "control-characters": "The details contain unsupported control characters."
};

export const PERMISSION_RECOVERY_GUIDANCE =
  "The user denied this exact operation and requested safe recovery of the blocked stage. " +
  "Do not replay, encode, conceal, split or repackage the rejected operation to evade review. " +
  "Reuse existing reviewed repository-owned tests, configured runner commands and authentication helpers. " +
  "Do not create or modify credential-handling code as a workaround. Keep completed evidence and existing failures. " +
  "Human sign-in, managed policy and normal permissions remain required. This grants no new file access, " +
  "external writes or publication. If a safe prerequisite is unavailable, explain the exact blocker and stop that stage.";

export function safeRuntimeText(value, limit = 8192) {
  return typeof value === "string" && value.length <= limit &&
    !secret.test(value) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
}

function requestsCredentials(value) {
  return credentialQuestion.test(value) &&
    (credentialSolicitation.test(value) || credentialQuestion.test(value.replace(credentialTest, "")));
}

export function validateSourceEditReview(value) {
  if (!value || typeof value.fileName !== "string" || !safeRuntimeText(value.fileName, 400) ||
      /^[\\/]|[*?:]/.test(value.fileName) ||
      value.fileName.split(/[\\/]/).some((part) => !part || part === "." || part === "..") ||
      !Number.isSafeInteger(value.reviewCharacters) || value.reviewCharacters <= 8192 ||
      value.reviewCharacters > MAX_RUNTIME_FRAME_BYTES) {
    throw new Error("Invalid oversized source-edit review metadata.");
  }
  return { fileName: value.fileName, reviewCharacters: value.reviewCharacters };
}

export function recordedSourceEditReview(value) {
  if (value === undefined || value === null) { return null; }
  if (typeof value.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(value.requestId)) {
    throw new Error("Invalid recorded source-edit request identity.");
  }
  return { requestId: value.requestId, ...validateSourceEditReview(value) };
}

export function sourceEditAuthorization(value) {
  const { fileName } = validateSourceEditReview(value);
  return `I explicitly authorize a fresh attempt at the previously reviewed source edit in ${fileName}. ` +
    "This supersedes the earlier denial only for that edit under the reviewed source/test file trust for this job and checkout. " +
    "Do not reopen the old approval, split or conceal the edit, retry other denied operations, or bypass full content, path, managed-policy or sandbox checks.";
}

export function validateRuntimeUsage(value, previous = {}) {
  const usage = {};
  for (const name of ["inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens"]) {
    if (!Number.isSafeInteger(value?.[name]) || value[name] < (previous[name] ?? 0)) {
      throw new Error("Copilot sent invalid or decreasing structured usage counters.");
    }
    usage[name] = value[name];
  }
  if (usage.cachedInputTokens > usage.inputTokens) {
    throw new Error("Copilot cached input cannot exceed total structured input.");
  }
  usage.cacheReusePercent = usage.inputTokens > 0
    ? usage.cachedInputTokens / usage.inputTokens * 100 : 0;
  return usage;
}

export function runtimePermissionPrompt(request) {
  const text = (value) => typeof value === "string" && value.trim().length > 0;
  const supported = {
    shell: text(request?.fullCommandText),
    read: text(request?.path),
    write: text(request?.fileName) && typeof request?.diff === "string",
    url: text(request?.url),
    mcp: text(request?.serverName) && text(request?.toolName)
  }[request?.kind] === true;
  const fields = {
    kind: request?.kind,
    intention: request?.intention,
    command: request?.fullCommandText,
    path: request?.path ?? request?.fileName,
    diff: request?.diff,
    url: request?.url,
    server: request?.serverName,
    tool: request?.toolName,
    readOnly: request?.readOnly,
    arguments: request?.args,
    possiblePaths: request?.possiblePaths,
    possibleUrls: request?.possibleUrls,
    warning: request?.warning,
    sandboxBypass: request?.requestSandboxBypass === true,
    sandboxPermissiveRetry: request?.requestSandboxPermissive === true,
    sandboxReason: request?.requestSandboxBypassReason,
    managedHumanApprovalRequired: request?.managedApprovalRequired === true
  };
  let hasControlCharacters = false;
  const details = JSON.stringify(fields, (_key, value) => {
    if (typeof value === "string" && /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
      hasControlCharacters = true;
    }
    return value;
  }, 2);
  const sensitivePath = ["read", "write"].includes(request?.kind) &&
    credentialPath.test(request.path ?? request.fileName ?? "");
  const reviewable = supported && !sensitivePath && !hasControlCharacters && safeRuntimeText(details);
  const blockedReasons = [
    ...(!supported ? ["unsupported"] : []),
    ...(details.length > 8192 ? ["oversized"] : []),
    ...(sensitivePath ? ["sensitive-path"] : []),
    ...(secret.test(details) ? ["sensitive-content"] : []),
    ...(hasControlCharacters ? ["control-characters"] : [])
  ];
  const canRecover = !reviewable && supported && !sensitivePath &&
    !request.managedApprovalRequired && !request.requestSandboxBypass &&
    !request.requestSandboxPermissive && !request.sandboxPathGrant && !request.warning;
  const canUseFileTrust = request?.kind === "write" && supported && !sensitivePath && !hasControlCharacters &&
    Buffer.byteLength(details, "utf8") <= MAX_RUNTIME_FRAME_BYTES &&
    safeRuntimeText(request.diff, MAX_RUNTIME_FRAME_BYTES) &&
    safeRuntimeText(details, MAX_RUNTIME_FRAME_BYTES);
  return {
    kind: "permission",
    title: "Copilot requests permission",
    details: reviewable ? details :
      `Approval is unavailable. Original details are hidden.\n${blockedReasons.map((reason) => permissionBlockReasons[reason]).join("\n")}\n` +
      (canRecover
        ? "Deny and request safe recovery to reuse existing reviewed tests and helpers in this same job. The rejected operation will not be approved or replayed."
        : "Deny this operation. Complete human sign-in or resolve the underlying policy/prerequisite before retrying; no restriction can be overridden here."),
    canApprove: reviewable,
    canUseFileTrust,
    reviewCharacters: details.length,
    ...(blockedReasons.length ? { blockedReasons } : {}),
    ...(canRecover ? { canRecover: true } : {}),
    choices: [],
    allowFreeform: false
  };
}

export function runtimeQuestionPrompt(request) {
  const choices = request?.choices ?? [];
  if (!safeRuntimeText(request?.question, 4000) ||
      requestsCredentials(request.question) ||
      !Array.isArray(choices) || choices.length > 20 ||
      choices.some((choice) => !safeRuntimeText(choice, 1000) || requestsCredentials(choice))) {
    throw new Error("Copilot requested sensitive, unsupported or oversized input. Complete authentication in the normal browser; never enter credentials in FixLab.");
  }
  if (choices.length === 0 && request.allowFreeform === false) {
    throw new Error("Copilot supplied a question without an available answer.");
  }
  return {
    kind: "question",
    title: "Copilot needs your input",
    details: request.question,
    choices,
    allowFreeform: request.allowFreeform !== false,
    canApprove: false
  };
}

export function runtimeConversationQuestion(request) {
  const canAnswer = request.kind === "question" &&
    [request.title, request.details, ...request.choices].every((value) =>
      safeRuntimeText(value, 4000) && !requestsCredentials(value) && !/https?:\/\//i.test(value));
  if (canAnswer) {
    return {
      kind: "runtime-question",
      requestId: request.id,
      message: request.details,
      choices: [...request.choices],
      allowFreeform: request.allowFreeform,
      responseChannel: "conversation",
      actions: ["answer"]
    };
  }
  const reasons = (request.blockedReasons ?? []).map((reason) => permissionBlockReasons[reason]).filter(Boolean);
  return {
    kind: "runtime-input",
    requestId: request.id,
    message: request.kind === "question"
      ? "Copilot is waiting for input containing details reserved for the dashboard. Review and answer the exact question in its browser panel; no answer or approval is inferred."
      : `Copilot is waiting for a native permission decision in the dashboard's browser panel. ${reasons.join(" ")} ${
        request.canRecover === true
          ? "Deny and request safe recovery is available there; it denies this operation without granting access or replaying it."
          : "Review the exact request there; connected conversation replies cannot grant runtime permissions."
      }`,
    ...(reasons.length ? { blockedReasons: [...request.blockedReasons] } : {}),
    canRecover: request.canRecover === true,
    responseChannel: "dashboard",
    actions: []
  };
}

export function createRuntimeRequestBridge({ send, onChange }) {
  const pending = new Map();
  const publish = () => onChange([...pending.values()]);
  return {
    receive(value) {
      if (pending.size >= MAX_RUNTIME_REQUESTS ||
          typeof value?.id !== "string" ||
          !/^[a-f0-9-]{36}$/.test(value.id) || pending.has(value.id) ||
          !["permission", "question"].includes(value.kind) ||
          !safeRuntimeText(value.title, 200) || !safeRuntimeText(value.details) ||
          !Array.isArray(value.choices) || value.choices.length > 20 ||
          value.choices.some((choice) => !safeRuntimeText(choice, 1000)) ||
          (value.kind === "question" &&
            [value.title, value.details, ...value.choices].some((text) => requestsCredentials(text))) ||
          typeof value.canApprove !== "boolean" ||
          typeof value.allowFreeform !== "boolean" ||
          (value.perAction !== undefined &&
            (value.perAction !== true || value.kind !== "permission" || !value.canApprove ||
              value.canAllowAll === true || value.grantScope !== undefined)) ||
          (value.blockedReasons !== undefined &&
            (value.kind !== "permission" || value.canApprove ||
              !Array.isArray(value.blockedReasons) || !value.blockedReasons.length ||
              value.blockedReasons.length > Object.keys(permissionBlockReasons).length ||
              new Set(value.blockedReasons).size !== value.blockedReasons.length ||
              value.blockedReasons.some((reason) => !Object.hasOwn(permissionBlockReasons, reason)))) ||
          (value.canRecover !== undefined &&
            (value.canRecover !== true || value.kind !== "permission" ||
              value.canApprove || !value.blockedReasons?.length)) ||
          (value.sourceEditReview !== undefined &&
            (!value.sourceEditReview || value.kind !== "permission" || value.canApprove || value.canRecover !== true ||
              value.blockedReasons?.length !== 1 || value.blockedReasons[0] !== "oversized" ||
              Object.keys(value.sourceEditReview ?? {}).some((key) =>
                !["fileName", "reviewCharacters"].includes(key)))) ||
          (value.canAllowAll !== undefined &&
            (typeof value.canAllowAll !== "boolean" ||
              (value.canAllowAll && (value.kind !== "permission" || !value.canApprove)))) ||
          (value.grantScope !== undefined &&
            (!value.canApprove || value.kind !== "permission" ||
              !["repository-reads", "exact-test-command", "publication-batch"].includes(value.grantScope)))) {
        throw new Error("Copilot sent an invalid or excessive runtime request.");
      }
      pending.set(value.id, {
        id: value.id,
        kind: value.kind,
        title: value.title,
        details: value.details,
        choices: [...value.choices],
        canApprove: value.canApprove,
        allowFreeform: value.allowFreeform,
        ...(value.perAction === true ? { perAction: true } : {}),
        ...(value.blockedReasons ? { blockedReasons: [...value.blockedReasons] } : {}),
        ...(value.canRecover === true ? { canRecover: true } : {}),
        ...(value.sourceEditReview ? { sourceEditReview: validateSourceEditReview(value.sourceEditReview) } : {}),
        ...(value.canAllowAll === true ? { canAllowAll: true } : {}),
        ...(value.grantScope ? { grantScope: value.grantScope } : {})
      });
      publish();
    },
    respond(id, response) {
      const request = pending.get(id);
      if (!request) {
        throw new Error("The runtime request is stale or was already answered.");
      }
      const { action, choice, answer } = response;
      let result = { type: "response", id, action };
      if (response.recover !== undefined) {
        if (response.recover !== true || action !== "deny" || request.canRecover !== true) {
          throw new Error("Guided recovery is not available for this request.");
        }
        result.recover = true;
      }
      if (response.scope !== undefined) {
        if (action !== "allow" || (response.scope === "all-tools"
          ? request.canAllowAll !== true
          : !request.grantScope || response.scope !== request.grantScope)) {
          throw new Error("This job-scoped permission decision is not available.");
        }
        result.scope = response.scope;
      }
      if (request.kind === "permission") {
        if (!["allow", "deny"].includes(action) ||
            (action === "allow" && !request.canApprove)) {
          throw new Error("This permission decision is not available.");
        }
      } else if (action === "answer") {
        if (Number.isInteger(choice) && choice >= 0 &&
            choice < request.choices.length) {
          result = { ...result, answer: request.choices[choice], wasFreeform: false };
        } else if (choice === undefined && request.allowFreeform &&
            safeRuntimeText(answer, 4000) && answer.trim() &&
            !credentialValue.test(answer)) {
          result = { ...result, answer, wasFreeform: true };
        } else {
          throw new Error("Select an available choice or supply a non-sensitive answer.");
        }
      } else if (action !== "cancel") {
        throw new Error("This question decision is not available.");
      }
      send(result);
      pending.delete(id);
      publish();
    },
    cancel(notify = true) {
      if (notify) {
        for (const id of pending.keys()) {
          send({ type: "response", id, action: "cancel" });
        }
      }
      pending.clear();
      publish();
    }
  };
}

export function runtimeRequestId() {
  return randomUUID();
}
