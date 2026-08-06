# 技术栈适配规则

在本目录为语言、框架、数据库、云平台或客户端创建适配规则。每份适配规则必须声明：适用路径、项目画像依赖、实际检查命令、工具版本、例外审批人和与通用规则的映射。

适配规则只能增加约束或将抽象基线映射为具体工具，绝不能降低 `policies/code-quality-baseline.md`、`contracts/quality-baseline.yaml` 或 `rules/registry.yaml` 的要求。
