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
    expect(code).toContain("mountIntentTool({ force: true, port: 50123 })");
  });

  it("serves a portless mount module when no channel is running", () => {
    expect(loadMount(aiuiDevOverlay())).toContain("mountIntentTool({ force: true })");
  });

  it("passes the configured format to the mount", () => {
    process.env[PORT_ENV] = "50123";
    expect(loadMount(aiuiDevOverlay({ format: "text-concat" }))).toContain(
      'mountIntentTool({ force: true, port: 50123, format: "text-concat" })',
    );
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
});
