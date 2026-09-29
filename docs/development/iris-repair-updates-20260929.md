# 主动讨论：修正只替换明确选中的正文

2026-09-29，应用`a2b3c449e65b50f38ae199abf2e5b5288f3d2951`，起点`d911d271`，此前应用`3e7636b8`；工作树和分支见
[交接](current-handoff.md)。只做已授权本地工作和免费合成验证，无部署或外发。

## 故障、选择与边界

[上轮失败原件](evidence/iris-bound-prose-20260929.json)显示：初审明确否定reasoning
中的无依据0/1接口算术，其余五字段为true；唯一修正却必须重写七个正文段，导致
新问题描述null、业务变化说明变成内部编辑记录。应用正确拒绝，没有终审。
不能据此断言模型能力不足或提示长度是根因；确定的是协议强制重写未受影响字段。

本次不补null、不删校验，也不再次增加全量改稿要求。将唯一修正改为严格
`{updates:[{field,value}]}`：模型显式选择需替换的完整字段，程序以**本次生成pair**
为基底，保留未指定的正文，再校验完整pair并执行原终审。生成仍是完整prose。
可选字段为issueDescription、observation、reasoning、suggestion、uncertainty、
changeExplanation、draftText；已有问题的描述不可改，身份/引用一直由程序持有。
重复字段、额外字段、null、空值、超长文本、未知字段拒绝。空updates允许表达
诊断无须改稿，但仍须终审；不自动视为通过，不增加请求或第二次修正。

没有按初审true永久冻结字段：审核也可能漏判，修正可显式改善关联字段，但最终
仍核对全体存续内容。未修改不等于受支持；错误初审、错误改稿及身份/重复语义
仍是模型职责，不能以字段合并证明修复整个能力。changeExplanation如果明确修改，
仍须描述业务问题/新依据，不能写编辑过程；本次不以关键词程序判语义。
trace保留实际updates及程序组合结果，不能混成完整模型原稿或旧初判回填。

## 本地与有限实模退出条件

归档对象回归先7项中2失败，实施后7通过，覆盖未改字段来自新生成稿、真正进入
终审和终审仍可拒绝；结合trace/正文契约36项通过。全量Core **4853通过 / 469条件
跳过**，typecheck/build、CLI7通过。独立五文件80项通过，无阻断；强调必填七字段
尚未证明是唯一原因，实际改错和遗漏仍需实模验证。没有真实PG/Redis或CI结果。
零HTTP preflight确认冻结生成及初审保持原件，不代替实模成功。

先冻结上轮完整生成和初审，真实调用本次唯一修正及终审；冻结输入不提供人工
正确答案，不删旧错误或更改初审。通过后依次全新qualified-risk、paraphrase、
arithmetic、inference、material-update各一轮；必须指出工作问题、提出独立有效
建议、限定未知后果，数字16/6与24/+8完整、未知不编0、语义重复skip。首次执行
或独立语义失败停止，不重采、不改预期。最多24HTTP、75000 reported tokens、
25分钟，每请求60秒；精确qwen3.8-max免费额度逐请求核对≥100K、期限及用完即停，
无付费回退。冻结通过不证明新鲜生成稳定；任何一例失败，不标完整验收。

## 实际结果：定点修正通过，前置审核仍错批新鲜风险稿

本窗口 **5次HTTP200 / 16794 reported tokens** 后首败停止，无重采或追加变体。
程序确实注入原件生成和原件初审各一次；未提供人工正确的改稿选项。

- frozen-risk：2次真实HTTP（修正3173、终审4776 tokens）。模型只更新reasoning，
  去掉伪0/1接口数量；本次生成的问题描述、业务风险说明和draft未被重写。真实
  终审返回完整pair，主代理与独立语义审查均有限通过。风险以可能/无法保证限定，
  建议核实联调和限定承诺；不是新鲜生成或稳定性证明。
- qualified-risk：3次HTTP（判断/生成/初审），执行失败。新生成reasoning将未联调
  扩成0进度、100%依赖项及全部工作量缺口，并写“一旦……将直接导致无法按期履约”；
  draft也包含进度0及全部工作量。来源未支持这些数量及必然后果。
- 初审reasoning=true、整体true，理由把上述数量当合理算术、把条件句当恰当限定。
  其requiredNumbers第一项unit=""导致本地schema失败，抛scope review was invalid；
  第二项100%的凭据也不是草稿中的逐字数值。**不是语义错误被成功识别**。
  本例没有进入updates修正或终审，不能把失败归为字段合并失败。
- paraphrase、arithmetic、inference、material-update均未调用。原语义标准不变，
  不把冻结例通过或格式拒绝提升为本窗口完整验收。

独立审查确认5个raw content与客户端一致及上述两层失败。
[执行审计](evidence/iris-repair-updates-20260929.audit.json)核对wire/response hash、
usage和逐请求quota新鲜度；[18份证据清单](evidence/iris-repair-updates-20260929-manifest.json)
保留实际请求、响应、脚本、语义判断、quota及停止记录。结束页面861.73K/1M、
用完即停开启、2026-12-18到期；页面滞后不作账单对账。

**层级：代码已改／本地通过／冻结修正实模有限通过但新鲜窗口失败／真实飞书未验收／未部署。**
当前有界修正路径已完成验证并保留失败出口，不继续扩大字段恢复或放宽数字契约。
剩余实质问题是生成与前置审核对数量适用性、风险强度及凭据的忠实核对；本次没有
因果分离提示复杂度、任务分工与模型能力，也没有证明新的审核修复方向。后续应
以这份完整新鲜失败原件设计独立可否证的审核职责方案，不重采本配置或追加同类
prompt变体。没有等待用户许可、额度刷新或生产条件的阻塞；整体能力缺陷仍开放。

## 四处文档处置

| 核对项 | disposition |
|---|---|
| 白皮书 | **updated**：[第6节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)补充唯一修正采用明确字段更新、以当前生成稿为基底且仍完整终审。 |
| 工程故障台账 | **updated**：[职责条目](../operations/engineering-failure-ledger.md#2026-09-29-do-not-ask-generation-to-recopy-locked-references)记录强制全量改稿导致无关字段退步，链接本次证据及限制。 |
| 需求覆盖基线 | **updated**：[本轮条目](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2026-09-29-program-bound-proactive-prose)记录修正契约；IRIS-CORE-005仍部分实现，不提升成生产或飞书通过。 |
| README / AGENTS / current-handoff | **updated**：[交接](current-handoff.md)与[README](../../README.md#current-product-state)定位本应用、本地检查及实模首败；**reviewed-unchanged**：[AGENTS](../../AGENTS.md)现有授权、定位和闭环规则适用。 |

此前所有失败窗口保留；文档提交不是部署。整体缺陷未关闭。
