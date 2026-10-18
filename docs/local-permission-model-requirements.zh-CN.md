# C2C 本机访问与权限模型需求

日期：2026-10-04

状态：需求基线（2026-10-17 已补充 Full Access / Remote Parity 最终裁决）

适用仓库：`RomioLA/codex-with-chatgpt`

本文记录本 fork 后续扩展 C2C 本机能力时已经讨论并确认的需求，以及实现时必须明确处理、但仍可在技术方案阶段细化的事项。

本文不是实现方案，不要求按照某一种内部代码结构完成；实现可以调整，但不得在没有用户明确确认的情况下缩减本文已经确认的权限能力、禁止项和人工授权边界。

## 0. 2026-10-17 产品裁决：Full Access / Remote Parity

本节是对本文早期权限设计的后续明确裁决。若本文后续旧段落与本节冲突，以本节为准。

- C2C 的最高本机权限模式定义为 **Full Access**。当前 V1.3.2 实现中，最高有效本机权限仍使用 `level2` 名称；产品语义按 Full Access 理解。
- 用户在本机明确选择 Full Access，本身就是对普通本机操作的授权边界。ChatGPT 仍不得自行从低权限提升到 Full Access。
- Full Access 的目标是在相同 Windows 用户、登录会话和 elevation 上，对非 GUI 的本机开发和主机操作达到 Remote Desktop Commander 的实际能力覆盖。
- Full Access 不得把“逐命令人工批准”“逐命令 digest 确认”“trusted-command 预登记”“单独开启 Level 3”作为普通通用命令执行的必经条件。
- PowerShell、CMD、直接程序、Node、Python、包管理器、测试、构建、lint、typecheck、Git、进程及其他同用户权限下的普通本机操作，都属于 Full Access 必须覆盖的能力范围。
- C2C 可以保留或加强 OAuth/client binding、workspace/repository identity、Job Object、输出脱敏、审计、stale protection、reparse/path validation、crash safety 等机制；这些是安全与可靠性增强，不能被用来把 Full Access 静默降级成比 Remote 更弱的权限层。
- 历史 Level 3 单次审批、trusted-command registry、Git repository approval 可以继续服务 restricted mode、兼容性、结构化安全路径或历史行为，但不得覆盖 Full Access 的最终产品合同。
- 如果未来因为安全原因确实需要降低 Full Access 已有能力，必须作为产品合同变更明确提出并获得用户/产品 owner 确认，不能作为普通实现细节静默收紧。
- 具体非回退验收矩阵见 `docs/remote-parity-acceptance.md`，仓库级开发约束见根目录 `AGENTS.md`。

---



## 1. 背景

当前 C2C 的主要特点是：

- ChatGPT 可以连接到一个指定的本地 workspace；
- 可以读取 workspace 内的文件、搜索代码、查看 Git 状态、diff、测试或执行记录等；
- 当前整体设计以只读为主；
- ChatGPT 不能直接通过 C2C 修改本地 workspace；
- 如果需要真正修改代码，当前通常仍要交给 Codex 等本地执行者完成，然后再由 C2C 读取结果进行复核。

当前 Remote Desktop Commander 则属于更高权限的通用本机工具，可以在电脑范围内进行读取、写入、删除和命令执行。

本 fork 的目标不是简单复制 Remote Desktop Commander，而是让 C2C 在保留“明确 workspace、明确权限、权限由用户本机控制”这些特点的同时，逐步具备真正的本机修改和执行能力。

用户希望最终减少下面这种反复中转：

1. ChatGPT 通过 C2C 调查代码；
2. ChatGPT 再生成提示词；
3. 用户把提示词交给 Codex；
4. Codex 修改；
5. ChatGPT 再通过 C2C 读取 diff 和结果；
6. 如果还有问题，再重复一轮。

目标是让获得相应权限后的 ChatGPT 可以直接完成：

1. 调查；
2. 修改；
3. 查看修改结果；
4. 必要时运行验证；
5. 再修改；
6. 最终复核。

