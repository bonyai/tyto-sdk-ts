/**
 * Demonstrates file upload/download, including reading directory archives (tar).
 */
import { Tyto } from "../src/index.js";

const tyto = new Tyto({ apiKey: process.env["TYTO_API_KEY"] });

const nest = await tyto.nests.create({ name: "files-demo", template: "ubuntu-24-dev" });
console.log(`Nest ${nest.id} is ${nest.status}`);

// Upload a file
const content = Buffer.from("Hello, Tyto!\n");
await nest.fs.write("demo.txt", content, "file");
console.log("Uploaded file");

// Download the file
const { data, kind } = await nest.fs.read("demo.txt");
console.log(`Downloaded ${kind}: ${data.toString()}`);

// Upload a tar archive as a directory
// (create a tar buffer containing your dir, then upload with kind='dir')
// const tar = await readFile("mydir.tar");
// await nest.fs.write("mydir", tar, "dir");
// console.log("Uploaded directory");

// Download a directory as tar
// const { data: dirTar } = await nest.fs.read("mydir");
// console.log(`Downloaded dir archive, ${dirTar.length} bytes`);

await nest.stop();
await nest.delete();
console.log("Done");
