"""web-ai: read a web page, check a link, ask what a stranger sees of a GitHub repository. Reads only."""

VERSION = "0.1.0"


class FetchError(Exception):
    """A fetch that did not happen or did not work, in words a person can read.

    Raised, not returned as data: the MCP door turns it into an error result, which the assistant's audit
    log records as a failure. A refused address returned as ordinary data would be logged as `ok`."""
