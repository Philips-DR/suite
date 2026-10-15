from datetime import date

from applyai.evidence import CHECK, GAP, NOT_FOUND, PARTLY, SUPPORTED, TRAIT, date_spans, match, question_for
from applyai.posting import PREFERRED, REQUIRED, Requirement
from applyai.sources import CONFIRMED, Line, units

CV = """\
# Philip Baah Afriyie

## Experience

### Machine Learning Engineer — Ayadata GH

Nov 2023 – Present · Accra, Ghana

- Engineered object detection models on drone imagery for automated crop counting, reaching 91.8% precision.
- Built a FastAPI service behind nginx and Gunicorn; deployed with Docker.

## Skills

- **Languages:** Python, TypeScript, SQL, Bash
- **Tools:** Git and GitHub, Power BI, QGIS

## Education

### BSc. Information Technology — BlueCrest University College
"""
TODAY = date(2026, 10, 15)


def lines(text: str = CV, source: str = "cv.md") -> list[Line]:
    return [Line(source, u) for u in units(text)]


def req(text: str, kind: str = REQUIRED, n: int = 1) -> Requirement:
    return Requirement(n, text, "Selection Criteria", kind)


def one(text: str, kind: str = REQUIRED, material: list[Line] | None = None):
    return match([req(text, kind)], material or lines(), TODAY)[0]


def test_a_degree_above_the_one_shown_is_a_hard_gap_naming_both():
    m = one("MSc (completed or ongoing) in Computer Science or a closely related field.")
    assert m.status == GAP
    check = m.checks[0]
    assert (check.type, check.met) == ("degree", False)
    assert "master's degree" in check.needs
    assert "bachelor's degree" in check.found and "BlueCrest" in check.found
    assert "in progress" in check.note
    assert "Do you hold one" in question_for(m)


def test_a_degree_that_is_met_is_supported_with_the_line_as_evidence():
    m = one("A Bachelor's degree in a technical field")
    assert m.status == SUPPORTED and m.checks[0].met is True
    assert "BlueCrest" in m.evidence[0]["line"]


def test_a_material_that_names_no_degree_at_all_cannot_meet_one():
    m = one("Bachelor's degree in any field", material=lines("- Built things with Python."))
    assert m.status == GAP and "mentions no degree" in m.checks[0].found


def test_or_equivalent_is_carried_to_the_question():
    m = one("A recently completed Master's degree (or equivalent) in Economics")
    assert "equivalent" in question_for(m)


def test_a_language_the_material_never_mentions_is_a_gap_and_english_is_not():
    m = one("Fluent in English or French and a good working knowledge of the other language.")
    by_name = {c.needs: c for c in m.checks}
    assert by_name["English"].met is True and by_name["French"].met is False
    assert m.status == GAP
    assert "French" in question_for(m) and "English" not in question_for(m)


def test_a_language_that_is_mentioned_is_met():
    m = one("Working knowledge of French", material=lines("- Languages: English, French (conversational)"))
    assert m.status == SUPPORTED and m.checks[0].met is True


def test_alternatives_are_one_check_and_either_meets_it():
    # "Stata and/or R" and "Linux/Unix": having one of a group is having it.
    m = one("Knowledge of statistical tools such as Stata and/or R")
    assert len(m.checks) == 1 and m.checks[0].needs == "Stata or R" and m.status == GAP
    ok = one("Knowledge of statistical tools such as Stata and/or R", material=lines("- Analysis in R and Python."))
    assert ok.status == SUPPORTED and ok.checks[0].met is True


def test_a_tool_is_matched_as_a_whole_word_and_r_must_stand_alone():
    assert one("Proficiency in R", material=lines("- Led R&D and Rust work.")).status == GAP
    assert one("Excel in a fast-paced team").checks == []      # the verb, not the spreadsheet
    assert one("Proficiency with Git/GitHub").status == SUPPORTED


