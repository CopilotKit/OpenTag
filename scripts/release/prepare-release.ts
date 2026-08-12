import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Bump = "baseline" | "patch" | "minor" | "major";

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

export interface Commit {
  hash: string;
  subject: string;
}

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseVersion(value: string): Version {
  const match = VERSION_PATTERN.exec(value);
  if (!match) throw new Error(`Invalid stable semantic version: ${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function formatVersion(version: Version): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export function nextVersion(current: string, bump: Bump): string {
  const version = parseVersion(current);
  if (bump === "baseline") return current;
  if (bump === "major") {
    return formatVersion({ major: version.major + 1, minor: 0, patch: 0 });
  }
  if (bump === "minor") {
    return formatVersion({
      major: version.major,
      minor: version.minor + 1,
      patch: 0,
    });
  }
  return formatVersion({ ...version, patch: version.patch + 1 });
}

export function validateReleaseState(
  current: string,
  bump: Bump,
  tags: string[],
): void {
  parseVersion(current);
  const stableTags = tags.filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  if (bump === "baseline") {
    if (current !== "0.2.0" || stableTags.length > 0) {
      throw new Error(
        "baseline is only valid for the first v0.2.0 release with no existing stable tags",
      );
    }
    return;
  }
  if (!stableTags.includes(`v${current}`)) {
    throw new Error(
      `package.json version ${current} has not been released; create its baseline release before bumping`,
    );
  }
}

export function generateReleaseNotes(
  version: string,
  commits: Commit[],
): string {
  const sections = [
    { title: "Features", commits: [] as Commit[] },
    { title: "Fixes", commits: [] as Commit[] },
    { title: "Other Changes", commits: [] as Commit[] },
  ];
  for (const commit of commits) {
    if (/^feat[:(]/.test(commit.subject)) sections[0]?.commits.push(commit);
    else if (/^fix[:(]/.test(commit.subject)) sections[1]?.commits.push(commit);
    else sections[2]?.commits.push(commit);
  }

  const lines = [`## v${version}`, ""];
  if (commits.length === 0) {
    lines.push("No changes since the previous release.", "");
  } else {
    for (const section of sections) {
      if (section.commits.length === 0) continue;
      lines.push(`### ${section.title}`, "");
      for (const commit of section.commits) {
        lines.push(`- ${commit.subject} (${commit.hash.slice(0, 7)})`);
      }
      lines.push("");
    }
  }
  lines.push(
    "### Container images",
    "",
    `- \`ghcr.io/copilotkit/opentag-agent:v${version}\``,
    `- \`ghcr.io/copilotkit/opentag-runtime:v${version}\``,
    "",
  );
  return `${lines.join("\n").trimEnd()}\n`;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function parseArgs(argv: string[]): { bump: Bump; dryRun: boolean } {
  const bumpIndex = argv.indexOf("--bump");
  const bump = argv[bumpIndex + 1] as Bump | undefined;
  if (!bump || !["baseline", "patch", "minor", "major"].includes(bump)) {
    throw new Error(
      "Usage: prepare-release.ts --bump <baseline|patch|minor|major> [--dry-run]",
    );
  }
  return { bump, dryRun: argv.includes("--dry-run") };
}

function main(): void {
  const { bump, dryRun } = parseArgs(process.argv.slice(2));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const packagePath = path.join(root, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
    version: string;
    [key: string]: unknown;
  };
  const tagsOutput = git(root, ["tag", "--list", "v*", "--sort=-version:refname"]);
  const tags = tagsOutput.length > 0 ? tagsOutput.split("\n") : [];
  validateReleaseState(packageJson.version, bump, tags);

  const version = nextVersion(packageJson.version, bump);
  const previousTag = tags.find((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  const range = previousTag ? `${previousTag}..HEAD` : "HEAD";
  const log = git(root, ["log", range, "--pretty=format:%h%x09%s"]);
  const commits = log.length === 0
    ? []
    : log.split("\n").map((line) => {
        const [hash = "", ...subject] = line.split("\t");
        return { hash, subject: subject.join("\t") };
      });
  const notes = generateReleaseNotes(version, commits);

  console.log(`Current version: ${packageJson.version}`);
  console.log(`Release version: ${version}`);
  console.log(`Commits included: ${commits.length}`);
  if (dryRun) {
    console.log("Dry run: package.json and release-notes.md were not changed.");
    return;
  }

  packageJson.version = version;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  writeFileSync(path.join(root, "release-notes.md"), notes);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
  }
}

const entrypoint = process.argv[1]
  ? path.resolve(process.argv[1])
  : undefined;
if (entrypoint === fileURLToPath(import.meta.url)) main();
