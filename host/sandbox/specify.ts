import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, posix } from "node:path";
import type TS from "typescript";
import { LINE_MAX, type SpecifyOutput } from "../../src/contract/contract.ts";
import {
	parseReviewOutput,
	parseSpecifyOutput,
	testDeclarations,
} from "../../src/contract/parse.ts";
import {
	NAMED_FILE_READ_BYTES,
	reviewPrompt,
	revisionPrompt,
} from "../../src/contract/prompt.ts";
import { checkoutOf } from "../controller/checkout.ts";
import {
	type BudgetCap,
	type EfficiencyFacts,
	type SessionOutcome,
	type StageUsage,
	aggregateEfficiency,
	parseEfficiency,
	unknownEfficiency,
} from "../../src/core/execution.ts";
import { fieldOf, objectOf, parseJson, textOf } from "../../src/core/json.ts";
import type {
	Checkout,
	StageLaunchInput,
} from "../../src/controller/launch.ts";
import { PINNED_VERSIONS } from "../bundle/manifest.ts";
import {
	type SPECIFY_SESSIONS,
	MAX_RECEIPT_BYTES,
	OUTPUT_MAX_BYTES,
	boundedText,
	executionSpent,
	executionWindow,
	publishFile,
	readStageReceipt,
	replaceUsage,
} from "./receipts.ts";
import { type StageReceipt, type StageResult, stageResult } from "./result.ts";
import { type StageHost, CRASHED, Ledger, runStage } from "./run-stage.ts";

type TrustedBase = Pick<Checkout, "files" | "readBase">;

