import re
import tomllib
from collections.abc import Iterable
from pathlib import Path

AGENT_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = Path(__file__).resolve().parents[2]

# Directories that sit beside the runtime code and must never reach the wheel or
# the image. Named, rather than left to a denylist that happened to be right:
# the derivation below reads "every package on disk ships", so a `scripts` or a
# `tests` package would otherwise make this file demand that developer tooling
# be installed into site-packages.
NOT_SHIPPED_PACKAGES = frozenset({".venv", "scripts", "tests"})

# Same, one level up. A `conftest.py` at the agent root is pytest scaffolding,
# not a runtime module, and the wheel has no business carrying it.
NOT_SHIPPED_MODULES = frozenset({"conftest"})

# A floor under every derived set below. Deriving from disk is what keeps these
# assertions honest for the next person to add a module, but a derived set only
# asserts something while it has something in it: a glob that matches nothing —
# a moved test file, a renamed layout — turns every comparison here into
# `set() == set()`. These names must appear whatever the glob does.
KNOWN_MODULES = frozenset({"agent", "agent_auth", "main"})
KNOWN_PACKAGE_ROOTS = frozenset({"coding", "composio_tools", "prompts"})

#: The first `composio` release whose client exposes `.sessions`. Everything in
#: `composio_tools/sessions.py` goes through it, and below this release the SDK
#: offers `tool_router` and no alias — so a resolver that picked a lower version
#: satisfies the floor, installs, imports, and raises `AttributeError` on the
#: first turn that touches a toolkit. Verified against the published wheels:
#: 0.16.0 has no `def sessions`, 0.17.0 does, and 0.17.0 already accepts the
#: `sandbox` and `manage_connections` arguments this repository passes.
COMPOSIO_SESSIONS_FLOOR = (0, 17, 0)

#: Floors that are not a matter of taste: the earliest release carrying an API
#: this repository actually calls.
REQUIRED_FLOORS = {"composio": COMPOSIO_SESSIONS_FLOOR}


def runtime_modules() -> set[str]:
    """Every top-level module on disk that the wheel has to carry."""
    modules = {
        path.stem
        for path in AGENT_ROOT.glob("*.py")
        if path.name != "__init__.py" and path.stem not in NOT_SHIPPED_MODULES
    }
    assert KNOWN_MODULES <= modules, f"module discovery is broken: {modules}"
    return modules


def package_roots() -> set[str]:
    """The top-level packages. What the image copies, one directory at a time."""
    roots = {
        path.parent.name
        for path in AGENT_ROOT.glob("*/__init__.py")
        if path.parent.name not in NOT_SHIPPED_PACKAGES
    }
    assert KNOWN_PACKAGE_ROOTS <= roots, f"package discovery is broken: {roots}"
    return roots


def package_names(init_paths: Iterable[Path], root: Path) -> set[str]:
    """
    The dotted names of the packages `init_paths` describe, minus what never ships.

    Split out and given its root so the exclusion can be tested at a depth the
    checkout does not currently have. `NOT_SHIPPED_PACKAGES` is matched against
    every path segment rather than only the first: the version that looked at
    the top-level name alone let a `composio_tools/tests/__init__.py` through,
    and this file would then have demanded that a test package be listed in the
    wheel — a derived assertion arguing for the opposite of what it exists for.
    """
    names = set()
    for path in init_paths:
        parts = path.parent.relative_to(root).parts
        if NOT_SHIPPED_PACKAGES.intersection(parts):
            continue
        names.add(".".join(parts))
    return names


def runtime_packages() -> set[str]:
    """
    Every package setuptools has to be named, nested ones included.

    `packages` is an explicit list and setuptools does not walk it: naming
    `composio_tools` does not carry `composio_tools.adapters`, which then
    imports fine from a source checkout and is missing from the wheel. A
    depth-one scan is that exact failure, so this one goes all the way down.

    Down from the package roots, not from the agent directory: a build leaves
    `build/lib/<package>/__init__.py` behind, and a sweep of the whole tree
    would then ask setuptools to package its own output.
    """
    return package_names(
        (
            path
            for root in package_roots()
            for path in (AGENT_ROOT / root).rglob("__init__.py")
        ),
        AGENT_ROOT,
    )


def lower_bound(requirement: str) -> tuple[int, ...] | None:
    """The `>=` floor in a requirement, as a comparable tuple, or `None`."""
    match = re.search(r">=\s*(\d+(?:\.\d+)*)", requirement)
    return tuple(int(part) for part in match.group(1).split(".")) if match else None


def declared_dependencies() -> dict[str, str]:
    """Each declared dependency's distribution name mapped to its full requirement."""
    project = tomllib.loads((AGENT_ROOT / "pyproject.toml").read_text())
    declared = {}
    for requirement in project["project"]["dependencies"]:
        name = re.split(r"[\s\[<>=!~;(]", requirement, maxsplit=1)[0]
        declared[name.strip().lower().replace("_", "-")] = requirement
    return declared


