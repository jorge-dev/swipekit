import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const allowed = new Set(["@biomejs/biome", "@types/node", "typescript"]);
export const requiredChecks = [
  "typecheck", "lint", "test (ubuntu-latest)", "test (macos-latest)",
  "build", "actions-lint", "pr-body", "pr-title", "analyze (javascript-typescript)", "CodeQL",
];

export function eligible(pr, files, dependencies, repository, head) {
  return pr.state === "open" && !pr.draft && pr.user.login === "dependabot[bot]" &&
    pr.user.type === "Bot" && pr.head.repo?.full_name === repository &&
    pr.base.repo.full_name === repository && pr.base.ref === "main" && pr.head.sha === head &&
    // fetch-metadata verifies the head signature; one commit excludes added human commits.
    pr.commits === 1 && files.length > 0 && files.length <= 2 &&
    files.every(file => ["package.json", "package-lock.json"].includes(file.filename) && file.status === "modified") &&
    dependencies.length > 0 && dependencies.every(dependency =>
      allowed.has(dependency.dependencyName) && dependency.dependencyType === "direct:development" &&
      dependency.packageEcosystem === "npm_and_yarn" && dependency.directory === "/" &&
      dependency.targetBranch === "main" &&
      ["version-update:semver-patch", "version-update:semver-minor"].includes(dependency.updateType));
}

export function checksPass(checks) {
  return requiredChecks.every(name => checks.some(check => check.name === name && check.bucket === "pass")) &&
    checks.every(check => check.bucket === "pass");
}

export function manifestsMatch(before, after, oldLock, newLock, dependencies) {
  const stripVersions = manifest => {
    const copy = structuredClone(manifest);
    for (const { dependencyName: name } of dependencies) {
      if (typeof copy.devDependencies?.[name] !== "string") return null;
      delete copy.devDependencies[name];
    }
    return copy;
  };
  const oldManifest = stripVersions(before);
  const newManifest = stripVersions(after);
  const oldRoot = stripVersions(oldLock.packages?.[""] ?? {});
  const newRoot = stripVersions(newLock.packages?.[""] ?? {});
  return oldManifest !== null && newManifest !== null && oldRoot !== null && newRoot !== null &&
    isDeepStrictEqual(oldManifest, newManifest) && isDeepStrictEqual(oldRoot, newRoot) &&
    isDeepStrictEqual(newLock.packages[""].devDependencies, after.devDependencies) &&
    isDeepStrictEqual({ ...oldLock, packages: null }, { ...newLock, packages: null }) &&
    Object.keys({ ...before.dependencies, ...before.devDependencies }).every(name =>
      dependencies.some(dependency => dependency.dependencyName === name) ||
      isDeepStrictEqual(oldLock.packages[`node_modules/${name}`], newLock.packages[`node_modules/${name}`]));
}

export function bodyFor(pr) {
  const marker = "<!-- swipekit-dependabot-validation -->";
  const body = pr.body ?? "";
  const end = body.startsWith(`${marker}\n`) ? body.indexOf(`${marker}\n`, marker.length) : -1;
  const original = end < 0 ? body : body.slice(end + marker.length + 1);
  return `${marker}
## Description

Dependabot updates allowlisted development dependencies. Signed bot metadata and the changed-file list passed the automatic eligibility policy for commit ${pr.head.sha}.

## How this was tested

No local commands were run by this automation. [GitHub checks](${pr.html_url}/checks) must pass before approval and merge: typecheck, lint, tests on Ubuntu and macOS, build, workflow lint, PR title/body, and CodeQL. These checks may still be pending.

## Checklist

- [x] Only package.json and/or package-lock.json changed in one verified Dependabot commit.
- [x] Every update is patch/minor for an allowlisted development dependency.
- [ ] Required GitHub checks pass (enforced again immediately before merging).

## LLM use

No LLM reviews or approves this update; the GitHub workflow applies the documented policy.

${marker}
${original}`;
}

function gh(args, input) {
  return execFileSync("gh", args, { encoding: "utf8", input });
}

function run(mode) {
  const repository = process.env.GITHUB_REPOSITORY;
  const number = process.env.PR_NUMBER;
  const head = process.env.EXPECTED_HEAD;
  const dependencies = JSON.parse(process.env.DEPENDENCIES);
  const endpoint = `repos/${repository}/pulls/${number}`;
  const pr = JSON.parse(gh(["api", endpoint]));
  const files = JSON.parse(gh(["api", `${endpoint}/files?per_page=100`]));
  if (!eligible(pr, files, dependencies, repository, head)) {
    if (mode === "merge") throw new Error("PR changed or is no longer eligible; leaving it for review.");
    appendFileSync(process.env.GITHUB_OUTPUT, "eligible=false\n");
    console.log("Leaving this update for manual review.");
    return;
  }
  const read = (path, ref) => {
    const file = JSON.parse(gh(["api", `repos/${repository}/contents/${path}?ref=${ref}`]));
    return JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
  };
  if (!manifestsMatch(
    read("package.json", pr.base.sha), read("package.json", head),
    read("package-lock.json", pr.base.sha), read("package-lock.json", head), dependencies,
  )) throw new Error("Changes extend beyond the approved development dependency versions; review required.");
  if (mode === "prepare") {
    const body = bodyFor(pr);
    if (pr.body !== body) gh(["api", endpoint, "--method", "PATCH", "--input", "-"], JSON.stringify({ body }));
    appendFileSync(process.env.GITHUB_OUTPUT, "eligible=true\n");
    return;
  }
  const checks = JSON.parse(gh(["pr", "checks", number, "--repo", repository, "--required", "--json", "name,bucket"]));
  if (!checksPass(checks)) throw new Error("All documented checks must be required and passing before automatic merge.");
  const reviews = JSON.parse(gh(["api", `${endpoint}/reviews?per_page=100`]));
  if (!reviews.some(review => review.user.login === "github-actions[bot]" && review.commit_id === head && review.state === "APPROVED")) {
    gh(["api", `${endpoint}/reviews`, "--method", "POST", "--input", "-"], JSON.stringify({
      event: "APPROVE", commit_id: head,
      body: "Verified Dependabot development patch/minor update; all required validation checks passed.",
    }));
  }
  // Merge this validated head only; never leave auto-merge armed for a later update.
  gh(["pr", "merge", number, "--repo", repository, "--squash", "--match-head-commit", head]);
}

if (["prepare", "merge"].includes(process.argv[2])) run(process.argv[2]);
