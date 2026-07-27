from pathlib import Path
import tomllib


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
