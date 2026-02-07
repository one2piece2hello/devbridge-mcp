# Remote Executor MCP 小白使用教程

> 本教程假设你是完全的新手，会一步一步教你配置和使用。

---

## 目录

1. [前提条件检查](#1-前提条件检查)
2. [配置 SSH 免密登录](#2-配置-ssh-免密登录)
3. [配置 Claude Code 使用 MCP](#3-配置-claude-code-使用-mcp)
4. [验证 MCP 是否工作](#4-验证-mcp-是否工作)
5. [实际使用示例](#5-实际使用示例)
6. [常见问题解答](#6-常见问题解答)

---

## 1. 前提条件检查

### 1.1 检查 SSH 是否可以连接

打开终端 (Terminal)，输入：

```bash
ssh Los_dc03
```

**如果看到类似这样的提示，说明连接成功：**
```
Welcome to Ubuntu 22.04.1 LTS
root@server:~#
```

输入 `exit` 退出。

**如果提示输入密码**，说明你还没配置好密钥，请看第 2 节。

**如果连接失败**，请检查：
- 网络是否正常
- `~/.ssh/config` 文件是否存在

### 1.2 检查你的 SSH Config

```bash
cat ~/.ssh/config
```

你应该看到类似这样的内容：
```
Host Los_dc03
  HostName 104.168.103.56
  User root
  Port 22
```

如果没有，手动创建：
```bash
nano ~/.ssh/config
```

粘贴以下内容，然后按 `Ctrl+X`，按 `Y`，按 `Enter` 保存：
```
Host Los_dc03
  HostName 104.168.103.56
  User root
  Port 22
  IdentityFile ~/.ssh/id_rsa
```

---

## 2. 配置 SSH 免密登录

> 如果你已经可以免密登录 `ssh Los_dc03`，跳过这一节。

### 2.1 检查是否有 SSH 密钥

```bash
ls -la ~/.ssh/
```

如果看到 `id_rsa` 和 `id_rsa.pub`，说明已有密钥，跳到 2.3。

### 2.2 生成 SSH 密钥（如果没有）

```bash
ssh-keygen -t rsa -b 4096
```

一路按 Enter（使用默认设置，不设置密码）。

### 2.3 复制公钥到服务器

**方法 A：使用 ssh-copy-id（推荐）**
```bash
ssh-copy-id root@104.168.103.56
```
输入服务器密码，完成后就可以免密登录了。

**方法 B：手动复制（如果 ssh-copy-id 不可用）**
```bash
# 显示你的公钥
cat ~/.ssh/id_rsa.pub
```

复制输出的内容（以 `ssh-rsa` 开头的一长串）。

然后登录服务器：
```bash
ssh root@104.168.103.56
# 输入密码
```

在服务器上执行：
```bash
mkdir -p ~/.ssh
echo "粘贴你的公钥内容" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
exit
```

### 2.4 验证免密登录

```bash
ssh Los_dc03
```

如果直接进入服务器，没有要求输入密码，说明配置成功！

---

## 3. 配置 Claude Code 使用 MCP

### 3.1 MCP Server 已经构建好了

MCP Server 在这个位置：
```
/Users/keamy/Desktop/cc-remote/remote-executor-mcp/dist/index.js
```

### 3.2 配置 Claude Code

**步骤 1：打开 Claude Code 设置文件**

```bash
# 创建 .claude 目录（如果不存在）
mkdir -p ~/.claude

# 编辑设置文件
nano ~/.claude/settings.json
```

**步骤 2：粘贴以下内容**

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

按 `Ctrl+X`，按 `Y`，按 `Enter` 保存。

**步骤 3：（可选）如果已有 settings.json**

如果文件已存在且有其他配置，只需在 `mcpServers` 里添加 `remote-executor`：

```json
{
  "其他配置": "...",
  "mcpServers": {
    "已有的mcp": { ... },
    "remote-executor": {
      "command": "node",
      "args": ["/Users/keamy/Desktop/cc-remote/remote-executor-mcp/dist/index.js"]
    }
  }
}
```

### 3.3 重启 Claude Code

**非常重要！** MCP 配置修改后必须重启 Claude Code：

1. 如果正在运行 Claude Code，输入 `/exit` 或按 `Ctrl+C` 退出
2. 重新启动：
   ```bash
   claude
   ```

---

## 4. 验证 MCP 是否工作

### 4.1 启动 Claude Code

```bash
claude
```

### 4.2 测试 MCP 工具

在 Claude Code 中输入：

```
请列出可用的远程服务器
```

Claude 会调用 `list_servers` 工具，你应该看到类似：
```json
{
  "configured_servers": [],
  "ssh_config_hosts": ["Los_dc03"],
  "default_server": null
}
```

### 4.3 测试连接

输入：
```
测试连接到 Los_dc03 服务器
```

Claude 会调用 `test_connection` 工具，成功的话会显示：
```json
{
  "success": true,
  "server": "Los_dc03",
  "output": "Connection successful\nserver-hostname\nLinux..."
}
```

---

## 5. 实际使用示例

### 5.1 在远程服务器执行命令

**你说：**
```
在 Los_dc03 上执行 ls -la /root
```

**Claude 会：**
1. 调用 `remote_execute` 工具
2. 执行 `ssh Los_dc03 'ls -la /root'`
3. 返回结果给你

### 5.2 同步代码到服务器

**你说：**
```
把 /Users/keamy/my-project 目录同步到 Los_dc03 的 /root/my-project
```

**Claude 会：**
1. 调用 `remote_sync` 工具
2. 执行 `rsync -avz /Users/keamy/my-project root@104.168.103.56:/root/my-project`
3. 返回同步结果

### 5.3 完整的开发流程示例

**你说：**
```
1. 把当前目录的代码同步到 Los_dc03 的 /root/project
2. 在服务器上运行 python main.py
3. 把运行结果 output.txt 下载到本地
```

**Claude 会自动执行这三步：**
1. `remote_sync` → 上传代码
2. `remote_execute` → 运行脚本
3. `remote_pull` → 下载结果

### 5.4 Git 工作流

**你说：**
```
commit 当前更改 "update config"，push 到 GitHub，
然后在 Los_dc03 的 /root/project 目录 pull 最新代码
```

**Claude 会：**
1. 本地 `git add -A && git commit -m "update config" && git push`
2. 远程 `ssh Los_dc03 'cd /root/project && git pull'`

---

## 6. 常见问题解答

### Q1: 需要密码的服务器怎么办？

**最佳方案：配置 SSH 密钥（推荐）**

参考第 2 节配置免密登录。SSH 密钥比密码更安全。

**临时方案：使用 sshpass（不推荐）**

如果实在无法配置密钥：

```bash
# 安装 sshpass
brew install sshpass

# 修改 MCP 代码支持密码（需要自己改源码）
```

不推荐这个方案，因为密码会暴露在命令行中。

### Q2: 连接超时怎么办？

1. **检查网络**
   ```bash
   ping 104.168.103.56
   ```

2. **检查端口是否开放**
   ```bash
   nc -zv 104.168.103.56 22
   ```

3. **检查防火墙**
   服务器可能有防火墙限制你的 IP

### Q3: Permission denied 怎么办？

1. **检查密钥权限**
   ```bash
   chmod 600 ~/.ssh/id_rsa
   chmod 700 ~/.ssh
   ```

2. **确认公钥已复制到服务器**
   ```bash
   ssh -v Los_dc03
   # 查看详细调试信息
   ```

### Q4: MCP 工具没有出现怎么办？

1. **确认设置文件正确**
   ```bash
   cat ~/.claude/settings.json
   ```
   检查 JSON 格式是否正确（没有多余逗号等）

2. **确认 MCP Server 可以运行**
   ```bash
   node /Users/keamy/Desktop/cc-remote/remote-executor-mcp/dist/index.js
   ```
   应该显示 "Remote Executor MCP Server running on stdio"
   按 `Ctrl+C` 退出

3. **重启 Claude Code**
   必须完全退出再重新启动

### Q5: 如何添加更多服务器？

在 `~/.ssh/config` 中添加：

```
Host singapore
  HostName sg.example.com
  User deploy
  Port 22
  IdentityFile ~/.ssh/id_rsa

Host tokyo
  HostName jp.example.com
  User admin
  Port 2222
```

重启 Claude Code 后，就可以使用 `singapore` 和 `tokyo` 作为服务器名称了。

### Q6: 命令执行超时怎么办？

默认超时是 300 秒（5分钟）。对于长时间运行的任务：

**方法 1：指定更长的超时**

告诉 Claude：
```
在 Los_dc03 上执行 python train.py，超时设置为 3600 秒
```

**方法 2：使用 nohup 后台运行**
```
在 Los_dc03 上执行：nohup python train.py > output.log 2>&1 &
```
这样即使断开连接，程序也会继续运行。

---

## 快速参考卡片

```
┌────────────────────────────────────────────────────────────────┐
│                    Remote Executor MCP 速查表                   │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  测试连接:      "测试连接到 Los_dc03"                          │
│                                                                │
│  执行命令:      "在 Los_dc03 上执行 ls -la"                    │
│                                                                │
│  同步代码:      "把 ./src 同步到 Los_dc03 的 /root/project"    │
│                                                                │
│  下载文件:      "从 Los_dc03 下载 /root/output.txt 到本地"     │
│                                                                │
│  Git 推送:      "commit '更新代码' 并在 Los_dc03 pull"         │
│                                                                │
│  列出服务器:    "列出可用的服务器"                              │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│  遇到问题?                                                     │
│  1. ssh Los_dc03  ← 先测试手动 SSH 是否正常                    │
│  2. 检查 ~/.claude/settings.json                               │
│  3. 重启 Claude Code                                           │
└────────────────────────────────────────────────────────────────┘
```

---

## 下一步

配置完成后，你就可以用自然语言让 Claude Code 帮你：

1. 在本地写代码
2. 自动同步到远程服务器
3. 在服务器上运行
4. 获取结果并继续调试

整个过程你不需要手动敲任何 SSH 命令！

有问题随时问我 😊
