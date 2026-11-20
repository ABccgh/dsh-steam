# dsh-steam

把 Steam 接进 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）：装成一个 host 侧
Cordis 插件 bundle 之后，模型获得 14 个 `steam_*` 只读工具——读**本机 Steam 库**、查**商店与公开数据**
（评测走 Valve 新的 `IUserReviewsService`，免 Key）、以及通过**官方 Steam Web API** 查账号数据。

所有工具都是只读的：不启动游戏、不改任何 Steam 文件、不写配置文件。

当前版本 **0.3.0**（2026-11）：与 DSH 0.2.2 对齐——`webApi` 默认 `on`（14 个工具始终注册）、
工坊/评测翻页（`page` / `cursor`）、免费应用价格语义修正、凭据优先级与 `.credentials.yaml` 写法纠正、
注册表非 ASCII 路径修复、配置告警与工具超时兜底、locale/图标显示元数据。

## 14 个工具

### 本地层（5 个，不联网、不需要 API Key）

| 工具 | 作用 |
|---|---|
| `steam_status` | 安装目录、客户端是否在运行（含 PID）、所有库根及占用、本机账号、已安装游戏数与总占用、本地创意工坊内容数、插件版本与系统根证书状态 |
| `steam_games` | 列出已安装游戏（占用、最后游玩、安装状态），支持按名称/appid 过滤与排序 |
| `steam_game` | 按 appid 查单个游戏的本地安装详情（安装目录、buildid、StateFlags、语言） |
| `steam_library_health` | 库体检：安装目录缺失、多余目录、跨库重复 appid、损坏的 appmanifest |
| `steam_workshop_local` | 本机已下载的创意工坊内容（appid、工坊 ID、大小、修改时间） |

数据来源就是 Steam 自己写的文件：注册表 `HKCU\Software\Valve\Steam\SteamPath`（通过 PowerShell
读取并强制 UTF-8 输出，中文或带空格的安装路径不会乱码）、
`config/libraryfolders.vdf`（也支持旧版 `steamapps/libraryfolders.vdf`）、
`steamapps/appmanifest_*.acf`、`config/loginusers.vdf`、`steamapps/workshop/content/`。
`steamPath` 配置写错时会继续按「注册表 → 平台常见路径」自动探测，不会静默停用探测。

### 公开层（4 个，免 Key；失败时给可执行建议）

| 工具 | 作用 |
|---|---|
| `steam_search` | 商店搜索（appid、名称、价格、平台；Steam 接口单次最多 10 条） |
| `steam_store_app` | 商店详情（价格、发行日期、开发商、类型标签、Metacritic、简介；用 `is_free` 标注免费） |
| `steam_reviews` | 用户评测汇总（好评率、评级描述）与样本；可按语言、情感、排序筛选，用 `cursor` 翻页 |
| `steam_app_stats` | 当前在线人数 + 全球成就达成率；配了 Key 时显示本地化成就名 |

价格语义：商店搜索接口对**免费游戏与 Demo 不返回价格**，所以工具只写「无价（免费或本区不售）」，
不会断言本地区不售；只有接口明确给了 `final: 0` 才写「免费」。`steam_store_app` 的免费标注
以 appdetails 的 `is_free` 为准（没有该字段时才用 `price_overview.final = 0` 兜底）。

### 密钥层（5 个，需要 `STEAM_API_KEY`）

| 工具 | 作用 |
|---|---|
| `steam_player` | 公开资料：显示名、在线状态、账号创建时间、正在玩的游戏 |
| `steam_owned_games` | 拥有游戏与游玩时长，并标出哪些已装在本机 |
| `steam_recent_games` | 最近两周游玩记录 |
| `steam_achievements` | 某个游戏里的成就解锁情况 |
| `steam_workshop_search` | 创意工坊条目查询（订阅数、更新时间等），用 `page` 翻页 |

不传 `steamId` 时默认用本机 Steam 登录的账号；也可以传 17 位 SteamID64、vanity 名或
`steamcommunity.com` 主页链接。

### 评测接口（2026-10-22 变更）

Valve 已停用 `store.steampowered.com/appreviews/<appid>?json=1`：旧地址现在一律 302 到商店首页，
跟随重定向只能拿到 HTML。dsh-steam 0.2.0 起改用：

```
GET https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/?input_json=...
```

- 免 Key；匿名调用共享较低配额，Steam 自己会缓存约 10 分钟，插件也做了同量级缓存；
- `input_json` 里 `filter` 是数字枚举（helpful/recent/updated/funny），`review_type` 是 all/positive/negative；
- `day_range: 0` 表示全时段，汇总里的 `total_reviews` 才是全时段数字；
- 无效/下架 appid 返回 `{"response":{}}`，工具按「读不到评测」降级而不是抛错。

## 安装

