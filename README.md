# 准点触发器

用 Cloudflare Worker 代替 GitHub Actions 自带的 schedule，解决推送时间漂移。

## 为什么需要

GitHub Actions 的 `schedule` 事件在整点负载高峰会延迟，负载过高时排队的 job 会被直接丢弃。
实测这两个仓库：

| 频道 | 约定 | 11-03 ~ 11-08 实际 | 11-09 之后实际 |
|---|---|---|---|
| 信息差 | 12:30 | 13:13–13:23（+45 分） | 19:38–21:07（+7 ~ 8.6 小时） |
| 赚钱机会 | 09:00 | 09:48–09:57（+50 分） | 15:16–15:57（+6.3 ~ 7 小时） |
| 新闻早报 | 08:00 | — | 11:27–12:56（+3.5 ~ 4.9 小时） |
| 新闻晚报 | 20:00 | — | 次日 01:24–03:14（+5.4 ~ 7.2 小时） |
| 手机好价 | 每小时 | 每小时一次 | 每天仅 3–5 次（大量被丢） |

对照实验：手动调 `workflow_dispatch`，`created_at 13:07:40` → `run_started_at 13:07:41`，**延迟 0 秒**。

所以改用外部定时器准点调 dispatch 接口。

## 运行位置

全部在 Cloudflare 边缘节点，**跟本机无关**，电脑关机、断网都不影响。配置完成后无需再管。

免费额度：每天 10 万次请求，本 Worker 每分钟触发一次 = 1440 次/天，远低于上限；单次 CPU 时间也远低于 10ms 限制。

## 当前线上状态（2026-11-18 已部署）

- Worker 名称：`info-push-scheduler`
- 访问域名：`https://info-push-scheduler.zoyshh.workers.dev`
- Cron 触发器：`* * * * *`（1 个，wrangler 部署时由 wrangler.toml 写入）
- 密钥：`GH_TOKEN`（secret_text 类型）
- 部署方式：wrangler CLI（见下）

Cloudflare 账号下另有早期脚本 `info-push`，是无关的旧脚本，勿动。

## 重新部署（推荐：wrangler 一键）

本机已有 Node 22 和 wrangler（通过 `npm exec` 临时拉取）。在本目录执行：

```bash
export CLOUDFLARE_API_TOKEN=$(cat ../.cf_token)
export CLOUDFLARE_ACCOUNT_ID=4a2df9b7f3c5c0fa1a8f29de6d7f4fd4
export WRANGLER_SEND_METRICS=false
npm exec --yes --package=wrangler -- wrangler deploy
```

`wrangler.toml` 里已写好 cron 和 main，脚本、cron、workers.dev 子域名一次搞定。
部署前确认 `GH_TOKEN` 密钥还在（deploy 不会覆盖密钥）。

### 为什么不用纯 REST API 部署

试过用 Cloudflare REST API 一步步建，发现 API token 鉴权方案下：
- `PUT /workers/scripts/{name}/triggers/cron` 返回 415，`PUT .../subdomain` 返回 405
- 所有子资源 GET 都被路由到脚本源码本身

改用 wrangler 后正常。`deploy.py` 保留了 REST 部署尝试（cron 通过上传时的 metadata 携带），
但实际部署以 wrangler 为准。

### 密钥获取

Cloudflare `API Tokens` → `Create Token` → **Edit Cloudflare Workers** 模板 →
**不要点开任何 policy**（Zone policy 会因没绑域名报红，无需管）→ 直接 `Continue to summary` → `Create Token`。

`GH_TOKEN` 用的是 GitHub classic token，权限需 `repo` + `workflow`。

## 验证

浏览器访问 `https://info-push-scheduler.zoyshh.workers.dev/?task=info-gap`，
返回 `{"label":"信息差","wf":"info-gap.yml","status":204,"ok":true}` 即链路通。
不带参数访问会列出全部任务及 UTC 时刻。

注意：本机沙箱网络访问不了 workers.dev（502），需在正常网络环境验证；
或等整点后查 GitHub `workflow_dispatch` 运行记录是否有新条目（见下方时间对照）。

也可以在 Cloudflare 面板 `Workers & Pages → info-push-scheduler → Logs` 看触发记录。

## 时间对照

Worker 内按 UTC 判断，对应北京时间：

| workflow | UTC 小时 | 北京时间 |
|---|---|---|
| `news.yml` | 0, 12 | 08:00 / 20:00 |
| `money-radar.yml` | 4 | 12:00 |
| `info-gap.yml` | 7 | 15:00 |
| `ai-watch.yml` | 11 | 19:00 |
| `deal-watch.yml` | 每小时 | 每小时整点 |

改时间只改 `worker.js` 里的 `SCHEDULE` 数组，然后重新 Deploy。

## 和原有 schedule 的关系

**workflow 里的 `schedule` 建议保留不动**，作为兜底。

重复触发不会导致重复推送，因为各脚本都有去重：

- `info-push` 三个频道：按条目 uid（链接哈希）永久去重，同一内容推过就不再推
- `ai_deal.py`：按「厂商 + 日期」去重
- `phone_deal.py`：同一机型同一价格档 24 小时内不重复，±1% 近价合并

所以即使 GitHub 的 schedule 延迟到几小时后才跑，Worker 已经推过的内容它也不会再推一遍。
反过来 Worker 出问题时，schedule 还能兜底。

代价是 Actions 运行次数翻倍，但两个仓库一个是公开仓库（不计费），另一个用量远低于免费额度。

## 备选方案：cron-job.org

不想用 Cloudflare 的话，可以用 [cron-job.org](https://cron-job.org)（免费，网页配置，不用写代码）。

建 4 个任务，每个填：

```
URL      https://api.github.com/repos/zoyshh-art/{仓库}/actions/workflows/{文件}/dispatches
Method   POST
Headers  Authorization: token <你的 token>
         Accept: application/vnd.github+json
         Content-Type: application/json
Body     {"ref":"main"}
Schedule 时区选 Asia/Shanghai，按上表设时间
```

缺点：token 会以明文形式保存在第三方服务器上。Cloudflare 方案可以把 token 存成加密 Secret，更安全。
