import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleJson } from "../../src/bench/bundle.ts";
import { parseBenchVariant } from "../../src/bench/variant.ts";
import {
	trialAccounting,
	type BenchTrial,
	type TrialJournal,
	type TrialOutcome,
	type TrialStage,
} from "../../src/bench/trial.ts";
import {
	BUILD_MAX_TOKENS,
	BUILD_TOOLS,
	buildPrompt,
	collectPatch,
	prepareRepairTree,
	visibleTestCommand,
	workspaceTestEdits,
} from "../../src/candidate/build.ts";
import { unrunTestFeedback } from "../../src/candidate/diagnosis.ts";
import {
	candidateReviewPrompt,
	parseSeat,
	replacementScenarios,
	REVIEW_TOOLS,
	reviewSeats,
	SECOND_JUDGE,
	SECOND_JUDGE_MAX_TOKENS,
	seatPrompt,
	type ReviewInput,
	type SeatReceipt,
} from "../../src/candidate/review.ts";
import { parseWorkflow } from "../../src/config/parse.ts";
import { type EnvLookup, type ModelId } from "../../src/config/schema.ts";
import { readAcceptanceSuite } from "../../src/contract/acceptance.ts";
import {
	parseStoredContract,
	regularText,
} from "../../src/contract/artifacts.ts";
import { objectOf, parseJson } from "../../src/core/json.ts";
import {
	parseFamily,
	FAMILY_MISSING,
	familyLabel,
} from "../../src/core/models.ts";
import {
	blocksReview,
	digestOf,
	isDigest,
	REVIEW_MAX_TOKENS,
	type Verdict,
} from "../../src/core/run.ts";
import { PINNED_TARIFF, tariffDigest } from "../../src/core/tariff.ts";
import type { Exec } from "../../src/github/exec.ts";
import type { PlatformProfile } from "../../src/trust/platform.ts";
import {
	ACCEPTANCE_SUITE_PREFIX,
	FEEDBACK_FILE,
} from "../../src/trust/protected-paths.ts";
import { manifestDigest, PINNED_VERSIONS } from "../bundle/manifest.ts";
import {
	checkCandidate,
	receiptPasses,
	type CandidateInput,
} from "../gates/gates.ts";
import { heldoutDigest } from "../gates/materialize.ts";
import { dockerRunner, type GateRunner } from "../gates/runner.ts";
import { readUsernsLimit, runPreflight } from "../isolation/preflight.ts";
import { detectArch } from "../isolation/seccomp.ts";
import { locateBundle, SANDBOX_ROOT, withSkills } from "../sandbox/executor.ts";
import { sandboxHost, type SandboxHostConfig } from "../sandbox/launch.ts";
import {
	boundedText,
	publishFile,
	readStageReceipt,
} from "../sandbox/receipts.ts";
import {
	runStage,
	type StageHost,
	type StageRunInput,
} from "../sandbox/run-stage.ts";
import { runVisibleTests } from "../sandbox/visible-tests.ts";
import { unpackBase } from "./archive.ts";
import { verifyBundle } from "./export.ts";

export type BenchRuntime = {
	readonly exec: Exec;
	readonly assetsDir?: string;
	readonly sourceRoot?: string;
	readonly createHost?: (config: SandboxHostConfig) => StageHost;
	readonly visible?: typeof runVisibleTests;
	readonly gateRunner?: GateRunner;
	readonly preflight?: (config: SandboxHostConfig) => Promise<void>;
};

