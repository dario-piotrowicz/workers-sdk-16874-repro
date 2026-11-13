import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export const REUSE_WINDOW_MS = 1_000;
const ACCESS_LIFETIME_SECONDS = 3;

/** One real HTTP exchange, identified by a diagnostic query parameter that never affects its outcome. */
type Exchange = { client: string; token: string; replacement?: string };

/** Provider state independent of the Wrangler build and the test's scheduling decisions. */
type ProviderState = {
  current: string;
  generation: number;
  consumed: Map<string, { replacement: string; usedAt: number }>;
  exchanges: Exchange[];
  lastRotation: number;
  error?: Error;
};

/** The loopback server and its observable history, used only to verify outcomes and wait for expiry. */
export type Provider = Awaited<ReturnType<typeof startProvider>>;

/** Rotate once, reuse the same replacement within the grace period, and otherwise reject a consumed token. */
function exchangeToken(state: ProviderState, token: string): string | undefined {
  if (token === state.current) {
    const replacement = `T${++state.generation}`;
    state.lastRotation = Date.now();
    state.consumed.set(token, { replacement, usedAt: state.lastRotation });
    state.current = replacement;
    return replacement;
  }
  const previous = state.consumed.get(token);
  if (previous && Date.now() - previous.usedAt < REUSE_WINDOW_MS) {
    return previous.replacement;
  }
  return undefined;
}

/** Parse an actual refresh POST and return standard OAuth JSON, never inspecting which build sent it. */
async function handleRequest(state: ProviderState, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url!, "http://127.0.0.1");
  assert.equal(request.method, "POST");
  assert.equal(url.pathname, "/oauth2/token");
  let body = "";
  for await (const chunk of request) body += chunk.toString();
  const params = new URLSearchParams(body);
  assert.equal(params.get("grant_type"), "refresh_token");
  assert.equal(params.get("client_id"), "repro");
  const token = params.get("refresh_token");
  assert.ok(token);
  const replacement = exchangeToken(state, token);
  state.exchanges.push({ client: url.searchParams.get("client")!, token, replacement });
  response.writeHead(replacement ? 200 : 400, { "Content-Type": "application/json" });
  response.end(JSON.stringify(replacement ? {
    access_token: `access-${replacement}`,
    refresh_token: replacement,
    expires_in: ACCESS_LIFETIME_SECONDS,
    scope: "account:read",
  } : { error: "invalid_grant" }));
}

/** Start a fake OAuth provider on an OS-selected loopback port, using shortened but real expiry intervals. */
export async function startProvider() {
  const state: ProviderState = {
    current: "T0",
    generation: 0,
    consumed: new Map(),
    exchanges: [],
    lastRotation: 0,
  };

  /** Keep malformed requests visible to the parent instead of allowing an unhandled async rejection. */
  function onRequest(request: IncomingMessage, response: ServerResponse): void {
    /** Record unexpected provider errors and terminate the waiting HTTP request. */
    function onError(error: Error): void {
      state.error = error;
      response.writeHead(500);
      response.end();
    }

    void handleRequest(state, request, response).catch(onError);
  }

  const server = createServer(onRequest);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, origin: `http://127.0.0.1:${address.port}`, state };
}
