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
	it("spend covers nested specify journals once, retaining incomplete aggregate floors", (t) => {
		const f = fixture(t);
		const dir = join(f.root, "nested");
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
		mkdirSync(join(dir, "runtime/specify/draft"), { recursive: true });
		mkdirSync(join(dir, "runtime/specify/review"), { recursive: true });
		writeFileSync(join(dir, "runtime/specify/specify.json"), '{"version":1}');
		writeFileSync(
			join(dir, "runtime/specify/receipt.json"),
			JSON.stringify({ usage: { total: 30 } }),
		);

		for (const session of ["draft", "review"])
			writeFileSync(
				join(dir, `runtime/specify/${session}/egress.requests.jsonl`),
				JSON.stringify({
					kind: "result",
					req: 1,
					route: "model-openai",
					inputTokens: 10,
					outputTokens: 5,
					status: 200,
				}),
			);
		const exact = f.run("spend", dir);
		assert.equal(exact.status, 0, exact.stderr);
		assert.equal(JSON.parse(exact.stdout).chargedTokens, 30);
		assert.equal(JSON.parse(exact.stdout).trials[0].coverage, "exact");
		writeFileSync(
			join(dir, "runtime/specify/receipt.json"),
			JSON.stringify({ usage: { total: 50 } }),
		);
		const floor = f.run("spend", dir);
		assert.equal(floor.status, 0, floor.stderr);
		assert.equal(JSON.parse(floor.stdout).chargedTokens, 50);
		assert.equal(JSON.parse(floor.stdout).trials[0].coverage, "lower_bound");
		rmSync(join(dir, "runtime/specify/review/egress.requests.jsonl"));
		const missing = f.run("spend", dir);
		assert.equal(missing.status, 0, missing.stderr);
		assert.ok(
			JSON.parse(missing.stdout).trials[0].unavailableStages.includes(
				"specify/review",
			),
		);
	});
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

	for (const [prefix, stage] of [
		["specify", "specify"],
		["accept", "accept"],
		["model", "build"],
	] as const)
		for (const [exit, diagnostic, expected] of [
			["malformed", null, "attempts"],
			["error", "accept_tool_limit", "attempts"],
			["error", "accept_request_limit", "attempts"],
			["error", "accept_length", "attempts"],
			["error", "prompt_response_failed", "infrastructure"],
			["crashed", null, "infrastructure"],
			["aborted", null, "infrastructure"],
		] as const)
			it(`reads legacy ${prefix}_failed's ${exit}/${diagnostic} receipt without changing stored bytes`, (t) => {
				const f = fixture(t);

				const dir = f.put("r-401-3", {
					...syntheticTrial({ id: "r-401-3" }),
					outcome: { kind: "failed", stage, reason: `${prefix}_failed` },
				});

				const runtime = join(dir, "runtime", stage);
				mkdirSync(runtime, { recursive: true });
				writeFileSync(
					join(runtime, "receipt.json"),
					JSON.stringify({
						outcome: { kind: "failed", exit },
						diagnostic,
					}),
					{ mode: 0o600 },
				);
				const before = readFileSync(join(dir, "trial.json"));
				const result = f.run("compare", dir);
				assert.equal(result.status, 0, result.stderr);
				const summary = JSON.parse(result.stdout).variants[0].summary;
				assert.equal(summary.failureClasses[expected], 1);
				assert.equal(
					summary.passRate.candidateFailures,
					expected === "attempts" ? 1 : 0,
				);
				assert.equal(
					summary.passRate.harnessFailures,
					expected === "infrastructure" ? 1 : 0,
				);
				assert.ok(before.equals(readFileSync(join(dir, "trial.json"))));
			});

	for (const [diagnostic, expected] of [
		["secret-in-request", "infrastructure"],
		["upstream-error", "infrastructure"],
		["upstream-timeout", "infrastructure"],
		["audit-unavailable", "infrastructure"],
		["response-blocked", "infrastructure"],
		["redirect-refused", "infrastructure"],
		["upstream-address-refused", "infrastructure"],
		["body-not-allowed", "attempts"],
	] as const)
		it(`uses the failed specify leaf's gateway ${diagnostic} evidence, not a generic error assumption`, (t) => {
			const f = fixture(t);

			const dir = f.put("legacy", {
				...syntheticTrial(),
				outcome: { kind: "failed", stage: "specify", reason: "specify_failed" },
			});

			const runtime = join(dir, "runtime/specify/draft");
			mkdirSync(runtime, { recursive: true });
			writeFileSync(
				join(runtime, "receipt.json"),
				JSON.stringify({ outcome: { kind: "failed", exit: "error" } }),
				{ mode: 0o600 },
			);
			writeFileSync(
				join(runtime, "egress.jsonl"),
				JSON.stringify({ route: "model-openai", reason: diagnostic }),
				{ mode: 0o600 },
			);
			const result = f.run("compare", dir);
			assert.equal(result.status, 0, result.stderr);
			const value = JSON.parse(result.stdout);
			assert.equal(value.variants[0].summary.failureClasses[expected], 1);
			assert.equal(
				value.tasks[0].variants[0].trials[0].outcome.reason,
				`specify_failed_error:${diagnostic}`,
			);
		});

	it("uses the retried accept receipt and ignores a recovered transport error", (t) => {
		const f = fixture(t);

		const dir = f.put("retry", {
			...syntheticTrial(),
			accounting: {
				...syntheticTrial().accounting,
				sources: ["accept", "accept-retry"],
			},
			outcome: { kind: "failed", stage: "accept", reason: "accept_failed" },
		});

		for (const stage of ["accept", "accept-retry"]) {
			const runtime = join(dir, "runtime", stage);
			mkdirSync(runtime, { recursive: true });
			writeFileSync(
				join(runtime, "receipt.json"),
				JSON.stringify({
					outcome: {
						kind: "failed",
						exit: stage === "accept" ? "crashed" : "error",
					},
				}),
				{ mode: 0o600 },
			);
		}

		writeFileSync(
			join(dir, "runtime/accept-retry/egress.jsonl"),
			[
				{ route: "model-openai", reason: "upstream-error" },
				{ route: "model-openai", reason: null },
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n"),
			{ mode: 0o600 },
		);
		const result = f.run("compare", dir);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(
			JSON.parse(result.stdout).variants[0].summary.passRate.candidateFailures,
			1,
		);
	});

	it("counts a legacy failure without a receipt as attempts", (t) => {
		const f = fixture(t);

		const dir = f.put("missing", {
			...syntheticTrial(),
			outcome: { kind: "failed", stage: "build", reason: "model_failed" },
		});

		const result = f.run("compare", dir);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(
			JSON.parse(result.stdout).variants[0].summary.failureClasses.attempts,
			1,
		);
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
		const compared = f.run("compare", complete, incomplete, empty);
		assert.equal(compared.status, 0, compared.stderr);
		assert.equal(JSON.parse(compared.stdout).excludedIncomplete.n, 2);
		assert.deepEqual(
			JSON.parse(compared.stdout).excludedIncomplete.directories,
			[incomplete, empty],
		);
		const onlyIncomplete = f.run("compare", incomplete);
		assert.equal(onlyIncomplete.status, 0, onlyIncomplete.stderr);
		assert.equal(JSON.parse(onlyIncomplete.stdout).excludedIncomplete.n, 1);
	});
	it("spend labels a partially unreadable stage set lower_bound and names the missing stage", (t) => {
		const f = fixture(t);
		const dir = join(f.root, "partial");
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
		mkdirSync(join(dir, "runtime/build"), { recursive: true });
		mkdirSync(join(dir, "runtime/second-judge/egress.requests.jsonl"), {
			recursive: true,
		});
		writeFileSync(
			join(dir, "runtime/build/egress.requests.jsonl"),
			JSON.stringify({
				kind: "result",
				req: 1,
				route: "model-openai",
				inputTokens: 20,
				outputTokens: 0,
				status: 200,
			}),
		);
		const result = f.run("spend", dir);
		assert.equal(result.status, 0, result.stderr);
		const trial = JSON.parse(result.stdout).trials[0];
		assert.equal(trial.chargedTokens, 20);
		assert.equal(trial.coverage, "lower_bound");
		assert.deepEqual(trial.unavailableStages, ["second-judge"]);
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
