/**
 * End-to-end demo — the payoff.
 *
 *   npm run demo     (from exploration/proxy-jwt/)
 *
 * Boots the mock issuer + the stateless proxy in-process, then walks the whole
 * story against the REAL vendor APIs (needs OPENAI_API_KEY in env; other keys
 * optional):
 *
 *   1. the "two ways" the channel is instrumented (BYOK vs proxy) — just config
 *   2. log in → 15-min JWT
 *   3. proxy REST  (OpenAI chat)     with the JWT — real answer, real usage metered
 *   4. proxy WS    (OpenAI realtime) with the JWT — real session.created
 *   5. BYOK        (OpenAI chat)     with the real key — identical call, direct
 *   6. failure modes: expired JWT, revoked JWT, no-credit → all rejected
 *   7. per-user usage / balance from GET /usage
 *
 * Nothing is wired into the channel; this is a standalone spike.
 */

import { WebSocket } from "ws";
import { PROXY_URL, PROXY_WS_URL } from "./config.ts";
import { startIssuer } from "./issuer.ts";
import { startProxy } from "./proxy.ts";

// ── tiny logger ──────────────────────────────────────────────────────────────
const C = {
  d: (s: string) => `\x1b[2m${s}\x1b[0m`,
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`,
  c: (s: string) => `\x1b[1m\x1b[36m${s}\x1b[0m`,
};
const H = (s: string) => console.log(`\n${C.c(`▐ ${s}`)}`);
const OK = (s: string) => console.log(`  ${C.g("✔")} ${s}`);
const NO = (s: string) => console.log(`  ${C.r("✗")} ${s}`);
const I = (s: string) => console.log(`  ${C.d("·")} ${C.d(s)}`);
let pass = 0;
let failn = 0;
const check = (good: boolean, s: string) => {
  if (good) {
    pass++;
    OK(s);
  } else {
    failn++;
    NO(s);
  }
};

// ── the "two ways", as channel option objects (base URL + auth only) ─────────

function channelOptionsFor(mode: "byok" | "proxy", jwt?: string) {
  if (mode === "byok") {
    return {
      summarizer: { baseUrl: "https://api.openai.com", apiKey: env("OPENAI_API_KEY") },
      realtime: {
        url: "wss://api.openai.com/v1/realtime?intent=transcription",
        apiKey: env("OPENAI_API_KEY"),
      },
      elevenlabs: {
        url: "wss://api.elevenlabs.io/v1/speech-to-text/realtime",
        apiKey: env("ELEVEN_LABS_API_KEY"),
      },
    };
  }
  return {
    summarizer: { baseUrl: `${PROXY_URL}/rest/openai`, apiKey: jwt },
    realtime: { url: `${PROXY_WS_URL}/ws/openai/realtime-transcription`, apiKey: jwt },
    elevenlabs: { url: `${PROXY_WS_URL}/ws/elevenlabs/stt-realtime`, apiKey: jwt },
  };
}
const env = (k: string) => (process.env[k] ? `<${k}>` : "(unset)");

// ── helpers ──────────────────────────────────────────────────────────────────

async function postChat(url: string, bearer: string): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  return { status: res.status, text: (await res.text()).slice(0, 300) };
}

function wsFirstMessage(
  url: string,
  headers: Record<string, string>,
): Promise<{ outcome: string; detail: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    const t = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      resolve({ outcome: "timeout", detail: "no frame in 12s" });
    }, 12_000);
    const fin = (outcome: string, detail: string) => {
      clearTimeout(t);
      try {
        ws.close();
      } catch {}
      resolve({ outcome, detail });
    };
    ws.on("message", (d) => fin("message", d.toString().slice(0, 160)));
    ws.on("unexpected-response", (_q, res) => fin("http-error", `HTTP ${res.statusCode}`));
    ws.on("close", (code, r) => fin("closed", `code=${code} ${r.toString()}`));
    ws.on("error", (e) => fin("error", String((e as Error).message)));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const hasOpenAi = !!process.env.OPENAI_API_KEY;

  const iss = await startIssuer();
  const prx = await startProxy({ revocationCacheMs: 150 });
  I(`issuer @ ${iss.url} · proxy @ ${prx.url}`);

  H("1 · The two ways the channel is instrumented (only baseURL + auth change)");
  console.log("  BYOK  :", JSON.stringify(channelOptionsFor("byok"), null, 0));
  console.log("  PROXY :", JSON.stringify(channelOptionsFor("proxy", "<jwt>"), null, 0));
  I("every other channel option is identical — proxy mode is a config swap, not a code change");

  H("2 · Log in → 15-minute JWT");
  const login = (await (
    await fetch(`${iss.url}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: "github:octocat" }),
    })
  ).json()) as { token: string; claims: { sub: string; jti: string; exp: number } };
  const jwt = login.token;
  const ttlMin = Math.round((login.claims.exp - Date.now() / 1000) / 60);
  check(
    !!jwt && ttlMin >= 14 && ttlMin <= 15,
    `issued JWT for ${login.claims.sub} (ttl≈${ttlMin}m, jti=${login.claims.jti.slice(0, 8)}…)`,
  );

  if (hasOpenAi) {
    H("3 · Proxy REST — OpenAI chat through the proxy with the JWT (real key stays server-side)");
    const r = await postChat(`${prx.url}/rest/openai/v1/chat/completions`, jwt);
    check(
      r.status === 200,
      `POST /rest/openai/v1/chat/completions → ${r.status}` +
        (r.status === 200 ? "" : ` ${r.text}`),
    );

    H("4 · Proxy WS — OpenAI realtime through the proxy with the JWT");
    const w = await wsFirstMessage(`${PROXY_WS_URL}/ws/openai/realtime-linter`, {
      authorization: `Bearer ${jwt}`,
    });
    const live = w.outcome === "message" && w.detail.includes("session.created");
    check(live, `WS /ws/openai/realtime-linter → ${w.outcome}: ${w.detail}`);

    H("5 · BYOK — the identical OpenAI chat call, made directly with the real key");
    const b = await postChat(
      "https://api.openai.com/v1/chat/completions",
      process.env.OPENAI_API_KEY as string,
    );
    check(
      b.status === 200,
      `POST api.openai.com/v1/chat/completions → ${b.status}` +
        (b.status === 200 ? "" : ` ${b.text}`),
    );
  } else {
    H("3–5 · Live pass-through");
    I("OPENAI_API_KEY not set — skipping live REST/WS/BYOK calls");
  }

  H("6 · Failure modes — every bad credential is rejected");

  // expired: mint an already-expired token (exp 10s in the past — clear of the
  // verifier's 5s clock-skew leeway), so no real wait is needed.
  const expiredTok = iss.issuer.mint("github:octocat", ["openai"], -10).token;
  const expd = await postChat(`${prx.url}/rest/openai/v1/chat/completions`, expiredTok);
  check(
    expd.status === 401,
    `expired JWT → ${expd.status} ${expd.text.includes("expired") ? "(expired)" : ""}`.trim(),
  );

  // revoked: mint, revoke jti, let the proxy's short cache refresh
  const rvk = iss.issuer.mint("github:octocat", ["openai"]);
  iss.issuer.revoke(rvk.claims.jti);
  await sleep(300);
  const rvkRes = await postChat(`${prx.url}/rest/openai/v1/chat/completions`, rvk.token);
  check(
    rvkRes.status === 401,
    `revoked JWT → ${rvkRes.status} ${rvkRes.text.includes("revoked") ? "(revoked)" : ""}`.trim(),
  );

  // no credit: drain this user's balance, then a valid token still gets 402
  const brokeUser = "github:broke";
  const brokeTok = iss.issuer.mint(brokeUser, ["openai"]).token;
  prx.meter.balances.set(brokeUser, 0);
  const brokeRes = await postChat(`${prx.url}/rest/openai/v1/chat/completions`, brokeTok);
  check(brokeRes.status === 402, `no-credit user → ${brokeRes.status} (payment required)`);

  // WS with a garbage token is rejected at the upgrade
  const badWs = await wsFirstMessage(`${PROXY_WS_URL}/ws/openai/realtime-linter`, {
    authorization: "Bearer not.a.jwt",
  });
  check(badWs.outcome === "http-error", `WS with bad token → ${badWs.outcome}: ${badWs.detail}`);

  H("7 · Usage / balance (what 'show the user their usage' reads)");
  const usage = (await (await fetch(`${prx.url}/usage`)).json()) as {
    startingBalance: number;
    balances: Record<string, number>;
    events: Array<{ sub: string; vendor: string; surface: string; cost: number }>;
  };
  for (const [sub, bal] of Object.entries(usage.balances))
    I(`${sub}: balance ${bal}/${usage.startingBalance} micro-credits`);
  for (const e of usage.events) I(`charged ${e.sub} ${e.cost} for ${e.vendor} ${e.surface}`);

  H("Summary");
  if (failn === 0) OK(`all ${pass} checks passed`);
  else NO(`${failn}/${pass + failn} checks failed`);
  console.log("");

  await prx.close();
  await iss.close();
  process.exit(failn === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
