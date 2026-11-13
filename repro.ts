import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { REUSE_WINDOW_MS, startProvider, type Provider } from "./provider.ts";
import {
  configureEnvironment,
  loadWrangler,
  runAuthClient,
  type AuthResult,
  type AuthStorage,
  type Build,
  type ClientOptions,
  type ClientEvent,
  type Pause,
} from "./wrangler.ts";

/** Independent schedules: an ordinary collision, the PR's race, its control, and a longer suspension. */
type Scenario = "overlap" | "stale-expiry" | "control" | "long-suspension";

/** A real child process and the checkpoints, writes, and result it reports over IPC. */
type Client = {
  process: ChildProcess;
  options: ClientOptions;
  events: ClientEvent[];
  diagnostics: string;
  error?: Error;
};

/** Start a named client within a scenario, optionally suspending it at selected auth boundaries. */
type LaunchClient = (id: string, pauses?: Pause[]) => Client;

/** Start an isolated Node process; all clients in a scenario share one real TOML file. */
function startClient(options: ClientOptions, clients: Client[]): Client {
  const child = fork(fileURLToPath(import.meta.url), ["--client"], {
    cwd: options.directory,
    env: { REPRO_CLIENT: JSON.stringify(options) },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const client: Client = { process: child, options, events: [], diagnostics: "" };

  /** Retain messages even when a checkpoint happens before its parent starts waiting. */
  function onMessage(event: ClientEvent): void {
    client.events.push(event);
  }

  /** Preserve child diagnostics for a useful failure message without cluttering successful output. */
  function onOutput(chunk: Buffer): void {
    client.diagnostics += chunk.toString();
  }

  /** Surface spawn failures in the same bounded checkpoint wait as other child failures. */
  function onError(error: Error): void {
    client.error = error;
  }

  child.on("message", onMessage);
  child.on("error", onError);
  child.stdout!.on("data", onOutput);
  child.stderr!.on("data", onOutput);
  clients.push(client);
  return client;
}

/** Wait for an actual client checkpoint or outcome, failing on crashes or stalled schedules. */
async function waitFor(client: Client, event: Pause | "done"): Promise<ClientEvent> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const message of client.events) {
      if (message.event === event) return message;
    }
    assert.ifError(client.error);
    assert.ok(
      client.process.exitCode === null && client.process.signalCode === null,
      `${client.options.id} exited before ${event}: ${client.diagnostics}`,
    );
    await delay(10);
  }
  throw new Error(`${client.options.id} timed out waiting for ${event}: ${client.diagnostics}`);
}

/** Resume a suspended client without changing any credentials or HTTP responses. */
function resume(client: Client, point: Pause): void {
  writeFileSync(join(client.options.directory, `${client.options.id}.${point}.resume`), "");
}

/** Obtain the real non-interactive auth result returned by a fresh Wrangler process. */
async function finish(client: Client): Promise<AuthResult> {
  const message = await waitFor(client, "done");
  assert.ok(message.result);
  if (client.process.exitCode === null && client.process.signalCode === null) {
    await once(client.process, "exit", { signal: AbortSignal.timeout(5_000) });
  }
  assert.equal(client.process.exitCode, 0, client.diagnostics);
  return message.result;
}

/** Let real time expire the access token and the local provider's reuse window; never edit the token file. */
async function waitForExpiry(storage: AuthStorage, provider: Provider): Promise<void> {
  const credentials = storage.read();
  assert.ok(credentials);
  const readyAt = Math.max(
    Date.parse(credentials.expiration_time),
    provider.state.lastRotation + REUSE_WINDOW_MS,
  );
  assert.ok(Number.isFinite(readyAt), "Expected a valid access-token expiry on disk");
  await delay(Math.max(0, readyAt - Date.now()) + 100);
}

/** Stop only this reproduction's children, including clients still held at a checkpoint after an error. */
async function stopClients(clients: Client[]): Promise<void> {
  for (const client of clients) {
    if (client.process.exitCode === null && client.process.signalCode === null) {
      client.process.kill();
    }
  }
  for (const client of clients) {
    if (client.process.exitCode === null && client.process.signalCode === null) {
      await once(client.process, "exit", { signal: AbortSignal.timeout(5_000) });
    }
  }
}

/** Drive real A/B/C calls in a chosen order; resume gates never write credentials or choose token responses. */
async function runSchedule(
  scenario: Scenario,
  launch: LaunchClient,
  storage: AuthStorage,
  provider: Provider,
): Promise<Client | undefined> {
  const clientA = launch("A", scenario === "overlap" ? ["selected"] : ["selected", "write"]);
  const clientB = launch("B", ["selected"]);
  const clientC = scenario === "stale-expiry" || scenario === "control"
    ? launch("C", ["expiry"])
    : undefined;
  await waitFor(clientA, "selected");
  await waitFor(clientB, "selected");
  if (clientC) await waitFor(clientC, "expiry");
  resume(clientA, "selected");
  resume(clientB, "selected");
  assert.equal((await finish(clientB)).loggedIn, true);

  if (scenario !== "overlap") {
    await waitFor(clientA, "write");
    if (scenario === "long-suspension") {
      await waitForExpiry(storage, provider);
      assert.equal((await finish(launch("C"))).loggedIn, true);
    } else if (scenario === "stale-expiry") {
      resume(clientC!, "expiry");
      assert.equal((await finish(clientC!)).loggedIn, true);
    }
    resume(clientA, "write");
  }
  assert.equal((await finish(clientA)).loggedIn, true);
  if (scenario === "control") {
    resume(clientC!, "expiry");
    assert.equal((await finish(clientC!)).loggedIn, true);
  }
  return clientC;
}

