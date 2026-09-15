import { readdir } from "node:fs/promises";
import { extractFeatureId, listOpenPullRequests } from "../feature-tip.ts";
import { activateFeature, type FeatureLane, type FeatureLocation, findFeature, moveFeature } from "../features.ts";
import { limenRoot } from "../git.ts";
import { readKeepers } from "../project-config.ts";
import { liveJob } from "../reap.ts";
import { textFile } from "../wrapper.ts";

export async function boardCommand(args: readonly string[], cwd: string): Promise<void> {
	await reconcileBoard(args, cwd);
}

export async function reconcileCommand(args: readonly string[], cwd: string): Promise<void> {
	await reconcileBoard(args, cwd);
}

async function reconcileBoard(args: readonly string[], cwd: string): Promise<void> {
	let apply = false;
	let applyStale = false;
	for (const arg of args) {
		if (arg === "--apply") apply = true;
		else if (arg === "--apply-stale-to-planned") applyStale = true;
		else throw new Error(`unknown board option ${arg}\nusage: limen board|reconcile [--apply] [--apply-stale-to-planned]`);
	}
	const root = limenRoot(cwd);
	const features = await listFeatureFolders(root);
	const running = await runningFeatureJobs(root);
	const openPrs = listOpenPullRequests(root);
	const keepers = await readKeepers(root);

	const byLane: Record<FeatureLane, FeatureLocation[]> = { planned: [], active: [], done: [], dropped: [] };
	for (const feature of features) byLane[feature.lane].push(feature);

	console.log("board reconcile");
	console.log(`planned ${byLane.planned.length} · active ${byLane.active.length} · done ${byLane.done.length} · dropped ${byLane.dropped.length}`);
	for (const lane of ["planned", "active", "done"] as const) {
		if (!byLane[lane].length) continue;
		console.log(`${lane}: ${byLane[lane].map((entry) => entry.feature).join(", ")}`);
	}
	if (keepers.raw.length) console.log(`keepers: ${keepers.raw.join(",")}`);
	if (running.size) console.log(`running tips: ${[...running.entries()].map(([feature, id]) => `${feature}→${id}`).join(", ")}`);

	const stale = byLane.active.filter((entry) => {
		if (running.has(entry.feature)) return false;
		return !openPrs.some((pr) => extractFeatureId(pr.branch, pr.title, pr.label) === entry.feature);
	});
	if (stale.length) console.log(`stale active (no live job, no open PR): ${stale.map((entry) => entry.feature).join(", ")}`);

	if (apply) {
		for (const feature of keepers.features) {
			if (!running.has(feature)) continue;
			const found = await findFeature(root, feature);
			if (found?.lane === "planned") console.log((await activateFeature(root, feature)).message);
		}
	}
	if (applyStale) {
		for (const entry of stale) {
			const dest = `spec/features/planned/${entry.slug}`;
			await moveFeature(root, entry, dest);
			console.log(`moved ${entry.relativePath} → ${dest}`);
		}
	} else if (stale.length) {
		console.log("hint: pass --apply-stale-to-planned to move stale active tickets back to planned (never automatic)");
	}
	if (!apply && keepers.features.some((feature) => running.has(feature))) {
		console.log("hint: pass --apply to activate planned keepers that already have a live tip");
	}
}

async function listFeatureFolders(root: string): Promise<FeatureLocation[]> {
	const out: FeatureLocation[] = [];
	for (const lane of ["planned", "active"] as const) {
		for (const entry of await readdir(`${root}/spec/features/${lane}`, { withFileTypes: true }).catch(() => [])) {
			if (!entry.isDirectory()) continue;
			const feature = extractFeatureId(entry.name);
			if (!feature) continue;
			out.push({
				feature,
				slug: entry.name,
				lane,
				path: `${root}/spec/features/${lane}/${entry.name}`,
				relativePath: `spec/features/${lane}/${entry.name}`,
			});
		}
	}
	for (const lane of ["done", "dropped"] as const) {
		const laneRoot = `${root}/spec/features/${lane}`;
		for (const monthEntry of await readdir(laneRoot, { withFileTypes: true }).catch(() => [])) {
			if (!monthEntry.isDirectory()) continue;
			if (/^\d{4}-\d{2}$/.test(monthEntry.name)) {
				for (const entry of await readdir(`${laneRoot}/${monthEntry.name}`, { withFileTypes: true }).catch(() => [])) {
					if (!entry.isDirectory()) continue;
					const feature = extractFeatureId(entry.name);
					if (!feature) continue;
					const relativePath = `spec/features/${lane}/${monthEntry.name}/${entry.name}`;
					out.push({
						feature,
						slug: entry.name,
						lane,
						month: monthEntry.name,
						path: `${root}/${relativePath}`,
						relativePath,
					});
				}
				continue;
			}
			const feature = extractFeatureId(monthEntry.name);
			if (!feature) continue;
			out.push({
				feature,
				slug: monthEntry.name,
				lane,
				path: `${laneRoot}/${monthEntry.name}`,
				relativePath: `spec/features/${lane}/${monthEntry.name}`,
			});
		}
	}
	return out;
}

async function runningFeatureJobs(root: string): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	const jobsRoot = `${root}/.limen/jobs`;
	for (const entry of await readdir(jobsRoot, { withFileTypes: true }).catch(() => [])) {
		if (!entry.isDirectory()) continue;
		const jobDir = `${jobsRoot}/${entry.name}`;
		if (!(await liveJob(jobDir))) continue;
		const feature = extractFeatureId(await textFile(`${jobDir}/label`), await textFile(`${jobDir}/task.md`));
		if (feature) map.set(feature, entry.name);
	}
	return map;
}
