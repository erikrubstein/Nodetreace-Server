# Nodetrace Server

<p align="center">
  <img src="./assets/nodetrace.svg" alt="Nodetrace logo" width="140" />
</p>

<p align="center">
  Backend API, persistence layer, and optional hosted web entry point for Nodetrace.
</p>

Nodetrace Server is the Node.js backend for Nodetrace. It handles authentication, project and media persistence, collaboration presence, access control, and optional hosting of the built web client.

## What This Repository Does

- manages accounts, sessions, and project access
- stores projects, nodes, templates, and per-user project UI data in SQLite
- stores uploaded media and generated preview files on disk
- serves media, project APIs, export/import routes, and collaboration presence
- can host the built web client bundle for browser-based use

## Requirements

- Node.js 22 or newer
- npm 10 or newer recommended
- a valid `NODETRACE_SECRET_KEY` for encrypting stored project-level API keys

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Create a `.env` file in the repo root or set environment variables directly.

Minimal local example:

```env
HOST=127.0.0.1
PORT=3001
NODETRACE_SECRET_KEY=replace-this-with-a-long-random-secret
```

3. Start the server:

```bash
npm run dev
```

The server listens on `http://127.0.0.1:3001` by default.

4. Start a client and connect to the server:

- web: host the built client through this server or another web deployment
- desktop: use a packaged desktop release or run the client repo locally

## Configuration

Supported environment variables:

- `HOST`
  Bind address. Defaults to `0.0.0.0`.
- `PORT`
  HTTP port. Defaults to `3001`.
- `NODETRACE_SECRET_KEY`
  Required for encrypting stored project-level secrets such as OpenAI API keys.
- `NODETRACE_DATA_DIR`
  Overrides the default runtime data directory. Defaults to `./data`.
- `NODETRACE_WEB_DIST`
  Overrides the path used to serve the built web client. Defaults to `./dist`.
- `OPENAI_IDENTIFICATION_MODEL`
  Optional override for the server-side AI identification model. Defaults to `gpt-4.1`.

## Data Storage

By default the server writes runtime data to:

- `./data/database.db`
- `./data/uploads/`
- `./data/tmp/`

If you set `NODETRACE_DATA_DIR`, those paths are relocated under the configured directory.

## Serving The Web Client

This repo can serve the browser UI if a built client bundle is available.

Default hosted web path:

- `./dist`

You can either:

- copy the built client bundle into `./dist`, or
- point `NODETRACE_WEB_DIST` at another built bundle location

To produce a bundle from the client repo:

```bash
cd ../Nodetrace-Client
npm install
npm run build:web
```

## Development Scripts

- `npm run dev`
  Starts the server with file watching.
- `npm run start`
  Starts the server without watch mode.
- `npm run lint`
  Lints all server-side JavaScript files.

## Typical Local Development Setup

Run the backend here:

```bash
npm run dev
```

Then in the client repo:

Web:

```bash
cd ../Nodetrace-Client
npm install
npm run dev
```

Desktop:

```bash
cd ../Nodetrace-Client
npm run dev:desktop
```

## Repository Layout

- `index.js`
  Application entry point and top-level composition
- `routes/`
  Express route registration for projects, nodes, media auth, and sessions
- `server/`
  Server-side helper modules for auth, access, presence, files, archive handling, and project modeling
- `db/`
  SQLite bootstrap and query helpers
- `shared/`
  Shared backend defaults such as project settings

## Contributing

1. Read [AGENTS.md](./AGENTS.md) before editing server code.
2. Keep route handlers thin and push reusable logic into `server/` or `db/`.
3. Preserve clear separation between:
   - HTTP routes
   - persistence helpers
   - domain normalization/business logic
4. Run validation before opening a pull request:

```bash
npm run lint
```