---

## 2. 核心原则

### 2.1 保留“指定 workspace”概念

C2C 仍然必须有一个明确的“当前指定文件夹 / workspace”。

这个 workspace 是权限判断的中心边界。

所有文件访问都必须先区分：

- workspace 内；
- workspace 外。

不能因为增加高权限，就取消 workspace 概念，直接把所有文件访问都当成全盘访问。

### 2.2 权限由用户本机决定

权限等级必须由用户在本机明确设置。

ChatGPT 可以读取并知道当前权限等级，但不能自行把自己从低权限提升到高权限。

例如：

- 当前是只读，ChatGPT 不能自己切换到权限 1；
- 当前是权限 1，ChatGPT 不能自己切换到权限 2；
- 如果某个操作需要更高权限，ChatGPT 应明确说明缺少什么权限，由用户决定是否在本机提升。

这是必须保留的安全边界。

### 2.3 自有链路不等于无限权限

本 fork 的一个重要价值是：C2C 的服务、域名、Bridge、认证和权限模型可以由用户自己控制，减少对第三方远程控制服务的依赖。

但“链路由自己控制”和“本机允许做什么”是两个问题。

即使连接链路完全由用户自己控制，也仍然需要清楚区分读取、写入、删除和命令执行权限。

---

## 3. 权限总体结构

在现有只读能力的基础上，新增两个提升等级。

因此实际使用时存在三个状态：

1. 当前只读模式；
2. 权限 1；
3. 权限 2。

这里所说的“分两层”是指在现有只读能力之上增加权限 1 和权限 2，而不是删除现有只读模式。

---

## 4. 当前只读模式

这是现有 C2C 的基础安全模式。

### 4.1 workspace 内

允许：

- 读取文件；
- 列出目录；
- 搜索内容；
- 查看 Git 状态；
- 查看 Git diff；
- 查看已经记录的测试、构建、执行结果；
- 其他现有只读能力。

不允许：

- 创建文件；
- 修改文件；
- 覆盖文件；
- 重命名或移动文件；
- 删除文件；
- 通过写操作改变 workspace 状态。

### 4.2 workspace 外

默认不开放普通文件读取和写入能力。

现有敏感文件保护仍然保留。

---

## 5. 权限 1

权限 1 是计划中的日常开发权限。

它的目标是：让 ChatGPT 能够真正参与日常代码开发，但不直接获得高风险删除能力，也不直接获得 workspace 外写权限。

### 5.1 workspace 内：允许读取

保留只读模式已有的全部 workspace 内读取、搜索、Git 查看和结果复核能力。

### 5.2 workspace 内：允许写入

权限 1 必须允许 ChatGPT 在当前指定 workspace 内执行正常开发所需要的写操作，包括：

- 创建新文件；
- 修改已有文件；
- 对已有文本文件进行局部编辑；
- 对已有文件进行完整写回；
- 创建新目录；
- 在 workspace 内重命名文件；
- 在 workspace 内移动文件；
- 保存代码修改；
- 保存配置修改；
- 保存文档修改；
- 其他属于“正常写入但不是删除”的 workspace 内操作。

### 5.3 workspace 内：权限 1 不允许删除

权限 1 不应获得删除能力。

因此权限 1 下，不允许：

- 删除文件；
- 删除目录；
- 递归删除目录；
- 通过专门删除工具移除 workspace 内内容。

关于“用覆盖方式把文件清空是否等价于删除”的具体保护方式，可以在实现设计阶段进一步确定，但实现不能故意通过其他工具绕过“权限 1 不允许删除”的产品边界。

### 5.4 workspace 外：允许读取

权限 1 必须增加 workspace 外读取能力。

目的是让 ChatGPT 在需要调查真实本机环境时，不必因为文件位于当前 repo 之外就完全无法查看。

例如可能需要读取：

- 另一个项目中的普通文件；
- 本机日志；
- 构建产物旁的文本信息；
- 安装目录中的普通配置；
- Release 目录中的普通元数据；
- 用户明确需要分析的其他普通文件。

