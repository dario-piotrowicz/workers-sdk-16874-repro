import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { compileFunction } from "node:vm";

/** The two installed package aliases compared by the reproduction. */
type Build = "main" | "pr";

/** The OAuth credential fields read and written by Wrangler's auth flow. */
type Credentials = {
  oauth_token: string;
  refresh_token: string;
  expiration_time: string;
};

/** The storage interface injected into the real OAuth implementation. */
type AuthStorage = {
  read(): Credentials;
  write(credentials: Credentials): void;
  clear(): never;
  path(): string;
};

/** The private bundle internals needed to run auth and replace its HTTP client. */
type AuthBundle = {
  createOAuthFlow(context: unknown): {
    getOAuthTokenFromLocalState(): Promise<string | undefined>;
  };
  undici: { fetch: typeof fetch };
};

/** C's initial activity and the subsequent refresh outcome for one replay. */
type ReplayResult = {
  firstExchanges: string[];
  firstWrites: number;
  laterAccessToken: string | undefined;
  exchanges: string[];
};

const EXPIRED_TIME = "2000-01-01T00:00:00.000Z";
const SIBLING_CREDENTIALS: Credentials = {
  oauth_token: "access-T1",
  refresh_token: "T1",
  expiration_time: "2099-01-01T00:00:00.000Z",
};

/**
 * Isolate Wrangler's startup configuration before loading either bundle.
 * Auth requests are mocked, metrics are disabled, and home/config lookups stay
 * inside this project. These changes affect this process, not the user's shell.
 */
function configureEnvironment(): void {
  process.env.WRANGLER_AUTH_DOMAIN = "repro.invalid";
  process.env.WRANGLER_TOKEN_URL = "https://repro.invalid/oauth2/token";
  process.env.WRANGLER_SEND_METRICS = "false";
  process.env.HOME = import.meta.dirname;
  process.env.USERPROFILE = import.meta.dirname;
  process.env.XDG_CONFIG_HOME = import.meta.dirname;
}

/**
 * Load the actual published Wrangler bundle with Node's CommonJS wrapper
 * arguments. An extra return statement exposes its unexported OAuth factory
 * and Undici client without editing installed files or changing auth logic.
 */
function loadAuth(packageName: string): AuthBundle {
  const filename = createRequire(import.meta.url).resolve(packageName);
  const source = readFileSync(filename, "utf8");
  const module = { exports: {} };
  return compileFunction(
    `${source}\nreturn { createOAuthFlow, undici: require_undici() };`,
    ["require", "module", "exports", "__filename", "__dirname"],
    { filename },
  )(createRequire(filename), module, module.exports, filename, dirname(filename));
}

/**
 * Model shared credential storage using independent in-memory snapshots.
 * C initially sees expired T0. B's valid T1 credentials appear on the second
 * read, precisely between C's expiry decision and its refresh-time reread.
 */
function createMockStorage() {
  const state = {
    credentials: {
      oauth_token: "access-T0",
      refresh_token: "T0",
      expiration_time: EXPIRED_TIME,
    },
    writes: 0,
  };
  let reads = 0;
  const storage: AuthStorage = {
    /** Inject B's save at the race boundary, then return a fresh snapshot. */
    read() {
      if (++reads === 2) state.credentials = { ...SIBLING_CREDENTIALS };
      return { ...state.credentials };
    },
    /** Record writes requested by Wrangler; never touch a credential file. */
    write(credentials) {
      state.writes++;
      state.credentials = { ...credentials };
    },
    /** Fail if the tested flow unexpectedly tries to delete credentials. */
    clear() {
      throw new Error("Unexpected credential deletion");
    },
    /** Supply a diagnostic placeholder instead of a real credential path. */
    path() {
      return "<fake credentials; no file>";
    },
  };
  return { storage, state };
}

/**
 * Model a provider that has already issued T1 to A and B. Each successful
 * refresh consumes the current token and issues the next generation. Rejecting
 * a consumed token models a later attempt after reuse tolerance has elapsed;
 * neither the live provider nor the duration of that window is tested here.
 */
