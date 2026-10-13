let requests = 0;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/info") {
      return Response.json(
        {
          backend: "worker",
          instance: env.INSTANCE_ID ?? "production",
          requests: ++requests,
          query: Object.fromEntries(url.searchParams),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (request.method === "POST" && url.pathname === "/echo") {
      try {
        return Response.json({ backend: "worker", body: await request.json() });
      } catch {
        return Response.json({ error: "Expected JSON" }, { status: 400 });
      }
    }
    return Response.json({ error: "Unknown Worker route" }, { status: 404 });
  },
};
