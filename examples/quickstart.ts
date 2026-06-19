import { Tyto } from "../src/index.js";

const tyto = new Tyto({ apiKey: process.env["TYTO_API_KEY"] });

const me = await tyto.me();
console.log(`Signed in as ${me.email}`);

console.log("Creating nest…");
const nest = await tyto.create({ name: "quickstart-demo", template: "ubuntu-24-dev" });
console.log(`Nest ${nest.id} is ${nest.status}`);

console.log("Writing file…");
await nest.fs.write("hello.txt", Buffer.from("Hello from Tyto!"), "file");

console.log("Running command…");
const output = await nest.run(["bash", "-lc", "cat ~/hello.txt"]);
console.log(`Output: ${output.trim()}`);

console.log("Reading file back…");
const { data, kind } = await nest.fs.read("hello.txt");
console.log(`Read ${kind}: ${data.toString()}`);

console.log("Stopping nest…");
await nest.stop();
console.log(`Nest status: ${nest.status}`);

console.log("Deleting nest…");
await nest.delete();
console.log(`Nest ${nest.id} deleted`);
