# Context

## Purpose
`server/` holds extracted backend helper domains that used to live in `index.js`.

## Current Domains
- `auth.js`: env loading, auth/session helpers, credential normalization, project secret masking/encryption
- `files.js`: upload and file-system helpers for project media
- `identification.js`: AI identification normalization, prompt preparation, template serialization
- `projectModel.js`: project/node normalization and serialization, tree building, preference shaping
- `access.js`: authenticated user resolution and access/assertion helpers
- `archive.js`: project archive import/export and subtree restore
- `presence.js`: server-sent project events and session/mobile presence bookkeeping

## Boundary Rules
- Modules here should be cohesive and dependency-injected.
- Do not let modules silently reach into globals from `index.js`.
- If a helper is reused across routes and transactions, it probably belongs here instead of back in the entrypoint.
