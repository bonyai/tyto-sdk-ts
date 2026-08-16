/**
 * Create a sandbox, run a command in it, and clean up.
 *
 *   export BONYA_API_KEY=byk_...
 *   npx tsx examples/quickstart.ts
 */
import { Tyto } from "../src/index.js";

async function main(): Promise<void> {
  const apiKey = process.env["BONYA_API_KEY"];
  const client = new Tyto({ apiKey });

  try {
    const sandbox = await client.createSandbox({ template: "ubuntu-24.04" });
    console.log(`created ${sandbox.name} (${sandbox.id})`);

    try {
      const result = await sandbox.exec(["echo", "hello from tyto"], { check: true });
      process.stdout.write(result.stdout);
    } finally {
      // JavaScript has no context-manager protocol, so cleanup is an explicit
      // finally. Drop it for a sandbox meant to outlive the script.
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
