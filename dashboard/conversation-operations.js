export const conversationOperations = Object.freeze({
  "sessions": { method: "GET", path: "/api/sessions" },
  "metrics": { method: "GET", path: "/api/metrics" },
  "onboarding-status": { method: "GET", path: "/api/onboarding" },
  "frontend-status": { method: "GET", path: "/api/frontend/status" },
  "authentication-status": { method: "GET", path: "/api/playwright/status" },
  "job-start": { method: "POST", path: "/api/jobs" },
  "job-stop": { method: "POST", path: "/api/job/stop" },
  "job-dismiss": { method: "POST", path: "/api/job/dismiss" },
  "job-hold": { method: "POST", path: "/api/jobs/hold" },
  "job-resume": { method: "POST", path: "/api/jobs/resume" },
  "job-restart": { method: "POST", path: "/api/jobs/restart" },
  "queue-cancel": { method: "POST", path: "/api/jobs/cancel" },
  "history-purge": { method: "POST", path: "/api/history/purge" },
  "frontend-start": { method: "POST", path: "/api/frontend/start" },
  "frontend-stop": { method: "POST", path: "/api/frontend/stop" },
  "authentication-start": { method: "POST", path: "/api/playwright/connect" },
  "session-control": { method: "POST", path: "/api/sessions/control" },
  "permission-review": { method: "POST", path: "/api/job/permissions", action: "review-directory" },
  "permission-approve": { method: "POST", path: "/api/job/permissions", action: "approve-directory" },
  "validation-run": { method: "POST", path: "/api/validation/run" },
  "validation-select": { method: "POST", path: "/api/job/checks" },
  "onboarding-configure": { method: "POST", path: "/api/onboarding/azure-devops" },
  "work-items-load": { method: "POST", path: "/api/azure-devops/load" }
});

const resultKeys = new Set([
  "id", "jobId", "ownerId", "requestId", "status", "ready", "error", "message",
  "accepted", "started", "stopped", "queued", "running", "starting", "connected",
  "configured", "enabled", "available", "healthy", "owned", "lastResult", "pid", "canResume", "canComment",
  "canReviewPermissions", "job", "queuedJob", "resumedJob", "heldJob",
  "dismissedJob", "queue", "held", "history", "sessions", "frontend",
  "authentication", "permissionRequest", "kind", "scope", "directory", "preflight", "runtimeDirectoryGrants",
  "repositoryReady", "profileReady", "profileName", "checks", "ok", "detail",
  "name", "exists", "stages", "validation", "gates", "reason", "required", "outcome", "pullRequestReadiness",
  "intake", "diagnosis", "reproduce", "fix", "review", "local-stack", "live-test",
  "pr", "mode", "createdAt", "finishedAt", "lastActivityAt", "warning",
  "workItems", "workItem", "title", "state", "workItemType", "commentCount",
  "deletedCount", "purgedCount", "remainingCount", "period", "metrics",
  "total", "passed", "failed", "blocked", "cancelled", "heldCount", "queuedCount",
  "completed", "bugs", "averageDurationMs", "usageJobs", "totalInputTokens",
  "totalCachedInputTokens", "totalCacheWriteTokens", "totalOutputTokens",
  "averageCacheHitPercent", "inputTokenLimit", "budgetExceeded", "inputTokens", "fileAccess",
  "workflow", "publication", "unitTestsAfterPr", "optionalBuilds", "fullValidationPassed", "executionState"
]);

export function compactControlResult(value, depth = 0) {
  if (depth > 8) {
    return null;
  }
  if (typeof value === "string") {
    return value.replace(/https?:\/\/\S+/giu, "[omitted URL]").slice(0, 1000);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => compactControlResult(item, depth + 1));
  }
  return Object.fromEntries(Object.entries(value ?? {})
    .filter(([key]) => resultKeys.has(key))
    .map(([key, item]) => [key, compactControlResult(item, depth + 1)]));
}
