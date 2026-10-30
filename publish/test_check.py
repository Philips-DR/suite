"""Tests for ./publish-check, each against a throwaway repository with its own bare "remote".

No network and no real login file. Every fake secret, address and number here is put together from pieces,
so this file holds none of them whole: written out, they would make the check flag its own tests on every push.
"""

import subprocess
from pathlib import Path

import pytest

import check

AWS_KEY = "AKIA" + "Q7X2" * 4
REFRESH = "1//0" + "gAbCdEfGh" * 5
EMAIL = "jane.doe" + "@" + "gmail.com"
PHONE = "+233" + " 20 555 0100"
SERVER = "i-" + "0abc1234def567890"
ACCOUNT_ARN = "arn:aws:iam::" + "1234" + "56789012" + ":role/x"
PUBLIC_IP = "8.8." + "8.8"


def git(repo: Path, *args: str) -> str:
    out = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True)
    return out.stdout


def commit(repo: Path, files: dict[str, str], message: str = "a change", email: str = "dev@example.com") -> None:
    for name, text in files.items():
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    git(repo, "add", "-A")
    git(repo, "-c", "user.name=Dev", "-c", f"user.email={email}", "commit", "-q", "-m", message)


@pytest.fixture
def repo(tmp_path):
    """A working copy whose first commit is already on its remote."""
    remote, work = tmp_path / "remote.git", tmp_path / "work"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(remote)], check=True)
    subprocess.run(["git", "init", "-q", "-b", "main", str(work)], check=True)
    commit(work, {"README.md": f"Public already: {EMAIL.replace('jane.doe', 'owner')}\n"}, "start")
    git(work, "remote", "add", "origin", str(remote))
    git(work, "push", "-q", "-u", "origin", "main")
    return work


def run(repo: Path, secrets=None, watch=None, all_history=False):
    return check.check(repo, all_history=all_history, secrets=secrets or {}, watch=watch or [])


def kinds(report):
    return {(f.level, f.kind) for f in report.findings}


def test_nothing_new_is_nothing_found(repo):
    report = run(repo)
    assert report.commits == 0 and report.findings == [] and report.exit_code == 0
    assert "Nothing found." in check.render(report)


def test_a_key_in_a_known_shape_must_be_fixed_and_is_never_printed_whole(repo):
    commit(repo, {"app.py": f"KEY = '{AWS_KEY}'\nTOKEN = '{REFRESH}'\n"})
    report = run(repo)
    assert {("fix", "AWS access key"), ("fix", "Google refresh token")} <= kinds(report)
    assert report.exit_code == 1
    text = check.render(report)
    assert AWS_KEY not in text and REFRESH not in text and "app.py:1" in text and "app.py:2" in text


def test_a_secret_from_this_machine_s_login_files_must_be_fixed_whatever_its_shape(repo):
    value = "nG" + "rok7_" + "x" * 20   # no shape anyone would recognise
    commit(repo, {"notes.md": f"the tunnel token is {value}\n"})
    report = run(repo, secrets={value: "~/.config/ngrok/ngrok.yml"})
    finding = next(f for f in report.findings if f.level == "fix")
    assert finding.kind == "a secret from ~/.config/ngrok/ngrok.yml" and value not in check.render(report)


def test_this_machine_s_secrets_are_read_from_json_and_env_files_by_key(tmp_path):
    (tmp_path / ".env").write_text("AWS_PROFILE=dev\nGOOGLE_CLIENT_SECRET=" + "GOCSPX-" + "a" * 24 +
                                   "\nSHORT_TOKEN=abc\n# OLD_TOKEN=" + "z" * 30 + "\n")
    cfg = tmp_path / "data/config/mail"
    cfg.mkdir(parents=True)
    (cfg / "token.json").write_text('{"token": "' + "ya29." + "b" * 40 + '", "token_uri": "https://oauth2.example/token",'
                                    ' "expiry": "2026-10-30T00:00:00Z", "nested": {"refreshToken": "' + "r" * 30 + '"}}')
    found = check.known_secrets(tmp_path, (".env", "data/config/**/*.json"))
    assert sorted(found.values()) == [".env", "data/config/mail/token.json", "data/config/mail/token.json"]
    assert not any(v.startswith(("https://", "2026", "abc", "z")) for v in found)


