/**
 * Stream a command's output as it is produced, instead of buffering it.
 *
 * Use this over `sandbox.exec` when output is large, the command is
 * long-running, or you want to react to output before the process finishes.
 *
 *   export BONYA_API_KEY=byk_...
 *   npx tsx examples/exec-streaming.ts
 */
import { Tyto, Exit, Stderr, Stdout } from "../src/index.js";

const decoder = new TextDecoder();

async function main(): Promise<void> {
  const apiKey = process.env["BONYA_API_KEY"];
  const client = new Tyto({ apiKey });

  try {
    const sandbox = await client.createSandbox({ template: "ubuntu-24.04" });

    try {
      // Events arrive as they happen: one line per second, rather than three
      // lines after three seconds.
      const session = sandbox.execStream(["bash", "-c", "for i in 1 2 3; do echo line $i; sleep 1; done"]);
      for await (const event of session) {
        if (event instanceof Stdout || event instanceof Stderr) {
          process.stdout.write(decoder.decode(event.data));
        } else if (event instanceof Exit) {
          console.log(`exited with ${event.exitCode}`);
        }
      }

      // Streaming stdin: write, then half-close so the process sees EOF.
      const piped = sandbox.execStream(["cat"]);
      await piped.write(new TextEncoder().encode("piped through cat\n"));
      await piped.closeStdin();
      for await (const event of piped) {
        if (event instanceof Stdout) {
          process.stdout.write(decoder.decode(event.data));
        }
      }
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