> **从副本安装，不要从 git 工作树安装。** 安装目标会成为 profile 的 `link:` 依赖，
> git 工作树里的改动会直接影响线上插件；反过来，误删工作树也会让插件失效。

1. 把仓库复制到一个长期保留的目录（不要放进任何会被清理的位置）：

   ```powershell
   robocopy "<仓库路径>" "$env:USERPROFILE\dsh-bundles\steam" /MIR /XD .git test
   ```

   `/XD test` 是因为运行时不读测试目录；想保留也可以去掉。
   注意 `/MIR` 会删除目标里源中没有的文件——所以 `DO-NOT-DELETE.txt` 是**放在仓库里**的，
   同步不会把它删掉。

2. 用绝对路径安装：

   ```
   plugin_manager  action: install_bundle  target: %USERPROFILE%\dsh-bundles\steam
   ```

   管理器会自己跑包安装、写入 profile 的 `package.json` 并选中这个 bundle。
   **不要手改 profile 的 `package.json` / `cordis.patch.yml`，也不要在 profile 目录里跑 pnpm。**

3. 验证：插件列表里出现一行 `steam`，模块是 `@local/steam`，状态 `active`。

4. **不要删安装目录。** profile 通过 `node_modules/@local/steam` 这个 junction 指向它，
   删掉就等于删掉全部 `steam_*` 工具，直到重新安装。目录里放了一份 `DO-NOT-DELETE.txt` 说明这一点。

## 配置

配置就在 bundle 的 `cordis.patch.yml` 里。

> **改完需要手动重载一次**（插件页把 `steam` 关开一次）。实测副本目录里的 patch
> 变更**不会**被 HMR 自动拾取；只改配置值不需要重启应用，改代码才需要。

| 字段 | 默认 | 说明 |
|---|---|---|
| `steamPath` | `''` | 手动指定 Steam 根目录；留空按「注册表 → 平台常见路径」自动探测。填错也会继续自动探测，不会停用探测 |
| `extraLibraryPaths` | `[]` | 追加库根，给自动探测漏掉的盘用 |
| `webApi` | `on` | `on`（默认）：始终注册 5 个密钥层工具，缺 Key 时调用会给出完整配置指引；`auto`：能解析到 Key 才注册（激活时凭据服务若尚未就绪，插件会自动重试，`steam_status` 也会自愈补注册）；`off`：永不注册 |
| `apiKeyEnv` | `STEAM_API_KEY` | Key 的凭据名 |
| `trustSystemCa` | `auto` | 见下面的「加速器与证书」 |
| `storeCountry` / `storeLanguage` | `cn` / `schinese` | 商店端点地区与语言 |
| `requestTimeoutMs` | `15000` | 单次 HTTP 超时 |
| `maxListedApps` | `200` | 列表类工具一次最多返回多少条；创意工坊搜索受接口单页上限限制，实际最多 100 |

## API Key

申请地址：<https://steamcommunity.com/dev/apikey>（Steam 账号不能是受限账号）。

凭据按 DSH 自己的优先级解析，从高到低：

1. **已存凭据**：`$DSH_HOME\.credentials.yaml` 里 `version: 1` 的 `refs:` 下 ← 最高优先级；
   凭据服务会热加载，保存后通常立刻生效，不用重启；
2. **启动 DSH 前的环境变量** ← `setx` 之后要重启 DSH（启动环境在启动时定格）；
3. **项目 `.env`**（启动目录下的 `.env`）← 只在启动时读一次，写完要重启 DSH；
4. `$DSH_HOME\.env` ← 优先级最低，只在启动时读一次；桌面版还只在 cwd ≠ `$DSH_HOME`
   时才把它当 user-env 层读，最容易「写了不生效」。

凭据文件是**带版本的结构化文档，不是 dotenv**。直接加一行裸的 `STEAM_API_KEY: 你的KEY`
会被当作未知顶层键忽略（启动时告警、不生效），必须写成：

```yaml
version: 1

refs:
  STEAM_API_KEY: 你的KEY
```

也可以走凭据 UI 或 `credentials.set`。环境变量的写法（之后要重启 DSH）：

```powershell
setx STEAM_API_KEY "你的KEY"
```

`steam_status` 会直接告诉你「已配置／未配置」以及 5 个密钥层工具是否已注册，不用猜。

0.3.0 起 `webApi` 默认 `on`：**14 个工具始终注册**，缺 Key 时调用密钥层工具会返回上面这份
完整配置指引，而不是让 5 个工具静默消失。只有显式 `webApi: auto` 才恢复「解析到 Key 才
注册」的旧行为（激活时凭据未就绪会自动重试，`steam_status` 也会顺手自愈一次）；`off` 则
永不注册。