def test_wheel_includes_every_runtime_module():
    project = tomllib.loads((AGENT_ROOT / "pyproject.toml").read_text())

    assert set(project["tool"]["setuptools"]["py-modules"]) == runtime_modules()

    # Derived, not listed. A hardcoded list passes for whoever wrote it and
    # fails the next person to add a package, which is backwards: the point is
    # to catch a package that exists on disk and never reaches the wheel.
    assert set(project["tool"]["setuptools"]["packages"]) == runtime_packages()


def test_nested_test_packages_never_reach_the_wheel():
    # At a depth the checkout does not currently have, which is the whole point:
    # the exclusion used to read the first path segment only, so the day someone
    # adds `composio_tools/tests/` this file starts demanding the test package
    # ship in the wheel.
    root = Path("/agent")

    assert package_names(
        [
            root / "composio_tools" / "__init__.py",
            root / "composio_tools" / "adapters" / "__init__.py",
            root / "composio_tools" / "tests" / "__init__.py",
            root / "composio_tools" / "tests" / "fixtures" / "__init__.py",
            root / "tests" / "__init__.py",
            root / ".venv" / "lib" / "site-packages" / "anything" / "__init__.py",
        ],
        root,
    ) == {"composio_tools", "composio_tools.adapters"}


def test_agent_image_copies_every_runtime_module():
    # Deleting `COPY agent/*.py ./` leaves an image with no `main.py`, which is
    # the file its own CMD runs: the container cannot boot at all. The package
    # assertion below never looked at it, so that deletion passed the suite.
    #
    # Each COPY's source is expanded against the checkout rather than compared
    # as text, so the assertion holds however the line is written — one glob or
    # seven explicit paths — and fails when it stops covering a module.
    dockerfile = (
        REPO_ROOT / "deployment" / "docker" / "agent.Dockerfile"
    ).read_text(encoding="utf-8")

    copied = set()
    for source, target in re.findall(r"^COPY agent/(\S+) (\S+)$", dockerfile, re.M):
        if not source.endswith(".py") or target not in ("./", "."):
            continue
        copied |= {path.stem for path in AGENT_ROOT.glob(source)}

    assert copied - NOT_SHIPPED_MODULES == runtime_modules()


def test_agent_image_copies_every_runtime_package():
    # The image copies packages one line at a time, so a new package imports
    # fine locally and crashes the container on first import. Derived from disk
    # for the same reason as the wheel assertion above. Nested packages come
    # along with their root's directory, so only the roots are checked here.
    dockerfile = (
        REPO_ROOT / "deployment" / "docker" / "agent.Dockerfile"
    ).read_text(encoding="utf-8")

    # Anchored and matched as a whole line, because `"COPY agent/x ./x" in text`
    # is satisfied by a commented-out COPY. Compared as a set rather than one
    # membership check at a time, because equality also catches a COPY left
    # behind for a directory that no longer exists — which fails the build.
    copied = set(
        re.findall(r"^COPY agent/(\S+) \./\1$", dockerfile, flags=re.MULTILINE)
    )

    assert copied == package_roots()


def test_coding_dependencies_are_declared():
    declared = declared_dependencies()

    # Whole names, not prefixes: `dep.startswith("httpx")` was satisfied by
    # `httpx-sse`, a different distribution that does not provide `httpx`.
    # `composio` is in the list because the agent imports it unconditionally
    # from `composio_tools/sessions.py`, and nothing here asserted it was
    # declared at all.
    assert {"composio", "daytona", "langchain-daytona", "httpx", "pyjwt"} <= set(
        declared
    )

    # And the extra, not merely the distribution: the coder signs GitHub App
    # tokens with `cryptography`, which only the `crypto` extra pulls in.
    assert "[crypto]" in declared["pyjwt"]


def test_every_dependency_declares_a_lower_bound():
    # A bare `daytona` resolves to whatever the index offers on the day the
    # image is built, including a release that renamed the API underneath us,
    # and the lockfile hides that until someone regenerates it. A floor is the
    # only part of this that survives a re-resolve.
    unbounded = sorted(
        requirement
        for requirement in declared_dependencies().values()
        if lower_bound(requirement) is None
    )

    assert unbounded == []


def test_pinned_apis_declare_a_floor_that_has_them():
    declared = declared_dependencies()

    for name, floor in REQUIRED_FLOORS.items():
        assert lower_bound(declared[name]) >= floor, (
            f"{declared[name]} admits a release without the API this repo calls"
        )


def test_the_project_is_actually_built():
    # Without `[build-system]` the whole `[tool.setuptools]` table above is
    # inert: uv treats the project as virtual, never builds it, and the wheel
    # the assertions in this file describe is never produced by anything. The
    # image's `uv sync --frozen --no-dev` after the source COPYs is the step
    # that builds it, and it only builds a project that names a backend.
    project = tomllib.loads((AGENT_ROOT / "pyproject.toml").read_text())

    assert project["build-system"]["build-backend"] == "setuptools.build_meta"
    # And the backend the `[tool.setuptools]` config is written for has to be
    # in the build requirements, or the build reaches for whatever is around.
    assert any(
        requirement.startswith("setuptools")
        for requirement in project["build-system"]["requires"]
    )
