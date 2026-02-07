# DevBridge MCP

> Make Claude Code / Codex your local AI IDE, while real code runs on remote servers.

DevBridge MCP is an MCP server that bridges **local AI coding clients** (Claude Code / Codex) with **remote Linux servers** through SSH.

## 1. Why This Project Exists

### Core pain points it solves

When you develop AI/ML systems, this is very common:

- You edit code on a local macOS laptop (good AI tools, good UX).
- Your GPU servers are remote (A100/H100, long-running jobs).
- Some remote servers are behind firewall / no international internet access.
- On those servers, you cannot directly use Claude Code / Codex.

DevBridge MCP solves this by using a **local MCP gateway**:

1. Claude Code / Codex runs on your local machine.
2. DevBridge MCP runs locally and manages SSH.
3. Commands execute on the remote server.
4. Output/logs/files return to local AI context.

So you still get:

- Local AI-assisted coding
- Remote execution and debugging
- Long-job log tracking
- Repeatable workflow (sync -> run -> inspect -> iterate)

### Typical workflow

```text
Local macOS (Claude/Codex edits code)
  -> auto/manual sync to remote
  -> remote run (short or long/nohup)
  -> stream/pull logs and results
  -> iterate quickly
```

## 2. Full Setup Tutorial

### 2.1 Prerequisites

- macOS / Linux local machine
- Node.js 18+
- SSH access to remote server
- `git`

Install and build:

```bash
cd remote-executor-mcp
npm install
npm run build
```

---

### 2.2 Step 1: Enable SSH key login (recommended, detailed)

This project is designed for key-based SSH.

#### A) Generate SSH keypair on local machine

```bash
ssh-keygen -t ed25519 -C "your_email@example.com"
```

Press Enter to use default path (`~/.ssh/id_ed25519`).

#### B) Get your public key

```bash
cat ~/.ssh/id_ed25519.pub
```

Copy the whole line (starts with `ssh-ed25519 ...`).

#### C) Put public key on remote server

Option 1 (recommended, if `ssh-copy-id` is available):

```bash
ssh-copy-id user@your-server-ip
```

Option 2 (manual):

```bash
# On local: append your public key into remote authorized_keys
cat ~/.ssh/id_ed25519.pub | ssh user@your-server-ip 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'
```

#### D) Configure SSH alias (`~/.ssh/config`)

```sshconfig
Host Los_dc03
  HostName 104.168.103.56
  User root
  Port 22
  IdentityFile ~/.ssh/id_ed25519
```

#### E) Verify no-password login

```bash
ssh Los_dc03
```

If login works without password prompt, SSH is ready.

---

### 2.3 Step 2: Configure Claude Code

Edit `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "remote-executor": {
      "command": "node",
      "args": ["/Users/keamy/Desktop/cc-remote/remote-executor-mcp/dist/index.js"]
    }
  }
}
```

Optional: in project `.claude/settings.local.json`, allow tool usage (including `dev_session_*`).

Restart Claude Code after config change.

#### Claude verification prompts

```text
请调用 list_servers
```

```text
测试连接 Los_dc03
```

```text
在 Los_dc03 上执行：hostname && uname -a
```

---

### 2.4 Step 3: Configure Codex

Add MCP server globally:

```bash
codex mcp add remote-executor -- node /Users/keamy/Desktop/cc-remote/remote-executor-mcp/dist/index.js
```

Verify:

```bash
codex mcp list
codex mcp get remote-executor
```

If you updated server code and want to refresh mount:

```bash
codex mcp remove remote-executor
codex mcp add remote-executor -- node /Users/keamy/Desktop/cc-remote/remote-executor-mcp/dist/index.js
```

#### Codex verification prompt

```text
先 list_servers，再 test_connection 到 Los_dc03，并返回摘要
```

---

### 2.5 Step 4: Verify end-to-end workflow

#### Short task loop

```text
把本地 ./test_cal 同步到 Los_dc03:/root/test_cal，然后运行 python3 /root/test_cal/calculate.py
```

#### Long task loop (nohup)

```text
在 Los_dc03 启动长任务（后台）：
cd /root/myproj && nohup python3 train.py > train.log 2>&1 &
然后持续查看日志
```

Or use fixed session tools (`dev_session_*`) below.

## 3. Tool Catalog (Latest)

| Category | Tool | Description |
|---|---|---|
| Basic Execution | `remote_execute` | Short synchronous command execution (<5 min) |
| Background Jobs | `remote_run_background` | Start long job via `nohup`, return PID + log path |
| Background Jobs | `remote_tail_log` | Read / follow log output |
| Background Jobs | `remote_check_process` | Check process by PID/name |
| Background Jobs | `remote_kill_process` | Stop process by signal |
| File Sync | `remote_sync` | Local -> Remote sync (`auto/rsync/scp`) |
| File Sync | `remote_pull` | Remote -> Local file/dir pull |
| Git | `remote_git_push` | Local add/commit/push to remote |
| Git | `remote_git_clone` | Clone remote repo to local |
| Git | `remote_git_pull_local` | Pull latest code to local repo |
| Git | `remote_git_init` | Initialize remote bare repo + deploy hook |
| Dev Session | `dev_session_start` | Start file-watch + auto sync + run workflow |
| Dev Session | `dev_session_status` | Inspect session state/log/result |
| Dev Session | `dev_session_stop` | Stop session (optional remote process kill) |
| Utility | `list_servers` | List configured SSH hosts/servers |
| Utility | `test_connection` | Verify SSH connectivity |

## 4. Fixed Workflow Examples

### 4.1 Short iterative development

```text
启动 short 会话：
- server: Los_dc03
- local_path: /path/to/local/project
- remote_path: /root/project
- remote_working_dir: /root/project
- mode: short
- short_command: python3 -m pytest -q
- method: auto
- exclude: [".git", "node_modules", "__pycache__", "*.log"]
- debounce_ms: 500
```

### 4.2 Long training session

```text
启动 long 会话：
- server: Los_dc03
- local_path: /path/to/local/project
- remote_path: /root/project
- remote_working_dir: /root/project
- mode: long
- long_command: bash -lc 'python3 train.py --epochs 10'
- method: auto
- poll_interval_seconds: 2
- log_lines: 120
- follow_seconds: 1
```

## 5. Security Notes

- Recommended auth mode: **SSH key login**.
- Password-only SSH is not recommended for this MCP workflow.
- Do not commit secrets (API keys, private keys, production configs).
- Prefer least-privilege server accounts if possible.

## 6. Open Source Collaboration

This project is open source and built for real-world remote AI dev workflows.

You are very welcome to:

- Open an **Issue** with your specific scenario/constraints.
- Propose feature improvements (sync strategy, session strategy, observability, etc.).
- Submit a **Pull Request** with bug fixes and enhancements.

Especially welcome:

- Enterprise/firewall-specific workflows
- Better cross-platform compatibility
- Better CI/testing coverage
- Better UX prompts and docs

Please keep contributions practical and reproducible.

## 7. Suggested Public Repo Name

If you want a more viral/distributable name, recommended:

- `devbridge-mcp` (recommended)
- `codebridge-mcp`
- `remote-loop-mcp`

## 8. License

MIT License.

If you fork/modify, please preserve attribution and keep improvements open where possible.
