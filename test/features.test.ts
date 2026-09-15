import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { activateFeature, closeFeatureToDone, findFeature, promotePlannedPathsInTask, warsawYearMonth } from "../src/features.ts";
import { git, limen, onlyJobId, scratchRepo, waitForState } from "./scratch.ts";

test("warsawYearMonth formats Europe/Warsaw calendar month", () => {
	assert.match(warsawYearMonth(new Date("2026-09-15T10:00:00Z")), /^\d{4}-\d{2}$/);
	// Late UTC evening can still be the prior Warsaw calendar day near midnight boundaries;
	assert.equal(warsawYearMonth(new Date("2026-09-15T12:00:00Z")), "2026-09");
});

test("activate moves planned → active and refuses other lanes", async (context) => {
	const scratch = await scratchRepo();
	context.after(scratch.cleanup);
	assert.equal(limen(scratch, "init").status, 0);
	const planned = join(scratch.root, "spec/features/planned/F900-lane-probe");
	await mkdir(planned, { recursive: true });
	await writeFile(join(planned, "ticket.md"), "# F900\n");
	git(scratch.root, "add", "spec/features/planned/F900-lane-probe");
	git(scratch.root, "commit", "-m", "add F900");
	const activated = limen(scratch, "activate", "F900");
	assert.equal(activated.status, 0, activated.stderr);
	assert.match(activated.stdout, /activated spec\/features\/planned\/F900-lane-probe → spec\/features\/active\/F900-lane-probe/);
	await access(join(scratch.root, "spec/features/active/F900-lane-probe/ticket.md"));
	await assert.rejects(access(planned));
	const again = limen(scratch, "activate", "F900");
	assert.equal(again.status, 1);
	assert.match(again.stderr, /already active/);
	const missing = limen(scratch, "activate", "F901");
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /not found/);
});

test("close moves planned or active into done/YYYY-MM and is idempotent", async (context) => {
	const scratch = await scratchRepo();
	context.after(scratch.cleanup);
	assert.equal(limen(scratch, "init").status, 0);
	const planned = join(scratch.root, "spec/features/planned/F902-close-lane");
	await mkdir(planned, { recursive: true });
	await writeFile(join(planned, "ticket.md"), "# F902\n");
	git(scratch.root, "add", ".");
	git(scratch.root, "commit", "-m", "add F902");
	const closed = limen(scratch, "close", "F902");
	assert.equal(closed.status, 0, closed.stderr);
	const month = warsawYearMonth();
	assert.match(closed.stdout, new RegExp(`moved spec/features/planned/F902-close-lane → spec/features/done/${month}/F902-close-lane`));
	await access(join(scratch.root, `spec/features/done/${month}/F902-close-lane/ticket.md`));
	const again = limen(scratch, "close", "F902");
	assert.equal(again.status, 0, again.stderr);
	assert.match(again.stdout, new RegExp(`already in spec/features/done/${month}/F902-close-lane`));
});

test("close moves active features and activate errors on done", async (context) => {
	const scratch = await scratchRepo();
	context.after(scratch.cleanup);
	limen(scratch, "init");
	const active = join(scratch.root, "spec/features/active/F903-from-active");
	await mkdir(active, { recursive: true });
	await writeFile(join(active, "ticket.md"), "# F903\n");
	const closed = limen(scratch, "close", "F903");
	assert.equal(closed.status, 0, closed.stderr);
	assert.match(closed.stdout, /moved spec\/features\/active\/F903-from-active →/);
	const activateDone = limen(scratch, "activate", "F903");
	assert.equal(activateDone.status, 1);
	assert.match(activateDone.stderr, /is in done\//);
});

test("spawn auto-promotes a planned Ticket path to active", async (context) => {
	const scratch = await scratchRepo();
	context.after(scratch.cleanup);
	limen(scratch, "init");
	const planned = join(scratch.root, "spec/features/planned/F904-spawn-promote");
	await mkdir(planned, { recursive: true });
	await writeFile(join(planned, "ticket.md"), "# F904\n");
	git(scratch.root, "add", ".");
	git(scratch.root, "commit", "-m", "add F904");
	const launched = limen(scratch, "spawn", "--detached", "--label", "spawn promote · F904", "Implement F904. Ticket: spec/features/planned/F904-spawn-promote/ticket.md");
	assert.equal(launched.status, 0, launched.stderr);
	assert.match(launched.stdout, /activated spec\/features\/planned\/F904-spawn-promote → spec\/features\/active\/F904-spawn-promote/);
	await access(join(scratch.root, "spec/features/active/F904-spawn-promote/ticket.md"));
	const id = onlyJobId(launched.stdout);
	await waitForState(scratch.root, id, "done");
	const task = await readFile(join(scratch.root, ".limen/jobs", id, "task.md"), "utf8");
	assert.match(task, /spec\/features\/active\/F904-spawn-promote\/ticket\.md/);
	assert.doesNotMatch(task, /spec\/features\/planned\/F904-spawn-promote/);
});

test("findFeature locates done month folders and promotePlannedPathsInTask is a no-op without planned paths", async (context) => {
	const scratch = await scratchRepo();
	context.after(scratch.cleanup);
	limen(scratch, "init");
	const month = "2026-08";
	const done = join(scratch.root, `spec/features/done/${month}/F905-archived`);
	await mkdir(done, { recursive: true });
	await writeFile(join(done, "ticket.md"), "# F905\n");
	const found = await findFeature(scratch.root, "F905");
	assert.equal(found?.lane, "done");
	assert.equal(found?.month, month);
	const promoted = await promotePlannedPathsInTask(scratch.root, "Ticket: spec/features/active/F905-archived/ticket.md");
	assert.equal(promoted.promotions.length, 0);
	assert.equal(promoted.task, "Ticket: spec/features/active/F905-archived/ticket.md");
	const closed = await closeFeatureToDone(scratch.root, "F905");
	assert.equal(closed.moved, false);
	await assert.rejects(activateFeature(scratch.root, "F905"), /is in done\//);
});
