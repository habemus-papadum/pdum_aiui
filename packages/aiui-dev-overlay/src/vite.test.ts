import type { HtmlTagDescriptor, Plugin } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aiuiDevOverlay } from "./vite";

const PORT_ENV = "VITE_AIUI_PORT";
const MOUNT_ID = "virtual:aiui-dev-overlay/mount";

// The hooks are registered as plain functions; grab them typed for direct calls.
const htmlTags = (plugin: Plugin): HtmlTagDescriptor[] =>
  (plugin.transformIndexHtml as () => HtmlTagDescriptor[])();
const loadMount = (plugin: Plugin): string | undefined =>
  (plugin.load as (id: string) => string | undefined)(MOUNT_ID);

const savedEnv = process.env[PORT_ENV];
beforeEach(() => {
  delete process.env[PORT_ENV];
});
afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env[PORT_ENV];
  } else {
    process.env[PORT_ENV] = savedEnv;
  }
});

describe("aiuiDevOverlay", () => {
  it("is a dev-server-only plugin", () => {
    expect(aiuiDevOverlay().apply).toBe("serve");
  });

  it("injects the port seed and the mount script when the env names a port", () => {
    process.env[PORT_ENV] = "50123";
    const tags = htmlTags(aiuiDevOverlay());
    expect(tags).toHaveLength(2);
    const [seed, mount] = tags;
    expect(seed.injectTo).toBe("head-prepend");
    expect(seed.children).toContain("window.__AIUI__");
    expect(seed.children).toContain("50123");
    expect(mount.attrs).toEqual({ type: "module", src: `/@id/${MOUNT_ID}` });
  });

  it("still mounts without a port, but injects no seed", () => {
    const tags = htmlTags(aiuiDevOverlay());
    expect(tags).toHaveLength(1);
    expect(tags[0].attrs?.src).toBe(`/@id/${MOUNT_ID}`);
  });

  it("prefers an explicit port option over the env", () => {
    process.env[PORT_ENV] = "50123";
    const tags = htmlTags(aiuiDevOverlay({ port: 4242 }));
    expect(tags[0].children).toContain("4242");
    expect(tags[0].children).not.toContain("50123");
  });

  it("injects no seed for a non-numeric env value", () => {
    // Also the injection guard: whatever the env holds, only a validated
    // integer is ever interpolated into the inline script.
    process.env[PORT_ENV] = "50123; alert(1)";
    const tags = htmlTags(aiuiDevOverlay());
    expect(tags).toHaveLength(1);
    expect(tags[0].attrs?.type).toBe("module");
  });

  it("serves a mount module that passes the port through", () => {
    process.env[PORT_ENV] = "50123";
    const plugin = aiuiDevOverlay();
    expect((plugin.resolveId as (id: string) => string | undefined)(MOUNT_ID)).toBe(MOUNT_ID);
    const code = loadMount(plugin);
    expect(code).toContain('from "@habemus-papadum/aiui-dev-overlay"');
    expect(code).toContain(
      'mountIntentTool({ force: true, port: 50123, debugUrl: "/__aiui/debug" })',
    );
  });

  it("serves a portless mount module when no channel is running", () => {
    expect(loadMount(aiuiDevOverlay())).toContain(
      'mountIntentTool({ force: true, debugUrl: "/__aiui/debug" })',
    );
  });

  it("passes the configured format to the mount", () => {
    process.env[PORT_ENV] = "50123";
    expect(loadMount(aiuiDevOverlay({ format: "text-concat" }))).toContain(
      'mountIntentTool({ force: true, port: 50123, format: "text-concat", debugUrl: "/__aiui/debug" })',
    );
  });

  it("passes the configured actor to the mount (trace provenance)", () => {
    process.env[PORT_ENV] = "50123";
    expect(loadMount(aiuiDevOverlay({ actor: "agent" }))).toContain(
      'mountIntentTool({ force: true, port: 50123, actor: "agent", debugUrl: "/__aiui/debug" })',
    );
    // Omitted → not serialized: the widget resolves the actor at runtime
    // (the tab's aiui-actor opt-in toggle, else "human").
    expect(loadMount(aiuiDevOverlay())).not.toContain("actor");
  });

  it("seeds the source root — explicit option, or the resolved Vite root", () => {
    const explicit = aiuiDevOverlay({ sourceRoot: "/repo/app" });
    expect(htmlTags(explicit)[0].children).toContain('window.__AIUI__.sourceRoot = "/repo/app";');

    const fromConfig = aiuiDevOverlay();
    (fromConfig.configResolved as (c: { root: string }) => void)({ root: "/resolved/root" });
    expect(htmlTags(fromConfig)[0].children).toContain(
      'window.__AIUI__.sourceRoot = "/resolved/root";',
    );
  });

  it("mount: false keeps the port seed and drops the auto-mount", () => {
    process.env[PORT_ENV] = "50123";
    const plugin = aiuiDevOverlay({ mount: false });
    const tags = htmlTags(plugin);
    expect(tags).toHaveLength(1);
    expect(tags[0].children).toContain("window.__AIUI__");
  });

  it("installs the session bus with role 'app' by default", () => {
    process.env[PORT_ENV] = "50123";
    const code = loadMount(aiuiDevOverlay());
    expect(code).toContain('installSessionBus({ port: 50123, role: "app" });');
    expect(code).toContain("installToolsBridge({ port: 50123 });");
  });

  it("carries the configured session role and label", () => {
    process.env[PORT_ENV] = "50123";
    expect(loadMount(aiuiDevOverlay({ session: { role: "code", label: "Reader" } }))).toContain(
      'installSessionBus({ port: 50123, role: "code", label: "Reader" });',
    );
  });

  it("session: false skips the bus (bridge + mount stay)", () => {
    process.env[PORT_ENV] = "50123";
    const code = loadMount(aiuiDevOverlay({ session: false }));
    expect(code).not.toContain("installSessionBus");
    expect(code).toContain("installToolsBridge");
    expect(code).toContain("mountIntentTool");
  });

  it("code:true points the 'Code' button at the served reader route", () => {
    process.env[PORT_ENV] = "50123";
    expect(loadMount(aiuiDevOverlay({ code: true }))).toContain('codeUrl: "/__aiui/code"');
  });

  it("omits the 'Code' button when code is not set", () => {
    process.env[PORT_ENV] = "50123";
    expect(loadMount(aiuiDevOverlay({}))).not.toContain("codeUrl:");
  });

  it("intentTool: false is a contributor view — bus + bridge, no turn host", () => {
    process.env[PORT_ENV] = "50123";
    const code = loadMount(aiuiDevOverlay({ intentTool: false, session: { role: "code" } }));
    expect(code).toContain('installSessionBus({ port: 50123, role: "code" });');
    expect(code).toContain("installToolsBridge({ port: 50123 });");
    // No hosting overlay: no mount, no keep/observer, not even the import.
    expect(code).not.toContain("mountIntentTool");
    expect(code).not.toContain("MutationObserver");
  });
});

