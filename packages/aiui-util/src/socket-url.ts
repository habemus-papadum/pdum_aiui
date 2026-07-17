/**
 * Re-host a Chrome DevTools websocket URL onto the endpoint that answered.
 *
 * Chrome reports its browser socket as `ws://127.0.0.1:<its own port>/…`, which
 * is a lie from anywhere but that machine — a tunneled remote browser
 * (docs/guide/remote) is reached at the forwarded host:port we just fetched
 * from. Keep the path (the browser's session id) and take the authority from
 * the endpoint that answered.
 */
export function rehostSocketUrl(webSocketDebuggerUrl: string, browserUrl: string): string {
  const socket = new URL(webSocketDebuggerUrl);
  const endpoint = new URL(browserUrl);
  socket.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  // hostname + port, never `host`: assigning a host with no port component
  // leaves the OLD port in place, so a default-port endpoint would inherit
  // Chrome's self-reported one.
  socket.hostname = endpoint.hostname;
  socket.port = endpoint.port;
  return socket.toString();
}
