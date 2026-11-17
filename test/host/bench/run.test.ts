import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import {
	after,
	before,
	describe,
	it,
	mock,
	type SuiteContext,
	type TestContext,
} from "node:test";
import { runBenchCli } from "../../../host/cli/bench.ts";
import { dockerRunner, localRunner } from "../../../host/gates/runner.ts";
import {
	MATERIALIZER_FILES,
	materializerIdentity,
} from "../../../host/gates/materialize.ts";
import { compareTrials } from "../../../src/bench/compare.ts";
import { parseBenchTrial } from "../../../src/bench/trial.ts";
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
import { SECOND_JUDGE } from "../../../src/candidate/review.ts";
import { inlined, specifySourceFacts } from "../../../src/contract/prompt.ts";
import { scopeOwner } from "../../../host/isolation/scope.ts";
import { stageBenchPaths, type BenchRuntime } from "../../../host/bench/run.ts";
import {
	objectOf,
	parseJson,
	type JsonObject,
} from "../../../src/core/json.ts";
import { EXE_DEV_PLATFORM } from "../../../src/trust/platform.ts";
import { startEchoFixture } from "../gateway/http-fixtures.ts";
import { benchFixture, put } from "./fixtures.ts";

// pi-ai 1.4.0 gpt-6.1-sol first-request shape; plain text misses reservation refusals.
const PI_140_FIRST_REQUEST = {
	model: "gpt-6.1-sol",
	stream: true,
	max_output_tokens: 100,
	store: false,
	prompt_cache_key: "synthetic-session",
	reasoning: { effort: "medium", summary: "auto" },
	include: ["reasoning.encrypted_content"],
	input: [
		{
			type: "additional_tools",
			role: "developer",
			tools: [
				{
					type: "function",
					name: "read",
					description: "Read a file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
					},
					strict: false,
				},
			],
		},
		{ role: "developer", content: "Synthetic system prompt" },
		{
			role: "user",
			content: [{ type: "input_text", text: "Synthetic request" }],
		},
		{ type: "configuration_update", reasoning: { effort: "medium" } },
	],
};

