const backends = {
  express: "EXPRESS_ORIGIN",
  python: "PYTHON_ORIGIN",
  worker: "WORKER_ORIGIN",
};

/** Same browser paths as dev; production origins are configured only on this Worker. */
export async function routeApi(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) return null;
  const match = /^\/api\/(express|python|worker)(\/.*)?$/.exec(url.pathname);
  if (!match) return Response.json({ error: "Unknown backend" }, { status: 404 });
  const origin = env[backends[match[1]]];
  if (!origin) return Response.json({ error: "Backend is not configured" }, { status: 503 });
  let target;
  try {
    target = new URL(origin);
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
      throw new Error("Invalid backend origin");
    }
    // Origins may include a service base path. The browser cannot choose an upstream host.
    target.pathname = `${target.pathname.replace(/\/$/, "")}${match[2] ?? "/"}`;
    target.search = url.search;
    target.hash = "";
  } catch {
    return Response.json({ error: "Invalid backend configuration" }, { status: 503 });
  }
  const headers = new Headers(request.headers);
  headers.delete("host");
  // Never trust a client's claimed forwarded address.
  headers.delete("x-forwarded-for");
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.slice(0, -1));
  if (request.headers.get("cf-connecting-ip")) {
    headers.set("x-forwarded-for", request.headers.get("cf-connecting-ip"));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const upstream = new Request(target, request);
    const response = await fetch(upstream, {
      headers,
      redirect: "manual",
      signal: controller.signal,
    });
    // Do not accidentally cache API replies at the browser or edge.
    const result = new Response(response.body, response);
    result.headers.set("Cache-Control", "no-store");
    return result;
  } catch {
    return Response.json({ error: "Backend unavailable" }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}

export function methodNotAllowed(request) {
  if (request.method === "GET" || request.method === "HEAD") return null;
  return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
}
