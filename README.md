# Wrangler #15089: concurrent refreshes and a persistently broken auth chain

Compare real Wrangler authentication from `wrangler@main` and `wrangler@16874` using **separate OS processes, one shared TOML credential file, and real HTTP requests to a local fake OAuth provider**.

Unlike the previous harness, A, B, and C all execute Wrangler. Their refresh responses and credential writes are not fabricated by the scheduler. Fresh processes then check whether authentication keeps failing, as reported in [issue #15089](https://github.com/cloudflare/workers-sdk/issues/15089).

**Important:** the issue's logs do not establish an exact causal ordering or fully specify the live provider's token-reuse rules. No offline test can prove it recreated that historical incident. This tests the reported failure mechanism and persistent symptom under an explicit provider model, including a case [PR #16874](https://github.com/cloudflare/workers-sdk/pull/16874) does **not** fix. It is not a claim that the issue is completely fixed.

## Run

Requires **Node.js 24+** and npm:

```sh
cd /Users/dario/Desktop/tests/workers-sdk-15089-repro
npm ci --ignore-scripts
npm test
```

Allow about a minute: tests wait for actual short-lived access tokens to expire. Installation needs internet access; the reproduction uses loopback networking only.

```sh
npm run main       # main only
npm run pr         # PR #16874 only
npm run typecheck
```

## What is tested?

Every scenario starts with one synthetic expired login (`T0`) in a temporary `config/default.toml`. From then on, **only Wrangler writes the credentials**. Each later retry runs in a new process, reading that same file.

| Schedule | main | PR #16874 |
| --- | --- | --- |
| `overlap`: A/B both select `T0` before either saves | Later retries succeed | Later retries succeed |
| `stale-expiry`: C's expiry decision is stale; A saves last | Repeated `invalid_grant` | Later retries succeed |
| `control`: same stale decision, but A saves before C continues | Later retries succeed | Later retries succeed |
| `long-suspension`: A's save is delayed beyond access-token expiry | Repeated `invalid_grant` | **Repeated `invalid_grant`** |

The ordinary A/B collision alone does not break this provider's chain: requests within its reuse window receive the same replacement token. That is a tested outcome, not an assumption that one of the requests must fail.

### Stale-expiry schedule

1. A/B select `T0`. C reads its expired access token and is suspended before returning that real snapshot.
2. A/B both exchange `T0` for `T1`. B writes its response; A is suspended just before its write.
3. C resumes. Main unnecessarily exchanges the freshly stored `T1` for `T2`; the PR reuses B's valid access token instead.
4. A resumes and writes its actual earlier `T1` response.
5. After expiry and the reuse window, two fresh processes try authentication. Main repeatedly gets `invalid_grant`; the PR succeeds.

The control releases A before C, removing the stale overwrite while keeping the other steps the same.

### Long-suspension schedule

1. A/B both exchange `T0` for `T1`; B saves, while A is suspended before its write.
2. B's access token really expires. A new C process legitimately exchanges `T1` for `T2` and saves it.
3. A resumes and writes its earlier `T1` response over `T2`.
4. Once reuse tolerance has elapsed, fresh processes repeatedly fail with `invalid_grant` on **both builds**. The stored credentials remain unchanged.

This deliberately longer suspension is a counterexample to a blanket fix claim, not proof that such a suspension happened in the original report. The PR rechecks expiry; it does not serialize the entire cross-process read → exchange → write operation.

## Real versus controlled

- **Real:** separate Node processes; the installed Wrangler bundles' command-facing `loginOrRefreshIfRequired()`; expiry checks; refresh-token selection; HTTP request construction and responses; non-interactive failure results; Wrangler's own TOML reader/writer; shared-file races; actual passage of time.
- **Controlled:** initial fake login, a loopback provider, and process pauses around real storage operations. The scheduler never replaces snapshots or writes replacement tokens.
- **Provider model:** first use rotates a token; reuse within **1 second** returns the same replacement; subsequent reuse returns HTTP 400 `invalid_grant`. Access tokens last **3 seconds**. These shortened intervals are test parameters, not claims about Cloudflare's current production configuration. There is no family-wide revocation rule in this model.
- **Not exercised:** the remote D1/deploy workload, Cloudflare's production OAuth service, an interactive login, or the reporter's original machine. Only the unrelated Cloudflare Access probe is faked in the client; actual refresh requests use Wrangler's bundled HTTP transport to the loopback server. Other destinations are rejected.

No real account, credential, browser, deployment, or D1 database is involved. Children receive a minimal environment without your credentials. Bundle initialization uses a disposable home; all test files are removed afterwards.

## Files and flow

- `repro.ts`: start the provider and child processes, coordinate their pauses, then assert two later authentication results.
- `wrangler.ts`: load the installed bundle, expose its private auth/storage factories without rewriting their implementations, and run an isolated auth client.
- `provider.ts`: implement the same build-independent OAuth model for every scenario.

`main()` → `runScenario()` → `startClient()` → child `runAuthClient()` → Wrangler `loginOrRefreshIfRequired()` → real file reads / local HTTP / real file writes. Afterwards, fresh `retry-1` and `retry-2` processes run the same authentication path.

Exit **0** means all outcomes in the table were observed, including the expected auth failures. An unexpected outcome, crash, or checkpoint timeout fails the test. It does **not** mean every scenario authenticated successfully or the original issue is universally fixed.

## Builds

The existing lockfile records the previously installed previews:

- `wrangler-main`: `https://pkg.pr.new/wrangler@main`, checked at main `3cea40b078519222db432b5edf827ddc3e629a2a` on November 12, 2026.
- `wrangler-pr`: `https://pkg.pr.new/wrangler@16874`, checked at PR head `f45017049e627cc049c88b101505db216ecf9774` on November 12, 2026.

Both report version `4.161.0`; the package aliases distinguish them. These URLs move: `npm ci` can fail integrity verification if they start serving different bytes. To deliberately update the lockfile and rerun against newly resolved previews:

```sh
npm install --ignore-scripts --force wrangler-main@https://pkg.pr.new/wrangler@main wrangler-pr@https://pkg.pr.new/wrangler@16874
npm test
```

The loader depends on private bundle names. If those internals or the number of auth reads change, update the harness rather than treating a broken checkpoint as evidence about the bug. If main gains the PR fix, its stale-expiry expected-failure assertion should fail intentionally.
