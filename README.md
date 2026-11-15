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

## 部署步骤

### 1. 创建 Worker

登录 https://dash.cloudflare.com ，左侧 `Workers & Pages` → `Create` → `Create Worker`，
随便起个名字（如 `info-push-scheduler`），点 `Deploy`，然后点 `Edit code`。

### 2. 粘贴代码

把本目录 `worker.js` 的全部内容替换掉编辑器里的默认代码，右上角 `Deploy`。

### 3. 添加密钥

回到 Worker 详情页 → `Settings` → `Variables and Secrets` → `Add`：

| 名称 | 值 | 类型 |
|---|---|---|
| `GH_TOKEN` | 你的 GitHub token（`ghp_` 开头） | **Secret**（选加密） |

必须选 Secret，否则 token 会以明文显示在面板上。

token 权限需要 `repo` + `workflow`（classic）或 `Contents: Read and write` + `Workflows: Read and write`（fine-grained）。

### 4. 添加定时触发器

Worker 详情页 → `Settings` → `Triggers` → `Cron Triggers` → `Add Cron Trigger`：

```
* * * * *
```

只需要这一个。Worker 每分钟醒来一次，在整分时按 UTC 时刻判断该触发哪个 workflow。
这样只占用 1 个 trigger 配额（免费版每个 Worker 最多 3 个），且时间判断集中在代码里，改时间只改代码不改配置。

### 5. 验证

浏览器访问 `https://<你的-worker-子域名>.workers.dev/?task=info-gap`，
返回 `{"label":"信息差","wf":"info-gap.yml","status":204,"ok":true}` 即成功。

访问根路径不带参数，会列出全部任务及其 UTC 时刻。

也可以在 Cloudflare 面板的 `Logs` 里看每次触发的记录。

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
