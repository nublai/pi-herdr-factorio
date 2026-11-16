import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { digestOf, runIdOf } from "../../../src/core/run.ts";
import { ledgerRowOf, unavailable } from "../../../src/ledger/schema.ts";
import { isRepoSlug } from "../../../src/trust/platform.ts";

const temps: string[] = [];

after(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function temp() {
	const dir = mkdtempSync(join(tmpdir(), "factory-cost-"));
	temps.push(dir);

	return dir;
}

function put(path: string, text: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

function row(issue: number, total: number) {
	const gap = unavailable("receipt_missing");
	const repo = "nublai/pi-herdr-factorio";
	assert.ok(isRepoSlug(repo));

	return ledgerRowOf({
		v: 1,
		runId: runIdOf({ repo, issue, eventId: String(issue) }),
		repo,
		issue,
		eventId: String(issue),
		eventAt: "2026-11-16T10:00:00Z",
		previousRunId: { kind: "known", value: null },
		snapshotDigest: digestOf("snapshot"),
		originalBase: "a".repeat(40),
		startedAt: gap,
		terminalObservedAt: "2026-11-16T11:00:00Z",
		provenance: {
			kind: "legacy_import",
			workflowSha: "a".repeat(40),
			workflowDigest: digestOf("workflow"),
			gates: gap,
			autonomy: gap,
		},
		terminalMarker: { seq: 1, digest: digestOf("marker") },
		outcome: { kind: "needs_info", stage: "specify" },
		pr: null,
		artifacts: { kind: "admission" },
		repairRounds: gap,
		stages: {
			kind: "known",
			value: [
				{
					stage: "specify",
					wallMs: { kind: "exact", unit: "milliseconds", total: 100 },
					attempts: gap,
					tokens: { kind: "exact", unit: "tokens", total },
				},
			],
		},
		models: gap,
		usage: {
			tokens: { kind: "exact", unit: "tokens", total },
			parentTokens: gap,
			childTokens: gap,
			unattributedTokens: gap,
			money: unavailable("provider_not_reported"),
		},
		interruptedAttempts: gap,
		contextPressure: gap,
		redactedReceiptDigests: [],
		evidence: {
			issueUrl: `https://github.com/nublai/pi-herdr-factorio/issues/${issue}`,
			ciUrls: [],
		},
	});
}

function fixture() {
	const state = temp();
	const first = row(1, 1_200);
	const second = row(2, 1_200);

	for (const saved of [first, second]) {
		put(
			join(state, "ledger", saved.row.runId, "row.json"),
			saved.bytes.toString(),
		);
		put(
			join(state, "stages", saved.row.runId, "specify-1", "receipt.json"),
			JSON.stringify({
				version: 1,
				runId: saved.row.runId,
				stage: "specify",
				models: {
					requested: "openai/gpt-6.1-sol",
					observed: "openai/gpt-6.1-sol",
				},
				fallback: null,
			}),
		);
	}

	const journal = join(
		state,
		"stages",
		first.row.runId,
		"specify-1",
		"egress.requests.jsonl",
	);

	const result = {
		kind: "result",
		req: 1,
		route: "model-openai",
		inputTokens: 1_000,
		outputTokens: 200,
	};

	put(
		journal,
		[result, result].map((line) => JSON.stringify(line)).join("\n") + "\n",
	);

	return { state, first, second, journal };
}

function cli(state: string, extra: string[] = []) {
	return spawnSync(
		process.execPath,
		[
			resolve("host/cli/index.ts"),
			"cost",
			"--json",
			"--state-dir",
			state,
			...extra,
		],
		{
			encoding: "utf8",
			timeout: 30_000,
			env: { ...process.env, FACTORY_PLATFORM: "exe-dev" },
		},
	);
}

describe("cost CLI", () => {
	it("reads two terminal runs, prices journals once and reports a missing journal as unavailable", () => {
		const { state, first, second, journal } = fixture();
		const before = digestOf(readFileSync(journal));
		const result = cli(state);
		assert.equal(result.status, 0, result.stderr);
		const report = JSON.parse(result.stdout);
		assert.equal(report.runs.length, 2);
		assert.equal(report.estimate.kind, "api_equivalent_estimate");
		assert.equal(report.estimate.usdMicros, 4_000);
		assert.equal(report.billedSpend, "unavailable");
		assert.match(report.tariffDigest, /^[a-f0-9]{64}$/);

		const priced = report.runs.find(
			(run: { runId: string }) => run.runId === first.row.runId,
		);

		const missing = report.runs.find(
			(run: { runId: string }) => run.runId === second.row.runId,
		);

		assert.equal(priced.tokens.total, 1_200);
		assert.equal(priced.coverage.kind, "exact");
		assert.equal(
			priced.stages[0].estimate.usdMicros,
			priced.estimate.usdMicros,
		);
		assert.equal(missing.estimate.usdMicros, null);
		assert.equal(missing.coverage.kind, "unavailable");
		assert.equal(missing.coverage.missingJournals, 1);
		assert.equal(digestOf(readFileSync(journal)), before);
	});

	it("skips pending and blocked ledger directories with no frozen row, including with --run", () => {
		const { state, first } = fixture();
		put(join(state, "ledger", "a".repeat(64), "terminal.json"), "{}\n");
		put(join(state, "ledger", "b".repeat(64), "blocked.json"), "{}\n");

		for (const extra of [[], ["--run", first.row.runId]]) {
			const result = cli(state, extra);
			assert.equal(result.status, 0, result.stdout + result.stderr);
			const report = JSON.parse(result.stdout);
			assert.equal(report.runs.length, extra.length === 0 ? 2 : 1);
			assert.equal(report.estimate.usdMicros, 4_000);
		}
	});

	it("counts only named execution leaves when an aggregate also has a journal", () => {
		const { state, first, journal } = fixture();
		const dir = dirname(journal);
		const receipt = readFileSync(join(dir, "receipt.json"), "utf8");
		const bytes = readFileSync(journal, "utf8");

		for (const child of ["draft", "unrelated"]) {
			put(join(dir, child, "receipt.json"), receipt);
			put(join(dir, child, "egress.requests.jsonl"), bytes);
		}

		const result = cli(state, ["--run", first.row.runId]);
		assert.equal(result.status, 0, result.stderr);
		const run = JSON.parse(result.stdout).runs[0];
		assert.equal(run.coverage.requests, 1);
		assert.equal(run.coverage.priced, 1);
		assert.equal(run.coverage.kind, "exact");
		assert.equal(run.tokens.total, 1_200);
		assert.equal(run.estimate.usdMicros, 4_000);
		assert.equal(run.stages[0].estimate.usdMicros, 4_000);
	});

	it("validates the pinned tariff only for cost, not other CLI commands", () => {
		const preload = `data:text/javascript,${encodeURIComponent(`
			import { registerHooks } from "node:module";
			registerHooks({
				load(url, context, nextLoad) {
					if (url.endsWith("/src/core/tariff.json"))
						return { format: "json", source: "{}", shortCircuit: true };
					return nextLoad(url, context);
				}
			});
		`)}`;

		for (const command of [
			["platform", "--env"],
			["cost", "--json", "--state-dir", temp()],
		]) {
			const result = spawnSync(
				process.execPath,
				["--import", preload, resolve("host/cli/index.ts"), ...command],
				{
					encoding: "utf8",
					timeout: 30_000,
					env: { ...process.env, FACTORY_PLATFORM: "exe-dev" },
				},
			);

			if (command[0] === "cost") {
				assert.equal(result.status, 1);
				assert.match(result.stderr, /tariff_digest_mismatch/);
			} else {
				assert.equal(result.status, 0, result.stderr);
				assert.match(result.stdout, /FACTORY_PLATFORM=/);
			}
		}
	});

	it("reports state_unavailable for both a missing path and a file", () => {
		const state = temp();
		put(join(state, "file"), "not a directory\n");

		for (const name of ["missing", "file"]) {
			const result = cli(join(state, name));
			assert.equal(result.status, 1);
			assert.equal(JSON.parse(result.stdout).error, "state_unavailable");
		}
	});

	it("filters by a unique run prefix and refuses an absent run", () => {
		const { state, first } = fixture();
		const result = cli(state, ["--run", first.row.runId.slice(0, 8)]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(JSON.parse(result.stdout).runs.length, 1);
		assert.equal(cli(state, ["--run", "ffff"]).status, 1);
	});

	it("prints zero runs for an empty read-only state and rejects invalid options", () => {
		const state = temp();
		chmodSync(state, 0o500);
		const result = cli(state);
		chmodSync(state, 0o700);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(JSON.parse(result.stdout).runs.length, 0);
		assert.equal(JSON.parse(result.stdout).estimate.usdMicros, 0);
		assert.equal(cli(state, ["--run", "../escape"]).status, 2);
		assert.equal(cli(state, ["--unexpected"]).status, 2);
	});

	it("reports an unknown journal model by name instead of falling back to the receipt model", () => {
		const { state, first, journal } = fixture();
		put(
			journal,
			JSON.stringify({
				kind: "result",
				req: 1,
				route: "model-openai",
				observedModel: "unknown-model",
				inputTokens: 1_000,
				outputTokens: 200,
			}) + "\n",
		);
		const result = cli(state, ["--run", first.row.runId]);
		assert.equal(result.status, 0, result.stderr);
		const run = JSON.parse(result.stdout).runs[0];
		assert.equal(run.coverage.unpriced, 1);
		assert.equal(run.estimate.usdMicros, null);
		assert.deepEqual(run.unpricedModels, ["openai/unknown-model"]);
	});

	it("prices aggregate leaves and Anthropic requests without counting agent directories as executions", () => {
		const { state, first, journal } = fixture();
		const dir = dirname(journal);
		const receipt = readFileSync(join(dir, "receipt.json"), "utf8");
		const bytes = readFileSync(journal, "utf8");
		rmSync(journal);
		put(join(dir, "draft", "receipt.json"), receipt);
		put(join(dir, "draft", "egress.requests.jsonl"), bytes);
		mkdirSync(join(dir, "draft", "agent-0", "sessions"), { recursive: true });
		put(join(dir, "review", "receipt.json"), receipt);
		put(
			join(dir, "review", "egress.requests.jsonl"),
			JSON.stringify({
				kind: "result",
				req: 1,
				route: "model-anthropic",
				observedModel: "claude-opus-5-5",
				inputTokens: 100,
				outputTokens: 20,
			}) + "\n",
		);
		const result = cli(state, ["--run", first.row.runId]);
		assert.equal(result.status, 0, result.stderr);
		const run = JSON.parse(result.stdout).runs[0];
		assert.equal(run.estimate.usdMicros, 4_800);
		assert.equal(run.tokens.total, 1_320);
		assert.equal(run.coverage.missingJournals, 0);
		assert.equal(run.coverage.missingReceipts, 0);
		assert.equal(run.tokenDifference, -120);
		assert.equal(
			run.byModel.find(
				(model: { model: string }) =>
					model.model === "anthropic/claude-opus-5-5",
			).estimate.usdMicros,
			800,
		);
	});

	it("retains known estimates beside an uncertain request and a missing execution receipt", () => {
		const { state, first, journal } = fixture();
		put(
			journal,
			readFileSync(journal, "utf8") +
				JSON.stringify({
					kind: "dispatch",
					req: 2,
					route: "model-openai",
					inputTokenEstimate: 100,
					maxOutputTokens: 1_000,
				}) +
				"\n",
		);
		put(join(dirname(dirname(journal)), "specify-2", "execution.json"), "{}\n");
		const result = cli(state, ["--run", first.row.runId]);
		assert.equal(result.status, 0, result.stderr);
		const run = JSON.parse(result.stdout).runs[0];
		assert.equal(run.estimate.usdMicros, 4_000);
		assert.equal(run.coverage.uncertain, 1);
		assert.equal(run.coverage.missingReceipts, 1);
		assert.equal(run.coverage.missingJournals, 1);
		assert.equal(run.coverage.kind, "uncertain");
	});

	it("marks a truncated journal as incomplete and refuses a corrupt terminal row", () => {
		const { state, first, journal } = fixture();
		put(journal, readFileSync(journal, "utf8") + '{"kind":');
		const result = cli(state, ["--run", first.row.runId]);
		assert.equal(result.status, 0, result.stderr);
		const run = JSON.parse(result.stdout).runs[0];
		assert.equal(run.coverage.missing, 1);
		assert.equal(run.coverage.kind, "lower_bound");
		put(join(state, "ledger", first.row.runId, "row.json"), "{}\n");
		assert.equal(cli(state).status, 1);
	});
});
