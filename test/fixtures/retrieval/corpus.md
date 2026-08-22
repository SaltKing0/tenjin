# Retrieval Fixture Corpus

A small, versioned corpus used by the B9-15 retrieval golden set to
regression-test the chunking + retrieval pipeline. Each section is a
self-contained topic so a query has an unambiguous set of relevant chunks.
The golden set lives alongside it and must be updated explicitly whenever
this corpus (or the chunking pipeline) changes.

## Authentication

The `parseAuthToken` helper validates an incoming bearer token and returns its
subject claim. Authentication is handled by the login service (`auth.ts`),
which issues signed tokens and verifies them on every request. The login
service also refreshes expired sessions.

## Build

The release build is produced by `bun run build` and tagged from the
changelog. On 2026-08-22 the 0.2.0 release shipped with the new memory
retrieval layer and the golden-set CI gate. Builds run on ubuntu-latest with
the Bun toolchain and must stay green.

## Storage

Chunks are persisted as newline-delimited JSON in `vectors.jsonl`. Each chunk
carries an embedding, a session id, and a project path. Retrieval fuses a BM25
rank list with a cosine rank list via reciprocal rank fusion (RRF, k=60).
