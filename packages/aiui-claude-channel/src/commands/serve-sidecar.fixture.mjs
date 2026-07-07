/**
 * A minimal Sidecar factory for serve.test.ts's `--sidecars` test — stands in
 * for a real sidecar package's export (e.g. the code reader's), reached by a
 * descriptor whose `module` is an absolute path, exactly the shape launchers
 * hand over. Lives inside the package because vitest's runner can only import
 * files under the project root (a real launch has no such limit).
 */
export function testSidecar(options) {
  return {
    name: "test",
    mount(app) {
      app.get("/__test_sidecar", (_req, res) => res.json({ root: options.root }));
      return {};
    },
  };
}
