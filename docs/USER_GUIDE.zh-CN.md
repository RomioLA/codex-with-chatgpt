# C2C Local V1.4 用户使用指南

[安装](INSTALL.zh-CN.md) · [AI 工具指南](AI_GUIDE.md) · [故障排查](troubleshooting.md)

安装并连接后，直接在 ChatGPT 中说：

> 请使用 C2C 读取我授权工作区下的项目 README 和 Git 状态，先做只读分析，未经同意不要改源码。

ChatGPT 应先调用 **workspace_info** 核实工作区身份；权限相关操作再调用 **permission_status**。当一个工作区包含多个仓库时，Git 工具要传 workspace 相对的 repository_path，不能把工作区根目录误认为仓库。

## V1.4 常用工具

| 需求 | 工具 |
| --- | --- |
| 一次读多个文件 | batch_read；最多 16 个显式目标，有大小限制与分页 |
| 一次搜多个关键词 | batch_search；最多 8 组搜索，共享扫描预算 |
| 一次收集文件/Git/搜索/既有执行证据 | collect_evidence；不同证据分区各自校验 OAuth scope |
| 运行通用命令 | **execution_run**；支持 program/powershell/cmd |
| 查询单条命令 | execution_status / execution_job_output / execution_cancel |
| 执行固定多步计划 | task_create / task_status / task_list / task_result / task_output / task_cancel |

**通用命令优先 execution_run**。旧 execution_start 面向预注册、受限 package recipe；不要将它的审批前置条件套到 V1.4 execution_run 上。

execution_run 需要当前的 **Level2 Full Access + execution.run OAuth scope**；Level2 仅在当前 Windows 登录会话有效，重启后恢复到持久基线。它不需要 Level3 逐命令审批，但绝不是无限制远程 shell；仍受用户授权、权限和运行安全策略约束。

## 持久 Task 不会自己决策

Task 创建后步骤固定；执行器不会调用模型、增添步骤或自动改变计划。状态为 **WAITING_FOR_MODEL** 时停止继续执行，AI 应先看原 Task 的状态、checkpoint 和结果。中断时命令可能已经产生副作用，**绝不能仅因为没有看到成功消息就再跑一遍**。

## 排障

- 工具不可见：检查当前 ChatGPT 连接器与正式 Runtime，GitHub 源码更新不代表运行中的旧 Runtime 自动更新。
- 执行权限不足：区分 OAuth scope 与本机 permission mode，不要自动提升权限、启用 Level3 或改用其他工具绕过门禁。
- 连接中断：先用本机 status 观察，再按需要 restore；Named Tunnel 正常恢复通常不需要重配对。
- /health 或 Bridge 进程正常只说明局部存活；**实际调用 C2C 工具成功**才能确认完整连接。
- Windows 自启是当前用户登录触发，DNS 刚恢复时可能有延迟。

从已构建源码根目录执行（将示例工作区替换为真实路径）：

~~~powershell
node .\bin\c2c.js status -w 'C:\Projects' --json
node .\bin\c2c.js restore -w 'C:\Projects' --json
~~~
