import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { safeRuntimeText } from "./runtime-requests.js";

const requestLimit = 8192;
const responseLimit = 1024 * 1024;
const maxPendingRequests = 16;
const transportTimeoutMs = 20000;
const channelNames = [
  "FIXLAB_BROWSER_POST_URL", "FIXLAB_BROWSER_POST_KEY", "FIXLAB_BROWSER_POST_JOB",
  "FIXLAB_BROWSER_POST_ENV", "FIXLAB_BROWSER_POST_HELPER"
];

export function clearBrowserPostEnvironment() {
  for (const name of channelNames) {
    delete process.env[name];
  }
}

async function boundedBody(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += Buffer.byteLength(chunk);
    if (size > limit) {
      throw new Error("Browser POST exceeded its private transport size limit.");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function startBrowserPostBridge({ send, revoke, jobId, environment, serializeRequests = false, request = fetch }) {
  if (process.env.DEBUG || process.env.PWDEBUG || process.env.NODE_DEBUG) {
    throw new Error("Browser POST requires credential-sensitive debug logging to be disabled.");
  }
  const key = randomBytes(32).toString("hex");
  const shutdown = new AbortController();
  let active = true;
  let pending = 0;
  let tail = Promise.resolve();
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const suppliedKey = req.headers["x-fixlab-post-key"];
    if (!active || req.method !== "POST" || req.url !== "/post" ||
        req.headers.host !== new URL(url).host || req.headers.origin !== undefined ||
        req.headers["content-type"] !== "application/json" ||
        typeof suppliedKey !== "string" || !/^[a-f0-9]{64}$/u.test(suppliedKey) ||
        !timingSafeEqual(Buffer.from(suppliedKey), Buffer.from(key))) {
      res.writeHead(403).end();
      return;
    }
    if ((pending && !serializeRequests) || pending >= maxPendingRequests) {
      res.writeHead(409).end();
      return;
    }
    pending++;
    const previous = tail;
    let release;
    if (serializeRequests) {
      tail = new Promise((resolve) => { release = resolve; });
    }
    const disconnected = new AbortController();
    let dispatched = false;
    res.once("close", () => {
      if (!res.writableEnded) {
        if (dispatched) { revoke(); }
        disconnected.abort();
      }
    });
    try {
      await previous;
      if (!active || disconnected.signal.aborted) {
        throw new Error("Browser POST channel closed before dispatch.");
      }
      const input = JSON.parse((await boundedBody(req, requestLimit)).toString("utf8"));
      if (!input || input.jobId !== jobId || input.environment !== environment ||
          Object.keys(input).some((name) => !["jobId", "environment", "args"].includes(name))) {
        throw new Error("Browser POST does not match the current job and environment.");
      }
      let reply;
      const metadata = await send(input.args, async (target, options) => {
        dispatched = true;
        const response = await request(target, {
          ...options, signal: AbortSignal.any([options.signal, shutdown.signal, disconnected.signal])
        });
        const headers = { "cache-control": "no-store" };
        for (const name of ["content-type", "access-control-allow-origin", "access-control-allow-credentials"]) {
          const value = response.headers.get(name);
          if (value !== null) { headers[name] = value; }
        }
        const body = response.body
          ? await boundedBody(response.body, responseLimit) : Buffer.alloc(0);
        reply = { status: response.status, body: body.toString("base64"), headers };
        return new Response(null, { status: response.status });
      });
      if (!reply || !active) {
        throw new Error("Browser POST ended without a current response.");
      }
      res.writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ ...reply, metadata }));
    } catch (error) {
      const reason = error instanceof Error && safeRuntimeText(error.message, 1000) &&
          /^(?:POST |DEV |SIT |UAT |PPE |The job-scoped |Browser POST )/u.test(error.message)
        ? error.message : "The request was blocked or did not complete successfully.";
      res.writeHead(409, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: `Browser POST failed: ${reason} Inspect the selected environment before another attempt; no automatic retry was made.` }));
    } finally {
      pending--;
      release?.();
    }
  });
  server.requestTimeout = transportTimeoutMs;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/post`;
  const values = [url, key, jobId, environment, import.meta.url];
  const previous = channelNames.map((name) => process.env[name]);
  for (const [index, name] of channelNames.entries()) {
    process.env[name] = values[index];
  }
  return {
    async close() {
      active = false;
      revoke();
      shutdown.abort();
      for (const [index, name] of channelNames.entries()) {
        if (previous[index] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = previous[index];
        }
      }
      const closed = new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      server.closeAllConnections();
      await closed;
    }
  };
}

export async function forwardApprovedBrowserPost(route, options) {
  return forwardBrowserRequest(route, options, true);
}

export async function forwardApprovedBrowserRequest(route, options) {
  return forwardBrowserRequest(route, options, false);
}

async function forwardBrowserRequest(route, { environment, purpose }, postOnly) {
  const request = route.request();
  try {
    if (process.env.DEBUG || process.env.PWDEBUG || process.env.NODE_DEBUG) {
      throw new Error("Browser POST requires credential-sensitive debug logging to be disabled.");
    }
    const url = new URL(process.env.FIXLAB_BROWSER_POST_URL ?? "");
    const key = process.env.FIXLAB_BROWSER_POST_KEY;
    const jobId = process.env.FIXLAB_BROWSER_POST_JOB;
    const data = request.postData();
    const method = request.method();
    const contentType = request.headers()["content-type"];
    if (!(postOnly ? method === "POST" : method === "POST" ||
          environment?.toLowerCase() === "ppe" && ["GET", "PUT", "PATCH", "DELETE"].includes(method)) ||
        (method === "GET" && data !== null) || typeof environment !== "string" ||
        environment.toLowerCase() !== process.env.FIXLAB_BROWSER_POST_ENV ||
        url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
        url.pathname !== "/post" || url.username || url.password || url.search || url.hash ||
        !/^[a-f0-9]{64}$/u.test(key ?? "") || !/^[a-f0-9-]{36}$/u.test(jobId ?? "") ||
        (!(data === null && contentType === undefined) &&
          !/^application\/json(?:;|$)/iu.test(contentType ?? ""))) {
      throw new Error("Browser POST requires the current FixLab job's private channel and JSON POST scope.");
    }
    if (data !== null && Buffer.byteLength(data) > 4000) {
      throw new Error("Browser POST payload is oversized.");
    }
    const args = { url: request.url(), purpose,
      ...(!postOnly && method !== "POST" ? { method } : {}),
      ...(data === null ? {} : { payload: JSON.parse(data) }) };
    const input = JSON.stringify({ jobId, environment: environment.toLowerCase(), args });
    // Include every bounded queue slot; upstream dispatch retains its own 15-second limit.
    const deadline = AbortSignal.timeout(maxPendingRequests * transportTimeoutMs);
    const reply = await new Promise((resolve, reject) => {
      const req = httpRequest(url, {
        method: "POST", headers: { "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(input), "x-fixlab-post-key": key },
        signal: deadline
      }, async (res) => {
        try {
          const body = await boundedBody(res, responseLimit * 2);
          const reply = JSON.parse(body.toString("utf8"));
          if (res.statusCode !== 200) {
            if (safeRuntimeText(reply.error, 2000) && reply.error.startsWith("Browser POST failed:")) {
              throw new Error(reply.error);
            }
            throw new Error("Browser POST was not authorized or did not complete successfully.");
          }
          resolve(reply);
        } catch (error) {
          reject(error);
        }
      });
      req.once("error", () => reject(new Error(deadline.aborted
        ? "Browser POST timed out; inspect the selected environment before retrying."
        : "The current FixLab browser POST channel is unavailable.")));
      req.end(input);
    });
    await route.fulfill({ status: reply.status, headers: reply.headers,
      body: Buffer.from(reply.body, "base64") });
    return reply.metadata;
  } catch (error) {
    await route.abort("blockedbyclient");
    throw error;
  }
}
