import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it, type TestContext } from "node:test";
import { runBenchCli } from "../../../host/cli/bench.ts";
import {
	sandboxHost,
	type SandboxHostConfig,
} from "../../../host/sandbox/launch.ts";
import { LineSplitter } from "../../../host/sandbox/lines.ts";
import { runVisibleTests } from "../../../host/sandbox/visible-tests.ts";
import {
	startGatewayProcess,
	type GatewayHandle,
} from "../../../host/gateway/client.ts";
import { manifestDigest } from "../../../host/bundle/manifest.ts";
import { digestOf } from "../../../src/core/run.ts";
import type { BenchRuntime } from "../../../host/bench/run.ts";
import {
	objectOf,
	parseJson,
	type JsonObject,
} from "../../../src/core/json.ts";
import { EXE_DEV_PLATFORM } from "../../../src/trust/platform.ts";
import { startEchoFixture } from "../gateway/http-fixtures.ts";
import { benchFixture, put } from "./fixtures.ts";

async function harness(t: TestContext, editExisting = false, builtValue = 1) {
	const root = mkdtempSync(join(tmpdir(), "bench-m5-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const f = await benchFixture(root);
	const echo = await startEchoFixture(t, 0, { anthropic: "usage" });
	t.after(() => echo.close());
	const calls: string[] = [];
	const prompts: string[] = [];
	let service = "not-found";
	const auditFiles: string[] = [];

	const runtime: BenchRuntime = {
		exec: async (command, args) => {
			assert.equal(command, "systemctl");
			assert.ok(args.includes("factory.service"));

			return { code: 0, stdout: service, stderr: "" };
		},
		assetsDir: f.assets,
		sourceRoot: f.repository,
		preflight: async () => {},
		visible: async (config, ...args) =>
			runVisibleTests(
				{
					...config,
					launch: (launch) => {
						mkdirSync(launch.agentDir, { recursive: true, mode: 0o700 });

						const command = launch.command.map((arg) =>
							arg
								.replaceAll("/workspace", launch.workspace)
								.replaceAll("/run/pi-agent", launch.agentDir),
						);

						const child = spawn(command[0] ?? "false", command.slice(1), {
							cwd: launch.workspace,
							env: { PATH: process.env.PATH, HOME: join(root, "home") },
							stdio: ["pipe", "pipe", "pipe"],
						});

						return { child, unit: "synthetic-visible" };
					},
					exec: async () => ({ code: 0, stdout: "", stderr: "" }),
				},
				...args,
			),
		gateRunner: {
			kind: "synthetic-process",
			async run(input) {
				const argv = input.argv.map((arg) =>
					arg
						.replaceAll("/g/", `${input.gates}/`)
						.replaceAll("/w/", `${input.tree}/`),
				);

				try {
					return {
						exitCode: 0,
						stdout: execFileSync(argv[0] ?? "node", argv.slice(1), {
							cwd: input.tree,
							encoding: "utf8",
							timeout: 10000,
							env: { PATH: process.env.PATH, HOME: join(root, "home") },
							stdio: ["ignore", "pipe", "pipe"],
						}),
						stderr: "",
					};
				} catch (error) {
					return {
						exitCode: 1,
						stdout: "",
						stderr:
							error instanceof Error ? error.message : "test process failed",
					};
				}
			},
		},
		createHost(config: SandboxHostConfig) {
			let gateway: GatewayHandle | null = null;
			let output = "";
			let turns = 0;

			const base = sandboxHost({
				...config,
				gateway: async (spec) => {
					assert.ok(
						spec.table.routes.every(
							(route) => route.id === "npm" || route.id.startsWith("model-"),
						),
					);
					assert.equal(spec.table.ceiling.reserve, true);
					auditFiles.push(spec.auditPath);

					const started = await startGatewayProcess({
						...spec,
						testMode: true,
						table: {
							...spec.table,
							routes: spec.table.routes.map((route) =>
								route.meter === null
									? route
									: {
											...route,
											upstream: {
												scheme: "http",
												host: "llm.test",
												port: echo.port,
												basePath: route.prefix,
												hostHeader: echo.host,
												sni: "llm.test",
												address: { kind: "pinned", ip: "127.0.0.1" },
											},
										},
							),
						},
					});

					if (started.ok) gateway = started.handle;

					return started;
				},
			});

			return {
				...base,
				stopSandbox: async () => {},
				async launchPi(model) {
					calls.push(model);
					assert.ok(!existsSync(join(config.workspace, "test/acceptance")));
					assert.ok(!existsSync(join(config.workspace, "oracle")));
					assert.ok(!existsSync(join(config.workspace, ".git")));
					const stdin = new PassThrough();
					const stdout = new PassThrough();
					let finish = (_code: number | null) => {};

					const exited = new Promise<number | null>((done) => {
						finish = done;
					});

					const emit = (record: JsonObject) =>
						stdout.write(`${JSON.stringify(record)}\n`);

					const splitter = new LineSplitter(1024 * 1024);
					stdin.on("end", () => {
						stdout.end();
						finish(0);
					});
					stdin.on("data", (chunk: Buffer) => {
						for (const line of splitter.push(chunk) ?? []) {
							const command = objectOf(parseJson(line));
							assert.ok(command !== null);

							if (command.type === "abort")
								emit({ type: "agent_settled", aborted: true });

							if (command.type === "get_last_assistant_text")
								emit({
									type: "response",
									id: command.id ?? null,
									command: command.type,
									success: true,
									data: { text: output },
								});

							if (command.type !== "prompt") continue;
							prompts.push(String(command.message));
							turns++;
							emit({
								type: "response",
								id: command.id ?? null,
								command: "prompt",
								success: true,
								data: { disposition: "started" },
							});
							emit({ type: "turn_start" });

							if (config.stage === "build") {
								put(
									config.workspace,
									"src/value.ts",
									`export const value = ${builtValue};\n`,
								);
								put(
									config.workspace,
									"test/src/added.test.ts",
									"import {test} from 'node:test'; test('new', () => {});\n",
								);

								if (editExisting)
									put(
										config.workspace,
										"test/src/value.test.ts",
										turns === 1
											? "import {test} from 'node:test'; test('edited', () => {});\n"
											: "import {test} from 'node:test'; test('base', () => {});\n",
									);
								output = "Built a synthetic patch.";
							} else {
								const seat = basename(config.stageDir ?? "");
								output = JSON.stringify({
									seat,
									findings: [],
									judgments:
										seat === "code-review" || seat === "second-judge"
											? [
													{
														scenario: "S2",
														outcome: "pass",
														reason: "Synthetic judge pass.",
													},
												]
											: [],
								});
							}

							void new Promise<number>((done) => {
								const anthropic = model.startsWith("anthropic/");

								const req = request(
									{
										socketPath: gateway?.socketPath ?? "",
										path: anthropic
											? "/anthropic/v1/messages"
											: "/openai/v1/responses",
										method: "POST",
										headers: {
											Host: "127.0.0.1:18080",
											"Content-Type": "application/json",
											"anthropic-version": "2023-06-01",
										},
										setHost: false,
									},
									(res) => {
										res.resume();
										res.on("end", () => done(res.statusCode ?? 0));
									},
								);

								req.on("error", () => done(0));
								req.end(
									JSON.stringify({
										model: model.slice(model.indexOf("/") + 1),
										stream: true,
										max_tokens: 100,
										max_output_tokens: anthropic ? undefined : 100,
										input: anthropic ? undefined : "Synthetic request",
										messages: anthropic
											? [{ role: "user", content: "Synthetic request" }]
											: undefined,
									}),
								);
							}).then((status) => {
								emit({
									type: "message_end",
									message: {
										role: "assistant",
										provider: model.split("/")[0] ?? "",
										model: model.split("/")[1] ?? "",
										stopReason: status === 200 ? "stop" : "error",
										errorMessage:
											status === 200
												? ""
												: "factory-gateway: denied: budget-closed",
										usage: { input: 0, output: 0, totalTokens: 0 },
									},
								});
								emit({ type: "agent_settled", aborted: false });
							});
						}
					});

					return {
						stdin,
						stdout,
						exited,
						kill: () => {
							stdout.end();
							finish(null);
						},
					};
				},
			};
		},
	};

	const run = async (state = join(root, "trial"), cap = 300000) => {
		let stdout = "",
			stderr = "";

		const code = await runBenchCli(
			[
				"run",
				"--bundle",
				f.bundle,
				"--variant",
				f.variantFile,
				"--state-dir",
				state,
				"--token-cap",
				String(cap),
			],
			{
				exec: runtime.exec,
				env: (name) => (name === "HOME" ? root : undefined),
				readPlatformFile: async () => ({ kind: "absent" }),
				stdout: (text) => {
					stdout += text;
				},
				stderr: (text) => {
					stderr += text;
				},
			},
			EXE_DEV_PLATFORM,
			runtime,
		);

		return { code, stdout, stderr, value: () => JSON.parse(stdout) };
	};

	return {
		...f,
		root,
		calls,
		prompts,
		auditFiles,
		run,
		service: (value: string) => {
			service = value;
		},
	};
}

describe("bench run offline CLI", () => {
	it("reuses the real runner, visible tests, trusted gates, held-out checks and both judges with a fake gateway", {
		timeout: 60000,
	}, async (t) => {
		const f = await harness(t);
		const result = await f.run();
		assert.equal(result.code, 0, result.stderr);
		const trial = result.value();
		assert.equal(trial.outcome.kind, "passed", JSON.stringify(trial.outcome));
		assert.deepEqual(
			trial.stages.map((stage: { name: string }) => stage.name),
			[
				"build",
				"visible_tests",
				"validation",
				"code-review",
				"security-review",
				"simplify",
				"second-judge",
			],
		);
		assert.equal(trial.judges.length, 4);
		assert.ok(trial.accounting.chargedTokens > 0);
		assert.equal(
			trial.accounting.chargedTokens,
			trial.accounting.cost.tokens.total,
		);
		assert.equal(trial.accounting.cost.coverage.kind, "exact");
		assert.equal(
			trial.accounting.cost.estimate.kind,
			"api_equivalent_estimate",
		);
		assert.equal(trial.accounting.cost.billedSpend, "unavailable");
		t.diagnostic(
			JSON.stringify({
				syntheticTask: 1,
				outcome: trial.outcome,
				tokens: trial.accounting.chargedTokens,
				cost: trial.accounting.cost.estimate,
				billedSpend: trial.accounting.cost.billedSpend,
				wallMs: trial.wallMs,
			}),
		);
		assert.ok(
			f.auditFiles.every(
				(file) => !readFileSync(file, "utf8").includes("github"),
			),
		);
		const before = f.calls.length;
		const resumed = await f.run();
		assert.equal(resumed.code, 0, resumed.stderr);
		assert.ok(resumed.stdout === result.stdout);
		assert.equal(f.calls.length, before);
	});
	it("applies a single model or digest-pinned skill variant without changing installed assets", {
		timeout: 60000,
	}, async (t) => {
		const f = await harness(t);
		writeFileSync(
			f.variantFile,
			JSON.stringify({
				...f.variant,
				change: {
					kind: "model",
					stage: "review",
					model: "openai/gpt-6.1-terra",
				},
			}),
		);
		const model = await f.run(join(f.root, "model"));
		assert.equal(model.code, 0, model.stderr);
		assert.equal(
			model.value().outcome.kind,
			"passed",
			JSON.stringify(model.value().outcome),
		);
		assert.ok(f.calls.includes("openai/gpt-6.1-terra"));
		const replacement = "A synthetic replacement skill.\n";
		put(f.root, "build.md", replacement);
		writeFileSync(
			f.variantFile,
			JSON.stringify({
				...f.variant,
				change: {
					kind: "skill",
					path: "skills/build/SKILL.md",
					file: "build.md",
					digest: digestOf(replacement),
				},
			}),
		);
		const skill = await f.run(join(f.root, "skill"));
		assert.equal(skill.code, 0, skill.stderr);
		assert.equal(
			skill.value().outcome.kind,
			"passed",
			JSON.stringify(skill.value().outcome),
		);
		assert.ok(f.prompts.some((prompt) => prompt.includes(replacement.trim())));
		assert.notEqual(
			skill.value().runtime.assetsDigest,
			f.variant.pins.assetsDigest,
		);
		assert.equal(await manifestDigest(f.assets), f.variant.pins.assetsDigest);
	});
	it("records a real held-out failure and never launches review over failed gates", {
		timeout: 30000,
	}, async (t) => {
		const f = await harness(t, false, 0);
		const result = await f.run();
		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.value().outcome.kind, "failed");
		assert.equal(result.value().outcome.stage, "validation");
		assert.equal(f.calls.length, 1);
	});
	it("enforces a below-one-build token cap before forwarding model work", {
		timeout: 30000,
	}, async (t) => {
		const f = await harness(t);
		const result = await f.run(join(f.root, "capped"), 1);
		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.value().outcome.kind, "budget_exhausted");
		assert.equal(result.value().accounting.chargedTokens, 0);
	});
	it("refuses factory.service, copied production state, bad pins and two dimensions before any model call", async (t) => {
		const f = await harness(t);
		f.service("loaded");
		assert.match((await f.run()).stderr, /factory_service_present/);
		f.service("not-found");
		assert.match(
			(await f.run(f.state)).stderr,
			/production_or_non_bench_state/,
		);
		writeFileSync(
			f.variantFile,
			JSON.stringify({
				...f.variant,
				change: {
					kind: "buildRevision",
					value: "on",
					model: "openai/gpt-6.1-sol",
				},
			}),
		);
		assert.notEqual((await f.run()).code, 0);
		writeFileSync(
			f.variantFile,
			JSON.stringify({
				...f.variant,
				pins: { ...f.variant.pins, factoryRevision: "b".repeat(40) },
			}),
		);
		assert.match((await f.run()).stderr, /variant_pin_mismatch/);
		assert.equal(f.calls.length, 0);
	});
	it("refuses an interrupted trial rather than resetting its accounting", {
		timeout: 60000,
	}, async (t) => {
		const f = await harness(t);
		const result = await f.run();
		assert.equal(result.code, 0, result.stderr);
		const before = f.calls.length;
		rmSync(join(f.root, "trial/trial.json"));
		assert.match((await f.run()).stderr, /trial_incomplete_refusing_resume/);
		assert.equal(f.calls.length, before);
	});
	it("buildRevision off omits the real unrun-test-edit draft check, on performs one revision", {
		timeout: 60000,
	}, async (t) => {
		const f = await harness(t, true);
		const on = await f.run(join(f.root, "on"));
		assert.equal(on.code, 0, on.stderr);
		assert.equal(
			on.value().outcome.kind,
			"passed",
			JSON.stringify(on.value().outcome),
		);
		assert.equal(
			f.prompts.filter((prompt) => prompt.includes("Unrun test edits:")).length,
			1,
		);
		const before = f.prompts.length;
		writeFileSync(
			f.variantFile,
			JSON.stringify({
				...f.variant,
				name: "off",
				change: { kind: "buildRevision", value: "off" },
			}),
		);
		const off = await f.run(join(f.root, "off"));
		assert.equal(off.code, 0, off.stderr);
		assert.equal(
			off.value().outcome.kind,
			"passed",
			JSON.stringify(off.value().outcome),
		);
		assert.equal(
			f.prompts
				.slice(before)
				.filter((prompt) => prompt.includes("Unrun test edits:")).length,
			0,
		);
	});
});
