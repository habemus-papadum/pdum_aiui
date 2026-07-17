/**
 * backend.test.ts — the relay's room logic, over real websockets.
 *
 * A real `http.Server` on an ephemeral port, real `ws` clients, no mocks: the
 * seams under test (`handleHttp` / `handleUpgrade`) are exactly what the channel
 * sidecar and the Lab's Vite plugin mount. The load-bearing claims: ink flows
 * client→host untouched; signaling is peer-stamped upward and peer-routed
 * downward (WebRTC is point-to-point); `videoStatus` replays on join so nobody
 * stares at unexplained black; and a host's death tells its clients.
 */
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createPencilBackend, type PencilBackend } from "./backend";
import { decode, encode, type RemotePresentation, type WireMessage } from "./protocol";

let server: Server;
let backend: PencilBackend;
let port: number;

beforeEach(async () => {
  backend = createPencilBackend({ prefix: "/pencil", session: { project: "/proj" } });
  server = createServer((req, res) => {
    if (!backend.handleHttp(req, res)) {
      res.statusCode = 404;
      res.end();
    }
  });
  server.on("upgrade", (req, socket, head) => {
    if (!backend.handleUpgrade(req, socket, head)) {
      socket.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no port");
  }
  port = address.port;
});

afterEach(async () => {
  backend.dispose();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A test peer: buffers messages, lets the test await the next one. */
class Peer {
  ws: WebSocket;
  private queue: WireMessage[] = [];
  private waiters: Array<(m: WireMessage) => void> = [];

  constructor(path: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    this.ws.on("message", (data) => {
      const message = decode(data.toString());
      if (!message) {
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(message);
      } else {
        this.queue.push(message);
      }
    });
  }

  next(): Promise<WireMessage> {
    const queued = this.queue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), 2000);
      this.waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  }

  async nextOf(type: string): Promise<WireMessage> {
    for (let i = 0; i < 10; i++) {
      const m = await this.next();
      if (m.type === type) {
        return m;
      }
    }
    throw new Error(`no ${type} frame arrived`);
  }

  send(message: WireMessage): void {
    this.ws.send(encode(message));
  }

  open(): Promise<void> {
    return new Promise((resolve) => this.ws.once("open", () => resolve()));
  }

  close(): void {
    this.ws.close();
  }
}

/** A registered host and a joined client, ready to talk. */
async function pair(): Promise<{ host: Peer; client: Peer; hostId: string; clientId: string }> {
  const host = new Peer("/pencil/host");
  await host.open();
  const registered = (await host.nextOf("registered")) as { type: "registered"; id: string };
  host.send({ type: "register", label: "lab" });

  const client = new Peer("/pencil/client");
  await client.open();
  await client.nextOf("sessions");
  client.send({ type: "join", host: registered.id });
  await client.nextOf("joined");
  const joined = (await host.nextOf("clientJoined")) as { type: "clientJoined"; client: string };
  return { host, client, hostId: registered.id, clientId: joined.client };
}

describe("the pencil relay", () => {
  it("carries the host's presentation into the session list and the joined frame", async () => {
    const client = new Peer("/pencil/client");
    await client.open();
    await client.nextOf("sessions");

    const host = new Peer("/pencil/host");
    await host.open();
    await host.nextOf("registered");
    const presentation: RemotePresentation = {
      title: "aiui intent",
      tools: ["draw"],
      navigation: true,
    };
    host.send({ type: "register", label: "intent", presentation });

    const update = (await client.nextOf("sessions")) as {
      sessions: Array<{ id: string; presentation?: unknown }>;
    };
    expect(update.sessions[0].presentation).toEqual(presentation);

    client.send({ type: "join", host: update.sessions[0].id });
    const joined = (await client.nextOf("joined")) as { presentation?: unknown };
    expect(joined.presentation).toEqual(presentation);
    host.close();
    client.close();
  });

  it("lists a registered host, with the sidecar's project attached", async () => {
    // Client first, so the registration is an OBSERVED broadcast rather than a
    // fact baked into the initial list — the update path is the one under test.
    const client = new Peer("/pencil/client");
    await client.open();
    await client.nextOf("sessions"); // initial list: empty

    const host = new Peer("/pencil/host");
    await host.open();
    await host.nextOf("registered");
    host.send({ type: "register", label: "lab" });

    const update = (await client.nextOf("sessions")) as {
      type: "sessions";
      sessions: Array<{ label: string; project?: string; busy: boolean }>;
    };
    expect(update.sessions).toHaveLength(1);
    expect(update.sessions[0]).toMatchObject({ label: "lab", project: "/proj", busy: false });
    host.close();
    client.close();
  });

  it("forwards ink intents to the host, untouched", async () => {
    const { host, client } = await pair();
    client.send({
      type: "strokeBegin",
      id: "s1",
      pointerType: "pen",
      tool: "draw",
      mode: "write",
      point: { u: 0.5, v: 0.5, t: 0 },
    });
    client.send({ type: "scroll", du: 0, dv: 0.25 });

    expect(await host.nextOf("strokeBegin")).toMatchObject({ id: "s1", tool: "draw" });
    expect(await host.nextOf("scroll")).toMatchObject({ dv: 0.25 });
    host.close();
    client.close();
  });

  it("stamps upward signaling with the sender, routes downward signaling to its one peer", async () => {
    const { host, client, clientId } = await pair();

    // A second client in the same room: the host's signal must NOT reach it.
    const other = new Peer("/pencil/client");
    await other.open();

    client.send({ type: "signal", data: { sdp: "answer" } });
    const up = (await host.nextOf("signal")) as { type: "signal"; peer?: string; data: unknown };
    expect(up.peer).toBe(clientId); // the relay's stamp, not the client's claim
    expect(up.data).toEqual({ sdp: "answer" });

    host.send({ type: "signal", peer: clientId, data: { sdp: "offer" } });
    expect(await client.nextOf("signal")).toMatchObject({ data: { sdp: "offer" } });
    host.close();
    client.close();
    other.close();
  });

  it("replays the host's last videoStatus on join — nobody stares at unexplained black", async () => {
    const host = new Peer("/pencil/host");
    await host.open();
    const registered = (await host.nextOf("registered")) as { type: "registered"; id: string };
    host.send({ type: "register", label: "lab" });
    host.send({ type: "videoStatus", state: "needsGesture", detail: "click the page" });
    await new Promise((r) => setTimeout(r, 50)); // let the cache land before the join

    const late = new Peer("/pencil/client");
    await late.open();
    await late.nextOf("sessions");
    late.send({ type: "join", host: registered.id });
    await late.nextOf("joined");
    expect(await late.nextOf("videoStatus")).toMatchObject({ state: "needsGesture" });
    host.close();
    late.close();
  });

  it("tells clients when their host goes away", async () => {
    const { host, client } = await pair();
    host.close();
    expect((await client.nextOf("hostGone")).type).toBe("hostGone");
    client.close();
  });

  it("serves info and sessions over HTTP, with CORS for the probes", async () => {
    const info = await fetch(`http://127.0.0.1:${port}/pencil/info`);
    expect(info.headers.get("access-control-allow-origin")).toBe("*");
    expect(await info.json()).toMatchObject({ ok: true, hosts: 0, clients: 0 });

    const missing = await fetch(`http://127.0.0.1:${port}/pencil/nope`);
    expect(missing.status).toBe(404); // confined to its own routes
  });
});
