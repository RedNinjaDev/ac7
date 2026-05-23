/**
 * Per-runner ephemeral `CODEX_HOME` directory.
 *
 * Why we don't edit `~/.codex/config.toml` directly:
 *   - It's the user's HOME-level config and likely contains MCP server
 *     entries, profile defaults, etc. that we shouldn't merge into.
 *   - Multi-slot runs would race on the same file.
 *   - Backup/restore semantics for HOME-level state are scarier than
 *     for per-project state — a botched restore loses real config.
 *
 * Instead, every `ac7 codex` invocation gets its own temporary
 * `CODEX_HOME`. We pass `CODEX_HOME=<dir>` to the spawned `codex
 * app-server`; codex reads ALL of its config (auth, config.toml,
 * sessions/) from that root, so we control it completely.
 *
 * Layout we create:
 *
 *   <ac7-codex-home>/
 *     auth.json       ← symlink to user's ~/.codex/auth.json (so OAuth
 *                       refreshes from the real codex login persist)
 *     config.toml     ← our own minimal config: just the [mcp_servers.ac7]
 *                       block pointing at `ac7 mcp-bridge`
 *
 * On runner close, the entire directory is removed. Symlinks make the
 * cleanup safe — we never delete the real auth.json.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * A local or self-hosted OpenAI-compatible model provider.
 *
 * When provided, `renderConfigToml` emits a `[model_providers.<name>]`
 * block plus `model_provider = "<name>"` so codex routes its API calls
 * to the given endpoint instead of OpenAI.
 */
export interface ModelProviderOptions {
  /**
   * Short identifier used as the TOML table key and the `model_provider`
   * directive value, e.g. `qwen` or `local`.
   */
  name: string;
  /**
   * Base URL for the OpenAI-compatible endpoint, e.g.
   * `http://localhost:8000/v1`.
   */
  baseUrl: string;
  /**
   * Wire protocol. `chat` selects the `/v1/chat/completions` endpoint;
   * `responses` selects the newer Responses API. Defaults to `chat`.
   */
  wireApi?: 'chat' | 'responses';
  /**
   * Name of the environment variable that holds the API key for this
   * provider. Defaults to `OPENAI_API_KEY`. Local servers typically
   * accept any non-empty value.
   */
  envKey?: string;
}

export interface CodexHomeOptions {
  /**
   * Path to the user's real codex home. Defaults to `~/.codex`.
   * Used only to symlink `auth.json` from. Tests override this so they
   * can run without touching the real codex login.
   */
  realCodexHome?: string;
  /**
   * Parent directory for our ephemeral home. Defaults to
   * `$XDG_CACHE_HOME/agentc7/codex` (or `~/.cache/agentc7/codex`).
   * NOT `$TMPDIR`: codex refuses to install helper binaries under
   * tmpfs and emits a `Refusing to create helper binaries under
   * temporary dir` warning, which means tooling like the apply-patch
   * helper isn't available to the agent.
   */
  parentDir?: string;
  /**
   * What `command` to write into the `[mcp_servers.ac7]` block. Always
   * `process.execPath` in production so codex spawns the same node
   * binary the runner is running under (no PATH dance).
   */
  bridgeCommand: string;
  /** Args to pass to the bridge command (`['<cli-entry>', 'mcp-bridge']`). */
  bridgeArgs: string[];
  /** Path to the runner's IPC socket — bridge env. */
  runnerSocketPath: string;
  /** Optional extra env vars to put on the bridge subprocess. */
  bridgeExtraEnv?: Record<string, string>;
  /**
   * When set, configures a local or self-hosted OpenAI-compatible
   * provider. The generated `config.toml` will contain a
   * `[model_providers.<name>]` block and `model_provider = "<name>"`
   * so codex routes to the given endpoint instead of OpenAI.
   *
   * The `auth.json` symlink is still attempted but is non-fatal when
   * absent — local providers don't require OpenAI credentials.
   */
  modelProvider?: ModelProviderOptions;
}