export async function sequenceCandidates(
	base: TrustedBase,
	files: readonly string[],
	testFiles: readonly string[],
): Promise<{
	tests: { path: string; test: string }[];
	truncated: boolean;
} | null> {
	if (base.readBase === undefined) return null;

	const ts: typeof TS = createRequire(import.meta.url)("typescript");
	const inventory = new Set(testFiles);
	const targets = new Set(files.filter((path) => !inventory.has(path)));
	const listed = new Set(base.files);
	const cache = new Map<string, TS.SourceFile | null>();

	const source = async (path: string) => {
		if (!cache.has(path)) {
			const text = await base.readBase?.(path, NAMED_FILE_READ_BYTES);

			cache.set(
				path,
				text == null || text instanceof Object
					? null
					: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false),
			);
		}

		return cache.get(path) ?? null;
	};

	const imports = (file: TS.SourceFile): string[] => {
		const paths = new Set<string>();

		const add = (name: string) => {
			if (!name.startsWith(".")) return;

			const path = posix.normalize(
				posix.join(posix.dirname(file.fileName), name),
			);

			const resolved = [
				path,
				path.replace(/\.[cm]?js$/, ".ts"),
				...[".ts", ".tsx", ".js", ".mjs", ".cjs", "/index.ts", "/index.js"].map(
					(suffix) => path + suffix,
				),
			].find((candidate) => listed.has(candidate));

			if (resolved !== undefined) paths.add(resolved);
		};

		const visit = (node: TS.Node): void => {
			if (
				((ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) ||
					(ts.isExportDeclaration(node) && !node.isTypeOnly)) &&
				node.moduleSpecifier !== undefined &&
				ts.isStringLiteral(node.moduleSpecifier)
			)
				add(node.moduleSpecifier.text);

			if (
				ts.isCallExpression(node) &&
				(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
					(ts.isIdentifier(node.expression) &&
						node.expression.text === "require"))
			) {
				const first = node.arguments[0];

				if (first !== undefined && ts.isStringLiteral(first)) add(first.text);
			}

			ts.forEachChild(node, visit);
		};

		visit(file);

		return [...paths];
	};

	const sequenceCue = (body: TS.Node): number => {
		let cue = 3;

		const identifier = (node: TS.Node, pattern: RegExp): boolean =>
			(ts.isIdentifier(node) && pattern.test(node.text)) ||
			ts.forEachChild(
				node,
				(child) => identifier(child, pattern) || undefined,
			) === true;

		const visit = (node: TS.Node): void => {
			if (ts.isStringLiteralLike(node) && /^[a-f\d]{64}$/i.test(node.text))
				cue = 0;

			if (ts.isCallExpression(node)) {
				const callee = node.expression;

				const name = ts.isPropertyAccessExpression(callee)
					? callee.name.text
					: ts.isIdentifier(callee)
						? callee.text
						: "";

				if (
					/snapshot|golden/i.test(name) ||
					(/^(?:equal|strictEqual|deepEqual|deepStrictEqual|toEqual|toBe)$/.test(
						name,
					) &&
						node.arguments.some((arg) => identifier(arg, /snapshot|golden/i)))
				)
					cue = Math.min(cue, 1);

				if (
					/^(?:deepEqual|deepStrictEqual)$/.test(name) &&
					node.arguments.some((arg) =>
						identifier(arg, /^(?:calls|requests|events|logs|lines)$/i),
					)
				)
					cue = Math.min(cue, 2);
			}

			if (cue > 0) ts.forEachChild(node, visit);
		};

		visit(body);

		return cue;
	};

	const candidates: {
		path: string;
		test: string;
		direct: boolean;
		named: boolean;
		cue: number;
		round: number;
	}[] = [];

	for (const path of [...inventory].sort()) {
		if (!listed.has(path)) continue;
		const file = await source(path);

		if (file === null) continue;
		const dependencies = imports(file);
		const direct = dependencies.some((path) => targets.has(path));
		let related = direct;

		if (!related)
			for (const dependency of dependencies) {
				if (inventory.has(dependency)) continue;
				const helper = await source(dependency);

				if (
					helper !== null &&
					imports(helper).some((path) => targets.has(path))
				) {
					related = true;
					break;
				}
			}

		if (!related) continue;
		const titles = new Map<string, { count: number; cue: number }>();

		const visit = (node: TS.Node): void => {
			if (ts.isCallExpression(node)) {
				const callee = ts.isPropertyAccessExpression(node.expression)
					? node.expression.expression
					: node.expression;

				const title = node.arguments[0];

				if (
					ts.isIdentifier(callee) &&
					/^(?:it|test)$/.test(callee.text) &&
					title !== undefined &&
					ts.isStringLiteralLike(title)
				) {
					const previous = titles.get(title.text);

					titles.set(title.text, {
						count: (previous?.count ?? 0) + 1,
						cue: Math.min(
							3,
							...node.arguments
								.slice(1)
								.map((arg) =>
									ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)
										? sequenceCue(arg.body)
										: 3,
								),
						),
					});
				}
			}

			ts.forEachChild(node, visit);
		};

		visit(file);

		const named = [...targets].some((target) =>
			posix
				.basename(path)
				.includes(posix.basename(target, posix.extname(target))),
		);

		const ranked = [...titles]
			.filter(
				([test, facts]) =>
					facts.count === 1 &&
					facts.cue < 3 &&
					test.length <= LINE_MAX &&
					!/[\r\n]/.test(test),
			)
			.sort((a, b) => a[1].cue - b[1].cue);

		for (const [round, [test, facts]] of ranked.entries())
			candidates.push({ path, test, direct, named, cue: facts.cue, round });
	}

	candidates.sort(
		(a, b) =>
			a.round - b.round ||
			Number(b.direct) - Number(a.direct) ||
			Number(b.named) - Number(a.named) ||
			a.cue - b.cue ||
			(a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
	);

	const tests: { path: string; test: string }[] = [];
	let bytes = 0;

	for (const { path, test } of candidates) {
		const size = Buffer.byteLength(`${path} > ${JSON.stringify(test)}\n`);

		if (tests.length === 64 || bytes + size > 8 * 1024)
			return { tests, truncated: true };
		tests.push({ path, test });
		bytes += size;
	}

	return { tests, truncated: false };
}

type KeptSession = {
	readonly outcome: SessionOutcome;
	readonly usage: StageUsage;
	readonly turns: number;
	readonly wallMs: number;
	readonly text: string | null;
	readonly efficiency?: EfficiencyFacts;
};

async function keptSession(dir: string): Promise<KeptSession | null> {
	const parsed = await readStageReceipt(join(dir, "receipt.json"));

	if (parsed === null) return null;

	const file = textOf(
		fieldOf(objectOf(fieldOf(parsed.record, "output")), "file"),
	);

	return {
		outcome: parsed.outcome,
		usage: parsed.usage,
		turns: parsed.turns,
		wallMs: parsed.wallMs,
		efficiency:
			parseEfficiency(fieldOf(parsed.record, "efficiency")) ?? undefined,
		text:
			parsed.outcome.kind === "passed" && file === "output.txt"
				? await boundedText(join(dir, file), OUTPUT_MAX_BYTES)
				: null,
	};
}

/**
 * A parse of specify's text in which every replaced test is one the base
 * checkout declares exactly once, by literal name in its listed file;
 * otherwise malformed, `unknown_test` or `ambiguous_test`.
 */
