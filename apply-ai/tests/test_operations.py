from datetime import date

import pytest

from applyai.operations import claims_report, requirements_report
from applyai.sources import SourceError

CV = """\
# Philip Baah Afriyie

### Machine Learning Engineer — Ayadata GH

Nov 2023 – Present · Accra, Ghana

- Engineered object detection models on drone imagery, reaching 91.8% precision on banana trees.
- **Languages:** Python, TypeScript, SQL

### BSc. Information Technology — BlueCrest University College
"""

POSTING = """\
Selection Criteria

● A recently completed Master's degree (or equivalent) in Economics; a PhD is a plus

● 3-5 years of experience with firm-level micro-data analysis

● Knowledge of statistical tools, such as Stata and/or R

● Working knowledge of French is highly desirable

Required Language(s):    English
Preferred Language(s):    French
"""


@pytest.fixture
def cv(tmp_path):
    path = tmp_path / "cv.md"
    path.write_text(CV)
    return str(path)


def test_every_requirement_appears_once_with_a_status_and_the_worst_first(cv, tmp_path):
    report = requirements_report(POSTING, [cv], [], [tmp_path], today=date(2026, 10, 15))
    items = report["requirements"]
    assert len(items) == report["posting"]["requirements_found"] == 7
    assert [i["id"] for i in sorted(items, key=lambda i: i["id"])] == list(range(1, 8))
    order = [i["status"] for i in items]
    assert order == sorted(order, key=("gap", "check", "not_found", "partly", "trait", "supported").index)
    assert report["summary"]["gap"] >= 4 and report["summary"]["check"] == 1


def test_the_same_question_is_asked_once_however_many_requirements_raise_it(cv, tmp_path):
    report = requirements_report(POSTING, [cv], [], [tmp_path], today=date(2026, 10, 15))
    french = [a for a in report["ask_the_user"] if "French" in a["question"]]
    assert len(french) == 1 and len(french[0]["ids"]) >= 2          # the bullet and the header field
    assert [a["required"] for a in report["ask_the_user"]] == sorted((a["required"] for a in report["ask_the_user"]), reverse=True)


def test_a_confirmed_fact_settles_a_gap_for_the_next_call(cv, tmp_path):
    before = requirements_report(POSTING, [cv], [], [tmp_path], today=date(2026, 10, 15))
    after = requirements_report(POSTING, [cv], ["I read and write French at B2 level"], [tmp_path],
                                today=date(2026, 10, 15))
    assert any("French" in a["question"] for a in before["ask_the_user"])
    assert not any("French" in a["question"] for a in after["ask_the_user"])
    assert after["material"]["confirmed_facts"] == 1


def test_the_report_tells_the_model_what_to_do_next_and_what_each_status_means(cv, tmp_path):
    report = requirements_report(POSTING, [cv], [], [tmp_path])
    assert "ONE message" in report["next_step"] and "remember" in report["next_step"]
    assert set(report["meaning_of_status"]) == {"gap", "check", "not_found", "partly", "trait", "supported"}


def test_a_posting_that_cannot_be_read_is_reported_not_silently_empty(cv, tmp_path):
    report = requirements_report("Apply soon.", [cv], [], [tmp_path])
    assert report["posting"]["requirements_found"] == 0 and report["posting"]["notes"]


def test_claims_reports_clean_only_when_nothing_was_found(cv, tmp_path):
    bad = claims_report("- Spent most of my time on Python and Stata.", [cv], [], "", [tmp_path])
    assert bad["clean"] is False and {f["token"] for f in bad["findings"]} >= {"most", "Stata"}
    good = claims_report("- Engineered object detection models on drone imagery, reaching 91.8% precision on banana trees.",
                         [cv], [], "", [tmp_path])
    assert good["clean"] is True and good["figures_traced"]
    assert "does not prove" in good["next_step"] and "cannot tell that a sentence is true" in good["limits"]


def test_claims_names_from_the_posting_are_separated_from_unknown_ones(cv, tmp_path):
    report = claims_report("- Keen to work with AfricaRice, as I did with Wageningen University.", [cv], [],
                           "AfricaRice is hiring", [tmp_path])
    assert report["names_that_come_from_the_posting"] == "AfricaRice"
    assert {n["token"] for n in report["names_to_review"]} == {"Wageningen"}


def test_a_private_claim_is_unchecked_until_links_are_passed_and_then_judged_by_them(cv, tmp_path):
    draft = "- My repositories are private; I am happy to grant access."
    unchecked = claims_report(draft, [cv], [], "", [tmp_path])
    assert unchecked["clean"] is False and [f["kind"] for f in unchecked["findings"]] == ["unchecked"]
    assert "public_links" in unchecked["next_step"]
    public = claims_report(draft, [cv], [], "", [tmp_path], public_links=["https://github.com/Philips-DR/docu-ai"])
    assert [f["kind"] for f in public["findings"]] == ["public link"]
    assert claims_report(draft, [cv], [], "", [tmp_path], public_links=[])["clean"] is True


def test_the_command_line_takes_public_addresses_and_an_empty_list(cv, tmp_path, capsys):
    from applyai.cli import main
    draft = tmp_path / "letter.md"
    draft.write_text("- My repositories are private.\n")
    assert main(["claims", str(draft), cv]) == 0 and "[unchecked] private" in capsys.readouterr().out
    assert main(["claims", str(draft), cv, "--public", "https://github.com/a/b"]) == 0
    assert "[public link] private" in capsys.readouterr().out
    assert main(["claims", str(draft), cv, "--public"]) == 0 and "Clean." in capsys.readouterr().out


def test_an_empty_draft_and_a_missing_source_are_errors(cv, tmp_path):
    with pytest.raises(ValueError, match="empty"):
        claims_report("  ", [cv], [], "", [tmp_path])
    with pytest.raises(SourceError):
        claims_report("- x", [str(tmp_path / "nope.md")], [], "", [tmp_path])
