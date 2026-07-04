# In-app updates (tauri-plugin-updater)

The updater plugin is already wired in `src/lib.rs` (desktop only). To enable
signed auto-updates for a release, add signing keys and endpoints — no code
changes needed.

## 1. Generate a signing keypair (once)

```bash
pnpm --filter @insightlibrary/desktop exec tauri signer generate -w ~/.tauri/insightlibrary.key
```

Keep the private key secret (CI secret `TAURI_SIGNING_PRIVATE_KEY`). Copy the
printed **public key**.

## 2. Add the config to `tauri.conf.json`

```jsonc
"plugins": {
  "updater": {
    "pubkey": "<PUBLIC KEY FROM STEP 1>",
    "endpoints": [
      "https://releases.insightlibrary.ai/{{target}}/{{arch}}/{{current_version}}"
    ]
  }
}
```

## 3. Sign during release

`tauri build` signs artifacts when `TAURI_SIGNING_PRIVATE_KEY` (and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) are set. Publish the generated
`latest.json` + signatures to the endpoint above.

## 4. Check for updates from the app

```ts
import { check } from '@tauri-apps/plugin-updater';
const update = await check();
if (update) { await update.downloadAndInstall(); }
```

Until endpoints are configured, `check()` is a no-op — the plugin is present but
inert, so nothing breaks in dev.
