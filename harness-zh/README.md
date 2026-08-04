# 企业级开发 Harness 中文模板

`harness-zh/` 是技术栈无关的可执行开发 Harness 中文发行版。Node.js 24 只用于运行 Harness CLI；被治理项目可以采用任意前端、后端、数据库、语言和构建工具。机器字段、Gate ID 和规则 ID 与英文发行版完全一致。

## 使用方式

1. 修改代码前，先阅读 `governance/document-hierarchy.md` 和项目画像。
2. 依据 `workflows/change-delivery.md` 分类需求与变更。
3. 执行项目画像或策略中标为 `approval-required` 的操作前，必须先获得明确审批。
4. 使用 `templates/` 记录需求、普通缺陷、项目进度、设计决策、风险、测试和发布证据；按 `governance/record-ownership.md` 分流记录。
5. 阅读 `policies/code-quality-baseline.md`、`rules/registry.yaml` 和 `contracts/quality-baseline.yaml`，确定适用规则、等级、阈值和证据。
6. 按质量门禁选择项目画像中的实际命令；记录实际命令输出，不以口头结论代替证据。

## 默认安全边界

- 默认仅允许本地只读检查、静态分析和无外部副作用的隔离测试。
- 外网调用、生产访问、凭证使用、破坏性操作、用户数据处理和第三方副作用必须获得明确审批。
- 禁止自动创建账号、规避身份识别、绕过安全控制、未授权抓取数据或规避第三方服务规则。
- 任何必需检查失败、跳过或不可用时，均视为门禁未通过，除非存在仍有效的书面例外审批。

## 启动

```powershell
npm ci
npm run harness -- validate --root harness-zh
npm run harness -- plan --root harness-zh --changed-file src/example.ts --operation merge --environment test --output .harness/plan.json
npm run harness -- run --root harness-zh --plan .harness/plan.json --output .harness/evidence
npm run harness -- evidence verify --root harness-zh --manifest .harness/evidence/manifest.json
```

项目命令使用结构化 `executable` 与 `args`，默认禁止隐式 Shell。`validate`、`plan`、`run` 和 `evidence verify` 在 TypeScript 核心中只实现一次，本地与 CI 共用相同行为。

运行时凭证必须通过 `inherited_environment` 指定；敏感变量还必须列入 `sensitive_environment`。敏感值不得写入 `environment` 或提交到项目画像，合同校验会拒绝这类配置。

GitHub 拉取请求需要在 `approvals.roles` 中配置获准的 GitHub 登录名。工作流通过 `approvals github` 将绑定当前提交的 `APPROVED` Review 转为结构化审批；后续 `CHANGES_REQUESTED` 或 `DISMISSED` 会撤销审批。审批记录同时绑定仓库、拉取请求、Review ID 和计划提交。条件 Gate 采用 fail-closed，必须提供对应的 `*-required` PR 标签。Evidence 验证的 `--root` 必须指向 canonical Harness 目录，而不是 Evidence 目录。

Git 绑定计划要求 base/head 差异非空、当前 `HEAD` 精确匹配、变更文件集合完全一致，并且项目命令运行前不存在 tracked、staged、untracked 或 ignored 文件。CLI 稳定退出码为：`0` 成功、`1` 内部错误、`2` 合同无效、`3` 规划或 Git 上下文失败、`4` 普通 Gate 失败、`5` Evidence 无效、`6` Gate 超时、`7` 执行取消。

`evidence verify` 只证明 Schema、摘要、canonical 计划、审批、例外和仓库上下文的一致性。SHA-256 摘要不是签名，不能独立证明命令确实执行。GitHub 使用可信 `prepare-context` Job、无凭证项目矩阵和可信 `harness-final` Job 重新计算结果，并使用 Ed25519 签署唯一最终结论。上下文绑定、密钥保管、验签、轮换和分支保护要求见 `governance/trusted-execution.md`。

## 目录说明

- `config/`：项目事实与已批准命令
- `contracts/`：可衡量的质量门禁
- `governance/`：权威层级与记录规则
- `policies/`：不可突破的安全与工程边界
- `rules/`：按模块注册的强制规则和技术栈适配层
- `enforcement/`：Hook、CI、扫描与覆盖率门禁的接入接口
- `skills/`：初始化、调试、评审、发布和事件响应工作流
- `workflows/`：可重复的交付与事件响应流程
- `templates/`：可审计记录模板
- `scripts/`：TypeScript CLI 的兼容包装器
- `tests/`：Harness 自身契约检查
