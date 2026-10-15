"""What the checks know about the world: tools, languages, degrees, and the words that overstate.

This is the tool's domain knowledge, kept in one file so it can be read, argued with and extended without
touching a check. It is deliberately short and deliberately literal. A list that tried to be complete
would make every miss look like a verdict; a short one says plainly what it looks for.
"""

from __future__ import annotations

import re

# A tool, library or language a posting may name and an applicant may or may not have used. Each maps to
# the spellings that count as having it: the canonical name is always one of them.
TOOLS: dict[str, tuple[str, ...]] = {
    "Python": ("python",), "R": ("r",), "SQL": ("sql",), "Stata": ("stata",), "SPSS": ("spss",),
    "SAS": ("sas",), "MATLAB": ("matlab",), "Excel": ("excel",), "PowerPoint": ("powerpoint",),
    "Tableau": ("tableau",), "Power BI": ("power bi", "powerbi"), "Git": ("git", "github", "gitlab"),
    "GitHub": ("github",), "GitLab": ("gitlab",), "Linux": ("linux",), "Unix": ("unix",), "Bash": ("bash",),
    "Docker": ("docker",), "Kubernetes": ("kubernetes", "k8s"), "AWS": ("aws",), "Azure": ("azure",),
    "GCP": ("gcp", "google cloud"), "TensorFlow": ("tensorflow",), "PyTorch": ("pytorch",),
    "Keras": ("keras",), "scikit-learn": ("scikit-learn", "sklearn", "scikit learn"), "pandas": ("pandas",),
    "NumPy": ("numpy",), "Spark": ("spark", "pyspark"), "Hadoop": ("hadoop",), "Airflow": ("airflow",),
    "dbt": ("dbt",), "QGIS": ("qgis",), "ArcGIS": ("arcgis",), "GDAL": ("gdal",),
    "Google Earth Engine": ("google earth engine", "earth engine"), "JavaScript": ("javascript",),
    "TypeScript": ("typescript",), "Java": ("java",), "C++": ("c++",), "Scala": ("scala",),
    "Julia": ("julia",), "LaTeX": ("latex",), "Jira": ("jira",), "Kafka": ("kafka",), "Redis": ("redis",),
    "PostgreSQL": ("postgresql", "postgres"), "MySQL": ("mysql",), "MongoDB": ("mongodb",),
    "FastAPI": ("fastapi",), "Django": ("django",), "Flask": ("flask",), "React": ("react",),
    "Terraform": ("terraform",), "Ansible": ("ansible",), "MLflow": ("mlflow",), "LangChain": ("langchain",),
    "Hugging Face": ("hugging face", "huggingface"), "OpenCV": ("opencv",), "YOLO": ("yolo", "yolov8"),
    "ArcPy": ("arcpy",), "SAP": ("sap",), "Salesforce": ("salesforce",), "Looker": ("looker",),
}

LANGUAGES = ("English", "French", "Spanish", "Portuguese", "Arabic", "German", "Swahili", "Mandarin",
             "Chinese", "Italian", "Hausa", "Yoruba", "Twi", "Akan", "Ewe", "Dutch", "Russian", "Hindi")

# Degree levels, low to high. The first pattern that matches a line names the level.
DEGREE_LEVELS = ("bachelor", "master", "doctorate")
_DEGREE_PATTERNS: dict[str, re.Pattern[str]] = {
    "doctorate": re.compile(r"\b(?:ph\.?d|doctorate|doctoral)\b", re.I),
    "master": re.compile(r"\b(?:master(?:'?s|’s)?|m\.?sc|m\.?eng|mba|mphil|postgraduate)\b", re.I),
    "bachelor": re.compile(r"\b(?:bachelor(?:'?s|’s)?|b\.?sc|b\.?eng|b\.?a\.?|b\.?s\.?|undergraduate degree|first degree)\b", re.I),
}
DEGREE_NAMES = {"bachelor": "a bachelor's degree", "master": "a master's degree", "doctorate": "a doctorate"}


def degree_levels(text: str) -> set[str]:
    """Every degree level a piece of text mentions."""
    return {level for level, pattern in _DEGREE_PATTERNS.items() if pattern.search(text)}


# Words that claim more than a plain statement of work does. A draft that uses one the material does not
# is overstating, however good the sentence reads: these four were found by hand in a real tailoring --
# "daily", "open tool", "fed directly into harvest planning", "most of my time" -- each of them added by a
# model that was only trying to sound good. Compared as exact lowercase forms, never stems: "directly"
# must not be supported by "directed".
WATCH: dict[str, tuple[str, ...]] = {
    "how often": ("daily", "weekly", "monthly", "hourly", "nightly", "always", "constantly", "continuously",
                  "regularly", "routinely", "frequently", "24/7"),
    "how much": ("most", "mostly", "majority", "entire", "entirely", "whole", "fully", "completely",
                 "directly", "solely", "single-handedly", "independently", "exclusively", "end-to-end",
                 "everything", "every", "extensive", "extensively", "numerous", "significant",
                 "significantly", "substantial", "substantially", "successfully", "proven"),
    "who did it": ("led", "lead", "leading", "owned", "managed", "headed", "directed", "spearheaded",
                   "architected", "founded", "championed", "oversaw", "supervised", "mentored", "pioneered"),
    "how big, how real": ("production", "deployed", "live", "launched", "shipped", "scaled", "enterprise",
                          "large-scale", "millions", "billions", "thousands", "hundreds", "nationwide",
                          "published", "open-source", "award", "awarded", "award-winning", "patented"),
    "what it is": ("open",),
    "level": ("expert", "advanced", "proficient", "fluent", "native", "bilingual", "certified", "licensed",
              "accredited", "master", "msc", "phd", "doctorate", "senior"),
}
WATCH_CATEGORY = {word: category for category, words in WATCH.items() for word in words}
_WATCH_PHRASES = tuple(w for w in WATCH_CATEGORY if not w.isalpha())  # "open-source", "end-to-end", "24/7"


