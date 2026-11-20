import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJobMonitor, notificationPrompt } from "../mcp/job-monitor.js";
import { attachNotifications } from "../mcp/notification-extension.js";
import { installNotifications } from "../bin/notifications.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

function fixture(overrides = {}) {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), "fixlab-watch-")));
  const binding = { repository, port: 4317, instanceId: "instance-a", jobId: "job-a", confirmed: true };
  const state = {
    instanceId: binding.instanceId, repository, controlProtocol: 1,
    job: { id: binding.jobId, status: "running", stages: {}, permissionRequest: null },
    question: null, workspaceReview: null
  };
  const timers = [];
  const events = [];
  const errors = [];
  let reads = 0;
  const monitor = createJobMonitor({
    readState: async () => { reads += 1; return structuredClone(state); },
    notify: async (event) => { events.push(event); },
    onError: async (message) => { errors.push(message); },
    setTimer(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cancelled = true; },
    ...overrides
  });
  return {
    binding, state, events, errors, monitor,
    reads: () => reads,
    async tick() {
      let timer = timers.shift();
      while (timer?.cancelled) {
        timer = timers.shift();
      }
      assert.ok(timer, "an active poll should be scheduled");
      await timer.callback();
    },
    close() { monitor.stop(); rmSync(repository, { recursive: true, force: true }); }
  };
}

test("unchanged running jobs are polled locally without model notifications", async () => {
  const f = fixture();
  try {
    await f.monitor.start(f.binding);
    for (let index = 0; index < 100; index += 1) {
      await f.tick();
    }
    assert.equal(f.reads(), 101);
    assert.equal(f.events.length, 0);
    assert.equal(f.monitor.status().active, true);
    await f.monitor.start(f.binding);
    assert.equal(f.reads(), 101, "starting the same active watch is idempotent");
  } finally {
    f.close();
  }
});

test("blockers are deduplicated, changed blockers notify, and an observed resume re-arms the same question", async () => {
  const f = fixture();
  try {
    await f.monitor.start(f.binding);
    f.state.job.status = "blocked";
    f.state.question = { kind: "recovery", message: "Approval required.", actions: ["continue"] };
    await f.tick();
    await f.tick();
    assert.equal(f.events.length, 1);
    f.state.question.message = "A different prerequisite is required.";
    await f.tick();
    assert.equal(f.events.length, 2);
    f.state.job.status = "running";
    f.state.question = null;
    await f.tick();
    f.state.job.status = "blocked";
    f.state.question = { kind: "recovery", message: "A different prerequisite is required.", actions: ["continue"] };
    await f.tick();
    assert.equal(f.events.length, 3);
    assert.equal(f.events[0].kind, "action-required");
    assert.equal(f.events[0].jobId, f.binding.jobId);
    assert.doesNotMatch(JSON.stringify(f.events), /Approval required|different prerequisite/);
  } finally {
    f.close();
  }
});

test("permission events wait for safe review and distinguish fresh request nonces", async () => {
  const f = fixture();
  try {
    await f.monitor.start(f.binding);
    f.state.job.status = "blocked";
    f.state.job.permissionRequest = { id: "nonce-a", kind: "unclassified" };
    f.state.job.canReviewPermissions = false;
    f.state.question = { kind: "permission", message: "Review permission.", actions: [] };
    await f.tick();
    assert.equal(f.events.length, 0);
    f.state.job.canReviewPermissions = true;
    await f.tick();
    await f.tick();
    assert.equal(f.events.length, 1);
    f.state.job.permissionRequest.id = "nonce-b";
    await f.tick();
    assert.equal(f.events.length, 2);
    assert.equal(f.events[0].kind, "permission-required");
  } finally {
    f.close();
  }
});

for (const status of ["passed", "scoped-complete", "held", "cancelled"]) {
  test(`${status} sends one truthful event and stops local polling`, async () => {
    const f = fixture();
    try {
      await f.monitor.start(f.binding);
      f.state.job.status = status;
      await f.tick();
      assert.equal(f.events.length, 1);
      assert.equal(f.events[0].status, status);
      assert.equal(f.monitor.status().active, false);
    } finally {
      f.close();
    }
  });
}

