import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { EVIDENCE_ONLY_REASON, isEvidenceOnlyPath } from "../src/evidence.ts";
import { allowsOpenPrForSameTip, extractFeatureId } from "../src/feature-tip.ts";
import { resolveJobId } from "../src/job.ts";
import { parseKeepersList } from "../src/project-config.ts";
import { finalizeJob } from "../src/wrapper.ts";
import { git, limen, limenWithEnv, onlyJobId, scratchRepo, waitForState, writeFakePi } from "./scratch.ts";

test("extractFeatureId reads label, prompt, and ticket paths", () => {
	assert.equal(extractFeatureId("auth handler · F012"), "F012");
	assert.equal(extractFeatureId("Implement F007: slice", "Ticket: spec/features/active/F007-auth/ticket.md"), "F007");
	assert.equal(extractFeatureId("no feature here"), undefined);
});

test("allowsOpenPrForSameTip waives matching branch, existing worktree, not a different tip", () => {
	assert.equal(allowsOpenPrForSameTip("limen/keeper-f007", { branch: "limen/keeper-f007" }), true);
	assert.equal(allowsOpenPrForSameTip("limen/keeper-f007", { branch: "limen/other-tip" }), false);
	assert.equal(allowsOpenPrForSameTip("limen/keeper-f007", {}), false);
	assert.equal(allowsOpenPrForSameTip("limen/keeper-f007", { existingWorktree: true }), true);
	assert.equal(allowsOpenPrForSameTip("limen/keeper-f007", { branch: "limen/other", existingWorktree: true }), true);
});

test("evidence-only paths classify docs and tickets", () => {
	assert.equal(isEvidenceOnlyPath("docs/note.md"), true);
	assert.equal(isEvidenceOnlyPath("src/main.ts"), false);
	assert.equal(isEvidenceOnlyPath("spec/features/active/F001-x/outcome.md"), true);
});

test("keepers parsing accepts F-ids and issue refs", () => {
	const keepers = parseKeepersList("F007,#225,F012,#222");
	assert.deepEqual(keepers.features, ["F007", "F012"]);
	assert.deepEqual(keepers.issues, ["#225", "#222"]);
	assert.throws(() => parseKeepersList("nope"), /must look like/);
});

test("resolveJobId prefers a single running match", () => {
	const ids = ["2026-09-15-f001-a-aaaa", "2026-09-15-f001-b-bbbb"];
	const labels = {
		"2026-09-15-f001-a-aaaa": "F001 tip",
		"2026-09-15-f001-b-bbbb": "F001 tip",
	};
	assert.equal(
		resolveJobId("F001", ids, labels, {
			mode: "prefer-running",
			states: { "2026-09-15-f001-a-aaaa": "done", "2026-09-15-f001-b-bbbb": "running" },
		}),
		"2026-09-15-f001-b-bbbb",
	);
	assert.throws(
		() =>
			resolveJobId("F001", ids, labels, {
				mode: "prefer-running",
				states: { "2026-09-15-f001-a-aaaa": "done", "2026-09-15-f001-b-bbbb": "done" },
			}),
		/none running; pass the full job id/,
	);
	assert.equal(
		resolveJobId("F001", ids, labels, {
			mode: "prefer-finished",
			states: { "2026-09-15-f001-a-aaaa": "done", "2026-09-15-f001-b-bbbb": "running" },
		}),
		"2026-09-15-f001-a-aaaa",
	);
});

