# Authentication (better-auth)

## Dev (default — no database)

Without `DATABASE_URL`, auth is **bypassed**: every request is the seeded owner
(`DEV_SESSION_USER` in `src/lib/server/auth.ts`), so all screens are reachable
with zero setup. `/api/auth/*` returns 501 in this mode.

## Production (Postgres)

With `DATABASE_URL` set, better-auth (organization + admin + bearer plugins)
backs real multi-tenant sessions via the Drizzle adapter. Web clients use cookie
sessions; the Tauri client uses the **bearer** plugin with the token stored in
the OS keyring (`secrets_*` Rust commands).

### Create better-auth's tables (once)

better-auth owns its own schema (user, session, account, verification, plus the
organization plugin's org/member/invitation tables). The static instance lives in
`src/lib/server/auth-config.ts` (no SvelteKit imports) so the CLI can read it:

```bash
cd apps/server
pnpm db:auth   # = @better-auth/cli migrate --config src/lib/server/auth-config.ts -y
```

Then apply the app schema and seed:

```bash
pnpm --filter @insightlibrary/server db:push    # app tables (folders, documents, topics, chunks, …)
pnpm --filter @insightlibrary/server db:seed     # prototype dataset + FTS index
```

### SSO / SAML

The `sso` plugin (OIDC discovery + SAML + org provisioning) can be added to the
`plugins` array in `auth.ts`; configure providers per the better-auth SSO docs.
