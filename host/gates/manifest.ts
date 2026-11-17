import { globSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
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

const NODE_CODE_FLAG =
	/^--(?:import|require|loader|experimental-loader|eval|print)(?:=|$)/;

const NO_CHECK_FLAGS = ["--version", "-v", "--help", "-h"];

export type Dependency = {
	readonly path: string;
	readonly version: string;
	readonly resolved: string;
	readonly integrity: string;
	readonly installScript: boolean;
};

type GatePolicy = {
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

function sourceRootsOf(value: JsonValue | undefined): readonly string[] {
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
				roots.some((other) => other !== root && root.startsWith(`${other}/`)),
		) ||
		new Set(roots).size !== roots.length
	)
		throw new Error("invalid_gate_manifest");

	return roots;
}

function candidatePath(arg: string, roots: readonly string[]): boolean {
	return arg.split(/[=,:]/).some((part) => {
		if (!part.startsWith("/w/")) return false;
		const path = posix.normalize(part.slice(3)).replace(/^\/+/, "");

		return ["test", ...roots].some(
			(root) => path === root || path.startsWith(`${root}/`),
		);
	});
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
		nodeFlags.every((flag) => flag.startsWith("--")) &&
		argv.every(
			(arg) =>
				!NODE_CODE_FLAG.test(arg) &&
				!NO_CHECK_FLAGS.includes(arg) &&
				!arg.split(/[/=,:]/).includes("..") &&
				!candidatePath(arg, roots),
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
	const value = objectOf(
		parseJson(
			readFileSync(join(tree, ".github/factory/gates/gates.json"), "utf8"),
		),
	);

	const version = fieldOf(value, "version");
	const rawChecks = arrayOf(fieldOf(value, "checks"));
	const testGlobs = trustedTestGlobsOf(fieldOf(value, "testGlobs"));

	if (
		(version !== 1 && version !== 2) ||
		rawChecks === null ||
		testGlobs === null ||
		(version === 1 && testGlobs.some((p) => !LEGACY_TEST_GLOB.test(p))) ||
		(version === 1 && fieldOf(value, "sourceRoots") !== undefined)
	)
		throw new Error("invalid_gate_manifest");

	const sourceRoots =
		version === 1 ? SOURCE : sourceRootsOf(fieldOf(value, "sourceRoots"));

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

	return { checks, sourceRoots, testGlobs };
}

export function sourceRootsIn(tree: string): readonly string[] {
	return gatePolicyOf(tree).sourceRoots;
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
