# Host Filesystem 路径边界

`src/workspace/host-filesystem.ts` 提供独立的 `HostFilesystem`，负责解析、
canonicalization、路径分类和敏感文件边界。它本身不执行文件 I/O，也不授予权限。
当前 MCP 文件工具由 `src/mcp/file-tools.ts` 集成：在调用写入原语前，分别检查
OAuth scope、本机权限模式和重新解析后的 canonical 路径。

```ts
const host = new HostFilesystem(workspace);
const target = host.resolve("C:/other-project/readme.txt");
// { abs: <canonical absolute path>, inputKind: "host-absolute", location: "external" }
const decision = host.checkOperation("C:/other-project/readme.txt", "delete");
// { decision: "deny", code: "EXTERNAL_DELETE_PERMANENTLY_DENIED", ... }
```

## 输入合同

- 相对路径、空串、`.` 和 `workspace:/...` 始终表示 workspace 内路径。
  相对 `..` 或链接越界返回 `PATH_OUTSIDE_WORKSPACE`，不会偷偷转换成外部访问。
  alias 大小写不敏感，`workspace:/` 表示根目录。
- 显式绝对路径表示 host 路径，可以最终归类为 `workspace` 或 `external`。
  Windows 支持 `C:\foo\bar.txt`、`C:/foo/bar.txt` 和大小写盘符。
- 两种 separator 均标准化；`.` / `..` 按原生路径语义规范化后，解析结果才用于 I/O。
  不支持在 POSIX 上寻址名称含字面反斜线的文件。
- Windows 的 drive-relative (`C:foo`) 和 root-relative (`\foo`、`/foo`)
  输入拒绝。绝对路径必须明确盘符；POSIX 原生绝对路径在 POSIX 上支持。
- UNC、设备命名空间和 extended-length 前缀明确拒绝；本版本不支持网络卷。
  链接的 canonical target 若落入不支持的命名空间，同样拒绝。
- ADS、其他 URI scheme、控制字符、首尾空白以及 Windows 保留设备名、尾点、
  尾空格和无效字符拒绝。非 Windows host 不把 Windows 盘符路径解释为相对文件名。

## Canonicalization 与分类

先对候选路径逐层 `lstat`，只在 `ENOENT` 时查找父目录；对最深的已存在祖先使用
`realpathSync.native()`，然后拼接不存在的 suffix。已有普通文件不能充当新 leaf 的父目录。
断链、链接环、权限错误和无法 canonicalize 的 reparse point 均拒绝，不回退到 lexical 路径。

唯一分类实现检查 canonical path 的完整祖先链，正确处理根目录和同前缀 sibling。
Windows native realpath 会还原已存在 component 的实际大小写，因此盘符和普通大小写别名
不影响分类。比较 canonical ancestor 时保留大小写，不用全路径小写化合并可能存在的
Windows case-sensitive 目录。不存在 component 的大小写按原样保留。
原始入口的大小写 root alias 还需通过 native realpath 确认与 workspace 根目录相同，
再保留其相对路径名称用于 `.c2cignore` 和删除策略；不能仅凭大小写折叠认定同一根目录。
Workspace 根目录的 canonical path 和 `dev` / `ino` 身份在每次解析时复核；被替换或
无法验证时返回 `WORKSPACE_ROOT_CHANGED`。macOS/POSIX 同样以 native canonical spelling 为准。

## 敏感文件与删除接缝

`resolve()` 和 `checkOperation()` 同时检查 lexical alias 与 canonical target。
默认 host adapter 复用 `SENSITIVE_PATTERNS`，将路径投影为卷根下的相对路径后再使用
gitignore 语义，包含 sensitive directory 本身。不会把绝对路径直接交给 `IgnoreRules`。
`.env.example` 例外保留。归类到 workspace 的路径还检查现有 `.c2cignore`。
`.c2cignore` 只作用于 workspace；外部路径扩展策略由第二个构造参数
`HostSensitivePolicy` 提供，接收 `abs`、`rootRelative`、`location` 及可用的
`workspaceRelative`。该策略只能增加拒绝，不能取消内置规则。

`checkOperation(path, "delete")` 在 lexical 或 canonical 任一位置属于 external 时返回
`EXTERNAL_DELETE_PERMANENTLY_DENIED`；外部链接指向内部也不能通过该接口取得删除许可。
这项拒绝不受权限等级影响。read、write 和内部 delete 只返回
`requires-permission`，不是允许结果。敏感路径仍抛出 `ACCESS_DENIED_SENSITIVE_FILE`。
无论解析器给出什么分类，后续权限层都必须独立批准操作。

## 当前 MCP 文件工具集成

| 操作 | 当前规则 |
|---|---|
| workspace 文件创建、编辑、替换 | 需要 `workspace.write` scope 和 `level1` 或 `level2`；替换与编辑要求匹配本次读取的内容 hash |
| workspace 目录创建 | 只创建一个 workspace 目录，父目录必须存在；需要 `workspace.write` 和可写本机模式 |
| workspace 文件移动 | 只允许 workspace 到 workspace，目标必须不存在；需要 `workspace.write` 和可写本机模式 |
| workspace 文件删除 | 只删一个普通文件，并要求匹配当前内容 hash；需要 `workspace.delete` 和 `level2` |
| workspace 外读取 | 读取非敏感 UTF-8 普通文件，受大小和分页上限约束；需要 `filesystem.external.read` 和权限 1 或 2 |
| workspace 外创建、编辑、替换 | 仅支持文件；需要 `filesystem.external.write` 和 `level2` |
| workspace 外目录创建、跨边界移动、删除 | 当前没有这些工具；外部删除在所有模式都硬拒绝 |

`permission_status` 只读报告当前 workspace 的本机权限。权限只能由本机
`c2c permission readonly|1|2|status` 命令变更。OAuth scope 与本机权限是两道独立门槛。

## 集成约束与验证范围

返回值是冻结的路径快照，**不是文件访问 capability**。当前 MCP 写工具在执行前重新解析
canonical `abs` 并检查 OAuth scope、本机权限和敏感文件规则，禁止使用未检查的原始输入
直接调用 `fs`。移动涉及两个路径，源码分别重新解析并确认两端仍在 workspace；当前目标
必须不存在。覆盖与删除分别使用独立操作授权和内容 hash 检查，不能把 write 的结果当成
删除授权。

本层不执行 syscall，因此不宣称消除 TOCTOU。MCP 写原语会在同步操作前再次解析和检查，
但该检查不能隔离其他原生进程，也不能约束绕开正式层的任意本地代码。`checkOperation()`
不是包装 `fs.rm` 的删除工具；当前 MCP 删除只处理单个普通 workspace 文件，不提供目录删除。

独立测试区分纯 Windows parser 测试和实际 host 测试。Windows 上用真实 junction 验证
目录跳转及不存在 leaf；文件 symlink 权限不足时测试显式 skip。POSIX 测试仅在 POSIX
host 执行，不冒充 Windows 验证。当前未覆盖网络卷（明确不支持）、实际启用的 NTFS
case-sensitive 目录、其他特殊 reparse tag、长路径极限和并发链接替换。