工具每次调用都会重新向凭据服务解析 Key，不缓存——所以刚写进 `.credentials.yaml` 通常就能用上；
环境变量与 `.env` 是启动时定格的，改完要重启。

## 时间显示

0.2.0 起所有时间都渲染成本机时区并带偏移量，例如 `2026-11-19 22:34 +08:00`。
之前是 UTC ISO 字符串（`2026-11-19T14:34:52Z`），UTC+8 的读者每次都要心算。

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
| `没有找到本机 Steam 安装` | 在 `cordis.patch.yml` 里把 `steamPath` 设成 Steam 根目录的绝对路径（填错会自动回落到注册表/常见路径探测，不会被静默停用；`steam_status` 会列出找过哪些位置） |
| `连接被拒绝：本机 hosts 可能把该域名指向了 127.0.0.1…` | 加速器没在运行。启动它，或关掉 hosts 加速模式 |
| `TLS 证书链无法验证…` | 见上一节；确认 `trustSystemCa` 不是 `never` |
| `请求被重定向到 https://store.steampowered.com/` | 旧评测端点已停用（2026-10-22），或 Steam 又迁移了接口。确认插件是 0.2.0+；再变时按 `IUserReviewsService` 文档更新 URL |
| `HTTP 429` / `Steam 限流…` | 匿名调用共享较低配额，Steam 自己缓存约 10 分钟；等一会再试，或配置 API Key |
| `steam_app_stats` 显示 `ce3_07_…` 这类名字 | 没配 Key 时只能拿到 Steam 内部 API 名。配 Key 后会自动换成中文成就名 |
| `steam_workshop_search` 超时 | 接口单页上限 100，工具会把 200 夹到 100；仍超时就减小 `limit`、用 `page` 缩小单页，或加 `searchText` |
| 密钥层工具不出现 | 0.3.0 默认 `webApi: on`，工具始终注册——如果「不出现」，先确认 `webApi` 没被改成 `off`；调用时报「Key 未配置」则按上一节配置。显式 `auto` 时工具要等凭据就绪才注册，看 `steam_status` 的「已配置／未配置」与注册状态 |
| 写了 `$DSH_HOME/.env` 还是没生效 | 桌面版只在 `cwd !== $DSH_HOME` 时才把 `$DSH_HOME/.env` 当 `user-env` 层读取，而且它只在启动时读一次。改用 `$DSH_HOME\.credentials.yaml`（`version: 1` + `refs:`，通常无需重启），或**启动环境变量**：`setx STEAM_API_KEY "你的KEY"` 后重启 DSH |
| `拿不到 … 的游戏列表：该账号的「游戏详情」隐私设置不是公开` | 在 Steam 隐私设置里把「游戏详情」设为公开 |
| 改了仓库代码但线上没变 | 安装读的是副本（`%USERPROFILE%\dsh-bundles\steam`），而且要**重启 DSH** 才会生效：Host 进程会缓存已加载的 ESM 模块，插件页关开、HMR 重载都只重新装配配置，不会重新读代码。改完先 robocopy，再重启应用。只改 `cordis.patch.yml` 的配置值则不需要重启 |
| DSH 升级后插件装不上 | 已无 `peerDependencies`，正常升级不会受影响；如果安装仍被拒，看管理器给出的诊断 |

## 开发与测试

`test/` 只存在于**仓库**里：安装副本用 `robocopy ... /XD .git test` 同步，运行时不读测试
（想保留也可以去掉 `/XD test`）。所以在安装副本里没有 `test/` 是正常的。

需要 Node 24（DSH 自带的那个就行：`resources\runtime\primary-runtime\dependencies\node\bin\node.exe`）。

```powershell
node --test "test/*.test.js"                        # 130 个用例通过，2 个联网用例跳过（共 132）
$env:DSH_STEAM_LIVE=1; node --test "test/*.test.js"  # 132 个全跑，含打真实 Steam 端点的活体用例
```

插件是**零外部依赖**的（只用 `node:*` 和自己的模块），所以测试像普通包一样直接 import，
不需要任何解析替身。`test/plugin.test.js` 会用假的 `ctx` 真正调用工具函数，包括扫本机的 Steam 库；
`test/library.test.js` 里的注册表用例用 `test/fixtures/registry-steam-path.txt` 锁死 UTF-8 解码，
`test/store.test.js` / `test/webapi.test.js` 用假 http 覆盖价格语义、翻页与截断标记。

`test/fixtures/` 下的 VDF/ACF/PowerShell 输出全是**虚构样例**（数字、应用名、SteamID64 都是编的），
只固定真实文件的结构；活体用例会自动适配任何装了 Steam 的机器，本机没装时跳过。

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

## 变更记录（0.3.0，2026-11）

