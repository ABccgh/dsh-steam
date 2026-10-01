# dsh-steam

把 Steam 接进 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）：装成一个 host 侧
Cordis 插件 bundle 之后，模型获得 14 个 `steam_*` 只读工具——读**本机 Steam 库**、查**商店与公开数据**、
以及通过**官方 Steam Web API** 查账号数据。

所有工具都是只读的：不启动游戏、不改任何 Steam 文件、不写配置文件。

## 14 个工具

### 本地层（5 个，不联网、不需要 API Key）

| 工具 | 作用 |
|---|---|
| `steam_status` | 安装目录、客户端是否在运行、所有库根及占用、本机账号、已安装游戏数与总占用、本地创意工坊内容数 |
| `steam_games` | 列出已安装游戏（占用、最后游玩、安装状态），支持按名称/appid 过滤与排序 |
| `steam_game` | 按 appid 查单个游戏的本地安装详情（安装目录、buildid、StateFlags、语言） |
| `steam_library_health` | 库体检：安装目录缺失、多余目录、跨库重复 appid、损坏的 appmanifest |
| `steam_workshop_local` | 本机已下载的创意工坊内容（appid、工坊 ID、大小、修改时间） |

数据来源就是 Steam 自己写的文件：注册表 `HKCU\Software\Valve\Steam\SteamPath`、
`config/libraryfolders.vdf`（也支持旧版 `steamapps/libraryfolders.vdf`）、
`steamapps/appmanifest_*.acf`、`config/loginusers.vdf`、`steamapps/workshop/content/`。

### 公开层（4 个，不联网失败时给建议、不需要 API Key）

| 工具 | 作用 |
|---|---|
| `steam_search` | 商店搜索（appid、名称、价格、平台） |
| `steam_store_app` | 商店详情（价格、发行日期、开发商、类型标签、Metacritic、简介） |
| `steam_reviews` | 用户评测汇总（好评率）与少量样本 |
| `steam_app_stats` | 当前在线人数 + 全球成就达成率 |

### 密钥层（5 个，需要 `STEAM_API_KEY`）

| 工具 | 作用 |
|---|---|
| `steam_player` | 公开资料：显示名、在线状态、账号创建时间、正在玩的游戏 |
| `steam_owned_games` | 拥有游戏与游玩时长，并标出哪些已装在本机 |
| `steam_recent_games` | 最近两周游玩记录 |
| `steam_achievements` | 某个游戏里的成就解锁情况 |
| `steam_workshop_search` | 创意工坊条目查询（订阅数、更新时间等） |

不传 `steamId` 时默认用本机 Steam 登录的账号；也可以传 17 位 SteamID64、vanity 名或
`steamcommunity.com` 主页链接。

## 安装

> **从副本安装，不要从 git 工作树安装。** 安装目标会成为 profile 的 `link:` 依赖，
> git 工作树里的改动会直接影响线上插件；反过来，误删工作树也会让插件失效。

1. 把仓库复制到一个长期保留的目录（不要放进任何会被清理的位置）：

   ```powershell
   robocopy "D:\DSH workspace\dsh-steam" "$env:USERPROFILE\dsh-bundles\steam" /MIR /XD .git test
   ```

   `/XD test` 是因为运行时不读测试目录；想保留也可以去掉。

2. 用绝对路径安装：

   ```
   plugin_manager  action: install_bundle  target: C:\Users\<你>\dsh-bundles\steam
   ```

   管理器会自己跑包安装、写入 profile 的 `package.json` 并选中这个 bundle。
   **不要手改 profile 的 `package.json` / `cordis.patch.yml`，也不要在 profile 目录里跑 pnpm。**

3. 验证：插件列表里出现一行 `steam`，模块是 `@local/steam`，状态 `active`。

4. **不要删安装目录。** profile 通过 `node_modules/@local/steam` 这个 junction 指向它，
   删掉就等于删掉全部 `steam_*` 工具，直到重新安装。目录里放了一份 `DO-NOT-DELETE.txt` 说明这一点。

## 配置

配置就在 bundle 的 `cordis.patch.yml` 里，改完即生效（有 HMR 时不用重启）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `steamPath` | `''` | 手动指定 Steam 根目录；留空按「注册表 → 平台常见路径」自动探测 |
| `extraLibraryPaths` | `[]` | 追加库根，给自动探测漏掉的盘用 |
| `webApi` | `auto` | `auto`：能解析到 Key 才注册密钥层工具；`on`：总是注册；`off`：永不注册 |
| `apiKeyEnv` | `STEAM_API_KEY` | Key 的凭据名 |
| `trustSystemCa` | `auto` | 见下面的「加速器与证书」 |
| `storeCountry` / `storeLanguage` | `cn` / `schinese` | 商店端点地区与语言 |
| `requestTimeoutMs` | `15000` | 单次 HTTP 超时 |
| `maxListedApps` | `200` | 列表类工具一次最多返回多少条 |

## API Key

申请地址：<https://steamcommunity.com/dev/apikey>（Steam 账号不能是受限账号）。

凭据按 DSH 自己的优先级解析，从高到低：

1. 启动 DSH 前的环境变量；
2. `C:\Users\<你>\.dsh\.credentials.yaml`；
3. 启动目录下的 `.env`；
4. **`C:\Users\<你>\.dsh\.env`** ← 最省事，改完自动重载。

也就是新建/编辑 `C:\Users\<你>\.dsh\.env`，写一行：

