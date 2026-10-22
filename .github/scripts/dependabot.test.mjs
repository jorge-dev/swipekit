import assert from "node:assert/strict";
import { test } from "node:test";
import { bodyFor, checksPass, eligible, manifestsMatch, requiredChecks } from "./dependabot.mjs";

const pr = {
  state: "open", draft: false, commits: 1, body: "Original release notes",
  html_url: "https://github.com/jorge-dev/swipekit/pull/1",
  user: { login: "dependabot[bot]", type: "Bot" },
  head: { sha: "abc", repo: { full_name: "jorge-dev/swipekit" } },
  base: { ref: "main", repo: { full_name: "jorge-dev/swipekit" } },
};
const files = [{ filename: "package-lock.json", status: "modified" }];
const dependency = {
  dependencyName: "typescript", dependencyType: "direct:development",
  packageEcosystem: "npm_and_yarn", directory: "/", targetBranch: "main",
  updateType: "version-update:semver-minor",
};
const accepts = (pull = pr, changes = files, dependencies = [dependency], head = "abc") =>
  eligible(pull, changes, dependencies, "jorge-dev/swipekit", head);

test("only authenticated, unchanged, single-commit dev patch/minor PRs qualify", () => {
  assert.equal(accepts(), true);
  assert.equal(accepts(pr, files, [{ ...dependency, dependencyName: "@types/node", updateType: "version-update:semver-patch" }]), true);
  for (const change of [
    { state: "closed" }, { draft: true }, { commits: 2 },
    { user: { login: "someone", type: "User" } },
    { head: { ...pr.head, repo: { full_name: "fork/swipekit" } } },
    { base: { ...pr.base, ref: "release" } },
  ]) assert.equal(accepts({ ...pr, ...change }), false);
  assert.equal(accepts(pr, files, [dependency], "stale"), false);
  assert.equal(accepts(pr, [], [dependency]), false);
  assert.equal(accepts(pr, [{ filename: ".github/workflows/ci.yml", status: "modified" }]), false);
  assert.equal(accepts(pr, [{ filename: "package.json", status: "added" }]), false);
  assert.equal(accepts(pr, files, []), false);
  for (const change of [
    { dependencyName: "playwright-core" }, { dependencyName: "zod" },
    { dependencyName: "@modelcontextprotocol/sdk" },
    { dependencyType: "direct:production" }, { updateType: "version-update:semver-major" },
    { updateType: "" }, { packageEcosystem: "github_actions" }, { directory: "/subdir" },
    { targetBranch: "release" },
  ]) assert.equal(accepts(pr, files, [dependency, { ...dependency, ...change }]), false);
});

test("missing, skipped, failing, or pending required checks fail closed", () => {
  const checks = requiredChecks.map(name => ({ name, bucket: "pass" }));
  assert.equal(checksPass(checks), true);
  assert.equal(checksPass([]), false);
  assert.equal(checksPass(checks.slice(1)), false);
  for (const bucket of ["fail", "pending", "skipping", "cancel"]) {
    assert.equal(checksPass([{ ...checks[0], bucket }, ...checks.slice(1)]), false);
  }
  assert.equal(checksPass([...checks, { name: "new-required-check", bucket: "pending" }]), false);
});

test("manifest edits cannot change scripts, runtime packages, or other dev dependencies", () => {
  const before = { scripts: { test: "node --test" }, dependencies: { zod: "^4.0.0" }, devDependencies: { typescript: "^7.0.1", other: "^1.0.0" } };
  const after = { ...before, devDependencies: { ...before.devDependencies, typescript: "^7.0.2" } };
  const lock = manifest => ({ lockfileVersion: 3, packages: { "": manifest, "node_modules/zod": { version: "4.0.0" } } });
  const accepts = (manifest = after, oldLock = lock(before), newLock = lock(manifest)) =>
    manifestsMatch(before, manifest, oldLock, newLock, [dependency]);
  assert.equal(accepts(), true);
  assert.equal(accepts({ ...after, scripts: { test: "echo skip" } }), false);
  assert.equal(accepts({ ...after, dependencies: { zod: "^5.0.0" } }), false);
  assert.equal(accepts({ ...after, devDependencies: { ...after.devDependencies, other: "^2.0.0" } }), false);
  assert.equal(accepts({ ...after, devDependencies: {} }), false);
  assert.equal(accepts(after, lock(before), lock(before)), false);
  assert.equal(accepts(after, lock(before), { ...lock(after), lockfileVersion: 4 }), false);
  const changedRuntime = lock(after);
  changedRuntime.packages["node_modules/zod"].version = "4.0.1";
  assert.equal(accepts(after, lock(before), changedRuntime), false);
  const changedOtherDev = lock(after);
  changedOtherDev.packages["node_modules/other"] = { version: "2.0.0" };
  assert.equal(accepts(after, lock(before), changedOtherDev), false);
});

test("generated body is idempotent, preserves notes, and records the current head", () => {
  const body = bodyFor(pr);
  assert.ok(body.endsWith(pr.body));
  assert.equal(bodyFor({ ...pr, body }), body);
  assert.match(body, /checks may still be pending/);
  const updated = bodyFor({ ...pr, body, head: { ...pr.head, sha: "new-head" } });
  assert.match(updated, /commit new-head/);
  assert.doesNotMatch(updated, /commit abc/);
  const notes = "Release notes mention <!-- swipekit-dependabot-validation -->\nmore notes";
  assert.ok(bodyFor({ ...pr, body: notes }).endsWith(notes));
});
