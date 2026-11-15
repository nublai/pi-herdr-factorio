import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  labeled,
  runOf,
  statuses,
  world,
} from "../../../../test/src/controller/orchestrator-fixtures.ts";

test("the mandatory test entry point includes controller regression tests", () => {
  const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
  assert.equal(typeof manifest.scripts.check, "string");
  assert.match(manifest.scripts.check, /\bnpm test\b/);
  assert.match(manifest.scripts.test, /--test\b/);
  assert.ok(manifest.scripts.test.includes("test/src/**/*.test.ts"));
  assert.ok(manifest.scripts.test.includes("test/host/**/*.test.ts"));
});

test("the existing mandatory dispatch fixture preserves claim and restart behavior", async () => {
  const { github, executor, start } = world();
  github.add(labeled(14));

  const first = await start().tick();
  assert.deepEqual(first.dispatch, { enabled: true, reasons: [] });
  assert.equal(first.runs.length, 1);
  assert.equal(first.runs[0]?.runId, runOf(14));
  assert.equal(first.runs[0]?.status, "blocked");
  assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
  assert.equal(executor.launches.length, 1);

  const restarted = await start().tick();
  assert.equal(restarted.runs.length, 1);
  assert.equal(restarted.runs[0]?.runId, runOf(14));
  assert.equal(restarted.runs[0]?.status, "blocked");
  assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
  assert.equal(executor.launches.length, 2);
});
// factory-holdout-b72b79c2c0975a465cdecd0b1d95de533430cff1402bddfbc027f8a1d4ac4c7d
