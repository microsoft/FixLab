#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  statSync
} from "node:fs";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { dashboardControl, dashboardConversation } from "./dashboard-client.js";
import { conversationOperations } from "../dashboard/conversation-operations.js";

const protocolVersion = "2024-11-05";
const tools = [
  {
    name: "fixlab_inspect_repository",
    annotations: { readOnlyHint: true },
    description:
      "Inspect whether a repository has a parseable FixLab profile and summarize its configured validation surfaces.",
    inputSchema: {
      type: "object",
      properties: {
        repository: {
          type: "string",
          description: "Absolute or current-directory-relative repository path."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "fixlab_validation_commands",
    annotations: { readOnlyHint: true },
    description:
      "Read the repository-owned package scripts that participate in FixLab validation without executing them.",
    inputSchema: {
      type: "object",
      properties: {
        repository: {
          type: "string",
          description: "Absolute or current-directory-relative repository path."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "fixlab_dashboard_status",
    annotations: { readOnlyHint: true },
    description: "Read compact status, waiting state and any pending question from an existing loopback dashboard. Ask the user using the host's question UI; never assume approval. Safe live questions include a requestId for an explicit answer; native permissions and sensitive questions stay in the dashboard. Does not start or modify jobs.",
    inputSchema: {
      type: "object",
      properties: { repository: { type: "string" }, port: { type: "integer", minimum: 1, maximum: 65535 } },
      required: ["repository", "port"],
      additionalProperties: false
    }
  },
  {
    name: "fixlab_dashboard_reply",
    annotations: { readOnlyHint: false },
    description: "Submit the user's explicit answer to the exact dashboard instance and same job returned by status. For a live runtime-question with responseChannel=conversation, use action=answer, its requestId and the user's exact answer or offered choice as details; this continues the same executor without retrying. Never infer confirmed=true. For workspace reuse, review the diff with the user and send the approved branch/fingerprint. Cannot grant runtime permissions or bypass authentication or required gates. Read status again after conflicts.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        port: { type: "integer", minimum: 1, maximum: 65535 },
        instanceId: { type: "string" }, jobId: { type: "string" },
        confirmed: { type: "boolean", const: true },
        action: { type: "string", enum: ["answer", "comment", "continue", "retry", "skip", "manual-pass", "manual-fail"] },
        requestId: { type: "string", description: "Exact live question requestId from status, required only for action=answer." },
        details: { type: "string", minLength: 1, maxLength: 10000 },
        validationIntent: { type: "string", enum: ["scoped", "full", "affected"] },
        reviewedWorkspace: {
          type: "object",
          properties: { branch: { type: "string" }, fingerprint: { type: "string" } },
          required: ["branch", "fingerprint"],
          additionalProperties: false
        }
      },
      required: ["repository", "port", "instanceId", "jobId", "confirmed", "action", "details"],
      additionalProperties: false
    }
  },
  {
    name: "fixlab_dashboard_control",
    annotations: { readOnlyHint: false },
    description: "Run an existing FixLab dashboard operation authorized by the user: jobs/queue, configured gates, frontend, human authentication, scoped permissions, sessions and intake. Read status first and bind to its instance/job IDs (jobId=null when none). parameters uses that dashboard operation's existing JSON payload. confirmed=true represents actual user authorization, not permission to bypass normal guards. Prefer the dedicated reply tool for blocker answers. No arbitrary shell commands, URLs or credential access. A successful start is not evidence that validation passed.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        port: { type: "integer", minimum: 1, maximum: 65535 },
        instanceId: { type: "string" },
        jobId: { type: ["string", "null"] },
        operation: { type: "string", enum: Object.keys(conversationOperations) },
        parameters: { type: "object", additionalProperties: true },
        confirmed: { type: "boolean" }
      },
      required: ["repository", "port", "instanceId", "jobId", "operation", "parameters"],
      additionalProperties: false
    }
  }
];

function textResult(value, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ],
    isError
  };
}

function resolveRepository(value) {
  const repository = resolve(
    typeof value === "string" && value.trim() ? value : process.cwd()
  );
  if (!existsSync(repository) || !statSync(repository).isDirectory()) {
    throw new Error("repository does not exist or is not a directory");
  }
  return repository;
}

function inspectRepository(repositoryValue) {
  const repository = resolveRepository(repositoryValue);
  const profilePath = join(
    repository,
    ".github",
    "fixlab",
    "repository-profile.json"
  );
  if (!existsSync(profilePath)) {
    return {
      repository,
      profileReady: false,
      profilePath,
      error: "repository profile is missing; run fixlab init"
    };
  }

  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
  return {
    repository,
    profileReady: true,
    profilePath,
    name: profile.name ?? null,
    applicationNames: Object.keys(profile.applications ?? {}),
    environmentNames: Object.keys(profile.environments ?? {}),
    browserAutomationConfigured: Boolean(profile.browserAutomation),
    pullRequestPolicyConfigured: Boolean(profile.pullRequest)
  };
}

function validationCommands(repositoryValue) {
  const repository = resolveRepository(repositoryValue);
  const packagePath = join(repository, "package.json");
  if (!existsSync(packagePath)) {
    return {
      repository,
      packagePath,
      commands: {},
      error: "package.json is missing"
    };
  }
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  const scripts = packageJson.scripts ?? {};
  const names = [
    "lint",
    "format:check",
    "docs:check",
    "test",
    "test:ci",
    "pack:check",
    "validate"
  ];
  return {
    repository,
    packagePath,
    commands: Object.fromEntries(
      names.filter((name) => scripts[name]).map((name) => [name, scripts[name]])
    )
  };
}

async function toolCall(params = {}) {
  const repository = params.arguments?.repository;
  if (params.name === "fixlab_inspect_repository") {
    return textResult(inspectRepository(repository));
  }
  if (params.name === "fixlab_validation_commands") {
    return textResult(validationCommands(repository));
  }
  if (params.name === "fixlab_dashboard_status" || params.name === "fixlab_dashboard_reply") {
    return textResult(await dashboardConversation(params.arguments ?? {}, params.name === "fixlab_dashboard_reply"));
  }
  if (params.name === "fixlab_dashboard_control") {
    const result = await dashboardControl(params.arguments ?? {});
    return textResult(result, params.arguments.operation === "validation-run" && result.result.status !== 0);
  }
  throw new Error(`unknown tool: ${params.name ?? ""}`);
}

function response(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function errorResponse(id, error) {
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error)
      }
    })}\n`
  );
}

async function handleMessage(message) {
  if (message.method === "initialize") {
    response(message.id, {
      protocolVersion,
      capabilities: {
        tools: {
          listChanged: false
        }
      },
      serverInfo: {
        name: "fixlab",
        version: "0.5.1"
      }
    });
    return;
  }
  if (message.method === "ping") {
    response(message.id, {});
    return;
  }
  if (message.method === "tools/list") {
    response(message.id, { tools });
    return;
  }
  if (message.method === "tools/call") {
    response(message.id, await toolCall(message.params));
    return;
  }
  if (message.id !== undefined) {
    throw new Error(`unsupported method: ${message.method ?? ""}`);
  }
}

const input = createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

input.on("line", async (line) => {
  if (!line.trim()) {
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
    await handleMessage(message);
  } catch (error) {
    errorResponse(message?.id ?? null, error);
  }
});
