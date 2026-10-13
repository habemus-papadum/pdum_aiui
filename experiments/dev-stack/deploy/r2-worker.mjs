import { methodNotAllowed, routeApi } from "./gateway.mjs";

export default {
  async fetch(request, env) {
    const api = await routeApi(request, env);
    if (api) return api;
    const denied = methodNotAllowed(request);
    if (denied) return denied;
    let path;
    try {
      path = decodeURIComponent(new URL(request.url).pathname).slice(1) || "index.html";
      if (path.split("/").some((part) => part === ".." || part === ".") || path.includes("\\")) {
        return new Response("Invalid path", { status: 400 });
      }
    } catch {
      return new Response("Invalid path", { status: 400 });
    }
    const prefix = (env.STATIC_PREFIX ?? "site").replace(/\/$/, "");
    const object = await env.SITE.get(`${prefix}/${path}`);
    if (!object) return new Response("Not found", { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("ETag", object.httpEtag);
    headers.set("Content-Length", String(object.size));
    // Can be overridden by uploaded HTTP metadata; HTML should revalidate.
    if (!headers.has("Cache-Control"))
      headers.set("Cache-Control", "public, max-age=0, must-revalidate");
    if (request.headers.get("If-None-Match") === object.httpEtag) {
      headers.delete("Content-Length");
      return new Response(null, { status: 304, headers });
    }
    return new Response(request.method === "HEAD" ? null : object.body, { headers });
  },
};
