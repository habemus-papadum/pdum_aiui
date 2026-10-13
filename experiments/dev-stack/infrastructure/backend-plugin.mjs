/** Routing only. The supervisor owns startup/cleanup; this plugin owns browser paths. */
export function backendPlugin({ instance, middleware = {}, services = {} }) {
  return {
    name: "dev-stack-backends",
    apply: "serve",
    config() {
      return {
        server: {
          proxy: Object.fromEntries(
            Object.entries(services).map(([name, backend]) => {
              const prefix = `/api/${name}`;
              return [
                `^${prefix}(?:/|\\?|$)`,
                {
                  target: backend.url,
                  changeOrigin: true,
                  ws: true,
                  rewrite: (path) => {
                    const rest = path.slice(prefix.length);
                    return rest.startsWith("?") ? `/${rest}` : rest || "/";
                  },
                },
              ];
            }),
          ),
        },
      };
    },
    configureServer(server) {
      server.middlewares.use("/__dev/instance", (_request, response) => {
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Cache-Control", "no-store");
        response.end(JSON.stringify({ instance, routes: Object.keys(services) }));
      });
      for (const [name, app] of Object.entries(middleware)) {
        server.middlewares.use(`/api/${name}`, app);
      }
    },
  };
}
