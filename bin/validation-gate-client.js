import { request } from "node:http";
import { resolve } from "node:path";

export async function runValidationGate(args, io = process) {
  try {
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index];
      const value = args[index + 1];
      if (!["--port", "--job", "--gate", "--resource", "--repository"].includes(key) || !value || options[key]) {
        throw new Error("Usage: fixlab gate --port <port> --job <id> (--gate <id> | --resource local-testing) --repository <worktree>");
      }
      options[key] = value;
    }
    const port = Number(options["--port"]);
    const resource = options["--resource"];
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !options["--job"] ||
        (resource !== undefined && resource !== "local-testing") ||
        (Boolean(options["--gate"]) === Boolean(resource))) {
      throw new Error("gate requires a loopback dashboard port, job ID, and gate ID.");
    }
    const body = JSON.stringify({
      jobId: options["--job"],
      gateId: options["--gate"],
      resource,
      repository: resolve(options["--repository"] ?? process.cwd())
    });
    const result = await new Promise((resolveResult, reject) => {
      const call = request({
        hostname: "127.0.0.1",
        port,
        path: "/api/validation/run",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
      }, (response) => {
        let content = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          content += chunk;
          if (Buffer.byteLength(content) > 128 * 1024) {
            call.destroy(new Error("Dashboard validation response exceeded its limit."));
          }
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            const data = JSON.parse(content);
            if (response.statusCode !== 200) {
              throw new Error(data.error ?? "Dashboard validation failed.");
            }
            if (!Number.isInteger(data.status) || typeof data.summary !== "string") {
              throw new Error("Invalid dashboard validation evidence.");
            }
            resolveResult(data);
          } catch (error) {
            reject(error);
          }
        });
      });
      call.on("error", reject);
      call.setTimeout(7_260_000, () => call.destroy(new Error("Dashboard validation timed out.")));
      call.end(body);
    });
    (result.status === 0 ? io.stdout : io.stderr).write(result.summary);
    return result.status;
  } catch (error) {
    io.stderr.write(`Validation gate failed: ${error.message}\n`);
    return 1;
  }
}