function git(repository: string, args: readonly string[]): string {
	return execFileSync(
		"git",
		[
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"core.attributesFile=/dev/null",
			"-c",
			"user.name=Offline bench",
			"-c",
			"user.email=bench@example.invalid",
			"-C",
			repository,
			...args,
		],
		{
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			timeout: 30_000,
			env: {
				PATH: process.env.PATH,
				HOME: "/nonexistent",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
				GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
				LC_ALL: "C",
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	).trim();
}

async function guardHost(exec: Exec): Promise<void> {
	for (const scope of [[], ["--user"]]) {
		const result = await exec("systemctl", [
			...scope,
			"show",
			"factory.service",
			"--property=LoadState",
			"--value",
		]);

		if (result.stdout.trim() !== "not-found")
			throw new Error(
				result.stdout.trim()
					? "factory_service_present"
					: "factory_service_probe_failed",
			);
	}
}

function privateState(path: string): void {
	if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
	const info = lstatSync(path);

	if (
		!info.isDirectory() ||
		info.uid !== process.getuid?.() ||
		(info.mode & 0o777) !== 0o700
	)
		throw new Error("unsafe_bench_state");
}

function fileLines(root: string): Map<string, number> {
	const files = new Map<string, number>();

	const walk = (prefix: string) => {
		for (const entry of readdirSync(join(root, prefix), {
			withFileTypes: true,
		})) {
			const path = prefix + entry.name;

			if (
				entry.name === ".git" ||
				entry.name === "node_modules" ||
				path === ".github" ||
				path === "test/acceptance"
			)
				continue;

			if (entry.isDirectory()) walk(`${path}/`);
			else if (entry.isFile())
				files.set(
					path,
					readFileSync(join(root, path), "utf8").split("\n").length,
				);
		}
	};

	walk("");

	return files;
}

async function preflight(config: SandboxHostConfig) {
	const result = await runPreflight({
		reconciled: async () => true,
		arch: process.arch,
		xdgRuntimeDir: config.xdgRuntimeDir,
		usernsLimit: readUsernsLimit,
		exec: config.exec,
		assetsDigest: () => manifestDigest(config.bundleDir),
		expectedDigest: config.assetsDigest,
		gatewayReady: async () => true,
	});

	if (!result.ok) throw new Error(`bench_preflight:${result.failed.join(",")}`);
}

export async function runBench(
	input: {
		readonly bundle: string;
		readonly variantFile: string;
		readonly stateDir: string;
		readonly tokenCap: number;
		readonly platform: PlatformProfile;
		readonly env: EnvLookup;
	},
	runtime: BenchRuntime,
): Promise<string> {
	const state = resolve(input.stateDir);

	if (existsSync(state)) {
		privateState(state);

		if (readdirSync(state).length > 0 && !existsSync(join(state, "claim")))
			throw new Error("production_or_non_bench_state");
	}

	const variantFile = resolve(input.variantFile);
	const variant = parseBenchVariant(regularText(variantFile, 64 * 1024));
	const bundle = realpathSync(input.bundle);
	const verified = verifyBundle(bundle);
	const { task, manifestDigest: bundleDigest } = verified;

	const sourceRoot =
		runtime.sourceRoot ?? fileURLToPath(new URL("../..", import.meta.url));

	const revision = git(sourceRoot, ["rev-parse", "HEAD"]);

	if (git(sourceRoot, ["status", "--porcelain", "--untracked-files=no"]) !== "")
		throw new Error("bench_checkout_dirty");

	const originalWorkflow = regularText(
		join(bundle, "original/WORKFLOW.md"),
		256 * 1024,
	);

	if (
		variant.pins.bundleDigest !== bundleDigest ||
		variant.pins.factoryRevision !== revision ||
		variant.pins.workflowDigest !== digestOf(originalWorkflow) ||
		variant.pins.tariffDigest !== tariffDigest(PINNED_TARIFF)
	)
		throw new Error("variant_pin_mismatch");

	if (!Number.isSafeInteger(input.tokenCap) || input.tokenCap <= 0)
		throw new Error("invalid_token_cap");

	if (input.platform.name !== "exe-dev")
		throw new Error("bench_requires_exe_dev");
	await guardHost(runtime.exec);
	const assets = runtime.assetsDir ?? (await locateBundle(SANDBOX_ROOT))?.dir;

	if (
		assets === undefined ||
		(await manifestDigest(assets)) !== variant.pins.assetsDigest
	)
		throw new Error("assets_pin_mismatch");

	const workflow = parseWorkflow({
		text: originalWorkflow,
		repo: task.repo,
		platform: input.platform,
		env: input.env,
	});

	if (workflow.kind !== "valid") throw new Error("bench_workflow_invalid");

	if (
		variant.change.kind === "model" &&
		workflow.config.stages[variant.change.stage].model === variant.change.model
	)
		throw new Error("variant_model_unchanged");

	const replacement =
		variant.change.kind === "skill"
			? readFileSync(resolve(dirname(variantFile), variant.change.file))
			: null;

	if (
		variant.change.kind === "skill" &&
		(replacement === null ||
			digestOf(replacement) !== variant.change.digest ||
			!lstatSync(join(assets, variant.change.path)).isFile() ||
			digestOf(readFileSync(join(assets, variant.change.path))) ===
				variant.change.digest)
	)
		throw new Error("skill_variant_mismatch");

	const stored = parseStoredContract(
		regularText(join(bundle, "builder/contract.json"), 8 * 1024 * 1024),
		regularText(join(bundle, "original/contract-receipt.json"), 64 * 1024),
		task.runId,
	);

	if (stored.kind !== "found") throw new Error("bench_contract_invalid");

	const rawSuite = objectOf(
		parseJson(regularText(join(bundle, "oracle/suite.json"), 8 * 1024 * 1024)),
	);

	if (rawSuite === null) throw new Error("bench_suite_invalid");
	const { canary: _canary, ...suiteBody } = rawSuite;
	const accepted = readAcceptanceSuite(suiteBody, stored.contract);

	if (accepted.kind !== "suite") throw new Error("bench_suite_invalid");
	privateState(state);
	const realState = realpathSync(state);

	if (
		bundle === realState ||
		bundle.startsWith(`${realState}/`) ||
		realState.startsWith(`${bundle}/`)
	)
		throw new Error("bundle_state_overlap");
	const variantDigest = digestOf(JSON.stringify(variant));

	const binding = bundleJson({
		kind: "factory_benchmark_state",
		version: 1,
		bundleDigest,
		variantDigest,
		tokenCap: input.tokenCap,
	});

	const claim = join(state, "claim");

	if (existsSync(claim)) {
		if (regularText(join(claim, "binding.json"), 4096) !== binding)
			throw new Error("bench_state_binding_mismatch");
		const result = join(state, "trial.json");

		if (!existsSync(result))
			throw new Error(
				"trial_incomplete_refusing_resume:no_new_calls_or_charges",
			);
		const text = regularText(result, 8 * 1024 * 1024);

		if (regularText(join(state, "trial.sha256"), 100) !== `${digestOf(text)}\n`)
			throw new Error("trial_record_digest_mismatch");

		return text;
	}

	if (readdirSync(state).length !== 0)
		throw new Error("production_or_non_bench_state");
	mkdirSync(claim, { mode: 0o700 });

	if (!publishFile(join(claim, "binding.json"), binding))
		throw new Error("bench_claim_failed");
	const id = digestOf(`bench/${randomBytes(32).toString("hex")}`);
	const started = Date.now();
	const stages: TrialStage[] = [];
	const journals: TrialJournal[] = [];
	const judges: SeatReceipt[] = [];
	let activeStage = "prepare";

	let outcome: TrialOutcome = {
		kind: "failed",
		stage: activeStage,
		reason: "trial_incomplete",
	};

	let bundleDir = assets;
	let assetsDigest: string = variant.pins.assetsDigest;
	const base = join(state, "base");
	const repository = join(state, "repository");
	const workspace = join(state, "builder");
	const reviewTree = join(state, "review-tree");
	const arch = detectArch(process.arch);

	if (arch === null) throw new Error("bench_arch_unsupported");

	const hostConfig = (
		stage: "build" | "review",
		stageDir: string,
		tree: string,
		tools: readonly string[],
	): SandboxHostConfig => ({
		platform: input.platform,
		stateDir: state,
		bundleDir,
		workspace: tree,
		stageDir,
		runId: id,
		stage,
		attempt: 1,
		tools,
		arch,
		xdgRuntimeDir:
			input.env("XDG_RUNTIME_DIR") ?? `/run/user/${process.getuid?.() ?? 1000}`,
		assetsDigest,
		versions: PINNED_VERSIONS,
		exec: runtime.exec,
	});

	const remaining = () =>
		Math.max(0, input.tokenCap - trialAccounting(journals).chargedTokens);

	const stageModel = (stage: "build" | "review") =>
		variant.change.kind === "model" && variant.change.stage === stage
			? variant.change.model
			: workflow.config.stages[stage].model;

	let reviewTurns = 0;
	let reviewDeadline: number | null = null;

	const runModel = async (
		name: string,
		stage: "build" | "review",
		model: ModelId,
		prompt: string,
		tree: string,
		tools: readonly string[],
		allowance: number,
	) => {
		activeStage = name;
		const stageDir = join(state, "runtime", name);
		mkdirSync(stageDir, { recursive: true, mode: 0o700 });
		const began = Date.now();
		const config = hostConfig(stage, stageDir, tree, tools);
		const stageBudget = workflow.config.stages[stage].budget;

		const fallback =
			stage === "build" || name === "security-review"
				? workflow.config.stages[stage].fallbackModel
				: null;

		const index = journals.length;
		journals.push({ id: name, model, fallback, text: null, receiptTokens: 0 });

		if (stage === "review" && reviewDeadline === null)
			reviewDeadline = Date.now() + stageBudget.wallMs;

		const budget =
			stage === "review" && reviewDeadline !== null
				? {
						...stageBudget,
						maxTurns: Math.max(0, stageBudget.maxTurns - reviewTurns),
						wallMs: Math.max(0, reviewDeadline - Date.now()),
					}
				: stageBudget;

		const request: StageRunInput = {
			runId: id,
			stage,
			attempt: 1,
			prompt,
			settings: {
				model,
				fallback,
				budget,
				maxTokens: Math.max(0, Math.min(remaining(), allowance)),
				reserveTokens: true,
			},
			remainingRunTokens: remaining(),
			signal: new AbortController().signal,
			progress: () => {},
		};

		const draftCheck =
			stage === "build" &&
			!(
				variant.change.kind === "buildRevision" &&
				variant.change.value === "off"
			)
				? async () =>
						unrunTestFeedback(
							workspaceTestEdits(
								base,
								workspace,
								stored.contract.replacesTests ?? [],
								true,
							).unrunTestEdits,
						)
				: undefined;

		const result = await runStage(
			draftCheck === undefined ? request : { ...request, draftCheck },
			(runtime.createHost ?? sandboxHost)(config),
		);

		journals[index] = {
			id: name,
			model,
			fallback,
			text: await boundedText(
				join(stageDir, "egress.requests.jsonl"),
				16 * 1024 * 1024,
			),
			receiptTokens: result.receipt.usage.total,
		};

		if (stage === "review") reviewTurns += result.receipt.turns;
		stages.push({ name, wallMs: Date.now() - began, outcome: result.kind });

		if (result.kind !== "passed")
			throw new Error(
				result.kind === "budget_exhausted"
					? "budget_exhausted"
					: `model_${result.kind}`,
			);

		if (
			remaining() === 0 &&
			trialAccounting(journals).chargedTokens > input.tokenCap
		)
			throw new Error("budget_exhausted");

		return {
			result,
			text: regularText(join(stageDir, "output.txt"), 256 * 1024),
		};
	};

	try {
		if (variant.change.kind === "skill" && replacement !== null) {
			bundleDir = join(state, "assets");
			cpSync(assets, bundleDir, { recursive: true, verbatimSymlinks: true });
			const target = join(bundleDir, variant.change.path);
			chmodSync(dirname(target), 0o700);
			rmSync(target);
			writeFileSync(target, replacement, { mode: 0o600, flag: "wx" });
			const computed = await manifestDigest(bundleDir);

			if (computed === null) throw new Error("skill_assets_invalid");
			assetsDigest = computed;
		}

		await (runtime.preflight ?? preflight)(
			hostConfig("build", join(state, "runtime/build"), workspace, BUILD_TOOLS),
		);
		mkdirSync(base, { mode: 0o700 });
		unpackBase(readFileSync(join(bundle, "builder/base.tar")), base);

		if (
			digestOf(readFileSync(join(base, ".github/factory/WORKFLOW.md"))) !==
				digestOf(readFileSync(join(bundle, "builder/WORKFLOW.md"))) ||
			digestOf(readFileSync(join(base, ".github/factory/gates/gates.json"))) !==
				digestOf(readFileSync(join(bundle, "policy/gates.json")))
		)
			throw new Error("archived_policy_mismatch");
		cpSync(base, repository, { recursive: true });
		git(repository, ["init", "-q"]);
		git(repository, ["add", "."]);
		git(repository, ["commit", "-qm", "Archived benchmark base"]);
		const gateSha = git(repository, ["rev-parse", "HEAD"]);
		await prepareRepairTree(base, workspace, "", [], "{}");
		rmSync(join(workspace, FEEDBACK_FILE));

		const prompt = await withSkills(
			bundleDir,
			buildPrompt({
				contract: stored.contract,
				guidance: workflow.guidance,
				inlined: [],
			}),
			["build"],
		);

		if (prompt === null) throw new Error("build_skills_unavailable");

		const build = await runModel(
			"build",
			"build",
			stageModel("build"),
			prompt,
			workspace,
			BUILD_TOOLS,
			BUILD_MAX_TOKENS,
		);

		const collected = await collectPatch({ base, workspace, repairTree: true });

		if (collected.kind !== "collected" || collected.policy !== "clean")
			throw new Error(
				collected.kind === "error" ? collected.reason : "forbidden_paths",
			);

		writeFileSync(join(state, "patch.diff"), collected.patch, {
			mode: 0o600,
			flag: "wx",
		});
		activeStage = "visible_tests";
		let began = Date.now();

		const visible = await (runtime.visible ?? runVisibleTests)(
			hostConfig("build", join(state, "visible"), workspace, []),
			base,
			collected.patch,
			visibleTestCommand(workflow.guidance),
			stored.contract.replacesTests ?? [],
			{ deadline: started + workflow.config.stages.build.budget.wallMs },
		);

		publishFile(join(state, "visible.json"), JSON.stringify(visible));
		stages.push({
			name: activeStage,
			wallMs: Date.now() - began,
			outcome: visible.exitCode === 0 ? "passed" : "failed",
		});

		if (visible.exitCode !== 0)
			throw new Error(visible.reason ?? "visible_tests_failed");
		await prepareRepairTree(
			base,
			reviewTree,
			collected.patch,
			collected.changedPaths,
			"{}",
		);
		rmSync(join(reviewTree, FEEDBACK_FILE));
		const patchFile = join(state, "patch.diff");
		git(repository, ["apply", "--binary", patchFile]);
		const heldoutDir = `${ACCEPTANCE_SUITE_PREFIX}bench-${id.slice(0, 16)}`;

		const heldoutFiles = accepted.suite.files.map((file) => ({
			path: `${heldoutDir}/checks/${file.path}`,
			bytes: readFileSync(join(bundle, "oracle/checks", file.path)),
		}));

		for (const file of heldoutFiles) {
			mkdirSync(dirname(join(repository, file.path)), {
				recursive: true,
				mode: 0o700,
			});
			writeFileSync(join(repository, file.path), file.bytes, { mode: 0o600 });
		}

		git(repository, ["add", "."]);
		git(repository, [
			"commit",
			"-qm",
			"Offline candidate and private validation",
		]);
		const candidateSha = git(repository, ["rev-parse", "HEAD"]);
		activeStage = "validation";
		began = Date.now();
		const heldout = digestOf(JSON.stringify([]));

		const oracleDigestText =
			heldoutFiles.length > 0 ? heldoutDigest(heldoutFiles) : heldout;

		if (!isDigest(oracleDigestText)) throw new Error("invalid_heldout_digest");
		const oracleDigest = oracleDigestText;

		const gateInput: CandidateInput = {
			repository,
			gateSha,
			candidateSha,
			nonce: id.slice(0, 32),
			output: join(state, "gates"),
			runner: runtime.gateRunner ?? dockerRunner,
			replacements: stored.contract.replacesTests ?? [],
			heldoutDir: heldoutFiles.length ? heldoutDir : undefined,
			heldoutDigest: heldoutFiles.length ? oracleDigest : undefined,
		};

		const gate = await checkCandidate(gateInput);
		stages.push({
			name: activeStage,
			wallMs: Date.now() - began,
			outcome: gate.status,
		});

		if (gate.status !== "passed" || !receiptPasses(gate))
			throw new Error(gate.reason ?? "trusted_gates_failed");

		const scenarios = [
			...accepted.suite.scenarios,
			...replacementScenarios(stored.contract),
		];

		const unjudged = scenarios.flatMap((scenario) =>
			scenario.judge === null ? [] : [scenario.id],
		);

		const verdict: Verdict = {
			patchDigest: collected.patchDigest,
			acceptanceDigest: task.acceptanceDigest,
			heldoutDigest: oracleDigest,
			candidateSha,
			gateSha,
			ciRunId: 0,
			originalBase: task.base.sha,
			baseSha: gateSha,
			pass: true,
			checks: gate.checks.map((check) => ({
				name: check.name,
				passed: check.exitCode === 0,
			})),
			requiredChecks: gate.requiredChecks,
			unjudged,
		};

		const reviewPrompt = candidateReviewPrompt({
			contract: stored.contract,
			diff: collected.patch,
			paths: collected.changedPaths,
			judges: scenarios,
			guidance: workflow.guidance.stages.review ?? "",
			verdict,
		});

		if (reviewPrompt.kind !== "ready") throw new Error(reviewPrompt.reason);
		const seats = reviewSeats(collected.changedPaths, gate, unjudged);

		if (!seats.includes(SECOND_JUDGE)) seats.push(SECOND_JUDGE);

		const review: ReviewInput = {
			binding: {
				runId: id,
				round: 0,
				candidateSha,
				patchDigest: collected.patchDigest,
				contractDigest: stored.digest,
				acceptanceDigest: task.acceptanceDigest,
				ciRunId: 0,
				originalBase: task.base.sha,
				baseSha: gateSha,
			},
			files: fileLines(reviewTree),
			scenarios: unjudged,
			seats,
			prompt: `${reviewPrompt.prompt}\n\nOffline bench evidence, NOT GitHub CI. ciRunId=0 means no CI run exists. The local trusted pinned-image gates passed on this candidate.\n${JSON.stringify({ runner: gate.runner, checks: gate.checks, heldoutCounts: gate.heldoutCounts, modelCalls: gate.modelCalls })}`,
		};

		publishFile(
			join(state, "review-input.json"),
			JSON.stringify({ ...review, files: [...review.files] }),
		);
		const builder = build.result.receipt.family ?? FAMILY_MISSING;
		let reviewTokens = 0;

		for (const seat of seats) {
			const model =
				seat === SECOND_JUDGE
					? workflow.config.stages.review.secondJudgeModel
					: seat === "code-review"
						? (workflow.config.stages.review.codeReviewModel ??
							stageModel("review"))
						: stageModel("review");

			if (model === null) throw new Error("second_judge_unconfigured");

			const decorated =
				seat === SECOND_JUDGE
					? seatPrompt(review, seat)
					: await withSkills(bundleDir, seatPrompt(review, seat), [seat]);

			if (decorated === null) throw new Error("review_skills_unavailable");

			const ran = await runModel(
				seat,
				"review",
				model,
				decorated,
				reviewTree,
				REVIEW_TOOLS,
				Math.min(
					REVIEW_MAX_TOKENS - reviewTokens,
					seat === SECOND_JUDGE ? SECOND_JUDGE_MAX_TOKENS : REVIEW_MAX_TOKENS,
				),
			);

			reviewTokens += ran.result.receipt.usage.total;
			const parsed = parseSeat(ran.text, seat, review.files, review.scenarios);

			if (parsed === null) throw new Error("review_malformed");
			const family = parseFamily(ran.result.receipt.family) ?? FAMILY_MISSING;
			judges.push({
				...parsed,
				family,
				requested: ran.result.receipt.fallback?.requested ?? model,
				observed:
					ran.result.receipt.fallback?.observed ??
					ran.result.receipt.models.observed,
				primary: model,
				refusal: ran.result.receipt.refusal,
				fallback: ran.result.receipt.fallback !== null,
				label: familyLabel(family, builder),
				tokens: ran.result.receipt.usage.total,
			});
		}

		outcome = blocksReview(judges)
			? {
					kind: "failed",
					stage: "review",
					reason: "review_blocking_or_unverifiable",
				}
			: { kind: "passed" };
	} catch (error) {
		const reason =
			error instanceof Error ? error.message : "bench_operation_failed";

		outcome = {
			kind: reason === "budget_exhausted" ? "budget_exhausted" : "failed",
			stage: activeStage,
			reason,
		};
	} finally {
		rmSync(workspace, { recursive: true, force: true });
		rmSync(reviewTree, { recursive: true, force: true });
	}

	const settledJournals = await Promise.all(
		journals.map(async (journal) => {
			const stageDir = join(state, "runtime", journal.id);
			const receipt = await readStageReceipt(join(stageDir, "receipt.json"));

			return {
				...journal,
				text: await boundedText(
					join(stageDir, "egress.requests.jsonl"),
					16 * 1024 * 1024,
				),
				receiptTokens: Math.max(
					journal.receiptTokens,
					receipt?.usage.total ?? 0,
				),
			};
		}),
	);

	const ended = Date.now();

	const trial: BenchTrial = {
		version: 1,
		kind: "factory_benchmark_trial",
		id,
		bundleDigest,
		originalRunId: task.runId,
		issue: task.issue,
		variant,
		variantDigest,
		runtime: {
			factoryRevision: revision,
			assetsDigest,
			node: process.version,
			platform: input.platform.name,
			gateRunner: (runtime.gateRunner ?? dockerRunner).kind,
			thinking: "runtime_default:not_historically_recorded",
		},
		tokenCap: input.tokenCap,
		startedAt: new Date(started).toISOString(),
		endedAt: new Date(ended).toISOString(),
		wallMs: ended - started,
		outcome,
		stages,
		judges,
		accounting: trialAccounting(settledJournals),
	};

	const text = `${JSON.stringify(trial, null, 2)}\n`;

	if (
		!publishFile(join(state, "trial.json"), text) ||
		!publishFile(join(state, "trial.sha256"), `${digestOf(text)}\n`)
	)
		throw new Error("trial_publish_failed");

	return text;
}
