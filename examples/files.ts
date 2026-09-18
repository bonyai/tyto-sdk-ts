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
    const sandbox = await client.createSandbox({ template: "bonya-dev" });

    try {
      await sandbox.writeFile("/workspace/greeting.txt", "hello\n");
      const data = await sandbox.readFile("/workspace/greeting.txt");
      process.stdout.write(new TextDecoder().decode(data));

      await sandbox.mkdirFile("/workspace/output");
      await sandbox.moveFile("/workspace/greeting.txt", "/workspace/output/greeting.txt");

      for (const entry of await sandbox.listFiles("/workspace/output")) {
        const kind = entry.kind === FileKind.DIRECTORY ? "dir " : "file";
        console.log(`${kind} ${entry.name} (${entry.size} bytes)`);
      }

      const info = await sandbox.statFile("/workspace/output/greeting.txt");
      console.log(`mode ${(info.mode & 0o7777).toString(8).padStart(4, "0")}, modified ${info.modifiedAt}`);

      // uploadFile and downloadFile stream in chunks, so file size is bounded
      // by disk rather than memory. readFile buffers, capped by filesystemReadLimit.
      await sandbox.uploadFile("package.json", "/workspace/output/package.json");
      await sandbox.downloadFile("/workspace/output/package.json", "/tmp/roundtrip.json");

      await sandbox.removeFile("/workspace/output", true);
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
