"""Which addresses this tool will connect to. The part that must never be wrong.

A model chooses the URL, and a page it read can tell it which one. Left alone, "fetch this page" is also
"ask this machine's network for anything": the cloud metadata service at 169.254.169.254 (which hands out
this server's credentials), a database on the container network, the router, the backend's own API on
localhost. So every host is resolved here, every address it resolves to must be a public one, and the
connection is then made to that very address -- never to the name again, which could answer differently the
second time (DNS rebinding).

The check is on the *resolved* address, not on how the URL is written. `http://2130706433/`, `http://0x7f.1/`
and `http://localhost./` all resolve to 127.0.0.1, and so are refused without this module having to know
every way of spelling it.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from typing import Awaitable, Callable
from urllib.parse import SplitResult, urlsplit

from webai import FetchError

MAX_URL_LENGTH = 2048

# Addresses that are global as far as Python's ipaddress knows, but that carry an IPv4 address inside them
# and are routed by a gateway to that address -- so they can reach a private one.
_IPV4_INSIDE_IPV6 = [ipaddress.ip_network(n) for n in (
    "64:ff9b::/96",   # NAT64
    "2002::/16",      # 6to4
    "2001::/32",      # Teredo
)]

# What turns a name into addresses: (host, port) -> ["93.184.216.34", ...]. Replaceable so a test can say what a
# name resolves to without a network.
Resolver = Callable[[str, int], Awaitable[list[str]]]
# What decides an address is acceptable. Replaceable only so a test can reach a server on this machine's own
# loopback; nothing outside a test builds one.
Policy = Callable[[str], bool]


def is_public(address: str) -> bool:
    """Is this an address on the public internet, and nothing else?

    Private, loopback, link-local (169.254.x.x, including the cloud metadata address), shared/carrier-grade
    (100.64.0.0/10), unspecified, reserved, documentation and multicast addresses are all refused, and an
    IPv6 address that wraps an IPv4 one is judged by the IPv4 address inside it."""
    try:
        addr = ipaddress.ip_address(address.split("%", 1)[0])  # a zone id (fe80::1%eth0) is not part of the address
    except ValueError:
        return False
    if isinstance(addr, ipaddress.IPv6Address):
        if addr.ipv4_mapped is not None:
            addr = addr.ipv4_mapped
        elif any(addr in net for net in _IPV4_INSIDE_IPV6):
            return False
    return addr.is_global and not addr.is_multicast


def check_url(url: str) -> SplitResult:
    """The URL, parsed, if it is one this tool will even try; otherwise a FetchError saying why."""
    url = (url or "").strip()
    if not url:
        raise FetchError("No web address was given.")
    if len(url) > MAX_URL_LENGTH:
        # Also a limit on what one request can carry out: a long address is where data would be hidden.
        raise FetchError(f"That web address is longer than {MAX_URL_LENGTH} characters.")
    if any(ord(c) <= 32 or ord(c) == 127 for c in url):
        raise FetchError("That web address has a space or a control character in it.")
    try:
        parts = urlsplit(url)
        port = parts.port  # raises ValueError on a bad port
    except ValueError:
        raise FetchError("That is not a valid web address.") from None
    if parts.scheme not in ("http", "https"):
        raise FetchError(f"Only http and https addresses are read, not {parts.scheme or 'this kind of address'}.")
    if not parts.hostname:
        raise FetchError("That web address has no site name in it.")
    if parts.username is not None or parts.password is not None:
        raise FetchError("A web address with a name or password in it is not read.")
    if port == 0:
        raise FetchError("That is not a valid web address.")
    return parts


async def system_resolver(host: str, port: int) -> list[str]:
    try:
        found = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise FetchError(f"Could not find a site called {host}.") from None
    # Order kept, repeats dropped.
    return list(dict.fromkeys(item[4][0] for item in found))


async def vet(host: str, port: int, resolver: Resolver = system_resolver, policy: Policy = is_public) -> list[str]:
    """Resolve a host and return the addresses it may be reached at. Every one of them must pass: a name that
    points at a public address and a private one is refused whole, because which one a connection would
    use is not ours to choose."""
    addresses = await resolver(host, port)
    if not addresses:
        raise FetchError(f"Could not find a site called {host}.")
    for address in addresses:
        if not policy(address):
            raise FetchError(f"{host} points to {address}, which is not a public internet address, so it is not read.")
    return addresses