但是，workspace 外读取仍然必须继续遵守敏感信息保护规则。

不能因为获得权限 1 就默认开放：

- 私钥；
- token；
- 密码；
- credential；
- 明确被 C2C 敏感文件策略禁止的内容。

是否需要允许用户针对某些敏感路径做额外人工授权，可以以后单独设计；本轮不要求自动解除敏感文件保护。

### 5.5 workspace 外：权限 1 不允许写入

权限 1 下，workspace 外只能读取，不能修改。

不允许：

- 创建 workspace 外文件；
- 修改 workspace 外文件；
- 覆盖 workspace 外文件；
- 重命名 workspace 外文件；
- 移动 workspace 外文件；
- 删除 workspace 外文件或目录。

---

## 6. 权限 2

权限 2 是更高权限模式。

它用于确实需要跨 workspace 修改本机内容，或者需要在当前 workspace 内进行删除操作的任务。

### 6.1 继承权限 1 的全部能力

权限 2 包含权限 1 已经允许的全部读取和写入能力。

### 6.2 workspace 内：增加删除能力

权限 2 下，允许删除当前指定 workspace 内的内容。

包括：

- 删除文件；
- 删除目录；
- 在有明确目标时删除目录内容；
- 完成正常开发、清理、重构所需要的 workspace 内删除操作。

具体是否对“递归删除大量文件”增加额外确认、数量限制或审计记录，可以在实现阶段设计。

但产品层面的结论是：权限 2 必须能够完成 workspace 内删除。

### 6.3 workspace 外：增加写入能力

权限 2 下，允许对 workspace 外进行写操作。

包括：

- 创建 workspace 外文件；
- 修改 workspace 外已有文件；
- 覆盖 workspace 外文件；
- 在允许的情况下创建目录；
- 为完成真实本机任务进行必要的跨目录修改。

这项能力的目的，是让 C2C 不再只能处理当前 repo，而是在用户明确给予高权限后，可以帮助处理 repo 外的真实开发环境和相关文件。

### 6.4 workspace 外：Full Access 允许按当前 Windows 用户权限删除

2026-10-17 产品裁决后，最高权限模式不再把 workspace 外删除作为永久硬禁令。

当用户已在本机明确选择 Full Access（当前 V1.3.2 实现名为 effective `level2`）时，C2C 应能够在与 Remote 相同的 Windows 用户、session 和 elevation 权限范围内执行必要的 workspace 外删除，包括普通文件、目录及开发/维护所需的递归清理。

仍然必须保留：

- ChatGPT 不能自行从低权限提升到 Full Access；
- 敏感路径、credential、受保护 C2C 自身状态等明确产品级保护；
- 路径 canonicalization / reparse / identity / audit 等安全检查；
- 对真实 OS 权限、sharing/ACL、UAC/elevation 边界的尊重。

不得通过逐命令审批、trusted-command allowlist 或单独 Level 3 开关重新把 Full Access 的普通删除能力封死。

---

## 7. 权限矩阵

最终的基础文件权限应符合下面的关系：

| 操作 | 只读 | 权限 1 | 权限 2 |
|---|---|---|---|
| workspace 内读取 | 允许 | 允许 | 允许 |
| workspace 内创建 | 禁止 | 允许 | 允许 |
| workspace 内修改 | 禁止 | 允许 | 允许 |
| workspace 内重命名 / 移动 | 禁止 | 允许 | 允许 |
| workspace 内删除 | 禁止 | 禁止 | 允许 |
| workspace 外读取 | 禁止 | 允许 | 允许 |
| workspace 外创建 | 禁止 | 禁止 | 允许 |
| workspace 外修改 / 覆盖 | 禁止 | 禁止 | 允许 |
| workspace 外删除 | 禁止 | 禁止 | **允许（Full Access；受同用户 OS 权限与明确产品级敏感保护约束）** |

