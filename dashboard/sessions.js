import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const ownerPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

function validateOwner(record, id) {
  const url = new URL(record.url);
  if (
    record.id !== id ||
    !ownerPattern.test(id) ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("invalid FixLab session owner");
  }
  return { id, url: url.origin };
}

export function createSessionRegistry(repositoryIdentity) {
  const key = createHash("sha256").update(repositoryIdentity).digest("hex");
  const directory = join(tmpdir(), "fixlab-dashboard-sessions", key);
  const id = randomUUID();
  const path = join(directory, `${id}.json`);
  let owner = null;

  function readOwner(ownerId, ownerDirectory = directory) {
    if (!ownerPattern.test(ownerId)) {
      throw new Error("invalid FixLab session owner ID");
    }
    const ownerPath = join(ownerDirectory, `${ownerId}.json`);
    const info = lstatSync(ownerPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2048) {
      throw new Error("invalid FixLab session ownership record");
    }
    return validateOwner(JSON.parse(readFileSync(ownerPath, "utf8")), ownerId);
  }

  async function inspectOwner(record, scopeId = key, timeoutMs = 1500) {
    const response = await fetch(`${record.url}/api/session`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error"
    });
    if (!response.ok) {
      throw new Error(`owner returned HTTP ${response.status}`);
    }
    const session = await response.json();
    if (session.id !== record.id || session.scopeId !== scopeId) {
      throw new Error("the port no longer belongs to this repository's FixLab session");
    }
    return { ...session, url: record.url };
  }

  return {
    id,
    scopeId: key,
    register(url) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      owner = validateOwner({ id, url }, id);
      writeFileSync(path, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    },
    unregister() {
      if (owner) {
        unlinkSync(path);
        owner = null;
      }
    },
    async list() {
      if (!owner) {
        throw new Error("FixLab session ownership is not registered");
      }
      const entries = readdirSync(directory).filter((name) =>
        /^[0-9a-f-]+\.json$/u.test(name)
      );
      if (entries.length > 100) {
        throw new Error("too many retained FixLab session ownership records");
      }
      return Promise.all(entries.map(async (name) => {
        const ownerId = name.slice(0, -5);
        try {
          return { ...(await inspectOwner(readOwner(ownerId))), available: true };
        } catch (error) {
          return { id: ownerId, available: false, error: error.message };
        }
      }));
    },
    async repositories({ scopeIds, timeoutMs = 1500 } = {}) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) {
        throw new Error("Repository ownership inspection requires a timeout between 1 and 10000 ms.");
      }
      const root = join(tmpdir(), "fixlab-dashboard-sessions");
      let candidates;
      if (scopeIds) {
        if (!Array.isArray(scopeIds) || scopeIds.length > 20 ||
            scopeIds.some(id => typeof id !== "string" || !/^[0-9a-f]{64}$/u.test(id))) {
          throw new Error("Repository discovery needs at most 20 exact scope IDs.");
        }
        candidates = [...new Set(scopeIds)].flatMap(name => {
          try {
            const info = lstatSync(join(root, name));
            return [{ name, isDirectory: () => info.isDirectory(), isSymbolicLink: () => info.isSymbolicLink() }];
          } catch (error) { if (error.code === "ENOENT") { return []; } throw error; }
        });
      } else {
        candidates = readdirSync(root, { withFileTypes: true });
      }
      const scopes = candidates.filter((entry) =>
        entry.isDirectory() && !entry.isSymbolicLink() && /^[0-9a-f]{64}$/u.test(entry.name)
      );
      if (scopes.length > 10000) {
        throw new Error("too many retained repository session directories");
      }
      const records = [];
      for (const scope of scopes) {
        if (scopeIds && !scopeIds.includes(scope.name)) { continue; }
        const ownerDirectory = join(root, scope.name);
        for (const name of readdirSync(ownerDirectory).filter((name) => ownerPattern.test(name.slice(0, -5)) && name.endsWith(".json"))) {
          if (records.length >= 250) {
            throw new Error("too many retained local dashboard records; repository discovery is bounded");
          }
          records.push({ ownerDirectory, scopeId: scope.name, ownerId: name.slice(0, -5) });
        }
      }
      const results = await Promise.all(records.map(async ({ ownerDirectory, scopeId, ownerId }) => {
        try {
          const session = await inspectOwner(readOwner(ownerId, ownerDirectory), scopeId, timeoutMs);
          if (typeof session.repository !== "string" || !isAbsolute(session.repository) ||
              session.repository.length > 2048) {
            throw new Error("invalid repository identity");
          }
          return {
            id: session.id, repository: session.repository, url: session.url,
            status: session.job?.status ?? "idle"
          };
        } catch {
          return null;
        }
      }));
      return {
        repositories: results.filter(Boolean),
        unavailableCount: results.filter((result) => result === null).length
      };
    },
    async control(ownerId, control) {
      const record = readOwner(ownerId);
      await inspectOwner(record);
      const response = await fetch(`${record.url}/api/session/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...control, ownerId }),
        signal: AbortSignal.timeout(10000),
        redirect: "error"
      });
      return { status: response.status, body: await response.json() };
    }
  };
}