test("target and keepers commands persist under .limen", async (context) => {
	const scratch = await scratchRepo();
	context.after(scratch.cleanup);
	assert.equal(limen(scratch, "init").status, 0);
	assert.equal(limen(scratch, "target", "2").status, 0);
	const got = limen(scratch, "target");
	assert.equal(got.status, 0, got.stderr);
	assert.match(got.stdout, /TARGET 2/);
	assert.equal(await readFile(join(scratch.root, ".limen/target"), "utf8"), "2\n");
	const set = limen(scratch, "keepers", "set", "F007,#225,F012");
	assert.equal(set.status, 0, set.stderr);
	assert.match(set.stdout, /keepers F007,#225,F012/);
	const listed = limen(scratch, "keepers");
	assert.equal(listed.status, 0);
	assert.match(listed.stdout, /F007,#225,F012/);
});

test("board summarizes feature lanes", async (context) => {
	const scratch = await scratchRepo();
	context.after(scratch.cleanup);
	limen(scratch, "init");
	await mkdir(join(scratch.root, "spec/features/planned/F910-board"), { recursive: true });
	await writeFile(join(scratch.root, "spec/features/planned/F910-board/ticket.md"), "# F910\n");
	await mkdir(join(scratch.root, "spec/features/active/F911-board"), { recursive: true });
	await writeFile(join(scratch.root, "spec/features/active/F911-board/ticket.md"), "# F911\n");
	const board = limen(scratch, "board");
	assert.equal(board.status, 0, board.stderr);
	assert.match(board.stdout, /planned 1/);
	assert.match(board.stdout, /active 1/);
	assert.match(board.stdout, /F910/);
	assert.match(board.stdout, /F911/);
});

test("spawn refuses a second live tip for the same F-id unless --force", async (context) => {
	const scratch = await scratchRepo();
	context.after(scratch.cleanup);
	limen(scratch, "init");
	await mkdir(join(scratch.root, "spec/features/active/F920-tip"), { recursive: true });
	await writeFile(join(scratch.root, "spec/features/active/F920-tip/ticket.md"), "# F920\n");
	git(scratch.root, "add", ".");
	git(scratch.root, "commit", "-m", "ticket");
	await writeFakePi(
		scratch.fakeBin,
		`#!/usr/bin/env node
setInterval(() => {}, 1000);
`,
	);
	const first = limenWithEnv(
		scratch,
		{ LIMEN_HANDSHAKE_MS: "5000" },
		"spawn",
		"--detached",
		"--label",
		"first · F920",
		"Implement F920. Ticket: spec/features/active/F920-tip/ticket.md",
	);
	assert.equal(first.status, 0, first.stderr);
	const id = onlyJobId(first.stdout);
	const second = limen(scratch, "spawn", "--detached", "--label", "second · F920", "Implement F920 again. Ticket: spec/features/active/F920-tip/ticket.md");
	assert.equal(second.status, 1);
	assert.match(second.stderr, /already has a live tip/);
	assert.match(second.stderr, new RegExp(id));
	const forced = limen(scratch, "spawn", "--detached", "--force", "--label", "forced · F920", "Implement F920 forced. Ticket: spec/features/active/F920-tip/ticket.md");
	assert.equal(forced.status, 0, forced.stderr);
	limen(scratch, "stop", id, "test cleanup");
	limen(scratch, "stop", onlyJobId(forced.stdout), "test cleanup");
});

test("spawn allows --branch equal to open PR head for same F-id; refuses a different tip branch", async (context) => {
	const scratch = await scratchRepo();
	context.after(scratch.cleanup);
	limen(scratch, "init");
	await mkdir(join(scratch.root, "spec/features/active/F921-pr"), { recursive: true });
	await writeFile(join(scratch.root, "spec/features/active/F921-pr/ticket.md"), "# F921\n");
	git(scratch.root, "checkout", "-b", "limen/keeper-f921");
	git(scratch.root, "add", ".");
	git(scratch.root, "commit", "-m", "F921 ticket");
	git(scratch.root, "checkout", "main");
	await writeFakePi(
		scratch.fakeBin,
		`#!/usr/bin/env node
setInterval(() => {}, 1000);
`,
	);
	const marker = join(scratch.root, "gh-called.txt");
	await writeFile(
		join(scratch.fakeBin, "gh"),
		[
			"#!/usr/bin/env node",
			'const { writeFileSync } = require("node:fs");',
			`writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(" "));`,
			"const args = process.argv.slice(2);",
			'if (args[0] === "pr" && args[1] === "list") {',
			'  process.stdout.write(JSON.stringify([{ number: 225, url: "https://github.com/example/repo/pull/225", title: "F921 keeper tip", headRefName: "limen/keeper-f921", labels: [{ name: "F921" }] }]));',
			"  process.exit(0);",
			"}",
			"process.exit(1);",
			"",
		].join("\n"),
	);
	await chmod(join(scratch.fakeBin, "gh"), 0o755);

	const blocked = limen(scratch, "spawn", "--detached", "--label", "new tip · F921", "Implement F921 on a fresh tip. Ticket: spec/features/active/F921-pr/ticket.md");
	assert.equal(blocked.status, 1, `blocked=${blocked.status} out=${blocked.stdout} err=${blocked.stderr} gh=${await readFile(marker, "utf8").catch(() => "missing")}`);
	assert.match(blocked.stderr, /already has an open PR/);

	const same = limenWithEnv(
		scratch,
		{ LIMEN_HANDSHAKE_MS: "5000" },
		"spawn",
		"--detached",
		"--branch",
		"limen/keeper-f921",
		"--label",
		"continue tip · F921",
		"Implement F921 on the keeper branch. Ticket: spec/features/active/F921-pr/ticket.md",
	);
	assert.equal(same.status, 0, same.stderr);
	const sameId = onlyJobId(same.stdout);
	limen(scratch, "stop", sameId, "test cleanup");

	const other = limen(
		scratch,
		"spawn",
		"--detached",
		"--branch",
		"limen/other-f921",
		"--label",
		"other tip · F921",
		"Implement F921 on a different branch. Ticket: spec/features/active/F921-pr/ticket.md",
	);
	assert.equal(other.status, 1, other.stdout + other.stderr);
	assert.match(other.stderr, /already has an open PR/);
});

test("evidence-only success finalizes as failed", async (context) => {
	const scratch = await scratchRepo();
	context.after(scratch.cleanup);
	limen(scratch, "init");
	const launched = limen(scratch, "spawn", "--detached", "--label", "docs only · F930", "Implement F930 without code");
	assert.equal(launched.status, 0, launched.stderr);
	const id = onlyJobId(launched.stdout);
	await waitForState(scratch.root, id, "failed");
	const state = await readFile(join(scratch.root, ".limen/jobs", id, "state"), "utf8");
	assert.equal(state.trim(), "failed");
	const log = await readFile(join(scratch.root, ".limen/jobs", id, "log"), "utf8");
	assert.match(log, new RegExp(EVIDENCE_ONLY_REASON));
});

test("finalizeJob flips done to failed when worktree has no code delta", async (context) => {
	const scratch = await scratchRepo();
	context.after(scratch.cleanup);
	const jobDir = join(scratch.root, ".limen/jobs/manual-empty");
	await mkdir(jobDir, { recursive: true });
	const base = git(scratch.root, "rev-parse", "HEAD");
	await writeFile(join(jobDir, "state"), "running\n");
	await writeFile(join(jobDir, "role"), "worker\n");
	await writeFile(join(jobDir, "worktree"), `${scratch.root}\n`);
	await writeFile(join(jobDir, "base"), `${base}\n`);
	await writeFile(join(jobDir, "branch"), "main\n");
	await writeFile(join(jobDir, "log"), "");
	await finalizeJob(jobDir, "done", "pi exited 0");
	assert.equal((await readFile(join(jobDir, "state"), "utf8")).trim(), "failed");
	assert.match(await readFile(join(jobDir, "log"), "utf8"), new RegExp(EVIDENCE_ONLY_REASON));
});

test("refill dry-run reports spawn plans from keepers", async (context) => {
	const scratch = await scratchRepo();
	context.after(scratch.cleanup);
	limen(scratch, "init");
	await mkdir(join(scratch.root, "spec/features/planned/F940-refill"), { recursive: true });
	await writeFile(join(scratch.root, "spec/features/planned/F940-refill/ticket.md"), "# F940\n");
	git(scratch.root, "add", ".");
	git(scratch.root, "commit", "-m", "F940");
	assert.equal(limen(scratch, "target", "1").status, 0);
	assert.equal(limen(scratch, "keepers", "set", "F940").status, 0);
	const dry = limen(scratch, "refill", "--detached", "--dry-run");
	assert.equal(dry.status, 0, dry.stderr);
	assert.match(dry.stdout, /would activate F940|would limen spawn/);
});

test("dist build entry is loadable", async () => {
	const { access } = await import("node:fs/promises");
	await access(join(new URL("..", import.meta.url).pathname, "dist/src/main.js"));
});
