import { persistentDevApiConfiguration } from "./dev-post.js";

export async function createDevBrowserContext(browser, {
  repository = process.env.FIXLAB_REPOSITORY,
  targetEnvironment = process.env.FIXLAB_DEV_API_ENVIRONMENT,
  contextOptions = {}
} = {}) {
  if (typeof repository !== "string" || !/^dev$/iu.test(targetEnvironment ?? "")) {
    throw new Error("DEV UI testing requires an explicit repository and DEV environment.");
  }
  const plan = persistentDevApiConfiguration(repository);
  if (!plan?.frontendOrigin) {
    throw new Error("Configure the frontend and dataSafety.devWrite.allowAll before real DEV UI testing.");
  }
  if (!contextOptions || typeof contextOptions !== "object" || Array.isArray(contextOptions) ||
      contextOptions.ignoreHTTPSErrors === true || contextOptions.recordHar ||
      (contextOptions.serviceWorkers !== undefined && contextOptions.serviceWorkers !== "block")) {
    throw new Error("DEV UI testing requires valid TLS, blocked service workers and no credential-bearing HAR recording.");
  }
  const context = await browser.newContext({ ...contextOptions, serviceWorkers: "block" });
  let failure = null;
  let writesStopped = false;
  const pending = new Set();
  const results = [];
  const fail = (message) => {
    failure ??= new Error(message);
    return failure;
  };
  const verify = () => {
    if (persistentDevApiConfiguration(repository)?.revision !== plan.revision) {
      throw fail("DEV API configuration or authentication helper changed; restart validation using the current configuration.");
    }
  };
  try {
    if (typeof context.routeWebSocket !== "function") {
      throw new Error("DEV UI guards require Playwright 1.48 or later for WebSocket controls.");
    }
    await context.routeWebSocket("**/*", socket => {
      try {
        verify();
        const url = new URL(socket.url());
        const frontend = new URL(plan.frontendOrigin);
        if (!["localhost", "127.0.0.1"].includes(frontend.hostname) ||
            url.hostname !== frontend.hostname || url.port !== frontend.port) {
          throw fail("WebSocket API traffic is not part of the configured DEV HTTP API contract.");
        }
        socket.connectToServer();
      } catch {
        fail("The frontend WebSocket guard failed; restart validation using the current configuration.");
        socket.close();
      }
    });
    await context.route("**/*", route => {
      const operation = (async () => {
        try {
          verify();
          const request = route.request();
          const url = new URL(request.url());
          const method = request.method();
          const read = ["GET", "HEAD", "OPTIONS"].includes(method);
          const proxy = url.origin === plan.frontendOrigin &&
            ["localhost", "127.0.0.1"].includes(url.hostname) &&
            !/%(?:2f|5c|2e)/iu.test(url.pathname) &&
            (plan.configuration.browserProxyPaths ?? []).some(path =>
              url.pathname === path || url.pathname.startsWith(`${path}/`));
          const developmentProbe = read && url.origin === plan.frontendOrigin &&
            ["/sockjs-node/info", "/__vite_ping"].includes(url.pathname);
          const api = ["fetch", "xhr", "eventsource"].includes(request.resourceType()) ||
            plan.configuration.origins.includes(url.origin) || !read;
          if (!api || developmentProbe) {
            const asset = ["script", "stylesheet", "image", "font", "media", "manifest"].includes(request.resourceType());
            if (url.origin !== plan.frontendOrigin && !(asset && url.protocol === "https:")) {
              throw fail("Navigation is outside the configured frontend; complete normal authentication before DEV UI validation.");
            }
            await route.continue();
            return;
          }
          if ((!proxy && (url.protocol !== "https:" || !plan.configuration.origins.includes(url.origin))) ||
              url.username || url.password ||
              !["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"].includes(method) ||
              request.redirectedFrom()) {
            throw fail("API traffic is outside the configured DEV origins/methods, or follows a redirect.");
          }
          if (!read && writesStopped) {
            throw fail("A previous DEV write failed or has an unknown outcome; inspect it before starting another validation.");
          }
          const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 15000 });
          const status = response.status();
          results.push({ method, status });
          if (results.length > 100) { results.shift(); }
          if (status >= 300 && status < 400) {
            throw fail("DEV API redirects are not followed; verify the configured target and authentication.");
          }
          if (status >= 500) {
            writesStopped = true;
            fail(`DEV API returned HTTP ${status}; no automatic retry was made.`);
          }
          await route.fulfill({ response });
        } catch {
          writesStopped = true;
          fail("DEV API request was blocked or failed. Check the configured origins, authentication and prior write outcome; no automatic retry was made.");
          await route.abort("blockedbyclient");
        }
      })();
      pending.add(operation);
      operation.finally(() => pending.delete(operation)).catch(() => {
        fail("The DEV browser request could not be settled; validation is not confirmed.");
      });
      return operation;
    });
  } catch (error) {
    await context.close();
    throw error;
  }
  const assertHealthy = async () => {
    while (pending.size) { await Promise.allSettled([...pending]); }
    verify();
    if (failure) { throw failure; }
    return { source: "non-production-approved", mutationMode: "approved-write",
      validationPassed: false, requests: results.map(result => ({ ...result })) };
  };
  return {
    context, assertHealthy,
    async close() {
      try { await assertHealthy(); }
      finally { await context.close(); }
    }
  };
}
