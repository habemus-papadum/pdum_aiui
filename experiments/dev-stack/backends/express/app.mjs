import express from "express";

/** Export an app, not a listener: Vite can mount it without allocating another port. */
export function createApp(instance = "production") {
  const app = express();
  let requests = 0;
  app.use(express.json());
  app.get("/info", (request, response) => {
    response.set("Cache-Control", "no-store").json({
      backend: "express",
      instance,
      requests: ++requests,
      query: request.query,
    });
  });
  app.post("/echo", (request, response) =>
    response.json({ backend: "express", body: request.body }),
  );
  app.use((_request, response) => response.status(404).json({ error: "Unknown Express route" }));
  return app;
}
