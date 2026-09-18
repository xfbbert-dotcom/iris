# 主动讨论：生成链路对照与免费候选续测

日期：2026-09-18。用户要求直接继续解决生成问题；沿用只做免费测试的费用边界。
实现树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支 `codex/iris-daily-pilot-followup`，
开工干净 `fd8c507fe1517f5098aed5adbd1034d0528f55f1`，应用仍为 `d699761e`。
默认checkout仍为干净的 `e4cd964a`，未切换或合并。本文是诊断记录，不是应用修复或上线批准。

## 1. 单变量：让原生格式合同对模型可见

本机使用的 [llama.cpp b11011 格式说明](https://github.com/ggml-org/llama.cpp/blob/b11011/grammars/README.md)
明确区分解码格式约束与模型可见提示。当前client仅在显式 `json_object` 模式下附完整schema；
本次假设为：保持原生 `response_format` 不变，仅把同一完整schema附到system，可能改善修正。
不能由文档差异直接断言它是全部语义失败的原因。

原有[连续性错误稿对照](iris-review-continuity-20260917.md#本地真实模型对照)作为保留基线；
相同Qwen3-4B-Q4_K_M、runtime、CPU/上下文/采样、seed1709、原错误pair及首次review。
初始assessment/draft/review重放，只有pair repair和最终review各一次新请求；
每请求180秒、总420秒/2请求上限，没有重试或修正循环，没有使用原文重建变体。

06:15:59–06:18:49 UTC实际2次HTTP200，仍返回旧106字符稿、遗漏6万元，
materialChange.explanation仍“预算不足导致招聘计划不可行”。最终模型raw supported=true，
列出的6万元引句仍只有10/16，应用既有引文检查拒绝，finalPair=null。
结论：显式schema不足以修好目标，不推广、不跑正向变体、不继续提示变体抽样。
也不能因最终null将其算成生成通过。三种旧对照相同schema已能在106/139字符正常结束，
没有证据表明maxLength=1200本身强制重复；上轮重建仍含旧review.adviceQuote，亦非完全独立原文生成。
[完整报告](evidence/iris-schema-visible-20260918-negative.json)与[封装](evidence/iris-schema-visible-20260918-harness.txt)
均原样归档。SHA256分别为 `ef50abc42feb7e8db7a122b7a395d9f49461538888558d6a92d70be4ed3e0a4a`、
`143a34a3c6b4b7dee1eee73326748143cbf05fbbd6894becf8022385a7376a32`。

## 2. 较晚免费云端窗口：一次容量拒绝后停止

重新核对[官方定价](https://docs.bigmodel.cn/cn/guide/start/pricing)、
[平台价格](https://bigmodel.cn/pricing)与[模型说明](https://docs.bigmodel.cn/cn/guide/models/free/glm-4.7-flash)：
GLM-4.7-Flash输入/输出仍标免费，不使用FlashX、付费搜索、付费回退或充值。
两价格页面对缓存存储分别显示“限时免费”/“免费”，本次没有请求专用缓存存储。
这不是账户账单审计，也不保证服务可用。

仍使用已保存的本机DPAPI加密测试密钥，仅向官方端点发送合成8+8格式问题。
既有client显式 `json_object`（完整schema入system）、thinking disabled、max_tokens256、
60秒/1请求，无真实群聊、企业文档或生产配置外传。
06:20:00.999–06:20:01.225 UTC返回HTTP429，“该模型当前访问量过大，请您稍后再试”。
本窗口持久化停止标记；未跑算术、完整集或另一云端模型，未重试。
[原始脱敏报告](evidence/iris-glm47-json-mode-20260918-format.json)及[有界封装](evidence/iris-glm47-json-mode-20260918-harness.txt)
SHA256分别为 `a414a78e3a468bc0751e3c3d97266a58b219342ed5b2c8fecfaf97a1da2e249c`、
`5386121a2a7680c2ad03671151790b453ae665e66f7e6fc26d79743a52e46dcb`。

[官方错误码](https://docs.bigmodel.cn/cn/faq/api-code)区分容量、账户速率和带重置时间的额度错误。
本报告只有实际HTTP状态及脱敏消息，未保留业务码，不倒推出具体业务码或“明天额度重置”。
[结构化输出文档](https://docs.bigmodel.cn/cn/guide/capabilities/struct-output)所示JSON模式与客户端校验
不能用这次没有输出的拒绝来判定兼容性或推理质量。

## 3. 新离线候选：两种格式均未通过，未采用

选择同等4B参数规模的 [Qwen3-4B-Instruct-2507](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507)，
官方说明为非thinking指令版；下载 [bartowski的GGUF量化](https://huggingface.co/bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF)。
它是第三方量化，不冒充Qwen官方GGUF发布。固定revision `ae44f08e1392f39c0e474af10c3ff8355c8b6688`，
文件 `Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf`，2497280736字节，发布LFS SHA256
`2fde00ce69dd4899c70d020845e2638353015bba0fdf161b3eb965f2bca4464e`；下载后长度和完整哈希一致才加载。
只下载权重，复用已有CPU运行器，不安装服务、运行下载脚本或上传用户资料。

阶段出口：格式单例 → 原始arithmetic完整链及独立语义验收 → 通过才运行原15例两轮。
不提供人工assessment、不注入synthetic expectedCriteria、不采用失败的schema可见私有变体。
原产品提示、schema及校验均不变；模型换代与量化发布来源不同，不声称是严格单变量因果证明。
临时CPU单请求上限180秒，不冒充原生产时延验收；无自动重试和任何付费API。
脚本独立只读核对未发现接线或请求范围阻塞。保留原有一次assessment合同修正，
“无自动重试”指传输层，不是删除应用既有修正。未启动完整集，也未提供绕过单例语义门禁的参数。

### 实际结果

| 路径 | 时间（UTC）/真实请求 | 结果与验收层级 |
|---|---|---|
| 原生格式最小例 | 06:34:13–06:34:14 / 1次HTTP200 | result=16、label正确；仅格式通过。 |
| 原生格式原始算术例 | 06:34:24–06:34:44 / 1次HTTP200 | 预算10万元、两人每人8万元，返回合法skip/no_work_value。实际语义漏报；draft=null，未进入render/review。 |
| 显式JSON模式最小例 | 06:36:20–06:36:22 / 1次HTTP200 | result=16、label正确；仅格式通过。 |
| 显式JSON模式原始算术例 | 06:36:36–06:37:24 / 2次HTTP200 | 两次都返回缺issueRef和顶层evidenceRefs的skip/insufficient_basis；既有一次合同修正后仍assessment_failed，diagnostic=assessment_validation。assessment/draft均null，不计为合法沉默或语义通过。 |

原生失败后只对同一用例使用应用已有的显式JSON兼容模式；该模式由既有client将schema附入system，
没有私有提示补丁。它同时改变解码模式和schema可见性，不能宣称严格单变量因果证明。
报告completions保留client调用前的messages/responseFormat，实际fetch边界另行检查出站
response_format分别为json_schema/json_object；不把调用前记录冒充完整HTTP出站报文。
两个模式的原单例均失败，所以不跑15例两轮、不继续改seed抽样、未把模型或配置接入应用。
这些结果排除了“本次候选换上即可解决”的主张，但不证明模型是唯一根因，也不证明所有免费模型都不可用。

原样归档如下，均与本地原件SHA256核对一致。原报告manualReview=pending保留不改；
上表是后续代理语义判读，不代表人工签字，不伪造运行器当时已经完成语义审阅。

| 证据 | SHA256 |
|---|---|
| [原生最小格式](evidence/iris-instruct-20260918-format.json) | `8d4f583693e712be07061545d6db18d02659643ddade7e90b5b83a08b5653c73` |
| [原生算术](evidence/iris-instruct-20260918-arithmetic.json) | `634c86cb0fff8ba968eb8558849fae78d43b7528e27101f5df8d1b49abe1d67b` |
| [JSON最小格式](evidence/iris-instruct-20260918-json-format.json) | `d51c81fd4f12df8508b8faa6b0e2daea642bb7e98b36477f6657350351692bc0` |
| [JSON算术](evidence/iris-instruct-20260918-json-arithmetic.json) | `2fd909158affb48c6a17585b9ec30cd2cf260376c1cf931c8ce2d2c5071dfa6c` |
| [原生封装](evidence/iris-instruct-20260918-native-harness.txt) | `648f6014c95bde1e3b6aa33e2234cdfb7e8e342dda9cc5c16f779e6121e2e5ad` |
| [JSON封装](evidence/iris-instruct-20260918-json-harness.txt) | `9bdb8aa61725d9b1198c20a732285cf833fe5973e566365e7f8025c7ec7aa98d` |
| [校验及启动器](evidence/iris-instruct-20260918-launcher.txt) | `13593def956f10463a702bb8e5b851dba6a805e68821b3ebc8110292238f4586` |

### 资源与后续边界

本轮合计7次本地真实请求和1次免费云端请求，不包含此前日期的对照。
本地旧模型先停再加载新模型；新服务经精确路径/模型参数核对后停止PID35136，
2026-09-18 14:42:14+08:00复核18089监听与llama-server进程均0。
下载产生的6个临时分片共2931899104字节已删除，可重新下载；经校验的完整权重保留在
`C:/Users/59912/AppData/Local/Iris/local-eval-20260918/`供复现，不进Git、不涉及用户文件。

已知应用修复仍为`d699761e`；本次没有新应用修复提交，也未重跑此前4734项Core回归，
不把旧回归数字写成本次新证据。当前确认的剩余问题仍是实际生成/判断/修正质量，归因未完整。
不能要求用户再重做群聊验收，也不能承诺“明天额度重置即可修好”。
此候选到此退出；后续须有新的可验证集成假设或免费服务恢复的独立可用性线索，
再按格式→原单例语义→原完整集的同一门槛继续，不重放已失败配置直到偶然通过。

### 交接验证

14:45:39+08:00重新执行既有4个聚焦文件：连续性15、pair-review16、receipts34、trace16，
合计81项通过；这是原程序的确定性回归，不是本次实际生成通过。源码与报告sourceHashes一致。
README、交接入口和本记录共97个本地链接目标存在，本记录6个本地锚点有效。
本次归档按字节核对原件哈希，并只为这三组新证据设置Git `-text`，避免Windows换行转换破坏复现哈希。
一次独立只读代理复核确认结果/调用计数/来源身份，指出“人工判定”措辞不当，现已改为代理判读；
未发现新增阻塞或密钥、真实业务内容泄露。复核不代表人类批准、模型语义通过或线上验收。

## 4. 四处文档处置

| 核对项 | disposition与理由 |
|---|---|
| 白皮书 | **reviewed-unchanged**：[第6节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)的来源、一次修正、显式格式和分级验收仍适用；本轮未改产品合同。 |
| 工程故障台账 | **reviewed-unchanged**：[主动协作条目](../operations/engineering-failure-ledger.md#proactive-collaboration-is-not-a-deadline-reminder)已要求有界同条件对照、保留失败及不将格式/拦截当语义通过；本轮没有新的已证实应用根因。 |
| 需求覆盖基线 | **reviewed-unchanged**：[IRIS-CORE-005](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2-核心需求追踪)仍部分实现，不把候选测试或容量拒绝写成已交付。 |
| README / AGENTS / 当前交接 | **updated**：[README](../../README.md#current-product-state)与[当前交接](current-handoff.md#当前正在推进)链接本轮实际结果，区分9月18日先前只归档与本次新调用。**reviewed-unchanged**：[AGENTS](../../AGENTS.md)的工作树定位、四处闭环与有限退出规则仍有效，无需重复改写。 |

没有push、部署、开能力或飞书发送；无需用户重新创建密钥、购买模型或操作审批。
