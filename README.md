# @local/dsh-multiuser-keys

让**同一台 DeepSeek Harness 服务**被多个人共用时，每个人用自己的 provider API Key、消耗自己账户的额度。

- Key 只保存在**用户自己的浏览器**（`localStorage`），随请求进入服务器**内存**，不落盘。
- 服务器管理员配置**哪些 provider 需要用户自备 Key**；没配置的 provider 完全走 Harness 默认行为（服务器自身的凭据），公司以后想统一发额度，把该 provider 从配置里去掉即可。
- 服务器重启/更新后无需任何操作：浏览器下一次请求会自动带上 Key。
- **会话不属于任何人**：一个对话谁接着聊，就用谁的 Key。自己没配 Key 还去接着聊，只会得到 `MISSING_CREDENTIAL`，不会消耗别人的额度，也不会回退到服务器凭据。

## 一、工作原理

```
浏览器 A                        Harness 服务器 X                   公司大模型网关
────────                        ─────────────────                  ──────────────
localStorage: Key
   │ 每个 /api 请求都带 header（没 Key 也带空环）
   │ x-dsh-user-keys: <base64url JSON>
   └──────────────────────────►  connection/request（HTTP 层）
                                 └─ AsyncLocalStorage 记录本次请求的 Key 环
                                    └─ 该请求驱动的会话/子 agent 绑定到这个 Key 环
                                       （后来者覆盖先到者，空环也覆盖）
                                       └─ credentials.resolve(ref) 命中映射时
                                          有 Key 返回浏览器里的 Key；
                                          没有则返回“无凭据”，绝不委托
                                          └──────────────────────────► 用当前说话人的 Key 调用
```

- **Host 半**（`index.js`）包装 `ctx.credentials.resolve()`：只拦截管理员映射的凭据引用（`apiKeyEnv` 的名字），其余一律委托给原生实现。
- **Client 半**（`client.js`）提供设置页 `设置 → 我的 API Key`，并把 Key 挂到同源 `/api` 请求上（不发给任何第三方域名）。
- Key 在服务器上仅存在于进程内存：每个请求一个作用域，每个会话一条绑定（最多 512 条，后来的绑定覆盖旧的，没有全局“最近活跃用户”槽位）。

## 二、安装

前置：目标机器上有 `pnpm`（Harness 插件管理器需要；只有 corepack 时可用 `corepack enable pnpm`，或写一个 `exec corepack pnpm "$@"` 的 shim）。

把本目录放到服务器上任意位置（例如 `/opt/dsh-plugins/dsh-multiuser-keys`），然后二选一：

**方式一（推荐）**：用 Harness 自带的插件管理器安装这个目录 —— 在 GUI 的插件页安装，或让 Agent 调 `plugin_manager install_bundle`，`target` 传目录绝对路径。

**方式二**：等价的两步手工操作：

```bash
dsh plugin --profile web add /opt/dsh-plugins/dsh-multiuser-keys
# 再把 "@local/dsh-multiuser-keys" 追加到 ~/.dsh/profiles/web/package.json 的
# dsh.profile.bundles 数组
```

也可以先把包发到公司私有 registry，再按包名安装。

**K8s 要点**：`$DSH_HOME`（默认 `~/.dsh`）里的 `profiles/web/`（依赖 + `dsh.profile.bundles` 选择 + `node_modules`）必须在**镜像里预先装好**，否则 Pod 重建后插件消失。因此请把“安装本插件”放进镜像构建阶段，而不是运行阶段：

```dockerfile
COPY dsh-multiuser-keys /opt/dsh-plugins/dsh-multiuser-keys
RUN dsh plugin --profile web add /opt/dsh-plugins/dsh-multiuser-keys \
 && node -e "const f='/root/.dsh/profiles/web/package.json',fs=require('fs'),p=require(f);p.dsh.profile.bundles.includes('@local/dsh-multiuser-keys')||p.dsh.profile.bundles.push('@local/dsh-multiuser-keys');fs.writeFileSync(f,JSON.stringify(p,null,2))"
```

本插件没有安装脚本、没有 npm 依赖（只用 Node 内置模块与页面自带的 React），因此安装不会触发任何 build script。

### 与 `--trusted-host` / Nginx 的关系

