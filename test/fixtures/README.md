# 测试夹具说明

这里的 VDF / ACF 文件**全部是虚构样例**，不是从任何人的机器上抓下来的。

它们的作用是固定 Steam 真实文件的**结构**（缩进、转义、嵌套、字段名与类型），
让解析器与映射逻辑能在不依赖本机 Steam 的情况下被测试。数字、应用名、
SteamID64、contentid 与时间戳都是编的。

覆盖的真实结构：

| 文件 | 覆盖点 |
|---|---|
| `libraryfolders.new.vdf` | 新版库列表：`path` / `label` / `apps` 子映射 |
| `libraryfolders.old.vdf` | 旧版库列表：数字键的值直接是路径，且同文件混有 `TimeNextStatsReport` 之类的字符串元数据 |
| `appmanifest_1234560.acf` | `appmanifest_*.acf`：字符串标量、嵌套的 `InstalledDepots` / `SharedDepots` / `UserConfig`、`\\` 转义路径 |
| `loginusers.vdf` | `loginusers.vdf`：SteamID64 作为键，含 `PersonaName` / `AutoLogin` / `Timestamp` |
| `registry-steam-path.txt` | PowerShell 查询注册表的 stdout **原始 UTF-8 字节**：`位置|值名|路径`，路径含中文与空格，用来锁死「非 ASCII 安装路径不能乱码」 |

`test/library.test.js` 里另有**活体**用例，它们会真的扫描本机 Steam；
本机没装 Steam 时自动跳过。
