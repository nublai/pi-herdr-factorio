import ts from "typescript";
import { globSync, lstatSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { trustedTestGlobsOf } from "../../src/candidate/review.ts";
import {
	arrayOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
	textsOf,
	type JsonObject,
	type JsonValue,
} from "../../src/core/json.ts";

export const CHECK_NAMES = [
	"typecheck",
	"lint",
	"format",
	"layout",
	"decisions",
];

export const SOURCE = [
	"src",
	"extension",
	"host",
	"skills",
	"scripts",
	".pi/skills",
	"docs/models",
];

const REQUIRED_CHECKS = ["typecheck", "lint", "format"];

const RESERVED_CHECKS = [
	"install",
	"baseline_tests",
	"main_tests",
	"candidate_tests",
	"heldout",
];

const LEGACY_TEST_GLOB =
	/^test\/(?:(?:src|host)\/\*\*\/\*\.test\.ts|integration\/\*\.test\.ts)$/;

type FileOption = "config" | "biome" | "ignore" | "refuse";

type ToolFileOptions = Readonly<
	Record<string, Readonly<Record<string, FileOption>>>
>;

// CLI sources and refusal rationale: docs/operations/factory-cli.md#tool-file-options.
const FILE_OPTIONS = {
	oxlint: {
		"-c": "config",
		"--config": "config",
		"--tsconfig": "config",
		"--ignore-path": "ignore",
	},
	eslint: {
		"-c": "config",
		"--config": "config",
		"--ignore-path": "ignore",
		"--suppressions-location": "ignore",
		"--parser": "refuse",
		"--parser-options": "refuse",
		"--plugin": "refuse",
		"--rulesdir": "refuse",
		"--resolve-plugins-relative-to": "refuse",
		"-f": "refuse",
		"--format": "refuse",
		"--stdin-filename": "refuse",
		"--cache": "refuse",
		"--cache-file": "refuse",
		"--cache-location": "refuse",
	},
	prettier: {
		"--config": "config",
		"--ignore-path": "ignore",
		"--plugin": "refuse",
		"--plugin-search-dir": "refuse",
		"--find-config-path": "refuse",
		"--stdin-filepath": "refuse",
		"--cache": "refuse",
		"--cache-location": "refuse",
	},
	biome: {
		"--config-path": "biome",
		"--vcs-root": "refuse",
		"--stdin-file-path": "refuse",
		"--use-server": "refuse",
	},
	tsc: {
		"-p": "config",
		"--project": "config",
		"-b": "refuse",
		"--build": "refuse",
		"-i": "refuse",
		"--incremental": "refuse",
		"--composite": "refuse",
		"--tsbuildinfofile": "refuse",
	},
	node: {
		"--require": "refuse",
		"--import": "refuse",
		"--loader": "refuse",
		"--experimental-loader": "refuse",
		"--eval": "refuse",
		"--print": "refuse",
		"--env-file": "refuse",
		"--env-file-if-exists": "refuse",
		"--experimental-config-file": "refuse",
		"--experimental-default-config-file": "refuse",
		"--config-file": "refuse",
		"--test-reporter": "refuse",
		"--test-reporter-destination": "refuse",
		"--test-global-setup": "refuse",
		"--test-rerun-failures": "refuse",
		"--bench-reporter": "refuse",
		"--conditions": "refuse",
		"--snapshot-blob": "refuse",
		"--build-snapshot": "refuse",
		"--build-snapshot-config": "refuse",
		"--experimental-sea-config": "refuse",
		"--build-sea": "refuse",
		"--experimental-policy": "refuse",
		"--policy-integrity": "refuse",
		"--experimental-package-map": "refuse",
		"--vfs-load": "refuse",
		"--openssl-config": "refuse",
		"--icu-data-dir": "refuse",
		"--localstorage-file": "refuse",
		"--run": "refuse",
		"--entry-url": "refuse",
		"--prof-process": "refuse",
	},
} satisfies ToolFileOptions;

function toolFileOptions(tool: string): Readonly<Record<string, FileOption>> {
	return (
		Object.entries(FILE_OPTIONS).find(([name]) => name === tool)?.[1] ?? {}
	);
}

function nodeCodeFlag(arg: string): boolean {
	const flag = arg.split("=", 1)[0]?.replaceAll("_", "-") ?? "";

	return (
		/^-[reC]/.test(arg) ||
		/^(?:--env-file|--inspect|--debug-port)/.test(flag) ||
		toolFileOptions("node")[flag] === "refuse"
	);
}

const CONFIG_NAME =
	/^(?:[jt]sconfig.*\.jsonc?|\.oxlintrc(?:\..+)?|oxlint\.config\..+|\.eslintrc(?:\..+)?|eslint\.config\..+|\.prettierrc(?:\..+)?|prettier\.config\..+|\.?biome\.jsonc?)$/;

const CHECK_PROGRAMS = new Set([
	"/g/tooling/node_modules/.bin/oxlint",
	"/g/tooling/node_modules/.bin/biome",
	"/g/tooling/node_modules/.bin/eslint",
	"/g/tooling/node_modules/.bin/prettier",
	"/g/tooling/node_modules/.bin/tsc",
	"/g/tooling/node_modules/typescript/bin/tsc",
]);

const NODE_RELAYS = new Set([
	"/g/tooling/node_modules/.bin/tsx",
	"/g/tooling/node_modules/tsx/dist/cli.mjs",
]);

const NO_CHECK_FLAGS = ["--version", "-v", "-V", "--help", "-h"];

const NODE_FLAGS = ["--experimental-strip-types", "--no-warnings"];

export type Dependency = {
	readonly path: string;
	readonly version: string;
	readonly resolved: string;
	readonly integrity: string;
	readonly installScript: boolean;
};

type GatePolicy = {
	readonly version: 1 | 2;
	readonly sourceRoots: readonly string[];
	readonly testGlobs: readonly string[];
	readonly checks: readonly { name: string; argv: readonly string[] }[];
};

function specs(value: JsonObject | null): void {
	if (value === null) throw new Error("invalid_dependency_manifest");

	for (const group of [
		"dependencies",
		"devDependencies",
		"optionalDependencies",
		"peerDependencies",
	]) {
		const item = fieldOf(value, group);

		if (item === undefined) continue;
		const deps = objectOf(item);

		if (deps === null) throw new Error("invalid_dependency_manifest");

		for (const [name, version] of Object.entries(deps)) {
			const raw = textOf(version) ?? "";
			const alias = /^npm:((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(.+)$/i.exec(raw);
			const spec = alias?.[2] ?? raw;

			if (
				!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) ||
				!/^[a-z0-9*^~<>=| .+-]+$/i.test(spec) ||
				!spec ||
				/^(?:git|file|workspace|https?|npm):/i.test(spec)
			)
				throw new Error("invalid_dependency_spec");
		}
	}
}

export function validateDependencies(
	manifestText: string,
	lockText: string,
	trustedLockText?: string,
): readonly Dependency[] {
	const manifest = objectOf(parseJson(manifestText));
	const lock = objectOf(parseJson(lockText));
	const packages = objectOf(fieldOf(lock, "packages"));
	specs(manifest);

	if (
		fieldOf(lock, "lockfileVersion") !== 3 ||
		packages === null ||
		Object.keys(packages).length > 2000
	)
		throw new Error("invalid_dependency_lock");
	specs(objectOf(fieldOf(packages, "")));
	const result: Dependency[] = [];
	const aliasNames = new Map<string, string>();

	const trustedPackages = trustedLockText
		? objectOf(fieldOf(objectOf(parseJson(trustedLockText)), "packages"))
		: null;

	for (const [owner, item] of Object.entries(packages)) {
		const value = objectOf(item);

		for (const group of [
			"dependencies",
			"devDependencies",
			"optionalDependencies",
			"peerDependencies",
		]) {
			const deps = objectOf(fieldOf(value, group));

			for (const [name, raw] of Object.entries(deps ?? {})) {
				const match = /^npm:((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(.+)$/i.exec(
					textOf(raw) ?? "",
				);

				if (!match?.[1]) continue;
				const trustedParent = objectOf(fieldOf(trustedPackages, owner));

				if (
					owner &&
					trustedParent !== null &&
					["version", "resolved", "integrity"].every(
						(key) => fieldOf(value, key) === fieldOf(trustedParent, key),
					) &&
					fieldOf(objectOf(fieldOf(trustedParent, group)), name) !== raw
				)
					throw new Error("package_swap");
				let parent = owner;

				for (;;) {
					const path = parent
						? `${parent}/node_modules/${name}`
						: `node_modules/${name}`;

					if (fieldOf(packages, path) !== undefined) {
						aliasNames.set(path, match[1]);
						break;
					}

					if (!parent) break;
					parent =
						parent.split("/node_modules/")[0] === parent
							? ""
							: parent.slice(0, parent.lastIndexOf("/node_modules/"));
				}
			}
		}
	}

	for (const [path, item] of Object.entries(packages)) {
		if (!path) continue;
		const value = objectOf(item);
		const resolved = textOf(fieldOf(value, "resolved")) ?? "";
		const version = textOf(fieldOf(value, "version")) ?? "";
		const integrity = textOf(fieldOf(value, "integrity")) ?? "";
		let url: URL;

		try {
			url = new URL(resolved);
		} catch {
			throw new Error("invalid_dependency_url");
		}

		if (
			!/^(?:node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+\/)*node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(
				path,
			) ||
			url.protocol !== "https:" ||
			url.hostname !== "registry.npmjs.org" ||
			url.port ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			!url.pathname.endsWith(".tgz") ||
			!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity) ||
			!version ||
			fieldOf(value, "link") === true
		)
			throw new Error("invalid_dependency_lock");

		const pathName = path.split("node_modules/").at(-1) ?? "";
		const name = aliasNames.get(path) ?? pathName;

		if (
			(aliasNames.has(path) || fieldOf(value, "name") !== undefined) &&
			fieldOf(value, "name") !== name
		)
			throw new Error("package_swap");

		if (
			!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) ||
			url.pathname !== `/${name}/-/${name.split("/").at(-1)}-${version}.tgz`
		)
			throw new Error("package_swap");
		specs(value);
		result.push({
			path,
			version,
			resolved,
			integrity,
			installScript: fieldOf(value, "hasInstallScript") === true,
		});
	}

	return result;
}

export function readDependencies(tree: string) {
	return validateDependencies(
		readFileSync(join(tree, "package.json"), "utf8"),
		readFileSync(join(tree, "package-lock.json"), "utf8"),
	);
}

function sourceRootsOf(
	value: JsonValue | undefined,
	tree: string,
): readonly string[] {
	const roots = textsOf(value);

	if (
		roots === null ||
		roots.length === 0 ||
		roots.length > 32 ||
		roots.some(
			(root) =>
				root.length >= 512 ||
				(root !== ".pi/skills" &&
					!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)*$/.test(
						root,
					)) ||
				/^test(?:\/|$)/.test(root) ||
				root.split("/").includes("node_modules") ||
				roots.some((other) => other !== root && root.startsWith(`${other}/`)) ||
				lstatSync(join(tree, root), {
					throwIfNoEntry: false,
				})?.isDirectory() !== true,
		) ||
		new Set(roots).size !== roots.length
	)
		throw new Error("invalid_gate_manifest");

	return roots;
}

function pathPieces(arg: string): readonly string[] {
	return arg.split(/[=,]/).flatMap((piece) => {
		if (!/^file:/i.test(piece)) return piece.split(":");

		try {
			return [fileURLToPath(piece)];
		} catch {
			return [piece.slice("file:".length)];
		}
	});
}

function candidatePath(arg: string, roots: readonly string[]): boolean {
	return pathPieces(arg).some((piece) => {
		const path = posix.normalize(piece);

		if (!path.startsWith("/w/")) return false;
		const inTree = path.slice("/w/".length);

		return ["test", ...roots].some(
			(root) => inTree === root || inTree.startsWith(`${root}/`),
		);
	});
}

function fileArgument(argv: readonly string[], index: number) {
	const scriptAt =
		argv[0] === "node"
			? argv.findIndex((arg, i) => i > 0 && !arg.startsWith("-"))
			: 0;

	const script = argv[scriptAt] ?? "";

	const program = NODE_RELAYS.has(script)
		? argv.slice(scriptAt + 1).find((arg) => !arg.startsWith("-"))
		: script;

	const tool = posix.basename(program ?? "");

	const options = toolFileOptions(tool);

	const arg =
		tool === "tsc" ? (argv[index] ?? "").toLowerCase() : (argv[index] ?? "");

	const flag = arg.split("=", 1)[0] ?? "";
	const kind = options[flag];

	if (kind !== undefined)
		return {
			kind,
			separate: !argv[index]?.includes("="),
			value: argv[index]?.includes("=")
				? (argv[index]?.slice(flag.length + 1) ?? "")
				: (argv[index + 1] ?? ""),
		};

	const short = Object.keys(options).find(
		(key) => /^-[a-z]$/.test(key) && arg.startsWith(key),
	);

	return short === undefined
		? undefined
		: {
				kind: options[short],
				separate: false,
				value: argv[index]?.slice(2) ?? "",
			};
}

function configArgument(
	argv: readonly string[],
	index: number,
): string | undefined {
	return fileArgument(argv, index)?.value;
}

function checkToolConfigs(tree: string, policy: GatePolicy): void {
	const pending: { path: string; plugin: boolean; kind?: FileOption }[] = [];
	const seen = new Set<string>();
	const explicit = new Set<string>();
	const opaque = new Set<string>();

	const tools = policy.checks.flatMap(({ argv }) =>
		argv
			.filter((arg) => arg.startsWith("/g/tooling/"))
			.map((arg) => posix.basename(arg)),
	);

	for (const { argv } of policy.checks)
		for (const index of argv.keys()) {
			const file = fileArgument(argv, index);

			if (file !== undefined) {
				if (file.kind === "refuse" || !file.value || file.value.startsWith("-"))
					throw new Error("invalid_gate_manifest");

				if (file.kind === "ignore" && file.value === "/dev/null") continue;

				const normalized = posix.normalize(
					file.value.startsWith("/") ? file.value : `/w/${file.value}`,
				);

				pending.push({ path: normalized, plugin: false, kind: file.kind });

				if (file.kind === "ignore") opaque.add(normalized);
				explicit.add(normalized.replace(/^\/g\/tooling\//, "/w/"));
			}
		}

	for (const { argv } of policy.checks)
		for (const arg of argv)
			for (const piece of pathPieces(arg)) {
				if (piece.startsWith("-") || !/\.jsonc?$/.test(piece)) continue;

				const path = posix.normalize(
					piece.startsWith("/") ? piece : `/w/${piece}`,
				);

				const relative = path.replace(/^\/(?:w|g\/tooling)\//, "");

				if (opaque.has(path)) continue;

				if (
					lstatSync(join(tree, relative), { throwIfNoEntry: false })?.isFile()
				)
					pending.push({ path, plugin: false });
			}

	for (const path of globSync("**/*", {
		cwd: tree,
		exclude: ["node_modules/**", ".git/**"],
	}))
		if (
			CONFIG_NAME.test(posix.basename(path)) &&
			tools.some((tool) =>
				tool === "tsc"
					? /^[jt]sconfig/.test(posix.basename(path))
					: posix.basename(path).includes(tool.replace(/^\./, "")),
			) &&
			!path.startsWith(".github/") &&
			!explicit.has(`/w/${path}`) &&
			lstatSync(join(tree, path)).isFile()
		)
			pending.push({ path: `/w/${path}`, plugin: false });

	for (const path of globSync("**/package.json", {
		cwd: tree,
		exclude: ["node_modules/**", ".git/**"],
	})) {
		const value = objectOf(parseJson(readFileSync(join(tree, path), "utf8")));

		if (
			["prettier", "eslintConfig", "oxlint"].some(
				(key) =>
					fieldOf(value, key) !== undefined &&
					tools.some((tool) => key.toLowerCase().startsWith(tool)),
			)
		)
			pending.push({ path: `/w/${path}`, plugin: false });
	}

	const enqueue = (
		owner: string,
		reference: string,
		project = false,
		plugin = false,
	) => {
		const ref = /^file:/i.test(reference)
			? fileURLToPath(reference)
			: reference;

		if (
			!ref ||
			ref.includes("\\") ||
			ref.includes("\0") ||
			(ref.includes(":") && !ref.startsWith("node:"))
		)
			throw new Error("invalid_gate_manifest");
		const frozen = owner.startsWith("/g/tooling/");

		if (!ref.startsWith(".") && !ref.startsWith("/") && !project) {
			if (frozen && plugin) return;
			throw new Error("invalid_gate_manifest");
		}

		pending.push({
			path: posix.normalize(
				ref.startsWith("/") ? ref : posix.join(posix.dirname(owner), ref),
			),
			plugin,
		});
	};

	while (pending.length > 0) {
		const next = pending.pop();

		if (next === undefined) continue;
		const { path: requested, plugin, kind } = next;
		const key = `${kind}:${plugin}:${requested}`;

		if (seen.has(key)) continue;
		seen.add(key);

		const frozen = requested.startsWith("/g/tooling/");

		const relative = requested.slice(
			frozen ? "/g/tooling/".length : "/w/".length,
		);

		if (
			(!frozen && !requested.startsWith("/w/")) ||
			(!frozen && relative.endsWith(".md")) ||
			(!frozen &&
				["test", ...policy.sourceRoots].some(
					(root) => relative === root || relative.startsWith(`${root}/`),
				)) ||
			relative
				.split("/")
				.some((p) => p === ".." || p === ".git" || p === "node_modules")
		)
			throw new Error("invalid_gate_manifest");

		const path = (
			kind === "ignore"
				? [relative]
				: kind === "biome"
					? [
							relative,
							posix.join(relative, "biome.json"),
							posix.join(relative, "biome.jsonc"),
						]
					: [
							relative,
							`${relative}.json`,
							posix.join(relative, "tsconfig.json"),
						]
		).find((p) =>
			lstatSync(join(tree, p), { throwIfNoEntry: false })?.isFile(),
		);

		if (path === undefined) throw new Error("invalid_gate_manifest");

		if (kind === "ignore") continue;
		const text = readFileSync(join(tree, path), "utf8");

		if (/\.[cm]?[jt]s$/.test(path)) {
			if (!frozen) throw new Error("invalid_gate_manifest");

			const source = ts.createSourceFile(
				path,
				text,
				ts.ScriptTarget.Latest,
				true,
			);

			const visit = (node: ts.Node) => {
				if (
					!plugin &&
					(ts.isCallExpression(node) ||
						ts.isNewExpression(node) ||
						ts.isPropertyAccessExpression(node) ||
						ts.isElementAccessExpression(node) ||
						ts.isFunctionLike(node) ||
						ts.isComputedPropertyName(node) ||
						ts.isTemplateExpression(node) ||
						ts.isTaggedTemplateExpression(node))
				)
					throw new Error("invalid_gate_manifest");

				if (
					ts.isStringLiteralLike(node) &&
					/^\/w(?:\/|$)/.test(posix.normalize(node.text))
				)
					throw new Error("invalid_gate_manifest");

				if (
					(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
					node.moduleSpecifier
				) {
					if (!ts.isStringLiteral(node.moduleSpecifier))
						throw new Error("invalid_gate_manifest");
					enqueue(
						`/g/tooling/${path}`,
						node.moduleSpecifier.text,
						false,
						plugin,
					);
				}

				if (
					ts.isCallExpression(node) &&
					(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
						(ts.isIdentifier(node.expression) &&
							node.expression.text === "require"))
				) {
					const ref = node.arguments[0];

					if (!ref || !ts.isStringLiteral(ref))
						throw new Error("invalid_gate_manifest");
					enqueue(`/g/tooling/${path}`, ref.text, false, plugin);
				}

				if (ts.isPropertyAssignment(node)) {
					const key = node.name
						.getText(source)
						.replaceAll('"', "")
						.replaceAll("'", "");

					if (
						key === "specifier" ||
						(!plugin &&
							[
								"extends",
								"plugins",
								"parser",
								"project",
								"projectService",
							].includes(key))
					) {
						const refs = ts.isArrayLiteralExpression(node.initializer)
							? node.initializer.elements
							: [node.initializer];

						for (const ref of refs) {
							if (
								!ts.isStringLiteral(ref) ||
								(key === "plugins" && !ref.text.startsWith("/g/tooling/"))
							)
								throw new Error("invalid_gate_manifest");
							enqueue(
								`/g/tooling/${path}`,
								ref.text,
								false,
								key === "specifier" || key === "plugins",
							);
						}
					}
				}

				ts.forEachChild(node, visit);
			};

			visit(source);
			continue;
		}

		const parsed = ts.parseConfigFileTextToJson(path, text);
		const value = objectOf(parseJson(JSON.stringify(parsed.config) ?? "null"));

		if (parsed.error || value === null)
			throw new Error("invalid_gate_manifest");

		const configurations = [value];

		for (const config of configurations) {
			for (const key of [
				"eslintConfig",
				"oxlint",
				"prettier",
				"parserOptions",
			]) {
				const nested = objectOf(fieldOf(config, key));

				if (nested !== null) configurations.push(nested);
			}

			for (const raw of arrayOf(fieldOf(config, "overrides")) ?? []) {
				const nested = objectOf(raw);

				if (nested === null) throw new Error("invalid_gate_manifest");
				configurations.push(nested);
			}

			for (const key of [
				"extends",
				"plugins",
				"jsPlugins",
				"parser",
				"project",
				"projectService",
			]) {
				const raw = fieldOf(config, key);

				if (raw === undefined) continue;
				const single = textOf(raw);
				const refs = single === null ? arrayOf(raw) : [single];

				if (refs === null) throw new Error("invalid_gate_manifest");

				for (const ref of refs) {
					const target =
						textOf(ref) ?? textOf(fieldOf(objectOf(ref), "specifier"));

					if (
						target === null ||
						(key === "plugins" && !target.startsWith("/g/tooling/"))
					)
						throw new Error("invalid_gate_manifest");
					enqueue(
						`${frozen ? "/g/tooling/" : "/w/"}${path}`,
						target,
						key === "project",
						key === "jsPlugins" || key === "plugins",
					);
				}
			}

			if (path.endsWith("package.json")) {
				const prettier = textOf(fieldOf(config, "prettier"));

				if (prettier !== null)
					enqueue(`${frozen ? "/g/tooling/" : "/w/"}${path}`, prettier);
			}
		}

		const references = fieldOf(value, "references");

		if (references !== undefined) {
			const refs = arrayOf(references);

			if (refs === null) throw new Error("invalid_gate_manifest");

			for (const ref of refs) {
				const target = textOf(fieldOf(objectOf(ref), "path"));

				if (target === null) throw new Error("invalid_gate_manifest");
				enqueue(`${frozen ? "/g/tooling/" : "/w/"}${path}`, target, true);
			}
		}
	}
}

function supportedProgram(script: string, args: readonly string[]): boolean {
	if (!NODE_RELAYS.has(script)) return CHECK_PROGRAMS.has(script);
	const at = args.findIndex((arg) => !arg.startsWith("-"));

	return (
		args.slice(0, at).every((flag) => NODE_FLAGS.includes(flag)) &&
		CHECK_PROGRAMS.has(args[at] ?? "")
	);
}

function runsTooling(
	argv: readonly string[],
	roots: readonly string[],
): boolean {
	const [program, ...rest] = argv;
	const at = program === "node" ? rest.findIndex((a) => !a.startsWith("-")) : 0;
	const script = program === "node" ? rest[at] : program;
	const nodeFlags = program === "node" ? rest.slice(0, at) : [];

	return (
		script !== undefined &&
		script.startsWith("/g/tooling/") &&
		nodeFlags.every((flag) => NODE_FLAGS.includes(flag)) &&
		supportedProgram(script, program === "node" ? rest.slice(at + 1) : rest) &&
		argv.every(
			(arg, index) =>
				!nodeCodeFlag(arg) &&
				!arg.startsWith("@") &&
				!NO_CHECK_FLAGS.includes(arg) &&
				!arg.split(/[/=,:]/).includes("..") &&
				!candidatePath(arg, roots) &&
				!candidatePath(`/w/${configArgument(argv, index) ?? ""}`, roots) &&
				!pathPieces(arg).some((piece) => {
					if (
						piece.startsWith("-") ||
						piece.startsWith("/") ||
						/[*?[\]]/.test(piece)
					)
						return false;
					const path = posix.normalize(piece);

					return ["test", ...roots].some(
						(root) =>
							path.startsWith(`${root}/`) ||
							(path === root &&
								(fileArgument(argv, index - 1)?.separate === true ||
									fileArgument(argv, index) !== undefined)),
					);
				}),
		)
	);
}

function policyCheck(
	name: string,
	argv: readonly string[],
	roots: readonly string[],
): boolean {
	return (
		/^[a-z][a-z0-9_]{0,63}$/.test(name) &&
		!RESERVED_CHECKS.includes(name) &&
		!name.endsWith("_deadline_control") &&
		runsTooling(argv, roots)
	);
}

export function gatePolicyOf(tree: string): GatePolicy {
	let text: string;

	try {
		text = readFileSync(join(tree, ".github/factory/gates/gates.json"), "utf8");
	} catch {
		throw new Error("invalid_gate_manifest");
	}

	const value = objectOf(parseJson(text));

	const version = fieldOf(value, "version");
	const rawChecks = arrayOf(fieldOf(value, "checks"));
	const testGlobs = trustedTestGlobsOf(fieldOf(value, "testGlobs"));

	if (
		(version !== 1 && version !== 2) ||
		(version === 2 &&
			Object.keys(value ?? {}).some(
				(key) =>
					![
						"version",
						"checks",
						"testGlobs",
						"sourceRoots",
						"toolingRevision",
					].includes(key),
			)) ||
		rawChecks === null ||
		testGlobs === null ||
		(version === 1 && testGlobs.some((p) => !LEGACY_TEST_GLOB.test(p))) ||
		(version === 1 && fieldOf(value, "sourceRoots") !== undefined)
	)
		throw new Error("invalid_gate_manifest");

	const sourceRoots =
		version === 1 ? SOURCE : sourceRootsOf(fieldOf(value, "sourceRoots"), tree);

	const checks = rawChecks.map((item) => {
		const obj = objectOf(item);
		const name = textOf(fieldOf(obj, "name")) ?? "";
		const argv = textsOf(fieldOf(obj, "argv"));

		if (
			argv === null ||
			argv.length === 0 ||
			argv.some((a) => a.includes("\0")) ||
			(version === 1
				? !CHECK_NAMES.includes(name)
				: !policyCheck(name, argv, sourceRoots))
		)
			throw new Error("invalid_gate_manifest");

		return { name, argv };
	});

	const names = new Set(checks.map((c) => c.name));

	if (
		names.size !== checks.length ||
		(version === 1
			? checks.length !== CHECK_NAMES.length
			: checks.length > 12 || REQUIRED_CHECKS.some((name) => !names.has(name)))
	)
		throw new Error("missing_checks");

	const policy: GatePolicy = { version, checks, sourceRoots, testGlobs };

	if (version === 2) {
		try {
			checkToolConfigs(tree, policy);
		} catch {
			throw new Error("invalid_gate_manifest");
		}
	}

	return policy;
}

export function manifestOf(tree: string) {
	const policy = gatePolicyOf(tree);

	const tests = policy.testGlobs
		.flatMap((pattern) => {
			const files = globSync(pattern, {
				cwd: tree,
				exclude: ["test/acceptance/**", "test/fixtures/**"],
			});

			if (files.length === 0) throw new Error("missing_tests");

			return files;
		})
		.sort();

	if (new Set(tests).size !== tests.length) throw new Error("duplicate_tests");

	return { ...policy, tests };
}
