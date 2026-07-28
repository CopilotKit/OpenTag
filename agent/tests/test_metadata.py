import tomllib
from pathlib import Path


def test_python_package_uses_opentag_identity():
    pyproject_path = Path(__file__).parents[1] / "pyproject.toml"
    project = tomllib.loads(pyproject_path.read_text())["project"]

    assert project["name"] == "opentag-agent"
    assert project["description"].startswith("OpenTag on-call triage agent")
