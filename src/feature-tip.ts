import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { liveJob } from "./reap.ts";

const FEATURE_RE = /\b(F\d{3,})\b/i;
const TICKET_RE = /spec\/features\/(?:planned|active|done|dropped)(?:\/\d{4}-\d{2})?\/(F\d{3,})/i;

/** Extract the first FNNN from label, prompt, or ticket path text. */
export function extractFeatureId(...parts: readonly string[]): string | undefined {
	for (const part of parts) {
		const fromTicket = TICKET_RE.exec(part)?.[1];
		if (fromTicket) return fromTicket.toUpperCase();
		const fromToken = FEATURE_RE.exec(part)?.[1];
		if (fromToken) return fromToken.toUpperCase();
	}
}

export type FeatureTipConflict =
	| { readonly kind: "job"; readonly feature: string; readonly jobId: string; readonly label: string }
	| { readonly kind: "pr"; readonly feature: string; readonly url: string; readonly title: string; readonly branch: string };

export type FeatureTipOptions = {
	readonly force?: boolean;
	readonly excludeJobId?: string;
	/** When set, an open PR whose head equals this branch is the same tip — not a conflict. */
	readonly branch?: string;
	/**
	 * Continue / reuse path: caller is attaching to an existing job worktree for this F-id
	 * (e.g. `limen continue`, or spawn reusing that tip's worktree). Open PRs for the F-id
	 * are allowed; live jobs still conflict unless excluded.
	 */
	readonly existingWorktree?: boolean;
};

export function formatFeatureTipConflict(conflict: FeatureTipConflict): string {
	if (conflict.kind === "job") {
		return `feature ${conflict.feature} already has a live tip: job ${conflict.jobId} (${conflict.label || "unlabeled"}). Pass --force to override.`;
	}
	return `feature ${conflict.feature} already has an open PR: ${conflict.url} (${conflict.title || conflict.branch}). Pass --force to override.`;
}

/** True when an open-PR tip conflict should be waived for same-tip continue / reuse. */
export function allowsOpenPrForSameTip(prBranch: string, options: { readonly branch?: string; readonly existingWorktree?: boolean } = {}): boolean {
	if (options.existingWorktree) return true;
	const requested = options.branch?.trim();
	if (!requested) return false;
	return requested === prBranch;
}

export async function findFeatureTipConflict(root: string, feature: string, options: FeatureTipOptions = {}): Promise<FeatureTipConflict | undefined> {
	if (options.force) return;
	const needle = feature.toUpperCase();
	const jobsRoot = `${root}/.limen/jobs`;
	for (const entry of await readdir(jobsRoot, { withFileTypes: true }).catch(() => [])) {
		if (!entry.isDirectory() || entry.name === options.excludeJobId) continue;
		const jobDir = `${jobsRoot}/${entry.name}`;
		if (!(await liveJob(jobDir))) continue;
		const [label, task] = await Promise.all([text(`${jobDir}/label`), text(`${jobDir}/task.md`)]);
		const owned = extractFeatureId(label, task);
		if (owned === needle) return { kind: "job", feature: needle, jobId: entry.name, label: label || entry.name };
	}
	for (const pr of listOpenPullRequests(root)) {
		const haystack = `${pr.branch} ${pr.title} ${pr.label}`;
		if (extractFeatureId(haystack) === needle || new RegExp(`\\b${needle}\\b`, "i").test(haystack)) {
			if (allowsOpenPrForSameTip(pr.branch, options)) continue;
			return { kind: "pr", feature: needle, url: pr.url, title: pr.title, branch: pr.branch };
		}
	}
}

export async function assertFeatureTipAvailable(root: string, feature: string | undefined, options: FeatureTipOptions = {}): Promise<void> {
	if (!feature) return;
	const conflict = await findFeatureTipConflict(root, feature, options);
	if (conflict) throw new Error(formatFeatureTipConflict(conflict));
}

type OpenPr = { readonly number: number; readonly url: string; readonly title: string; readonly branch: string; readonly label: string };

export function listOpenPullRequests(cwd: string): readonly OpenPr[] {
	const result = spawnSync("gh", ["pr", "list", "--state", "open", "--limit", "100", "--json", "number,url,title,headRefName,labels"], {
		cwd,
		encoding: "utf8",
		timeout: 15_000,
	});
	if (result.status !== 0 || !result.stdout.trim()) return [];
	try {
		const rows = JSON.parse(result.stdout) as Array<{
			number: number;
			url: string;
			title: string;
			headRefName: string;
			labels?: Array<{ name: string }>;
		}>;
		return rows.map((row) => ({
			number: row.number,
			url: row.url,
			title: row.title ?? "",
			branch: row.headRefName ?? "",
			label: (row.labels ?? []).map((entry) => entry.name).join(" "),
		}));
	} catch {
		return [];
	}
}

function text(path: string): Promise<string> {
	return readFile(path, "utf8").then(
		(value) => value,
		() => "",
	);
}
