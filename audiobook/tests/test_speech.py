import pytest

from audiobook.speech import apply_corrections, for_speech, parse_corrections, roman_to_int


@pytest.mark.parametrize(
    "text, expected",
    [
        # Each of these was misread by the voice before the rule (see speech.py).
        ("Part III, The Return of The Eagles", "Part Three, The Return of The Eagles"),
        ("Parts II & III were published", "Parts Two and Three were published"),
        ("Chapter XIV begins", "Chapter Fourteen begins"),
        ("as Paul prayed in Ephesians 1:18, the more", "as Paul prayed in Ephesians chapter 1, verse 18, the more"),
        ("read 1 John 3:16-18 aloud", "read 1 John chapter 3, verses 16 to 18 aloud"),
        ("at 3:30 we left", "at 3 30 we left"),
        ('I read "THE JUDGMENT SEAT OF CHRIST."', 'I read "The Judgment Seat of Christ."'),
        ("turned into a . . . and I stopped", "turned into a... and I stopped"),
        ("the world . . . to give sight", "the world... to give sight"),
        ("call first_hop_retrieve then LEADS_TO", "call first hop retrieve then Leads to"),
        # Left alone: the pronoun I, short acronyms, ordinary text.
        ("I said I would, and the USA and NASA agreed.", "I said I would, and the USA and NASA agreed."),
        ("In early 1995, the Lord gave me a dream.", "In early 1995, the Lord gave me a dream."),
    ],
)
def test_for_speech(text, expected):
    assert for_speech(text) == expected


def test_roman():
    assert [roman_to_int(r) for r in ("I", "IV", "IX", "XIV", "XL")] == [1, 4, 9, 14, 40]


def test_corrections():
    pairs = parse_corrections("# comment\n\nwit1~ My heart => with My heart\nbad line\n")
    assert pairs == [("wit1~ My heart", "with My heart")]
    assert apply_corrections("understand wit1~ My heart.", pairs) == "understand with My heart."
