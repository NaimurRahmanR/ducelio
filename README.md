# Ducelio

Your ambition. Guided to mastery.

A modular Academy OS built with Next.js, React, TypeScript, Tailwind and Supabase PostgreSQL/Auth. Phase 1 only; no AI services.

## Local start

Requires Node 22.12+ and npm. From this repository:

```sh
npm ci
cp .env.example .env.local
npm run dev
```

On PowerShell use `Copy-Item .env.example .env.local`. Open http://localhost:3000. No credentials are needed for `/demo`. Real sign-in requires Supabase; consult docs/04-auth-and-identity.md.

```sh
npm run check
npm run build
npm start
```

Start with docs/implementation-progress.md for checkpoint status. docs/01-product-principles.md through docs/12-roadmap.md explain the architecture and deferred scope.
