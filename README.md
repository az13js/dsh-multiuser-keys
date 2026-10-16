# @local/dsh-multiuser-keys

让**同一台 DeepSeek Harness 服务**被多个人共用时，每个人用自己的 provider API Key、消耗自己账户的额度。

- Key 只保存在**用户自己的浏览器**（`localStorage`），随请求进入服务器**内存**，不落盘。
- 服务器管理员配置**哪些 provider 需要用户自备 Key**；没配置的 provider 完全走 Harness 默认行为（服务器自身的凭据），公司以后想统一发额度，把该 provider 从配置里去掉即可。
- 服务器重启/更新后无需任何操作：浏览器下一次请求会自动带上 Key。

## 一、工作原理

```
浏览器 A                        Harness 服务器 X                   公司大模型网关
────────                        ─────────────────                  ──────────────
localStorage: Key
   │ 每个 /api 请求带 header
   │ x-dsh-user-keys: <base64url JSON>
   └──────────────────────────►  connection/request（HTTP 层）
                                 └─ AsyncLocalStorage 记录本次请求的 Key 环
                                    └─ 该请求驱动的会话/子 agent 绑定到这个 Key 环
                                       └─ credentials.resolve(ref) 命中映射时
                                          返回浏览器里的 Key，否则原样委托
                                          └──────────────────────────► 用该用户的 Key 调用
```

- **Host 半**（`index.js`）包装 `ctx.credentials.resolve()`：只拦截管理员映射的凭据引用（`apiKeyEnv` 的名字），其余一律委托给原生实现。
- **Client 半**（`client.js`）提供设置页 `设置 → 我的 API Key`，并把 Key 挂到同源 `/api` 请求上（不发给任何第三方域名）。
- Key 在服务器上仅存在于进程内存：会话绑定（最多 512 条）+ 最近活动 Key 环（默认 30 分钟内有效，用于后台任务/子 agent 等没有会话上下文的调用）。

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
- 可选字段：`recentRingWindowMs`（默认 1800000，设 0 关闭“最近活动”回退）、`header`（默认 `x-dsh-user-keys`）、`source`（默认 `browser`）、`logResolutions`（默认 false）。
- **改完配置要刷新浏览器页面**：provider 目录随首页 HTML 下发。

## 四、用户使用

`设置 → 我的 API Key`（英文界面为 *My API keys*）：每个已映射的 provider 一行，粘贴自己的 Key → 保存，立即对下一次请求生效。清除则回退到服务器默认凭据。

页面会显示“已配置/未配置”，Key 输入框默认掩码显示。

## 五、已知限制

1. **同一个会话被两个用户同时使用**时，会话绑定以最后一次发起请求的人为准，可能把 A 的请求记到 B 的 Key 上（服务器上是共享会话模型，本身就没有用户隔离）。建议各自用自己的会话。
2. **非 Web 传输**（桌面端 IPC、ACP/CLI）没有浏览器，Key 无法注入，行为等同未配置。
3. **无会话上下文的后台任务**（定时任务、团队协作触发的调用）在 `recentRingWindowMs` 窗口内使用最近活跃用户的 Key，超出窗口则回退默认凭据。
4. 映射后的凭据，Models 设置页仍然只反映服务器端存储状态（`describe` 未被改写），用户 Key 的状态以本插件页面为准。
5. Key 的信任边界等同于同源页面本身：任何能在 `x.example.com` 上执行脚本的人都能读到 `localStorage`。

## 六、验证状态

已在本机 Harness（0.2.0-rc.2，web profile，provider `company-gateway`）验证：

- 安装返回 `application: applied`、无告警；插件行 `include:multiuser-keys` 处于 `enabled + active`。
- 客户端插件已在真实页面注册：`settings.section` 中出现 `multiuser-keys`（order 25，active）。
- `node test/host.test.mjs`：18 项通过 —— 覆盖 header 解码、请求作用域、会话绑定、子 agent 继承、最近活动回退、未映射/无 Key 委托、目录发现、销毁还原。

尚未在真实浏览器里点过：页面外观、保存后 header 往返、以及**映射生效时的真实计费路径**（需要在管理员配置里加上 provider、刷新页面、填入 Key 后发一条消息来确认）。这一步只有你能完成。

## 七、自检与卸载

```bash
node test/host.test.mjs
```

卸载：插件管理器 `remove_bundle @local/dsh-multiuser-keys`；用户浏览器里的 Key 属于浏览器，清站点数据即清空。
