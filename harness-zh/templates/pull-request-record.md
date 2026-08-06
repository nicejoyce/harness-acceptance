# 变更评审记录：<标题>

## 人工责任字段

目标：<需要达成的结果>
设计动机：<选择该方案的原因>
风险判断：<责任人的判断>
业务理由：<业务层面的原因>
回滚决策：<何时以及如何回滚>

## Harness 签名事实

不得手工编辑通过/失败状态、哈希、平台、门禁、阈值、工具版本或审批引用。使用以下命令生成本节：

`harness records render --manifest <manifest> --final <signed-final> --format markdown`

<!-- harness-signed-facts:start -->
<生成的签名事实>
<!-- harness-signed-facts:end -->

## 支持记录

风险记录：<路径>
设计记录：<路径>
发布或回滚记录：<路径>
