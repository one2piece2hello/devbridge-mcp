#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import { readFileSync, existsSync, statSync, readdirSync, watch, FSWatcher } from "fs";
import { homedir } from "os";
import { join, posix as posixPath } from "path";

// ============================================================================
// 配置管理
// ============================================================================

interface ServerConfig {
  host: string;
  user: string;
  port?: number;
  identity_file?: string;
  remote_path?: string;
}

interface Config {
  servers: Record<string, ServerConfig>;
  default_server?: string;
}

function loadConfig(): Config {
  const configPaths = [
    join(process.cwd(), ".remote-executor.json"),
    join(homedir(), ".remote-executor.json"),
  ];

  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      try {
        const content = readFileSync(configPath, "utf-8");
        return JSON.parse(content);
      } catch (e) {
        console.error(`Failed to load config from ${configPath}:`, e);
      }
    }
  }

  return {
    servers: {},
    default_server: undefined,
  };
}

// ============================================================================
// SSH 命令执行与安全校验
// ============================================================================

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const SAFE_SERVER_RE = /^[A-Za-z0-9._-]+$/;
const SAFE_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
const SAFE_PROJECT_RE = /^[A-Za-z0-9._-]+$/;
const SAFE_SIGNAL_SET = new Set(["TERM", "KILL", "INT", "HUP"]);
const SAFE_SYNC_METHOD_SET = new Set(["auto", "rsync", "scp"]);
const CONTROL_CHAR_RE = /[\0\r\n]/;

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function assertNoControlChars(value: string, field: string): string {
  if (CONTROL_CHAR_RE.test(value)) {
    throw new Error(`${field} contains invalid control characters`);
  }
  return value;
}

function assertServerName(value: unknown, field: string = "server"): string {
  const serverName = assertNoControlChars(assertString(value, field), field);
  if (!SAFE_SERVER_RE.test(serverName)) {
    throw new Error(
      `${field} must match ${SAFE_SERVER_RE.toString()} (letters, numbers, ., _, -)`
    );
  }
  return serverName;
}

function assertProjectName(value: unknown): string {
  const projectName = assertNoControlChars(assertString(value, "project_name"), "project_name");
  if (!SAFE_PROJECT_RE.test(projectName)) {
    throw new Error(
      `project_name must match ${SAFE_PROJECT_RE.toString()} (letters, numbers, ., _, -)`
    );
  }
  return projectName;
}

function assertPath(value: unknown, field: string): string {
  return assertNoControlChars(assertString(value, field), field);
}

function assertPositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function assertTimeoutSeconds(value: unknown, field: string = "timeout"): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 86400) {
    throw new Error(`${field} must be a number between 1 and 86400 seconds`);
  }
  return value;
}

function assertBranch(value: unknown): string {
  const branch = assertNoControlChars(assertString(value, "branch"), "branch");
  if (!SAFE_BRANCH_RE.test(branch)) {
    throw new Error(`branch contains unsupported characters`);
  }
  if (
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("//") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.endsWith(".lock")
  ) {
    throw new Error(`branch format is invalid`);
  }
  return branch;
}

function assertSignal(value: unknown): string {
  const signal = assertNoControlChars(assertString(value, "signal"), "signal").toUpperCase();
  if (!SAFE_SIGNAL_SET.has(signal)) {
    throw new Error(`signal must be one of: ${Array.from(SAFE_SIGNAL_SET).join(", ")}`);
  }
  return signal;
}

function assertSyncMethod(value: unknown): "auto" | "rsync" | "scp" {
  const method = assertNoControlChars(assertString(value, "method"), "method").toLowerCase();
  if (!SAFE_SYNC_METHOD_SET.has(method)) {
    throw new Error(`method must be one of: ${Array.from(SAFE_SYNC_METHOD_SET).join(", ")}`);
  }
  return method as "auto" | "rsync" | "scp";
}

function assertDevSessionMode(value: unknown): DevSessionMode {
  const mode = assertNoControlChars(assertString(value, "mode"), "mode").toLowerCase();
  if (mode !== "short" && mode !== "long") {
    throw new Error("mode must be short or long");
  }
  return mode as DevSessionMode;
}

function assertStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((item, idx) =>
    assertNoControlChars(assertString(item, `${field}[${idx}]`), `${field}[${idx}]`)
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function shellQuoteArgs(parts: string[]): string {
  return parts.map((part) => shellQuote(part)).join(" ");
}

async function executeCommand(
  program: string,
  args: string[],
  timeoutMs: number = 300000,
  cwd?: string
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const proc = spawn(program, args, {
      timeout: timeoutMs,
      cwd: cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? -1,
      });
    });

    proc.on("error", (err) => {
      resolve({
        stdout: "",
        stderr: err.message,
        exitCode: -1,
      });
    });
  });
}

function buildSSHBaseArgs(server: string, config: Config): { args: string[]; target: string } {
  const serverName = assertServerName(server);
  const serverConfig = config.servers[serverName];
  const args: string[] = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ControlMaster=auto",
    "-o",
    "ControlPersist=300",
    "-o",
    "ControlPath=~/.ssh/remote-executor-%C",
  ];

  if (serverConfig) {
    if (serverConfig.port !== undefined) {
      const port = assertPositiveInt(serverConfig.port, "port");
      args.push("-p", String(port));
    }
    if (serverConfig.identity_file) {
      args.push("-i", assertPath(serverConfig.identity_file, "identity_file"));
    }
    const user = assertNoControlChars(assertString(serverConfig.user, "user"), "user");
    const host = assertNoControlChars(assertString(serverConfig.host, "host"), "host");
    return {
      args,
      target: `${user}@${host}`,
    };
  }

  return {
    args,
    target: serverName,
  };
}

function buildSSHArgs(server: string, config: Config, remoteCommand: string): string[] {
  const { args, target } = buildSSHBaseArgs(server, config);
  return [...args, target, remoteCommand];
}

function buildSCPArgs(
  server: string,
  config: Config,
  direction: "upload" | "download",
  localPath: string | string[],
  remotePath: string
): string[] {
  const { args, target } = buildSSHBaseArgs(server, config);
  const scpArgs: string[] = ["-r"];

  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === "-p") {
      scpArgs.push("-P", args[i + 1]);
    } else {
      scpArgs.push(args[i], args[i + 1]);
    }
  }

  // scp 在现代 OpenSSH (sftp 模式) 下会把引号当作字面量，不能像 shell 一样包裹远程路径
  const remoteSpec = `${target}:${remotePath}`;
  if (direction === "upload") {
    const localPaths = Array.isArray(localPath) ? localPath : [localPath];
    scpArgs.push(...localPaths, remoteSpec);
  } else {
    if (Array.isArray(localPath)) {
      throw new Error("download direction expects a single local path");
    }
    scpArgs.push(remoteSpec, localPath);
  }

  return scpArgs;
}

