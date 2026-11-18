/**
 * info-push 准点触发器（Cloudflare Worker）
 *
 * 为什么需要它：GitHub Actions 的 schedule 事件在整点高峰会被延迟甚至丢弃，
 * 实测 11-09 之后两个仓库的定时任务延迟已达 6–9 小时。而 workflow_dispatch
 * 走的是另一条队列，实测 0 秒启动。
 *
 * 本 Worker 每分钟醒来一次，在整分时按 UTC 时刻调用 GitHub 的 dispatch 接口，
 * 准点触发对应的 workflow。全部运行在 Cloudflare 边缘节点，与本地电脑无关。
 *
 * 部署要点见同目录 README.md。
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

async function trigger(env, task) {
  const url = `https://api.github.com/repos/${OWNER}/${task.repo}/actions/workflows/${task.wf}/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `token ${env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'info-push-scheduler',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main' }),
  });
  return { label: task.label, wf: task.wf, status: res.status, ok: res.status === 204 };
}

export default {
  async scheduled(event, env, ctx) {
    const now = new Date();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    // Cloudflare Cron 实际执行可能延迟 1 分钟，放宽到 0/1 分都算整点，避免漏触发。
    // 重复 dispatch 由下游各频道的去重逻辑吸收，不会造成重复推送。
    if (minute > 1) return;

    for (const task of SCHEDULE) {
      if (task.everyHour || task.utc.includes(hour)) {
        const r = await trigger(env, task);
        console.log(JSON.stringify({ ...r, utc: now.toISOString() }));
      }
    }
  },

  // 浏览器访问 /?task=info-gap 可手动测试，不传参数则列出全部任务
  async fetch(request, env) {
    const want = new URL(request.url).searchParams.get('task');
    if (!want) {
      return new Response(JSON.stringify(SCHEDULE, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const task = SCHEDULE.find(t => t.wf.startsWith(want));
    if (!task) return new Response(`未知任务：${want}`, { status: 400 });
    const r = await trigger(env, task);
    return new Response(JSON.stringify(r, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
