import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionRegistry } from "../dashboard/sessions.js";

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
    session = { id: registry.id, scopeId: randomUUID() };
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
      registry.register(`http://127.0.0.1:${server.address().port}`);
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
