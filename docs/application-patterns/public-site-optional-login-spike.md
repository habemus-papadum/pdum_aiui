# Public site with optional login

**Status: planned spike for a future session.**

Demonstrate a public static application whose visitors can sign in to gain
additional capabilities. The primary use is access to funded services through
issued credentials. Editing application data is a possible extension of the
same authorization boundary.

Anonymous visitors can load and use the public application without a login
redirect. Signing in adds authorized capabilities to that application. This is
the optional-access facet of the [application patterns](./README.md), and should
produce a small example and reusable configuration guidance.

## Starting arrangement to investigate

Use a static frontend delivered by a Cloudflare site Worker. Keep the public
page available anonymously. Evaluate protecting selected API paths with
Cloudflare Access while the frontend offers an explicit sign-in action.

The protected service identifies the user, determines which capabilities that
user has, and issues an appropriate short-lived credential. The frontend uses
that credential to connect to a real supported service. Reuse the existing
[credential adapters](../../packages/aiui-cf-creds/README.md) and credential kit
where they fit.

Cloudflare Access's Bypass action disables enforcement for matching traffic;
it should not be assumed to provide optional authenticated identity on that
traffic. Confirm the public and protected path arrangement, login return flow,
and identity available at the protected endpoint before treating this as a
recipe. [Cloudflare Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)

## Work for the spike

1. Build a minimal public page with useful anonymous content, a sign-in action,
   and one service-backed feature. Display capability availability independently
   of whether the visitor can view the page.
2. Configure public delivery and protected service paths. Record the exact
   Cloudflare settings, including which application or policy protects each
   path. Keep the example's resource names and origins configurable.
3. Implement the explicit login and return to the application. Establish how the
   page discovers its current capabilities without automatically redirecting
   anonymous visitors into login. Verify the actual cookie and redirect behavior.
4. Reuse a supported credential flow for one funded service. Enforce the user's
   entitlement at the issuing endpoint. A successful login alone need not grant
   access to every funded service. Make one real browser-to-provider request.
5. Exercise the flow from local Vite development as well as the deployed site.
   Resolve any cross-origin login or credential requests explicitly. Keep the
   existing pasted-key and dev-key options usable as separate configured flows.
6. If a small data-editing example is useful, protect its write endpoint with
   the same capability model. Public readers should still see the public page.
   This extension is optional for the first spike.

## Evidence to collect

| Case | Expected result |
| --- | --- |
| Fresh anonymous browser | Public content works without login; funded capability is unavailable |
| Explicit login by an authorized user | Returns to the application and enables the funded feature |
| Credential issuance and provider call | Browser receives a suitable short-lived credential and successfully uses the real service |
| Anonymous or unauthorized direct request to the issuer | Does not receive a funded credential, regardless of frontend controls |
| Credential or authentication expiry | The application accurately reports availability and supports the next required refresh or sign-in |
| Local Vite frontend | The documented development flow reaches the intended deployed credential service |
| Optional protected edit | Authorized write succeeds; an unauthorized direct write fails |

Use distinct browser profiles for anonymous and authenticated checks so that
existing login state does not mask the flow. Use the application's actual entry
point as well as direct endpoint checks.

## Deliverables

- A small runnable experiment with deployment and local-development instructions.
- Exact public/protected routing, Access configuration, and login flow, including
  any settings that differ between development and deployment.
- A concise sequence showing login, capability discovery, credential issuance,
  and the direct provider request.
- A record of what can be reused across applications and what each application
  must configure: origins, Access policy, service entitlement, and credential
  adapter.
- Results for the cases above and a recommendation for the application-patterns
  guide. If the proposed Access arrangement does not provide the intended flow,
  document the smallest working alternative and the reason it is needed.

Hosting the static content in R2 instead of Static Assets should preserve the
same public-page and protected-service boundary; both storage choices do not
need separate implementations in the first spike.
