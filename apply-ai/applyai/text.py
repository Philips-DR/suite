"""Words, numbers and sentences: the small, deterministic vocabulary both checks share.

Nothing here is clever on purpose. A check that says "this number is in your material and that one
is not" has to be explainable line by line to the person reading it, so there is no model, no
embedding and no fuzzy threshold at this level -- just stems, numerals and sentence breaks.
"""

from __future__ import annotations

import re

# Function words and the filler a posting is written in. IDF over the source lines (evidence.py)
# does the rest: a word that is on every line of a CV carries no evidence either.
STOPWORDS = frozenset("""
a about above across after again against all also although am an and any are as at be because been
before being below between both but by can could did do does doing down during each either else
etc even ever few for from further had has have having he her here hers herself him himself his how
i if in into is it its itself just may me might more most must my myself no nor not of off on once
only or other our ours ourselves out over own per same shall she should so some such than that the
their theirs them themselves then there these they this those through to too under until up upon us
very was we were what when where which while who whom why will with within without would you your
yours yourself yourselves
able ability abilities strong strongly excellent good solid sound proven demonstrated demonstrate
relevant related similar suitable ideally preferably highly desirable required require requires
essential minimum plus asset advantage candidate candidates including include includes example
eg ie e.g i.e. well high higher level levels etc one two three four five six seven eight nine ten eleven twelve several various
support supports supporting assist assists assisting contribute contributes contributing liaise liaising
ensure ensures ensuring provide provides providing help helps helping use uses using used work works working
worked make makes making perform performs preparing preparation producing
""".split())

_TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9+#]*(?:['’][A-Za-z]+)?")
# Digits glued to letters or an underscore are part of a name ("Assistant_1", "DR4D", "YOLOv8"), not a figure.
_NUMBER = re.compile(r"(?<![A-Za-z_\d])\d+(?:[.,]\d+)*(?![A-Za-z_])")

_NUMBER_WORDS = {
    "two": "2", "three": "3", "four": "4", "five": "5", "six": "6", "seven": "7", "eight": "8",
    "nine": "9", "ten": "10", "eleven": "11", "twelve": "12",
}


def tokens(text: str) -> list[str]:
    """Words as written (case kept), with possessive endings removed: "Master's" -> "Master"."""
    return [re.sub(r"['’]s$", "", t) for t in _TOKEN.findall(text)]


def stem(word: str) -> str:
    """A light suffix-stripper: enough that "datasets" meets "dataset", "automated" meets "automation".

    Deliberately crude. It must never join two words that mean different things, and it errs toward
    leaving a word alone: a missed match costs one more line in a person's review, a false one hides
    a gap. Used for overlap only -- the watch-list of strong words (claims.py) compares exact forms,
    because "directly" must not be supported by "directed".
    """
    w = word.lower()
    if len(w) <= 3:
        return w
    for suffix, replacement in (
        ("ations", "at"), ("ation", "at"), ("ments", ""), ("ment", ""), ("ies", "y"), ("ing", ""), ("ed", ""),
        ("es", ""), ("s", ""),
    ):
        if w.endswith(suffix) and len(w) - len(suffix) >= 3:
            if suffix == "s" and w.endswith(("ss", "us", "is")):
                continue
            if suffix == "es" and not w.endswith(("ches", "shes", "xes", "zes", "ses")):
                continue
            w = w[: len(w) - len(suffix)] + replacement
            break
    if len(w) > 4 and w[-1] == w[-2] and w[-1] not in "aeiouls":  # "planned" -> "plan"
        w = w[:-1]
    return w[:-1] if len(w) > 3 and w.endswith("e") else w


def content_stems(text: str) -> set[str]:
    """The distinctive words of a sentence, stemmed, minus the filler."""
    return {stem(t) for t in tokens(text) if t.lower() not in STOPWORDS and len(t) > 1}


_ADDRESS = re.compile(r"\S+@\S+|(?:https?://)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?:/\S*)?")


def numbers(text: str) -> list[str]:
    """Every figure in the text, normalised: "91.8%" -> "91.8", "1,200" -> "1200", "three" -> "3".

    Spelled-out numbers two to twelve count (a claim of "three years" is a figure); "one" does not,
    since it is as often a pronoun. Years like 2023 are figures too, which is the point: a date that
    is not in the material is as unsupported as a percentage that is not.
    """
    text = _ADDRESS.sub(" ", text)  # "philip-portfolio-five.vercel.app" holds no claim about five of anything
    found = [n.replace(",", "") for n in _NUMBER.findall(text)]
    found += [_NUMBER_WORDS[w.lower()] for w in tokens(text) if w.lower() in _NUMBER_WORDS]
    return found


_SENTENCE_BREAK = re.compile(r"(?<=[.!?])\s+(?=[A-Z\"“(])")
# A full stop after these is not a sentence end, whatever follows it.
_ABBREVIATIONS = re.compile(r"\b(e\.g|i\.e|etc|vs|dr|mr|mrs|ms|prof|no|ltd|inc|approx|fig)\.", re.IGNORECASE)
_DOT = "\u2024"  # one-dot leader: stands in for a full stop that does not end a sentence


def sentences(text: str) -> list[str]:
    """Split on sentence ends, leaving "e.g.", "3.63" and "Ltd." in one piece."""
    protected = _ABBREVIATIONS.sub(lambda m: m.group(0)[:-1] + _DOT, text)
    return [part.replace(_DOT, ".").strip() for part in _SENTENCE_BREAK.split(protected) if part.strip()]


_NEGATORS = frozenset({"not", "no", "never", "without", "neither", "nor", "isn't", "wasn't", "aren't",
                       "weren't", "didn't", "don't", "doesn't", "hasn't", "haven't", "cannot", "can't"})


# A negation reaches four words back, and never across a clause: "has not been deployed to production" denies
# "production" (four back, seen in a real letter on 2026-10-30, flagged when the reach was three), while "not just a
# prototype but deployed to production" claims it.
NEGATION_REACH = 4
_CLAUSE = re.compile(r"[,;:.!?()\[\]—–]|\b(?:but|however|although|though|whereas)\b", re.IGNORECASE)


def negated(line: str, word: str) -> bool:
    """Is every occurrence of `word` in `line` preceded, within its clause and four words, by a negator?

    A CV that says "prototype, not deployed to production" contains the word "deployed". A draft
    that says "deployed" must not be called supported by it.
    """
    target = word.lower()
    found = False
    for clause in _CLAUSE.split(line):
        words = [t.lower().replace("’", "'") for t in _TOKEN.findall(clause)]
        for i, w in enumerate(words):
            if w == target:
                found = True
                if not any(x in _NEGATORS for x in words[max(0, i - NEGATION_REACH): i]):
                    return False
    # Not a token at all -- absent, or hyphenated ("open-source"), with no words before it to read.
    return found
