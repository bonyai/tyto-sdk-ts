# @bonya/tyto

TypeScript SDK for the [Tyto API](https://api.tyto.run) — manage nests, sessions, files, previews, snapshots, and keepalive holds.

## Install

```bash
npm install @bonya/tyto
```

## Auth

Export your API key:

```bash
export TYTO_API_KEY=your_key_here
```

Or pass it directly:

```ts
const tyto = new Tyto({ apiKey: "your_key_here" });
```

## Usage

```ts
import { Tyto } from "@bonya/tyto";

const tyto = new Tyto();

// Who am I?
const me = await tyto.me();
console.log(me.email);

// Create a nest
const nest = await tyto.nests.create({ name: "my-nest", template: "ubuntu-24-dev" });

// Upload a file
await nest.fs.write("/home/tyto/hello.txt", Buffer.from("Hello!"), "file");

// Read it back
const { data, kind } = await nest.fs.read("/home/tyto/hello.txt");
console.log(data.toString()); // "Hello!"

// Run a command via a managed session
const session = await nest.sessions.create({
  tty: false,
  argv: ["bash", "-lc", "echo hi"],
});

// Attach to the session over WebSocket
const ws = session.attach();
ws.on("message", (d) => console.log(String(d)));

// Open a raw interactive shell
const console_ = nest.console();
const exec_ = nest.exec();

// Create a preview
const preview = await nest.previews.create({ port: 3000, auth: "private" });
console.log(preview.url);

// Snapshot, fork, restore
const snap = await nest.snapshots.create({ name: "v1" });
const fork = await nest.fork({ name: "my-fork" });
// await nest.restore(snap.id!);

// Keepalive hold
await nest.holds.put("ci", { ttl: "30m", reason: "CI job" });
await nest.holds.heartbeat("ci", { ttl: "30m" });
await nest.holds.delete("ci");

// Lifecycle
await nest.stop();
await nest.start();
await nest.wake({ reason: "wakeup" });
await nest.delete();
```

## Resources

| Resource | Description |
|---|---|
| `tyto.nests` | Create / list / get nests |
| `tyto.previews` | Inspect / revoke previews by ID |
| `tyto.snapshots` | Delete snapshots by ID |
| `tyto.auth` | CLI browser auth flow |
| `nest.fs` | Upload / download files |
| `nest.sessions` | Managed sessions (create / list) |
| `nest.previews` | Previews scoped to the nest |
| `nest.snapshots` | Snapshots + fork/restore |
| `nest.holds` | Keepalive holds |
| `session.attach()` | WebSocket stream for a session |
| `nest.console()` | Interactive shell WebSocket |
| `nest.exec()` | Command WebSocket |

## Configuration

| Option | Env var | Default |
|---|---|---|
| `apiKey` | `TYTO_API_KEY` | — (required) |
| `apiUrl` | `TYTO_API_URL` | `https://api.tyto.run` |

## Examples

```bash
npx tsx examples/quickstart.ts
npx tsx examples/files.ts
npx tsx examples/preview.ts
npx tsx examples/snapshot-fork.ts
npx tsx examples/websocket-exec.ts
```
