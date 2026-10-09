# Iris aff258f7 发布与联合验收执行记录

2026-10-09。承接[本地候选与方案](iris-qa-free-pilot-20261009.md)，用户在具体范围可审阅后
明确“确认”：允许推送及免费CI、仅更新生产Core并保持关闭，再在成员在场时对原群进行
一次最多15分钟、QA与PD合计8次模型HTTP的联合验收。允许临时切换普通QA到与PD共用的
qwen3.8-max受监督门禁、使用既有受保护凭据；每请求重新核免费额度与用完即停，无付费回退。
成员在场与发送通知是执行协调，不再重复询问同一授权。

实现树`D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支
`codex/iris-daily-pilot-followup`。进入时干净HEAD147d14fc，应用aff258f7；默认工作树未改变。
下列阶段分别记账，发布和模拟检查不关闭真实意见质量及追问体验缺口。

## 精确免费CI

普通快进推送4eeadd9f→147d14fc，无force。推送新增34个文件经过代码、配置示例、合成
证据及凭据模式检查，无确认泄露；不声称可以自动识别任意自然语言隐私。现查仓库PUBLIC、
标准ubuntu-latest、无制品上传或larger runner，现有cache46,494,627字节。
[GitHub计费说明](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
明确公开仓库标准runner免费；没有修改付费设置或购买额度。

[CI 37914079405](https://github.com/xfbbert-dotcom/iris/actions/runs/37914079405)仅dispatch一次，
精确来源147d14fcb94d1a345343c05665dc3329225356bb；应用仍为
aff258f7fa0a1560cdbe51d305bf97bb88c5a0b5。Core与AI Worker两job首次全部通过：

- Core5165通过、471条件跳过，类型检查及生产构建通过。
- 完整pilot230通过。这次CI包含最终token-await修复，补上本地旧pilot运行时点限制。
- 单独PostgreSQL阶段23个文件530项通过；各阶段计数不去重相加，不把一般套件全部跳过项
  写成已补测。主动讨论历史回放、QA路径仍为模型和飞书替身。
- AI Worker181通过；Compose、就绪、数据库角色、成对备份恢复及Redis故障拒绝/恢复通过。

[免费条件](evidence/iris-qa-ci-20261009-preflight.json)、[运行元数据](evidence/iris-qa-ci-20261009-run.json)、
[摘要及原日志hash](evidence/iris-qa-ci-20261009-summary.json)保留精确证据。
本次CI未调用业务模型、未向真实飞书发送消息。

## 生产发布准备

[预检](evidence/iris-release-aff258f7-20261009-preflight.json)重新确认现场为c7a286f3/19cce镜像、
健康，global/desired/reply/proactive关闭，revision3427、就绪21/21。
[准备](evidence/iris-release-aff258f7-20261009-prepared.json)核对镜像ID
`sha256:9be24803b0a63b12b29dd2fe158f0c7e3506b803ba013b25db7335fc24866f6c`，
完整revision、Config、RootFS均与本机制品相同。镜像包84,103,680字节、SHA256
`148e6eafaadb0349b1ab924373c44605265126008f35c63b562542affdce24db`，已上传，无生产重建。

[发布脚本](evidence/iris-release-aff258f7-20261009-ops.py)只允许Core三个新增QA配置为空值，
以及Core/migrate/embedding-model-verify的镜像别名变化；一次性helper不执行。
现场Compose只插入这三行，其余原字节及Caddy保留。切换Git前仅暂时去除已快照的Compose
覆盖，随后安装候选；回退恢复原覆盖、env及markers，不恢复数据库。无迁移/worker/lock变更。
25项本地helper检查包含临时Git切换与中断回退；不据此宣称Windows验证了Linux文件锁。

[新成对备份](evidence/iris-release-aff258f7-20261009-backup.json)于10:06:41 UTC完成，
旧Core恢复健康、入口保持关闭。[单连接机外传输](evidence/iris-release-aff258f7-20261009-transfer-verified.json)
240.7秒、零重试，759,491,816字节整包hash匹配；10:11:36 UTC
[既有身份解密/断网PG与RDB检查](evidence/iris-release-aff258f7-20261009-backup-verified.json)通过，
派生明文精确清理。检查备份结构不等于新的恢复演练，生产未restore。
本地备份目录ACL仅当前用户及SYSTEM；服务器stage0700并加入精确本地Git排除，密钥不打印
或归档到仓库，既有age身份不离开本机。

10:12:20 UTC[切换](evidence/iris-release-aff258f7-20261009-cutover.json)、10:12:29
[验收](evidence/iris-release-aff258f7-20261009-acceptance.json)完成，精确aff258f7/9be248镜像
健康；新Core只增加三个空env参数，其余配置保留。53项迁移、权限和业务记录与基线一致。
10:12:50[独立读回](evidence/iris-release-aff258f7-20261009-independent.json)19项全部通过，
就绪21/21、非Core五容器未替换、全局/desired/QA/主动发言/PD策略关闭、无未决回执。
[本机公网检查](evidence/iris-release-aff258f7-20261009-public.json)health200/internal404，
未绕过TLS，入口已恢复。关闭态发布至此通过，无新的应用修复或业务模型请求。

## 联合窗口准备与证据边界

[ops](evidence/iris-qa-pd-window-20261009-ops.py)、[控制](evidence/iris-qa-pd-window-20261009-control.mjs)、
[预检](evidence/iris-qa-pd-window-20261009-preflight.py)和[门禁wrapper](evidence/iris-qa-pd-window-20261009-gate.mjs)
基于旧窗口作有界适配：显式pd-and-qa、两客户端共同参数/预算、QA原群白名单、关闭十个
旁路开关、打开QA和关闭时明确reply-off。新基线允许历史非零业务记录，不删除/重放旧错误意见。
watchdog先于global-on建立；许可异常也触发关闭，恢复本轮基线。语法、配置、wrapper和
14个本地许可文件案例通过，两名独立只读审查未发现阻断；尚不代替现场装配及真实使用。

[私有采集脚本](evidence/iris-qa-pd-window-20261009-capture.mjs)仅从该群及本窗口关联记录
取证，飞书操作限认证与数据库绑定的精确消息GET。业务正文只写私有文件，不入公共仓库。
QA来源采集目前仅含文档trace，消息存在/父消息检查不是QA全文指纹及全部来源核验；
直接fallback/clarification可能无持久QA回执，须结合事件及实际飞书观察。

10:13:18[窗口预检](evidence/iris-qa-pd-window-20261009-preflight.json)固定aff，原群策略v10关闭，
QA89条历史回执及PD3个job/1条旧sent意见完整保留，QA未决/待提示/不确定均0。
[现场准备](evidence/iris-qa-pd-window-20261009-prepared.json)已临时应用联合配置，逐键核对
实际Core环境；全局/desired/reply关闭、policy仍关闭。实际容器内的合成接线通过，
providerHTTP/Feishu均0，不把它算真实业务验收。尚未启动真实门禁，等待成员在场确认。

页面准备检查显示qwen3.8-max剩466.32K/1M、2026-12-18到期、用完即停开启；这不是调用
许可或账单审计，实际每次pending之后仍需新鲜观察。窗口尚未启动，不要求成员提前发消息。

## 开窗被执行策略拒绝，配置已恢复

成员随后明确“现在方便，等你通知”。执行启动命令时，`exec_command`在CreateProcess前
被自动审批拒绝，工具仅返回`blocked by policy`，没有更具体原因；远端start没有派发。
[拦截记录](evidence/iris-qa-pd-window-20261009-policy-blocked.json)保留用户授权和在场均已
具备的事实。这是执行策略阻断，不是模型错误、额度不足或缺少用户确认；没有改工具或
换等价命令重试启动，也没有让用户向未开启的群窗口发消息。

随后执行较安全的stop恢复：10:16:48 UTC[恢复读回](evidence/iris-qa-pd-window-20261009-restored.json)
确认真实gate不存在、started/watchdog标记不存在，全局/desired/reply/主动发言及policy
关闭；实际Core环境完全等于窗口前基线，env/Compose原字节恢复，非Core不变。
PD及QA计数和既有回执不变，未决/待安全提示/不确定均0，未重放。模型HTTP0、飞书发送0。
10:17:54 UTC[最终独立核验](evidence/iris-release-aff258f7-20261009-final-independent.json)
再次19项通过，精确aff镜像健康、就绪21/21、数据库基线保持。

本轮出口：**代码已部署，免费CI及关闭态生产验收通过；联合真实窗口未执行。**
新的实模语义、真实意见和@追问仍未验，产品缺陷未关闭。下一缺失条件是允许执行这项
已获用户授权的开窗动作的工具策略；不要求用户重复授权/登录，不把本次拒绝当作语义失败
或一次模型试验。后续继续时需读回现场和确认成员在场，不复用本次已恢复的stage直接start。

## 白皮书11.2四处处置

| 位置 | 处置 |
| --- | --- |
| 白皮书 | **reviewed-unchanged**：[第8节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#8-admin-console-and-runtime-control)已准确表达QA部署范围及发送边界；本轮发布与试点执行不新增架构能力。 |
| 工程故障台账 | **updated**：[台账](../operations/engineering-failure-ledger.md)保留自动审批阻止开窗与恢复证据，明确不是模型/额度/授权缺失，不清除旧应用失败。 |
| 核心需求覆盖基线 | **updated**：[基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)记录aff关闭部署、开窗未执行及已恢复；IRIS-CORE-005仍部分实现。 |
| README / AGENTS / current-handoff | **updated**：[README](../../README.md#current-product-state)、[交接](current-handoff.md)记录精确生产版本及真实验收被执行策略阻断；**reviewed-unchanged**：[AGENTS](../../AGENTS.md)的工作树、授权与闭环规则仍有效。 |
