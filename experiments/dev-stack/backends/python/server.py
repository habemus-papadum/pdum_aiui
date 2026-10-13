"""Dependency-free example; the reporting helper works with other Python frameworks."""
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "infrastructure"))
from ready import report_ready


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path != "/info":
            self.send_json(404, {"error": "Unknown Python route"})
            return
        with self.server.counter_lock:
            self.server.requests += 1
            count = self.server.requests
        self.send_json(200, {
            "backend": "python", "instance": os.getenv("DEV_INSTANCE_ID", "production"),
            "requests": count, "query": parse_qs(url.query),
        })

    def do_POST(self):
        if urlsplit(self.path).path != "/echo":
            self.send_json(404, {"error": "Unknown Python route"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 <= length <= 1024 * 1024:
                self.send_json(413, {"error": "Body too large"})
                return
            body = json.loads(self.rfile.read(length))
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"error": "Expected JSON"})
            return
        self.send_json(200, {"backend": "python", "body": body})


if __name__ == "__main__":
    server = ThreadingHTTPServer((os.getenv("HOST", "127.0.0.1"), int(os.getenv("PORT", "0"))), Handler)
    server.requests = 0
    server.counter_lock = threading.Lock()
    # The socket is bound here. With port 0 the OS has already assigned the real port.
    report_ready(f"http://127.0.0.1:{server.server_port}/")
    try:
        server.serve_forever()
    finally:
        server.server_close()