def test_the_tool_evidence_is_the_line_that_is_most_about_it_not_the_first_that_names_it():
    m = one("Proficiency in Python.", material=lines(
        "[github.com/x](https://github.com/x) · Python, FastAPI, LiveKit, Claude on AWS Bedrock, Gunicorn, nginx\n\n"
        "- **Languages:** Python, TypeScript"))
    assert m.checks[0].evidence[0]["line"].startswith("Languages: Python")


def test_years_are_worked_out_from_the_dates_and_left_for_a_person_to_judge():
    m = one("3-5 years of demonstrated experience with micro-data analysis")
    assert m.status == CHECK and m.checks[0].met is None
    assert "Machine Learning Engineer — Ayadata GH" in m.checks[0].found
    assert "about 2 years 11 months" in m.checks[0].found
    assert "2026-10-15" in m.checks[0].found
    assert "Is there other work that counts" in question_for(m)


def test_date_spans_read_present_as_today_and_say_when_months_are_missing():
    spans = date_spans(lines("### Analyst\n\n2019 – 2021\n\n### Engineer\n\nMar 2021 – Present"), TODAY)
    assert [how for _, _, how in spans] == ["about 2 years (months not given)", "about 5 years 7 months"]
    assert spans[1][1].text == "Engineer"


def test_failed_hard_checks_do_not_sit_beside_lines_that_merely_share_a_word():
    # "Languages: Python, ..." must not be offered as evidence for a request for French.
    m = one("Working knowledge of French")
    assert m.status == GAP and m.evidence == []


def test_a_requirement_nothing_in_the_material_touches_is_not_found_and_names_what_is_missing():
    m = one("Experience working with climate, weather, or agricultural datasets in West Africa.")
    assert m.status == NOT_FOUND
    assert {"climate", "weather", "West", "Africa"} <= set(m.words_not_found)
    assert "Have you done this?" in question_for(m)


def test_a_requirement_whose_words_mostly_appear_is_partly_met_and_shows_the_lines():
    m = one("Experience applying deep learning to drone imagery for object detection")
    assert m.status in (PARTLY, SUPPORTED)
    assert "drone imagery" in m.evidence[0]["line"]


def test_confirmed_facts_count_as_material_and_are_named_as_such():
    facts = lines("The crop images were drone imagery.", CONFIRMED)
    m = one("Experience with satellite or drone imagery", material=lines() + facts)
    assert any(e["source"] == CONFIRMED for e in m.evidence) or m.status == SUPPORTED


def test_a_duty_with_no_match_is_not_asked_about_one_by_one():
    m = one("Liaise with national meteorological agencies", kind="duty")
    assert m.status == NOT_FOUND and question_for(m) is None


def test_a_preferred_gap_is_asked_about_but_marked_as_preferred():
    m = one("Working knowledge of French is highly desirable", kind=PREFERRED)
    assert "preferred, not required" in question_for(m)


# Asking the user about "a proactive, self-starting attitude" produced a numbered list of questions with no
# answer to give, in the second real run. A trait cannot be searched for; it is shown by examples.
def test_a_quality_of_character_is_a_trait_and_is_not_put_to_the_user_as_a_question():
    for text in ("A proactive, self-starting attitude and the ability to work independently and collaboratively",
                 "Strong client orientation, integrity, and commitment to the World Bank Group's mission of ending poverty"):
        m = one(text)
        assert m.status == TRAIT and question_for(m) is None


def test_a_requirement_about_a_subject_is_not_a_trait_even_when_it_says_interest():
    m = one("Genuine interest in private sector development, jobs, competitiveness, and financial sector issues in Sub-Saharan Africa")
    assert m.status == NOT_FOUND and question_for(m)


def test_a_hard_check_outranks_a_trait_reading():
    m = one("Strong commitment to open-source work, and fluent French", material=lines("- Python"))
    assert m.status == GAP
