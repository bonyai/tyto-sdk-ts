/**
 * Publish a guest port at an HTTPS URL a browser can open.
 *
 *   export BONYA_API_KEY=byk_...
 *   npx tsx examples/previews.ts
 */
import { Tyto, PreviewAuth } from "../src/index.js";

async function main(): Promise<void> {
  const apiKey = process.env["BONYA_API_KEY"];
  const client = new Tyto({ apiKey });

  try {
    const sandbox = await client.createSandbox({ template: "ubuntu-24.04" });

    try {
      await client.createSession(sandbox.id, "web", ["python3", "-m", "http.server", "3000"]);

      // Ports must be 1024-65535; privileged ports are never previewable.
      // TOKEN is the default, and an omitted auth never yields a public URL.
      const preview = await client.createPreview(sandbox.id, 3000, { name: "web" });
      console.log(`preview: ${preview.url}`);

      // A token-mode URL needs the sandbox's capability, and a URL is not a
      // safe place to leave one. browserUrl mints a single-use entry point:
      // the gateway validates the token, swaps it for an HttpOnly cookie, and
      // redirects to the same address without it.
      //
      // Open it once and let the cookie carry the session. Do not share it --
      // whoever holds it holds the sandbox's capability. There is no flat
      // form for this: it is a local computation, not an RPC.
      console.log(`open once: ${sandbox.previews.browserUrl(preview)}`);

      for (const existing of await client.listPreviews(sandbox.id)) {
        console.log(`${existing.id} :${existing.port} ${existing.auth}`);
      }

      // PUBLIC means exactly that: no credential at all.
      const publicPreview = await client.createPreview(sandbox.id, 8080, { auth: PreviewAuth.PUBLIC });
      console.log(`public (anyone with this URL): ${publicPreview.url}`);

      await client.deletePreview(sandbox.id, preview.id);
      await client.deletePreview(sandbox.id, publicPreview.id);
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
