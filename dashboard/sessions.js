import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
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
  if (record.version !== undefined &&
      (record.version !== 2 || !Number.isSafeInteger(record.pid) || record.pid < 1 ||
       !["busy", "quiescent"].includes(record.resources))) {
    throw new Error("invalid FixLab session resource checkpoint");
  }
  return { id, url: url.origin, ...(record.version === 2
    ? { version: 2, pid: record.pid, resources: record.resources } : {}) };
}

function processStopped(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) { return false; }
  try { process.kill(pid, 0); }
  catch (error) { return error.code === "ESRCH"; }
  return false;
}

function obsoleteEndpoint(error) {
  return error.code === "FIXLAB_SESSION_REPLACED" || error.cause?.code === "ECONNREFUSED";
}

function verifyDirectory(directory) {
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("invalid FixLab session ownership directory");
  }
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
    verifyDirectory(join(tmpdir(), "fixlab-dashboard-sessions"));
    verifyDirectory(ownerDirectory);
    const ownerPath = join(ownerDirectory, `${ownerId}.json`);
    const info = lstatSync(ownerPath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 2048) {
      throw new Error("invalid FixLab session ownership record");
    }
    const raw = readFileSync(ownerPath, "utf8");
    return { ...validateOwner(JSON.parse(raw), ownerId),
      revision: createHash("sha256").update(raw).digest("hex"), ino: info.ino, dev: info.dev };
  }

  function collectOwners(scopeIds) {
    if (scopeIds && (!Array.isArray(scopeIds) || scopeIds.length === 0 || scopeIds.length > 20 ||
        scopeIds.some(value => typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)))) {
      throw new Error("Repository discovery needs 1 to 20 exact scope IDs.");
    }
    const root = join(tmpdir(), "fixlab-dashboard-sessions");
    try { verifyDirectory(root); }
    catch (error) { if (error.code === "ENOENT") { return []; } throw error; }
    let candidates;
    if (scopeIds) {
      candidates = [...new Set(scopeIds)].flatMap(name => {
        try {
          verifyDirectory(join(root, name));
          return [name];
        } catch (error) { if (error.code === "ENOENT") { return []; } throw error; }
      });
    } else {
      candidates = readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^[0-9a-f]{64}$/u.test(entry.name))
        .map(entry => entry.name);
    }
    if (candidates.length > 10000) {
      throw new Error("too many retained repository session directories");
    }
    const records = [];
    for (const scopeId of candidates.sort()) {
      const ownerDirectory = join(root, scopeId);
      verifyDirectory(ownerDirectory);
      for (const name of readdirSync(ownerDirectory).sort()
        .filter(value => ownerPattern.test(value.slice(0, -5)) && value.endsWith(".json"))) {
        if (records.length >= 250) {
          throw new Error("too many retained local dashboard records; repository discovery is bounded");
        }
        records.push({ ownerDirectory, scopeId, ownerId: name.slice(0, -5) });
      }
    }
    return records;
  }

  function archiveOwner(record, entry, reason) {
    const current = readOwner(entry.ownerId, entry.ownerDirectory);
    if (current.revision !== record.revision || current.ino !== record.ino || current.dev !== record.dev) {
      throw new Error("Session ownership changed after inspection; nothing was retired.");
    }
    if (current.pid && !processStopped(current.pid)) {
      throw new Error("The registered process is running or cannot be verified; nothing was retired.");
    }
    const archive = join(entry.ownerDirectory, `.recovered-${record.id}-${randomUUID()}`);
    mkdirSync(archive, { mode: 0o700 });
    const verified = readOwner(entry.ownerId, entry.ownerDirectory);
    if (verified.revision !== record.revision || verified.ino !== record.ino || verified.dev !== record.dev) {
      throw new Error("Session ownership changed during recovery; its record was preserved.");
    }
    const recoveredAt = new Date().toISOString();
    writeFileSync(join(archive, "receipt.json"), JSON.stringify({
      id: record.id, scopeId: entry.scopeId, revision: record.revision, reason, recoveredAt
    }), { flag: "wx", mode: 0o600 });
    renameSync(join(entry.ownerDirectory, `${record.id}.json`), join(archive, "owner.json"));
    return { id: record.id, scopeId: entry.scopeId, reason, recoveredAt, archive };
  }

  async function inspectEntry(entry, timeoutMs, recover = false) {
    const alreadyRemoved = error => {
      if (error.code !== "ENOENT") { return false; }
      try { lstatSync(join(entry.ownerDirectory, `${entry.ownerId}.json`)); }
      catch (missing) { return missing.code === "ENOENT"; }
      return false;
    };
    let record;
    try {
      record = readOwner(entry.ownerId, entry.ownerDirectory);
      const session = await inspectOwner(record, entry.scopeId, timeoutMs);
      const current = readOwner(entry.ownerId, entry.ownerDirectory);
      if (current.url !== record.url || current.pid !== record.pid) {
        throw new Error("Session ownership changed during inspection.");
      }
      return { entry, record: current, session };
    } catch (error) {
      if (alreadyRemoved(error)) { return { entry, absent: true }; }
      if (recover && record?.version === 2 && record.resources === "quiescent" &&
          processStopped(record.pid) && obsoleteEndpoint(error)) {
        try {
          return { entry, record, recovered: archiveOwner(record, entry, "verified-quiescent-owner-exited") };
        } catch (failure) {
          if (alreadyRemoved(failure)) { return { entry, absent: true }; }
          throw failure;
        }
      }
      return { entry, record, error };
    }
  }

  async function inspectOwner(record, scopeId = key, timeoutMs = 1500) {
    const signal = AbortSignal.timeout(timeoutMs);
    const readSession = async () => {
      const response = await fetch(`${record.url}/api/session`, {
        signal,
        redirect: "error"
      });
      if (!response.ok) {
        throw new Error(`owner returned HTTP ${response.status}`);
      }
      return response.json();
    };
    let session;
    try {
      session = await readSession();
    } catch (error) {
      if (signal.aborted || !["ECONNRESET", "UND_ERR_SOCKET"].includes(error.cause?.code)) {
        throw error;
      }
      session = await readSession();
    }
    if (!session || !ownerPattern.test(session.id) ||
        typeof session.scopeId !== "string" || !/^[0-9a-f]{64}$/u.test(session.scopeId)) {
      throw new Error("owner returned an invalid session identity");
    }
    if (session.id !== record.id || session.scopeId !== scopeId) {
      throw Object.assign(new Error("the port no longer belongs to this repository's FixLab session"),
        { code: "FIXLAB_SESSION_REPLACED" });
    }
    return { ...session, url: record.url };
  }

  return {
    id,
    scopeId: key,
    register(url) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      verifyDirectory(join(tmpdir(), "fixlab-dashboard-sessions"));
      verifyDirectory(directory);
      owner = validateOwner({ id, url, version: 2, pid: process.pid, resources: "busy" }, id);
      writeFileSync(path, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    },
    checkpoint(quiescent) {
      if (!owner) { throw new Error("FixLab session ownership is not registered"); }
      const resources = quiescent ? "quiescent" : "busy";
      if (owner.resources === resources) { return; }
      const current = readOwner(id);
      if (current.url !== owner.url || current.pid !== process.pid || current.resources !== owner.resources) {
        throw new Error("FixLab session ownership changed; resource checkpoint was not written.");
      }
      writeFileSync(path, JSON.stringify({ ...owner, resources }), { mode: 0o600 });
      owner.resources = resources;
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
      const entries = collectOwners([key]);
      if (entries.length > 100) {
        throw new Error("too many retained FixLab session ownership records");
      }
      const results = await Promise.all(entries.map(entry => inspectEntry(entry, 1500, true)));
      return results.filter(result => !result.recovered && !result.absent).map(result => result.session
        ? { ...result.session, available: true }
        : { id: result.entry.ownerId, available: false, error: result.error.message });
    },
    async repositories({ scopeIds, timeoutMs = 1500 } = {}) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) {
        throw new Error("Repository ownership inspection requires a timeout between 1 and 10000 ms.");
      }
      const records = collectOwners(scopeIds);
      const results = await Promise.all(records.map(async entry => {
        const result = await inspectEntry(entry, timeoutMs, Boolean(scopeIds));
        if (result.recovered || result.absent) { return result; }
        try {
          const session = result.session;
          if (!session) { return null; }
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
      const recovered = results.filter(result => result?.recovered).map(result => result.recovered);
      return { repositories: results.filter(result => result && !result.recovered && !result.absent),
        unavailableCount: results.filter(result => result === null).length,
        ...(recovered.length ? { recovered } : {}) };
    },
    async reviewRecovery(scopeIds) {
      const results = (await Promise.all(collectOwners(scopeIds).map(entry => inspectEntry(entry, 10000))))
        .filter(result => !result.absent);
      const candidates = [];
      const blocked = [];
      const live = [];
      for (const result of results) {
        const summary = { id: result.entry.ownerId, scopeId: result.entry.scopeId };
        if (result.session) {
          const session = result.session;
          live.push({ ...summary, url: session.url, job: session.job ?? null,
            frontend: session.frontend ?? null, authentication: session.authentication ?? null });
        } else if (result.record && obsoleteEndpoint(result.error) &&
            (!result.record.pid || processStopped(result.record.pid))) {
          candidates.push({ ...summary, url: result.record.url, revision: result.record.revision,
            reason: result.error.code === "FIXLAB_SESSION_REPLACED" ? "port-reassigned" : "connection-refused" });
        } else {
          blocked.push({ ...summary, reason: result.record?.pid && !processStopped(result.record.pid)
            ? "The registered process is running or cannot be verified." : result.error.message });
        }
      }
      const reviewToken = createHash("sha256").update(JSON.stringify({
        candidates, blocked, live, records: results.map(result => ({
          id: result.entry.ownerId, scopeId: result.entry.scopeId, revision: result.record?.revision,
          ino: result.record?.ino, dev: result.record?.dev
        }))
      })).digest("hex");
      return { reviewToken, candidates, blocked, live };
    },
    async recoverReviewed(scopeIds, reviewToken, confirmedQuiescent, verifyResources) {
      if (confirmedQuiescent !== true || !/^[0-9a-f]{64}$/u.test(reviewToken ?? "")) {
        throw new Error("Recovery requires the reviewed token and explicit confirmation that old resources stopped.");
      }
      const review = await this.reviewRecovery(scopeIds);
      if (review.reviewToken !== reviewToken) {
        throw new Error("Session ownership changed after review; inspect a fresh recovery plan.");
      }
      if (review.blocked.length) {
        throw new Error("Some owners remain unverifiable; no registrations were retired.");
      }
      verifyResources();
      const recovered = [];
      try {
        for (const candidate of review.candidates) {
          verifyResources();
          const ownerDirectory = join(tmpdir(), "fixlab-dashboard-sessions", candidate.scopeId);
          const record = readOwner(candidate.id, ownerDirectory);
          if (record.revision !== candidate.revision) {
            throw new Error("Session ownership changed during recovery.");
          }
          recovered.push(archiveOwner(record, { ownerDirectory, ownerId: candidate.id, ...candidate }, "reviewed-quiescence"));
        }
      } catch (error) {
        throw Object.assign(new Error(`Recovery stopped after archiving ${recovered.length} registrations: ${error.message}`),
          { recovered });
      }
      return { recovered, preservedLiveOwners: review.live.length };
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
