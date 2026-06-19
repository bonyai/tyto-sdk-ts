/**
 * Uploads a web page to a nest, starts a server, and creates a live preview URL.
 */
import { Tyto } from "../src/index.js";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tyto = new Tyto({ apiKey: process.env["TYTO_API_KEY"] });

const nest = await tyto.nests.create({ name: "preview-demo", template: "ubuntu-24-dev" });
console.log(`Nest ${nest.id} is ${nest.status}`);

// Upload the HTML page to the nest
const html = await readFile(join(__dirname, "assets/index.html"));
await nest.fs.write("index.html", html, "file");
console.log("Uploaded index.html");

// Start a Python HTTP server on port 3000 serving /home/tyto
await nest.sessions.create({
  tty: true,
  argv: ["python3", "-m", "http.server", "3000"],
  cwd: "/home/tyto",
  cols: 80,
  rows: 24,
});
console.log("Web server started on port 3000");

// Give the server a moment to bind
await new Promise((r) => setTimeout(r, 1500));

// Create a public preview (no auth token needed to open in browser)
const preview = await nest.previews.create({
  port: 3000,
  auth: "public",
  name: "my-app",
});

console.log("\n┌─────────────────────────────────────────┐");
console.log(`│  🌐 Open in browser:                    │`);
console.log(`│  ${preview.url}`);
console.log("└─────────────────────────────────────────┘\n");

// Inspect via top-level resource
if (preview.id) {
  const inspected = await tyto.previews.get(preview.id);
  console.log(`Preview ID: ${inspected.id}  expires: ${inspected.expires_at}`);
}

// The nest is left running so you can view the preview.
// When done, stop and clean up:
await nest.stop();
await nest.delete();
