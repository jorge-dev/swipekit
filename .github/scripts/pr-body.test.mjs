import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("only same-repository Dependabot bot PRs bypass the body template", () => {
  const workflow = readFileSync(new URL("../workflows/pr-body.yml", import.meta.url), "utf8");
  const expression = workflow.match(/name: Require the pull request template sections\n[\s\S]*?if: >-\n([\s\S]*?)\n        env:/)[1];
  const requiresTemplate = new Function("github", `return ${expression};`);
  const repository = "jorge-dev/swipekit";
  const pr = {
    user: { login: "dependabot[bot]", type: "Bot" },
    head: { repo: { full_name: repository } },
    base: { repo: { full_name: repository } },
  };
  const check = value => requiresTemplate({ repository, event: { pull_request: value } });
  assert.equal(check(pr), false);
  assert.equal(check({ ...pr, user: { login: "human", type: "User" } }), true);
  assert.equal(check({ ...pr, user: { login: "dependabot[bot]", type: "User" } }), true);
  assert.equal(check({ ...pr, head: { repo: { full_name: "someone/fork" } } }), true);
  assert.equal(check({ ...pr, base: { repo: { full_name: "someone/fork" } } }), true);
});
