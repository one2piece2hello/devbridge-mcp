# DevBridge MCP Launch Kit (ZH/EN)

This file provides ready-to-copy content for:

- GitHub Release
- First launch post
- Community call for issues and PRs

## 1. GitHub Release Template (Chinese)

### Title

`DevBridge MCP v1.0.0 - 本地 AI 编程, 远程服务器执行`

### Body

```markdown
## DevBridge MCP v1.0.0

DevBridge MCP 是一个 MCP 服务，用来连接本地 AI 编程客户端（Claude Code / Codex）和远程 Linux 服务器。

### 解决的问题

- 本地编辑体验好，但算力在远程 GPU 服务器
- 部分服务器无法直连国际互联网，无法直接使用 Claude Code / Codex
- 远程长任务调试成本高（日志查看、状态追踪、反复同步）

### 核心能力

- 远程命令执行（短任务）
- nohup 后台任务与日志追踪（长任务）
- 本地 <-> 远程代码同步（rsync/scp）
- 开发会话（监听文件变化 -> 自动同步 -> 自动执行）
- Git 协作辅助

### 支持场景

- 本地 macOS 上使用 Claude Code / Codex 编码
- 远程 Linux 服务器运行训练/推理/测试
- 固定化迭代工作流（编辑 -> 同步 -> 执行 -> 查看结果 -> 继续）

### 快速开始

1. 配置本机到服务器的 SSH 密钥登录
2. 在 Claude Code / Codex 中挂载本 MCP
3. 调用 `test_connection` / `remote_sync` / `remote_execute` 验证链路

文档：README + TUTORIAL_CN

---

欢迎提交：

- Issue（你的具体场景和限制）
- PR（功能增强、Bug 修复、文档改进）
```

## 2. GitHub Release Template (English)

### Title

`DevBridge MCP v1.0.0 - Local AI coding, remote execution`

### Body

```markdown
## DevBridge MCP v1.0.0

DevBridge MCP bridges local AI coding clients (Claude Code / Codex) with remote Linux servers via SSH.

### Problems this solves

- Best coding UX is local, while compute lives on remote GPU servers
- Some servers are behind firewall/no international internet and cannot run Claude Code/Codex directly
- Remote long-job iteration is slow (sync, run, inspect logs, repeat)

### Core capabilities

- Remote command execution for short tasks
- nohup background jobs with log tailing for long tasks
- Local <-> remote sync (`rsync`/`scp`)
- Dev session workflow (watch -> sync -> run)
- Git-oriented collaboration helpers

### Typical workflow

Local macOS coding (Claude/Codex)
-> sync to remote
-> run on remote
-> stream/pull logs
-> iterate quickly

### Quick start

1. Configure SSH key login
2. Mount this MCP in Claude Code or Codex
3. Verify with `test_connection`, `remote_sync`, `remote_execute`

Docs: README + TUTORIAL_CN

---

Contributions are welcome:

- Open issues with your concrete constraints
- Submit PRs for improvements/fixes/docs
```

## 3. First Launch Post Template (Chinese)

```markdown
我把 DevBridge MCP 开源了：
[https://github.com/one2piece2hello/devbridge-mcp](https://github.com/one2piece2hello/devbridge-mcp)

一句话：让 Claude Code / Codex 在本地写代码，但在远程服务器执行和调试。

适合：
- 本地 macOS 开发 + 远程 GPU 训练
- 服务器受防火墙限制，无法直接跑 Claude/Codex

支持：
- 远程执行
- nohup 后台任务 + 日志追踪
- 本地/远程同步
- 固定化开发会话（改代码后自动同步和执行）

欢迎提 Issue/PR，告诉我你的真实场景，我会持续迭代。
```

## 4. First Launch Post Template (English)

```markdown
I open-sourced DevBridge MCP:
[https://github.com/one2piece2hello/devbridge-mcp](https://github.com/one2piece2hello/devbridge-mcp)

One-line pitch: keep Claude Code/Codex local, run/debug code on remote servers.

Built for:
- local macOS coding + remote GPU training
- firewall-restricted servers that cannot run Claude/Codex directly

Includes:
- remote execution
- nohup background jobs + log tracking
- local/remote sync
- fixed dev session workflow (watch -> sync -> run)

Issues and PRs are very welcome. Share your constraints and I will keep improving it.
```

## 5. Suggested tags

- `mcp`
- `claude-code`
- `codex`
- `ssh`
- `remote-development`
- `ai-engineering`
