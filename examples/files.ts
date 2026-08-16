/**
 * Read and write files inside a sandbox.
 *
 *   export BONYA_API_KEY=byk_...
 *   npx tsx examples/files.ts
 */
import { Tyto, FileKind } from "../src/index.js";

async function main(): Promise<void> {
  const apiKey = process.env["BONYA_API_KEY"];
  const client = new Tyto({ apiKey });

  try {
    const sandbox = await client.createSandbox({ template: "ubuntu-24.04" });

    try {
      const files = sandbox.files;

      await files.write("/workspace/greeting.txt", "hello\n");
      const data = await files.read("/workspace/greeting.txt");
      process.stdout.write(new TextDecoder().decode(data));

      await files.mkdir("/workspace/output");
      await files.move("/workspace/greeting.txt", "/workspace/output/greeting.txt");

      for (const entry of await files.list("/workspace/output")) {
        const kind = entry.kind === FileKind.DIRECTORY ? "dir " : "file";
        console.log(`${kind} ${entry.name} (${entry.size} bytes)`);
      }

      const info = await files.stat("/workspace/output/greeting.txt");
      console.log(`mode ${(info.mode & 0o7777).toString(8).padStart(4, "0")}, modified ${info.modifiedAt}`);

      // upload and download stream in chunks, so file size is bounded by disk
      // rather than memory. read buffers, capped by filesystemReadLimit.
      await files.upload("package.json", "/workspace/output/package.json");
      await files.download("/workspace/output/package.json", "/tmp/roundtrip.json");

      await files.remove("/workspace/output", true);
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
