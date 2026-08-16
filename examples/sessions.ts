/**
 * Managed console sessions: terminals that outlive your connection.
 *
 * A session keeps running after you detach, survives the sandbox suspending
 * and resuming, and replays what it produced while nobody was attached. That
 * is the difference from `execStream`, whose process dies when the stream
 * closes.
 *
 *   export BONYA_API_KEY=byk_...
 *   npx tsx examples/sessions.ts
 */
import { Tyto, Exit, SessionEnded, SessionOutputDropped, Stdout } from "../src/index.js";

const decoder = new TextDecoder();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const apiKey = process.env["BONYA_API_KEY"];
  const client = new Tyto({ apiKey });

  try {
    const sandbox = await client.createSandbox({ template: "ubuntu-24.04" });

    try {
      // Session names match ^[a-z][a-z0-9-]{0,31}$ and are the identity you
      // reattach with later.
      const info = await client.createSession(
        sandbox.id,
        "worker",
        ["bash", "-c", "for i in $(seq 1 10); do echo tick $i; sleep 1; done"],
        { cols: 120, rows: 40 },
      );
      console.log(`started ${info.name}: ${info.status}`);

      // Let it produce output with nobody attached, so the attach below has
      // something to replay.
      await sleep(3000);

      const stream = await client.attachSession(sandbox.id, "worker");

      // Available before the first event: they describe the bounded replay
      // buffer, not live output.
      console.log(`replaying ${stream.replayedBytes} bytes`);
      if (stream.historyDropped) {
        console.log("(some older output was dropped)");
      }

      for await (const event of stream) {
        if (event instanceof Stdout) {
          process.stdout.write(decoder.decode(event.data));
        } else if (event instanceof Exit) {
          console.log(`process exited with ${event.exitCode}`);
          break;
        } else if (event instanceof SessionEnded) {
          console.log(`attach ended: ${event.reason}`);
          break;
        } else if (event instanceof SessionOutputDropped) {
          // Reading too slowly. The attach is still live.
          console.log(`[dropped ${event.droppedBytes} bytes]`);
        }
      }

      const list = await client.listSessions(sandbox.id);
      for (const session of list.sessions) {
        console.log(`${session.name}: ${session.status}`);
      }

      await client.killSession(sandbox.id, "worker");
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
