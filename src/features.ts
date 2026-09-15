import { spawnSync } from "node:child_process";
import { mkdir, readdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { isGitRepository } from "./git.ts";

export type FeatureLane = "planned" | "active" | "done" | "dropped";
export type FeatureLocation = {
	readonly feature: string;
	readonly slug: string;
	readonly lane: FeatureLane;
	readonly month?: string;
	readonly path: string;
	readonly relativePath: string;
};

/** Done-lane month folders use Europe/Warsaw calendar date (operator TZ), not UTC. */
export function warsawYearMonth(date = new Date()): string {
	const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit" }).formatToParts(date);
	const year = parts.find((part) => part.type === "year")?.value;
	const month = parts.find((part) => part.type === "month")?.value;
	if (!year || !month) throw new Error("failed to format Europe/Warsaw year-month");
	return `${year}-${month}`;
}

export function parseFeatureId(raw: string): string {
	const feature = /(?:^|\/)(F\d+)/i.exec(raw.trim())?.[1]?.toUpperCase();
	if (!feature) throw new Error("requires a feature like F012");
	return feature;
}

export function isTerminalLane(lane: FeatureLane): boolean {
	return lane === "done" || lane === "dropped";
}

export async function findFeature(root: string, featureRaw: string): Promise<FeatureLocation | undefined> {
	const feature = parseFeatureId(featureRaw);
	for (const lane of ["planned", "active"] as const) {
		const found = await findDirectChild(`${root}/spec/features/${lane}`, feature, lane);
		if (found) return found;
	}
	for (const lane of ["done", "dropped"] as const) {
		const laneRoot = `${root}/spec/features/${lane}`;
		for (const entry of await readdir(laneRoot, { withFileTypes: true }).catch(() => [])) {
			if (!entry.isDirectory()) continue;
			if (/^\d{4}-\d{2}$/.test(entry.name)) {
				const found = await findDirectChild(`${laneRoot}/${entry.name}`, feature, lane, entry.name);
				if (found) return found;
				continue;
			}
			if (entry.name.toUpperCase().startsWith(`${feature}-`)) {
				return { feature, slug: entry.name, lane, path: `${laneRoot}/${entry.name}`, relativePath: `spec/features/${lane}/${entry.name}` };
			}
		}
	}
}

async function findDirectChild(dir: string, feature: string, lane: FeatureLane, month?: string): Promise<FeatureLocation | undefined> {
	const match = (await readdir(dir, { withFileTypes: true }).catch(() => [])).find((entry) => entry.isDirectory() && entry.name.toUpperCase().startsWith(`${feature}-`));
	if (!match) return;
	const relativePath = month ? `spec/features/${lane}/${month}/${match.name}` : `spec/features/${lane}/${match.name}`;
	return { feature, slug: match.name, lane, ...(month ? { month } : {}), path: `${dir}/${match.name}`, relativePath };
}

export async function moveFeature(root: string, from: FeatureLocation, destRelative: string): Promise<FeatureLocation> {
	if (from.relativePath === destRelative) return from;
	await mkdir(dirname(`${root}/${destRelative}`), { recursive: true });
	if (isGitRepository(root)) {
		const result = spawnSync("git", ["mv", from.relativePath, destRelative], { cwd: root, encoding: "utf8" });
		if (result.status !== 0) await rename(`${root}/${from.relativePath}`, `${root}/${destRelative}`);
	} else await rename(`${root}/${from.relativePath}`, `${root}/${destRelative}`);
	const parts = destRelative.split("/");
	const lane = parts[2] as FeatureLane;
	const month = (lane === "done" || lane === "dropped") && /^\d{4}-\d{2}$/.test(parts[3] ?? "") ? parts[3] : undefined;
	return { feature: from.feature, slug: from.slug, lane, ...(month ? { month } : {}), path: `${root}/${destRelative}`, relativePath: destRelative };
}

export async function closeFeatureToDone(root: string, featureRaw: string): Promise<{ readonly location: FeatureLocation; readonly moved: boolean; readonly message: string }> {
	const feature = parseFeatureId(featureRaw);
	const found = await findFeature(root, feature);
	if (!found) throw new Error(`${feature} not found under spec/features/{planned,active,done,dropped}`);
	if (isTerminalLane(found.lane)) return { location: found, moved: false, message: `already in ${found.relativePath}` };
	const destRelative = `spec/features/done/${warsawYearMonth()}/${found.slug}`;
	return { location: await moveFeature(root, found, destRelative), moved: true, message: `moved ${found.relativePath} → ${destRelative}` };
}

export async function activateFeature(root: string, featureRaw: string): Promise<{ readonly location: FeatureLocation; readonly message: string }> {
	const feature = parseFeatureId(featureRaw);
	const found = await findFeature(root, feature);
	if (!found) throw new Error(`${feature} not found under spec/features/{planned,active,done,dropped}`);
	if (found.lane === "active") throw new Error(`${feature} is already active at ${found.relativePath}`);
	if (found.lane !== "planned") throw new Error(`${feature} is in ${found.lane}/ (${found.relativePath}); activate only moves planned → active`);
	const destRelative = `spec/features/active/${found.slug}`;
	return { location: await moveFeature(root, found, destRelative), message: `activated ${found.relativePath} → ${destRelative}` };
}

/** When a spawn prompt points at planned/…, promote those tickets to active/ and rewrite Ticket paths. */
export async function promotePlannedPathsInTask(root: string, task: string): Promise<{ readonly task: string; readonly promotions: readonly string[] }> {
	const matches = [...task.matchAll(/\bspec\/features\/planned\/(F\d+[A-Za-z0-9._-]*)/g)];
	if (matches.length === 0) return { task, promotions: [] };
	const promotions: string[] = [];
	let next = task;
	const seen = new Set<string>();
	for (const match of matches) {
		const slug = match[1];
		if (!slug || seen.has(slug.toUpperCase())) continue;
		seen.add(slug.toUpperCase());
		const feature = /^(F\d+)/i.exec(slug)?.[1];
		if (!feature) continue;
		const found = await findFeature(root, feature);
		if (!found || found.lane !== "planned") continue;
		promotions.push((await activateFeature(root, feature)).message);
		next = next.split(`spec/features/planned/${found.slug}`).join(`spec/features/active/${found.slug}`);
	}
	return { task: next, promotions };
}