这张表是当前权限设计的最重要产品合同之一。

---

## 8. 高权限如何由用户开启

当前 C2C 没有一个适合日常操作的完整本地 GUI 窗口，因此权限切换不能依赖“以后再做一个复杂桌面管理器”才能使用。

第一阶段必须提供简单、明确、可以在本机完成的权限切换方式。

### 8.1 必须有本机权限控制入口

至少要提供类似下面的本机命令能力：

```text
c2c permission readonly
c2c permission 1
c2c permission 2
```

实际命令名称可以在实现阶段调整，但必须满足：

- 用户可以在本机明确切换权限；
- 不需要进入 ChatGPT 让模型替用户提权；
- 不需要修改源码才能切权限；
- 可以查看当前权限；
- 权限变化有明确成功或失败反馈。

还应提供类似：

```text
c2c permission status
```

用于查看当前实际权限。

### 8.2 ChatGPT 不能自行提权

这是强制要求。

ChatGPT 可以通过 C2C 看到当前是：

- readonly；
- permission 1；
- permission 2。

但 ChatGPT 不得拥有一个可以直接把自己切换到更高权限的 MCP tool。

换句话说：

- MCP 可以报告权限；
- MCP 可以根据权限允许或拒绝操作；
- 但不能把“提升自己的权限”作为普通远程工具开放给模型。

用户提权动作必须发生在用户控制的本机侧。

### 8.3 桌面快捷方式

为了让不熟悉命令行的用户能够直接使用，计划同时提供非常简单的本机快捷入口，例如桌面快捷方式：

- `C2C 只读`
- `C2C 权限 1`
- `C2C 权限 2`

快捷方式本质上可以只是调用对应的本机 C2C 命令，不要求第一阶段实现完整 GUI。

目标是让用户双击即可切换，不需要每次记命令。

### 8.4 后续 GUI 不属于第一阶段硬要求

未来可以增加托盘菜单或小型控制窗口，例如显示：

- C2C 是否在线；
- 当前 workspace；
- 当前权限；
- Tunnel 状态；
- 一键切换权限；
- 一键重启 Bridge；

但不能因为未来可能做 GUI，就让第一阶段权限功能依赖 GUI 才能使用。

---

## 9. 权限持久化

权限设置应该由 C2C 本机保存，而不是只存在于某一次 ChatGPT 对话中。

### 9.1 基本要求

电脑重启、Bridge 重启或 ChatGPT 页面刷新后，不应该因为远端状态丢失而无法知道当前授权策略。

权限配置应保存在 C2C 本机配置中。

### 9.2 只读与权限 1

只读和权限 1 应支持持久保存。

如果用户主动选择权限 1，则 C2C 重启后应该能够恢复到用户保存的权限状态，而不是要求用户每次重新配置。

### 9.3 权限 2

权限 2 也需要具备可持久化的实现能力。

如果后续希望提供“重启后自动降回权限 1”的可选安全设置，可以增加，但不应把它硬编码成唯一行为。

也就是说，实现最好允许用户决定：

- 权限 2 重启后继续保持；
- 或权限 2 重启后自动降级。

如果第一阶段暂时只实现一种行为，必须在实现前明确说明，不能静默决定。

---

## 10. 电脑重启后的 C2C 自动恢复

当前实际使用中还有一个独立问题：电脑每次重启后 C2C 可能会断开，用户往往需要再进入 Codex 对话，让 Codex 帮忙修复或重新启动。

这会严重影响高权限 C2C 的日常可用性。

因此本 fork 的目标还包括解决“每次重启都需要人工找 Codex 修 C2C”的问题。

### 10.1 目标体验

理想流程：

```text
Windows 启动 / 用户登录
→ C2C Bridge 自动启动
→ 所需 Tunnel 自动恢复
→ 原有本机配置和权限加载
→ ChatGPT 连接重新可用
```

用户不应每次重启电脑都必须：

