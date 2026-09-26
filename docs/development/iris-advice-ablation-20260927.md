# 主动讨论：移除无条件授权建议

日期2026-09-27（Asia/Shanghai），工作树`D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，
分支`codex/iris-daily-pilot-followup`。起点29a4f4d5，候选应用1f00cc0e。
无push、生产访问、部署、能力启用或飞书外发。

## 证据、假设与有界路径

上一轮[算术修复记录](iris-executable-arithmetic-20260926.md)保留了具体失败：
inference初判建议付费测试，重新生成后却说没有审批制度才需要转化证据。
发送前审核只检查建议没有冒充已存在制度，六项全true，未识别建议的逻辑缺口。

`git log -S`与d9200703的diff确认，生成提示在9月15日为数值场景加入了无条件
“建议核对授权”。它不是授权来源，不应替所有问题预定建议动作。本次只删除该指令
及逗号，保留“不假定已有审批制度”、允许合理核实权限的条款及全部其他提示、
上下文、schema、算术检查和一次修正路径。审核未修改；不引入审批关键词黑名单。
指令存在及删除是确定事实；它对上一轮退化的因果贡献仍需验证，不能认定唯一根因。

原失败为真实模型RED。82项现有相关测试通过，typecheck/build exit0；未新增只断言
字符串删除的自证测试，也不把模拟响应通过当语义修复。独立审查认可该有界干扰
假设和正反例，未发现阻塞项。

冻结上轮inference的初判assessment，调用当前真实render；零网络preflight逐项
核对消息及schema，确认同一生成请求除删除该无条件指令之外完全相同。首例不是
新鲜初判。随后预定原目录inference、separate-next、qualified-risk、paraphrase
各一轮，沿用原语义预期，每例独立审核后才进入下一例，首个失败即停，不重采或
追加提示变体。首例通过只说明这一回返回可用意见，不证明确定因果或稳定能力。

窗口仅现有合成key、精确qwen3.8-max，non-thinking/max_tokens2048；每请求60秒，
总窗口20分钟，硬上限22请求、下次发起前80000 reported tokens停止。每次实际HTTP
前刷新精确免费quota行、验证用完即停和到期时间，绑定待发wire hash，凭据60秒内
且余额至少100K；无自动重试、其他模型或付费回退。任何额外格式修正也占请求上限。
原私有启动器使用已有DPAPI凭据，未创建或输出密钥。

## 结果：局部改善，完整链路失败

**7次HTTP200 / 28440 reported usage tokens**。冻结输入render两次HTTP返回pair；
全新inference的判断、生成、初审、唯一修正、终审五次HTTP后返回null。运行器以
`pair rejected or incomplete`停止，无重试，separate-next、qualified-risk、paraphrase
三项未调用，不声明这些反例已通过。首例不算全新端到端判断。

| 场景 | 独立判断与实际返回 |
|---|---|
| frozen-inference | **有限通过**。指出5人喜欢不能证明全量付费，无条件停止100%预测，并核实历史转化数据、在可靠依据前保留不确定性。原预期不要求一定新做实验。“经审批标准或历史数据”的并列仍含糊，但全文没有再以有审批免除补证据，不能仅凭出现审批二字判失败。主代理与独立审查一致；仅一轮，不证明确定因果或稳定性。 |
| inference | **端到端失败**。生成建议核实更大样本或历史转化记录，不再引入审批前提；初审六项true，却把未知收入总额、差额、增量填为expectedValue=0、unit=不适用。本地字面凭据正确拒绝。唯一修正向draft添加三处“不适用”，终审仍以0元为必要数值并拒绝，render=null。不是建议语义失败，也不是目标错误被成功审核后完成修复。 |

本次直接观察到的第二个故障是**不存在的数字核验义务被审核创建并延续到终审**。
模型已说数据未知，仍用0作占位；终审没有撤回错误项目。程序拒绝缺失的凭据符合
当前契约，不能删除检查或把null算介入成功。无条件授权建议确为不当通用指令，
删除可保留；但本次未证明整个生成/审核问题解决，前后随机性和其他提示影响未分离。

冻结对照只改该指令，没有修改原语义预期、来源或schema。全新初判仍含过度确定
措辞，重新生成时改为可能风险；说明存续pair与初判不能混为同一验收对象。数字
模板造成的冗长、字面转义换行及“不适用”污染记录在此，不另开无限润色循环。

免费页启动前951.14K/1M，最后2026-09-26T16:20:59.036Z读数938.4K/1M，12月18日
到期，用完即停始终开启。页面存在更新滞后，差值不当作28440tokens账单审计。
[报告](evidence/iris-advice-ablation-20260927.json)、
[20份脱敏证据清单](evidence/iris-advice-ablation-20260927-manifest.json)、
[运行器](evidence/iris-advice-ablation-20260927.txt)、
[启动器](evidence/iris-run-advice-ablation.txt)保留实际请求/响应/配额绑定/停止记录。
原私有文件未改，7次wire/response哈希归档前核对；脱敏副本有独立字节hash。
独立复核另将首例实际wire与旧wire作深比较，确认除删句之外完全相同；逐响应
重算usage与停止记录一致，并确认删除可保留但不关闭相关语义缺陷。

## 验收层级与后续限制

- **代码已改**：1f00cc0e只删除不当的无条件建议指令，审核与权限边界未改。
- **本地检查通过**：Core四文件82项、typecheck/build exit0。本轮未重跑全Core，
  60a8c2ac的4811/469及CLI7仍是历史结果，不挪到当前提交名下。
- **实模窗口失败**：冻结输入一例有限通过，全新案例不能返回意见；三项未调用。
- **真实飞书未验收，未部署**：无push、生产访问、开关变更或外发，生产SHA未核验。

不再追加同一候选提示变体或重采。下一项应先解决数值职责的适用性：来源不能计算
的数值不得成为必须补齐的0值，而已知预算等必要结果仍须核算并保留。当前只有问题
定位，没有已证明有效的新方案；不能未经验证把“来源没写结果”都过滤掉（会误删
合法计算），也不能恢复旧assessment为事实模板。风险确定性和历史重复仍是独立
未关闭缺口。本轮不是额度、HTTP或等待用户许可阻塞，完整主动讨论能力没有完成。

## 四处文档处置

| 核对项 | disposition及依据 |
|---|---|
| 白皮书 | **reviewed-unchanged**：[第6节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)已有以授权事实支撑有价值意见、单次修正和语义边界要求；删除错误通用指令未改变架构、授权或产品目标，尚无可提升为架构规则的实模方案。 |
| 工程故障台账 | **updated**：[主动讨论条目](../operations/engineering-failure-ledger.md#proactive-collaboration-is-not-a-deadline-reminder)记录从特定场景扩散的通用建议指令及不存在的数值义务，区分局部清理与链路失败。 |
| 核心需求覆盖基线 | **updated**：[本轮补记](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2026-09-27-移除通用授权建议)记1f00cc0e、82本地检查、7HTTP窗口失败与三项未调用；IRIS-CORE-005仍部分实现。 |
| README / AGENTS / 当前交接 | **updated**：[README](../../README.md#current-product-state)与[交接](current-handoff.md#当前正在推进)指向本轮和实际失败；**reviewed-unchanged**：[AGENTS](../../AGENTS.md)定位、禁止扩权和闭环要求仍有效。 |

本记录归档一次有限代码清理及失败，不关闭能力缺陷，不是部署记录。
