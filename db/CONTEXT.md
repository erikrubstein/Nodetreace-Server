# Context

## Purpose
`db/` owns schema bootstrap and database initialization.

## Boundary Rules
- Schema creation and compatibility bootstrap belong here.
- Higher-level runtime helpers should not be added here; those belong in `server/`.
- If statement management grows significantly, split query groups into focused modules instead of extending `index.js`.
