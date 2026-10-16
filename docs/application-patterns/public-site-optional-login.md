# Public site with optional login

**Status: proven by a spike (2026-10-14) at `authtest.habemus-papadum.net`.**

A statically delivered application that anyone can use without logging in, and
that offers an explicit **Sign in** action. Signing in adds capabilities: the
page can obtain short-lived credentials from a broker and use them to call a
service directly from the browser. Anonymous visitors are never redirected into
a login flow.

This is the optional-access facet of the [application patterns](./README.md).
It composes with the credential broker from the
[credential adapters](../../packages/aiui-cf-creds/README.md): the broker is the
protected part, and the page around it is public.

## The shape

One hostname with two Workers. Cloudflare Access protects only the API path.

```
authtest.habemus-papadum.net/*       → site Worker   (Static Assets; public)
authtest.habemus-papadum.net/api/*   → api Worker    (Access app on /api; identity + broker)
authtest.habemus-papadum.net/svc/*   → api Worker    (public; test "provider", bearer-credential only)
```

- The **site Worker** serves the built Vite app from Static Assets and is
  attached as a Custom Domain on the hostname.
- The **api Worker** is attached by a zone route on `/api/*`. A route on a
  more specific path wins over the Custom Domain on the same hostname; this
  was verified, and no service binding is needed.
- **Access** has one self-hosted application whose domain is
  `authtest.habemus-papadum.net/api`. It covers `/api` and every path under
  it, and nothing else: `/`, `/session`, `/svc/*` and `/apifoo` are not
  gated.
- **Same origin is deliberate.** The Access cookie is issued for the
  hostname, so page → `/api` calls carry it with no CORS and no SameSite
  concerns.

No Bypass policy is involved. Bypass turns enforcement off for matching
traffic and does not provide an optional identity on it. Instead, public paths
are simply outside the Access app's domain, and the protected path carries the
identity.

## Access configuration

Prerequisites, done once per account and outside this playbook: a Zero Trust
team (here `habemus-papadum.cloudflareaccess.com`) and a login method. The
spike used a Google Workspace SAML login method.

### Wrangler cannot create Access applications

As of Wrangler 4.151, there is no Access command, and `wrangler login` offers
no Access or Zero Trust OAuth scope (`wrangler login --scopes-list`). The
Access application is created in one of three ways:

- the **API**, with an account API token holding
  - *Access: Apps and Policies → Edit*
  - *Access: Organizations, Identity Providers, and Groups → Read* (to look up
    the IdP id)
- **OpenTofu/Terraform** (`cloudflare_zero_trust_access_application`), for
  estates already managed as infrastructure code;
- the **dashboard**, entering the same settings by hand.

The application's **AUD tag** is the one value the Workers need back from this
step.

### The application the spike used

Create it **before** the first deploy of the protected route, so the path is
never served ungated. The Access API accepts policies inline on the app.

```sh
# Idempotent: PUT if an app with this name exists, POST otherwise.
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/apps" \
  -H "Authorization: Bearer $CLOUDFLARE_ACCESS_API_TOKEN" -H "content-type: application/json" \
  -d '{
    "name": "authtest api",
    "type": "self_hosted",
    "domain": "authtest.habemus-papadum.net/api",
    "destinations": [{ "type": "public", "uri": "authtest.habemus-papadum.net/api" }],
    "allowed_idps": ["<Google Workspace IdP id>"],
    "auto_redirect_to_identity": true,
    "session_duration": "24h",
    "app_launcher_visible": false,
    "http_only_cookie_attribute": true,
    "same_site_cookie_attribute": "none",
    "options_preflight_bypass": true,
    "policies": [{
      "name": "workspace members",
      "decision": "allow",
      "include": [{ "email_domain": { "domain": "habemus-papadum.net" } }]
    }]
  }'
# → .result.aud is the AUD tag
```

