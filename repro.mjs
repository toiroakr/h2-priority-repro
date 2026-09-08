// Minimal, self-contained repro: 16 concurrent HTTP/2 client-streaming uploads
// sharing ONE connection finish at wildly uneven times on Node 24+, even though
// aggregate throughput is unchanged. On Node <=22 all 16 finish within ~the same
// second (fair scheduling); on Node 24/25 the fastest can finish 12x+ before the
// slowest. No dependencies beyond node:http2 and node:net.
import http2 from "node:http2";
import net from "node:net";

const HALF_RTT_MS = 25; // ~50ms simulated RTT
const NUM_STREAMS = 16;
const BYTES_PER_STREAM = 1024 * 1024;
const CHUNK_SIZE = 64 * 1024;

const server = http2.createServer();
server.on("stream", (stream) => {
  stream.on("data", () => {});
  stream.on("end", () => {
    stream.respond({ ":status": 200 });
    stream.end();
  });
});
await new Promise((r) => server.listen(0, r));
const serverPort = server.address().port;

const proxy = net.createServer((clientSocket) => {
  const upstream = net.connect(serverPort, "127.0.0.1");
  clientSocket.on("data", (c) => setTimeout(() => upstream.write(c), HALF_RTT_MS));
  upstream.on("data", (c) => setTimeout(() => clientSocket.write(c), HALF_RTT_MS));
  const done = () => { clientSocket.destroy(); upstream.destroy(); };
  clientSocket.on("close", done);
  upstream.on("close", done);
});
await new Promise((r) => proxy.listen(0, r));
const proxyPort = proxy.address().port;

const session = http2.connect(`http://127.0.0.1:${proxyPort}`);
const perStreamSeconds = [];

function upload() {
  const t0 = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    const stream = session.request({ ":method": "POST", ":path": "/upload" });
    stream.on("error", reject);
    stream.on("data", () => {});
    stream.on("end", () => {
      perStreamSeconds.push(Number(process.hrtime.bigint() - t0) / 1e9);
      resolve();
    });
    let sent = 0;
    (function writeMore() {
      while (sent < BYTES_PER_STREAM) {
        const size = Math.min(CHUNK_SIZE, BYTES_PER_STREAM - sent);
        sent += size;
        if (!stream.write(Buffer.alloc(size, "x"))) return stream.once("drain", writeMore);
      }
      stream.end();
    })();
  });
}

await Promise.all(Array.from({ length: NUM_STREAMS }, upload));

const sorted = [...perStreamSeconds].sort((a, b) => a - b);
console.log(`node ${process.version}`);
console.log(`per-stream completion time (s), sorted: ${sorted.map((s) => s.toFixed(2)).join(", ")}`);
console.log(`min=${sorted[0].toFixed(2)}s max=${sorted.at(-1).toFixed(2)}s spread=${(sorted.at(-1) / sorted[0]).toFixed(1)}x`);

session.close();
server.close();
proxy.close();
