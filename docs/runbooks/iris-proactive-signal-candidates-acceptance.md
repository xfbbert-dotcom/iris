# Iris 主动信号候选灰度验收

> 适用范围：Phase 4A，只生成和审查候选，不主动向飞书发送消息。
> 架构依据：`2026-06-30-iris-architecture-whitepaper.md`
> 设计依据：`2026-07-18-iris-proactive-signal-candidates-design.md`

## 1. 验收前置条件

只有以下条件全部成立，才允许打开候选扫描：

1. PR #8 的 semantic thread/action 真实飞书灰度已经通过，候选提交及 Core/AI Worker 镜像 SHA 一致，CI checks 为 success。
2. 本变更已经经过独立评审并部署了数据库 migration；Phase 4B 尚未部署，系统不存在主动发送接口。
3. `globalEnabled=false`、所有非试点群禁用、`proactiveSpeech=false`、Caddy stopped；event/document/reindex/memory 队列及 DLQ 均为 0。
4. `.env` 中保持：

```dotenv
IRIS_PROACTIVE_CANDIDATE_SCANNING_ENABLED=false
IRIS_PROACTIVE_CANDIDATE_GROUP_IDS=
```

空白群白名单表示不扫描任何群，绝不表示扫描全部群。

## 2. 禁用态部署核对

先在禁用态执行 migration、重建 Core，然后通过仅限 VPS 回环地址的内部接口核对：

```powershell
$headers = @{ Authorization = "Bearer $env:IRIS_INTERNAL_API_TOKEN" }
Invoke-RestMethod -Headers $headers -Uri http://127.0.0.1:3000/internal/status
```

预期 `proactiveSignals` 明确显示 disabled/unavailable，Core/Postgres/Redis/AI Worker healthy，所有队列和 DLQ 为 0。此时不得启动 Caddy，不得启用 Iris，也不得发送飞书消息。

## 3. 单群候选灰度

选择唯一试点群 `$pilotGroupId`，确认其他已知群仍禁用。Phase 4A 没有任何发送路径，因此本窗口可以只开放生成候选所需的运行时门禁：

1. 将 `.env` 设置为：

```dotenv
IRIS_PROACTIVE_CANDIDATE_SCANNING_ENABLED=true
IRIS_PROACTIVE_CANDIDATE_GROUP_IDS=<pilot-group-id>
```

2. 保持 Caddy stopped；重建 Core。
3. 只为试点群启用 `globalEnabled`、群运行时和 `proactiveSpeech` capability。所有非试点群继续禁用。
4. 查询状态：

```powershell
Invoke-RestMethod -Headers $headers -Uri http://127.0.0.1:3000/internal/proactive/status
```

预期：`enabled=true`、`running=true`、`allowlistedGroupCount=1`、`idleReason=null`，且 `policyVersion=phase4a-v1`。

5. 仅触发一次有界扫描：

```powershell
Invoke-RestMethod -Method Post -Headers $headers -Uri http://127.0.0.1:3000/internal/proactive/scans
```

6. 等扫描结束后读取试点群候选：

```powershell
$uri = "http://127.0.0.1:3000/internal/proactive/candidates?groupId=$pilotGroupId&status=pending&limit=50"
$candidates = Invoke-RestMethod -Headers $headers -Uri $uri
$candidates
```

## 4. 候选质量门禁

逐条对照真实群聊证据，必须全部满足：

- 只出现试点群，控制群候选数为 0；
- 只引用 current、retrieval-visible、`open` 的 thread/action；
- 已完成、已解决、已合并、候选态或已失效实体不出现；
- 有 open action 的 thread 不再生成重复 thread 提醒；
- overdue action 优先于 quiet action；
- 同一 source version 和 policy version 重扫不重复；
- explanation 不包含群聊正文、标题、负责人姓名或其他内容数据；
- 评分及 `scoreFactors` 可由固定策略复算；
- 扫描前后所有异步队列和 DLQ 仍为 0；
- 飞书群内没有新增 Iris 主动消息。

抽样中的任何一条误报、安全边界失败或跨群数据都判定本轮失败，不得进入 Phase 4B。

## 5. 驳回与幂等验收

选一条待处理候选，使用响应里的当前 `version` 驳回：

```powershell
$body = @{
  groupId = $pilotGroupId
  expectedVersion = $candidate.version
  dismissedBy = "pilot-operator"
  dismissalReason = "acceptance-sample"
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Headers $headers -ContentType application/json `
  -Body $body -Uri "http://127.0.0.1:3000/internal/proactive/candidates/$($candidate.id)/dismiss"
```

预期首次成功；重复使用旧 `version` 返回 409。再次扫描不得为相同 source version 和 policy version 重建已驳回候选。

## 6. 通过与回滚

Phase 4A 通过条件：所有质量门禁通过，扫描记录完整，候选可审查/驳回，无跨群数据、无模型调用、无飞书发送。

验收结束后立即恢复：

```dotenv
IRIS_PROACTIVE_CANDIDATE_SCANNING_ENABLED=false
IRIS_PROACTIVE_CANDIDATE_GROUP_IDS=
```

并将 `proactiveSpeech=false`、所有群和全局运行时恢复到验收前状态，重建 Core，再次核对队列/DLQ 为 0。候选表和 append-only events 保留为审计证据，不做手工删除。

Phase 4B 必须另行设计和验收群内主动建议、频率限制、发送审计、暂停/恢复与反馈闭环；Phase 4A 通过不代表 Iris 已经具备主动发言能力。
