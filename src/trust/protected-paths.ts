export const CONTROL_PLANE_DIR = ".github";
export const CONTROL_PLANE_PREFIX = `${CONTROL_PLANE_DIR}/`;
export const ACCEPTANCE_SUITE_DIR = "test/acceptance";
export const ACCEPTANCE_SUITE_PREFIX = `${ACCEPTANCE_SUITE_DIR}/`;

export const COORDINATOR_ONLY_FILES = [
	"docs/decisions.tsv",
	"scripts/decisions-checkpoint.json",
] as const;

export const FEEDBACK_FILE = ".factory-feedback.json";
export const FEEDBACK_FULL_FILE = ".factory-feedback-full.json";

export function isAtOrUnder(path: string, dir: string): boolean {
	return path === dir || path.startsWith(`${dir}/`);
}