- 打开 Codex；
- 新开对话；
- 让 Codex 排查 C2C；
- 手工重新跑一串修复命令；
- 再回到 ChatGPT。

### 10.2 权限恢复和连接恢复是两个问题

实现时必须区分：

- 权限配置是否还在；
- Bridge / Tunnel 是否在线。

不能因为权限已经持久化，就认为重启恢复已经完成。

也不能因为 Tunnel 恢复了，就认为权限状态一定正确。

两者都需要有明确状态。

### 10.3 自动启动失败时要可诊断

如果自动恢复失败，至少要能通过简单命令看到：

- Bridge 是否运行；
- Tunnel 是否运行；
- 当前 workspace；
- 当前权限；
- 最近一次启动失败原因。

不要求普通用户阅读复杂日志才能知道“到底哪一层坏了”。

---

## 11. 命令执行能力

文件读写权限本身不能覆盖完整的软件开发流程。

例如 ChatGPT 修改代码后，通常还需要：

```text
pnpm test
pnpm build
git status
git diff
node ...
python ...
PowerShell ...
```

因此如果目标是让 C2C 真正减少对 Codex / Remote Desktop Commander 的依赖，就必须在后续实现中处理“命令执行”能力。

### 11.1 命令执行不是普通文件写入

命令执行必须作为独立能力设计，不能简单认为“有写权限 = 可以任意运行 PowerShell”。

原因是：

- 一个命令可以读取 workspace 外文件；
- 一个命令可以修改 workspace 外文件；
- 一个命令可以删除文件；
- 一个命令可以启动其他程序；
- 一个命令甚至可以绕开普通文件工具本身的目录限制。

因此命令执行必须与本文文件权限边界一致，不能成为绕过权限模型的后门。

### 11.2 已确认的产品目标

后续 C2C 应具备足够的软件开发命令执行能力，使 ChatGPT 可以在获得合适授权后自行完成：

- 测试；
- lint；
- typecheck；
- build；
- Git 检查；
- Node / Python 等项目工具；
- 必要的 PowerShell / CMD 操作。

### 11.3 Full Access 命令执行已冻结的产品结论

2026-10-17 后，最高权限模式的通用命令执行不再属于“是否开放”的待设计项。

Full Access 必须允许：

- PowerShell / CMD；
- 直接可执行程序；
- Node / Python；
- package manager、测试、build、lint、typecheck；
- 普通 Git 命令和开发工具；
- 合法 cwd；
- 长时间任务、状态、stdout/stderr 与取消；
- 在相同 Windows 用户 / session / elevation 下 Remote 能完成的普通非 GUI 本机操作。

普通 Full Access 命令不得要求逐命令人工审批、digest 确认、trusted-command 预登记或额外 Level 3 feature switch。

仍可继续设计和强化的是“如何更可靠地执行”，例如 Job Object、审计、输出脱敏、超时、幂等、crash recovery、路径与 material 验证。Restricted mode 的命令边界也可以继续较窄。

如果某类操作要作为 Full Access 的明确例外，必须写入产品需求和 Remote Parity 验收矩阵，不能由实现者默默假设。

---

## 12. 写入并发与误覆盖保护

增加写权限后，需要避免 ChatGPT 读取旧版本文件后，把用户或 Codex 刚刚完成的新修改覆盖掉。

例如：

1. ChatGPT 读取 `foo.ts`；
2. 此时用户或其他工具修改了 `foo.ts`；
3. ChatGPT 仍然根据旧内容提交完整覆盖；
4. 新修改被意外丢失。

因此实现应具备“写入前确认文件仍是自己读取的版本”的能力。

推荐使用文件 hash、版本号或等价机制。

例如编辑请求可以携带：

```text
expected_hash
```

如果目标文件已经变化，则拒绝写入，并返回类似：

```text
STALE_FILE
```

然后由 ChatGPT 重新读取并处理冲突。

具体字段名可以变化，但不能完全没有并发保护。

---

## 13. 优先支持局部编辑

