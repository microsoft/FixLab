import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionRegistry } from "../dashboard/sessions.js";
import { createExecutorLease } from "../dashboard/executor-lease.js";
import { recoverRepositorySessions, reviewSessionRecovery, sessionRecoveryContext } from "../dashboard/session-recovery.js";

test("session ownership rejects external URLs and arbitrary owner identifiers", async () => {
  const registry = createSessionRegistry(randomUUID());
  assert.throws(() => registry.register("https://example.com"), /invalid/);
  assert.throws(() => registry.register("http://127.0.0.1:4317/private"), /invalid/);
  await assert.rejects(registry.control("..\\other", {}), /invalid/);
});

test("session ownership refuses a reused port or another repository's live owner", async () => {
  const registry = createSessionRegistry(randomUUID());
  let session = { id: randomUUID(), scopeId: registry.scopeId };
  let controls = 0;
  const server = createServer((request, response) => {
    if (request.method === "POST") {
      controls += 1;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(session));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  registry.register(`http://127.0.0.1:${server.address().port}`);
  try {
    const owners = await registry.list();
    assert.equal(owners[0].available, false);
    await assert.rejects(registry.control(registry.id, {
      resource: "all", action: "shutdown", confirmed: true
    }), /no longer belongs/);
    session = { id: registry.id, scopeId: createSessionRegistry(randomUUID()).scopeId };
    await assert.rejects(registry.control(registry.id, {
      resource: "all", action: "shutdown", confirmed: true
    }), /no longer belongs/);
    assert.equal(controls, 0);
  } finally {
    registry.unregister();
    server.closeIdleConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("scoped checkout discovery waits for a slow live owner but still rejects a reused identity", async () => {
  const repository = join(tmpdir(), `fixlab-slow-owner-${randomUUID()}`);
  const registry = createSessionRegistry(repository);
  let delay = 2000;
  let id = registry.id;
  const server = createServer((_request, response) => {
    setTimeout(() => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ id, scopeId: registry.scopeId, repository }));
    }, delay);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  registry.register(`http://127.0.0.1:${server.address().port}`);
  try {
    const options = { scopeIds: [registry.scopeId], timeoutMs: 10000 };
    const catalog = await registry.repositories(options);
    assert.equal(catalog.unavailableCount, 0);
    assert.equal(catalog.repositories[0].id, registry.id);
    delay = 0;
    id = randomUUID();
    const replaced = await registry.repositories(options);
    assert.deepEqual(replaced.repositories, []);
    assert.equal(replaced.unavailableCount, 1);
  } finally {
    registry.unregister();
    server.closeIdleConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("owner discovery retries one disconnected read but never trusts a replacement or retries a control", async () => {
  const repository = join(tmpdir(), `fixlab-disconnected-owner-${randomUUID()}`);
  const registry = createSessionRegistry(repository);
  let reads = 0;
  let controls = 0;
  let mode = "recover";
  const server = createServer((request, response) => {
    if (request.method === "POST") {
      controls += 1;
      request.socket.destroy();
      return;
    }
    reads += 1;
    if (mode === "disconnected" || (mode !== "control" && mode !== "unavailable" && reads === 1)) {
      request.socket.destroy();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.statusCode = mode === "unavailable" ? 503 : 200;
    response.end(JSON.stringify({
      id: mode === "replacement" ? randomUUID() : registry.id,
      scopeId: registry.scopeId, repository
    }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  registry.register(`http://127.0.0.1:${server.address().port}`);
  try {
    const options = { scopeIds: [registry.scopeId] };
    const recovered = await registry.repositories(options);
    assert.equal(recovered.unavailableCount, 0);
    assert.equal(recovered.repositories[0].id, registry.id);
    assert.equal(reads, 2);
    for (const next of ["replacement", "disconnected", "unavailable"]) {
      mode = next;
      reads = 0;
      const rejected = await registry.repositories(options);
      assert.deepEqual(rejected.repositories, []);
      assert.equal(rejected.unavailableCount, 1);
      assert.equal(reads, next === "unavailable" ? 1 : 2);
    }
    mode = "control";
    await assert.rejects(registry.control(registry.id, {
      resource: "all", action: "shutdown", confirmed: true
    }));
    assert.equal(controls, 1);
  } finally {
    registry.unregister();
    server.closeIdleConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("repository catalog discovers verified local owners without starting or controlling jobs", async () => {
  const repositories = [join(tmpdir(), `fixlab-catalog-${randomUUID()}`),
    join(tmpdir(), `fixlab-catalog-${randomUUID()}`)];
  const registries = repositories.map((repository) => createSessionRegistry(repository));
  const servers = [];
  let controls = 0;
  let stale = false;
  try {
    for (const [index, registry] of registries.entries()) {
      const server = createServer((request, response) => {
        if (request.method !== "GET" || request.url !== "/api/session") {
          controls++;
        }
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          id: index === 1 && stale ? randomUUID() : registry.id,
          scopeId: registry.scopeId, repository: repositories[index],
          job: { status: "blocked" }
        }));
      });

      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      servers.push(server);
      registry.register(`http://127.0.0.1:${servers[index].address().port}`);
    }
    const catalog = await registries[0].repositories();
    for (const [index, registry] of registries.entries()) {
      assert.deepEqual(catalog.repositories.find((entry) => entry.id === registry.id), {
        id: registry.id, repository: repositories[index],
        url: `http://127.0.0.1:${servers[index].address().port}`, status: "blocked"
      });
    }
    stale = true;
    const refreshed = await registries[0].repositories();
    assert.equal(refreshed.repositories.some((entry) => entry.id === registries[1].id), false);
    assert.ok(refreshed.unavailableCount > 0);
    const scoped = await registries[0].repositories({ scopeIds: [registries[1].scopeId] });
    assert.deepEqual(scoped.repositories, []);
    assert.equal(scoped.unavailableCount, 1);
    const healthyScope = await registries[0].repositories({ scopeIds: [registries[0].scopeId] });
    assert.equal(healthyScope.repositories.length, 1);
    assert.equal(healthyScope.repositories[0].id, registries[0].id);
    assert.equal(healthyScope.unavailableCount, 0);
    assert.equal(controls, 0);
  } finally {
    for (const registry of registries.slice(0, servers.length)) {
      registry.unregister();
    }
    for (const server of servers) {
      server.closeIdleConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

async function closedLoopbackUrl() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  await new Promise(resolve => server.close(resolve));
  return url;
}

function recoveryRepository(t, git = false) {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-owner-recovery-"));
  if (git) {
    const result = spawnSync("git", ["init", "-q", repository], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }
  const context = sessionRecoveryContext(repository);
  t.after(() => {
    for (const scopeId of context.scopeIds) {
      rmSync(join(tmpdir(), "fixlab-dashboard-sessions", scopeId), { recursive: true, force: true });
    }
    rmSync(repository, { recursive: true, force: true });
  });
  return context;
}

async function legacyOwner(t, git = false) {
  const context = recoveryRepository(t, git);
  const directory = join(tmpdir(), "fixlab-dashboard-sessions", context.registry.scopeId);
  mkdirSync(directory, { recursive: true });
  const id = randomUUID();
  const record = { id, url: await closedLoopbackUrl() };
  const path = join(directory, `${id}.json`);
  const raw = JSON.stringify(record);
  writeFileSync(path, raw);
  return { ...context, id, path, raw };
}

function crashedDashboard(t, mode = "quiescent") {
  const context = recoveryRepository(t, mode === "reserved");
  const script = `
    import { once } from "node:events";
    import { request } from "node:http";
    import { createDashboardServer } from ${JSON.stringify(new URL("../dashboard/server.js", import.meta.url).href)};
    import { createExecutorLease } from ${JSON.stringify(new URL("../dashboard/executor-lease.js", import.meta.url).href)};
    const dashboard = createDashboardServer({ repository: process.argv[1], runtime: "copilot",
      packageRoot: ${JSON.stringify(fileURLToPath(new URL("..", import.meta.url)))} });
    const address = await dashboard.listen({ port: 0 });
    if (process.argv[2] === "reserved") {
      createExecutorLease(process.argv[1], "prior-owner").acquire("unfinished-executor");
    }
    if (process.argv[2] === "pending") {
      const pending = request(address.url + "/api/playwright/connect", {
        method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "100", Expect: "100-continue" }
      });
      pending.flushHeaders();
      await once(pending, "continue");
    }
    const response = await fetch(address.url + "/api/session");
    if (!response.ok) { throw new Error("Session checkpoint failed"); }
    process.stdout.write(JSON.stringify({ ...(await response.json()), url: address.url }));
    process.exit(0);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, context.repository, mode], {
    encoding: "utf8", windowsHide: true, timeout: 30000
  });
  assert.equal(result.status, 0, result.stderr);
  const session = JSON.parse(result.stdout);
  const path = join(tmpdir(), "fixlab-dashboard-sessions", session.scopeId, `${session.id}.json`);
  return { ...context, session, path, raw: readFileSync(path, "utf8") };
}

test("scoped discovery recovers a genuinely exited quiescent dashboard and retains its exact registration", async t => {
  const fixture = crashedDashboard(t);
  assert.equal(JSON.parse(fixture.raw).resources, "quiescent");
  const global = await fixture.registry.repositories();
  assert.equal(existsSync(fixture.path), true, "global discovery must not recover another scope");
  assert.ok(global.unavailableCount > 0);
  const result = await fixture.registry.repositories({ scopeIds: fixture.scopeIds });
  assert.equal(result.unavailableCount, 0);
  assert.deepEqual(result.repositories, []);
  assert.equal(result.recovered.length, 1);
  assert.equal(result.recovered[0].id, fixture.session.id);
  assert.equal(readFileSync(join(result.recovered[0].archive, "owner.json"), "utf8"), fixture.raw);
  assert.equal(JSON.parse(readFileSync(join(result.recovered[0].archive, "receipt.json"), "utf8")).reason,
    "verified-quiescent-owner-exited");
  assert.equal(existsSync(fixture.path), false);
  const repeated = await fixture.registry.repositories({ scopeIds: fixture.scopeIds });
  assert.equal(repeated.unavailableCount, 0);
  assert.equal(repeated.recovered, undefined);
});

test("pending startup cannot persist a quiescent checkpoint or auto-recover after its owner exits", async t => {
  const fixture = crashedDashboard(t, "pending");
  assert.equal(JSON.parse(fixture.raw).resources, "busy");
  const result = await fixture.registry.repositories({ scopeIds: fixture.scopeIds });
  assert.equal(result.unavailableCount, 1);
  assert.equal(result.recovered, undefined);
  assert.equal(readFileSync(fixture.path, "utf8"), fixture.raw);
});

test("a retained reservation prevents a false quiescent checkpoint even without an in-memory executor", async t => {
  const fixture = crashedDashboard(t, "reserved");
  assert.equal(JSON.parse(fixture.raw).resources, "busy");
  const result = await fixture.registry.repositories({ scopeIds: fixture.scopeIds });
  assert.equal(result.unavailableCount, 1);
  assert.equal(readFileSync(fixture.path, "utf8"), fixture.raw);
  assert.equal(fixture.reservations().length, 1);
});

test("concurrent recovery scans do not fail when another observer already archived the same owner", async t => {
  const fixture = crashedDashboard(t);
  const results = await Promise.all(Array.from({ length: 4 }, () =>
    fixture.registry.repositories({ scopeIds: fixture.scopeIds })));
  assert.ok(results.every(result => result.unavailableCount === 0 && result.repositories.length === 0));
  const recovered = results.flatMap(result => result.recovered ?? []);
  assert.equal(recovered.length, 1);
  assert.equal(readFileSync(join(recovered[0].archive, "owner.json"), "utf8"), fixture.raw);
});

test("automatic recovery rejects ambiguous responses and never controls a replacement session", async t => {
  const fixture = crashedDashboard(t);
  let mode = "unavailable";
  let controls = 0;
  const server = createServer((request, response) => {
    if (request.method !== "GET") { controls++; }
    response.setHeader("Content-Type", "application/json");
    response.statusCode = mode === "unavailable" ? 503 : 200;
    response.end(JSON.stringify(mode === "malformed" ? {} : {
      id: randomUUID(), scopeId: fixture.registry.scopeId, repository: fixture.repository
    }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeIdleConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const raw = JSON.stringify({ ...JSON.parse(fixture.raw), url: `http://127.0.0.1:${server.address().port}` });
  writeFileSync(fixture.path, raw);
  for (const next of ["unavailable", "malformed"]) {
    mode = next;
    const result = await fixture.registry.repositories({ scopeIds: fixture.scopeIds });
    assert.equal(result.unavailableCount, 1);
    assert.equal(readFileSync(fixture.path, "utf8"), raw);
  }
  mode = "replacement";
  const recovered = await fixture.registry.repositories({ scopeIds: fixture.scopeIds });
  assert.equal(recovered.unavailableCount, 0);
  assert.equal(recovered.recovered.length, 1);
  assert.equal(readFileSync(join(recovered.recovered[0].archive, "owner.json"), "utf8"), raw);
  assert.equal(controls, 0);
});

test("legacy recovery is preview-only until explicitly confirmed and preserves live owners and job evidence", async t => {
  const fixture = await legacyOwner(t);
  const live = createSessionRegistry(fixture.repository);
  let controls = 0;
  const server = createServer((request, response) => {
    if (request.method !== "GET") { controls++; }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ id: live.id, scopeId: live.scopeId, repository: fixture.repository,
      job: { id: "saved-job", status: "failed", running: false } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  live.register(`http://127.0.0.1:${server.address().port}`);
  t.after(async () => {
    server.closeIdleConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const evidence = join(fixture.repository, "saved-evidence.json");
  const saved = '{"status":"failed","stages":{"live-test":"pending"},"permissions":[]}';
  writeFileSync(evidence, saved);
  const plan = await reviewSessionRecovery(fixture.repository);
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.live[0].id, live.id);
  assert.equal(readFileSync(fixture.path, "utf8"), fixture.raw);
  await assert.rejects(recoverRepositorySessions(fixture.repository, {
    reviewToken: plan.reviewToken, confirmed: true
  }), /explicit approval/);
  const result = await recoverRepositorySessions(fixture.repository, {
    reviewToken: plan.reviewToken, confirmedQuiescent: true, confirmed: true
  });
  assert.equal(result.recovered.length, 1);
  assert.equal(result.preservedLiveOwners, 1);
  assert.equal(readFileSync(join(result.recovered[0].archive, "owner.json"), "utf8"), fixture.raw);
  assert.equal(existsSync(join(tmpdir(), "fixlab-dashboard-sessions", live.scopeId, `${live.id}.json`)), true);
  assert.equal(readFileSync(evidence, "utf8"), saved);
  assert.equal(controls, 0);
  await assert.rejects(recoverRepositorySessions(fixture.repository, {
    reviewToken: plan.reviewToken, confirmedQuiescent: true, confirmed: true
  }), /changed after review/);
});

test("changed registrations and live registered processes cannot be retired using an old review", async t => {
  const fixture = await legacyOwner(t);
  const plan = await reviewSessionRecovery(fixture.repository);
  const replacement = JSON.stringify({ id: fixture.id, url: await closedLoopbackUrl(),
    version: 2, pid: process.pid, resources: "quiescent" });
  writeFileSync(fixture.path, replacement);
  await assert.rejects(recoverRepositorySessions(fixture.repository, {
    reviewToken: plan.reviewToken, confirmedQuiescent: true, confirmed: true
  }), /changed after review/);
  const fresh = await reviewSessionRecovery(fixture.repository);
  assert.equal(fresh.candidates.length, 0);
  assert.equal(fresh.blocked.length, 1);
  const discovery = await fixture.registry.repositories({ scopeIds: fixture.scopeIds });
  assert.equal(discovery.unavailableCount, 1);
  assert.equal(readFileSync(fixture.path, "utf8"), replacement);
});

test("manual recovery preserves executor, testing and linked-worktree reservations", async t => {
  const fixture = await legacyOwner(t, true);
  const plan = await reviewSessionRecovery(fixture.repository);
  for (const resource of ["executor", "local-testing"]) {
    const owner = createExecutorLease(fixture.repository, "old-owner", { resource });
    const lease = owner.acquire("old-job");
    const path = join(owner.scope.directory, "owner.json");
    const raw = readFileSync(path, "utf8");
    try {
      await assert.rejects(recoverRepositorySessions(fixture.repository, {
        reviewToken: plan.reviewToken, confirmedQuiescent: true, confirmed: true
      }), /reservations remain/);
      assert.equal(readFileSync(path, "utf8"), raw);
      assert.equal(readFileSync(fixture.path, "utf8"), fixture.raw);
    } finally { lease.release(); }
  }
  const isolated = join(fixture.repository, ".git", "worktrees", "owned", "fixlab", "executor-lease");
  mkdirSync(isolated, { recursive: true });
  writeFileSync(join(isolated, "owner.json"), '{"state":"unknown"}');
  await assert.rejects(recoverRepositorySessions(fixture.repository, {
    reviewToken: plan.reviewToken, confirmedQuiescent: true, confirmed: true
  }), /reservations remain/);
  assert.equal(readFileSync(join(isolated, "owner.json"), "utf8"), '{"state":"unknown"}');
});

test("recovery refuses untrusted reservation paths without following them or changing registration bytes", async t => {
  const fixture = await legacyOwner(t, true);
  const target = join(fixture.repository, "unrelated");
  mkdirSync(target);
  writeFileSync(join(target, "sentinel"), "preserve");
  symlinkSync(target, join(fixture.repository, ".git", "fixlab"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(reviewSessionRecovery(fixture.repository), /untrusted reservation/);
  assert.equal(readFileSync(fixture.path, "utf8"), fixture.raw);
  assert.equal(readFileSync(join(target, "sentinel"), "utf8"), "preserve");
});

test("CLI recovery rejects incomplete confirmation and repeated options before changing any registration", async t => {
  const fixture = await legacyOwner(t);
  const cli = fileURLToPath(new URL("../bin/fixlab.js", import.meta.url));
  const preview = spawnSync(process.execPath, [cli, "recover-sessions", fixture.repository], {
    encoding: "utf8", windowsHide: true, timeout: 30000
  });
  assert.equal(preview.status, 0, preview.stderr);
  const plan = JSON.parse(preview.stdout);
  assert.equal(plan.candidates[0].id, fixture.id);
  for (const args of [["--yes"], ["--review-token", "invalid"], ["--yes", "--yes"]]) {
    const result = spawnSync(process.execPath, [cli, "recover-sessions", fixture.repository, ...args], {
      encoding: "utf8", windowsHide: true, timeout: 30000
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /recover-sessions|Review first/);
    assert.equal(readFileSync(fixture.path, "utf8"), fixture.raw);
  }
  const confirmed = spawnSync(process.execPath, [cli, "recover-sessions", fixture.repository,
    "--review-token", plan.reviewToken, "--confirm-quiescent", "--yes"], {
    encoding: "utf8", windowsHide: true, timeout: 30000
  });
  assert.equal(confirmed.status, 0, confirmed.stderr);
  const result = JSON.parse(confirmed.stdout);
  assert.equal(readFileSync(join(result.recovered[0].archive, "owner.json"), "utf8"), fixture.raw);
  assert.equal(existsSync(fixture.path), false);
});