- **`webApi` 默认 `on`**：14 个工具始终注册，不再因为激活时凭据服务未就绪而让 5 个密钥层工具
  静默消失；缺 Key 时调用会走 `requireKey()` 给出完整配置指引。`auto`（显式配置）保留旧的
  「解析到 Key 才注册 + 自动重试/自愈」语义，`off` 保留「永不注册」。
- **凭据文档纠正**：优先级改为 DSH 的真实顺序——已存 `$DSH_HOME/.credentials.yaml`
  （`version: 1` 的 `refs:`）> 启动环境变量 > 项目 `.env` > `$DSH_HOME/.env`；文档明确写出
  裸写一行会被当作未知顶层键忽略（README、`cordis.patch.yml`、`apiKeyHelp`、`steam_status` 一致）。
- **免费应用价格语义**：商店搜索对 F2P/Demo 不返回价格，`price` 缺失时显示「无价（免费或本区不售）」，
  不再断言本区不售；`steam_store_app` 用 `is_free` 标注免费（缺该字段时用 `price_overview.final = 0` 兜底）。
- **翻页**：`steam_workshop_search` 新增 `page`，`steam_reviews` 新增 `cursor`，两者都在输出里回显
  下一次的值（`下一页：page=…` / `下一页：cursor=…`）。
- **注册表路径编码**：改走 PowerShell 并强制 UTF-8 输出，中文/带空格的 Steam 安装路径不再乱码；
  顺带删掉写死的 `D:\` 候选，配置错误的 `steamPath` 也会继续自动探测。
- **本地库提示**：`steam_games` 过滤无结果时说明「没有匹配……（共 N 个已安装）」而不是谎称装了 0 个；
  `steam_owned_games` 在本机库未探测到时只提示库不可用，不再逐条标「未装在本机」。
- **截断标记**：本地创意工坊条目的目录遍历截断、评测正文截断都补「（已截断）」/「（偏小）」说明，
  列表截断提示保持不变。
- **可靠性**：`webApi=auto` 的补注册用 in-flight promise 去重（并发触发只注册一次），兜底定时器挂
  `ctx.effect`（插件卸载后不再回调）；`steam_status` 去掉了 `isConcurrencySafe` 声明（它会在调用中
  补注册工具、修改插件状态）。
- **配置与超时**：`normalizeConfig` 为每个被拒字段记一条 `warn` 日志；所有工具带 `timeoutMs: 60_000`
  兜底；`lib/library.js` 删除未使用的 `formatUnixSeconds`。
- **描述精简**：9 个工具描述里重复的「不联网 / 不需要 API Key」样板收敛到 `steam_status` 与 README，
  `steam_search` 的「接口单次最多 10 条」只在 `limit` 参数说明里出现一次。

## 变更记录（0.2.0，2026-11）

- **评测迁移**：`steam_reviews` 改用 `api.steampowered.com/IUserReviewsService/GetAppReviews/v1`；
  商店旧端点 `/appreviews` 已于 2026-10-22 停用（现在 302 到首页）。新增 `language` / `sort` / `sentiment`
  三个可选参数，10 分钟进程内缓存，无效 appid 的空响应降级为可读说明。
- **成就名本地化**：`steam_app_stats` 在配了 Key 时用 `GetSchemaForGame` 换成中文成就名；
  没配 Key 时仍可用，但会明确说明显示的是 Steam 内部 API 名。
- **工坊上限**：`steam_workshop_search` 的 `limit` 上限从 200 收到 100（实测 200 会 15 秒超时）。
- **时间可读**：所有时间改成本机时区 + 偏移量（`2026-11-19 22:34 +08:00`）。
- **状态诊断**：`steam_status` 增加插件版本、生效配置摘要、Steam 客户端 PID、系统根证书合并状态。
- **错误可执行**：单独识别「被重定向到别处」，429 给出限流建议，JSON 解析失败带 HTTP 状态与最终 URL，
  URL 里的 `key=` 脱敏。
- **本地工坊**：`steam_workshop_local` 显示所属游戏名；截断提示按工具可用参数生成。

## 卸载

```
plugin_manager  action: remove_bundle  target: @local/steam
```

由管理器改 profile，不要手改。确认卸载完成后，再删安装副本目录。

## 说明

- 仓库目录叫 `dsh-steam`，但包名是 `@local/steam`——这是刻意的：`link:` 安装要求
  **包名与 profile 的依赖键一致**，否则 `node_modules` 下不会出现对应目录。
  改名等于卸载重装，所以保留这个名字，并在安装步骤里按 `@local/steam` 引用。
- 这是个人自用插件，`private: true` 保留（防止误发 npm），不发布到 npm。
- 从 Steam 拉回来的内容（商店简介、评测正文、工坊标题）是**外部不可信数据**，
  只当数据看，不要当指令执行。
- 工具是只读的：没有任何参数能让它们写入 Steam 或系统配置。

## License

MIT