| Setting | Why |
| --- | --- |
| `domain` is a path (`host/api`) | Gates only the API; the rest of the hostname stays public |
| `allowed_idps` + `auto_redirect_to_identity` | Login goes straight to the Workspace IdP; no Cloudflare chooser, no one-time PIN |
| Allow `email_domain` | Who may **log in**. Entitlement to a service is a separate, narrower check in the Worker |
| `same_site_cookie_attribute: none` | Lets the cookie ride cross-origin calls from a local Vite page; see [Local development](#local-development). `lax` suffices if nothing ever calls cross-origin |
| `options_preflight_bypass: true` | CORS preflights carry no cookie; Access lets `OPTIONS` through to the Worker instead of redirecting it to login |

## Login flow

The **Sign in** button navigates the top-level page to a protected endpoint
that exists only to bounce back:

```ts
// page
location.href = `${ORIGIN}/api/login?return=${encodeURIComponent(location.href)}`;
```

```ts
// api Worker: Access has already run the login by the time this executes
case "/api/login":
  return new Response(null, { status: 302, headers: { location: safeReturn(url.searchParams.get("return")) } });
```

`safeReturn` accepts only same-origin relative paths, plus `http://localhost`
and other loopback origins for development, so the endpoint is never an open
redirect.

The sequence:

1. **Click Sign in.** The browser goes to `/api/login?return=…`.
2. **Access sees no cookie.** It responds 302 to
   `<team>.cloudflareaccess.com/cdn-cgi/access/login/<host>?…&redirect_url=/api/login…`.
3. **Workspace login.** Access redirects to the Workspace IdP, and the user
   authenticates.
4. **Access sets the cookie.** On return, Access sets `CF_Authorization` on
   the hostname and replays `/api/login?return=…`.
5. **Back to the page.** The Worker responds 302 to `return`, and the page
   reloads.
6. **Discovery runs.** It now finds a session.

Sign out is a link to `/cdn-cgi/access/logout` on the same hostname.

## Capability discovery without a forced login

On load, the page asks the protected API who it is but **does not follow
redirects**:

```ts
const probe = await fetch(`${ORIGIN}/api/me`, { credentials: "include", redirect: "manual" });
const me = probe.ok ? await probe.json() : null;
// anonymous  → probe.type === "opaqueredirect" (status 0): Access wanted to log in
// signed in  → 200 { identity: { email }, capabilities: { test: true|false }, accessExpires }
```

`redirect: "manual"` is what makes the Access-gated path safe to probe: an
anonymous visitor's 302 becomes an opaque result instead of a background trip
to the IdP, which would otherwise surface as a CORS error.

**Capabilities are computed by the API, not the page.** `/api/me` returns one
boolean per capability. The page shows signed-in, signed-in but not entitled,
or anonymous, and enables controls from those booleans. That is presentation
only: every enforcement point checks again.

### Optional: identity on a public path

The site Worker also exposes `/session`, which Access does not gate. It
verifies the `CF_Authorization` cookie itself if one is present, checking the
signature against the team's JWKS and the app's AUD. It reports
`{ signedIn, email, expires }` and never redirects. The kit already has the
verifier:

```ts
import { verifyAccessToken } from "@habemus-papadum/cf-creds-worker";
const id = await verifyAccessToken(cookieValue, { teamDomain, audience: ACCESS_APP_AUD });
```

Observed: although the Access app covers only `/api`, the browser sends
`CF_Authorization` to `/session` as well, and a signed-in visitor gets
`{ "signedIn": true, "email": "…", "expires": "…" }`, with `expires` equal to
login time plus the app's `session_duration`.

This is the "optional authenticated identity on public traffic" that a Bypass
policy cannot provide. Use it only when a public endpoint needs to personalise
its own response. For discovery, `/api/me` with `redirect: "manual"` is
sufficient, and it is what the spike's UI relies on.

## Credential issuance with the credential manager

The broker route lives under `/api/credentials/<provider>`, so Access gates it.
It follows the `cf-browser-credentials` envelope contract: any JSON with an
ISO-8601 `expiration`. Every broker request goes through the same three steps:

1. **Verify the Access JWT.** `verifyAccessIdentity` checks the signature,
   issuer and **AUD**. This is not a mere header-presence check, so the route
   stays protected even if Access is misconfigured.
2. **Check entitlement.** Logging in grants nothing by itself; the Worker
   checks the identity against a per-service rule.
3. **Mint and log.** Mint the short-lived credential, and log the outcome
   with `logMint` (allowed and denied alike).

```ts
let identity: AccessIdentity;
try {
  identity = await verifyAccessIdentity(request, { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_APP_AUD });
} catch (err) {
  return Response.json({ error: "unauthenticated" }, { status: 401 });
}
// …
case "/api/credentials/test": {
  if (!capabilities(env, identity).test) {
    logMint({ provider: "test", outcome: "denied", identity, reason: "not entitled", request });
    return Response.json({ error: "not entitled to test service" }, { status: 403 });
  }
  const cred = await mintTestToken(env.TEST_SIGNING_KEY, { sub: identity.email, scope: "svc:echo" }, 120);
  logMint({ provider: "test", outcome: "allowed", identity, expiration: cred.expiration, request });
  return Response.json(cred); // { token, scope, subject, expiration }
}
```

Entitlement in the spike was a Worker var, `TEST_ENTITLED`: a comma-separated
list of emails or `*@domain` rules. `/api/me` and the broker route share the
same `capabilities()` function, so what the page shows and what the broker
enforces cannot drift apart.

The page consumes the route with the kit's `CredentialManager`, unmodified:

```ts
import { CredentialManager } from "@habemus-papadum/cf-browser-credentials";

const manager = new CredentialManager<{ token: string; expiration: string }>({
  url: `${ORIGIN}/api/credentials/test`, // same-origin relative when deployed
  refreshMarginMs: 30_000,               // the default 10 min exceeds the test credential's 2 min life
});
manager.onRotate((c) => showExpiry(c.expiration));

const { token } = await manager.get();   // cached; refreshed inside the margin; concurrent calls deduped
await fetch(`${ORIGIN}/svc/echo`, { headers: { authorization: `Bearer ${token}` } });
```

Against a same-origin URL, the manager's login bounce is off by default, so a
403 for a signed-in but non-entitled user surfaces as an error rather than a
popup. Real providers slot in as further routes, such as the existing AWS,
OpenAI or ElevenLabs adapters, with no change to the page-side pattern.

## The test provider

The spike did not use a funded service. A fake provider exercises every
boundary that a real one would:

- **Issuer:** `GET /api/credentials/test` sits behind Access and checks
  entitlement. It returns
  `{ token: "test_<claims>.<hmac>", scope, subject, expiration }`, valid for
  120 s. The HMAC key is a Wrangler secret (`TEST_SIGNING_KEY`).
- **Provider:** `GET /svc/echo` is public; Access is not in front of it. It
  accepts only a valid, unexpired bearer token, and echoes the token's claims
  with a 200. Anything else gets a 401.

Because `/svc/echo` is outside Access, a successful call shows that the
**credential alone** authorizes the provider request, which is exactly the
situation with a real third-party service. The short TTL makes the manager's
refresh observable within a couple of minutes: the page counts `onRotate`
events. Something like this belongs in the credential kit as a
first-class test provider, so any application can validate its login and
broker wiring without spending money.

## Results

| Case | Result |
| --- | --- |
| Fresh anonymous browser (incognito) | Public page and its tool work; no redirect; "Anonymous"; gated feature disabled |
| Explicit login by an entitled user | Workspace login, back on the same page, signed in; `test` available |
| Credential issuance and provider call | Manager obtained a 2-minute credential; `/svc/echo` returned 200 with the user's email as `sub` |
| Credential expiry | Manager rotated the credential before expiry; later calls kept succeeding |
| Signed-in user not entitled | Signed in; `test` unavailable; direct `GET /api/credentials/test` → 403 |
| Anonymous direct request to `/api/*` (including the broker, with any method) | 302 to the team login: Access stops it before the Worker |
| Forged `Cf-Access-Jwt-Assertion` header | 302: Access ignores it; the Worker would reject it anyway |
| Forged `CF_Authorization` cookie on `/session` | `signedIn: false`: the site Worker verifies, not trusts |
| `/svc/echo` with no token or a forged token | 401 |
| Signed-in visitor on public `/session` | `signedIn: true` with email and expiry: the Access cookie reaches paths outside the app's domain |
| Local Vite frontend (Chrome) | Sign-in returns to `localhost`; discovery, credential issuance and provider calls work against the deployed services |
| Local Vite frontend (Safari, default settings) | Login completes but the page stays anonymous: `/session` reports `no cookie`, `/api/me` is `opaqueredirect`. Disabling "Prevent cross-site tracking" makes it work |
| Protected edit | Not attempted; it would be one more `capabilities()` key checked at a write route |

The anonymous, forged-request and CORS checks were run with `curl`. The browser
rows were run by hand in separate profiles, an anonymous one and a logged-in
one, against both the deployed entry point and a local Vite server.

## Local development

Development uses the **same deployed services** as production. Vite serves the
page on `localhost`, and the page calls the deployed origin cross-origin with
`credentials: "include"`, the same way the credential service is consumed in
development elsewhere. Nothing about login, entitlement or minting is
simulated locally.

The only development setting is the origin the page talks to:

```sh
# site/app/.env.development: read by `vite` (dev), ignored by `vite build`
VITE_AUTH_ORIGIN=https://authtest.habemus-papadum.net
```

```ts
const ORIGIN: string = import.meta.env.VITE_AUTH_ORIGIN ?? ""; // empty when deployed → same-origin
```

What makes the cross-origin calls work:

- **The Access app:** `same_site_cookie_attribute: "none"` and
  `options_preflight_bypass: true`, as in the configuration above.
- **Worker CORS:** the Workers echo loopback origins, any port, with
  credentials allowed, using `corsHeadersFor` from
  `@habemus-papadum/cf-loopback-cors`. Other origins get no CORS headers.
  Simple `GET`s such as `/session`, `/api/me` and the broker route need
  nothing more.
- **Preflights:** `corsHeadersFor` emits only allow-origin and
  allow-credentials. A route that receives non-simple requests must answer
  `OPTIONS` with `access-control-allow-headers` and `-methods` itself. In
  the spike, that was only the `/svc/echo` stand-in, because of its
  `Authorization` header. Real providers answer their own preflights.
- **Login return:** `/api/login` accepts a loopback `return` URL, so sign-in
  lands back on the dev page. For broker calls, the manager's popup login
  bounce, which is on by default for cross-origin URLs, covers a missing
  session as well.

**Use Chrome, in a normal window, for local development.** From `localhost`,
the deployed hostname is a different site, so `CF_Authorization` is a
third-party cookie there:

- **Chrome** sends it.
- **Safari's** default "Prevent cross-site tracking" withholds it. Login
  succeeds, but every later call is anonymous.
- **Chrome Incognito** blocks third-party cookies by default.

Deployed pages are same-origin and are unaffected in every browser.

The pasted-key and `devKeys` flows remain separate credential sources and are
unaffected by any of this.

## Deployment checklist

- **Workers:** `workers_dev: false` and `preview_urls: false` on both. An
  off-route URL bypasses Access.
- **Site Worker:**
  - `routes: [{ pattern: "<host>", custom_domain: true }]`;
  - `assets.run_worker_first: ["/session"]` only, so everything else is
    served straight from Static Assets.
- **api Worker:** `routes: [{ pattern: "<host>/api/*", zone_name }]`, plus any
  public provider path.
- **Workers config:** vars `ACCESS_TEAM_DOMAIN` and `ACCESS_APP_AUD`.
  Entitlement is a var or a store; signing keys and vendor keys are secrets.
- **Deploy order:** Access app, then api Worker, then site Worker.
- `observability.enabled: true`, so `logMint` lines land in Workers Logs.

## Reusable versus per-application

| Reusable as is | Each application configures |
| --- | --- |
| Hostname-plus-`/api` layout and route arrangement | Hostname, zone, Worker names |
| `/api/login?return=` bounce and `safeReturn` | The Access app (path domain, IdP, allow policy) and its AUD |
| `/api/me` + `redirect: "manual"` discovery | Capability names and entitlement rules |
| `verifyAccessIdentity` / `verifyAccessToken`, `logMint` (`cf-creds-worker`) | Which provider routes the broker exposes, and their secrets |
| `CredentialManager` and the provider adapters (`cf-browser-credentials`, `aiui-cf-creds`) | The page's UI for anonymous, signed-in and entitled states |
| `corsHeadersFor` (`cf-loopback-cors`) and the cross-origin Access cookie settings | `VITE_AUTH_ORIGIN` for development |

## Recommendation

Use this arrangement as the pattern for public sites with optional login:

- a path-scoped Access app on the API only;
- an explicit `/api/login` bounce;
- `/api/me` probed with `redirect: "manual"`;
- entitlement enforced in the broker.

It needs no Bypass policy and no custom session layer, and it reuses the
credential kit unchanged.

Follow-up: add a test provider (issuer route plus verifier) to the credential
kit.
