# Context

## Purpose
`routes/` contains HTTP registration modules. Each file mounts related endpoints onto the Express app using an injected `ctx` object.

## Contains
- `mediaAuthRoutes.js`: auth, account, and upload access routes
- `projectRoutes.js`: project metadata, preferences, collaborators, templates
- `projectFileRoutes.js`: archive import/export and subtree restore
- `nodeRoutes.js`: node edits, media operations, identification
- `sessionRoutes.js`: capture/mobile/desktop session coordination

## Boundary Rules
- Keep route modules thin.
- Validation and response shaping can live here.
- Reusable or multi-step domain logic belongs in `server/`.
- Route files should depend on injected helpers rather than import unrelated modules directly.