async function parseDeclared(
	text: string,
	workspace: string,
	files: readonly string[],
	testFiles: readonly string[] | undefined,
	base?: TrustedBase,
): Promise<SpecifyOutput> {
	const parsed = parseSpecifyOutput(text, new Set(files));

	if (parsed.kind !== "contract") return parsed;

	const replacements = parsed.draft.replacesTests ?? [];

	const tests =
		testFiles ??
		files.filter((path) => /^test\/.*\.(?:test|cases)\.[cm]?[jt]s$/.test(path));

	const checkout = checkoutOf(workspace, files);

	for (const replaced of replacements) {
		if (!tests.includes(replaced.path))
			return { kind: "malformed", reason: "bad_field" };

		const source =
			base === undefined
				? await checkout.read(replaced.path, NAMED_FILE_READ_BYTES)
				: await base.readBase?.(replaced.path, NAMED_FILE_READ_BYTES);

		const count =
			source == null || source instanceof Object || !("test" in replaced)
				? 0
				: testDeclarations(source, replaced.test);

		if (count !== 1)
			return {
				kind: "malformed",
				reason: count === 0 ? "unknown_test" : "ambiguous_test",
			};
	}

	return parsed;
}

export async function runSpecify(
	input: StageLaunchInput,
	dir: string,
	createHost: (dir: string, tools: readonly string[]) => StageHost,
	base?: TrustedBase,
): Promise<StageResult> {
	const review = input.specify;

	if (review === undefined) throw new Error("specify inputs missing");

	mkdirSync(dir, { recursive: true, mode: 0o700 });

	if (
		!existsSync(join(dir, "specify.json")) &&
		!publishFile(join(dir, "specify.json"), '{"version":1}\n')
	)
		throw new Error("specify checkpoint unavailable");

	const window = await executionWindow(dir, input);
	const previous = (await executionSpent(dir)) ?? 0;
	const records: KeptSession[] = [];
	let metadata: Pick<StageReceipt, "assetsDigest" | "versions"> | null = null;

	const usage = (): StageUsage => {
		const ledger = new Ledger();
		let gatewayRan = false;

		for (const record of records) {
			ledger.parent += record.usage.parent;
			ledger.children += record.usage.children;
			ledger.gateway += record.usage.gateway ?? 0;
			ledger.unreadChildren += record.usage.unreadChildren;
			ledger.add(new Map(Object.entries(record.usage.byModel)));
			gatewayRan ||= record.usage.gateway !== null;
		}

		return {
			...ledger.usage(gatewayRan),
			total: records.reduce((sum, record) => sum + record.usage.total, 0),
		};
	};

	const turns = () => records.reduce((sum, record) => sum + record.turns, 0);
	const wallMs = () => records.reduce((sum, record) => sum + record.wallMs, 0);

	const session = async (
		name: (typeof SPECIFY_SESSIONS)[number],
		prompt: string,
		tools: readonly string[],
	): Promise<KeptSession> => {
		const sessionDir = join(dir, name);
		const kept = await keptSession(sessionDir);

		if (kept !== null) {
			records.push(kept);

			return kept;
		}

		const used = usage().total;

		const maxTokens =
			input.settings.maxTokens === null
				? null
				: Math.max(0, input.settings.maxTokens - used);

		const remainingRunTokens = Math.max(
			0,
			input.remainingRunTokens - (used - previous),
		);

		const remainingTurns = Math.max(
			0,
			input.settings.budget.maxTurns - turns(),
		);

		const remainingWall = Math.max(
			0,
			Math.min(
				window.deadline - Date.now(),
				input.settings.budget.wallMs - wallMs(),
			),
		);

		const cap: BudgetCap | null =
			maxTokens !== null && maxTokens <= 0
				? "tokens"
				: remainingRunTokens <= 0
					? "run_tokens"
					: remainingTurns <= 0
						? "turns"
						: remainingWall <= 0
							? "wall"
							: null;

		if (cap !== null || existsSync(sessionDir)) {
			const partial = (await executionSpent(sessionDir)) ?? 0;

			const record: KeptSession = {
				outcome: cap === null ? CRASHED : { kind: "budget_exhausted", cap },
				usage: {
					total: partial,
					parent: 0,
					children: 0,
					gateway: partial,
					unreadChildren: 0,
					byModel: {},
				},
				turns: 0,
				wallMs: 0,
				text: null,
			};

			records.push(record);

			return record;
		}

		const host = createHost(sessionDir, tools);
		metadata = host;

		const result = await runStage(
			{
				...input,
				prompt,
				source:
					name === "draft"
						? input.source
						: { bytes: 0, omissions: 0, capHit: false },
				settings: {
					...input.settings,
					fallback: name === "draft" ? input.settings.fallback : null,
					maxTokens,
					budget: {
						...input.settings.budget,
						maxTurns: remainingTurns,
						wallMs: remainingWall,
					},
				},
				remainingRunTokens,
				progress: (value) =>
					input.progress(Math.max(0, used - previous) + value),
			},
			host,
		);

		const record: KeptSession = {
			...result.receipt,
			text:
				result.kind === "passed"
					? await boundedText(join(sessionDir, "output.txt"), OUTPUT_MAX_BYTES)
					: null,
		};

		records.push(record);

		return record;
	};

	const finish = async (
		outcome: SessionOutcome,
		text: string | null,
	): Promise<StageResult> => {
		const last = records.at(-1);

		const raw = objectOf(
			parseJson(
				(await boundedText(
					join(dir, "draft", "receipt.json"),
					MAX_RECEIPT_BYTES,
				)) ?? "",
			),
		);

		const assetsDigest =
			metadata?.assetsDigest ?? textOf(fieldOf(raw, "assetsDigest")) ?? "";

		const versions = objectOf(fieldOf(raw, "versions"));
		const kept = outcome.kind === "passed" && text !== null;
		const bytes = text === null ? 0 : Buffer.byteLength(text);

		const outputWritten =
			!kept ||
			existsSync(join(dir, "output.txt")) ||
			publishFile(join(dir, "output.txt"), text ?? "");

		const receipt: StageReceipt = {
			version: 1,
			runId: input.runId,
			stage: input.stage,
			attempt: input.attempt,
			outcome: outputWritten ? outcome : CRASHED,
			settlement: {
				event: last === undefined ? "none" : "agent_settled",
				aborted: null,
			},
			models: { requested: input.settings.model, observed: null },
			fallback: null,
			refusal: null,
			usage: usage(),
			efficiency: aggregateEfficiency(
				records.map((r) => r.efficiency ?? unknownEfficiency()),
			),
			turns: turns(),
			wallMs: wallMs(),
			egress: null,
			stderr: [],
			output:
				kept && outputWritten
					? { file: "output.txt", bytes, kept: bytes }
					: null,
			assetsDigest,
			versions: metadata?.versions ?? {
				pi: textOf(fieldOf(versions, "pi")) ?? PINNED_VERSIONS.pi,
				piHerdrAgents:
					textOf(fieldOf(versions, "piHerdrAgents")) ??
					PINNED_VERSIONS.piHerdrAgents,
				piHerdrPstack:
					textOf(fieldOf(versions, "piHerdrPstack")) ??
					PINNED_VERSIONS.piHerdrPstack,
			},
			pricing: "unavailable",
		};

		const checkpoint = replaceUsage(join(dir, "usage.json"), {
			...window,
			turns: receipt.turns,
			usage: receipt.usage,
		});

		const written =
			checkpoint &&
			(existsSync(join(dir, "receipt.json")) ||
				publishFile(
					join(dir, "receipt.json"),
					JSON.stringify(receipt, null, "\t"),
				));

		return {
			...stageResult(written ? receipt : { ...receipt, outcome: CRASHED }),
			usage: Math.max(0, receipt.usage.total - previous),
		};
	};

	const draft = await session("draft", input.prompt, input.tools);

	if (draft.outcome.kind !== "passed") return finish(draft.outcome, null);

	const parsed = await parseDeclared(
		draft.text ?? "",
		input.workspace,
		review.files,
		input.testFiles,
		base,
	);

	if (parsed.kind === "malformed")
		return finish({ kind: "failed", exit: "malformed" }, null);

	if (parsed.kind === "questions")
		return finish({ kind: "passed" }, draft.text);

	const candidates =
		base === undefined
			? null
			: await sequenceCandidates(
					base,
					parsed.draft.files,
					input.testFiles ?? [],
				);

	const critique = await session(
		"review",
		reviewPrompt(review, draft.text ?? "", candidates),
		[],
	);

	if (critique.outcome.kind !== "passed") return finish(critique.outcome, null);

	const ambiguities = parseReviewOutput(critique.text ?? "");

	if (ambiguities === null)
		return finish({ kind: "failed", exit: "malformed" }, null);

	if (ambiguities.length === 0) return finish({ kind: "passed" }, draft.text);

	const revision = await session(
		"revision",
		revisionPrompt(review, draft.text ?? "", ambiguities, candidates),
		[],
	);

	if (revision.outcome.kind !== "passed") return finish(revision.outcome, null);

	if (
		(
			await parseDeclared(
				revision.text ?? "",
				input.workspace,
				review.files,
				input.testFiles,
				base,
			)
		).kind === "malformed"
	)
		return finish({ kind: "failed", exit: "malformed" }, null);

	return finish({ kind: "passed" }, revision.text);
}
