import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdtemp,
	mkdir,
	readFile,
	writeFile,
	rm,
	symlink,
} from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { test } from "node:test";
import { parseLedger, ledgerRowOf } from "../../../src/ledger/schema.ts";
import { digestOf } from "../../../src/core/run.ts";
import { EXE_DEV_PLATFORM } from "../../../src/trust/platform.ts";
import { startViewer } from "../../../host/viewer/server.ts";

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "scoreboard-"));

	const rows = parseLedger(
		await readFile(
			new URL("../../fixtures/metrics/runs-2026-11-08.jsonl", import.meta.url),
		),
	);

	const original = rows.find((entry) => entry.kind === "known");
	assert.ok(original?.kind === "known");

	const saved = ledgerRowOf({
		...original.row,
		startedAt: { kind: "known", value: "2026-11-15T00:00:00Z" },
		stages: { kind: "known", value: [] },
		models: { kind: "unavailable", reason: "receipt_missing" },
	});

	const row = saved.row;
	const title = '<img src=x onerror="alert(1)"> & synthetic';

	const put = async (path: string, bytes: string | Buffer) => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, bytes);
	};

	const rowPath = join(root, "ledger", row.runId, "row.json");
	await put(rowPath, saved.bytes);
	await put(
		join(
			root,
			"admissions",
			"github",
			row.repo,
			String(row.issue),
			`${row.eventId}.json`,
		),
		JSON.stringify({ snapshot: { title } }),
	);
	const stage = join(root, "stages", row.runId, "build-1");
	await put(
		join(stage, "receipt.json"),
		JSON.stringify({
			version: 1,
			runId: row.runId,
			stage: "build",
			models: { requested: "openai/gpt-6.1-sol" },
		}),
	);
	await put(
		join(stage, "egress.requests.jsonl"),
		`${JSON.stringify({ kind: "result", req: 1, route: "model-openai", inputTokens: 1000, outputTokens: 200 })}\n`,
	);

	return { root, rowPath, row, title, stage };
}

function get(
	port: number,
	path: string,
	headers: Record<string, string> = {},
	method = "GET",
): Promise<{
	code: number;
	body: string;
	headers: import("node:http").IncomingHttpHeaders;
}> {
	return new Promise((done, reject) => {
		const req = request(
			{ host: "127.0.0.1", port, path, headers, method },
			(res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					body += chunk;
				});
				res.on("end", () =>
					done({ code: res.statusCode ?? 0, body, headers: res.headers }),
				);
			},
		);

		req.on("error", reject);
		req.end();
	});
}

function cli(root: string, args: string[] = [], verb = "scoreboard") {
	return spawnSync(
		process.execPath,
		[
			resolve("host/cli/index.ts"),
			verb,
			"--json",
			"--state-dir",
			root,
			...args,
		],
		{
			encoding: "utf8",
			timeout: 30000,
			env: { ...process.env, FACTORY_PLATFORM: "exe-dev" },
		},
	);
}

test("scoreboard viewer shares HTTP guards, escapes issue titles and matches the real CLI", async () => {
	const f = await fixture();

	const server = await startViewer({
		stateDir: f.root,
		port: 0,
		basePath: "/factory",
		platform: EXE_DEV_PLATFORM,
	});

	try {
		const before = digestOf(await readFile(f.rowPath));
		const output = cli(f.root);
		assert.equal(output.status, 0, output.stderr);
		const report = JSON.parse(output.stdout);
		const page = await get(server.port, "/factory/scoreboard");
		assert.equal(page.code, 200);
		assert.ok(
			page.body.includes(
				"&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; synthetic",
			),
		);
		assert.ok(!page.body.includes("<img src=x"));
		assert.ok(page.body.includes("api_equivalent_estimate"));
		assert.ok(page.body.includes('href="/factory/scoreboard.json"'));
		assert.equal(page.headers["cache-control"], "no-store");
		assert.ok(
			page.headers["content-security-policy"]?.includes("default-src 'none'"),
		);
		assert.equal(page.headers["access-control-allow-origin"], undefined);
		const json = await get(server.port, "/scoreboard.json");
		const expected = digestOf(JSON.stringify(report.summary));
		assert.equal(
			digestOf(JSON.stringify(JSON.parse(json.body).summary)),
			expected,
		);

		for (const path of [
			"/scoreboard",
			"/scoreboard.json",
			"/factory/scoreboard",
		]) {
			assert.equal(
				(await get(server.port, path, { Origin: "https://foreign.example" }))
					.code,
				403,
			);
			assert.equal(
				(await get(server.port, path, { Host: "foreign.example" })).code,
				403,
			);
			assert.equal((await get(server.port, path, {}, "POST")).code, 405);
		}

		assert.equal(digestOf(await readFile(f.rowPath)), before);
	} finally {
		await server.close();
		await rm(f.root, { recursive: true, force: true });
	}
});

test("scoreboard real CLI filters starts, selects groups, matches cost and rejects invalid dates", async () => {
	const f = await fixture();

	try {
		const cost = cli(f.root, [], "cost");
		assert.equal(cost.status, 0, cost.stderr);
		assert.equal(JSON.parse(cost.stdout).estimate.usdMicros, 4000);

		for (const by of ["revision", "stage", "model", "failure"]) {
			const output = cli(f.root, ["--since", "2026-11-15", "--by", by]);
			assert.equal(output.status, 0, output.stderr);
			const result = JSON.parse(output.stdout);
			assert.equal(result.summary.runs, 1);
			assert.equal(result.by, by);
			assert.equal(
				result.summary.estimate.usdMicros,
				JSON.parse(cost.stdout).estimate.usdMicros,
			);
			assert.equal(result.selectedGroups.length, result.groups[by].length);
		}

		assert.equal(
			JSON.parse(cli(f.root, ["--since", "2026-11-16"]).stdout).summary.runs,
			0,
		);

		for (const args of [
			["--since", "2026-02-30"],
			["--by", "ticket"],
			["--since", "invalid"],
		])
			assert.equal(cli(f.root, args).status, 2);

		const unknownStart = ledgerRowOf({
			...f.row,
			startedAt: { kind: "unavailable", reason: "receipt_missing" },
		});

		await writeFile(f.rowPath, unknownStart.bytes);
		const filtered = JSON.parse(cli(f.root, ["--since", "2026-11-15"]).stdout);
		assert.equal(filtered.summary.runs, 0);
		assert.equal(filtered.filter.excludedUnknownStart, 1);
		await rm(join(f.stage, "egress.requests.jsonl"));
		await symlink(f.rowPath, join(f.stage, "egress.requests.jsonl"));
		const missing = JSON.parse(cli(f.root).stdout);
		assert.equal(missing.summary.estimate.usdMicros, null);
		assert.equal(missing.summary.coverage.kind, "unavailable");
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});
