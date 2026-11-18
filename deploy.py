#!/usr/bin/env python3
"""
Cloudflare Worker 一键部署脚本

作用：把 push-scheduler/worker.js 部署成 Cloudflare Worker，
      写入 GH_TOKEN 密钥，配置每分钟 Cron，开启 workers.dev 子域名，最后验证。

前置：需要 Cloudflare API Token（Edit Cloudflare Workers 模板）。
用法：
    echo "你的CF_TOKEN" > F:/ai/信息/.cf_token
    python deploy.py

每一步都会打印 HTTP 状态和结果，失败即停。
"""
import json
import pathlib
import sys
import urllib.request
import urllib.error

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
CF_TOKEN = (ROOT / ".cf_token").read_text().strip()
GH_TOKEN = (ROOT / ".gh_token").read_text().strip()
WORKER = "info-push-scheduler"
BASE = "https://api.cloudflare.com/client/v4"
H = {
    "Authorization": f"Bearer {CF_TOKEN}",
    "Accept": "application/json",
}


def call(method, path, *, body=None, raw=None, content_type=None):
    url = BASE + path
    headers = dict(H)
    data = None
    if raw is not None:
        data = raw
        headers["Content-Type"] = content_type
    elif body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def ok(step, status, result):
    success = status < 300 and result.get("success", True)
    print(f"[{'OK' if success else 'FAIL'}] {step}  HTTP {status}", end="")
    if not success:
        errs = result.get("errors") or [{"message": result}]
        print("  ", errs[:1])
        sys.exit(1)
    print()
    return result.get("result")


def main():
    # 1. 拿 account_id
    _, d = call("GET", "/accounts")
    accounts = d.get("result") or []
    if not accounts:
        print("[FAIL] 账号列表为空，检查 CF Token 权限"); sys.exit(1)
    account_id = accounts[0]["id"]
    print(f"账号: {accounts[0]['name']}  id={account_id}")

    # 2. 上传 Worker 脚本（multipart，指定 main module = worker.js）
    js = (HERE / "worker.js").read_bytes()
    boundary = "----cfdeploy7d3f9a"
    parts = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="worker.js"; filename="worker.js"\r\n'
        "Content-Type: application/javascript\r\n\r\n"
    ).encode() + js + f"\r\n--{boundary}--\r\n".encode()
    ok("上传 worker.js",
       *call("PUT", f"/accounts/{account_id}/workers/scripts/{WORKER}",
             raw=parts, content_type=f"multipart/form-data; boundary={boundary}"))

    # 3. 写加密密钥 GH_TOKEN
    ok("写入 GH_TOKEN 密钥",
       *call("PUT", f"/accounts/{account_id}/workers/scripts/{WORKER}/secrets",
             body={"name": "GH_TOKEN", "text": GH_TOKEN}))

    # 4. 配置 Cron 触发器（每分钟）
    ok("配置 Cron * * * * *",
       *call("PUT", f"/accounts/{account_id}/workers/scripts/{WORKER}/triggers/cron",
             body={"crons": ["* * * * *"]}))

    # 5. 开启 workers.dev 子域名
    ok("开启 workers.dev 子域名",
       *call("PUT", f"/accounts/{account_id}/workers/scripts/{WORKER}/subdomain",
             body={"enabled": True}))

    # 6. 查子域名并验证
    sub = call("GET", f"/accounts/{account_id}/workers/scripts/{WORKER}/subdomain")[1]
    subdomain = (sub.get("result") or {}).get("name", WORKER)
    url = f"https://{subdomain}.workers.dev/?task=info-gap"
    print(f"\n验证地址: {url}")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "deploy-check"})
        with urllib.request.urlopen(req, timeout=40) as r:
            print("验证返回:", r.read().decode()[:300])
    except Exception as e:
        print("验证请求失败（部署可能仍需几秒生效）:", type(e).__name__, e)


if __name__ == "__main__":
    main()
