import tomllib
from pathlib import Path


def test_python_package_uses_opentag_identity():
    pyproject_path = Path(__file__).parents[1] / "pyproject.toml"
    project = tomllib.loads(pyproject_path.read_text())["project"]

    assert project["name"] == "opentag-agent"
    assert project["description"].startswith("OpenTag on-call triage agent")


def test_deepagents_minimum_supports_harness_profiles():
    pyproject_path = Path(__file__).parents[1] / "pyproject.toml"
    project = tomllib.loads(pyproject_path.read_text())["project"]

    assert "deepagents>=0.6.12" in project["dependencies"]


def test_agent_uses_datadogs_dogstatsd_client():
    pyproject_path = Path(__file__).parents[1] / "pyproject.toml"
    project = tomllib.loads(pyproject_path.read_text())["project"]

    assert any(dependency.startswith("datadog>=") for dependency in project["dependencies"])
