# Wrangler OAuth refresh race: main vs PR #16874

Minimal, deterministic TypeScript reproduction of the **specific stale-expiry / late-write sequence** addressed by [PR #16874](https://github.com/cloudflare/workers-sdk/pull/16874), related to [issue #15089](https://github.com/cloudflare/workers-sdk/issues/15089).

One script, two Wrangler packages, and Node's built-in TypeScript support. No Worker, compilation step, test framework, Cloudflare account, or login is needed. TypeScript and Node typings are included for editor support and type checking.

## Run

Requires **Node.js 24+** and npm. From this directory:

```sh
npm ci --ignore-scripts
npm test
```

Check TypeScript separately with `npm run typecheck`.

Run either build separately:

```sh
npm run main
npm run pr
```

Expected result:

```text
main:
  ...
  Later refresh: T1 -> invalid_grant. BUG REPRODUCED.
  Control without A's late write: refresh succeeds.

PR #16874:
  ...
  Later refresh: T1 -> T2. FIX VERIFIED for this sequence.
  Control without A's late write: refresh succeeds.

All expected outcomes verified.
```

The comparison exits **0** only if main reproduces the bug, the PR avoids it, and the controls succeed. An unexpected outcome exits nonzero. Main's failure is expected and asserted, not a failed comparison test.

## What the script does

`repro.ts` executes **the actual OAuth flow bundled in the installed Wrangler packages**, not a copied implementation. Since that internal factory is not publicly exported, `loadAuth()` evaluates the CommonJS bundle with an extra return statement exposing `createOAuthFlow` and its bundled Undici transport. It does not edit the installed files or change the auth logic.

Storage and HTTP are replaced with in-memory fakes. **No real credentials are read or written, no network requests are made during the repro, and no browser opens.** Installation is the only step that needs network access.

The script also redirects its process-local home/config paths into this project before loading Wrangler, keeping bundle initialization away from your normal Wrangler directory. It does not change your shell's environment.

The replay starts just after A and B have both exchanged `T0` for the same `T1`: B is about to save its response, and A's response is still pending. A storage-read hook inserts B's save at the exact race boundary:

1. C reads expired credentials and decides to refresh.
2. Before C's refresh-time read, B saves a valid access token and `T1`.
3. **Main** nevertheless exchanges `T1` for `T2` and saves `T2`. **The PR** rechecks expiry and reuses B's valid access token, without an exchange or write.
4. A's delayed save writes its earlier `T1` over the stored credentials.
5. We expire the access token and try another refresh. Main fails because `T1` was already consumed; with the PR, `T1` is unused and succeeds.

The mock provider rejects previously consumed tokens on the later attempt. This **simulates the later refresh after the provider's reuse-tolerance window has elapsed**; it does not measure or verify Cloudflare's live token behavior. A/B's duplicate exchange, their scheduling, and time passing are modeled rather than run as real concurrent processes. The actual expiry checks, token selection, refresh handling, and storage writes run through each published build.

A matching control omits A's late save: both builds must then refresh successfully. This isolates the stale overwrite from ordinary token rotation. This repro is not a claim that the PR fixes every possible concurrent-refresh ordering or proves which ordering occurred in the original issue's logs.

## Builds

The dependencies use the requested moving URLs:

- `wrangler-main`: <https://pkg.pr.new/wrangler@main>
- `wrangler-pr`: <https://pkg.pr.new/wrangler@16874>

Verified on November 12, 2026: main `3cea40b078519222db432b5edf827ddc3e629a2a`; PR `f45017049e627cc049c88b101505db216ecf9774`. Both report Wrangler `4.161.0`, so the version number alone does not distinguish them.

`package-lock.json` records the tested package integrity. `npm ci` reproduces that installation while those URLs still serve the same bytes; if a moving URL changes, it may fail integrity verification. To deliberately resolve the URLs again and update the lockfile:

```sh
npm install --ignore-scripts --force wrangler-main@https://pkg.pr.new/wrangler@main wrangler-pr@https://pkg.pr.new/wrangler@16874
npm test
```

If main later contains the fix, its expected-bug assertion should fail; that is intentional. The loader also depends on private bundle names, which may change in future builds.
