import { methodNotAllowed, routeApi } from "./gateway.mjs";

export default {
  async fetch(request, env) {
    const api = await routeApi(request, env);
    if (api) return api;
    return methodNotAllowed(request) ?? env.ASSETS.fetch(request);
  },
};
