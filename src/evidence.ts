import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const EVIDENCE_ONLY_ROLES = new Set(["reviewer", "advisor", "researcher", "judge", "picture", "quality"]);
const AGENT_NOISE = /^(pi-args\.json|pi-task\.txt|pi-env\.json|claude-args\.json|\.pi\/|\.limen\/|node_modules\/)/;

/** Paths that do not count as product code for the evidence-only gate. */
export function isEvidenceOnlyPath(path: string): boolean {
	const normalized = path.replace(/^\.\//, "").replace(/\\/g, "/");
	if (!normalized || normalized === ".") return true;
	if (AGENT_NOISE.test(normalized)) return true;
	if (/^(docs\/|\.agents\/|\.pi\/|\.limen\/|spec\/features\/|templates\/)/.test(normalized)) return true;
	if (/(^|\/)(README|LICENSE|CHANGELOG|SECURITY|CONTRIBUTING)(\.|$)/i.test(normalized)) return true;
	if (/\.(md|txt|rst)$/i.test(normalized)) return true;
	return false;
}

export function listChangedPaths(worktree: string, base: string): string[] | undefined {
	if (!worktree || !base) return undefined;
	const committed = spawnSync("git", ["-C", worktree, "diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" });
	const dirty = spawnSync("git", ["-C", worktree, "--no-optional-locks", "status", "--porcelain", "-uall"], { encoding: "utf8" });
	if (committed.status !== 0 || dirty.status !== 0) return undefined;
	const paths = new Set<string>();
	for (const line of committed.stdout.trim().split("\n")) if (line.trim()) paths.add(line.trim());
	for (const line of dirty.stdout.trimEnd().split("\n")) {
		if (!line.trim()) continue;
		const path = line.slice(3).trim().split(" -> ").at(-1)?.trim();
		if (path) paths.add(path);
	}
	return [...paths];
}

export function hasMeaningfulCodeDelta(worktree: string, base: string): boolean | undefined {
	const paths = listChangedPaths(worktree, base);
	if (paths === undefined) return undefined;
	if (paths.length === 0) return false;
	return paths.some((path) => !isEvidenceOnlyPath(path));
}

export async function shouldFailEvidenceOnly(jobDir: string): Promise<boolean> {
	const role = (await text(`${jobDir}/role`)) || "worker";
	if (EVIDENCE_ONLY_ROLES.has(role)) return false;
	const [worktree, base] = await Promise.all([text(`${jobDir}/worktree`), text(`${jobDir}/base`)]);
	const meaningful = hasMeaningfulCodeDelta(worktree, base);
	return meaningful === false;
}

export const EVIDENCE_ONLY_REASON = "evidence-only: no code delta";

function text(path: string): Promise<string> {
	return readFile(path, "utf8").then(
		(value) => value.trim(),
		() => "",
	);
}