```
STEAM_API_KEY=你的KEY
```

保存后，密钥层的 5 个工具会在下一次插件加载时出现：在「插件」页把 `steam` 这一行
关开一次即可，不需要改配置、不需要改这个仓库里的任何文件。

工具每次调用都会重新解析 Key，不缓存——所以刚保存就能用上。没配 Key 时调用密钥层工具
（`webApi: on` 的情况下）会返回一段「去哪儿写、怎么生效」的完整指引，而不是一句 missing key。

## 加速器与证书（重要）

本机 hosts 里有大量形如 `127.0.0.1 store.steampowered.com` 的记录，这是 Steam++ / Watt Toolkit
一类加速工具的加速模式：它在本机监听并用一张自签名根证书接管这些域名的 TLS。

- Windows 信任那张根证书，所以浏览器和 PowerShell 正常；
- Node 自带 CA 包不信任它，`fetch` 会抛 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`；
- DSH 自己的 `web_fetch` 有 SSRF 防护，会直接拒绝解析到非公网 IP 的域名。

dsh-steam 的处理方式：第一次遇到证书错误时，用 Node 24 的
`tls.getCACertificates('system')` + `tls.setDefaultCACertificates()` 把**系统根证书并进
Node 的默认 CA 列表**，然后重试一次。这等于「信任操作系统已经信任的根」，只在真的遇到
证书错误时才发生（`trustSystemCa: auto`）。

- 不想让它动这个：把 `trustSystemCa` 设为 `never`，代价是加速器开着时网络类工具全部失败；
- 想启动就并好：设为 `always`；
- 关掉加速器的 hosts 加速模式（改用别的加速方式）也能让默认行为正常，此时根本不会触发合并。

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `没有找到本机 Steam 安装` | 在 `cordis.patch.yml` 里把 `steamPath` 设成绝对路径 |
| `连接被拒绝：本机 hosts 可能把该域名指向了 127.0.0.1…` | 加速器没在运行。启动它，或关掉 hosts 加速模式 |
| `TLS 证书链无法验证…` | 见上一节；确认 `trustSystemCa` 不是 `never` |
| 密钥层工具不出现 | `webApi` 是 `off`，或 `$DSH_HOME/.env` 里没有 `STEAM_API_KEY`。用 `webApi: on` 可以强制注册，调用时会给出具体指引 |
| `拿不到 … 的游戏列表：该账号的「游戏详情」隐私设置不是公开` | 在 Steam 隐私设置里把「游戏详情」设为公开 |
| 改了仓库代码但线上没变 | 安装读的是副本（`%USERPROFILE%\dsh-bundles\steam`），而且要**重启 DSH** 才会生效：Host 进程会缓存已加载的 ESM 模块，插件页关开、HMR 重载都只重新装配配置，不会重新读代码。改完先 robocopy，再重启应用。只改 `cordis.patch.yml` 的配置值则不需要重启 |
| DSH 升级后插件装不上 | 已无 `peerDependencies`，正常升级不会受影响；如果安装仍被拒，看管理器给出的诊断 |

## 开发与测试

需要 Node 24（DSH 自带的那个就行：`resources\runtime\primary-runtime\dependencies\node\bin\node.exe`）。

```powershell
node --test "test/*.test.js"                        # 86 个用例通过，2 个联网用例跳过
$env:DSH_STEAM_LIVE=1; node --test "test/*.test.js"  # 88 个用例全跑，包含打真实 Steam 端点的活体用例
```

插件是**零外部依赖**的（只用 `node:*` 和自己的模块），所以测试像普通包一样直接 import，
不需要任何解析替身。`test/plugin.test.js` 会用假的 `ctx` 真正调用工具函数，包括扫本机的 Steam 库。

### 为什么不 import DSH 自己的包

插件是 `link:` 安装的 profile bundle，代码在 `%USERPROFILE%\dsh-bundles\steam`，不在 DSH 的
安装作用域里。DSH 的 profile 解析路由能解析 bundle 自己的包名，但**不会**把 bundle 里的
`@deepseek-ai/*` 导入重定向到 DSH 安装目录，所以：

```js
import { defineTool } from '@deepseek-ai/dsh-tools';  // ✗ ERR_MODULE_NOT_FOUND，整个插件加载失败
```

工具注册表真正需要的只有 `name` / `description` / `parameters`（JSON Schema，原样透传给模型）
与 `output.schema` + `output.render` + `execute`，其中 `parameters` 在
`dsh-tools` 的 `register()` 里没有任何转换。于是 `lib/tool-kit.js` 自己把简写 spec 编译成
JSON Schema 并补上参数校验，插件因此完全不依赖 DSH 内部模块——顺带也不再受 DSH 版本升级影响。

同理不导出 `Config`：cordis 的 `resolveConfig` 在插件没有 `Config` 时**原样透传**配置对象，
默认值与非法值处理由 `lib/index.js` 的 `normalizeConfig` 负责。

## 卸载

```
plugin_manager  action: remove_bundle  target: @local/steam
```

由管理器改 profile，不要手改。确认卸载完成后，再删安装副本目录。

## 说明

- 这是个人自用插件，`version` 与 `private` 都在本地管理，不发布到 npm。
- 从 Steam 拉回来的内容（商店简介、评测正文、工坊标题）是**外部不可信数据**，
  只当数据看，不要当指令执行。
- 工具是只读的：没有任何参数能让它们写入 Steam 或系统配置。

## License

MIT