def test_a_file_that_holds_credentials_must_be_fixed_and_an_example_need_not(repo):
    commit(repo, {".env": "A=1\n", ".env.example": "A=\n", "keys/client_secret_123.json": "{}\n",
                  "mail/token-compose.json": "{}\n", "deploy/id_ed25519": "x\n", "certs/server.pem": "x\n"})
    fixed = {f.shown for f in run(repo).findings if f.kind == "a file that holds credentials"}
    assert fixed == {".env", "keys/client_secret_123.json", "mail/token-compose.json", "deploy/id_ed25519", "certs/server.pem"}


def test_a_file_of_personal_data_is_looked_at(repo):
    commit(repo, {"data/mail-ai/mailbox.sqlite3": "x\n", "assistant/uploads/cv.md": "x\n"})
    report = run(repo)
    assert {f.shown for f in report.findings} == {"data/mail-ai/mailbox.sqlite3", "assistant/uploads/cv.md"}
    assert report.exit_code == 2


def test_personal_details_are_looked_at_unless_already_public(repo):
    commit(repo, {"plan.md": f"Write to {EMAIL} or {PHONE}. The server is {SERVER} ({ACCOUNT_ARN}) at {PUBLIC_IP}.\n"
                             f"The owner is {EMAIL.replace('jane.doe', 'owner')}.\n"})
    report = run(repo)
    assert {(f.kind, f.shown) for f in report.findings} == {
        ("email address", EMAIL), ("phone number", PHONE), ("server id", SERVER),
        ("AWS account number", "1234" + "56789012"), ("public IP address", PUBLIC_IP)}
    assert report.already_public == 1   # the owner's address is in the remote's README


def test_what_is_nobody_s_is_not_a_personal_detail(repo):
    commit(repo, {"docs.md": "Mail a@example.com, x@users.noreply.github.com or noreply" + "@anthropic.com. "
                             "Local 127.0.0.1, 10.0.0.4, 169.254.169.254 and 192.0.2.7. Version +1 2, release "
                             "1.2.3.4.5. Ids i-xyz.\n"})
    assert run(repo).findings == []


def test_a_commit_message_and_a_new_author_are_read_too(repo):
    commit(repo, {"a.txt": "x\n"}, message=f"rotate {AWS_KEY}", email=EMAIL)
    report = run(repo)
    assert ("fix", "AWS access key") in kinds(report)
    assert any(f.kind == "email address" and f.where.endswith("author") for f in report.findings)


def test_an_author_already_in_the_remote_s_history_is_not_new(repo):
    commit(repo, {"a.txt": "x\n"}, email="dev@" + "ayadata.ai")
    git(repo, "push", "-q")
    commit(repo, {"b.txt": "y\n"}, email="dev@" + "ayadata.ai")
    report = run(repo)
    assert report.findings == [] and report.already_public == 2   # author and committer


def test_a_watched_word_is_looked_at_whatever_its_case(repo):
    commit(repo, {"letter.md": "Referred by SHERIFF in person.\n"})
    report = run(repo, watch=["Sheriff"])
    assert [(f.kind, f.shown) for f in report.findings] == [("watched word", "Sheriff")]


def test_only_what_the_remote_lacks_is_read_by_default_and_all_reads_everything_for_secrets(repo):
    commit(repo, {"old.py": f"KEY = '{AWS_KEY}'\nmail = '{EMAIL}'\n"})
    git(repo, "push", "-q")
    assert run(repo).findings == []                      # already pushed: not in this push
    report = run(repo, all_history=True)
    assert kinds(report) == {("fix", "AWS access key")}  # the history was left as it is: secrets only


def test_without_a_remote_every_commit_is_read(tmp_path):
    work = tmp_path / "solo"
    subprocess.run(["git", "init", "-q", "-b", "main", str(work)], check=True)
    commit(work, {"a.py": f"KEY = '{AWS_KEY}'\n"})
    report = run(work)
    assert report.scope.startswith("every commit") and report.exit_code == 1


def test_the_command_prints_the_report_and_exits_by_what_it_found(repo, capsys):
    assert check.main(["--repo", str(repo)]) == 0
    commit(repo, {"plan.md": f"call {PHONE}\n"})
    assert check.main(["--repo", str(repo)]) == 2 and "LOOK AT before pushing" in capsys.readouterr().out


def test_this_check_s_own_files_hold_no_secret_and_no_personal_detail_whole():
    """The fakes above are built from pieces; written out they would be flagged on every push of this folder."""
    here = Path(__file__).parent
    for path in sorted(here.glob("*.py")):
        text = path.read_text(encoding="utf-8")
        assert not [name for name, shape in check.SECRET_SHAPES.items() if shape.search(text)], path.name
        assert check.look_for(text, []) == [], path.name