虽然权限 1 和权限 2 都可能允许完整文件写回，但日常代码修改应优先提供局部编辑能力。

例如：

- 精确文本替换；
- 基于旧内容的替换；
- patch；
- 明确范围修改。

原因：

- 更不容易误覆盖无关内容；
- diff 更小；
- 更容易审核；
- 并行修改冲突更容易发现；
- 对大文件不需要每次完整传输。

完整 `write_file` 仍然可以存在，用于创建新文件或确实需要完整替换的情况。

---

## 14. 敏感文件保护

现有 C2C 对敏感文件的保护不能因为增加权限 1 / 权限 2 就自动取消。

至少继续保护典型敏感内容：

- `.env`；
- 私钥；
- credential；
- token；
- 密码文件；
- 当前安全策略已经明确禁止读取的内容。

未来如果用户确实需要授权某个敏感文件，应通过独立、明确的本机授权设计处理，而不是让 ChatGPT 自己关闭敏感文件策略。

---

## 15. 审计要求

增加写入和高权限能力后，C2C 应记录足够的操作审计信息，方便用户知道某次变化来自哪里。

至少应考虑记录：

- 时间；
- 使用的工具；
- 当前 workspace；
- 当前权限等级；
- 操作的文件路径；
- 操作类型：读取 / 创建 / 修改 / 移动 / 删除 / 执行命令；
- 修改前 hash；
- 修改后 hash；
- 成功或失败；
- 如果被权限拒绝，拒绝原因。

审计日志本身不能记录敏感 credential 的正文。

目标是出现问题时可以回答：

- 这是 ChatGPT 通过 C2C 改的；
- 这是 Codex 改的；
- 这是用户手工改的；
- 这次操作为什么被拒绝。

---

## 16. 权限拒绝必须清楚

当 ChatGPT 请求了当前权限不允许的操作时，不应该只返回模糊的“失败”。

需要明确区分例如：

- 当前为只读，不能写 workspace；
- 当前为权限 1，不能删除 workspace 内文件；
- 当前为权限 1，不能写 workspace 外文件；
- 当前权限不足以完成所请求操作，或目标命中 Full Access 仍保留的明确产品级敏感保护；
- 目标属于敏感文件；
- 文件在读取后已经变化；
- 路径无效；
- 操作越界。

这样 ChatGPT 才能正确告诉用户需要做什么，而不是不断尝试不同工具。

---

## 17. Restricted mode 不允许通过其他工具绕过权限；Full Access 不再人为降级

权限模型必须针对“最终效果”，而不仅仅针对某几个工具名。

例如：

- 权限 1 禁止删除，不能再提供一个 `shell rm` 来绕过；
- 权限 1 禁止 workspace 外写入，不能通过 move / copy / shell 间接写到外面；
- readonly / 权限 1 的限制不能通过通用命令执行旁路。

但 Full Access 的目标恰恰是允许同一 Windows 用户权限范围内的通用本机操作。不能继续用 restricted mode 的禁止项反向约束 Full Access，造成 Remote 可以做而 C2C Full Access 做不了。

因此实现必须区分：

- restricted mode：命令执行不得绕过其权限边界；
- Full Access：不以 C2C 独有的逐命令审批、allowlist 或 Level 3 gate 人为降级能力，但仍保留敏感信息保护、审计、OS 权限和明确产品级例外。

---

## 18. V1.3.2 最终目标包含 Full Access Remote Parity

此前“第一阶段不要求达到 Remote 能力”的阶段性原则已经被 2026-10-17 产品裁决取代。

内部实现仍可以分阶段完成，但在 V1.3.2 最终 Release Gate 上：

1. readonly / restricted 权限边界必须正确；
2. ChatGPT 仍不能自行提权；
3. Full Access 必须达到 `docs/remote-parity-acceptance.md` 定义的关键 Remote parity；
4. 普通通用命令执行不能再依赖逐命令人工审批、trusted-command 预登记或单独 Level 3 开关；
5. 长任务、输出、取消、Git、进程和本机开发操作必须有可用链路；
6. C2C 安全增强不能以迫使日常任务重新退回 Remote 为代价；
7. 重启与连接恢复仍需保持可诊断、可恢复。

