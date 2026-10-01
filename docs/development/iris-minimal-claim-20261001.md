# 单句最小审核对照

2026-10-01，应用7ad82a87，文档基线449eeb54。不是新应用修复或部署。

Qwen3.8-Max单条完整条件句+两条来源，无其他候选、身份、历史或字段任务：
**1HTTP200/298tokens，首例FAIL**。原句“若联调发现问题或供应商侧延迟，将直接
导致无法按期交付，造成对客户的违约风险并损害信任。”被判supported，解释仍从
未验证接口跳到无法履约，没有核对严重度、耗时或缓冲。b/c未调用，不改原判定。
[11份证据](evidence/iris-minimal-claim-20261001-manifest.json)。

与9月26日三句同屏、完整mechanical slices、9月29日完整候选职责删除不同；
没有手工正确选项进入同次请求。独立复核确认FAIL。长上下文不是本例错批必需
条件，但不能据单次结果断言模型整体无能力。没有证明无提示迁移或产品能力。

## 下一精确模型因子对照

同一三例、逐条独立messages/schema/参数/oracle，唯一模型改为已授权qwen3.7-plus。
不改提示词；首错停、最多3HTTP/12000reportedtokens/10分钟，无重试，逐请求UI
精确免费额度>=150K、未过期、用完即停开启、观察<=60秒且绑定wire hash。
a必要失败insufficient；b必要成功insufficient；c合理可能影响supported。理由也须
忠实识别原句，不能仅碰中分类。预检零HTTP通过。历史3.7没有此相同单句输入。
即使通过也只支持进一步验证，不授权生产模型切换，也不能直接称审核修复。

## 11.2四处处置

| 位置 | 处置 |
| --- | --- |
| 白皮书 | **reviewed-unchanged**：[架构](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md)事实推断及审核标准不变，私有有界对照没有应用改动。 |
| 故障台账 | **updated**：[台账](../operations/engineering-failure-ledger.md)不得将此故障仅归因长上下文，保留原句错批。 |
| 覆盖基线 | **reviewed-unchanged**：[基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)此前候选失败、CORE-005部分覆盖仍准确，无新能力通过。 |
| README / AGENTS / handoff | **updated**：[交接](current-handoff.md)指向诊断；**reviewed-unchanged**：[README](../../README.md)未完整交付状态及[AGENTS](../../AGENTS.md)授权/定位/闭环不变。 |

未push、未访问生产、未切生产模型或启用群发、未飞书外发，原bug未关闭。
