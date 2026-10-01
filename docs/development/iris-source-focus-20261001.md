# 原文定位新问题的可执行边界

2026-10-01，基线4e0c10c1。用户要求单个候选失败后继续处理整体缺陷，不把每轮
实验停止当作工作终点。[此前canonical候选](iris-canonical-opinion-20261001.md)仍失败。

## 观察、改动与冻结窗口

此前“严重样本偏差”先出现在assess的新问题description，再进入生成和审核。
projectIdentityTarget保留该自由文本，身份仅供定位的提示没有阻止结论传递。
传播路径已确认，但尚未证明因果。此次改变可执行数据合同，不追加反例审核：
sourceBoundIdentity默认false，仅配合canonicalOpinion；assess的新description
只能选schema中的来源句子，程序要求它确实属于已选择evidence。下游只接收
sourceFocus{sourceRef,sourceQuote}作为新问题定位，不传初判描述或分析正文。
引文不等于事实认可；scope仍检查是否同一主题、候选是否受支持。既有ID、真实
历史、权限、数字历史、初终审及唯一修正不变。原文句长上限2000，不能绑定时
不回退到自由诊断。默认runtime和正式eval未启用。

7项新增回归，旧代码4失败/1通过；新增修正/拒绝回退后定向7通过。主动讨论
356通过/121条件跳过，typecheck及build通过；未将此前全Core结果搬到本提交。
独立复核通过，主题/推断正确性仍由语义验收决定。

一次冻结窗口：全新inference→qualified-risk→arithmetic→material-update→
paraphrase→handled。沿用上一轮六例语义标准：未知代表性不能写成已证实严重
偏差；未验证接口不能保证失败；16/6及24/+8/14完整；已提醒或人已处理时沉默。
没有旧assessment/generation/review注入。最多24HTTP/100000reported tokens下次
发起前停/30分钟/单次60秒；逐例独立语义gate，首失败停止该候选，不重采同配置。
精确qwen3.8-max non-thinking/max_tokens2048，逐HTTP UI核对免费额度≥150K、
到期未过、用完即停开启、观察≤60秒并绑定请求hash；无付费回退。

结果待本轮实际验证填写。停止一个假设不意味着关闭原bug或结束已授权整体工作。
