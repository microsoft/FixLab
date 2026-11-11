import { clearLine, createInterface, cursorTo } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import { runtimeConversationQuestion } from "./runtime-requests.js";

const DEFAULT_LOG_COUNT = 20;
const MAX_LOG_COUNT = 100;

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(Number(milliseconds ?? 0) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0
    ? `${minutes}m ${remainingSeconds}s`
    : `${minutes}m`;
}

export function formatChatHelp() {
  return `Commands:
  /status              Show the current job and stage state.
  /logs [count]        Show the most recent logs (default ${DEFAULT_LOG_COUNT}).
  /evidence            List Playwright screenshots and videos.
  /pr                  Show pull-request readiness and known PR links.
  /retry [guidance]    Retry a failed or blocked job.
  /continue [guidance] Continue a blocked or completed job.
  /skip [reason]       Resume while recording an explicitly skipped gate.
  /manual-pass         Confirm that manual React localhost validation passed.
  /manual-fail         Confirm that manual React localhost validation failed.
  /new-bug <details>   Start or queue a separate bug-fix job.
  /cancel-job <id|#>   Remove a waiting job by ID or queue position.
  /stop                Stop the owned executor and leave the job resumable.
  /help                Show these commands.
  /exit                Leave chat without stopping the job.

Any other text is sent to the same FixLab session as a comment while it is
running, or as continue guidance while it is blocked, failed, or completed.`;
}

export function parseNaturalChatCommand(line) {
  const normalized = line.trim();
  const lower = normalized.toLowerCase();
  if (/^(?:open|show|start)(?: the)? dashboard$/u.test(lower)) {
    return { command: "/dashboard", details: "" };
  }
  if (/^(?:show|check|get)(?: the)? status$/u.test(lower)) {
    return { command: "/status", details: "" };
  }
  const logs = lower.match(
    /^(?:show|view|tail)(?: the)? logs(?:\s+(\d+))?$/u
  );
  if (logs) {
    return { command: "/logs", details: logs[1] ?? "" };
  }
  if (
    /^(?:show|open|check)(?: the)? (?:pr|pull request)$/u.test(lower)
  ) {
    return { command: "/pr", details: "" };
  }
  if (
    /^(?:show|list|open)(?: the)? (?:evidence|screenshots|playwright evidence)$/u.test(
      lower
    )
  ) {
    return { command: "/evidence", details: "" };
  }
  const repository = normalized.match(
    /^(?:switch|change)(?: the)? repo(?:sitory)?(?:\s+to)?(?:\s+(.+))?$/iu
  );
  if (repository) {
    return {
      command: "/repository",
      details: repository[1]?.trim() ?? ""
    };
  }
  if (/^(?:help|show help|what can i do)\??$/u.test(lower)) {
    return { command: "/help", details: "" };
  }
  if (/^(?:manual test|localhost test|react test) passed$/u.test(lower)) {
    return { command: "/manual-pass", details: "" };
  }
  if (/^(?:manual test|localhost test|react test) failed$/u.test(lower)) {
    return { command: "/manual-fail", details: "" };
  }
  const newBug = normalized.match(
    /^(?:new|add|create)(?: a)? bug(?::|\s+)(.+)$/iu
  );
  if (newBug) {
    return { command: "/new-bug", details: newBug[1].trim() };
  }
  const cancelJob = normalized.match(
    /^(?:cancel|remove)(?:\s+(?:queued|waiting))?(?:\s+job)?\s+#?([a-z0-9-]+)(?:\s+from(?:\s+the)?\s+queue)?$/iu
  );
  if (cancelJob) {
    return { command: "/cancel-job", details: cancelJob[1].trim() };
  }
  return null;
}

export function formatJobStatus(job) {
  if (!job) {
    return "No FixLab job is available.";
  }
  const lines = [
    `Job ${job.id}: ${job.executionState ?? job.status} (${formatDuration(job.durationMs)})`,
    `Request: ${job.request}`,
    `PR readiness: ${job.pullRequestReadiness?.message ?? "unknown"}`
  ];
  if (job.runtimeRequests?.length) {
    const question = runtimeConversationQuestion(job.runtimeRequests[0]);
    lines.push(`Action needed: ${question.message}`,
      "Review the live request in the dashboard browser panel; comments and retry commands cannot answer or approve it.");
  }
  for (const [stage, result] of Object.entries(job.stages ?? {})) {
    lines.push(
      `  ${stage}: ${result.status}${result.message ? ` - ${result.message}` : ""}`
    );
  }
  if (job.error) {
    lines.push(`Error: ${job.error}`);
  }
  return lines.join("\n");
}

