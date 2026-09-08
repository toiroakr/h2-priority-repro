# h2-priority-repro

Minimal reproduction: HTTP/2 streams sharing one connection become severely
unfair since Node.js 24.2.0, even though aggregate throughput is unchanged.

`repro.mjs` opens 16 concurrent client-streaming HTTP/2 requests over a
single connection to a local server, through a local proxy that adds ~50ms
of simulated round-trip latency, with each stream uploading 1 MiB in 64 KiB
chunks. It prints each stream's completion time. The script has no
dependencies beyond `node:http2` and `node:net`.

## Running it

```sh
node repro.mjs
```

Requires Node.js 18 or later. No install step — the script is
self-contained.

## Expected output

- **Node 18 / 20 / 22**: all 16 streams finish within roughly the same
  second (`spread` close to `1.0x`) — fair scheduling.
- **Node 24 / 25**: streams finish at wildly uneven times (`spread` of
  `10x` or more) — later streams take proportionally longer, even though
  the aggregate bytes/sec across all streams is unchanged from Node 22.

## Actual results observed

Node 22.22.0 (all 16 streams, sorted, seconds):

```
20.84, 20.84, 20.84, 20.84, 20.84, 20.84, 20.84, 20.84,
20.84, 20.84, 20.84, 20.84, 20.84, 20.84, 20.84, 20.85
min=20.84s max=20.85s spread=1.0x
```

Node 24.13.0 (all 16 streams, sorted, seconds):

```
1.78, 3.09, 4.46, 5.83, 7.19, 8.45, 9.81, 11.18,
12.54, 13.92, 15.18, 16.54, 17.91, 19.27, 20.52, 21.57
min=1.78s max=21.57s spread=12.1x
```

Re-run independently on a second machine with Node 24.13.0, the spread was
consistent (`12.4x`, min `1.73s` / max `21.48s`).

Node 18.20.8 and 20.20.2 were also tested and both showed fair scheduling
(`spread` close to `1.0x`), matching Node 22.22.0. Node 25.9.0 was tested
and showed the same unfair scheduling as Node 24.13.0. Node 23.x, 24.0.x,
and 24.1.x have not been tested, so the exact version boundary is not
independently confirmed — see "Suspected cause" below.

## Suspected cause

This coincides with Node.js PR "http2: remove support for priority
signaling" (Matteo Collina / Antoine du Hamel, merged 2025-06-03 as
`a631264`, first released in Node.js 24.2.0), which removed nghttp2's
stream-priority-tree scheduler following [RFC 9113](https://www.rfc-editor.org/rfc/rfc9113)'s
deprecation of HTTP/2 priority signaling.

The priority tree may not have only handled explicit RFC 7540 priority
signaling — it may also have provided an implicit fairness mechanism for
concurrent streams when no priority is set. Removing it appears to have
taken that mechanism away without a replacement scheduling policy. This is
a hypothesis based on the timing match with the above PR, not something
independently verified against Node.js's internal scheduling code.

This matters for any client running several concurrent uploads or
downloads over one HTTP/2 connection (chunked uploads, gRPC-style
client-streaming, etc.): a simple aggregate-throughput benchmark looks
unaffected, but per-request latency becomes highly variable, which can
trip server-side per-request timeouts even though the server and network
are otherwise healthy.
