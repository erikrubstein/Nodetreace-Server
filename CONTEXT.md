# Context

## Purpose
This repo is the Nodetrace backend. It owns authentication, project and node persistence, media storage, archive import/export, live collaboration presence, and web bundle hosting.

## Structure
- `index.js`: server entrypoint and composition root
- `server/`: extracted backend helper domains used to assemble the route context
- `routes/`: HTTP route registration modules; routes should stay thin and depend on injected context
- `db/`: database bootstrap and schema initialization
- `shared/`: cross-route defaults and small backend-only shared constants

## Boundary Rules
- `index.js` should compose helpers, statements, middleware, and routes. It should not keep growing as the home for domain logic.
- `routes/` should not own core business logic. If route handlers start accumulating stateful logic, move that into `server/`.
- `server/` modules should expose cohesive helper groups with explicit dependencies passed in.
- Database statements may stay in `index.js` until there is a deliberate query-layer refactor, but helper functions should move out once a domain becomes large.

## Maintenance Workflow
- Significant structural changes must update the relevant `CONTEXT.md` files.
- If a file or folder becomes difficult to reason about, split it before adding more behavior.
- Prefer creating a new boundary with its own `CONTEXT.md` over expanding a god file.
