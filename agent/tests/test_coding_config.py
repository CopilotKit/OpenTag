from coding import config


def test_coding_disabled_without_daytona_key(monkeypatch):
    monkeypatch.delenv("DAYTONA_API_KEY", raising=False)
    monkeypatch.setenv("GITHUB_PERSONAL_ACCESS_TOKEN", "github_pat_test")
    assert config.coding_enabled() is False


def test_coding_disabled_without_github_token(monkeypatch):
    monkeypatch.setenv("DAYTONA_API_KEY", "dtn_test")
    monkeypatch.delenv("GITHUB_PERSONAL_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("GITHUB_CODER_TOKEN", raising=False)
    assert config.coding_enabled() is False


def test_coding_enabled_with_daytona_and_pat(monkeypatch):
    monkeypatch.setenv("DAYTONA_API_KEY", "dtn_test")
    monkeypatch.setenv("GITHUB_PERSONAL_ACCESS_TOKEN", "github_pat_test")
    monkeypatch.delenv("GITHUB_CODER_TOKEN", raising=False)
    assert config.coding_enabled() is True
    assert config.write_token() == "github_pat_test"


def test_coder_token_overrides_pat(monkeypatch):
    monkeypatch.setenv("GITHUB_PERSONAL_ACCESS_TOKEN", "github_pat_read")
    monkeypatch.setenv("GITHUB_CODER_TOKEN", "github_pat_write")
    assert config.write_token() == "github_pat_write"


def test_allowlist_unset_allows_any_repo(monkeypatch):
    monkeypatch.delenv("GITHUB_ALLOWED_REPOS", raising=False)
    assert config.repo_is_allowed("any/repo") is True


def test_allowlist_matches_exact_and_org_glob(monkeypatch):
    monkeypatch.setenv("GITHUB_ALLOWED_REPOS", "CopilotKit/OpenTag, acme/*")
    assert config.repo_is_allowed("CopilotKit/OpenTag") is True
    assert config.repo_is_allowed("acme/widgets") is True
    assert config.repo_is_allowed("other/repo") is False


def test_ttl_defaults_to_sixty_and_rejects_junk(monkeypatch):
    monkeypatch.delenv("DAYTONA_TTL_MINUTES", raising=False)
    assert config.ttl_minutes() == 60
    monkeypatch.setenv("DAYTONA_TTL_MINUTES", "nope")
    assert config.ttl_minutes() == 60
    monkeypatch.setenv("DAYTONA_TTL_MINUTES", "15")
    assert config.ttl_minutes() == 15


def test_snapshot_is_none_when_unset(monkeypatch):
    monkeypatch.delenv("DAYTONA_SNAPSHOT", raising=False)
    assert config.snapshot_id() is None
    monkeypatch.setenv("DAYTONA_SNAPSHOT", "snap-1")
    assert config.snapshot_id() == "snap-1"