function buildRsyncSshCommand(server: string, config: Config): string {
  const { args } = buildSSHBaseArgs(server, config);
  const sshParts = ["ssh", ...args];
  return shellQuoteArgs(sshParts);
}

function buildRsyncRemoteTarget(server: string, config: Config, remotePath: string): string {
  const { target } = buildSSHBaseArgs(server, config);
  return `${target}:${shellQuote(remotePath)}`;
}

function resolveScpUploadRemoteMkdirPath(localPath: string, remotePath: string): string {
  try {
    const stats = statSync(localPath);
    if (stats.isFile()) {
      return posixPath.dirname(remotePath);
    }
  } catch {
    // local path 不存在时交给 scp 报错，这里不吞掉实际同步错误
  }
  return remotePath;
}

function resolveScpUploadLocalSources(localPath: string): string[] {
  try {
    const stats = statSync(localPath);
    if (stats.isDirectory()) {
      return readdirSync(localPath).map((name) => join(localPath, name));
    }
  } catch {
    // local path 不存在时交给 scp 报错
  }
  return [localPath];
}

function resolveRsyncSourcePath(localPath: string): string {
  try {
    const stats = statSync(localPath);
    if (stats.isDirectory()) {
      return localPath.endsWith("/") ? localPath : `${localPath}/`;
    }
  } catch {
    // local path 不存在时交给 rsync 报错
  }
  return localPath;
}

async function executeRemoteCommand(
  server: string,
  config: Config,
  remoteCommand: string,
  timeoutMs: number = 300000
): Promise<ExecResult> {
  const sshArgs = buildSSHArgs(server, config, remoteCommand);
  return executeCommand("ssh", sshArgs, timeoutMs);
}

function parseBackgroundPid(rawOutput: string): number | null {
  const lines = rawOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  // 优先解析带前缀的 PID，避免 MOTD 等额外输出干扰
  const marker = lines.find((line) => line.startsWith("__MCP_PID__"));
  if (marker) {
    const pid = parseInt(marker.replace("__MCP_PID__", ""), 10);
    if (!isNaN(pid) && pid > 0) return pid;
  }

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^\d+$/.test(lines[i])) {
      const pid = parseInt(lines[i], 10);
      if (!isNaN(pid) && pid > 0) return pid;
    }
  }

  return null;
}

function isNothingToCommit(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes("nothing to commit") || normalized.includes("nothing added to commit");
}

function isRsyncUnavailable(result: ExecResult): boolean {
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (result.exitCode === 127) return true;
  return (
    combined.includes("rsync: command not found") ||
    combined.includes("failed to exec rsync") ||
    combined.includes("remote command not found")
  );
}

interface SyncExecutionResult {
  success: boolean;
  method: "rsync" | "scp";
  exit_code: number;
  output: string;
  stderr: string;
  exclude: string[];
  delete_remote_extra: boolean;
  fallback_used: boolean;
  rsync_error?: string;
}

async function performRemoteSync(params: {
  server: string;
  local_path: string;
  remote_path: string;
  exclude?: string[];
  method?: "auto" | "rsync" | "scp";
  delete_remote_extra?: boolean;
}): Promise<SyncExecutionResult> {
  const safeServer = assertServerName(params.server);
  const safeLocalPath = assertPath(params.local_path, "local_path");
  const safeRemotePath = assertPath(params.remote_path, "remote_path");
  const safeExclude = params.exclude ? assertStringArray(params.exclude, "exclude") : [];
  const safeMethod = params.method ?? "auto";
  const safeDeleteRemoteExtra =
    typeof params.delete_remote_extra === "boolean" ? params.delete_remote_extra : false;
  const rsyncSourcePath = resolveRsyncSourcePath(safeLocalPath);

  let methodUsed: "rsync" | "scp" = "scp";
  let fallbackUsed = false;
  let result: ExecResult;
  let rsyncResult: ExecResult | undefined;

  if (safeMethod !== "scp") {
    const rsyncArgs: string[] = [
      "-az",
      "--partial",
      "--human-readable",
      "-e",
      buildRsyncSshCommand(safeServer, config),
    ];

    if (safeDeleteRemoteExtra) {
      rsyncArgs.push("--delete");
    }
    for (const pattern of safeExclude) {
      rsyncArgs.push("--exclude", pattern);
    }
    rsyncArgs.push(
      rsyncSourcePath,
      buildRsyncRemoteTarget(safeServer, config, safeRemotePath)
    );

    rsyncResult = await executeCommand("rsync", rsyncArgs, 600000);
    if (rsyncResult.exitCode === 0) {
      methodUsed = "rsync";
      result = rsyncResult;
    } else if (safeMethod === "auto" && isRsyncUnavailable(rsyncResult)) {
      fallbackUsed = true;
      const remoteMkdirPath = resolveScpUploadRemoteMkdirPath(safeLocalPath, safeRemotePath);
      const scpSourcePaths = resolveScpUploadLocalSources(safeLocalPath);
      await executeRemoteCommand(
        safeServer,
        config,
        `mkdir -p ${shellQuote(remoteMkdirPath)}`,
        30000
      );
      if (scpSourcePaths.length === 0) {
        result = { stdout: "", stderr: "", exitCode: 0 };
      } else {
        const scpArgs = buildSCPArgs(
          safeServer,
          config,
          "upload",
          scpSourcePaths,
          safeRemotePath
        );
        result = await executeCommand("scp", scpArgs, 600000);
      }
      methodUsed = "scp";
    } else {
      methodUsed = "rsync";
      result = rsyncResult;
    }
  } else {
    const remoteMkdirPath = resolveScpUploadRemoteMkdirPath(safeLocalPath, safeRemotePath);
    const scpSourcePaths = resolveScpUploadLocalSources(safeLocalPath);
    await executeRemoteCommand(
      safeServer,
      config,
      `mkdir -p ${shellQuote(remoteMkdirPath)}`,
      30000
    );
    if (scpSourcePaths.length === 0) {
      result = { stdout: "", stderr: "", exitCode: 0 };
    } else {
      const scpArgs = buildSCPArgs(
        safeServer,
        config,
        "upload",
        scpSourcePaths,
        safeRemotePath
      );
      result = await executeCommand("scp", scpArgs, 600000);
    }
    methodUsed = "scp";
  }

  return {
    success: result.exitCode === 0,
    method: methodUsed,
    exit_code: result.exitCode,
    output: result.stdout,
    stderr: result.stderr,
    exclude: safeExclude,
    delete_remote_extra: safeDeleteRemoteExtra,
    fallback_used: fallbackUsed,
    rsync_error:
      fallbackUsed && rsyncResult
        ? [rsyncResult.stdout, rsyncResult.stderr].filter(Boolean).join("\n")
        : undefined,
  };
}

