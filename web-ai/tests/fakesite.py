"""A web server on this machine's own loopback, for the tests: it answers what it is told to and records
exactly what it was sent, so a test can say what the fetcher did and did not put on the wire.

Several loopback addresses exist on Linux (127.0.0.1, 127.0.0.2, ...), which is what lets a test tell a
fetcher "this address is allowed, that one is not" while every server is still on this machine."""

from __future__ import annotations

import ssl
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

from webai.fetch import Fetcher
from webai.safety import system_resolver

Route = tuple[int, dict[str, str], bytes]


class Site:
    def __init__(self, routes: dict[str, Route | Callable[[dict[str, Any]], Route]], host: str = "127.0.0.1",
                 certificate: tuple[str, str] | None = None) -> None:
        self.routes = routes
        self.requests: list[dict[str, Any]] = []
        site = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def _answer(self) -> None:
                request = {"method": self.command, "path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}}
                site.requests.append(request)
                route = site.routes.get(self.path) or site.routes.get(self.path.split("?")[0])
                if route is None:
                    status, headers, body = 404, {"Content-Type": "text/plain"}, b"not found"
                else:
                    status, headers, body = route(request) if callable(route) else route
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if self.command != "HEAD":
                    try:
                        self.wfile.write(body)
                    except (BrokenPipeError, ConnectionResetError):
                        pass  # the client stopped reading, as it should once it has what it wants

            do_GET = do_HEAD = _answer

            def log_message(self, *args: object) -> None:
                pass

        self.server = ThreadingHTTPServer((host, 0), Handler)
        if certificate:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(*certificate)
            self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.host, self.port = host, self.server.server_address[1]
        self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> "Site":
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self._thread.join(timeout=5)

    def url(self, path: str = "/", name: str | None = None) -> str:
        return f"http://{name or self.host}:{self.port}{path}"


def html(body: str, **headers) -> Route:
    return 200, {"Content-Type": "text/html; charset=utf-8", **headers}, body.encode()


def fetcher(names: dict[str, list[str]] | None = None, allowed: tuple[str, ...] = ("127.0.0.1",), **kw) -> Fetcher:
    """A fetcher that may reach `allowed` addresses (loopback ones, here) and resolves the given names."""
    calls: list[str] = []

    async def resolve(host, port):
        calls.append(host)
        return (names or {}).get(host) or await system_resolver(host, port)

    made = Fetcher(resolver=resolve, policy=lambda address: address in allowed, **kw)
    made.resolved = calls  # type: ignore[attr-defined]
    return made
