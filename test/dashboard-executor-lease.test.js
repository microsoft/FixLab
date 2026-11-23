import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExecutorLease, waitForExecutorLease } from "../dashboard/executor-lease.js";

function repository() {
  const path = mkdtempSync(join(tmpdir(), "fixlab-lease-"));
  const result = spawnSync("git", ["init", "--quiet", path]);
  assert.equal(result.status, 0);
  return path;
}

test("isolated worktrees execute concurrently while local testing waits and resumes after release", async () => {
  const path = repository();
  const worktree = `${path}-parallel`;
  try {
    assert.equal(spawnSync("git", ["-C", path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
      "commit", "--allow-empty", "--quiet", "-m", "fixture"]).status, 0);
    assert.equal(spawnSync("git", ["-C", path, "worktree", "add", "--quiet", "-b", "parallel", worktree]).status, 0);
    const first = createExecutorLease(path, randomUUID()).acquire("first-code-job");
    const second = createExecutorLease(worktree, randomUUID(), { worktree: true }).acquire("second-code-job");
    const testOwner = createExecutorLease(path, randomUUID(), { resource: "local-testing" });
    const waitingOwner = createExecutorLease(worktree, randomUUID(), { resource: "local-testing" });
    assert.equal(testOwner.scope.directory, waitingOwner.scope.directory);
    const testing = testOwner.acquire("first-test-job");
    let waiting = 0;
    let acquired = false;
    const next = waitForExecutorLease(waitingOwner, "second-test-job", {
      pollMs: 5, onWaiting() { waiting += 1; }
    }).then(lease => { acquired = true; return lease; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(waiting, 1);
    assert.equal(acquired, false);
    testing.release();
    (await next).release();
    second.release();
    first.release();
    assert.equal(existsSync(testOwner.scope.directory), false);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(path, { recursive: true, force: true });
  }
});

test("cancelling queued local testing leaves the active owner's reservation untouched", async () => {
  const path = repository();
  try {
    const owner = createExecutorLease(path, randomUUID(), { resource: "local-testing" });
    const held = owner.acquire("active");
    const controller = new AbortController();
    const waiting = waitForExecutorLease(owner, "waiting", { signal: controller.signal, pollMs: 5 });
    controller.abort();
    await assert.rejects(waiting, { name: "AbortError" });
    assert.throws(() => owner.acquire("third"), /lease is reserved/);
    held.release();
    assert.throws(() => createExecutorLease(path, randomUUID(), { worktree: true }), /linked Git worktree/);
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("executor lease admits exactly one barrier-synchronized cross-process contender", async () => {
  const path = repository();
  const evidence = join(path, "starts.txt");
  const fixture = new URL("../scripts/ci/fixtures/executor-lease-contender.mjs", import.meta.url);
  const workers = [
    fork(fixture, [path, evidence], { stdio: ["ignore", "ignore", "inherit", "ipc"] }),
    fork(fixture, [path, evidence], { stdio: ["ignore", "ignore", "inherit", "ipc"] })
  ];
  try {
    await Promise.all(workers.map((worker) => once(worker, "message")));
    const outcomes = workers.map((worker) => once(worker, "message"));
    for (const worker of workers) {
      worker.send({ start: true });
    }
    const results = (await Promise.all(outcomes)).map(([message]) => message);
    assert.equal(results.filter((result) => result.type === "acquired").length, 1);
    assert.equal(results.filter((result) => result.type === "reserved").length, 1);
    assert.equal(readFileSync(evidence, "utf8").trim().split("\n").length, 1);
    const winner = workers[results.findIndex((result) => result.type === "acquired")];
    const exited = once(winner, "exit");
    winner.send({ finish: true });
    await exited;
    const next = createExecutorLease(path, randomUUID()).acquire(randomUUID());
    next.release();
  } finally {
    for (const worker of workers) {
      if (worker.connected) {
        const exited = once(worker, "exit");
        worker.send({ finish: true });
        await exited;
      }
    }
    rmSync(path, { recursive: true, force: true });
  }
});

test("executor lease release is acquisition-scoped and stale callbacks cannot remove a successor", () => {
  const path = repository();
  try {
    const owner = createExecutorLease(path, randomUUID());
    const first = owner.acquire("first-job");
    first.update("stopping", 123);
    assert.throws(() => owner.acquire("other-job"), /lease is reserved/);
    first.release();
    const second = owner.acquire("second-job");
    first.release();
    assert.throws(() => owner.acquire("third-job"), /lease is reserved/);
    second.release();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("partial or crashed executor reservations fail closed without heartbeat or PID reclamation", () => {
  const path = repository();
  try {
    const owner = createExecutorLease(path, randomUUID());
    mkdirSync(owner.scope.directory, { recursive: true });
    assert.throws(() => owner.acquire("job"), /incomplete or unreadable/);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("linked worktrees share the canonical executor lease", () => {
  const path = repository();
  const worktree = `${path}-worktree`;
  try {
    const commit = spawnSync("git", [
      "-C", path, "-c", "user.name=FixLab test", "-c", "user.email=fixlab@example.invalid",
      "commit", "--allow-empty", "--quiet", "-m", "Fixture"
    ]);
    assert.equal(commit.status, 0);
    assert.equal(spawnSync("git", ["-C", path, "worktree", "add", "--quiet", "-b", "fixture", worktree]).status, 0);
    const first = createExecutorLease(path, randomUUID());
    const second = createExecutorLease(worktree, randomUUID());
    assert.equal(first.scope.key, second.scope.key);
    const held = first.acquire("main-job");
    assert.throws(() => second.acquire("worktree-job"), /lease is reserved/);
    held.release();
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(path, { recursive: true, force: true });
  }
});

test("an owner crash with a surviving executor cannot free the repository lease", async () => {
  const path = repository();
  const evidence = join(path, "crash-evidence");
  const fixture = new URL("../scripts/ci/fixtures/executor-lease-contender.mjs", import.meta.url);
  const worker = fork(fixture, [path, evidence], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  });
  let executorPid;
  try {
    await once(worker, "message");
    const acquired = once(worker, "message");
    worker.send({ start: true });
    assert.equal((await acquired)[0].type, "acquired");
    const orphaned = once(worker, "message");
    const exited = once(worker, "exit");
    worker.send({ crash: true });
    executorPid = (await orphaned)[0].pid;
    await exited;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if (readFileSync(`${evidence}.child`, "utf8").includes("active")) {
          break;
        }
      } catch (error) {
        assert.equal(error.code, "ENOENT");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(readFileSync(`${evidence}.child`, "utf8"), /active/);
    const contender = createExecutorLease(path, randomUUID());
    assert.throws(() => contender.acquire("after-owner-crash"), /lease is reserved/);
  } finally {
    if (executorPid) {
      if (process.platform === "win32") {
        assert.equal(spawnSync("powershell.exe", [
          "-NoProfile", "-NonInteractive", "-Command",
          `Stop-Process -Id ${executorPid} -Force -ErrorAction Stop`
        ], { windowsHide: true }).status, 0);
      } else {
        process.kill(executorPid, "SIGTERM");
      }
    }
    if (worker.connected) {
      const exited = once(worker, "exit");
      worker.send({ finish: true });
      await exited;
    }
    rmSync(path, { recursive: true, force: true });
  }
});
