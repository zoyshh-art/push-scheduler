/**
 * info-push 准点触发器（Cloudflare Worker · Service Worker 语法）
 *
 * 为什么需要它：GitHub Actions 的 schedule 事件在整点高峰会被延迟甚至丢弃，
 * 实测 11-09 之后延迟已达 6–9 小时（赚钱机会 12:00 的配置 20:42 才跑）。
 * workflow_dispatch 走另一条队列，实测 0 秒启动，所以所有 workflow 已移除
 * schedule，只保留 workflow_dispatch，由本 Worker 作为唯一触发源。
 *
 * 幂等：Worker Cron 每小时只跑一次（整点后 2 分钟），但 Cloudflare 偶发重试或
 * 手动访问都可能造成同一小时多次调用。因此触发前先查 GitHub 该 workflow 在本
 * 小时内是否已有 workflow_dispatch 运行记录，有则跳过。
 *
 * Secret GH_TOKEN 由 Cloudflare 作为全局变量注入。
 */

const OWNER = 'zoyshh-art';

// utc 小时列表：命中的整点触发；everyHour 为 true 则每小时触发
const SCHEDULE = [
  { label: '新闻速览', repo: 'info-push',      wf: 'news.yml',        utc: [0, 12] },
  { label: '赚钱机会', repo: 'info-push',      wf: 'money-radar.yml', utc: [4] },
  { label: '信息差',   repo: 'info-push',      wf: 'info-gap.yml',    utc: [7] },
  { label: 'AI 额度',  repo: 'info-push-deal', wf: 'ai-watch.yml',    utc: [11] },
  { label: '手机好价', repo: 'info-push-deal', wf: 'deal-watch.yml',  everyHour: true },
];

function headers() {
  return {
    Authorization: `token ${GH_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'info-push-scheduler',
    'Content-Type': 'application/json',
  };
}

// 本小时内是否已经 dispatch 过同一个 workflow。
// API 异常时返回 false（宁可多触发一次，也不要漏推；下游还有内容级去重兜底）。
async function alreadyDispatched(task, since) {
  const url = `https://api.github.com/repos/${OWNER}/${task.repo}/actions/workflows/${task.wf}/runs?event=workflow_dispatch&per_page=10`;
  try {
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) {
      console.log(JSON.stringify({ warn: 'idempotency-check-failed', wf: task.wf, status: res.status }));
      return false;
    }
    const data = await res.json();
    return (data.workflow_runs || []).some(r => new Date(r.created_at) >= since);
  } catch (e) {
    console.log(JSON.stringify({ warn: 'idempotency-check-error', wf: task.wf, err: String(e) }));
    return false;
  }
}

async function trigger(task) {
  const url = `https://api.github.com/repos/${OWNER}/${task.repo}/actions/workflows/${task.wf}/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ ref: 'main' }),
  });
  return { label: task.label, wf: task.wf, status: res.status, ok: res.status === 204 };
}

addEventListener('scheduled', function (event) {
  event.waitUntil((async function () {
    const now = new Date();
    // Cron 配置为每小时只跑一次（整点后 2 分钟），所以不需要按分钟过滤；
    // 即使 Cloudflare 延迟执行，也只会有一次调用，不会漏掉也不会重复。
    const hour = now.getUTCHours();
    const since = new Date(now);
    since.setUTCMinutes(0, 0, 0);

    for (const task of SCHEDULE) {
      if (!(task.everyHour || task.utc.includes(hour))) continue;
      if (await alreadyDispatched(task, since)) {
        console.log(JSON.stringify({ skipped: 'already-dispatched', wf: task.wf, utc: now.toISOString() }));
        continue;
      }
      const r = await trigger(task);
      console.log(JSON.stringify({ ...r, utc: now.toISOString() }));
    }
  })());
});

// 浏览器访问 /?task=info-gap 可手动测试（绕过幂等），不传参数则列出全部任务
addEventListener('fetch', function (event) {
  event.respondWith((async function () {
    const want = new URL(event.request.url).searchParams.get('task');
    if (!want) {
      return new Response(JSON.stringify(SCHEDULE, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const task = SCHEDULE.find(t => t.wf.startsWith(want));
    if (!task) return new Response(`未知任务：${want}`, { status: 400 });
    const r = await trigger(task);
    return new Response(JSON.stringify(r, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  })());
});
