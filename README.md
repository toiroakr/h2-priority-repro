# h2-priority-repro

Minimal reproduction: HTTP/2 streams sharing one connection become severely
unfair on certain Node.js versions, even though aggregate throughput across
all streams is unchanged.

`repro.mjs` opens 16 concurrent client-streaming HTTP/2 requests over a
single connection to a local server, through a local proxy that adds ~50ms
of simulated round-trip latency, with each stream uploading 1 MiB in 64 KiB
chunks. It prints each stream's completion time. The script has no
dependencies beyond `node:http2` and `node:net`.

`repro-incremental.mjs` is the same script, except each request adds an
RFC 9218 `priority: u=3, i` header (`incremental=true`) — see "Is this
actually a bug?" below for why, and what it does (or doesn't) change.

## Running it

```sh
node repro.mjs
node repro-incremental.mjs
```

Requires Node.js 18 or later. No install step — the scripts are
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
mechanism away. (This mechanism explanation is our inference from the
observed behavior; the changelog entry itself only documents the
priority-signaling removal, not this scheduling side effect.)

## Is this actually a bug?

Not clearly, on its own — see below.

[RFC 9113](https://www.rfc-editor.org/rfc/rfc9113) deprecated the old
RFC 7540 priority-tree signaling, and its intended replacement is
[RFC 9218](https://www.rfc-editor.org/rfc/rfc9218.html) ("Extensible
Prioritization Scheme for HTTP"), which nghttp2 also implements. RFC 9218
defines two parameters per request: `urgency` (default `3`) and
`incremental` (default `false`). Critically, the RFC itself recommends,
for requests that share the same urgency and have `incremental=false`
(i.e. anything sent with no priority hints at all, which defaults to
`u=3, i=false`):

> Serving non-incremental responses with the same urgency concurrently
> because the client is not going to process those responses
> incrementally. Serving non-incremental responses with the same urgency
> one by one, in the order in which those requests were generated, is
> considered to be the best strategy. (Section 4.2)

> Non-incremental responses of the same urgency SHOULD be served by
> prioritizing bandwidth allocation in ascending order of the stream ID,
> which corresponds to the order in which clients make requests.
> (Section 10.5)

That is *exactly* the pattern this repro observes: 16 same-priority
streams, served roughly one at a time in ascending stream-ID order. So
the "unfair" scheduling matches the new spec's own documented default
recommendation — this isn't obviously a scheduling bug in the sense of
violating any spec.

**However**, `incremental=true` is meant to be how a client opts back
into concurrent/fair scheduling for streams it wants processed together
(our repro's 16 uploads are exactly that case). `repro-incremental.mjs`
tests this by sending `priority: u=3, i` (RFC 9218's syntax for
`incremental=true`) on every request. **It has no effect** — the spread
is unchanged (`12.6x` on Node 24.13.0, same as without the header).
Node's `http2stream.priority()` — the old client-facing API for
influencing scheduling — is now a deprecated no-op tied to the removed
RFC 7540 mechanism, and there does not appear to be any current Node.js
API that lets a client opt its own outbound streams into RFC 9218
`incremental` scheduling for its own writes (as opposed to just hinting
a remote server how to schedule *its* responses, which is the direction
RFC 9218 headers are normally used for).

So the more precise framing is: removing RFC 7540 priority took away a
mechanism that also happened to provide fair default scheduling for
concurrent client-side writes, RFC 9218's own recommended default doesn't
restore that fairness for non-incremental same-urgency streams (which is
what any request with no priority hints becomes), and there's currently
no client-facing way to opt out of that default and get the old
concurrent behavior back. That combination — not the scheduling change in
isolation — is what looks like a gap worth raising with Node.js, framed
as a missing capability rather than a straightforward regression.

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