如果某项 parity 尚未实现，应明确报告 `NOT_YET_IMPLEMENTED` 或 `FAIL`，而不是把它重新定义为“第一阶段不要求”。

---

## 19. 预期最终使用方式

### 19.1 普通调查

用户保持只读：

```text
ChatGPT
→ C2C
→ 读取 workspace
→ 调查 / 审核
```

### 19.2 日常开发

用户本机切换到权限 1：

```text
ChatGPT
→ 读取项目
→ 修改 workspace 内代码
→ 读取 workspace 外必要信息
→ 查看 diff
→ 运行允许的开发验证
→ 继续修复
```

不允许删除文件，也不允许修改 workspace 外内容。

### 19.3 Full Access 高权限开发

用户本机切换到最高权限（当前 V1.3.2 实现名为 effective `level2`）：

```text
ChatGPT
→ 完成权限 1 的全部工作
→ 可以删除 workspace 内文件
→ 可以创建 / 修改 / 删除 workspace 外普通文件和目录
→ 可以运行 PowerShell / CMD / exe / Node / Python / Git 等通用命令
→ 可以完成需要跨目录、进程与主机操作的开发任务
```

普通操作不再需要逐命令本机审批。仍受相同 Windows 用户/session/elevation、敏感保护、审计以及明确产品级例外约束。

### 19.4 权限不足

如果 ChatGPT 需要更高能力：

```text
ChatGPT：当前操作需要权限 2。
```

然后停止。

是否提升由用户本机决定。

ChatGPT 不能自己执行“把权限改成 2”。

---

## 20. 验收要求

实现完成后，至少需要验证下面这些场景。

### 20.1 只读

- workspace 内读取成功；
- workspace 内写入失败；
- workspace 内删除失败；
- workspace 外读取失败；
- workspace 外写入失败；
- workspace 外删除失败。

### 20.2 权限 1

- workspace 内读取成功；
- workspace 内创建成功；
- workspace 内修改成功；
- workspace 内移动 / 重命名成功；
- workspace 内删除失败；
- workspace 外普通文件读取成功；
- workspace 外创建失败；
- workspace 外修改失败；
- workspace 外删除失败；
- 敏感文件仍然被保护。

### 20.3 权限 2

- 权限 1 的允许能力继续成功；
- workspace 内删除成功；
- workspace 外创建成功；
- workspace 外修改成功；
- workspace 外覆盖在设计允许的条件下成功；
- workspace 外删除成功（目标在同用户 OS 权限范围内且不命中明确产品级保护）；
- PowerShell / CMD / exe / Node / Python 等普通通用执行不需要逐命令审批；
- 敏感文件保护仍然有效。

### 20.4 提权控制

- 用户可以在本机查看当前权限；
- 用户可以在本机切换权限；
- ChatGPT 可以看到当前权限；
- ChatGPT 无法自行提权；
- 权限拒绝返回明确原因。

### 20.5 重启恢复

- Windows 重启后 C2C 可以自动启动或自动恢复；
- Bridge 状态可检查；
- Tunnel 状态可检查；
- workspace 配置仍然正确；
- 权限配置按照用户设定恢复；
- 不需要每次开机都重新找 Codex 手工修连接。

### 20.6 并发保护

- ChatGPT 读取文件后，如果其他执行者先修改该文件，旧写入不能静默覆盖新版本；
- C2C 应拒绝陈旧写入并要求重新读取。

### 20.7 权限边界与 Full Access

- 权限 1 不能通过其他工具绕过 workspace 内删除限制；
- 权限 1 不能通过其他工具绕过 workspace 外写入限制；
- Full Access 不得被 restricted mode 的旧禁令人为降级；
- Full Access 普通命令执行不得重新引入逐命令审批、trusted-command 依赖或额外 Level 3 开关。

