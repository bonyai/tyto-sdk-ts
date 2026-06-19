/**
 * Demonstrates interactive WebSocket connections: exec and console.
 *
 * exec() opens a raw command WebSocket (/nest/{id}/exec).
 * console() opens an interactive shell WebSocket (/nest/{id}/console).
 * session.attach() attaches to a managed session's output stream.
 */
import { Tyto } from "../src/index.js";

const tyto = new Tyto({ apiKey: process.env["TYTO_API_KEY"] });

const nest = await tyto.nests.create({ name: "ws-demo", template: "ubuntu-24-dev" });
console.log(`Nest ${nest.id} is ${nest.status}`);

// --- Raw exec WebSocket ---
console.log("Opening exec WebSocket…");
const execWs = nest.exec();

await new Promise<void>((resolve, reject) => {
  execWs.on("open", () => console.log("exec: connected"));
  execWs.on("message", (data) => process.stdout.write(String(data)));
  execWs.on("close", (code) => {
    console.log(`\nexec: closed (${code})`);
    resolve();
  });
  execWs.on("error", reject);
  // Close after 3 seconds
  setTimeout(() => execWs.close(), 3000);
});

// --- Managed session attach WebSocket ---
console.log("Creating managed session…");
const session = await nest.sessions.create({
  tty: true,
  argv: ["bash", "-lc", "for i in 1 2 3; do echo $i; sleep 0.2; done"],
  cols: 80,
  rows: 24,
});

console.log(`Attaching to session ${session.id}…`);
const attachWs = session.attach();

await new Promise<void>((resolve, reject) => {
  attachWs.on("open", () => console.log("attach: connected"));
  attachWs.on("message", (data) => process.stdout.write(String(data)));
  attachWs.on("close", () => {
    console.log("\nattach: closed");
    resolve();
  });
  attachWs.on("error", reject);
});

await nest.stop();
await nest.delete();
console.log("Done");
