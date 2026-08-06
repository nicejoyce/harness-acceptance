# 机械化执行接口

文档规则必须逐步映射到可执行控制。推荐顺序：本地格式化/静态检查 → pre-commit → CI 质量门禁 → 分支保护 → 发布审批。

最小映射：

| 规则域 | 推荐控制 |
|---|---|
| SEC/DATA/BOUND | 秘密扫描、SAST、依赖扫描、API 负向测试 |
| ARCH | 复杂度/大小检查、架构测试、ADR 审查 |
| TEST | 覆盖率阈值、测试报告、E2E 制品 |
| DEP | 锁定安装、SBOM、许可证与容器扫描 |
| OPS/DOC/AI | PR 模板、发布清单、审批、分支保护、审计日志 |

示例配置只定义接口，实际工具、命令和 CI 平台由项目画像绑定。

P0 的真实执行入口是 `.github/workflows/harness.yml`。仓库管理员只应将 `harness-final` 配置为 Harness 必需 Check，并要求两名独立的非作者 CODEOWNER Review。`prepare-context` 从受保护 base 生成 canonical Plan 和审批；无凭证的 `harness` 矩阵 Job 执行项目命令并输出不可信 Evidence；`harness-final` 重新获取当前 Review、验证所有上下文绑定 Evidence、重算结果、使用 Ed25519 签名并发布稳定 Check。

本地 SHA-256 验证只能发现不一致或被修改的制品，不是执行签名。应使用 `final verify` 和独立获取的 `HARNESS_ED25519_PUBLIC_KEYS_JSON` 验证 `final.signed.json`。只有 base 工作流、分支保护、CODEOWNERS、签名密钥、公钥配置和仓库权限持续受保护时，信任结论才成立。详见 `../governance/trusted-execution.md`。