/** Check the real HTTP history and final file, including whether C requested an exchange or wrote anything. */
function verifySchedule(
  build: Build,
  scenario: Scenario,
  storage: AuthStorage,
  provider: Provider,
  clientC: Client | undefined,
): void {
  for (const exchange of provider.state.exchanges.slice(0, 2)) {
    assert.equal(exchange.token, "T0");
    assert.equal(exchange.replacement, "T1");
  }
  let exchangesByC = 0;
  for (const exchange of provider.state.exchanges) {
    if (exchange.client === "C") exchangesByC++;
  }
  const expectedExchangesByC = scenario === "overlap" ? 0
    : scenario === "long-suspension" || build === "main" ? 1 : 0;
  assert.equal(provider.state.exchanges.length, 2 + expectedExchangesByC);
  assert.equal(exchangesByC, expectedExchangesByC);
  if (clientC) {
    let writes = 0;
    for (const event of clientC.events) if (event.event === "written") writes++;
    assert.equal(writes, expectedExchangesByC);
  }
  const expectedStoredToken = scenario === "control" && build === "main" ? "T2" : "T1";
  assert.equal(storage.read()?.refresh_token, expectedStoredToken);
}

/** Require two independent retries to agree, and verify that failed refreshes leave the broken file unchanged. */
async function verifyRetries(
  build: Build,
  scenario: Scenario,
  launch: LaunchClient,
  storage: AuthStorage,
): Promise<boolean> {
  const beforeRetries = storage.read();
  const firstRetry = await finish(launch("retry-1"));
  const secondRetry = await finish(launch("retry-2"));
  const broken = scenario === "long-suspension" || (scenario === "stale-expiry" && build === "main");
  for (const result of [firstRetry, secondRetry]) {
    assert.deepEqual(result, broken
      ? { loggedIn: false, reason: "token-expired-non-interactive" }
      : { loggedIn: true });
  }
  if (broken) assert.deepEqual(storage.read(), beforeRetries);
  return broken;
}

/**
 * Exercise real A/B/C refreshes, real shared-file writes, and two later fresh-process retries.
 * Checkpoints control scheduling only: snapshots and token responses always come from real reads
 * and exchanges. The long-suspension case deliberately tests a boundary the PR does not serialize.
 */
async function runScenario(build: Build, scenario: Scenario, root: string): Promise<void> {
  const directory = mkdtempSync(join(root, `${build}-${scenario}-`));
  const bundle = loadWrangler(build);

  /** Resolve the single private auth file shared by every child in this scenario. */
  function credentialPath(): string {
    return join(directory, "config", "default.toml");
  }

  const storage = bundle.createFileStorage("toml", credentialPath);
  storage.write({
    oauth_token: "access-T0",
    refresh_token: "T0",
    expiration_time: "2000-01-01T00:00:00.000Z",
    scopes: ["account:read"],
  });
  const provider = await startProvider();
  const clients: Client[] = [];

  /** Give each process the same build, provider, and credential directory, but separate scheduling gates. */
  function launch(id: string, pauses: Pause[] = []): Client {
    return startClient({ build, directory, origin: provider.origin, id, pauses }, clients);
  }

  try {
    const clientC = await runSchedule(scenario, launch, storage, provider);
    verifySchedule(build, scenario, storage, provider, clientC);
    await waitForExpiry(storage, provider);
    const broken = await verifyRetries(build, scenario, launch, storage);
    assert.ifError(provider.state.error);
    console.log(`  ${scenario}: ${broken ? "both later retries FAIL (invalid_grant)" : "both later retries succeed"}`);
    for (const exchange of provider.state.exchanges) {
      console.log(`    ${exchange.client}: ${exchange.token} -> ${exchange.replacement ?? "invalid_grant"}`);
    }
  } finally {
    await stopClients(clients);
    provider.server.closeAllConnections();
    provider.server.close();
  }
}

/** Validate the optional build selection without assuming that the two builds have identical outcomes. */
function getBuilds(): Build[] {
  const selected = process.argv[2];
  if (!selected) return ["main", "pr"];
  assert.ok(selected === "main" || selected === "pr", "Use: node repro.ts [main|pr]");
  return [selected];
}

/** Run every schedule in a disposable directory and report the PR's observed limits as well as its fix. */
async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "wrangler-15089-"));
  configureEnvironment(root);
  try {
    for (const build of getBuilds()) {
      console.log(`\n${build === "main" ? "main" : "PR #16874"}:`);
      for (const scenario of ["overlap", "stale-expiry", "control", "long-suspension"] as const) {
        await runScenario(build, scenario, root);
      }
    }
    console.log("\nAll scheduled outcomes verified. See README for the provider model and scope limits.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--client") {
  await runAuthClient(JSON.parse(process.env.REPRO_CLIENT!));
} else {
  await main();
}
