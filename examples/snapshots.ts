/**
 * Capture a running sandbox's state as a snapshot.
 *
 *   export BONYA_API_KEY=byk_...
 *   npx tsx examples/snapshots.ts
 */
import { Tyto } from "../src/index.js";

async function main(): Promise<void> {
  const apiKey = process.env["BONYA_API_KEY"];
  const client = new Tyto({ apiKey });

  try {
    const sandbox = await client.createSandbox({
      template: "ubuntu-24.04",
      name: "snapshot-source",
    });

    try {
      await sandbox.files.write("/workspace/state.txt", "captured\n");

      // Snapshot create requires a running source. Suspended, failed, and
      // deleted sandboxes each reject with their own error rather than a
      // generic one.
      //
      // Passing an idempotencyKey makes a retry return the same snapshot
      // instead of minting a second one.
      const snapshot = await client.createSnapshot(sandbox.id, { idempotencyKey: "example-snapshot-1" });
      console.log(`snapshot ${snapshot.id} from ${snapshot.sourceSandboxId}`);

      // Snapshot identities outlive their source sandbox, so deleting the
      // snapshot is a separate decision from deleting what it came from.
      await snapshot.delete();
      await snapshot.delete(); // idempotent: a local no-op the second time
    } finally {
      await sandbox.delete();
    }
  } finally {
    client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