function pullRequestSummary(job) {
  if (!job) {
    return "No FixLab job is available.";
  }
  const text = [
    job.stages?.pr?.message,
    job.pullRequestReadiness?.message,
    ...(job.activity ?? []).map((entry) => entry.message),
    ...(job.logs ?? []).map((entry) => entry.message)
  ]
    .filter(Boolean)
    .join("\n");
  const urls = [
    ...new Set(
      text.match(
        /https:\/\/(?:dev\.azure\.com|github\.com)\/[^\s<>"')\]]+/gi
      ) ?? []
    )
  ];
  return [
    `PR stage: ${job.stages?.pr?.status ?? "unknown"}${
      job.stages?.pr?.message ? ` - ${job.stages.pr.message}` : ""
    }`,
    `Readiness: ${job.pullRequestReadiness?.message ?? "unknown"}`,
    ...(urls.length > 0 ? urls : ["No PR URL has been reported yet."])
  ].join("\n");
}

async function requestJson(fetchImpl, url, options) {
  const response = await fetchImpl(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error ?? `Request failed with HTTP ${response.status}`);
  }
  return body;
}

export async function runChat({
  baseUrl,
  model = "",
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  fetchImpl = globalThis.fetch,
  pollIntervalMs = 1000,
  recoverConnection,
  selectRepository,
  switchRepository,
  openDashboard
}) {
  let dashboardUrl = baseUrl;
  let currentJob = null;
  let currentReadiness = null;
  let lastJobId = null;
  let lastLogIndex = -1;
  let lastStatus = "";
  let closed = false;
  let polling = false;
  let interactive = false;
  let handlingLine = false;
  let readline;
  let lastPollingError = "";
  const pendingMessages = [];
  const writeMessages = (messages) => {
    const safeMessages = messages.map(({ stream, message }) => ({
      stream,
      message: stripVTControlCharacters(String(message)).replace(/\r/g, "")
    }));
    if (safeMessages.length === 0) {
      return;
    }
    if (interactive && readline && !handlingLine && !closed) {
      if (readline.line) {
        pendingMessages.push(...safeMessages);
        return;
      }
      clearLine(output, 0);
      cursorTo(output, 0);
      for (const { stream, message } of safeMessages) {
        stream.write(`${message}\n`);
      }
      readline.prompt(true);
      return;
    }
    for (const { stream, message } of safeMessages) {
      stream.write(`${message}\n`);
    }
  };
  const writeMessage = (stream, message = "") =>
    writeMessages([{ stream, message }]);
  const write = (message = "") => writeMessage(output, message);
  const writeError = (message) => writeMessage(errorOutput, message);
  const flushPendingMessages = () => {
    if (pendingMessages.length === 0) {
      return;
    }
    clearLine(output, 0);
    cursorTo(output, 0);
    for (const { stream, message } of pendingMessages.splice(0)) {
      stream.write(`${message}\n`);
    }
  };

  const loadStatus = async ({ announce = false } = {}) => {
    const body = await requestJson(fetchImpl, `${dashboardUrl}/api/status`);
    const messages = [];
    const announceMessage = (message) => messages.push({ stream: output, message });
    currentJob = body.job;
    currentReadiness = body.readiness ?? null;
    if (!currentJob) {
      if (announce) {
        announceMessage("No FixLab job is available. Start one in the dashboard first.");
      }
      writeMessages(messages);
      return null;
    }
    if (currentJob.id !== lastJobId) {
      lastJobId = currentJob.id;
      lastLogIndex = Math.max(
        -1,
        ...(currentJob.logs ?? []).map((entry) => Number(entry.index))
      );
      lastStatus = currentJob.executionState ?? currentJob.status;
      announceMessage(formatJobStatus(currentJob));
      writeMessages(messages);
      return currentJob;
    }
    for (const entry of currentJob.logs ?? []) {
      if (Number(entry.index) <= lastLogIndex) {
        continue;
      }
      lastLogIndex = Number(entry.index);
      const message = stripVTControlCharacters(entry.message ?? "").replace(/\r/g, "");
      if (message.trim()) {
        announceMessage(`[${entry.stream}] ${message}`);
      }
    }
    const executionState = currentJob.executionState ?? currentJob.status;
    if (executionState !== lastStatus) {
      announceMessage(`[status] ${lastStatus} -> ${executionState}`);
      lastStatus = executionState;
      if (currentJob.runtimeRequests?.length) {
        announceMessage(formatJobStatus(currentJob));
      }
    }
    if (announce) {
      announceMessage(formatJobStatus(currentJob));
    }
    writeMessages(messages);
    return currentJob;
  };

  const submitInput = async (action, details) => {
    const body = await requestJson(fetchImpl, `${dashboardUrl}/api/job/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, details })
    });
    currentJob = body.job;
    write(
      body.queued
        ? "Guidance queued for the same session after the current agent turn."
        : "Guidance accepted; the same FixLab session is resuming."
    );
  };

  const submitNewBug = async (details) => {
    const body = await requestJson(fetchImpl, `${dashboardUrl}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: details,
        ...(model ? { model } : {}),
        mode: "fix-and-validate",
        requestType: "bug-fix",
        pullRequestStrategy: "common",
        runAllUiScenarios: false,
        recordPlaywrightVideo: false,
        manualLocalhostTest: false
      })
    });
    currentJob = body.job;
    const queuedJob = (body.queue ?? []).find(
      (job) => job.request === details
    );
    write(
      queuedJob
        ? `New bug queued as job ${queuedJob.id}.`
        : `New bug started as job ${body.job?.id ?? "unknown"}.`
    );
  };
  const cancelQueuedJob = async (selector) => {
    const position = Number.parseInt(selector, 10);
    const body = await requestJson(
      fetchImpl,
      `${dashboardUrl}/api/jobs/cancel`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          /^\d+$/u.test(selector)
            ? { position }
            : { jobId: selector }
        )
      }
    );
    currentJob = body.job;
    write(
      `Cancelled queued job ${body.cancelledJob.id}. ${body.queue.length} job(s) waiting.`
    );
  };

  try {
    await loadStatus();
  } catch (error) {
    if (recoverConnection) {
      try {
        dashboardUrl =
          (await recoverConnection({ baseUrl: dashboardUrl, error })) ??
          dashboardUrl;
        await loadStatus();
      } catch (recoveryError) {
        writeError(
          `Cannot connect to the FixLab dashboard at ${dashboardUrl}: ${recoveryError.message}`
        );
        return 1;
      }
    } else {
      writeError(
        `Cannot connect to the FixLab dashboard at ${dashboardUrl}: ${error.message}`
      );
      return 1;
    }
  }

  if (selectRepository) {
    try {
      const selectedUrl = await selectRepository({
        baseUrl: dashboardUrl,
        readiness: currentReadiness
      });
      if (selectedUrl && selectedUrl !== dashboardUrl) {
        dashboardUrl = selectedUrl;
        currentJob = null;
        currentReadiness = null;
        lastJobId = null;
        lastLogIndex = -1;
        lastStatus = "";
        await loadStatus();
      }
    } catch (error) {
      writeError(`Cannot select the FixLab repository: ${error.message}`);
      return 1;
    }
  }

  if (currentReadiness?.repository) {
    write(`FixLab repository: ${currentReadiness.repository}`);
  }
  write("FixLab chat is connected. Type /help for commands.");
  interactive = Boolean(input.isTTY && output.isTTY);
  readline = createInterface({
    input,
    output: interactive ? output : undefined,
    terminal: interactive,
    prompt: "fixlab> "
  });

  const poll = async () => {
    if (
      closed ||
      polling ||
      handlingLine ||
      (interactive && Boolean(readline?.line))
    ) {
      return;
    }
    polling = true;
    try {
      await loadStatus();
      if (lastPollingError) {
        write("Dashboard connection restored.");
        lastPollingError = "";
      }
    } catch (error) {
      if (error.message !== lastPollingError) {
        writeError(`Dashboard polling failed: ${error.message}`);
        lastPollingError = error.message;
      }
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(poll, pollIntervalMs);
  timer.unref?.();

  const handleLine = async (rawLine) => {
    const line = rawLine.trim();
    if (!line) {
      return;
    }
    const naturalCommand = parseNaturalChatCommand(line);
    const [typedCommand, ...remainder] = line.split(/\s+/);
    const command = naturalCommand?.command ?? typedCommand;
    const details =
      naturalCommand?.details ?? remainder.join(" ").trim();
    if (command === "/help") {
      write(formatChatHelp());
      return;
    }
    if (command === "/exit" || command === "/quit") {
      readline.close();
      return;
    }
    if (command === "/status") {
      await loadStatus({ announce: true });
      return;
    }
    if (command === "/dashboard") {
      if (openDashboard) {
        await openDashboard({ baseUrl: dashboardUrl });
        write(`Opened FixLab dashboard: ${dashboardUrl}`);
      } else {
        write(`FixLab dashboard: ${dashboardUrl}`);
      }
      return;
    }
    if (command === "/new-bug") {
      if (!details) {
        write("Describe the bug after /new-bug or type: new bug <details>");
        return;
      }
      await submitNewBug(details);
      return;
    }
    if (command === "/cancel-job") {
      if (!details) {
        write(
          "Provide a queued job ID or position, for example: /cancel-job 2"
        );
        return;
      }
      await cancelQueuedJob(details.replace(/^#/u, ""));
      return;
    }
    if (command === "/repository") {
      if (!switchRepository) {
        write("Repository switching is unavailable in this FixLab chat.");
        return;
      }
      const selectedUrl = await switchRepository({
        baseUrl: dashboardUrl,
        readiness: currentReadiness,
        repository: details
      });
      if (selectedUrl && selectedUrl !== dashboardUrl) {
        dashboardUrl = selectedUrl;
        currentJob = null;
        currentReadiness = null;
        lastJobId = null;
        lastLogIndex = -1;
        lastStatus = "";
        await loadStatus();
      }
      if (currentReadiness?.repository) {
        write(`FixLab repository: ${currentReadiness.repository}`);
      }
      return;
    }
    if (command === "/logs") {
      await loadStatus();
      const requested = Number.parseInt(details, 10);
      const count = Number.isInteger(requested)
        ? Math.min(MAX_LOG_COUNT, Math.max(1, requested))
        : DEFAULT_LOG_COUNT;
      for (const entry of (currentJob?.logs ?? []).slice(-count)) {
        write(`[${entry.stream}] ${entry.message}`);
      }
      return;
    }
    if (command === "/evidence") {
      if (!currentJob) {
        write("No FixLab job is available.");
        return;
      }
      const body = await requestJson(
        fetchImpl,
        `${dashboardUrl}/api/playwright/artifacts?jobId=${encodeURIComponent(
          currentJob.id
        )}`
      );
      if (body.artifacts.length === 0) {
        write("No Playwright evidence is available yet.");
        return;
      }
      for (const artifact of body.artifacts) {
        write(`${artifact.kind}: ${artifact.relativePath} (${artifact.url})`);
      }
      return;
    }
    if (command === "/pr") {
      await loadStatus();
      write(pullRequestSummary(currentJob));
      return;
    }
    if (command === "/stop") {
      await requestJson(fetchImpl, `${dashboardUrl}/api/job/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      write("Stop requested for the FixLab-owned executor.");
      return;
    }
    if (["/retry", "/continue", "/skip"].includes(command)) {
      await submitInput(
        command.slice(1),
        details || `${command.slice(1)} requested from FixLab chat`
      );
      return;
    }
    if (["/manual-pass", "/manual-fail"].includes(command)) {
      await submitInput(
        command.slice(1),
        command === "/manual-pass"
          ? "Manual React localhost validation passed."
          : "Manual React localhost validation failed."
      );
      return;
    }
    await loadStatus();
    if (currentJob?.manualLocalhostPending) {
      write(
        "Manual React localhost validation is pending. Use /manual-pass or /manual-fail."
      );
      return;
    }
    await submitInput(
      currentJob?.status === "running" ? "comment" : "continue",
      line
    );
  };

  let lineQueue = Promise.resolve();
  readline.on("line", (line) => {
    lineQueue = lineQueue
      .then(async () => {
        handlingLine = true;
        try {
          await handleLine(line);
        } finally {
          handlingLine = false;
        }
      })
      .catch((error) => writeError(error.message))
      .finally(() => {
        if (!closed && interactive) {
          flushPendingMessages();
          readline.prompt();
        }
      });
  });

  if (interactive) {
    readline.prompt();
  }
  await new Promise((resolve) => readline.once("close", resolve));
  closed = true;
  clearInterval(timer);
  await lineQueue;
  write("FixLab chat disconnected. The dashboard job continues.");
  return 0;
}
