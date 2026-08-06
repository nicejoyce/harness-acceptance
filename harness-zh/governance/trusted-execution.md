# 可信执行

本文档是 GitHub CI 信任模型的权威来源。本地 `evidence verify` 可以发现制品不一致，但只有受保护的 GitHub 工作流能够生成带签名的最终结论。

## 审核者身份

两个受信 Job 都会重新查询 GitHub，并在把 Review 转换为审批或规则签署前生成绑定提交的身份快照。审核者只有同时满足以下条件才有效：GitHub 返回 `user.type === User`，账号具有当前有效的组织成员资格或仓库 collaborator 权限，配置角色授权该登录名，并且该登录名不是 PR 作者。API 结果缺失、资格撤销、上下文漂移、Bot/App Review 和未知账号一律 fail closed。

Bot 和 App Review 只会单独保留为带正文哈希的 `AgentAttestationRecord` 审计事实，永远不能满足人类审批或 human-attested 规则。本控制只证明 GitHub API 返回的当前账号类型和归属状态，不宣称 proof-of-personhood。

## Job 边界

1. `prepare-context` 是可信 Job。它从受保护的 base SHA 运行 Harness 代码和合同，读取当前 GitHub Review，生成不可变 Plan，并在不执行项目命令的前提下打包 PR 源码。
2. `harness` 是不可信项目执行 Job。矩阵 Job 使用 `permissions: {}`，不接收 `GH_TOKEN` 或 OIDC 凭证，重建干净 checkout，并将 Evidence 输出到项目仓库外。
3. `harness-final` 是可信 Job。它重新获取当前 Review，依据 canonical base 合同和 GitHub Job 结论验证所有 Evidence，重新计算结果，完成签名和外部信任锚验签，并发布唯一稳定的 `harness-final` Check。

不可信 Evidence Manifest 只能作为输入，不能成为最终信任结论。缺失、跳过、取消、格式错误、上下文不匹配或失败的输入一律 fail-closed。

## 不可变上下文

GitHub 绑定的 Plan、Run、Evidence verify 和 Final aggregate 必须使用完全相同的 `repository`、`pull_request`、`base_sha` 和 `head_sha`。声明的 head 必须等于 checkout 的 `HEAD`，base/head 差异和变更文件集合必须完全一致；任一不匹配都会使运行无效。

执行从干净 checkout 开始。项目命令运行前，Harness 会拒绝 tracked、staged、untracked 和 ignored 文件。依赖准备由项目画像声明的 `gate.setup` 执行；生成的依赖只能出现在洁净检查之后。Evidence 必须写到项目 checkout 外。

## Ed25519 信任锚

最终 Job 从 Actions Secret `HARNESS_ED25519_PRIVATE_KEY_B64` 读取当前 PKCS8 DER Base64 私钥。私钥不得提交、写入 Artifact、打印或暴露给项目 Job。

受信 SPKI DER Base64 公钥通过仓库 Variable `HARNESS_ED25519_PUBLIC_KEYS_JSON` 提供。该 JSON 对象将小写 SHA-256 `key_id` 映射到公钥。`final verify` 根据签名信封的 `key_id` 选择外部公钥，拒绝未知 ID 和非 Ed25519 密钥，并且绝不信任签名制品自行携带的密钥材料。`HARNESS_ED25519_PUBLIC_KEY_B64` 作为单公钥兼容入口保留一个迁移周期。

密钥轮换顺序固定为：先将新公钥加入 keyring，再替换私钥 Secret，确认新运行使用新的 `key_id`，等待在途运行结束，最后移除旧公钥。怀疑密钥泄露时，应移除对应公钥、轮换私钥、重新运行受影响 PR，并创建事件记录。

使用独立获取的受信公钥配置验证下载的签名结果：

```powershell
$env:HARNESS_ED25519_PUBLIC_KEYS_JSON = '<受信 key_id 到公钥的 JSON>'
npm run harness -- final verify --input final.signed.json --json
```

## 仓库强制控制

保护默认分支，要求两名独立的非作者 CODEOWNER 审批，新提交后撤销过期审批，要求会话已解决且分支为最新，禁止强制推送和删除，并禁止绕过。只将 `harness-final` 配置为 Harness 必需 Check；矩阵 Check 仅用于诊断。

可信结论依赖 base 工作流、CODEOWNERS、合同、仓库权限、签名 Secret、公钥 keyring 和分支规则持续受到保护，PR 作者不能修改这些控制。

## 平台 Shadow 与事实记录

受保护 base Plan 同时记录预测平台集合和执行平台集合。Shadow Mode 故意执行完整矩阵，并生成由签名 Final 派生的 `platform-sample.json`；只有预测和全量结果共享同一 commit SHA 与 Plan 摘要时，样本才有效。`platform-metrics` 将非 flaky 漏检与 flaky 失败分开统计，至少 30 个有效样本且漏检率为零后，才允许在 enforce 模式省略平台。

交付记录必须先完成 Evidence 和 Final 签名验证，renderer 不读取日志，也不推断动机。服务边界从受保护 base 加载合同，按租户授权仓库，隐藏测试只能使用无网络/无凭证调用，并且不开放任意 shell 或 MCP 信任权限。
