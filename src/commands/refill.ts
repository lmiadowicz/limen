import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { extractFeatureId, findFeatureTipConflict } from "../feature-tip.ts";
import { activateFeature, findFeature } from "../features.ts";
import { limenRoot } from "../git.ts";
import { packageBin } from "../paths.ts";
import { readKeepers, readTarget } from "../project-config.ts";
import { liveJob } from "../reap.ts";
import { textFile } from "../wrapper.ts";

const LIMEN = packageBin();

/** Spawn or continue keeper tips until live F-id count reaches TARGET. Aiffer can call this instead of shell scripts. */
export async function refillCommand(args: readonly string[], cwd: string): Promise<void> {
	let detached = false;
	let tab = false;
	let force = false;
	let dryRun = false;
	for (const arg of args) {
		if (arg === "--detached") detached = true;
		else if (arg === "--tab") tab = true;
		else if (arg === "--force") force = true;
		else if (arg === "--dry-run") dryRun = true;
		else throw new Error(`unknown refill option ${arg}\nusage: limen refill [--detached|--tab] [--force] [--dry-run]`);
	}
	if (tab && detached) throw new Error("--tab and --detached cannot be combined");
	const root = limenRoot(cwd);
	const target = (await readTarget(root)) ?? 1;
	const keepers = await readKeepers(root);
	if (!keepers.features.length) throw new Error("keepers unset; run limen keepers set F007,F012 first");

	const running = await listRunningFeatures(root);
	let slots = Math.max(0, target - running.size);
	console.log(`refill TARGET ${target} · live ${running.size} · free ${slots}`);
	if (slots === 0) {
		console.log("at TARGET; nothing to spawn");
		return;
	}

	const mode = tab ? (["--tab"] as const) : detached || !process.env.HERDR_ENV ? (["--detached"] as const) : ([] as const);
	for (const feature of keepers.features) {
		if (slots <= 0) break;
		if (running.has(feature)) {
			console.log(`skip ${feature}: already live as ${running.get(feature)}`);
			continue;
		}
		const conflict = await findFeatureTipConflict(root, feature, { force });
		if (conflict?.kind === "job") {
			console.log(`skip ${feature}: job ${conflict.jobId}`);
			continue;
		}
		// Open PR for this F-id: continue/spawn onto that tip branch (same tip). A different
		// new tip is still refused later by spawn's guard unless --force / matching --branch.
		const tipBranch = conflict?.kind === "pr" ? conflict.branch : undefined;
		if (conflict?.kind === "pr") console.log(`same-tip ${feature}: open PR ${conflict.url} on ${conflict.branch}`);
		let found = await findFeature(root, feature);
		if (!found) {
			console.log(`skip ${feature}: no ticket under spec/features`);
			continue;
		}
		if (found.lane === "planned") {
			if (dryRun) console.log(`would activate ${feature}`);
			else {
				console.log((await activateFeature(root, feature)).message);
				found = (await findFeature(root, feature)) ?? found;
			}
		}
		if (found.lane !== "active" && !(dryRun && found.lane === "planned")) {
			console.log(`skip ${feature}: in ${found.lane}/`);
			continue;
		}
		const ticketPath = `spec/features/active/${found.slug}/ticket.md`;
		const finished = await latestFinishedJob(root, feature);
		const canContinue = finished !== undefined && (await hasSession(finished.jobDir));
		const argv = canContinue
			? ["continue", finished.id, `Continue ${feature}: land the next code slice. Ticket: ${ticketPath}`, ...mode, ...(force ? ["--force"] : []), "--label", `${feature} continue`]
			: [
					"spawn",
					...mode,
					...(force ? ["--force"] : []),
					...(tipBranch ? ["--branch", tipBranch] : []),
					"--label",
					`${feature} tip`,
					`Implement ${feature}: land the next code slice. Ticket: ${ticketPath}`,
				];
		if (dryRun) {
			console.log(`would limen ${argv.join(" ")}`);
			slots -= 1;
			running.set(feature, "dry-run");
			continue;
		}
		const result = runLimen(cwd, argv);
		const output = (result.stdout.trim() || result.stderr.trim()).trim();
		if (output) console.log(output);
		if (result.status !== 0) throw new Error(result.stderr.trim() || `${argv[0]} ${feature} failed`);
		slots -= 1;
		running.set(feature, "started");
	}
}

async function listRunningFeatures(root: string): Promise<Map<string, string>> {
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

async function latestFinishedJob(root: string, feature: string): Promise<{ id: string; jobDir: string } | undefined> {
	const jobsRoot = `${root}/.limen/jobs`;
	const matches: Array<{ id: string; jobDir: string; started: string }> = [];
	for (const entry of await readdir(jobsRoot, { withFileTypes: true }).catch(() => [])) {
		if (!entry.isDirectory()) continue;
		const jobDir = `${jobsRoot}/${entry.name}`;
		const state = await textFile(`${jobDir}/state`);
		if (!["done", "failed", "stopped"].includes(state)) continue;
		const owned = extractFeatureId(await textFile(`${jobDir}/label`), await textFile(`${jobDir}/task.md`));
		if (owned !== feature) continue;
		matches.push({ id: entry.name, jobDir, started: await textFile(`${jobDir}/started-at`) });
	}
	matches.sort((a, b) => b.started.localeCompare(a.started));
	return matches[0];
}

async function hasSession(jobDir: string): Promise<boolean> {
	const names = await readdir(`${jobDir}/session`).catch(() => []);
	return names.some((name) => name.endsWith(".jsonl"));
}

function runLimen(cwd: string, args: readonly string[]): { stdout: string; stderr: string; status: number } {
	const result = spawnSync(process.execPath, [LIMEN, ...args], { cwd, encoding: "utf8", env: process.env });
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}
