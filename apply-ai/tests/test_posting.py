from applyai.posting import DUTY, PREFERRED, REQUIRED, looks_french, read_posting

# The shape of a real posting extracted from a PDF: headings with no blank line under them, wrapped
# bullets, an unbulleted lead-in ending in a colon, and the whole thing repeated in French.
BILINGUAL = """\
JOB ANNOUNCEMENT
Research Assistant_1
Ref: GSS/DR4D/2026.10.13

About AfricaRice
AfricaRice is a leading pan-African rice research organization.

Position purpose
The purpose of these positions is to support digital innovation in agriculture.

Position responsibilities
Under the supervision of the Research Associate, the duties and responsibilities
of Research Assistant_1 will include the following key interventions:

    •   Support data ingestion, cleaning, and management of weather, soil, and remote sensing
        datasets relevant to West Africa.
    •   Develop scripts and workflows (Python) for data processing, analysis, and visualisation.

Qualifications/Selection Criteria
          Education:
   • MSc (completed or ongoing) in Computer Science, Statistics, or a closely related field.
        .
        Required Professional Experience:
    •   Proficiency in Python.
        Required Competencies:
    •   Experience with Linux/Unix environments and command-line tools.
Languages

    •   The candidate should be able to communicate fluently in English or French and have
        a good working knowledge of the other language.

Terms and Conditions
   • This is a Regionally recruited position.

AVIS DE VACANCE DE POSTE
Assistant(e) de recherche_1

Principales responsabilités
Sous la supervision du Chercheur associé, les tâches et responsabilités de l'Assistant de recherche
comprendront les interventions clés suivantes :

    •   Appuyer l'ingestion, le nettoyage et la gestion des jeux de données météorologiques pour l'Afrique de l'Ouest.
Qualifications / critères de sélection
        Qualifications :
   • Master (achevé ou en cours) en informatique, mathématiques appliquées, statistiques ou dans un domaine connexe.
        Expérience professionnelle requise :
    •   Maîtrise de Python.
"""

WORLD_BANK = """\
Job #:    req38605
Required Language(s):    English
Preferred Language(s):    French

What You Will Do

● Firm-level data analytics: work with large firm-level datasets as well as trade data

Selection Criteria

● A recently completed Master's degree (or equivalent) in Economics, Finance, or a related field; a PhD is a plus

● 3-5 years of demonstrated experience with firm-level micro-data analysis, gained through research or work;

● Excellent written and oral communication skills in English; working knowledge of French is highly desirable

Note: This is an Extended Term Consultant appointment for a fixed term.

WBG Culture Attributes:

1. Sense of urgency: Anticipate and quickly respond to the needs of internal and external stakeholders.
"""


def kinds(reading):
    return [(r.kind, r.text[:40]) for r in reading.requirements]


def test_every_bullet_under_a_requirements_or_duties_heading_becomes_an_item():
    reading = read_posting(BILINGUAL)
    texts = [r.text for r in reading.requirements]
    assert any(t.startswith("Support data ingestion") for t in texts)
    assert any(t.startswith("Develop scripts") for t in texts)
    assert any(t.startswith("MSc") for t in texts)
    assert any(t.startswith("Proficiency in Python") for t in texts)
    assert any(t.startswith("Experience with Linux/Unix") for t in texts)
    assert any(t.startswith("The candidate should be able to communicate fluently") for t in texts)


def test_a_heading_with_no_blank_line_under_it_is_still_a_heading():
    # "Position responsibilities" sat directly on its first sentence; a first version lost every duty.
    reading = read_posting(BILINGUAL)
    duties = [r for r in reading.requirements if r.kind == DUTY]
    assert len(duties) == 2
    assert "Position responsibilities" in reading.read
    assert "Position purpose" in reading.skipped


def test_wrapped_lines_join_and_a_lead_in_ending_in_a_colon_is_not_a_requirement():
    reading = read_posting(BILINGUAL)
    ingest = next(r for r in reading.requirements if r.text.startswith("Support data ingestion"))
    assert ingest.text.endswith("relevant to West Africa.")
    assert not any("key interventions" in r.text for r in reading.requirements)


def test_a_subheading_inherits_its_section_and_a_stray_full_stop_is_ignored():
    reading = read_posting(BILINGUAL)
    msc = next(r for r in reading.requirements if r.text.startswith("MSc"))
    assert msc.kind == REQUIRED
    assert not any(r.text.strip(" .") == "" for r in reading.requirements)


def test_the_french_half_of_a_bilingual_posting_is_dropped_and_counted():
    reading = read_posting(BILINGUAL)
    assert not any("Maîtrise" in r.text or "Appuyer" in r.text or "Master (achevé" in r.text for r in reading.requirements)
    assert any("French" in note and "skipped" in note for note in reading.notes)


def test_a_posting_that_is_french_throughout_is_refused_with_a_reason_not_misread():
    french = "Qualifications\n\n• Maîtrise de Python et de Git pour le contrôle de version dans les équipes du projet.\n" \
             "• Expérience des environnements Linux et des outils en ligne de commande pour les données du projet.\n" \
             "• Le candidat devrait être en mesure de communiquer couramment en français et en anglais.\n"
    reading = read_posting(french)
    assert reading.requirements == []
    assert any("French" in n and "English only" in n for n in reading.notes)


def test_a_bullet_is_split_at_semicolons_when_each_side_stands_alone():
    reading = read_posting(WORLD_BANK)
    by_text = {r.text: r for r in reading.requirements}
    degree = next(r for t, r in by_text.items() if t.startswith("A recently completed Master"))
    phd = by_text["A PhD is a plus"]
    # A first version read the whole bullet as preferred because of "a PhD is a plus", and the master's
    # degree stopped being required.
    assert degree.kind == REQUIRED and phd.kind == PREFERRED
    assert by_text["Excellent written and oral communication skills in English"].kind == REQUIRED
    assert by_text["Working knowledge of French is highly desirable"].kind == PREFERRED


def test_a_trailing_semicolon_does_not_split_a_bullet():
    reading = read_posting(WORLD_BANK)
    years = [r for r in reading.requirements if r.text.startswith("3-5 years")]
    assert len(years) == 1 and not years[0].text.endswith(";")


def test_culture_attributes_under_selection_criteria_are_not_requirements():
    reading = read_posting(WORLD_BANK)
    assert not any("Sense of urgency" in r.text for r in reading.requirements)
    assert "WBG Culture Attributes" in reading.skipped
    assert not any(r.text.startswith("Note:") or "Extended Term" in r.text for r in reading.requirements)


def test_header_language_fields_are_requirements_too():
    reading = read_posting(WORLD_BANK)
    texts = {(r.kind, r.text) for r in reading.requirements}
    assert (REQUIRED, "Required language: English") in texts
    assert (PREFERRED, "Preferred language: French") in texts
    assert reading.header["job #"] == "req38605"


def test_a_posting_without_headings_says_so_instead_of_returning_nothing_silently():
    reading = read_posting("We need someone good with data. Apply soon.")
    assert reading.requirements == []
    assert any("No requirements or duties were found" in n for n in reading.notes)


def test_french_detection():
    assert looks_french("Maîtrise de Python et de Git pour le contrôle de version")
    assert not looks_french("Proficiency in Python and Git for version control")
    assert not looks_french("Python Git")  # too short to tell