for (const replacement of ["instance", "job", "no-job"]) {
  test(`a changed ${replacement} stops monitoring without attaching a replacement`, async () => {
    const f = fixture();
    try {
      await f.monitor.start(f.binding);
      if (replacement === "instance") {
        f.state.instanceId = "instance-b";
      } else if (replacement === "job") {
        f.state.job.id = "job-b";
      } else {
        f.state.job = null;
      }
      await f.tick();
      assert.equal(f.monitor.status().active, false);
      assert.equal(f.events[0].kind, "watch-ended");
      assert.equal(f.events[0].jobId, "job-a");
      assert.equal(f.events.length, 1);
    } finally {
      f.close();
    }
  });
}

test("starting requires consent and fresh identity, and cannot replace an active watch", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.monitor.start({ ...f.binding, confirmed: false }), /explicit user consent/);
    await assert.rejects(f.monitor.start({ ...f.binding, jobId: "stale-job" }), /current dashboard/);
    await f.monitor.start(f.binding);
    await assert.rejects(f.monitor.start({ ...f.binding, jobId: "other-job" }), /already watched/);
    assert.equal(f.events.length, 0);
  } finally {
    f.close();
  }
});

test("stop ignores late reads and never notifies for a replacement watch", async () => {
  let finish;
  let calls = 0;
  const f = fixture({
    readState: async () => {
      calls += 1;
      if (calls === 1) {
        return structuredClone(f.state);
      }
      return new Promise((resolve) => { finish = resolve; });
    }
  });
  try {
    await f.monitor.start(f.binding);
    const pending = f.tick();
    f.monitor.stop();
    finish({ ...f.state, question: { kind: "recovery" } });
    await pending;
    assert.equal(f.events.length, 0);
    assert.equal(f.monitor.status().active, false);
  } finally {
    f.close();
  }
});

test("a stop during initial admission cannot start a late watcher", async () => {
  let finish;
  const f = fixture({
    readState: () => new Promise((resolve) => { finish = resolve; })
  });
  try {
    const starting = f.monitor.start(f.binding);
    f.monitor.stop();
    finish(structuredClone(f.state));
    await assert.rejects(starting, /changed during startup/);
    assert.equal(f.monitor.status().active, false);
    assert.equal(f.events.length, 0);
  } finally {
    f.close();
  }
});

test("concurrent starts cannot replace the first successfully attached watcher", async () => {
  const reads = [];
  const f = fixture({
    readState: () => new Promise((resolve) => { reads.push(resolve); })
  });
  try {
    const first = f.monitor.start(f.binding);
    const second = f.monitor.start({ ...f.binding, jobId: "job-b" });
    reads[0](structuredClone(f.state));
    await first;
    reads[1]({ ...structuredClone(f.state), job: { ...f.state.job, id: "job-b" } });
    await assert.rejects(second, /changed during startup/);
    assert.equal(f.monitor.status().binding.jobId, f.binding.jobId);
  } finally {
    f.close();
  }
});

test("three failed status reads produce one connection event and stop rather than waking Copilot repeatedly", async () => {
  let calls = 0;
  const f = fixture({
    readState: async () => {
      calls += 1;
      if (calls === 1) {
        return structuredClone(f.state);
      }
      throw new Error("Local dashboard is unavailable.");
    }
  });
  try {
    await f.monitor.start(f.binding);
    await f.tick();
    await f.tick();
    assert.equal(f.events.length, 0);
    await f.tick();
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].kind, "connection-lost");
    assert.equal(f.errors.length, 1);
    assert.equal(f.monitor.status().active, false);
  } finally {
    f.close();
  }
});

test("an ambiguous notification delivery failure stops without automatic retries", async () => {
  let sends = 0;
  const f = fixture({
    notify: async () => { sends += 1; throw new Error("Host disconnected."); }
  });
  try {
    await f.monitor.start(f.binding);
    f.state.job.status = "blocked";
    await f.tick();
    assert.equal(sends, 1);
    assert.equal(f.errors.length, 1);
    assert.equal(f.monitor.status().active, false);
    assert.match(f.monitor.status().error, /without retrying/);
  } finally {
    f.close();
  }
});

test("status refresh revalidates identity and never exposes a replacement job as the watched job", async () => {
  const f = fixture();
  try {
    await f.monitor.start(f.binding);
    f.state.job.id = "replacement";
    await assert.rejects(f.monitor.refresh(), /changed/);
    assert.equal(f.monitor.status().active, false);
    assert.equal(f.monitor.status().conversation, null);
  } finally {
    f.close();
  }
});

