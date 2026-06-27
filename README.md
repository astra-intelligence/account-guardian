# Express + EJS + Postgres Starter

Minimal Node.js web app: Express server, EJS templates, PostgreSQL connection,
migration runner, Render deployment config.

## Requirements

- Node.js 20+
- PostgreSQL database

## Environment Variables

- `DATABASE_URL` — PostgreSQL connection string (required)
- `PORT` — Server port (default: 3000)

## Endpoints

- `GET /` — Landing page (renders `views/layout.ejs`)
- `GET /health` — Health check

## Layout

```
views/
  layout.ejs           top-level template (entry point)
  partials/            sections included from layout via <%- include('partials/<name>') %>
public/
  css/                 stylesheets, served at /css/<file>
lib/
  landing-context.js   builds the render context (slug, theme tokens, stylesheet links)
server.js              Express app
migrate.js             migration runner (run via `npm run migrate`)
```

## Local Development

```bash
npm install
DATABASE_URL="postgresql://..." npm run dev
```

## Deployment

Configured for Render via `render.yaml`. `npm run build` runs migrations on
deploy.
