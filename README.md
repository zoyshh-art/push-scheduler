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

免费额度：每天 10 万次请求，本 Worker 每小时触发一次 = 24 次/天，远低于上限。

## 当前线上状态（2026-11-19 修复后）

- Worker 名称：`info-push-scheduler`
- 访问域名：`https://info-push-scheduler.zoyshh.workers.dev`
- Cron 触发器：`2 * * * *`（每小时一次，整点后 2 分钟）
- 密钥：`GH_TOKEN`（secret_text 类型）
- **所有 workflow 已移除 `schedule`，Worker 是唯一触发源**

Cloudflare 账号下另有早期脚本 `info-push`，是无关的旧脚本，勿动。

## 重新部署

已验证可用的方式（wrangler 在本机 `npx` 安装有问题，用 REST 脚本更稳）：

```bash
cd F:/ai/信息/push-scheduler
python deploy.py
```

脚本会上传 worker.js + cron + GH_TOKEN 密钥。最后一步"开启 workers.dev 子域名"
报 405 属正常（该 token 的鉴权方案不支持此子资源），子域名此前已开启，不影响使用。
`wrangler.toml` 也保留了同样的 cron 配置，供换机器时参考。

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

## 和 GitHub schedule 的关系（重要）

**workflow 里的 `schedule` 必须删掉，不能留作兜底。**

2026-11-19 排查发现两个真实故障：

1. GitHub 原生 `schedule` 延迟严重且不可预测：赚钱机会配置 12:00，实际 20:42 才跑；
   新闻出现在 03:40 / 12:46 / 20:51。这是"推送时间乱"的直接原因。
2. 旧 Worker 的 cron 是 `* * * * *`，配合 `minute <= 1` 判断，导致每个整点在
   :00 和 :01 各 dispatch 一次，两次运行都成功推送，同一内容收到两遍。
   两次推送之间状态尚未提交，下游去重也拦不住。

现在的处理：

- 五个 workflow 全部只保留 `workflow_dispatch`；
- Worker cron 改为每小时一次（`2 * * * *`），从结构上消除双触发；
- Worker 内部再加一层"本小时已 dispatch 则跳过"的幂等检查兜底。

代价：Worker 挂了就完全没有推送。Cloudflare 定时比 GitHub schedule 可靠得多，
且脚本极简，可接受。

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
