/**
 * Codex Adapter — orchestrates a single `ac7 codex` session.
 *
 * Responsibilities:
 *
 *   1. Locate the `codex` binary.
 *   2. Set up the ephemeral `CODEX_HOME` (auth symlink + config.toml
 *      with our `[mcp_servers.ac7]` block).
 *   3. Spawn `codex app-server` (stdio JSON-RPC default transport).
 *   4. `initialize` handshake.
 *   5. Subscribe to thread/turn/item notifications and wire them into
 *      runner state: presence, status cache, active turn id, optional
 *      diagnostic logging.
 *   6. Auto-respond to any approval/elicitation server-requests with a
 *      deny (defense in depth — we configure approvalPolicy=never and
 *      mcp default_tools_approval_mode=never, so these shouldn't fire).
 *   7. `thread/start` carrying the briefing as developerInstructions.
 *   8. Hold the process alive until codex exits (we treat codex exit
 *      as the runner's signal to stop).
 *   9. On shutdown: flush the channel sink, `turn/interrupt` if a turn
 *      is active, `close` the JSON-RPC client, kill codex if still
 *      alive, remove the ephemeral CODEX_HOME.
 *
 * The adapter is deliberately the only file that knows about codex
 * subprocess concerns. Everything beyond it (broker, tools dispatch,
 * MCP bridge, trace host) is shared with claude-code via the runner.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { BriefingResponse } from '@agentc7/sdk/types';
import { CLI_VERSION } from '../../../version.js';
import type { Presence } from '../../presence.js';
import type { BusySignal } from '../../trace/busy.js';
import type { TraceHost } from '../../trace/host.js';
import { attachCodexBusySniff, type CodexBusySniff } from './busy-sniff.js';
import type { CodexChannelSink } from './channel-sink.js';
import { createCodexChannelSink } from './channel-sink.js';
import { setupCodexHome } from './codex-home.js';
import { createJsonRpcClient, type JsonRpcClient } from './json-rpc.js';
import {
  type ItemCompletedNotification,
  type ItemStartedNotification,
  METHODS,
  NOTIFICATIONS,
  SERVER_REQUEST_METHODS,
  type ThreadStartedNotification,
  type ThreadStartResponse,
  type ThreadStatus,
  type ThreadStatusChangedNotification,
  type TurnStartedNotification,
} from './protocol.js';

export class CodexAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexAdapterError';
  }
}

/** Locate the `codex` binary. Mirrors `findClaudeBinary`. */
export function findCodexBinary(): string {
  const fromEnv = process.env.CODEX_PATH;
  if (fromEnv && fromEnv.length > 0) {
    if (!existsSync(fromEnv)) {
      throw new CodexAdapterError(`CODEX_PATH points at ${fromEnv} but no file exists there`);
    }
    return fromEnv;
  }
  try {
    const out = execFileSync('which', ['codex'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out.length === 0) {
      throw new CodexAdapterError('which found no codex binary');
    }
    return out;
  } catch (err) {
    throw new CodexAdapterError(
      `failed to locate codex binary: ${err instanceof Error ? err.message : String(err)}\n` +
        '  Install OpenAI Codex CLI (npm i -g @openai/codex) and make sure it is on PATH, ' +
        'or set CODEX_PATH explicitly.',
    );
  }
}

export interface CodexSpawnOptions {
  briefing: BriefingResponse;
  /**
   * Path to the runner's IPC socket. Used both for the bridge subprocess
   * (via CODEX_HOME's config.toml env block) and is otherwise unused
   * by codex itself.
   */
  runnerSocketPath: string;
  /**
   * The `command` + `args` to write into `[mcp_servers.ac7]`. Must match
   * the same auto-detection the claude-code adapter does — point at this
   * cli's own dist so the bridge subprocess is reachable.
   */
  bridgeCommand: string;
  bridgeArgs: string[];
  /** Trace host or null when --no-trace. Drives the codex env delta. */
  traceHost: TraceHost | null;
  /** Codex binary path, from `findCodexBinary()`. */
  codexBinary: string;
  /** Working directory for codex. Defaults to process.cwd. */
  cwd?: string;
  /** Optional model override (`--model`). */
  model?: string;
  /**
   * Extra args forwarded verbatim to `codex app-server` after the
   * subcommand. The operator is responsible for the codex version
   * accepting these; ac7 passes them through unchanged.
   * Use codex's own `-c key=value` syntax to override config.toml entries,
   * e.g. `-c 'model_provider="qwen"'`.
   */
  codexArgs?: string[];
  /** Presence signal — flipped by status notifications. */
  presence: Presence;
  /**
   * Busy signal — bumped on each tool-execution `item/started` and
   * decremented on the matching `item/completed`. Optional: when
   * absent (e.g. `--no-trace`), tool-lifecycle events still get
   * logged but don't drive the indicator. Pass the same signal the
   * trace host uses so LLM-call and tool-execution bumps share one
   * 0↔busy transition contract.
   */
  busy?: BusySignal;
  /** Logger, structured JSON to stderr by default. */
  log: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface CodexSpawnResult {
  /** Resolves with the exit code of codex when it terminates. */
  exitCode: Promise<number>;
  /** Pluggable sink the runner forwarder writes channel events into. */
  channelSink: CodexChannelSink;
  /** Best-effort graceful shutdown. Idempotent. */
  shutdown(reason?: string): Promise<void>;
}

export async function spawnCodex(opts: CodexSpawnOptions): Promise<CodexSpawnResult> {
  const cwd = opts.cwd ?? process.cwd();

  // 1. Set up ephemeral CODEX_HOME with our config.toml.
  const codexHome = setupCodexHome({
    bridgeCommand: opts.bridgeCommand,
    bridgeArgs: opts.bridgeArgs,
    runnerSocketPath: opts.runnerSocketPath,
  });
  if (!codexHome.authLinked) {
    process.stderr.write(
      'ac7 codex: no codex auth.json found in ~/.codex — run `codex login` first ' +
        'so the spawned codex can talk to OpenAI.\n',
    );
  }

  // 2. Build the codex subprocess env. CODEX_HOME points at our
  //    ephemeral dir; trace env vars get translated from Node-style
  //    (NODE_EXTRA_CA_CERTS) into codex/reqwest-style
  //    (CODEX_CA_CERTIFICATE).
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  childEnv.CODEX_HOME = codexHome.path;
  if (opts.traceHost !== null) {
    const nodeStyle = opts.traceHost.envVars(process.env);
    // Proxy variables: codex's reqwest client honors HTTPS_PROXY /
    // HTTP_PROXY / ALL_PROXY / NO_PROXY directly. We keep all of these.
    if (nodeStyle.HTTPS_PROXY) childEnv.HTTPS_PROXY = nodeStyle.HTTPS_PROXY;
    if (nodeStyle.HTTP_PROXY) childEnv.HTTP_PROXY = nodeStyle.HTTP_PROXY;
    if (nodeStyle.ALL_PROXY) childEnv.ALL_PROXY = nodeStyle.ALL_PROXY;
    if (nodeStyle.NO_PROXY) childEnv.NO_PROXY = nodeStyle.NO_PROXY;
    // Custom CA: codex prefers CODEX_CA_CERTIFICATE (PEM file path).
    // SSL_CERT_FILE works as a fallback. We set both — if codex's
    // bundled-roots path ignores SSL_CERT_FILE, CODEX_CA_CERTIFICATE
    // is the canonical knob.
    childEnv.CODEX_CA_CERTIFICATE = opts.traceHost.caCertPath;
    childEnv.SSL_CERT_FILE = opts.traceHost.caCertPath;
    // Drop NODE_EXTRA_CA_CERTS — codex isn't a Node process.
    delete childEnv.NODE_EXTRA_CA_CERTS;
    // Drop NODE_USE_ENV_PROXY — Node-only.
    delete childEnv.NODE_USE_ENV_PROXY;
    opts.log('codex: trace env armed', {
      proxy: nodeStyle.HTTPS_PROXY,
      caCert: opts.traceHost.caCertPath,
    });
  }

  // 3. Spawn codex app-server. Default --listen=stdio:// — we own the
  //    child's stdin/stdout. ac7-injected flags are kept to zero so
  //    the same code path works across every codex version that ships
  //    `app-server` (older builds reject unknown flags). User-supplied
  //    `codexArgs` are appended verbatim — the operator has chosen
  //    their codex version and accepts responsibility for compatibility.
  opts.log('codex: spawning', {
    binary: opts.codexBinary,
    codexHome: codexHome.path,
    codexArgs: opts.codexArgs ?? [],
  });
  const child = spawn(opts.codexBinary, ['app-server', ...(opts.codexArgs ?? [])], {
    cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  let resolveExit: (code: number) => void = () => {};
  const exitCode = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  child.on('exit', (code, signal) => {
    const resolved = code ?? (signal ? 128 + (signalNumber(signal) ?? 0) : 0);
    opts.log('codex: child exited', { code: resolved, signal });
    resolveExit(resolved);
  });
  child.on('error', (err) => {
    opts.log('codex: spawn error', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  if (!child.stdin || !child.stdout) {
    codexHome.remove();
    throw new CodexAdapterError('codex spawned without stdin/stdout pipes');
  }

  // 4. Wire the JSON-RPC client.
  const rpc: JsonRpcClient = createJsonRpcClient(child.stdout, child.stdin, {
    log: opts.log,
  });

  // Auto-deny any approval/elicitation server-request that fires.
  // With our thread settings these shouldn't happen; the handlers
  // exist so a misconfigured run hangs visibly (with a log) rather
  // than silently waiting for a UI that doesn't exist.
  for (const method of Object.values(SERVER_REQUEST_METHODS)) {
    rpc.onRequest(method, async (params) => {
      opts.log('codex: auto-denying server request', { method, params });
      // Codex's response shape varies by method; an empty object
      // generally maps to "deny / cancel" semantics (the client
      // didn't pick a decision). For elicitations specifically we
      // return a `cancel` action. This is best-effort — if codex
      // demands a stricter shape, the request will surface as a
      // JSON deserialization error in codex's logs and we'll know
      // to refine the response.
      return { decision: 'deny', action: 'cancel' };
    });
  }

  // 5. State the channel sink reads via getters.
  let threadId: string | null = null;
  let lastStatus: ThreadStatus = { type: 'notLoaded' };
  let activeTurnId: string | null = null;

  // 6. Channel sink for the runner forwarder. Constructed BEFORE the
  //    notification handlers below because some of them call
  //    `channelSink.flushNow()`, and codex can fire notifications the
  //    instant we register the handlers (the channel is already open
  //    by the time `initialize` completes).
  const channelSink = createCodexChannelSink({
    rpc,
    getThreadId: () => threadId,
    getStatus: () => lastStatus,
    getActiveTurnId: () => activeTurnId,
    log: opts.log,
  });

  rpc.onNotification(NOTIFICATIONS.threadStarted, (params) => {
    const p = params as ThreadStartedNotification;
    if (p?.thread?.id) {
      threadId = p.thread.id;
      opts.log('codex: thread started', { threadId, status: p.thread.status?.type });
      if (p.thread.status) {
        applyStatus(p.thread.status);
      }
    }
  });
  /**
   * Centralised status updater. Called from three sources, all of which
   * carry the same `ThreadStatus` shape:
   *   - `thread/start` RPC response (initial)
   *   - `thread/started` notification (initial, redundant safety net)
   *   - `thread/status/changed` notification (transitions)
   * Without the first two, codex's habit of only emitting status-changed
   * on transitions would leave us stuck at `notLoaded` indefinitely on a
   * fresh idle thread, and the channel sink would buffer every inbound
   * director message forever.
   */
  function applyStatus(status: ThreadStatus): void {
    lastStatus = status;
    opts.log('codex: status changed', { status: status.type });
    switch (status.type) {
      case 'idle':
      case 'active':
        opts.presence.setOnline();
        break;
      case 'notLoaded':
        opts.presence.setConnecting();
        break;
      case 'systemError':
        opts.presence.setOffline();
        break;
    }
    if (status.type !== 'notLoaded') {
      void channelSink.flushNow().catch((err) => {
        opts.log('codex: status-driven flush failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  rpc.onNotification(NOTIFICATIONS.threadStatusChanged, (params) => {
    const p = params as ThreadStatusChangedNotification;
    if (!p?.status) return;
    applyStatus(p.status);
  });
  rpc.onNotification(NOTIFICATIONS.turnStarted, (params) => {
    const p = params as TurnStartedNotification;
    if (p?.turn?.id) {
      activeTurnId = p.turn.id;
    }
  });
  rpc.onNotification(NOTIFICATIONS.turnCompleted, () => {
    activeTurnId = null;
  });
  rpc.onNotification(NOTIFICATIONS.itemStarted, (params) => {
    const p = params as ItemStartedNotification;
    if (p?.item?.type) {
      opts.log('codex: item started', { type: p.item.type, turnId: p.turnId });
    }
  });
  rpc.onNotification(NOTIFICATIONS.itemCompleted, (params) => {
    const p = params as ItemCompletedNotification;
    if (p?.item?.type) {
      opts.log('codex: item completed', { type: p.item.type, turnId: p.turnId });
    }
  });
  // Tool-execution busy sniff (only when a busy signal is provided —
  // i.e., tracing is enabled). Subscribes to the same notifications
  // above; logging stays here, busy-counter ownership lives in the
  // shared helper so tests can exercise the same code path.
  const busySniff: CodexBusySniff | null = opts.busy
    ? attachCodexBusySniff({ rpc, busy: opts.busy, log: opts.log })
    : null;
  rpc.onNotification(NOTIFICATIONS.error, (params) => {
    opts.log('codex: error notification', params as Record<string, unknown>);
  });

  // ─── Shutdown wiring ──────────────────────────────────────────
  // Hoisted ABOVE the initialize/thread-start blocks because their
  // catch handlers call `teardown()`. Function declarations are
  // hoisted, but `let teardownReason` is in TDZ until reached, so a
  // failed initialize would have crashed with "Cannot access
  // 'teardownReason' before initialization" — a real bug surfaced
  // the first time codex rejected one of our requests.
  let teardownReason: string | null = null;
  async function teardown(reason: string): Promise<void> {
    if (teardownReason !== null) return;
    teardownReason = reason;
    opts.log('codex: tearing down', { reason });
    try {
      await channelSink.flushNow();
    } catch (err) {
      opts.log('codex: final flush failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (threadId !== null && activeTurnId !== null) {
      try {
        await rpc.request(METHODS.turnInterrupt, {
          threadId,
          turnId: activeTurnId,
        });
      } catch {
        /* best-effort */
      }
    }
    // Drain any in-flight tool handles before we tear down the rpc
    // client — codex won't be sending matching `item/completed` once
    // we close, so anything left here would wedge the busy signal.
    busySniff?.drain();
    rpc.close(reason);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
    codexHome.remove();
  }

  // 7. Initialize handshake. Codex requires this before any other
  //    method will succeed.
  try {
    await rpc.request(METHODS.initialize, {
      clientInfo: { name: 'agentc7-cli', version: CLI_VERSION },
    });
  } catch (err) {
    await teardown('initialize-failed');
    throw new CodexAdapterError(
      `codex initialize failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  opts.log('codex: initialize ok');

  // 8. Start the thread with our briefing as developerInstructions.
  //    This is also where we lock down `approvalPolicy: never` +
  //    `sandbox: workspaceWrite` so headless runs never elicit a
  //    UI prompt.
  try {
    const resp = await rpc.request<ThreadStartResponse>(METHODS.threadStart, {
      cwd,
      developerInstructions:
        opts.briefing.instructions.length > 0 ? opts.briefing.instructions : undefined,
      model: opts.model,
      approvalPolicy: 'never',
      // Match claude-code's posture: `--dangerously-skip-permissions` on the
      // claude side disables prompting but doesn't sandbox the filesystem or
      // network (claude has no built-in sandbox). `danger-full-access` is the
      // codex equivalent — same trust boundary, just expressed through codex's
      // explicit sandbox enum. Tighter modes (`workspace-write`, `read-only`)
      // are useful for review/CI scenarios; we'll surface them as a flag later.
      sandbox: 'danger-full-access',
    });
    if (resp?.thread?.id) {
      threadId = resp.thread.id;
      opts.log('codex: thread/start ok', {
        threadId,
        status: resp.thread.status?.type,
      });
      if (resp.thread.status) {
        applyStatus(resp.thread.status);
      }
    }
  } catch (err) {
    await teardown('thread-start-failed');
    throw new CodexAdapterError(
      `codex thread/start failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    exitCode,
    channelSink,
    shutdown: teardown,
  };
}

function signalNumber(signal: NodeJS.Signals): number | null {
  switch (signal) {
    case 'SIGINT':
      return 2;
    case 'SIGTERM':
      return 15;
    case 'SIGHUP':
      return 1;
    case 'SIGQUIT':
      return 3;
    default:
      return null;
  }
}
