from datetime import date  # noqa: F401  (kept for symmetry with the other test modules)

from applyai.text import content_stems, negated, numbers, sentences, stem


def test_stems_meet_inflections_and_not_different_words():
    assert stem("datasets") == stem("dataset")
    assert stem("automated") == stem("automation") == stem("automating") == stem("automate")
    assert stem("planned") == stem("planning") == stem("plan")
    # Leaves a word alone rather than joining two that differ.
    assert stem("business") == "business" and stem("analysis") == "analysis"
    assert stem("directly") != stem("directed")


def test_filler_is_not_distinctive():
    stems = content_stems("Support the team and assist with the work, including Python scripts")
    assert stems == {"team", "python", "script"}


def test_numbers_are_normalised_and_cover_spelled_out_figures():
    assert numbers("91.8% on trees, 94% on palms, 1,200 files in 2023") == ["91.8", "94", "1200", "2023"]
    assert numbers("three years, twelve models, one pipeline") == ["3", "12"]  # "one" is a pronoun as often as a number


def test_digits_inside_a_name_or_an_address_are_not_figures():
    # The first draft of the check flagged "1" in "Research Assistant_1" and "5" in a portfolio URL.
    assert numbers("Research Assistant_1 (Ref DR4D), YOLOv8, Python3") == []
    assert numbers("see philip-portfolio-five.vercel.app and phil900@gmail.com") == []
    assert numbers("CGPA 3.63") == ["3.63"]


def test_sentences_keep_abbreviations_whole():
    assert sentences("Engineered models, e.g. YOLOv8. Reached 94% precision. CGPA 3.63 at BlueCrest.") == [
        "Engineered models, e.g. YOLOv8.", "Reached 94% precision.", "CGPA 3.63 at BlueCrest."]


def test_a_word_is_negated_only_when_every_use_of_it_is():
    assert negated("Real-time platform (prototype, not deployed to production)", "deployed")
    assert not negated("We deployed it", "deployed")
    assert not negated("not deployed at first, then deployed", "deployed")
    assert not negated("no such word here", "deployed")


def test_a_negation_reaches_four_words_back_within_its_clause():
    # A real letter (2026-10-30): "production" four words after "not" was flagged when the reach was three.
    assert negated("the voice agent has not been deployed to production", "production")
    assert negated("it is not yet deployed to production", "production")
    # A clause break or "but" ends it, even within reach: these claim what follows.
    assert not negated("not cheap but deployed", "deployed")
    assert not negated("not slow, deployed to production", "production")
    assert not negated("Not slow: deployed to production", "production")
    assert not negated("not just a prototype but deployed to production", "deployed")
    # Five words back is too far: "not" there is about something else.
    assert not negated("did not stop until it was deployed to production", "production")