---

## 21. 当前已经确认与尚待设计的边界

### 已经确认

- 保留指定 workspace 概念；
- 现有只读模式继续存在；
- 在其上增加权限 1 和权限 2；
- 权限 1：workspace 内可写；
- 权限 1：workspace 外可读；
- 权限 1：workspace 内不可删；
- 权限 1：workspace 外不可写、不可删；
- 权限 2：workspace 内可删；
- 权限 2：workspace 外可写；
- Full Access（当前实现名 effective `level2`）：workspace 外删除属于目标能力；
- Full Access：普通通用命令执行以 Remote parity 为目标，不逐命令审批；
- 权限必须由用户本机控制；
- ChatGPT 不得自行提权；
- 权限需要本机持久化；
- 不应因为没有完整 GUI 就无法切换权限；
- 第一阶段应提供简单本机命令，适合进一步做桌面快捷方式；
- 希望解决 Windows 重启后 C2C 经常需要 Codex 手工恢复的问题；
- Full Access 必须具备通用命令执行能力，让 ChatGPT 真正完成修改、验证和本机维护闭环；
- restricted mode 的权限机制不能被 shell 或其他间接工具轻易绕过；
- Full Access 的安全机制不得被用作 Remote parity 的能力降级理由。

### 仍需实现设计进一步确定

- Full Access 当前 session-scoped `level2` 与未来正式命名/UX 如何统一；
- restricted mode 具体允许哪些命令；
- Full Access generic execution 的最佳 MCP 工具形态与短任务/长任务 UX；
- 如何在不降低 Full Access 能力的前提下继续加强 audit、secret protection、Job Object、crash recovery；
- 完整文件覆盖和“等价删除”之间的防护规则；
- 高风险批量操作是否需要速率限制、审计提示等非阻断式保护；
- 未来是否增加托盘或小型本地 GUI。

这些待设计项不能反向修改前面已经确认的权限矩阵，除非用户重新明确确认。

---

## 附录 A：当前实现状态

本文件前文仍是产品需求基线；下表说明当前代码已经交付的范围，避免把目标需求误读成
现有能力。OAuth scope 和本机权限模式分别检查：新授权默认仍只有读取 scopes，文件修改
还要求本机已保存的模式允许该操作。MCP 的 `permission_status` 只能读取权限，不能提权；
本机命令为：

```text
c2c permission readonly
c2c permission 1
c2c permission 2
c2c permission status
```

当前权限状态按 workspace 持久化，包含 `level2`，当前没有重启后自动降级选项；状态缺失、
格式错误、workspace 不匹配或版本不支持时，读取结果回退到 `readonly`。当前实际能力如下：

| 能力 | 当前实现 |
|---|---|
| workspace 文件创建、编辑、替换 | 权限 1、2 可用；替换和编辑要求与本次读取一致的内容 hash |
| workspace 文件移动 | 权限 1、2 可用；仅 workspace 内移动，目标必须不存在 |
| workspace 目录创建 | 权限 1、2 可用；一次创建一个目录，父目录必须存在 |
| workspace 删除 | 权限 2 仅可删除一个普通文件，并要求当前内容 hash；**目录删除和递归删除尚未实现** |
| workspace 外读取 | 权限 1、2 可读取受敏感文件规则保护的文本文件 |
| workspace 外写入 | 权限 2 可创建、编辑或替换文件；**workspace 外目录创建尚未实现** |
| workspace 外移动或删除 | **当前实现仍未提供完整工具；这是 Full Access Remote Parity 的待实现差距，不再是产品级永久禁令** |

因此，前文 6.2 所述 workspace 目录和递归删除仍属于未完成要求，不是当前可调用能力。
前文权限矩阵与第 0 节继续描述目标边界；当前实现不足必须按 Remote Parity gap 追踪，不能反向把缺失能力解释成产品禁止。实施现状以本附录和
[Host Filesystem 路径边界](host-filesystem-boundary.zh-CN.md)为准。