test("Copilot extension wires real loopback status to one queued host event without approving anything", async () => {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), "fixlab-watch-host-")));
  const state = {
    instanceId: "live-instance", repository, controlProtocol: 1,
    job: { id: "live-job", status: "blocked", stages: {} },
    question: { kind: "recovery", message: "User decision required." }, workspaceReview: null
  };
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(state));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const sends = [];
  let tools;
  let shutdown;
  const monitor = await attachNotifications(async (options) => {
    tools = options.tools;
    return {
      async send(message) { sends.push(message); return "message-id"; },
      async log() {},
      on(type, handler) { assert.equal(type, "session.shutdown"); shutdown = handler; }
    };
  });
  try {
    assert.deepEqual(tools.map((tool) => tool.name), ["fixlab_watch_start", "fixlab_watch_status", "fixlab_watch_stop"]);
    const started = JSON.parse(await tools[0].handler({
      repository, port: server.address().port, instanceId: "live-instance", jobId: "live-job", confirmed: true
    }));
    assert.equal(started.active, true);
    for (let attempt = 0; attempt < 100 && sends.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(sends.length, 1);
    assert.equal(sends[0].mode, "enqueue");
    assert.match(sends[0].prompt, /NOT user authorization/);
    assert.doesNotMatch(sends[0].prompt, /User decision required/);
    const refreshed = JSON.parse(await tools[1].handler({}));
    assert.equal(refreshed.conversation.question.message, "User decision required.");
    assert.ok(requests.every((request) => request.method === "GET" && request.path === "/api/conversation"));
    shutdown();
    assert.equal(monitor.status().active, false);
    assert.equal(JSON.parse(await tools[2].handler({})).active, false);
    assert.match(notificationPrompt({ kind: "completed", status: "scoped-complete" }), /not full validation/);
  } finally {
    monitor.stop();
    await new Promise((resolve) => server.close(resolve));
    rmSync(repository, { recursive: true, force: true });
  }
});

function gitRepository() {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-watch-install-"));
  const result = spawnSync("git", ["init", "--quiet", repository], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return repository;
}

test("notification installation is plan-first, idempotent, package-bound and refuses to overwrite custom code", () => {
  const repository = gitRepository();
  try {
    const plan = installNotifications(repository, packageRoot);
    assert.equal(plan.status, "planned");
    assert.equal(existsSync(plan.destination), false);
    const installed = installNotifications(repository, packageRoot, true);
    assert.equal(installed.status, "installed");
    const content = readFileSync(installed.destination, "utf8");
    assert.match(content, /@microsoft\/copilot-sdk\/extension/);
    assert.match(content, /notification-extension\.js/);
    assert.doesNotMatch(content, /confirmed|watch_start/);
    assert.equal(installNotifications(repository, packageRoot, true).status, "already-installed");
    writeFileSync(installed.destination, "custom extension code");
    assert.throws(() => installNotifications(repository, packageRoot, true), /nothing was overwritten/);
    assert.equal(readFileSync(installed.destination, "utf8"), "custom extension code");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("notification installation rejects linked extension roots", () => {
  const repository = gitRepository();
  const outside = mkdtempSync(join(tmpdir(), "fixlab-watch-external-"));
  try {
    mkdirSync(join(repository, ".github"));
    symlinkSync(outside, join(repository, ".github", "extensions"), "junction");
    assert.throws(() => installNotifications(repository, packageRoot, true), /symbolic links or junctions/);
    assert.equal(existsSync(join(outside, "fixlab-notifications")), false);
  } finally {
    rmSync(repository, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("notification CLI resolves the Git root, plans without writes and rejects unknown options", () => {
  const repository = gitRepository();
  try {
    const nested = join(repository, "src");
    mkdirSync(nested);
    const plan = spawnSync(process.execPath, [join(packageRoot, "bin", "fixlab.js"), "notifications", nested], {
      encoding: "utf8", windowsHide: true
    });
    assert.equal(plan.status, 0, plan.stderr);
    const result = JSON.parse(plan.stdout);
    assert.equal(dirname(result.destination), join(realpathSync(repository), ".github", "extensions", "fixlab-notifications"));
    assert.equal(existsSync(result.destination), false);
    const invalid = spawnSync(process.execPath, [join(packageRoot, "bin", "fixlab.js"), "notifications", repository, "--allow-all"], {
      encoding: "utf8", windowsHide: true
    });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Usage: fixlab notifications/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
