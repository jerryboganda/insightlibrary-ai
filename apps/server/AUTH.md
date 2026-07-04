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

### Generate better-auth's tables (once)

better-auth owns its own schema (user, session, account, verification, plus the
organization plugin's org/member/invitation tables). Generate and apply it with
the official CLI — this reads the config in `src/lib/server/auth.ts`:

```bash
cd apps/server
npx @better-auth/cli generate --output ./drizzle/auth-schema.ts   # emits the schema
npx @better-auth/cli migrate                                       # applies it to DATABASE_URL
```

Then apply the app schema and seed:

```bash
pnpm --filter @insightlibrary/server db:push    # app tables (folders, documents, topics, chunks, …)
pnpm --filter @insightlibrary/server db:seed     # prototype dataset + FTS index
```

### SSO / SAML

The `sso` plugin (OIDC discovery + SAML + org provisioning) can be added to the
`plugins` array in `auth.ts`; configure providers per the better-auth SSO docs.
