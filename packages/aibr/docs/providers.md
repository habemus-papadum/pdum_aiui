# Browser discovery providers

A provider is an executable that exchanges one JSON request and one JSON response with aibr.
It can be written in any language. It locates CDP endpoints and optionally prepares connectivity;
the Chrome DevTools MCP process still runs on the agent machine.

Register a provider once in user configuration:

```sh
aibr provider add office --command /absolute/path/to/provider -- optional arguments
aibr provider discover office
aibr target add desktop --provider office --id laptop/research
aibr codex --target desktop
# Or discover candidates interactively:
aibr codex --pick
```

The executable receives its configured argument array without shell evaluation. It reads a
single JSON line on stdin, writes only its JSON response to stdout, writes diagnostics to
stderr, and exits. The default timeout is 15 seconds; `timeoutMs` in its user configuration can
set 1–300000 ms. Output is bounded to 1 MiB. Errors and invalid responses fail the launch;
there is no silent fallback to another browser.

## Discover

Request:

```json
{ "schemaVersion": 1, "operation": "discover" }
```

Response:

```json
{
  "schemaVersion": 1,
  "candidates": [
    {
      "id": "laptop/research",
      "label": "Research browser",
      "host": "laptop",
      "detail": "SSH reverse forward on port 19223"
    }
  ]
}
```

IDs are opaque strings and must be unique within one response. Discovery does not establish
tunnels, start browsers, or run commands that require an interactive terminal. The candidate's
ID, rather than a transient port, is what a saved target records.

## Resolve and connect

Request:

```json
{ "schemaVersion": 1, "operation": "resolve", "id": "laptop/research" }
```

If connectivity exists, return an endpoint reachable **from this machine**:

```json
{ "schemaVersion": 1, "endpoint": "http://127.0.0.1:19223" }
```

If it must be established first, return:

```json
{ "schemaVersion": 1, "needsConnect": true }
```

aibr then sends `{"schemaVersion":1,"operation":"connect","id":"laptop/research"}`.
`connect` must be idempotent and return an endpoint after connectivity is ready. It may reuse
an SSH ControlMaster, ask a service manager to start a tunnel, or contact a rendezvous service.
Any tunnel it starts must have an independent lifetime and detached stdio. The provider must
exit; aibr will exec the agent and cannot supervise the tunnel afterward. Tunnel status and
stop operations belong to the provider's own CLI or service manager.

`resolve` is read-only. `explain` and `--dry-run` may call it but never call `connect`.

For errors return `{"schemaVersion":1,"error":"Actionable explanation"}` or exit nonzero.
For authenticated rendezvous systems, put authentication in the tunnel/proxy layer or supply
a signed `wss:` URL. Direct custom WebSocket authentication headers are not part of version 1.
Use a full WebSocket URL for proxy routing that cannot be inferred from `/json/version`.

## Minimal provider for an existing tunnel

```js
#!/usr/bin/env node
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const reply = request.operation === "discover"
  ? { candidates: [{ id: "research", label: "Research via my existing tunnel" }] }
  : request.id === "research"
    ? { endpoint: "http://127.0.0.1:19223" }
    : { error: "Unknown browser target" };
console.log(JSON.stringify({ schemaVersion: 1, ...reply }));
```

## Manual SSH examples

When the agent machine can SSH to the browser machine, run this on the **agent machine**:

```sh
ssh -N -L 127.0.0.1:19223:127.0.0.1:9223 browser-host
```

When the browser machine can SSH to the agent machine, run this on the **browser machine**:

```sh
ssh -N -R 127.0.0.1:19223:127.0.0.1:9223 agent-host
```

In either case the agent connects to `http://127.0.0.1:19223`. Keep that SSH command in its own
terminal or use your existing tunnel manager. A mesh network supplies reachability, but Chrome
CDP still listens on loopback: use SSH over the mesh or an explicitly configured authenticated
forwarder. A reachable mesh hostname alone does not expose a loopback browser port.