// ============================================================================
// MCP Server 实现
// ============================================================================

const server = new Server(
  {
    name: "remote-executor",
    version: "2.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const config = loadConfig();

type DevSessionMode = "short" | "long";
type DevSessionState = "running" | "stopped" | "error";

interface DevSession {
  id: string;
  name: string;
  server: string;
  localPath: string;
  remotePath: string;
  remoteWorkingDir: string;
  exclude: string[];
  syncMethod: "auto" | "rsync" | "scp";
  deleteRemoteExtra: boolean;
  mode: DevSessionMode;
  shortCommand?: string;
  longCommand?: string;
  debounceMs: number;
  pollIntervalSeconds: number;
  logLines: number;
  followSeconds: number;
  watcher?: FSWatcher;
  debounceTimer?: NodeJS.Timeout;
  pollingTimer?: NodeJS.Timeout;
  running: boolean;
  pending: boolean;
  stopRequested: boolean;
  status: DevSessionState;
  startedAt: number;
  lastSyncAt?: number;
  lastRunAt?: number;
  syncCount: number;
  runCount: number;
  changedPaths: Set<string>;
  lastError?: string;
  lastOperation?: string;
  pid?: number;
  logFile?: string;
  lastSyncResult?: SyncExecutionResult;
  lastShortRun?: ExecResult;
  lastTailLog?: string;
  lastTailStderr?: string;
  lastProcessInfo?: string;
  isProcessRunning?: boolean;
}

const devSessions = new Map<string, DevSession>();

function assertSessionName(value: unknown): string {
  const name = assertNoControlChars(assertString(value, "session_name"), "session_name");
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error("session_name must contain only letters, numbers, ., _, -");
  }
  return name;
}

function createSessionId(name: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${name}-${Date.now().toString(36)}-${random}`;
}

function normalizeWatchPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function shouldIgnorePath(relativePath: string, excludePatterns: string[]): boolean {
  const normalized = normalizeWatchPath(relativePath);
  const base = posixPath.basename(normalized);
  for (const pattern of excludePatterns) {
    const p = normalizeWatchPath(pattern);
    if (!p.includes("*")) {
      if (p.includes("/")) {
        if (normalized === p || normalized.startsWith(`${p}/`)) return true;
      } else {
        if (normalized === p || normalized.includes(`/${p}/`) || base === p) return true;
      }
      continue;
    }

    const re = wildcardToRegex(p);
    if (p.includes("/")) {
      if (re.test(normalized)) return true;
    } else {
      if (re.test(base)) return true;
    }
  }
  return false;
}

function buildSessionSummary(session: DevSession) {
  return {
    id: session.id,
    name: session.name,
    status: session.status,
    mode: session.mode,
    server: session.server,
    local_path: session.localPath,
    remote_path: session.remotePath,
    remote_working_dir: session.remoteWorkingDir,
    started_at: new Date(session.startedAt).toISOString(),
    sync_count: session.syncCount,
    run_count: session.runCount,
    last_sync_at: session.lastSyncAt ? new Date(session.lastSyncAt).toISOString() : undefined,
    last_run_at: session.lastRunAt ? new Date(session.lastRunAt).toISOString() : undefined,
    pending_changes: Array.from(session.changedPaths).slice(0, 200),
    last_operation: session.lastOperation,
    last_error: session.lastError,
    pid: session.pid,
    log_file: session.logFile,
    is_process_running: session.isProcessRunning,
    last_process_info: session.lastProcessInfo,
    last_tail_log: session.lastTailLog,
    last_tail_stderr: session.lastTailStderr,
    last_sync_result: session.lastSyncResult,
    last_short_run: session.lastShortRun
      ? {
          exit_code: session.lastShortRun.exitCode,
          stdout: session.lastShortRun.stdout,
          stderr: session.lastShortRun.stderr,
        }
      : undefined,
  };
}

function markSessionError(session: DevSession, error: unknown): void {
  session.status = "error";
  session.lastError = error instanceof Error ? error.message : String(error);
}

function clearSessionTimers(session: DevSession): void {
  if (session.debounceTimer) {
    clearTimeout(session.debounceTimer);
    session.debounceTimer = undefined;
  }
  if (session.pollingTimer) {
    clearInterval(session.pollingTimer);
    session.pollingTimer = undefined;
  }
}

async function maybeStartLongTask(session: DevSession): Promise<void> {
  if (session.mode !== "long" || !session.longCommand) return;

  if (session.pid) {
    const checkRes = await executeRemoteCommand(
      session.server,
      config,
      `ps -p ${session.pid} -o pid=,stat=,etime=,command=`,
      15000
    );
    session.isProcessRunning = checkRes.exitCode === 0 && checkRes.stdout.trim().length > 0;
    session.lastProcessInfo = checkRes.stdout;
    if (session.isProcessRunning) return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const actualLogFile =
    session.logFile || `${session.remoteWorkingDir}/${session.name}_${timestamp}.log`;
  const bgCommand = `cd ${shellQuote(session.remoteWorkingDir)} && nohup ${session.longCommand} > ${shellQuote(actualLogFile)} 2>&1 < /dev/null & printf "__MCP_PID__%s\\n" "$!"`;

  const result = await executeRemoteCommand(session.server, config, bgCommand, 30000);
  const pid = parseBackgroundPid(result.stdout);
  if (result.exitCode !== 0 || pid === null) {
    throw new Error(`failed to start long task: ${result.stderr || result.stdout}`);
  }

  session.pid = pid;
  session.logFile = actualLogFile;
  session.isProcessRunning = true;
  session.runCount += 1;
  session.lastRunAt = Date.now();
  session.lastOperation = "long task started";
}

async function pollLongTask(session: DevSession): Promise<void> {
  if (session.mode !== "long") return;

  if (session.pid) {
    const checkRes = await executeRemoteCommand(
      session.server,
      config,
      `ps -p ${session.pid} -o pid=,stat=,etime=,command=`,
      15000
    );
    session.isProcessRunning = checkRes.exitCode === 0 && checkRes.stdout.trim().length > 0;
    session.lastProcessInfo = checkRes.stdout;
  }

  if (!session.logFile) return;

  let tailCmd: string;
  if (session.followSeconds > 0) {
    tailCmd = `if command -v timeout >/dev/null 2>&1; then timeout ${session.followSeconds} tail -f -n ${session.logLines} ${shellQuote(session.logFile)} 2>/dev/null || true; else tail -n ${session.logLines} ${shellQuote(session.logFile)}; fi`;
  } else {
    tailCmd = `tail -n ${session.logLines} ${shellQuote(session.logFile)}`;
  }

  const timeout = session.followSeconds > 0 ? (session.followSeconds + 5) * 1000 : 30000;
  const tailRes = await executeRemoteCommand(session.server, config, tailCmd, timeout);
  session.lastTailLog = tailRes.stdout;
  session.lastTailStderr = tailRes.stderr;
}

async function runDevSessionCycle(session: DevSession, reason: string): Promise<void> {
  if (session.stopRequested) return;

  if (session.running) {
    session.pending = true;
    return;
  }

  session.running = true;
  try {
    do {
      session.pending = false;
      session.status = "running";
      session.lastError = undefined;
      session.lastOperation = `sync (${reason})`;
      const syncResult = await performRemoteSync({
        server: session.server,
        local_path: session.localPath,
        remote_path: session.remotePath,
        exclude: session.exclude,
        method: session.syncMethod,
        delete_remote_extra: session.deleteRemoteExtra,
      });
      session.lastSyncResult = syncResult;
      session.syncCount += 1;
      session.lastSyncAt = Date.now();
      session.changedPaths.clear();

      if (!syncResult.success) {
        throw new Error(syncResult.stderr || `sync failed with exit code ${syncResult.exit_code}`);
      }

      if (session.mode === "short" && session.shortCommand) {
        session.lastOperation = "short command run";
        const command = `cd ${shellQuote(session.remoteWorkingDir)} && ${session.shortCommand}`;
        const runRes = await executeRemoteCommand(session.server, config, command, 300000);
        session.lastShortRun = runRes;
        session.runCount += 1;
        session.lastRunAt = Date.now();
        if (runRes.exitCode !== 0) {
          session.lastError = `short command failed with exit code ${runRes.exitCode}`;
        }
      } else if (session.mode === "long") {
        await maybeStartLongTask(session);
      }
    } while (session.pending && !session.stopRequested);
  } catch (error) {
    markSessionError(session, error);
  } finally {
    session.running = false;
  }
}

function scheduleDevSessionCycle(session: DevSession, reason: string): void {
  if (session.stopRequested) return;
  if (session.debounceTimer) {
    clearTimeout(session.debounceTimer);
  }
  session.debounceTimer = setTimeout(() => {
    void runDevSessionCycle(session, reason);
  }, session.debounceMs);
}

function startDevSessionWatcher(session: DevSession): void {
  const watcher = watch(
    session.localPath,
    { recursive: true },
    (_eventType, filename) => {
      if (session.stopRequested) return;
      if (!filename) {
        scheduleDevSessionCycle(session, "watch event");
        return;
      }
      const changed = normalizeWatchPath(filename.toString());
      if (shouldIgnorePath(changed, session.exclude)) return;
      session.changedPaths.add(changed);
      scheduleDevSessionCycle(session, changed);
    }
  );

  watcher.on("error", (error) => {
    markSessionError(session, error);
  });
  session.watcher = watcher;
}

// 工具列表
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      // ========== 基础执行 ==========
      {
        name: "remote_execute",
        description:
          "【短任务】在远程服务器上执行命令，同步等待完成并返回结果。适用于：ls、cat、pip install、简单脚本（< 5分钟）。超过 5 分钟的任务请用 remote_run_background。",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "服务器名称（SSH config 别名）",
            },
            command: {
              type: "string",
              description: "要执行的命令",
            },
            working_dir: {
              type: "string",
              description: "远程工作目录（可选）",
            },
            timeout: {
              type: "number",
              description: "超时时间（秒），默认 300",
            },
          },
          required: ["server", "command"],
        },
      },

      // ========== 后台任务（长时间运行） ==========
      {
        name: "remote_run_background",
        description:
          "【长任务】用 nohup 在后台启动任务，立即返回 PID 和日志路径。适用于：模型训练、数据处理、长时间脚本（> 5分钟）。启动后用 remote_tail_log 查看日志，remote_check_process 检查状态。",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "服务器名称",
            },
            command: {
              type: "string",
              description: "要执行的命令（如 python train.py）",
            },
            working_dir: {
              type: "string",
              description: "远程工作目录",
            },
            log_file: {
              type: "string",
              description: "日志文件路径（默认自动生成）",
            },
            task_name: {
              type: "string",
              description: "任务名称（用于标识）",
            },
          },
          required: ["server", "command", "working_dir"],
        },
      },
      {
        name: "remote_tail_log",
        description:
          "【长任务配套】查看后台任务的日志文件。可显示最后 N 行，或实时跟踪指定秒数。配合 remote_run_background 使用。",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "服务器名称",
            },
            log_file: {
              type: "string",
              description: "日志文件路径",
            },
            lines: {
              type: "number",
              description: "显示最后多少行，默认 50",
            },
            follow_seconds: {
              type: "number",
              description: "实时跟踪秒数（0 表示不跟踪，只显示当前内容）",
            },
          },
          required: ["server", "log_file"],
        },
      },
      {
        name: "remote_check_process",
        description:
          "【长任务配套】检查后台进程是否还在运行。通过 PID 或进程名查询。配合 remote_run_background 使用。",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "服务器名称",
            },
            pid: {
              type: "number",
              description: "进程 ID",
            },
            process_name: {
              type: "string",
              description: "进程名称（如 python）",
            },
            working_dir: {
              type: "string",
              description: "工作目录（用于更精确匹配）",
            },
          },
          required: ["server"],
        },
      },
      {
        name: "remote_kill_process",
        description: "【长任务配套】终止后台进程。通过 PID 杀死进程。",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "服务器名称",
            },
            pid: {
              type: "number",
              description: "进程 ID",
            },
            signal: {
              type: "string",
              description: "信号（默认 TERM，可选 KILL）",
            },
          },
          required: ["server", "pid"],
        },
      },

      // ========== 文件同步 ==========
      {
        name: "remote_sync",
        description:
          "将本地文件/目录同步到远程服务器。使用 rsync 或 scp。",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "目标服务器名称",
            },
            local_path: {
              type: "string",
              description: "本地文件或目录路径",
            },
            remote_path: {
              type: "string",
              description: "远程目标路径",
            },
            exclude: {
              type: "array",
              items: { type: "string" },
              description: "排除的文件模式（如 node_modules, .git）",
            },
            method: {
              type: "string",
              description: "同步方式：auto（默认，优先 rsync，失败回退 scp）、rsync、scp",
            },
            delete_remote_extra: {
              type: "boolean",
              description: "仅 rsync 有效：是否删除远程目标中本地已不存在的文件（默认 false）",
            },
          },
          required: ["server", "local_path", "remote_path"],
        },
      },
      {
        name: "remote_pull",
        description: "从远程服务器拉取文件/目录到本地。",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "源服务器名称",
            },
            remote_path: {
              type: "string",
              description: "远程文件或目录路径",
            },
            local_path: {
              type: "string",
              description: "本地目标路径",
            },
          },
          required: ["server", "remote_path", "local_path"],
        },
      },

      // ========== Git 操作（双向） ==========
      {
        name: "remote_git_push",
        description:
          "【本地→服务器】在指定本地目录执行 git add、commit、push 到服务器。代码会自动部署到服务器工作目录。必须指定 working_dir。",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "远程服务器名称（git remote 名称）",
            },
            commit_message: {
              type: "string",
              description: "Git commit 消息",
            },
            working_dir: {
              type: "string",
              description: "本地 Git 仓库目录（必填）",
            },
            branch: {
              type: "string",
              description: "分支名称，默认 main",
            },
          },
          required: ["server", "commit_message", "working_dir"],
        },
      },
      {
        name: "remote_git_clone",
        description:
          "【服务器→本地】首次从服务器 clone 仓库到本地。用于获取服务器上已有的代码。",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "服务器名称",
            },
            remote_repo_path: {
              type: "string",
              description: "服务器上的仓库路径（如 /root/repos/project.git 或 /root/projects/project）",
            },
            local_path: {
              type: "string",
              description: "本地目标路径",
            },
            branch: {
              type: "string",
              description: "分支名称，默认 main",
            },
          },
          required: ["server", "remote_repo_path", "local_path"],
        },
      },
      {
        name: "remote_git_pull_local",
        description:
          "【服务器→本地】在指定本地目录执行 git pull，从服务器拉取最新代码。必须指定 working_dir。",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "远程服务器名称（git remote 名称）",
            },
            working_dir: {
              type: "string",
              description: "本地 Git 仓库目录（必填）",
            },
            branch: {
              type: "string",
              description: "分支名称，默认 main",
            },
          },
          required: ["server", "working_dir"],
        },
      },
      {
        name: "remote_git_init",
        description:
          "【初始化】在服务器上创建 Git 仓库（bare repo + 工作目录 + 自动部署 hook）。新项目首次使用。",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "服务器名称",
            },
            project_name: {
              type: "string",
              description: "项目名称",
            },
            bare_repo_path: {
              type: "string",
              description: "bare 仓库路径，默认 /root/repos/<project>.git",
            },
            work_dir_path: {
              type: "string",
              description: "工作目录路径，默认 /root/projects/<project>",
            },
          },
          required: ["server", "project_name"],
        },
      },

      // ========== 固定化开发会话 ==========
      {
        name: "dev_session_start",
        description:
          "启动固定化开发会话：监听本地文件变化，自动同步到远程，并按模式执行（short 立即运行；long 后台运行并轮询日志）。",
        inputSchema: {
          type: "object",
          properties: {
            session_name: {
              type: "string",
              description: "会话名称（可选，默认 dev-session）",
            },
            server: {
              type: "string",
              description: "服务器名称",
            },
            local_path: {
              type: "string",
              description: "本地监听目录",
            },
            remote_path: {
              type: "string",
              description: "远程同步目录",
            },
            remote_working_dir: {
              type: "string",
              description: "远程执行工作目录（默认等于 remote_path）",
            },
            mode: {
              type: "string",
              description: "会话模式：short 或 long（默认 short）",
            },
            short_command: {
              type: "string",
              description: "short 模式下每次同步后执行的命令",
            },
            long_command: {
              type: "string",
              description: "long 模式下后台启动的命令（nohup）",
            },
            exclude: {
              type: "array",
              items: { type: "string" },
              description: "同步和监听排除规则（如 node_modules, *.log）",
            },
            method: {
              type: "string",
              description: "同步方式：auto（默认）/rsync/scp",
            },
            delete_remote_extra: {
              type: "boolean",
              description: "仅 rsync 生效，是否删除远程多余文件",
            },
            debounce_ms: {
              type: "number",
              description: "文件变更去抖时间，默认 800ms",
            },
            poll_interval_seconds: {
              type: "number",
              description: "long 模式日志轮询间隔，默认 5 秒",
            },
            log_lines: {
              type: "number",
              description: "long 模式每次读取日志行数，默认 80",
            },
            follow_seconds: {
              type: "number",
              description: "long 模式 tail -f 跟踪秒数，默认 1 秒",
            },
          },
          required: ["server", "local_path", "remote_path"],
        },
      },
      {
        name: "dev_session_status",
        description: "查看开发会话状态，并可选择立即触发一次同步/执行。",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "会话 ID",
            },
            trigger_now: {
              type: "boolean",
              description: "是否立即触发一次同步/执行（默认 false）",
            },
          },
          required: ["session_id"],
        },
      },
      {
        name: "dev_session_stop",
        description: "停止开发会话（可选：同时终止远程后台进程）。",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "会话 ID",
            },
            stop_remote_process: {
              type: "boolean",
              description: "若是 long 会话，是否终止远程进程（默认 false）",
            },
            signal: {
              type: "string",
              description: "终止信号（TERM/KILL/INT/HUP，默认 TERM）",
            },
          },
          required: ["session_id"],
        },
      },

      // ========== 工具 ==========
      {
        name: "list_servers",
        description: "列出所有配置的服务器和 SSH config 中的主机。",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "test_connection",
        description: "测试与远程服务器的 SSH 连接。",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "要测试的服务器名称",
            },
          },
          required: ["server"],
        },
      },
    ],
  };
});

// 工具调用处理
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // ========== 基础执行 ==========
      case "remote_execute": {
        const { server: serverName, command, working_dir, timeout = 300 } = args as {
          server: string;
          command: string;
          working_dir?: string;
          timeout?: number;
        };

        const safeServer = assertServerName(serverName);
        const safeCommand = assertString(command, "command");
        const safeTimeout = assertTimeoutSeconds(timeout, "timeout");

        let remoteCommand = safeCommand;
        if (working_dir) {
          const safeWorkingDir = assertPath(working_dir, "working_dir");
          remoteCommand = `cd ${shellQuote(safeWorkingDir)} && ${safeCommand}`;
        }

        const result = await executeRemoteCommand(safeServer, config, remoteCommand, safeTimeout * 1000);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: result.exitCode === 0,
                  exit_code: result.exitCode,
                  stdout: result.stdout,
                  stderr: result.stderr,
                  server: safeServer,
                  command: safeCommand,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // ========== 后台任务 ==========
      case "remote_run_background": {
        const {
          server: serverName,
          command,
          working_dir,
          log_file,
          task_name = "task",
        } = args as {
          server: string;
          command: string;
          working_dir: string;
          log_file?: string;
          task_name?: string;
        };

        const safeServer = assertServerName(serverName);
        const safeCommand = assertString(command, "command");
        const safeWorkingDir = assertPath(working_dir, "working_dir");
        const safeTaskName = task_name
          ? assertNoControlChars(assertString(task_name, "task_name"), "task_name")
          : "task";

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const actualLogFile = log_file
          ? assertPath(log_file, "log_file")
          : `${safeWorkingDir}/${safeTaskName}_${timestamp}.log`;

        // 使用 nohup 启动，并输出带标识的 PID，避免额外 stdout 干扰解析
        const bgCommand = `cd ${shellQuote(safeWorkingDir)} && nohup ${safeCommand} > ${shellQuote(actualLogFile)} 2>&1 < /dev/null & printf "__MCP_PID__%s\\n" "$!"`;

        const result = await executeRemoteCommand(safeServer, config, bgCommand, 30000);
        const pid = parseBackgroundPid(result.stdout);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: result.exitCode === 0 && pid !== null,
                  pid: pid,
                  log_file: actualLogFile,
                  server: safeServer,
                  command: safeCommand,
                  stderr: result.stderr,
                  message: `任务已在后台启动。使用 remote_tail_log 查看日志，remote_check_process 检查状态。`,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "remote_tail_log": {
        const {
          server: serverName,
          log_file,
          lines = 50,
          follow_seconds = 0,
        } = args as {
          server: string;
          log_file: string;
          lines?: number;
          follow_seconds?: number;
        };

        const safeServer = assertServerName(serverName);
        const safeLogFile = assertPath(log_file, "log_file");
        const safeLines = lines === undefined ? 50 : assertPositiveInt(lines, "lines");
        const safeFollow = follow_seconds === undefined ? 0 : follow_seconds;
        if (!Number.isInteger(safeFollow) || safeFollow < 0 || safeFollow > 86400) {
          throw new Error("follow_seconds must be an integer between 0 and 86400");
        }

        let tailCmd: string;

        if (safeFollow > 0) {
          // 实时跟踪模式：优先用 timeout，若不可用则降级为一次性 tail
          tailCmd = `if command -v timeout >/dev/null 2>&1; then timeout ${safeFollow} tail -f -n ${safeLines} ${shellQuote(safeLogFile)} 2>/dev/null || true; else tail -n ${safeLines} ${shellQuote(safeLogFile)}; fi`;
        } else {
          tailCmd = `tail -n ${safeLines} ${shellQuote(safeLogFile)}`;
        }

        const timeout = safeFollow > 0 ? (safeFollow + 5) * 1000 : 30000;
        const result = await executeRemoteCommand(safeServer, config, tailCmd, timeout);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  log_file: safeLogFile,
                  lines_requested: safeLines,
                  content: result.stdout,
                  stderr: result.stderr,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "remote_check_process": {
        const {
          server: serverName,
          pid,
          process_name,
          working_dir,
        } = args as {
          server: string;
          pid?: number;
          process_name?: string;
          working_dir?: string;
        };

        const safeServer = assertServerName(serverName);
        let checkCmd: string;
        let isRunning: boolean;

        if (pid) {
          const safePid = assertPositiveInt(pid, "pid");
          checkCmd = `ps -p ${safePid} -o pid=,stat=,etime=,command=`;
          const result = await executeRemoteCommand(safeServer, config, checkCmd, 15000);
          isRunning = result.exitCode === 0 && result.stdout.trim().length > 0;

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    is_running: isRunning,
                    pid: safePid,
                    process_info: result.stdout,
                    stderr: result.stderr,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } else if (process_name) {
          const safeProcessName = assertNoControlChars(
            assertString(process_name, "process_name"),
            "process_name"
          );
          if (working_dir) {
            const safeWorkingDir = assertPath(working_dir, "working_dir");
            checkCmd = `ps aux | grep -F -- ${shellQuote(safeProcessName)} | grep -F -- ${shellQuote(safeWorkingDir)} | grep -v grep || true`;
          } else {
            checkCmd = `ps aux | grep -F -- ${shellQuote(safeProcessName)} | grep -v grep || true`;
          }
        } else {
          checkCmd = `ps aux | head -20`;
        }

        const result = await executeRemoteCommand(safeServer, config, checkCmd, 15000);

        isRunning = result.stdout.trim().length > 0;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  is_running: isRunning,
                  pid: pid,
                  process_info: result.stdout,
                  stderr: result.stderr,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "remote_kill_process": {
        const {
          server: serverName,
          pid,
          signal = "TERM",
        } = args as {
          server: string;
          pid: number;
          signal?: string;
        };

        const safeServer = assertServerName(serverName);
        const safePid = assertPositiveInt(pid, "pid");
        const safeSignal = signal ? assertSignal(signal) : "TERM";
        const killCmd = `kill -s ${safeSignal} ${safePid}`;
        const result = await executeRemoteCommand(safeServer, config, killCmd, 10000);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: result.exitCode === 0,
                  pid: safePid,
                  signal: safeSignal,
                  output:
                    result.exitCode === 0
                      ? `Process ${safePid} killed with ${safeSignal}`
                      : "",
                  stderr: result.stderr,
                  exit_code: result.exitCode,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // ========== 文件同步 ==========
      case "remote_sync": {
        const {
          server: serverName,
          local_path,
          remote_path,
          exclude = [],
          method = "auto",
          delete_remote_extra = false,
        } = args as {
          server: string;
          local_path: string;
          remote_path: string;
          exclude?: string[];
          method?: string;
          delete_remote_extra?: boolean;
        };

        const safeMethod = assertSyncMethod(method);
        const syncResult = await performRemoteSync({
          server: serverName,
          local_path,
          remote_path,
          exclude,
          method: safeMethod,
          delete_remote_extra,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(syncResult, null, 2),
            },
          ],
        };
      }

      case "remote_pull": {
        const { server: serverName, remote_path, local_path } = args as {
          server: string;
          remote_path: string;
          local_path: string;
        };

        const safeServer = assertServerName(serverName);
        const safeRemotePath = assertPath(remote_path, "remote_path");
        const safeLocalPath = assertPath(local_path, "local_path");
        const scpArgs = buildSCPArgs(safeServer, config, "download", safeLocalPath, safeRemotePath);
        const result = await executeCommand("scp", scpArgs, 600000);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: result.exitCode === 0,
                  exit_code: result.exitCode,
                  output: result.stdout,
                  stderr: result.stderr,
                  local_path: safeLocalPath,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // ========== Git 操作 ==========
      case "remote_git_push": {
        const {
          server: serverName,
          commit_message,
          working_dir,
          branch = "main",
        } = args as {
          server: string;
          commit_message: string;
          working_dir: string;
          branch?: string;
        };

        const safeServer = assertServerName(serverName);
        const safeCommitMessage = assertNoControlChars(
          assertString(commit_message, "commit_message"),
          "commit_message"
        );
        const safeWorkingDir = assertPath(working_dir, "working_dir");
        const safeBranch = assertBranch(branch);

        const addResult = await executeCommand("git", ["add", "-A"], 60000, safeWorkingDir);
        if (addResult.exitCode !== 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: false,
                    step: "git add -A",
                    exit_code: addResult.exitCode,
                    working_dir: safeWorkingDir,
                    output: addResult.stdout,
                    stderr: addResult.stderr,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        const commitResult = await executeCommand(
          "git",
          ["commit", "-m", safeCommitMessage],
          60000,
          safeWorkingDir
        );
        const commitCombined = `${commitResult.stdout}\n${commitResult.stderr}`;
        const nothingToCommit = isNothingToCommit(commitCombined);
        const commitSuccess = commitResult.exitCode === 0 || nothingToCommit;

        if (!commitSuccess) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: false,
                    step: "git commit",
                    exit_code: commitResult.exitCode,
                    working_dir: safeWorkingDir,
                    output: commitResult.stdout,
                    stderr: commitResult.stderr,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        const pushResult = await executeCommand(
          "git",
          ["push", "-u", safeServer, safeBranch],
          60000,
          safeWorkingDir
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: pushResult.exitCode === 0,
                  exit_code: pushResult.exitCode,
                  working_dir: safeWorkingDir,
                  output: [commitResult.stdout, pushResult.stdout].filter(Boolean).join("\n"),
                  stderr: [commitResult.stderr, pushResult.stderr].filter(Boolean).join("\n"),
                  commit_skipped: nothingToCommit,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "remote_git_clone": {
        const {
          server: serverName,
          remote_repo_path,
          local_path,
          branch = "main",
        } = args as {
          server: string;
          remote_repo_path: string;
          local_path: string;
          branch?: string;
        };

        const safeServer = assertServerName(serverName);
        const safeRemoteRepoPath = assertPath(remote_repo_path, "remote_repo_path");
        const safeLocalPath = assertPath(local_path, "local_path");
        const safeBranch = assertBranch(branch);

        const cloneUrl = `${safeServer}:${safeRemoteRepoPath}`;
        const result = await executeCommand(
          "git",
          ["clone", "-b", safeBranch, cloneUrl, safeLocalPath],
          120000
        );

        // 如果 clone 成功，添加远程
        if (result.exitCode === 0) {
          await executeCommand(
            "git",
            ["remote", "rename", "origin", safeServer],
            10000,
            safeLocalPath
          );
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: result.exitCode === 0,
                  exit_code: result.exitCode,
                  local_path: safeLocalPath,
                  remote: `${safeServer}:${safeRemoteRepoPath}`,
                  output: result.stdout,
                  stderr: result.stderr,
                  hint: result.exitCode === 0
                    ? `Clone 成功！使用 'git push ${safeServer} ${safeBranch}' 推送更改。`
                    : undefined,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "remote_git_pull_local": {
        const {
          server: serverName,
          working_dir,
          branch = "main",
        } = args as {
          server: string;
          working_dir: string;
          branch?: string;
        };

        const safeServer = assertServerName(serverName);
        const safeWorkingDir = assertPath(working_dir, "working_dir");
        const safeBranch = assertBranch(branch);
        const result = await executeCommand(
          "git",
          ["pull", safeServer, safeBranch],
          60000,
          safeWorkingDir
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: result.exitCode === 0,
                  exit_code: result.exitCode,
                  working_dir: safeWorkingDir,
                  output: result.stdout,
                  stderr: result.stderr,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "remote_git_init": {
        const {
          server: serverName,
          project_name,
          bare_repo_path,
          work_dir_path,
        } = args as {
          server: string;
          project_name: string;
          bare_repo_path?: string;
          work_dir_path?: string;
        };

        const safeServer = assertServerName(serverName);
        const safeProjectName = assertProjectName(project_name);
        const actualBareRepo = bare_repo_path
          ? assertPath(bare_repo_path, "bare_repo_path")
          : `/root/repos/${safeProjectName}.git`;
        const actualWorkDir = work_dir_path
          ? assertPath(work_dir_path, "work_dir_path")
          : `/root/projects/${safeProjectName}`;

        // 创建 bare repo, 工作目录, 和 post-receive hook
        const hookContent = `#!/bin/bash
cd ${shellQuote(actualBareRepo)}
GIT_WORK_TREE=${shellQuote(actualWorkDir)} git checkout -f main 2>/dev/null || GIT_WORK_TREE=${shellQuote(actualWorkDir)} git checkout -f master
echo "deployed to ${actualWorkDir}"`;

        const hookBase64 = Buffer.from(hookContent).toString("base64");

        const initScript = `mkdir -p ${shellQuote(actualBareRepo)} ${shellQuote(actualWorkDir)} && cd ${shellQuote(actualBareRepo)} && git init --bare && printf %s ${shellQuote(hookBase64)} | base64 -d > hooks/post-receive && chmod +x hooks/post-receive && echo "Git 仓库初始化完成"`;

        const result = await executeRemoteCommand(safeServer, config, initScript, 30000);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: result.exitCode === 0,
                  bare_repo: actualBareRepo,
                  work_dir: actualWorkDir,
                  git_remote_url: `${safeServer}:${actualBareRepo}`,
                  output: result.stdout,
                  stderr: result.stderr,
                  next_steps: result.exitCode === 0 ? [
                    `本地添加远程: git remote add ${safeServer} ${safeServer}:${actualBareRepo}`,
                    `推送代码: git push -u ${safeServer} main`,
                    `代码会自动部署到: ${actualWorkDir}`,
                  ] : undefined,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // ========== 固定化开发会话 ==========
      case "dev_session_start": {
        const {
          session_name = "dev-session",
          server: serverName,
          local_path,
          remote_path,
          remote_working_dir,
          mode = "short",
          short_command,
          long_command,
          exclude = [],
          method = "auto",
          delete_remote_extra = false,
          debounce_ms = 800,
          poll_interval_seconds = 5,
          log_lines = 80,
          follow_seconds = 1,
        } = args as {
          session_name?: string;
          server: string;
          local_path: string;
          remote_path: string;
          remote_working_dir?: string;
          mode?: string;
          short_command?: string;
          long_command?: string;
          exclude?: string[];
          method?: string;
          delete_remote_extra?: boolean;
          debounce_ms?: number;
          poll_interval_seconds?: number;
          log_lines?: number;
          follow_seconds?: number;
        };

        const safeSessionName = assertSessionName(session_name);
        const safeServer = assertServerName(serverName);
        const safeLocalPath = assertPath(local_path, "local_path");
        const safeRemotePath = assertPath(remote_path, "remote_path");
        const safeRemoteWorkingDir = remote_working_dir
          ? assertPath(remote_working_dir, "remote_working_dir")
          : safeRemotePath;
        const safeMode = assertDevSessionMode(mode);
        const safeExclude = assertStringArray(exclude, "exclude");
        const safeMethod = assertSyncMethod(method);
        const safeDeleteRemoteExtra =
          typeof delete_remote_extra === "boolean" ? delete_remote_extra : false;
        const safeDebounceMs = assertPositiveInt(debounce_ms, "debounce_ms");
        const safePollInterval = assertPositiveInt(
          poll_interval_seconds,
          "poll_interval_seconds"
        );
        const safeLogLines = assertPositiveInt(log_lines, "log_lines");
        if (!Number.isInteger(follow_seconds) || follow_seconds < 0 || follow_seconds > 86400) {
          throw new Error("follow_seconds must be an integer between 0 and 86400");
        }
        const safeFollowSeconds = follow_seconds;

        let safeShortCommand: string | undefined;
        let safeLongCommand: string | undefined;
        if (safeMode === "short") {
          if (!short_command) {
            throw new Error("short mode requires short_command");
          }
          safeShortCommand = assertString(short_command, "short_command");
        } else {
          if (!long_command) {
            throw new Error("long mode requires long_command");
          }
          safeLongCommand = assertString(long_command, "long_command");
        }

        const sessionId = createSessionId(safeSessionName);
        const session: DevSession = {
          id: sessionId,
          name: safeSessionName,
          server: safeServer,
          localPath: safeLocalPath,
          remotePath: safeRemotePath,
          remoteWorkingDir: safeRemoteWorkingDir,
          exclude: safeExclude,
          syncMethod: safeMethod,
          deleteRemoteExtra: safeDeleteRemoteExtra,
          mode: safeMode,
          shortCommand: safeShortCommand,
          longCommand: safeLongCommand,
          debounceMs: safeDebounceMs,
          pollIntervalSeconds: safePollInterval,
          logLines: safeLogLines,
          followSeconds: safeFollowSeconds,
          running: false,
          pending: false,
          stopRequested: false,
          status: "running",
          startedAt: Date.now(),
          syncCount: 0,
          runCount: 0,
          changedPaths: new Set<string>(),
          lastOperation: "session created",
        };

        devSessions.set(sessionId, session);
        try {
          startDevSessionWatcher(session);
          if (safeMode === "long") {
            session.pollingTimer = setInterval(() => {
              if (session.stopRequested) return;
              void pollLongTask(session).catch((error) => {
                markSessionError(session, error);
              });
            }, safePollInterval * 1000);
          }

          await runDevSessionCycle(session, "session start");
          if (safeMode === "long") {
            await pollLongTask(session);
          }
        } catch (error) {
          markSessionError(session, error);
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: session.status !== "error",
                  session: buildSessionSummary(session),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "dev_session_status": {
        const { session_id, trigger_now = false } = args as {
          session_id: string;
          trigger_now?: boolean;
        };
        const safeSessionId = assertNoControlChars(assertString(session_id, "session_id"), "session_id");
        const session = devSessions.get(safeSessionId);
        if (!session) {
          throw new Error(`session not found: ${safeSessionId}`);
        }

        if (trigger_now) {
          await runDevSessionCycle(session, "manual trigger");
        }
        if (session.mode === "long") {
          await pollLongTask(session);
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: session.status !== "error",
                  session: buildSessionSummary(session),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "dev_session_stop": {
        const { session_id, stop_remote_process = false, signal = "TERM" } = args as {
          session_id: string;
          stop_remote_process?: boolean;
          signal?: string;
        };
        const safeSessionId = assertNoControlChars(assertString(session_id, "session_id"), "session_id");
        const session = devSessions.get(safeSessionId);
        if (!session) {
          throw new Error(`session not found: ${safeSessionId}`);
        }

        session.stopRequested = true;
        session.status = "stopped";
        session.lastOperation = "session stopped";
        clearSessionTimers(session);

        if (session.watcher) {
          try {
            session.watcher.close();
          } catch {
            // ignore
          }
          session.watcher = undefined;
        }

        let killResult:
          | {
              success: boolean;
              pid?: number;
              signal?: string;
              exit_code: number;
              stderr: string;
            }
          | undefined;

        if (stop_remote_process && session.mode === "long" && session.pid) {
          const safeSignal = assertSignal(signal);
          const killRes = await executeRemoteCommand(
            session.server,
            config,
            `kill -s ${safeSignal} ${session.pid}`,
            10000
          );
          const alreadyExited = /no such process/i.test(killRes.stderr);
          const killSuccess = killRes.exitCode === 0 || alreadyExited;
          session.isProcessRunning = killSuccess ? false : true;
          killResult = {
            success: killSuccess,
            pid: session.pid,
            signal: safeSignal,
            exit_code: killRes.exitCode,
            stderr: killRes.stderr,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  session: buildSessionSummary(session),
                  kill_result: killResult,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // ========== 工具 ==========
      case "list_servers": {
        const sshConfigPath = join(homedir(), ".ssh", "config");
        let sshHosts: string[] = [];

        if (existsSync(sshConfigPath)) {
          const sshConfig = readFileSync(sshConfigPath, "utf-8");
          const hostMatches = sshConfig.match(/^Host\s+(\S+)/gm);
          if (hostMatches) {
            sshHosts = hostMatches
              .map((h) => h.replace(/^Host\s+/, ""))
              .filter((h) => !h.includes("*"));
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  configured_servers: Object.keys(config.servers),
                  ssh_config_hosts: sshHosts,
                  default_server: config.default_server,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "test_connection": {
        const { server: serverName } = args as { server: string };
        const safeServer = assertServerName(serverName);
        const result = await executeRemoteCommand(
          safeServer,
          config,
          `echo "Connection successful" && hostname && uname -a`,
          10000
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: result.exitCode === 0,
                  server: safeServer,
                  output: result.stdout,
                  error: result.stderr,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
            null,
            2
          ),
        },
      ],
    };
  }
});

// 启动服务器
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Remote Executor MCP Server v2.0 running on stdio");
}

main().catch(console.error);