def watch_words_in(text: str) -> set[str]:
    """Every watched word the text uses. Hyphenated ones are found as phrases: the tokenizer splits them."""
    lowered = text.lower().replace("’", "'")
    found = {w for w in re.findall(r"[a-z][a-z0-9']*", lowered) if w in WATCH_CATEGORY}
    found |= {w for w in _WATCH_PHRASES if re.search(rf"(?<![a-z0-9]){re.escape(w)}(?![a-z0-9])", lowered)}
    return found

# Words of character, not of work: a requirement made mostly of these ("a proactive, self-starting attitude")
# cannot be found in a CV by searching for it, and asking the user about each one is a long list of
# questions with no answer to give. They are listed apart, to be shown through real examples already in the
# material -- never asserted bare, and never invented an example for.
TRAIT_WORDS = frozenset("""
proactive self starting attitude integrity commitment committed enthusiasm enthusiastic curiosity curious
passion passionate motivated team collaborative collaboratively independently independent fast paced
multicultural orientation urgency accountable accountability empower thoughtful risk taking genuine interest
interested mission dedicated reliable flexible adaptable creative driven drive environment ability strong
excellent solid client players player spirit
""".split())

# What a person's own material says to LIMIT a claim: the thing that makes "I built the Kafka layer" honest
# where "I run Kafka" is not. A draft that keeps the point and drops the limit overstates exactly as much as
# one that adds a word, and it is the commoner way to do it when a page has to be cut. Each pattern captures
# the limit as written, so the finding can quote it back. Short on purpose: it names the hedges this
# material actually uses, and a new one is a line here.
HEDGES: tuple[str, ...] = (
    r"prototype[^)]*",
    r"not deployed[^)]*",
    r"our cloud engineer[^.;]*",
    r"\([^)]*\b(?:layer|authoring|config(?:uration)?|serving)\b[^)]*\)",
    r"\b(?:limited|basic|beginner|partial) (?:experience|knowledge|exposure|use)\b",
    r"\bexposure to\b[^.;]*",
    r"\bfamiliar(?:ity)? with\b[^.;]*",
    r"\bin progress\b|\bongoing\b",
)

# Capitalised words that are not names of anything an applicant could have worked with.
COMMON_CAPITALISED = frozenset("""
dear sincerely regards best yours faithfully kind hiring manager committee team department sir madam mr ms
mrs dr prof cv resume cover letter january february march april may june july august september october november december monday
tuesday wednesday thursday friday saturday sunday i i'm i've i'd i'll my thank thanks attached please
""".split())


def tool_in(text: str, spellings: tuple[str, ...]) -> bool:
    """Is any spelling of a tool in the text, as a whole word? "R" must be a capital on its own."""
    for spelling in spellings:
        if spelling == "r":
            if re.search(r"(?<![A-Za-z0-9&/+#.])R(?![A-Za-z0-9&+#])", text):
                return True
        elif re.search(rf"(?<![A-Za-z0-9]){re.escape(spelling)}(?![A-Za-z0-9])", text, re.I):
            return True
    return False


_VERBS = frozenset({"Excel", "Spark", "React"})  # tools whose names are also verbs: not when opening a sentence


def tools_named(text: str) -> list[str]:
    """The tools a requirement names, in order of first mention.

    Matched by the canonical spelling, case-sensitively where it is capitalised: "Excel" is a tool and
    "excel in a fast-paced team" is not. (What counts as *having* a tool is wider: see `tool_in`.)
    """
    found: list[tuple[int, str]] = []
    for name in TOOLS:
        pattern = (r"(?<![A-Za-z0-9&/+#.])R(?![A-Za-z0-9&+#])" if name == "R"
                   else rf"(?<![A-Za-z0-9]){re.escape(name)}(?![A-Za-z0-9])")
        flags = re.I if name.islower() else 0
        for m in re.finditer(pattern, text, flags):
            # "Excel in a fast-paced team" opens with a verb; "Spark" and "React" do the same.
            if name in _VERBS and re.search(r"(?:^|[.!?:;•●▪]\s*)$", text[: m.start()]):
                continue
            found.append((m.start(), name))
            break
    return [name for _, name in sorted(found)]


def languages_named(text: str) -> list[str]:
    return [name for name in LANGUAGES if re.search(rf"\b{name}\b", text)]
