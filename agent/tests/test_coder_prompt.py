from pathlib import Path

from coding.prompt import CODER_PROMPT

SKILLS = Path(__file__).resolve().parents[1] / "coding" / "skills"


def test_coder_prompt_forbids_linear_and_requires_green_check():
    assert "You are the OpenTag coder" in CODER_PROMPT
    assert "prepare_repository" in CODER_PROMPT
    assert "publish_changes" in CODER_PROMPT
    assert "Never clone, pull, fetch, or push with git" in CODER_PROMPT
    assert "never invoke gh" in CODER_PROMPT
    assert "exit 0" in CODER_PROMPT
    assert "open anyway" in CODER_PROMPT
    assert "corepack" in CODER_PROMPT
    assert "Do not invent a test patch" in CODER_PROMPT


def test_coder_prompt_requires_full_implementation_briefs_only():
    text = CODER_PROMPT.lower()
    assert "implement-issue only" in text
    assert "files" in text
    assert "one test" in text
    assert "fix-tests, fix-ci, and merge-main" in text
    assert "checkout and logs" in text


def test_implement_issue_skill_uses_the_brief_not_repo_exploration():
    text = (SKILLS / "implement-issue" / "SKILL.md").read_text(encoding="utf-8")
    lowered = text.lower()
    assert "listed files" in lowered or "only the listed" in lowered
    assert "test command from the brief" in lowered or "one test command" in lowered
    assert "do not explore" in lowered or "do not rediscover" in lowered
    assert "do not guess" in lowered or "do not run the full" in lowered


def test_four_skill_files_exist():
    names = ["fix-tests", "merge-main", "fix-ci", "implement-issue"]
    for name in names:
        path = SKILLS / name / "SKILL.md"
        assert path.is_file(), path
        text = path.read_text(encoding="utf-8")
        assert name.replace("-", " ") in text.lower() or name in text
        assert "prepare_repository" in text
        assert "publish_changes" in text


def test_skill_files_start_with_yaml_frontmatter():
    names = ["fix-tests", "merge-main", "fix-ci", "implement-issue"]
    for name in names:
        path = SKILLS / name / "SKILL.md"
        text = path.read_text(encoding="utf-8")
        assert text.startswith("---"), path
        assert f"name: {name}" in text, path
