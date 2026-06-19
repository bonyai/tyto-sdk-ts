/**
 * Demonstrates file upload/download, including reading directory archives (tar).
 */
import { Tyto } from "../src/index.js";

const tyto = new Tyto({ apiKey: process.env["TYTO_API_KEY"] });

const nest = await tyto.create({ name: "files-demo", template: "ubuntu-24-dev" });
console.log(`Nest ${nest.id} is ${nest.status}`);

// Upload a file
await nest.put("./demo.txt", "demo.txt");
console.log("Uploaded file");

// Download the file
await nest.get("demo.txt", "./demo.downloaded.txt");
console.log("Downloaded file");

// Upload a directory
await nest.put("./mydir", "mydir");
console.log("Uploaded directory");

// Download a directory
await nest.get("mydir", "./mydir-downloaded");
console.log("Downloaded directory");

await nest.stop();
await nest.delete();
console.log("Done");