describe("the served pages (/__aiui routes)", () => {
  const DEBUG_MOUNT_ID = "virtual:aiui-dev-overlay/debug";

  /** Register the middleware and return a driver for one GET. */
  function serve(plugin: Plugin): (url: string) => { status: number; body: string } | undefined {
    let handler: ((req: { url?: string }, res: unknown, next: () => void) => void) | undefined;
    (plugin.configureServer as (server: unknown) => void)({
      middlewares: {
        use(fn: (req: { url?: string }, res: unknown, next: () => void) => void) {
          handler = fn;
        },
      },
    });
    return (url) => {
      let out: { status: number; body: string } | undefined;
      let nexted = false;
      const res = {
        statusCode: 200,
        setHeader() {},
        end(body: string) {
          out = { status: this.statusCode, body };
        },
      };
      handler?.({ url }, res, () => {
        nexted = true;
      });
      return nexted ? undefined : out;
    };
  }

  it("serves the trace debugger at /__aiui/debug, port-seeded, booting the debug-ui page", () => {
    process.env[PORT_ENV] = "50123";
    const get = serve(aiuiDevOverlay());
    const page = get("/__aiui/debug?session=x");
    expect(page?.status).toBe(200);
    expect(page?.body).toContain("aiui · lowering traces");
    expect(page?.body).toContain("window.__AIUI__.port = 50123;");
    expect(page?.body).toContain(`/@id/${DEBUG_MOUNT_ID}`);
    // Anything else falls through to the app.
    expect(get("/somewhere/else")).toBeUndefined();
  });

  it("serves the reader route only when code: true; the debug route is always on", () => {
    const withoutCode = serve(aiuiDevOverlay());
    expect(withoutCode("/__aiui/code")).toBeUndefined();
    expect(withoutCode("/__aiui/debug")?.status).toBe(200);

    const withCode = serve(aiuiDevOverlay({ code: true }));
    expect(withCode("/__aiui/code")?.body).toContain("aiui · code reader");
  });

  it("the debug virtual module mounts the shared debug-ui page with the port", () => {
    process.env[PORT_ENV] = "50123";
    const plugin = aiuiDevOverlay();
    const code = (plugin.load as (id: string) => string | undefined)(DEBUG_MOUNT_ID);
    expect(code).toContain('from "@habemus-papadum/aiui-dev-overlay/debug-ui"');
    expect(code).toContain("mountDebugPage({ port: 50123 });");
    delete process.env[PORT_ENV];
    expect((aiuiDevOverlay().load as (id: string) => string | undefined)(DEBUG_MOUNT_ID)).toContain(
      "mountDebugPage({});",
    );
  });
});
