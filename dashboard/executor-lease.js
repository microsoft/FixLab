import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

export function canonicalExecutionRepository(repository) {
  const root = realpathSync.native(repository);
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000
  });
  let identity;
  let directory;
  if (result.status === 0) {
    const common = result.stdout.trim();
    if (!common) {
      throw new Error("Git did not identify the repository's common directory");
    }
    identity = realpathSync.native(isAbsolute(common) ? common : resolve(root, common));
    directory = join(identity, "fixlab", "executor-lease");
  } else if (
    !result.error &&
    !existsSync(join(root, ".git")) &&
    /not a git repository/i.test(result.stderr)
  ) {
    identity = root;
  } else {
    throw new Error("Cannot verify the canonical repository for executor ownership");
  }
  const canonical = process.platform === "win32" ? identity.toLowerCase() : identity;
  const key = createHash("sha256").update(canonical).digest("hex");
  return {
    key,
    directory: directory ?? join(tmpdir(), "fixlab-executor-leases", key),
    repository: identity
  };
}

export function createExecutorLease(repository, ownerId, { worktree = false, resource = "executor" } = {}) {
  const scope = canonicalExecutionRepository(repository);
  if (!["executor", "local-testing"].includes(resource) || (worktree && resource !== "executor")) {
    throw new Error("Unknown execution resource scope.");
  }
  if (worktree) {
    const root = realpathSync.native(repository);
    const result = spawnSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000
    });
    if (result.status !== 0 || result.error) {
      throw new Error("Cannot verify the isolated checkout's Git directory.");
    }
    const directory = realpathSync.native(result.stdout.trim());
    if (directory === scope.repository) {
      throw new Error("Parallel executor ownership requires a linked Git worktree.");
    }
    scope.directory = join(directory, "fixlab", "executor-lease");
    scope.key = createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex");
  } else if (resource === "local-testing") {
    scope.directory = scope.directory === join(scope.repository, "fixlab", "executor-lease")
      ? join(resolve(scope.directory, ".."), "local-testing-lease")
      : `${scope.directory}-local-testing`;
  }
  const metadataPath = join(scope.directory, "owner.json");

  function reservedError() {
    let description = "incomplete or unreadable ownership metadata";
    try {
      const directoryInfo = lstatSync(scope.directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
        throw new Error("untrusted lease directory");
      }
      const info = lstatSync(metadataPath);
      if (info.isFile() && !info.isSymbolicLink() && info.size <= 8192) {
        const record = JSON.parse(readFileSync(metadataPath, "utf8"));
        description = `owner ${record.ownerId}, job ${record.jobId}, state ${record.state}`;
      }
    } catch {
      // An incomplete reservation remains exclusive after an owner crash.
    }
    return Object.assign(new Error(
      `Repository executor lease is reserved (${description}). ` +
      "Reconnect to its owner or wait for confirmed executor termination. " +
      "An unreachable owner is not proof that its executor stopped; do not clear the lease without verifying that the owner and executor tree are quiescent."
    ), { code: "FIXLAB_LEASE_RESERVED" });
  }

  return {
    scope,
    acquire(jobId) {
      const parent = resolve(scope.directory, "..");
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      try {
        mkdirSync(scope.directory, { mode: 0o700 });
      } catch (error) {
        if (error.code === "EEXIST") {
          throw reservedError();
        }
        throw error;
      }
      const record = {
        version: 1,
        acquisition: randomUUID(),
        ownerId,
        jobId,
        ownerPid: process.pid,
        ownerStartedAt: performance.timeOrigin,
        executorPid: null,
        state: "starting",
        acquiredAt: new Date().toISOString()
      };
      const directoryInfo = lstatSync(scope.directory);
      writeFileSync(metadataPath, JSON.stringify(record), {
        flag: "wx",
        mode: 0o600
      });
      let released = false;
      const verify = () => {
        const currentDirectory = lstatSync(scope.directory);
        const currentFile = lstatSync(metadataPath);
        if (
          !currentDirectory.isDirectory() ||
          currentDirectory.isSymbolicLink() ||
          currentDirectory.ino !== directoryInfo.ino ||
          currentDirectory.dev !== directoryInfo.dev ||
          !currentFile.isFile() ||
          currentFile.isSymbolicLink()
        ) {
          throw new Error("Executor lease ownership paths changed");
        }
        const current = JSON.parse(readFileSync(metadataPath, "utf8"));
        if (current.acquisition !== record.acquisition || current.ownerId !== ownerId) {
          throw new Error("Executor lease acquisition changed; refusing to alter another owner");
        }
      };
      return {
        update(state, executorPid = record.executorPid) {
          if (released) {
            throw new Error("Executor lease has already been released");
          }
          verify();
          record.state = state;
          record.executorPid = executorPid ?? null;
          writeFileSync(metadataPath, JSON.stringify(record), { mode: 0o600 });
        },
        release() {
          if (released) {
            return;
          }
          verify();
          unlinkSync(metadataPath);
          rmdirSync(scope.directory);
          released = true;
        }
      };
    }
  };
}

/** @param {{signal?: AbortSignal, onWaiting?: () => void, pollMs?: number}} options */
export async function waitForExecutorLease(owner, jobId, options = {}) {
  const { signal, onWaiting = () => {}, pollMs = 250 } = options;
  let waiting = false;
  for (;;) {
    signal?.throwIfAborted();
    try {
      return owner.acquire(jobId);
    } catch (error) {
      if (error.code !== "FIXLAB_LEASE_RESERVED") { throw error; }
      if (!waiting) { onWaiting(); waiting = true; }
      await sleep(pollMs, undefined, { signal });
    }
  }
}
