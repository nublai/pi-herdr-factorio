import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, type TestContext } from "node:test";
import { digestOf } from "../../../src/core/run.ts";
import { parseBenchTrial } from "../../../src/bench/trial.ts";
import { syntheticTrial } from "./trial-fixtures.ts";

const cli = fileURLToPath(
	new URL("../../../host/cli/index.ts", import.meta.url),
);

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "bench-compare-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const put = (name: string, trial = syntheticTrial({ id: name })) => {
		const dir = join(root, name);
		mkdirSync(dir, { mode: 0o700 });
		const raw = `${JSON.stringify(trial)}\n`;
		writeFileSync(join(dir, "trial.json"), raw, { mode: 0o600 });
		writeFileSync(join(dir, "trial.sha256"), `${digestOf(raw)}\n`, {
			mode: 0o600,
		});

		return dir;
	};

	const run = (...args: string[]) =>
		spawnSync(process.execPath, [cli, "bench", ...args], {
			encoding: "utf8",
			timeout: 15_000,
			env: { ...process.env, FACTORY_PLATFORM: "exe-dev" },
		});

	return { root, put, run };
}

describe("bench compare and spend CLI", () => {
	it("prints read-only JSON through the real command entry point", (t) => {
		const f = fixture(t);
		const a = f.put("a");

		const b = f.put(
			"b",
			syntheticTrial({ id: "b", name: "off", value: "off", tokens: 50 }),
		);

		const before = readFileSync(join(a, "trial.json"));
		const result = f.run("compare", a, b);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(JSON.parse(result.stdout).tasks[0].differences[0].tokens, -50);
		assert.ok(before.equals(readFileSync(join(a, "trial.json"))));
	});
	it("refuses corrupt digests, structurally invalid records, and duplicate directory aliases", (t) => {
		const f = fixture(t);
		const a = f.put("a");
		assert.equal(f.run("compare", a, join(a, ".")).status, 1);
		const bad = `${JSON.stringify({ ...syntheticTrial(), unexpected: true })}\n`;
		writeFileSync(join(a, "trial.json"), bad);
		assert.match(f.run("compare", a).stderr, /digest_mismatch/);
		writeFileSync(join(a, "trial.sha256"), `${digestOf(bad)}\n`);
		assert.match(f.run("compare", a).stderr, /unexpected_keys/);
	});
	it("tallies completed and interrupted recorded charges once, and reports missing charges", (t) => {
		const f = fixture(t);
		const complete = f.put("complete");
		const incomplete = join(f.root, "incomplete");
		const empty = join(f.root, "empty");

		for (const dir of [incomplete, empty]) {
			mkdirSync(join(dir, "claim"), { recursive: true });
			writeFileSync(
				join(dir, "claim/binding.json"),
				JSON.stringify({
					kind: "factory_benchmark_state",
					version: 1,
					bundleDigest: syntheticTrial().bundleDigest,
					variantDigest: syntheticTrial().variantDigest,
					tokenCap: 540000,
				}),
				{ mode: 0o600 },
			);
		}

		mkdirSync(join(incomplete, "runtime/build"), { recursive: true });
		writeFileSync(
			join(incomplete, "runtime/build/egress.requests.jsonl"),
			[
				{
					kind: "dispatch",
					req: 1,
					route: "model-openai",
					inputTokenEstimate: 40,
					maxOutputTokens: 10,
				},
			]
				.map((line) => JSON.stringify(line))
				.join("\n"),
		);
		writeFileSync(
			join(incomplete, "runtime/build/usage.json"),
			JSON.stringify({ usage: { total: 20 } }),
		);
		const result = f.run("spend", complete, incomplete, empty);
		assert.equal(result.status, 0, result.stderr);
		const value = JSON.parse(result.stdout);
		assert.equal(value.chargedTokens, 150);
		assert.equal(value.completedTrials, 1);
		assert.equal(value.incompleteTrials, 2);
		assert.equal(value.unavailableTrials, 1);
		assert.equal(value.billedSpend, "unavailable");
		assert.match(f.run("compare", incomplete).stderr, /trial_incomplete/);
	});
	it("does not add runtime charges to a completed record or count copied trial IDs twice", (t) => {
		const f = fixture(t);
		const trial = syntheticTrial();
		const completed = f.put("completed", trial);
		const copy = f.put("copy", trial);
		mkdirSync(join(completed, "runtime/build"), { recursive: true });
		writeFileSync(
			join(completed, "runtime/build/receipt.json"),
			JSON.stringify({ usage: { total: 500 } }),
		);
		const result = f.run("spend", completed);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(JSON.parse(result.stdout).chargedTokens, 100);

		for (const command of ["compare", "spend"])
			assert.match(f.run(command, completed, copy).stderr, /duplicate_trial/);
	});
	it("requires trial directories and no unrelated flags", (t) => {
		const f = fixture(t);

		for (const args of [
			["compare"],
			["spend"],
			["compare", f.root, "--run", "a"],
		])
			assert.equal(f.run(...args).status, 2);
	});
});

describe("parseBenchTrial", () => {
	it("round-trips the complete trial schema", () => {
		const trial = syntheticTrial();
		const result = parseBenchTrial(JSON.stringify(trial));
		assert.equal(result.id, trial.id);
		assert.equal(result.accounting.chargedTokens, 100);
	});
	it("rejects unknown and duplicate keys, missing fields, invalid numbers, digests, outcomes and timestamps", () => {
		const trial = syntheticTrial();

		for (const value of [
			{ ...trial, version: 2 },
			{ ...trial, id: "bad" },
			{ ...trial, wallMs: -1 },
			{ ...trial, endedAt: "yesterday" },
			{ ...trial, outcome: { kind: "maybe" } },
			{ ...trial, variantDigest: digestOf("wrong") },
			{ ...trial, tokenCap: Number.MAX_SAFE_INTEGER + 1 },
			{
				...trial,
				accounting: { ...trial.accounting, sources: ["build", "build"] },
			},
			{ ...trial, runtime: { ...trial.runtime, surprise: true } },
		])
			assert.throws(() => parseBenchTrial(JSON.stringify(value)));
		assert.throws(() =>
			parseBenchTrial(
				JSON.stringify(trial).replace('"version":1', '"version":1,"version":1'),
			),
		);
		const { judges: _judges, ...missing } = trial;
		assert.throws(() => parseBenchTrial(JSON.stringify(missing)));
	});
});