async function harness(
	t: TestContext | SuiteContext,
	editExisting = false,
	builtValue = 1,
	options: Parameters<typeof benchFixture>[1] & {
		pi140Request?: boolean;
		respec?:
			| "on"
			| "github-path"
			| "oversized-summary"
			| "unknown"
			| "ambiguous"
			| "revision"
			| "revision-unknown"
			| "questions"
			| "judge"
			| "judge-execution"
			| "preserved"
			| "replacement"
			| "missing-base"
			| "failed-base";
	} = {},
	suiteCleanup: (run: () => void) => void = after,
) {
	const cleanup = "after" in t ? t.after.bind(t) : suiteCleanup;
	const root = mkdtempSync(join(tmpdir(), "bench-m5-"));
	cleanup(() => rmSync(root, { recursive: true, force: true }));
	const f = await benchFixture(root, options);

	const echo = await startEchoFixture(t, 0, { anthropic: "usage" });
	cleanup(() => echo.close());

	const baseRequests: Parameters<typeof localRunner.run>[0][] = [];
	const workspaces: { stage: string; path: string; published: boolean }[] = [];

	if (options.respec) {
		writeFileSync(
			f.variantFile,
			JSON.stringify({
				...f.variant,
				name: "respec",
				change: { kind: "respec", value: "on" },
			}),
		);
		("mock" in t ? t.mock : mock).method(
			localRunner,
			"run",
			async (input: Parameters<typeof localRunner.run>[0]) => {
				baseRequests.push(input);

				if (
					input.tree.includes("accept-base") &&
					options.respec === "missing-base"
				)
					return { exitCode: 0, stdout: "", stderr: "" };

				if (
					input.tree.includes("accept-base") &&
					options.respec === "failed-base"
				)
					return { exitCode: 2, stdout: "", stderr: "runner failed" };

				const argv = input.argv.map((arg) =>
					arg
						.replaceAll("/g/", `${input.gates}/`)
						.replaceAll("/w/", `${input.tree}/`)
						.replaceAll("/d/", `${input.detailReporter}/`),
				);

				const result = spawnSync(argv[0] ?? "false", argv.slice(1), {
					cwd: input.tree,
					encoding: "utf8",
					timeout: 10000,
					env: { PATH: process.env.PATH, HOME: join(root, "home") },
				});

				return {
					exitCode: result.status ?? 2,
					stdout: result.stdout,
					stderr: result.stderr,
				};
			},
		);
	}

	const calls: string[] = [];
	const prompts: string[] = [];
	const buildTools: (readonly string[])[] = [];
	let service = "not-found";
	const auditFiles: string[] = [];
	const reservations: { stage: string; reserve: boolean | undefined }[] = [];
	let visibleDeadline: number | undefined;
	let buildHostAt = 0;

	const runtime: BenchRuntime = {
		exec: async (command, args) => {
			assert.equal(command, "systemctl");
			assert.ok(args.includes("factory.service"));

			return { code: 0, stdout: service, stderr: "" };
		},
		assetsDir: f.assets,
		sourceRoot: f.repository,
		preflight: async () => {},
		visible: async (config, ...args) => {
			visibleDeadline = args[4]?.deadline;

			return runVisibleTests(
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
			);
		},
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
			if (config.stage === "build") {
				buildTools.push([...config.tools]);
				buildHostAt = Date.now();
			}

			if (config.stage === "accept")
				assert.equal(config.acceptEffort, "medium");
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
					reservations.push({
						stage: basename(config.stageDir ?? ""),
						reserve: spec.table.ceiling.reserve,
					});
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
					workspaces.push({
						stage: config.stage,
						path: config.workspace,
						published: existsSync(join(config.workspace, "test/acceptance")),
					});

					if (config.stage === "build" || config.stage === "review")
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

							if (config.stage === "specify") {
								const {
									version: _v,
									runId: _r,
									issue: _i,
									base: _b,
									snapshot: _s,
									link: _l,
									...draft
								} = f.contract;

								output =
									basename(config.stageDir ?? "") === "review"
										? '{"kind":"no_finding"}'
										: JSON.stringify({
												kind: "contract",
												...draft,
												summary: "Fresh contract",
												...(options.respec === "github-path"
													? {
															evidence: [
																{
																	path: ".github/factory/WORKFLOW.md",
																	start: 1,
																	end: 1,
																	fact: "Frozen workflow",
																},
															],
														}
													: options.respec === "oversized-summary"
														? {
																behavior: Array.from({ length: 8 }, () =>
																	"界".repeat(300),
																),
																exclusions: Array.from({ length: 8 }, () =>
																	"界".repeat(300),
																),
															}
														: {}),
												acceptance: draft.acceptance.map(
													({ id: _id, ...criterion }) => criterion,
												),
												...(["unknown", "ambiguous", "replacement"].includes(
													options.respec ?? "",
												) ||
												(options.respec === "revision-unknown" &&
													basename(config.stageDir ?? "") === "revision")
													? {
															replacesTests: [
																{
																	path: "test/src/value.test.ts",
																	test:
																		options.respec === "unknown" ||
																		options.respec === "revision-unknown"
																			? "missing"
																			: "base",
																	reason: "Synthetic replacement",
																},
															],
														}
													: undefined),
											});

								if (
									(options.respec === "revision" ||
										options.respec === "revision-unknown") &&
									basename(config.stageDir ?? "") === "review"
								)
									output =
										'{"kind":"ambiguities","ambiguities":["Clarify the value"]}';

								if (options.respec === "questions")
									output =
										'{"kind":"questions","questions":[{"text":"Which value?","cites":[]}]}';
							} else if (config.stage === "accept") {
								output = JSON.stringify({
									...f.suite,
									scenarios: f.suite.scenarios.map(
										({ kind: _kind, ...scenario }) =>
											scenario.id === "S2" &&
											options.respec?.startsWith("judge")
												? {
														...scenario,
														judge:
															options.respec === "judge-execution"
																? "Execute the CLI and inspect its output for value one."
																: "The trusted gates must pass.",
													}
												: scenario,
									),
									files: f.suite.files.map((file) => ({
										...file,
										content:
											options.respec === "preserved"
												? "import { readFileSync } from 'node:fs'; readFileSync('test/src/value.test.ts', 'utf8');\n"
												: file.content.replace(
														"private value",
														"fresh private value",
													),
									})),
								});
							} else if (config.stage === "build") {
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
													...(options.replacements ||
													options.respec === "replacement"
														? [
																{
																	scenario: "T1",
																	outcome: "pass",
																	reason: "Replacement matches the contract.",
																},
															]
														: []),
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
									JSON.stringify(
										options.pi140Request && !anthropic
											? PI_140_FIRST_REQUEST
											: {
													model: model.slice(model.indexOf("/") + 1),
													stream: true,
													max_tokens: 100,
													max_output_tokens: anthropic ? undefined : 100,
													input: anthropic ? undefined : "Synthetic request",
													messages: anthropic
														? [{ role: "user", content: "Synthetic request" }]
														: undefined,
												},
									),
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

	const run = async (
		state = join(root, "trial"),
		cap = 300000,
		overrides: Partial<BenchRuntime> = {},
	) => {
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
			{ ...runtime, ...overrides },
		);

		return { code, stdout, stderr, value: () => JSON.parse(stdout) };
	};

	return {
		...f,
		root,
		calls,
		prompts,
		auditFiles,
		reservations,
		buildTools,
		baseRequests,
		workspaces,
		deadline: () => ({ visibleDeadline, buildHostAt }),
		run,
		service: (value: string) => {
			service = value;
		},
	};
}

async function runHappyRespec(
	t: SuiteContext,
	cleanup: (run: () => void) => void,
) {
	const f = await harness(t, false, 1, { respec: "github-path" }, cleanup);
	const bin = join(f.root, "bin");
	const ghCalls = join(f.root, "gh-calls");
	put(bin, "gh", `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ghCalls}'\nexit 91\n`);
	chmodSync(join(bin, "gh"), 0o700);
	const previous = process.env.PATH;
	process.env.PATH = `${bin}:${previous}`;

	try {
		return { f, result: await f.run(), ghCalls };
	} finally {
		process.env.PATH = previous;
		mock.restoreAll();
	}
}

describe("bench run offline CLI", (suite) => {
	let happyRespec: Awaited<ReturnType<typeof runHappyRespec>>;
	const cleanups: (() => void)[] = [];
	after(() => {
		for (const cleanup of cleanups) cleanup();
	});
	before(
		async () => {
			happyRespec = await runHappyRespec(suite, (cleanup) =>
				cleanups.push(cleanup),
			);
		},
		{ timeout: 30000 },
	);

	it("respec accepts GitHub evidence with production's complete authoring checkout and file list", {
		timeout: 30000,
	}, () => {
		const { f, result } = happyRespec;
		assert.equal(result.code, 0, result.stderr);
		const trial = parseBenchTrial(result.stdout);

		assert.equal(trial.outcome.kind, "passed", JSON.stringify(trial.outcome));

		const authoring = f.workspaces.filter(
			({ stage }) => stage === "specify" || stage === "accept",
		);

		assert.ok(authoring.length >= 3);
		assert.ok(
			authoring.every(
				({ path, published }) =>
					published && path !== join(f.root, "trial/builder"),
			),
		);

		for (const stage of ["specify", "accept"]) {
			const prompt = f.prompts.find((prompt) =>
				prompt.includes(`factory's ${stage} stage`),
			);

			assert.ok(prompt?.includes(".github/factory/WORKFLOW.md"));

			if (stage === "specify")
				assert.ok(prompt?.includes("test/acceptance/published/secret.test.ts"));
		}
	});

	it("respec final base qualification passes production's scope and abort bounds to every runner call", {
		timeout: 30000,
	}, () => {
		const { f, result } = happyRespec;
		const trial = parseBenchTrial(result.stdout);
		assert.equal(trial.outcome.kind, "passed", JSON.stringify(trial.outcome));

		const requests = f.baseRequests.filter(({ tree }) =>
			tree.includes("accept-base"),
		);

		assert.ok(requests.length >= 2);
		const prefix = `factory-stage-${scopeOwner(join(f.root, "trial"))}-${trial.id.slice(0, 16)}-basecheck-1-`;

		for (const input of requests) {
			assert.ok(
				input.scope?.startsWith(prefix),
				"final base runner needs the production resource scope",
			);
			assert.match(input.scope ?? "", /-[0-9a-f]{8}$/);
			assert.ok(input.signal instanceof AbortSignal);
			assert.ok(
				input.deadlineMs !== undefined &&
					input.deadlineMs > 0 &&
					input.deadlineMs <= 180000,
			);
		}

		assert.equal(new Set(requests.map(({ scope }) => scope)).size, 1);
	});

	it("respec never invokes gh for draft checking or final base qualification", {
		timeout: 30000,
	}, () => {
		const { f, result, ghCalls: calls } = happyRespec;
		assert.equal(
			existsSync(calls),
			false,
			"offline respec attempted the gh CLI fallback",
		);
		const trial = parseBenchTrial(result.stdout);
		assert.equal(trial.outcome.kind, "passed", JSON.stringify(trial.outcome));
		assert.ok(existsSync(join(f.root, "trial/runtime/accept/draft-1.json")));
		assert.ok(f.baseRequests.some(({ tree }) => tree.includes("draft-1")));
		assert.ok(f.baseRequests.some(({ tree }) => tree.includes("accept-base")));
	});

	it("respec adds production's newline before skills to both authoring prompts", {
		timeout: 30000,
	}, () => {
		const { f } = happyRespec;

		for (const stage of ["specify", "accept"]) {
			const prompt = f.prompts.find((prompt) =>
				prompt.includes(`factory's ${stage} stage`),
			);

			assert.ok(
				prompt?.includes("\n\n\n## Skills\n"),
				`${stage} prompt lacks production's final newline`,
			);
		}
	});

	it("respec records specifySourceFacts for the inlined README", {
		timeout: 30000,
	}, () => {
		const { f } = happyRespec;

		const receipt = JSON.parse(
			readFileSync(
				join(f.root, "trial/runtime/specify/draft/receipt.json"),
				"utf8",
			),
		);

		const facts = specifySourceFacts([
			inlined(
				"README.md",
				readFileSync(join(f.repository, "README.md"), "utf8"),
				10000,
			),
		]);

		assert.equal(receipt.efficiency.initialSourceBytes, facts.bytes);
	});

	it("respec refuses an unpostable rendered contract summary before accept", {
		timeout: 60000,
	}, async (t) => {
		const f = await harness(t, false, 1, { respec: "oversized-summary" });
		const result = await f.run();
		const trial = parseBenchTrial(result.stdout);

		assert.deepEqual(trial.outcome, {
			kind: "failed",
			stage: "specify",
			reason: "specify_too_large_to_post",
		});
		assert.equal(
			f.workspaces.some(({ stage }) => stage === "accept"),
			false,
		);
		assert.equal(trial.respec?.contractDigest, null);
	});

	it("respec runs real authoring and final base qualification before the unchanged build-to-review path", {
		timeout: 30000,
	}, async (t) => {
		const { f, result } = happyRespec;
		assert.equal(result.code, 0, result.stderr);
		const trial = parseBenchTrial(result.stdout);
		assert.equal(trial.outcome.kind, "passed", JSON.stringify(trial.outcome));
		assert.deepEqual(
			trial.stages.slice(0, 4).map((stage) => stage.name),
			["specify", "accept", "accept-base", "build"],
		);
		assert.ok(trial.respec?.baseReceiptDigest);
		assert.notEqual(
			trial.respec?.contractDigest,
			JSON.parse(readFileSync(join(f.bundle, "task.json"), "utf8"))
				.contractDigest,
		);
		assert.ok(f.prompts.some((prompt) => prompt.includes("Fresh contract")));
		assert.ok(f.buildTools.every((tools) => !tools.includes("subagent")));
		const { visibleDeadline, buildHostAt } = f.deadline();
		assert.ok(
			visibleDeadline !== undefined &&
				visibleDeadline - buildHostAt > 1_799_900,
		);

		const review = JSON.parse(
			readFileSync(join(f.root, "trial/review-input.json"), "utf8"),
		);

		assert.equal(
			review.binding.acceptanceDigest,
			trial.respec?.acceptanceDigest,
		);
		assert.equal(review.binding.contractDigest, trial.respec?.contractDigest);

		const candidate = execFileSync(
			"git",
			[
				"-C",
				join(f.root, "trial/repository"),
				"show",
				"HEAD:test/acceptance/bench-" +
					trial.id.slice(0, 16) +
					"/checks/value.test.ts",
			],
			{ encoding: "utf8" },
		);

		assert.ok(candidate.includes("fresh private value"));
		assert.ok(candidate.includes("factory-holdout-"));
		assert.ok(trial.accounting.sources.includes("specify/draft"));
		assert.ok(!trial.accounting.sources.includes("specify"));
		const compared = JSON.stringify(compareTrials([trial]));
		assert.ok(!compared.includes("fresh private value"));
		assert.ok(!compared.includes("factory-holdout-"));
		t.diagnostic(
			JSON.stringify({
				syntheticTask: 1,
				mode: "respec",
				outcome: trial.outcome,
				stages: trial.stages.map((stage) => stage.name),
				tokens: trial.accounting.chargedTokens,
				cost: trial.accounting.cost.estimate,
				billedSpend: trial.accounting.cost.billedSpend,
			}),
		);
		const before = f.calls.length;
		rmSync(join(f.root, "trial/trial.json"));
		assert.match((await f.run()).stderr, /trial_incomplete_refusing_resume/);
		assert.equal(f.calls.length, before);
	});

	for (const mode of [
		"unknown",
		"ambiguous",
		"revision-unknown",
		"questions",
		"judge",
		"judge-execution",
		"preserved",
		"missing-base",
		"failed-base",
	] as const)
		it(`respec refuses ${mode} before any build`, {
			timeout: 60000,
		}, async (t) => {
			const f = await harness(t, false, 1, {
				respec: mode,
				ambiguous: mode === "ambiguous",
			});

			const result = await f.run();
			assert.equal(result.code, 0, result.stderr);
			const trial = parseBenchTrial(result.stdout);
			assert.equal(trial.outcome.kind, "failed");
			assert.equal(f.buildTools.length, 0);

			if (mode.startsWith("judge") || mode === "preserved") {
				const draft = JSON.parse(
					readFileSync(
						join(f.root, "trial/runtime/accept/draft-1.json"),
						"utf8",
					),
				);

				assert.equal(draft.feedback.verdict, "judge_refused");
				assert.equal(
					draft.feedback.reason,
					mode === "preserved"
						? "heldout_reads_preserved_test"
						: mode === "judge"
							? "judge_restates_gate"
							: "judge_requires_execution",
				);
			}

			assert.equal(
				trial.outcome.kind === "failed" ? trial.outcome.stage : "",
				["unknown", "ambiguous", "revision-unknown", "questions"].includes(mode)
					? "specify"
					: mode.includes("base")
						? "accept-base"
						: "accept",
			);
		});

	for (const mode of ["revision", "replacement"] as const)
		it(`respec retains real specify ${mode} output downstream`, {
			timeout: 60000,
		}, async (t) => {
			const f = await harness(t, false, 1, { respec: mode });
			const result = await f.run();
			assert.equal(result.code, 0, result.stderr);
			const trial = parseBenchTrial(result.stdout);
			assert.equal(trial.outcome.kind, "passed", JSON.stringify(trial.outcome));

			if (mode === "revision")
				assert.ok(trial.accounting.sources.includes("specify/revision"));
			else {
				const contract = JSON.parse(
					readFileSync(join(f.root, "trial/respec/contract.json"), "utf8"),
				);

				assert.equal(contract.replacesTests[0].test, "base");
				assert.ok(
					trial.judges.some((judge) =>
						judge.judgments.some((judgment) => judgment.scenario === "T1"),
					),
				);
			}
		});

	it("respec caps all authoring work before build without discarding its leaf charges", {
		timeout: 60000,
	}, async (t) => {
		const f = await harness(t, false, 1, { respec: "on" });
		const result = await f.run(undefined, 1);
		assert.equal(result.code, 0, result.stderr);
		const trial = parseBenchTrial(result.stdout);
		assert.equal(trial.outcome.kind, "budget_exhausted");
		assert.ok(trial.accounting.chargedTokens > 0);
		assert.equal(f.buildTools.length, 0);
	});

	it("refuses a mismatched Docker gate uid before model calls or a claim", {
		timeout: 60000,
	}, async (t) => {
		t.mock.method(dockerRunner, "run", async () => ({
			exitCode: 1,
			stdout: "",
			stderr: "Docker must not run on a mismatched host",
		}));

		for (const gateRunner of [undefined, dockerRunner]) {
			const f = await harness(t);
			const state = join(f.root, "trial");
			const overrides = { gateRunner, uid: () => 1000 };
			const result = await f.run(state, 300000, overrides);
			assert.equal(f.calls.length, 0, "must refuse before any model call");
			assert.equal(result.code, 1, result.stderr);
			assert.match(result.stderr, /gate_runner_uid_mismatch/);
			assert.equal(existsSync(join(state, "claim")), false);
		}
	});
	it("allows a matching Docker gate uid to reach sandbox preflight", async (t) => {
		const f = await harness(t);

		const result = await f.run(undefined, undefined, {
			gateRunner: dockerRunner,
			uid: () => 1001,
			preflight: async () => {
				throw new Error("matching_uid_reached_preflight");
			},
		});

		assert.equal(result.code, 0, result.stderr);
		assert.equal(
			result.value().outcome.reason,
			"matching_uid_reached_preflight",
		);
		assert.equal(existsSync(join(f.root, "trial/claim")), true);
		assert.equal(f.calls.length, 0);
	});
	it("reserves tokens only for the second judge, matching production", {
		timeout: 60000,
	}, async (t) => {
		const f = await harness(t);
		const result = await f.run();
		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.value().outcome.kind, "passed");
		assert.deepEqual(
			f.reservations.map(({ stage }) => stage),
			["build", "code-review", "security-review", "simplify", SECOND_JUDGE],
		);

		for (const { stage, reserve } of f.reservations)
			assert.equal(reserve === true, stage === SECOND_JUDGE, stage);
	});
	it("forwards pi 1.4.0 gpt-6.1-sol first-request items through the build gateway", {
		timeout: 60000,
	}, async (t) => {
		const f = await harness(t, false, 1, { pi140Request: true });
		const result = await f.run();
		assert.equal(result.code, 0, result.stderr);

		const audit = readFileSync(
			join(f.root, "trial/runtime/build/egress.jsonl"),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

		assert.ok(
			audit.some(
				(row) =>
					row.route === "model-openai" &&
					row.decision === "forward" &&
					row.status === 200,
			),
			JSON.stringify(
				audit.map(({ decision, reason, gate }) => ({ decision, reason, gate })),
			),
		);
		assert.equal(
			result.value().outcome.kind,
			"passed",
			JSON.stringify(result.value().outcome),
		);
	});
	it("stages colon-prefixed paths literally", async (t) => {
		const f = await harness(t);
		put(f.repository, ":added.ts", "export const added = 1;\n");
		put(f.repository, "added.ts", "must remain unstaged\n");
		stageBenchPaths(f.repository, [":added.ts"]);
		assert.equal(f.git("diff", "--cached", "--name-only"), ":added.ts");
		assert.equal(f.git("show", "::added.ts"), "export const added = 1;");
	});
	it("passes the recorded replacements digest to trusted gates", {
		timeout: 60000,
	}, async (t) => {
		const f = await harness(t, false, 1, { replacements: true });
		const result = await f.run();
		assert.equal(result.code, 0, result.stderr);
		assert.equal(
			result.value().outcome.kind,
			"passed",
			JSON.stringify(result.value().outcome),
		);
		assert.equal(result.value().judges.length, 4);
	});
	it("gives every review seat bench-local gate evidence inside the trusted block", {
		timeout: 60000,
	}, async (t) => {
		const f = await harness(t);
		const result = await f.run();
		assert.equal(result.code, 0, result.stderr);
		assert.equal(
			result.value().outcome.kind,
			"passed",
			JSON.stringify(result.value().outcome),
		);

		const receipt = readFileSync(
			join(f.root, "trial/gates/receipt.json"),
			"utf8",
		);

		const gate = JSON.parse(receipt);
		const reviews = f.prompts.slice(1);
		assert.equal(reviews.length, 4);

		for (const prompt of reviews) {
			const block = prompt.match(
				/<trusted-pipeline-evidence>\n(.*?)\n<\/trusted-pipeline-evidence>/s,
			);

			assert.ok(block?.[1]);

			const evidence = JSON.parse(block[1]);
			assert.ok(evidence !== null, "trusted gate evidence must not be null");
			assert.match(evidence.run, /bench-local trusted gates/);
			assert.equal(evidence.candidateSha, gate.candidateSha);
			assert.equal(evidence.gateSha, gate.gateSha);
			assert.equal(evidence.ciRunId, 0);
			assert.equal(evidence.ci.runId, 0);
			assert.equal(evidence.ci.reportId, 0);
			assert.equal(evidence.gateReceiptDigest, digestOf(receipt));
			assert.equal(evidence.reportDigest, digestOf(receipt));
			assert.equal(evidence.checks.length, gate.checks.length);
			assert.ok(
				evidence.checks.every(
					(check: { exitCode: number; durationMs: number }) =>
						check.exitCode === 0 && check.durationMs >= 0,
				),
			);
			assert.deepEqual(
				evidence.checks.find(
					(check: { name: string }) => check.name === "main_tests",
				).testGlobs,
				gate.testGlobs,
			);
			assert.deepEqual(evidence.heldout, { files: 1, tests: 1 });
			assert.ok(!prompt.includes("Offline bench evidence, NOT GitHub CI."));
		}
	});
	it("retains ignored archived files and explicitly stages ignored patch additions", {
		timeout: 60000,
	}, async (t) => {
		const f = await harness(t, false, 1, { ignored: true });
		const result = await f.run();
		assert.equal(result.code, 0, result.stderr);
		assert.equal(
			result.value().outcome.kind,
			"passed",
			JSON.stringify(result.value().outcome),
		);

		const gate = JSON.parse(
			readFileSync(join(f.root, "trial/gates/receipt.json"), "utf8"),
		);

		const files = (sha: string) =>
			execFileSync(
				"git",
				[
					"-C",
					join(f.root, "trial/repository"),
					"ls-tree",
					"-r",
					"--name-only",
					sha,
				],
				{ encoding: "utf8" },
			).split("\n");

		assert.ok(
			files(gate.gateSha).includes("src/ignored-base.ts"),
			"archived tracked files must survive gitignore",
		);
		assert.ok(
			files(gate.candidateSha).includes("test/src/added.test.ts"),
			"patch additions must survive gitignore",
		);
		assert.ok(
			gate.checks.some(
				(check: { name: string; exitCode: number; durationMs: number }) =>
					check.name === "candidate_tests" &&
					check.exitCode === 0 &&
					check.durationMs > 0,
			),
		);
	});
	it("inlines production source excerpts and enables subagent only above eight contract files", {
		timeout: 60000,
	}, async (t) => {
		const small = await harness(t);
		assert.equal((await small.run()).value().outcome.kind, "passed");
		assert.ok(small.prompts[0]?.includes("export const value = 0;"));
		assert.ok(small.buildTools.every((tools) => !tools.includes("subagent")));

		const large = await harness(t, false, 1, { large: true });
		assert.equal((await large.run()).value().outcome.kind, "passed");
		assert.ok(large.prompts[0]?.includes("export const value = 0;"));
		assert.ok(large.buildTools.every((tools) => tools.includes("subagent")));
	});
	it("refuses skill variants through symlinked installed directories without touching their targets", {
		timeout: 60000,
	}, async (t) => {
		for (const path of ["assets", "assets/skills", "assets/skills/build"]) {
			const f = await harness(t);
			const target = join(f.root, path);
			const external = join(f.root, "external");
			renameSync(target, external);
			symlinkSync(external, target);
			const replacement = "Replacement must never reach the installed skill.\n";
			put(f.root, "build.md", replacement);
			const assetsDigest = await manifestDigest(f.assets);
			assert.ok(assetsDigest !== null);
			writeFileSync(
				f.variantFile,
				JSON.stringify({
					...f.variant,
					pins: { ...f.variant.pins, assetsDigest },
					change: {
						kind: "skill",
						path: "skills/build/SKILL.md",
						file: "build.md",
						digest: digestOf(replacement),
					},
				}),
			);
			const result = await f.run();
			assert.notEqual(
				result.code,
				0,
				"symlinked installed directory must be refused before trial preparation",
			);
			assert.match(result.stderr, /skill_variant_symlink/);
			assert.equal(f.calls.length, 0);
			assert.equal(await manifestDigest(f.assets), assetsDigest);
		}
	});
	it("refuses variant files resolving inside the bundle, including oracle checks", {
		timeout: 60000,
	}, async (t) => {
		for (const file of [
			"bundle/oracle/checks/value.test.ts",
			"bundle/builder/contract.json",
		]) {
			const f = await harness(t);
			const originalDigest = await manifestDigest(f.assets);
			symlinkSync(join(f.root, file), join(f.root, "replacement.md"));
			writeFileSync(
				f.variantFile,
				JSON.stringify({
					...f.variant,
					change: {
						kind: "skill",
						path: "skills/build/SKILL.md",
						file: "replacement.md",
						digest: digestOf(readFileSync(join(f.root, file))),
					},
				}),
			);
			const result = await f.run();
			assert.notEqual(
				result.code,
				0,
				"bundle bytes must not become skill instructions",
			);
			assert.match(result.stderr, /variant_file_inside_bundle/);
			assert.equal(f.calls.length, 0);
			assert.equal(await manifestDigest(f.assets), originalDigest);
		}
	});
	it("R3 runs current trusted gates against a historical bundle base with different materializer files", {
		timeout: 30000,
	}, async (t) => {
		const f = await harness(t, false, 1, { historicalMaterializer: true });
		assert.ok(
			!materializerIdentity(f.repository).equals(
				materializerIdentity(process.cwd()),
			),
		);

		for (const path of MATERIALIZER_FILES)
			put(f.repository, path, readFileSync(path));
		f.git("add", "host");
		f.git("commit", "-qm", "current bench product");
		const revision = f.git("rev-parse", "HEAD");
		assert.notEqual(revision, f.sha);
		writeFileSync(
			f.variantFile,
			JSON.stringify({
				...f.variant,
				pins: { ...f.variant.pins, factoryRevision: revision },
			}),
		);

		const result = await f.run();
		assert.equal(result.code, 0, result.stderr);
		const trial = parseBenchTrial(result.stdout);
		assert.equal(trial.outcome.kind, "passed", JSON.stringify(trial.outcome));
		assert.equal(trial.runtime.factoryRevision, revision);

		const receipt = JSON.parse(
			readFileSync(join(f.root, "trial/gates/receipt.json"), "utf8"),
		);

		assert.equal(receipt.status, "passed");
		assert.notEqual(receipt.gateSha, revision);
		assert.equal(receipt.reason, null);

		for (const path of MATERIALIZER_FILES)
			assert.equal(
				execFileSync(
					"git",
					[
						"-C",
						join(f.root, "trial/repository"),
						"show",
						`${receipt.gateSha}:${path}`,
					],
					{ encoding: "utf8" },
				),
				"export const materializer = 'historical';\n",
			);
	});

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
		const malformed = `${JSON.stringify({ ...trial, version: 99 })}\n`;
		writeFileSync(join(f.root, "trial/trial.json"), malformed);
		writeFileSync(
			join(f.root, "trial/trial.sha256"),
			`${digestOf(malformed)}\n`,
		);
		const refused = await f.run();
		assert.equal(
			refused.code,
			1,
			"a matching digest does not validate the trial schema",
		);
		assert.match(refused.stderr, /invalid_literal/);
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
	it("accepts a passed receipt from a repository's version 2 gate policy without Factorio's checks", {
		timeout: 60000,
	}, async (t) => {
		const f = await harness(t, false, 1, { repositoryGatePolicy: true });
		const result = await f.run();
		assert.equal(result.code, 0, result.stderr);
		const trial = result.value();
		assert.equal(trial.outcome.kind, "passed", JSON.stringify(trial.outcome));
		assert.equal(
			trial.stages.find(
				(stage: { name: string }) => stage.name === "validation",
			)?.outcome,
			"passed",
		);
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
	it("records budget exhaustion after the request crossing the cap, as production does", {
		timeout: 30000,
	}, async (t) => {
		const f = await harness(t);
		const result = await f.run(join(f.root, "capped"), 1);
		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.value().outcome.kind, "budget_exhausted");
		assert.ok(result.value().accounting.chargedTokens > 1);

		const audit = readFileSync(
			join(f.root, "capped/runtime/build/egress.jsonl"),
			"utf8",
		);

		assert.ok(
			audit
				.split("\n")
				.filter(Boolean)
				.some((line) => {
					const row = JSON.parse(line);

					return row.route === "model-openai" && row.decision === "forward";
				}),
		);
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
