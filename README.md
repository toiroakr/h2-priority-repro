# h2-priority-repro

Minimal reproduction: HTTP/2 streams sharing one connection become severely
unfair on certain Node.js versions, even though aggregate throughput across
all streams is unchanged.

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

## Affected versions (confirmed)

CI (`.github/workflows/repro.yml`) runs this script across a Node.js
version matrix on every push. As of the versions below:

| Node.js version | Scheduling | Notes |
| --- | --- | --- |
| 18.20.8 | fair (`spread` ≈ `1.0x`) | |
| 20.20.2 | fair (`spread` ≈ `1.0x`) | |
| 22.22.0 – 22.22.3 | fair (`spread` ≈ `1.0x`) | |
| **22.23.0 and later 22.x** | **unfair (`spread` ≈ `12x`)** | backport onto the 22.x LTS line |
| 24.2.0 and later 24.x | unfair (`spread` ≈ `12x`) | |
| 25.x | unfair (`spread` ≈ `12x`) | |

The exact boundary within 22.x was bisected in CI across every 22.x patch
between 22.22.0 and 22.23.2: fair through 22.22.3, unfair starting at
22.23.0. **This means Node.js 22 (an active LTS line) is affected once
it's updated past 22.22.3, not just Node.js 24+.**

## Confirmed cause

Both boundaries (24.2.0 and 22.23.0) correspond to the same upstream
change landing in each release line. Node.js's own changelog for
[22.23.0](https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V22.md)
lists it explicitly, as a `(SEMVER-MAJOR)` change backported onto an LTS
line:

> **(SEMVER-MAJOR)** **http2**: remove support for priority signaling
> (Matteo Collina) [#58293](https://github.com/nodejs/node/pull/58293)

The same PR first shipped in 24.2.0 (merged 2025-06-03 as `a631264`) and
was backported into 22.23.0 (released 2026-06-18, LTS "Jod") about a year
later. It removed nghttp2's stream-priority-tree scheduler following
[RFC 9113](https://www.rfc-editor.org/rfc/rfc9113)'s deprecation of HTTP/2
priority signaling.

The priority tree appears to have done more than handle explicit RFC 7540
priority signaling — it also provided an implicit fairness mechanism for
concurrent streams when no priority is set. Removing it took that
mechanism away without a replacement scheduling policy. (This mechanism
explanation is our inference from the observed behavior; the changelog
entry itself only documents the priority-signaling removal, not this
scheduling side effect.)

This matters for any client running several concurrent uploads or
downloads over one HTTP/2 connection (chunked uploads, gRPC-style
client-streaming, etc.): a simple aggregate-throughput benchmark looks
unaffected, but per-request latency becomes highly variable, which can
trip server-side per-request timeouts even though the server and network
are otherwise healthy.

## Raw data

CI, Node 22.22.0 (fair):

```
min=19.91s max=19.92s spread=1.0x
```

CI, Node 22.23.0 (unfair, first affected 22.x patch):

```
per-stream completion time (s), sorted: 1.69, 2.96, 4.27, 5.59, 6.90, 8.13, 9.44, 10.76,
12.08, 13.40, 14.61, 15.93, 17.24, 18.56, 19.77, 20.80
min=1.69s max=20.80s spread=12.3x
```

CI, Node 24.20.0 (unfair):

```
per-stream completion time (s), sorted: 1.69, 2.96, 4.28, 5.60, 6.91, 8.13, 9.45, 10.76,
12.07, 13.39, 14.60, 15.92, 17.23, 18.55, 19.76, 20.78
min=1.69s max=20.78s spread=12.3x
```

Locally (two different machines), Node 24.13.0 showed `12.1x` and `12.4x`
spreads respectively — consistent with the CI numbers above. See the
[Actions tab](../../actions) for the full matrix output on every push.