export interface CodexHomeHandle {
  /** Absolute path to set as `CODEX_HOME` on the spawned codex. */
  readonly path: string;
  /** Absolute path of the config.toml we wrote (for diagnostics). */
  readonly configPath: string;
  /**
   * Whether we successfully linked the user's auth.json. When false,
   * codex will need to login on first connect (or fail with an auth
   * error). The CLI prints a helpful hint in this case.
   */
  readonly authLinked: boolean;
  /** Best-effort recursive removal. Idempotent. */
  remove(): void;
}

export class CodexHomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexHomeError';
  }
}

export function setupCodexHome(options: CodexHomeOptions): CodexHomeHandle {
  const realHome = options.realCodexHome ?? join(homedir(), '.codex');
  const parent =
    options.parentDir ??
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'agentc7', 'codex');
  // mkdtempSync needs the parent to exist.
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'ac7-codex-'));

  let authLinked = false;
  const realAuth = join(realHome, 'auth.json');
  if (existsSync(realAuth)) {
    try {
      symlinkSync(realAuth, join(dir, 'auth.json'));
      authLinked = true;
    } catch (err) {
      // Symlink can fail on Windows without privileges or on some
      // FUSE mounts. We fall through and let codex attempt its own
      // login — the CLI surfaces a hint about this.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`ac7 codex: warning — could not link auth.json: ${msg}\n`);
    }
  }

  const configPath = resolve(dir, 'config.toml');
  writeFileSync(configPath, renderConfigToml(options), { mode: 0o600 });

  let removed = false;
  return {
    path: dir,
    configPath,
    authLinked,
    remove() {
      if (removed) return;
      removed = true;
      try {
        // `rm -rf`. The auth.json entry is a symlink so this only
        // removes the link, not the real file.
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

/**
 * Format the config.toml we hand to codex. We hand-write rather than
 * using a TOML library because the shape is fixed and the strings we
 * embed are tightly controlled (paths, env values) — we know what
 * needs escaping.
 *
 * The settings we set explicitly:
 *   - `[mcp_servers.ac7]` — points at `ac7 mcp-bridge`
 *   - `default_tools_approval_mode = "approve"` — the bridge's tools are
 *     trusted by definition (team authority is the access control), so
 *     codex must auto-approve every call. The enum is
 *     `auto | prompt | approve` (snake_case); `approve` is the explicit
 *     always-approve mode. `auto` defaults to the global per-tool policy
 *     and would still escalate some calls.
 *   - `enabled = true` — explicit, in case codex ever defaults the
 *     other way
 */
function renderConfigToml(opts: CodexHomeOptions): string {
  const env: Record<string, string> = {
    AC7_RUNNER_SOCKET: opts.runnerSocketPath,
    ...(opts.bridgeExtraEnv ?? {}),
  };
  const lines = [
    '# Auto-generated by ac7 codex runner — do not edit.',
    '# Lifetime: this entire CODEX_HOME directory is ephemeral.',
    '',
  ];

  if (opts.modelProvider) {
    const p = opts.modelProvider;
    lines.push(`model_provider = ${tomlString(p.name)}`, '');
    lines.push(`[model_providers.${p.name}]`);
    lines.push(`base_url = ${tomlString(p.baseUrl)}`);
    lines.push(`wire_api = ${tomlString(p.wireApi ?? 'chat')}`);
    lines.push(`env_key = ${tomlString(p.envKey ?? 'OPENAI_API_KEY')}`);
    lines.push('');
  }

  lines.push(
    '[mcp_servers.ac7]',
    `command = ${tomlString(opts.bridgeCommand)}`,
    `args = ${tomlStringArray(opts.bridgeArgs)}`,
    'enabled = true',
    'default_tools_approval_mode = "approve"',
    '',
    '[mcp_servers.ac7.env]',
    ...Object.entries(env).map(([k, v]) => `${k} = ${tomlString(v)}`),
    '',
  );
  return `${lines.join('\n')}\n`;
}

function tomlString(s: string): string {
  // TOML basic strings: double-quoted, with these mandatory escapes.
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

function tomlStringArray(arr: string[]): string {
  return `[${arr.map(tomlString).join(', ')}]`;
}
