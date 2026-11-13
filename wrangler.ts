import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { compileFunction } from "node:vm";

/** The installed preview packages being compared. */
export type Build = "main" | "pr";

/** Real Wrangler TOML fields; only the initial synthetic login is seeded by the harness. */
type Credentials = {
  oauth_token: string;
  refresh_token: string;
  expiration_time: string;
  scopes?: string[];
};

/** Wrangler's actual file-backed credential storage, not an in-memory replacement. */
export type AuthStorage = {
  read(): Credentials | undefined;
  write(credentials: Credentials): void;
  clear(): boolean;
  path(): string;
};

/** The authentication outcome returned to non-interactive Wrangler commands. */
export type AuthResult = { loggedIn: boolean; reason?: string };

/** Boundaries where an OS process can be suspended without modifying its auth decisions. */
export type Pause = "expiry" | "selected" | "write";

/** Everything a child needs; no real home directory, environment credentials, or provider secrets are passed. */
export type ClientOptions = {
  build: Build;
  directory: string;
  origin: string;
  id: string;
  pauses: Pause[];
};

/** Checkpoints and outcomes emitted by a child, with writes reported only after the real write completes. */
export type ClientEvent = {
  event: Pause | "written" | "done";
  result?: AuthResult;
};

/** Private bundle entry points exposed without replacing their implementations. */
type AuthBundle = {
  createOAuthFlow(context: unknown): {
    loginOrRefreshIfRequired(props: { complianceConfig: object }): Promise<AuthResult>;
  };
  createFileStorage(format: "toml", getPath: () => string): AuthStorage;
  undici: { fetch: typeof fetch };
};

/** Keep bundle initialization inside the disposable home and disable metrics before loading Wrangler. */
export function configureEnvironment(directory: string): void {
  process.env.HOME = directory;
  process.env.USERPROFILE = directory;
  process.env.XDG_CONFIG_HOME = directory;
  process.env.WRANGLER_SEND_METRICS = "false";
  process.env.WRANGLER_AUTH_DOMAIN = "repro.invalid";
  process.env.CI = "true";
}

/** Evaluate the installed CLI bundle and expose its real OAuth and TOML-storage factories in memory. */
export function loadWrangler(build: Build): AuthBundle {
  const filename = createRequire(import.meta.url).resolve(`wrangler-${build}`);
  const source = readFileSync(filename, "utf8");
  const module = { exports: {} };
  return compileFunction(
    `${source}\nreturn { createOAuthFlow, createFileStorage, undici: require_undici() };`,
    ["require", "module", "exports", "__filename", "__dirname"],
    { filename },
  )(createRequire(filename), module, module.exports, filename, dirname(filename));
}

/** Report a selected boundary and wait for the parent to release it; timeout rather than hang forever. */
function checkpoint(options: ClientOptions, point: Pause): void {
  if (!options.pauses.includes(point)) return;
  process.send!({ event: point } satisfies ClientEvent);
  const gate = join(options.directory, `${options.id}.${point}.resume`);
  const deadline = Date.now() + 20_000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(gate)) {
    assert.ok(Date.now() < deadline, `${options.id} timed out at ${point}`);
    Atomics.wait(sleeper, 0, 0, 10);
  }
}

/** Ignore routine auth logging; assertions and the local provider report the relevant outcomes. */
function ignore(): void {}

/** Flush the result over IPC before exiting so HTTP keep-alive sockets cannot prolong a finished child. */
function exitClient(error: Error | null): void {
  if (error) console.error(error);
  process.exit(error ? 1 : 0);
}

/**
 * Run the actual command-facing authentication entry point in a separate process.
 * Wrappers only suspend real reads/writes and prevent non-loopback networking. A/B/C all
 * execute Wrangler's own expiry checks, HTTP exchanges, error handling, and file writes.
 */
export async function runAuthClient(options: ClientOptions): Promise<void> {
  configureEnvironment(options.directory);
  const endpoint = `${options.origin}/oauth2/token?client=${options.id}`;
  process.env.WRANGLER_TOKEN_URL = endpoint;
  const bundle = loadWrangler(options.build);
  const realFetch = bundle.undici.fetch;

  /** Fake only the unrelated Access probe; token requests use Wrangler's transport and real loopback HTTP. */
  async function localFetch(url: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    if (String(url) === "https://repro.invalid/") return new Response("");
    assert.equal(String(url), endpoint, "Refusing a non-repro network request");
    return realFetch(url, init);
  }

  /** Resolve the same real file used by the parent and every sibling process. */
  function credentialPath(): string {
    return join(options.directory, "config", "default.toml");
  }

  const realStorage = bundle.createFileStorage("toml", credentialPath);
  let reads = 0;
  const storage: AuthStorage = {
    ...realStorage,
    /** Return the actual on-disk snapshot, optionally suspending after the expiry or token-selection read. */
    read() {
      const snapshot = realStorage.read();
      reads++;
      if (reads === 2) checkpoint(options, "expiry");
      if (reads === 3) checkpoint(options, "selected");
      return snapshot;
    },
    /** Optionally suspend a completed exchange before passing its unmodified credentials to Wrangler's writer. */
    write(credentials) {
      checkpoint(options, "write");
      realStorage.write(credentials);
      process.send!({ event: "written" } satisfies ClientEvent);
    },
  };

  /** Disable environment-token shortcuts and interactive login in this isolated test. */
  function no(): boolean {
    return false;
  }

  /** Select the non-interactive authentication branch used by automation in the original report. */
  function yes(): boolean {
    return true;
  }

  /** Fail rather than open a browser if the auth flow unexpectedly attempts interactive login. */
  async function rejectBrowser(): Promise<never> {
    throw new Error("Unexpected interactive login");
  }

  /** Preserve the instrumented real-file storage across all calls within this client. */
  function storageFactory(): AuthStorage {
    return storage;
  }

  bundle.undici.fetch = localFetch;
  const flow = bundle.createOAuthFlow({
    logger: { debug: ignore, info: ignore, log: ignore, warn: ignore, error: ignore },
    clientId: "repro",
    redirectUri: "http://localhost:8976/oauth/callback",
    consent: { granted: { url: "" }, denied: { url: "", error: "denied" } },
    cliDisplayName: "Wrangler",
    deviceLoginCommand: "unused",
    hasEnvCredentials: no,
    isNonInteractiveOrCI: yes,
    openInBrowser: rejectBrowser,
    allowGlobalAuthKey: false,
    temporary: undefined,
    storageFactory,
  });
  const result = await flow.loginOrRefreshIfRequired({ complianceConfig: {} });
  process.send!({ event: "done", result } satisfies ClientEvent, exitClient);
}
