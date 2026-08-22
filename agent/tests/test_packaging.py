import tomllib
from pathlib import Path


def test_wheel_includes_every_runtime_module():
    agent_root = Path(__file__).resolve().parent.parent
    project = tomllib.loads((agent_root / "pyproject.toml").read_text())
    packaged_modules = set(project["tool"]["setuptools"]["py-modules"])
    runtime_modules = {
        path.stem
        for path in agent_root.glob("*.py")
        if path.name != "__init__.py"
    }

    assert packaged_modules == runtime_modules
    assert project["tool"]["setuptools"]["packages"] == ["prompts", "coding"]


def test_agent_image_copies_the_coding_package():
    repo_root = Path(__file__).resolve().parents[2]
    dockerfile = (
        repo_root / "deployment" / "docker" / "agent.Dockerfile"
    ).read_text(encoding="utf-8")
    assert "COPY agent/coding ./coding" in dockerfile


def test_coding_dependencies_are_declared():
    agent_root = Path(__file__).resolve().parent.parent
    project = tomllib.loads((agent_root / "pyproject.toml").read_text())
    deps = project["project"]["dependencies"]
    assert any(dep.startswith("daytona") for dep in deps)
    assert any(dep.startswith("langchain-daytona") for dep in deps)
    assert any(dep.startswith("httpx") for dep in deps)
    assert any(dep.startswith("pyjwt[crypto]") for dep in deps)