**不影响**。本插件不新增任何 HTTP 端点，只是复用既有的 `/api` 请求：Nginx 的 `proxy_pass` 默认透传未知请求头，`--trusted-host x.example.com` 的信任栅栏照常生效，无需改 Nginx 或启动参数。唯一需要留意的是：**不要在 Nginx/网关日志里记录请求头**（Key 在 header 中传输，走的是同一条 HTTPS 连接）。

## 三、管理员配置

两种方式，选一种。

**A. 覆盖 profile patch 里的插件行**（完整示例见 `config.example.yml`）：

```yaml
- id: multiuser-keys
  name: "@local/dsh-multiuser-keys"
  config:
    providers:
      - provider: company-gateway     # llm-pi-ai 里的路由名（Models 页面显示的那个）
        label: 公司大模型网关          # 用户设置页显示的名字
      # - provider: openrouter
      #   ref: OPENROUTER_API_KEY     # 可选：显式指定凭据引用（apiKeyEnv 名）
```

**B. 独立的 JSON 配置文件**（适合 ConfigMap 挂载）：

```yaml
- id: multiuser-keys
  name: "@local/dsh-multiuser-keys"
  config:
    configFile: /etc/dsh/multiuser-keys.json
```

```json
{ "providers": [ { "provider": "company-gateway", "label": "公司大模型网关" } ] }
```

- `ref` 可省略：插件会从实时 settings 文档里读取该 provider 的 `apiKeyEnv`（`llm-pi-ai` 的 `providers.<路由>.apiKeyEnv`；官方 DeepSeek 路由的 `llm-deepseek-api-key.apiKeyEnv` 也识别）。读不到的 provider 会在日志里告警并跳过。
- 可选字段：`header`（默认 `x-dsh-user-keys`）、`source`（默认 `browser`）、`logResolutions`（默认 false）。
- **改完配置要刷新浏览器页面**：provider 目录随首页 HTML 下发。

## 四、用户使用

`设置 → 我的 API Key`（英文界面为 *My API keys*）：每个已映射的 provider 一行，粘贴自己的 Key → 保存，立即对下一次请求生效。

页面会显示“已配置/未配置”，Key 输入框默认掩码显示。

清除后，本浏览器在下一次请求里发送空 Key 环。此时接着聊任何对话都会得到 `MISSING_CREDENTIAL`（而不是用上一位用户或服务器的 Key）——这正是“谁聊谁付”的预期行为。

## 五、已知限制

1. **同一个会话被两个人同时聊**时，以最后一次驱动该会话的人为准：A 正在跑的回合如果 B 刚好发了一条消息，A 后续的模型调用会改成用 B 的 Key。这是“当前说话人付费”的直接结果，不是跨用户泄漏；并发聊天建议各开各的会话。
2. **非 Web 传输**（桌面端 IPC、ACP/CLI）没有浏览器，映射的 provider 解析为无凭据并报 `MISSING_CREDENTIAL`；需要给这类入口单独配置未映射的 provider，或走服务器凭据。
3. **无会话上下文的后台任务**（定时任务、没有任何会话的调用）同样没有 Key：映射的 provider 会失败。想让这类任务用服务器凭据，就把它的 provider 从管理员映射里去掉。
4. 映射后的凭据，Models 设置页仍然只反映服务器端存储状态（`describe` 未被改写），用户 Key 的状态以本插件页面为准。
5. Key 的信任边界等同于同源页面本身：任何能在 `x.example.com` 上执行脚本的人都能读到 `localStorage`。

## 六、验证状态

已在本机 Harness（web profile，provider `company-gateway`）验证：

- 安装返回 `application: applied`、无告警；插件行 `include:multiuser-keys` 处于 `enabled + active`。
- 客户端插件已在真实页面注册：`settings.section` 中出现 `multiuser-keys`（order 25，active）。
- `node test/host.test.mjs`：33 项通过 —— 覆盖空环解码、请求作用域、会话接管（有 Key / 无 Key / 来回切换）、会话在请求中创建、无 header 的接管、无全局兜底、子 agent 继承、未映射委托、目录发现、销毁还原。

尚未在真实浏览器里点过：页面外观、保存后 header 往返、以及**映射生效时的真实计费路径**（需要在管理员配置里加上 provider、刷新页面、填入 Key 后发一条消息来确认）。这一步只有你能完成。

## 七、自检与卸载

```bash
node test/host.test.mjs
```

卸载：插件管理器 `remove_bundle @local/dsh-multiuser-keys`；用户浏览器里的 Key 属于浏览器，清站点数据即清空。
