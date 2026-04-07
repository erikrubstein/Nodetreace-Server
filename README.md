# Nodetrace Server

Standalone backend for Nodetrace.

Shared architecture notes live in [../architecture.md](../architecture.md).

## Responsibilities

- local account authentication and sessions
- project, node, collaborator, and media APIs
- public/private project visibility enforcement
- SQLite persistence and file storage
- optional hosting of the built web UI

## Development

Install dependencies:

```powershell
npm install
```

Run the server:

```powershell
npm run dev
```

Current local setup points the server at the existing live data directory:

```powershell
C:\SolaSec\Tools\Nodetrace\Nodetrace-Client\data
```

That path is configured in the server repo `.env` so the backend can use the existing database and uploads without moving them yet.

## Configuration

- `HOST` and `PORT`: bind address and port for the HTTP server
- `NODETRACE_SECRET_KEY`: required to encrypt stored project API keys
- `NODETRACE_DATA_DIR`: optional override for SQLite/uploads/temp storage
- `NODETRACE_WEB_DIST`: optional override for the built web UI directory

By default the server stores runtime data in `./data` and serves hosted web assets from `./dist`.

The server repo does not invoke client repo scripts. If you want to host the web UI from the server, build and deploy the frontend bundle into `./dist` or point `NODETRACE_WEB_DIST` at a deployed bundle path.

Uploaded media is served with versioned URLs and strong private cache headers so desktop and web clients can reuse cached previews without serving stale images after an update.
