import { describe, expect, it } from "vitest";
import {
  generateReleaseNotes,
  nextVersion,
  parseVersion,
  validateReleaseState,
} from "./prepare-release.js";

describe("release preparation", () => {
  it("computes stable semantic version bumps", () => {
    expect(nextVersion("0.2.0", "baseline")).toBe("0.2.0");
    expect(nextVersion("0.2.0", "patch")).toBe("0.2.1");
    expect(nextVersion("0.2.0", "minor")).toBe("0.3.0");
    expect(nextVersion("0.2.0", "major")).toBe("1.0.0");
  });

  it("rejects malformed versions", () => {
    expect(() => parseVersion("v0.2.0")).toThrow(/Invalid/);
    expect(() => parseVersion("0.2")).toThrow(/Invalid/);
    expect(() => parseVersion("01.2.0")).toThrow(/Invalid/);
  });

  it("only permits the one-time v0.2.0 baseline", () => {
    expect(() => validateReleaseState("0.2.0", "baseline", [])).not.toThrow();
    expect(() =>
      validateReleaseState("0.2.0", "baseline", ["v0.1.0"]),
    ).toThrow(/baseline/);
    expect(() => validateReleaseState("0.3.0", "baseline", [])).toThrow(
      /baseline/,
    );
  });

  it("requires the current version to have a release before bumping", () => {
    expect(() =>
      validateReleaseState("0.2.0", "patch", ["v0.2.0"]),
    ).not.toThrow();
    expect(() => validateReleaseState("0.2.0", "patch", [])).toThrow(
      /has not been released/,
    );
  });

  it("groups release notes and names both versioned images", () => {
    const notes = generateReleaseNotes("0.2.1", [
      { hash: "abcdef0123", subject: "feat: ship it" },
      { hash: "1234567890", subject: "fix(runtime): stay online" },
      { hash: "9876543210", subject: "docs: explain it" },
    ]);

    expect(notes).toContain("### Features");
    expect(notes).toContain("### Fixes");
    expect(notes).toContain("### Other Changes");
    expect(notes).toContain("opentag-agent:v0.2.1");
    expect(notes).toContain("opentag-runtime:v0.2.1");
  });
});