function createMockProvider() {
  let currentRefreshToken = "T1";
  let nextGeneration = 2;
  const exchanges: string[] = [];

  /** Handle the Access probe and token exchanges without a network fallback. */
  const fetchMock: typeof fetch = async (url, options) => {
    if (String(url) === "https://repro.invalid/") return new Response("");
    assert.equal(String(url), "https://repro.invalid/oauth2/token");
    const params = new URLSearchParams(String(options?.body));
    assert.equal(params.get("grant_type"), "refresh_token");
    const token = params.get("refresh_token");
    if (token !== currentRefreshToken) {
      exchanges.push(`${token} -> invalid_grant`);
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    currentRefreshToken = `T${nextGeneration++}`;
    exchanges.push(`${token} -> ${currentRefreshToken}`);
    return Response.json({
      access_token: `access-${currentRefreshToken}`,
      refresh_token: currentRefreshToken,
      expires_in: 3600,
      scope: "account:read",
    });
  };
  return { fetch: fetchMock, exchanges };
}

/**
 * Connect the real OAuth implementation to fake storage and HTTP. Wrangler uses
 * its bundled Undici client, so replacing global fetch alone would not work.
 * The injected context prevents interactive login or environment credentials.
 */
function createFlow(bundle: AuthBundle, storage: AuthStorage, fetchMock: typeof fetch) {
  bundle.undici.fetch = fetchMock;
  /** Discard auth diagnostics so the replay's own output remains readable. */
  const ignore = () => {};
  return bundle.createOAuthFlow({
    logger: { debug: ignore, info: ignore, log: ignore, warn: ignore, error: ignore },
    clientId: "repro",
    redirectUri: "http://localhost:8976/oauth/callback",
    consent: { granted: { url: "" }, denied: { url: "", error: "denied" } },
    cliDisplayName: "Repro",
    deviceLoginCommand: "unused",
    /** Prevent the flow from bypassing the fake OAuth credentials. */
    hasEnvCredentials: () => false,
    /** Keep authentication on its non-interactive path. */
    isNonInteractiveOrCI: () => true,
    /** Fail rather than open a browser if an interactive path is reached. */
    openInBrowser: async () => {
      throw new Error("Unexpected interactive login");
    },
    allowGlobalAuthKey: false,
    temporary: undefined,
    /** Reuse the same mock store across all reads and writes in this replay. */
    storageFactory: () => storage,
  });
}

/**
 * Replay C's lookup, optionally apply A's delayed T1 save, then force a later
 * refresh without waiting for expiry. Main consumes T1 unnecessarily, making
 * A's overwrite stale; the PR leaves T1 usable. A/B scheduling and elapsed time
 * are modeled, while both lookups execute the package's actual auth code.
 * Omitting A's save supplies the matching control with fresh mock state.
 */
async function replay(bundle: AuthBundle, lateWrite: boolean): Promise<ReplayResult> {
  const { storage, state } = createMockStorage();
  const provider = createMockProvider();
  const flow = createFlow(bundle, storage, provider.fetch);
  const firstAccessToken = await flow.getOAuthTokenFromLocalState();
  assert.equal(firstAccessToken, state.credentials.oauth_token);

  const firstExchanges = [...provider.exchanges];
  const firstWrites = state.writes;
  if (lateWrite) state.credentials = { ...SIBLING_CREDENTIALS };
  state.credentials.expiration_time = EXPIRED_TIME;
  const laterAccessToken = await flow.getOAuthTokenFromLocalState();
  return { firstExchanges, firstWrites, laterAccessToken, exchanges: provider.exchanges };
}

/**
 * Require main to reproduce the stale-token failure and the PR to avoid it.
 * Also verify that C makes neither a refresh request nor a storage write on the
 * PR. Main's expected auth failure is a successful reproduction, not a test error.
 */
function verifyRace(version: Build, result: ReplayResult): void {
  const isMain = version === "main";
  assert.deepEqual(result.firstExchanges, isMain ? ["T1 -> T2"] : []);
  assert.equal(result.firstWrites, isMain ? 1 : 0);
  assert.deepEqual(result.exchanges, isMain
    ? ["T1 -> T2", "T1 -> invalid_grant"]
    : ["T1 -> T2"]);
  assert.equal(result.laterAccessToken, isMain ? undefined : "access-T2");
}

/** Ensure both builds refresh successfully when A's stale overwrite is absent. */
function verifyControl(version: Build, control: ReplayResult): void {
  const isMain = version === "main";
  assert.deepEqual(control.exchanges, isMain
    ? ["T1 -> T2", "T2 -> T3"]
    : ["T1 -> T2"]);
  assert.equal(control.laterAccessToken, isMain ? "access-T3" : "access-T2");
}

/** Explain the build's race and control outcomes after all assertions pass. */
function printOutcome(version: Build): void {
  const isMain = version === "main";
  console.log(`\n${isMain ? "main" : "PR #16874"}:`);
  console.log("  C sees expired T0; B saves valid credentials with T1 before C rereads.");
  console.log(isMain
    ? "  C unnecessarily refreshes T1 -> T2 and writes T2."
    : "  C reuses B's access token: zero refresh requests, zero writes.");
  console.log("  A's delayed response writes T1; access token expires (simulated).");
  console.log(isMain
    ? "  Later refresh: T1 -> invalid_grant. BUG REPRODUCED."
    : "  Later refresh: T1 -> T2. FIX VERIFIED for this sequence.");

  console.log("  Control without A's late write: refresh succeeds.");
}

/** Validate the optional build argument, defaulting to a comparison of both. */
function getBuilds(): Build[] {
  const selected = process.argv[2];
  if (!selected) return ["main", "pr"];
  assert.ok(selected === "main" || selected === "pr", "Use: node repro.ts [main|pr]");
  return [selected];
}

/** Run the race and its control against one installed build, then report it. */
async function compareBuild(version: Build): Promise<void> {
  const bundle = loadAuth(`wrangler-${version}`);
  verifyRace(version, await replay(bundle, true));
  verifyControl(version, await replay(bundle, false));
  printOutcome(version);
}

/** Configure isolation and run each selected comparison, failing on any mismatch. */
async function main(): Promise<void> {
  configureEnvironment();
  for (const version of getBuilds()) {
    await compareBuild(version);
  }
  console.log("\nAll expected outcomes verified.");
}

await main();
