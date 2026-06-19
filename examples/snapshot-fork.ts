/**
 * Demonstrates snapshots: create, list, fork, restore, and delete.
 */
import { Tyto } from "../src/index.js";

const tyto = new Tyto({ apiKey: process.env["TYTO_API_KEY"] });

const nest = await tyto.nests.create({ name: "snapshot-demo", template: "ubuntu-24-dev" });
console.log(`Nest ${nest.id} is ${nest.status}`);

// Create a snapshot
console.log("Creating snapshot…");
const snap = await nest.snapshots.create({
  name: "my-snapshot",
  description: "Before refactoring",
  stop_if_running: false,
});
console.log(`Snapshot ${snap.id} state: ${snap.state}`);

// List snapshots
const { snapshots } = await nest.snapshots.list();
console.log(`Snapshots: ${snapshots?.length ?? 0}`);

// Fork the nest into a new one
console.log("Forking nest…");
const fork = await nest.fork({
  name: "snapshot-demo-fork",
  stop_if_running: false,
  restart_source: true,
});
console.log(`Forked → ${fork.id} (${fork.status})`);

// Restore a stopped nest from the snapshot (requires nest to be stopped)
// await nest.stop();
// const restored = await nest.restore(snap.id!);
// console.log(`Restored from ${restored.restored_from}: ${restored.status}`);

// Delete the snapshot (dry run first)
if (snap.id) {
  const dryRun = await tyto.snapshots.delete(snap.id, { dry_run: true });
  console.log(
    `Would free ${dryRun.would_free_bytes ?? 0} bytes, can_delete=${dryRun.can_delete}`,
  );

  if (dryRun.can_delete) {
    const result = await tyto.snapshots.delete(snap.id);
    console.log(`Deleted: ${result.deleted}`);
  }
}

await nest.stop();
await nest.delete();
console.log("Done");
