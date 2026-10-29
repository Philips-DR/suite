"""The address rules. These are the tests that matter most here: a model chooses the URL."""

import asyncio

import pytest

from webai import FetchError
from webai.safety import MAX_URL_LENGTH, check_url, is_public, system_resolver, vet


def run(coro):
    return asyncio.run(coro)


@pytest.mark.parametrize("address", [
    "127.0.0.1", "127.1.2.3", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254",                  # the cloud metadata service: this machine's own credentials
    "169.254.0.1", "0.0.0.0", "100.64.0.1",       # link-local, unspecified, carrier-grade NAT
    "224.0.0.1", "240.0.0.1", "255.255.255.255", "192.0.2.1", "198.51.100.7", "203.0.113.9",
    "::1", "::", "fe80::1", "fe80::1%eth0", "fc00::1", "fd12:3456::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",   # an IPv4 address inside an IPv6 one
    "64:ff9b::7f00:1", "2002:7f00:1::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2",  # NAT64, 6to4, Teredo
    "not an address", "",
])
def test_an_address_that_is_not_the_public_internet_is_refused(address):
    assert is_public(address) is False


@pytest.mark.parametrize("address", ["93.184.216.34", "8.8.8.8", "140.82.121.3", "2606:4700:4700::1111",
                                     "::ffff:8.8.8.8"])
def test_a_public_address_is_allowed(address):
    assert is_public(address) is True


@pytest.mark.parametrize("url", [
    "ftp://example.com/x", "file:///etc/passwd", "gopher://example.com", "javascript:alert(1)", "data:text/html,x",
    "//example.com/x", "example.com/x", "",
])
def test_only_http_and_https_are_read(url):
    with pytest.raises(FetchError):
        check_url(url)


@pytest.mark.parametrize("url", [
    "http://user@example.com/", "http://user:pass@example.com/", "https://example.com@evil.example/",
    "http://evil.example\\@127.0.0.1/",           # a backslash some parsers treat as a slash
    "http://example.com/a b", "http://example.com/\r\nHost: evil", "http://exa\x00mple.com/",
    "http://example.com:0/", "http://example.com:99999/", "http://example.com:abc/",
    "http:///path",
])
def test_an_address_that_hides_where_it_goes_is_refused(url):
    with pytest.raises(FetchError):
        check_url(url)


def test_a_very_long_address_is_refused():
    with pytest.raises(FetchError, match="longer than"):
        check_url("https://example.com/?q=" + "a" * MAX_URL_LENGTH)
    check_url("https://example.com/?q=" + "a" * 100)


def test_an_ordinary_address_passes_and_is_parsed():
    parts = check_url("  https://Example.com:8443/jobs?id=7#top  ")
    assert (parts.hostname, parts.port, parts.path, parts.query) == ("example.com", 8443, "/jobs", "id=7")


def resolver_for(table):
    async def resolve(host, port):
        return table.get(host, [])
    return resolve


def test_a_name_is_refused_if_any_address_it_resolves_to_is_private():
    """Which address a connection uses is not ours to choose, so one bad answer refuses the name."""
    resolve = resolver_for({"mixed.example": ["93.184.216.34", "10.0.0.7"]})
    with pytest.raises(FetchError, match="10.0.0.7.*not a public"):
        run(vet("mixed.example", 80, resolve))


def test_a_name_that_resolves_to_nothing_is_refused():
    with pytest.raises(FetchError, match="Could not find"):
        run(vet("nowhere.example", 80, resolver_for({})))


def test_a_public_name_returns_its_addresses_in_order():
    resolve = resolver_for({"ok.example": ["93.184.216.34", "2606:2800:220:1::1"]})
    assert run(vet("ok.example", 443, resolve)) == ["93.184.216.34", "2606:2800:220:1::1"]


@pytest.mark.parametrize("host", ["localhost", "2130706433", "0x7f.1", "0177.0.0.1", "127.1", "[::1]".strip("[]")])
def test_every_way_of_writing_loopback_is_caught_by_what_it_resolves_to(host):
    """The check is on the resolved address, so the many spellings need no list of their own."""
    with pytest.raises(FetchError, match="not a public internet address"):   # not "could not find a site"
        run(vet(host, 80, system_resolver))
