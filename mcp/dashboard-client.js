import { request } from "node:http";
import { realpathSync } from "node:fs";
import { conversationOperations } from "../dashboard/conversation-operations.js";
import { canonicalExecutionRepository } from "../dashboard/executor-lease.js";

function dashboardRequest(port, path, body, { headers = {}, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const content = body === undefined ? undefined : JSON.stringify(body);
    const call = request({
      hostname: "127.0.0.1", port, path,
      method: content === undefined ? "GET" : "POST",
      headers: content === undefined ? headers : {
        ...headers,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(content)
      }
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 128 * 1024) {
          call.destroy(new Error("Dashboard response exceeded 128 KiB."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (response.statusCode < 200 || response.statusCode >= 300) {
            throw new Error(result.error ?? `Dashboard returned HTTP ${response.statusCode}.`);
          }
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
    });
    call.on("error", reject);
    const timer = setTimeout(() => call.destroy(new Error("Dashboard request timed out; an accepted operation may still be running. Read status before retrying.")), timeoutMs);
    call.on("close", () => clearTimeout(timer));
    call.end(content);
  });
}

function validateConversation(result, repository) {
  if (!result || typeof result.instanceId !== "string" ||
      typeof result.repository !== "string" || realpathSync(result.repository) !== repository ||
      !Object.hasOwn(result, "question") || !Object.hasOwn(result, "workspaceReview") ||
      !(result.job === null || (typeof result.job?.id === "string" && typeof result.job.status === "string"))) {
    throw new Error("Invalid dashboard conversation or repository mismatch.");
  }
  return result;
}

export async function dashboardControl(args) {
  const operation = Object.hasOwn(conversationOperations, args.operation)
    ? conversationOperations[args.operation]
    : null;
  if (!operation) {
    throw new Error("Unknown dashboard operation; arbitrary URLs and shell commands are not supported.");
  }
  if (!args.parameters || typeof args.parameters !== "object" || Array.isArray(args.parameters) ||
      Buffer.byteLength(JSON.stringify(args.parameters)) > 64 * 1024) {
    throw new Error("Operation parameters must be a JSON object of at most 64 KiB.");
  }
  const current = await dashboardConversation(args);
  if (current.controlProtocol !== 1) {
    throw new Error("Update the FixLab dashboard before using identity-bound control operations.");
  }
  if (current.instanceId !== args.instanceId || (current.job?.id ?? null) !== args.jobId ||
      (operation.method === "POST" && args.confirmed !== true)) {
    throw new Error("Use current instance/job IDs and explicit user authorization for dashboard changes.");
  }
  const body = operation.method === "POST"
    ? { ...(args.operation === "job-start" ? { routineFileAccess: true } : {}),
      ...args.parameters, ...(operation.action ? { action: operation.action } : {}) }
    : undefined;
  if (args.operation === "job-start" && typeof args.parameters.targetEnvironment === "string" &&
      args.parameters.targetEnvironment.toLowerCase() === "ppe" &&
      args.parameters.allowPpeWrites === undefined && args.parameters.ppeWriteApprovalConfirmed !== false &&
      args.parameters.allowPostRequests !== true && !args.parameters.testMutationMode &&
      current.ppeWriteConfigured === true) {
    body.allowPpeWrites = true;
    body.ppeWriteApprovalConfirmed = true;
  }
  const path = args.operation === "metrics" && args.parameters.period
    ? `${operation.path}?period=${encodeURIComponent(args.parameters.period)}`
    : operation.path;
  const coordinator = args.operation === "job-start" ? current.sourceConnection : null;
  const result = await dashboardRequest(coordinator?.port ?? current.workspaceConnection?.port ?? args.port, path, body, {
    headers: {
      "x-fixlab-operation": args.operation,
      "x-fixlab-instance": coordinator?.instanceId ?? args.instanceId,
      "x-fixlab-job": coordinator?.jobId ?? args.jobId ?? "none",
      "x-fixlab-repository": encodeURIComponent(realpathSync(coordinator?.repository ?? current.repository)),
      "x-fixlab-confirmed": String(args.confirmed === true)
    },
    timeoutMs: ["validation-run", "job-start", "frontend-start"].includes(args.operation) ? 7260000 : 10000
  });
  const state = await dashboardConversation(args);
  const assignedStart = args.operation === "job-start" && result.job?.id === state.job?.id &&
    (state.sourceConnection?.instanceId ?? state.instanceId) === (coordinator?.instanceId ?? current.instanceId);
  if (state.instanceId !== args.instanceId && !assignedStart) {
    throw new Error("Dashboard instance changed after the operation; read status before taking further action.");
  }
  return { operation: args.operation, result, state };
}

export async function dashboardConversation(args, reply = false) {
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535 ||
      typeof args.repository !== "string" || !args.repository.trim()) {
    throw new Error("An explicit repository and loopback dashboard port (1-65535) are required.");
  }

  const repository = realpathSync(args.repository);
  let current = validateConversation(await dashboardRequest(args.port, "/api/conversation"), repository);
  const workspace = current.job?.workspace;
  if (workspace && workspace.jobId === current.job.id && workspace.repository !== current.repository) {
    const url = new URL(workspace.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
        url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
        canonicalExecutionRepository(workspace.repository).key !== canonicalExecutionRepository(repository).key) {
      throw new Error("Assigned workspace is not an owned loopback checkout in this repository.");
    }
    const assigned = validateConversation(await dashboardRequest(Number(url.port), "/api/conversation"),
      realpathSync(workspace.repository));
    if (assigned.job?.id !== current.job.id) { throw new Error("Assigned workspace changed jobs; read status before continuing."); }
    current = { ...assigned,
      sourceConnection: { port: args.port, repository, instanceId: current.instanceId, jobId: current.job.id },
      workspaceConnection: { port: Number(url.port), repository: assigned.repository } };
  }
  if (!reply) {
    return current;
  }
  if (args.confirmed !== true || current.instanceId !== args.instanceId ||
      !current.job || current.job.id !== args.jobId) {
    throw new Error("Reply requires the user's explicit answer and the current dashboard instance and job IDs. Read status again.");
  }
  if (!["comment", "continue", "retry", "skip", "manual-pass", "manual-fail"].includes(args.action) ||
      typeof args.details !== "string" || !args.details.trim() || args.details.length > 10000 ||
      (args.validationIntent !== undefined && !["scoped", "full", "affected"].includes(args.validationIntent))) {
    throw new Error("Provide a valid action, explicit answer (1-10000 characters), and scoped, full, or affected validation intent.");
  }
  const result = validateConversation(await dashboardRequest(current.workspaceConnection?.port ?? args.port, "/api/conversation/reply", {
    instanceId: args.instanceId, jobId: args.jobId, repository: current.repository,
    confirmed: true, action: args.action, details: args.details,
    validationIntent: args.validationIntent, reviewedWorkspace: args.reviewedWorkspace
  }), realpathSync(current.repository));
  if (result.instanceId !== args.instanceId || result.job?.id !== args.jobId) {
    throw new Error("Dashboard or job changed during the reply. Read status before continuing.");
  }
  return result;
}
