/**
 * The mint decision (pure of HTTP plumbing): keyless is a LOUD 503 with the
 * remedy, a good mint answers the vendor's own wire shape, vendor refusal is
 * a 502 that names the cause.
 */
import { describe, expect, it } from "vitest";
import { mintOutcome } from "./mint-backend";

const mintedFetch = (async () =>
  new Response(JSON.stringify({ value: "ek_minted", expires_at: 42 }), {
    status: 200,
  })) as unknown as typeof fetch;

describe("mintOutcome", () => {
  it("keyless → 503 with the remedy, never a silent failure", async () => {
    const outcome = await mintOutcome({ session: {} }, { resolveKey: () => undefined });
    expect(outcome.status).toBe(503);
    expect(String(outcome.body.error)).toContain("OPENAI_API_KEY");
  });

  it("mints with the resolved key and answers the vendor wire shape", async () => {
    const outcome = await mintOutcome(
      { session: { type: "realtime", model: "gpt-realtime-2.1" } },
      { resolveKey: () => "sk-server-side", ttlSeconds: 900, fetchImpl: mintedFetch },
    );
    expect(outcome).toEqual({ status: 200, body: { value: "ek_minted", expires_at: 42 } });
  });

  it("a vendor refusal surfaces as 502 with the cause", async () => {
    const refused = (async () =>
      new Response("bad key", { status: 401 })) as unknown as typeof fetch;
    const outcome = await mintOutcome(
      { session: {} },
      { resolveKey: () => "sk-stale", fetchImpl: refused },
    );
    expect(outcome.status).toBe(502);
    expect(String(outcome.body.error)).toContain("401");
  });

  it("a malformed body is a 400", async () => {
    const outcome = await mintOutcome(
      { session: "not an object" },
      { resolveKey: () => "sk-x", fetchImpl: mintedFetch },
    );
    expect(outcome.status).toBe(400);
  });
});
