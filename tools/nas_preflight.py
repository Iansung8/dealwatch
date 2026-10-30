#!/usr/bin/env python3
"""將診斷模組經 SSH stdin 送入既有 Node.js 的記憶體，不在 NAS 建立檔案或容器。"""
import argparse
import base64
import json
from pathlib import Path
import re
import shlex
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
ALLOWED = {"doctor.mjs", "bestbuy.mjs", "walmart.mjs", "http.mjs"}


def bundle(name, cache):
    if name not in ALLOWED:
        raise ValueError(f"診斷套件含未核准模組：{name}")
    if name not in cache:
        source = (ROOT / "src" / name).read_text(encoding="utf-8")
        source = re.sub(r"from '(\./[^']+)'", lambda m: "from '" + bundle(m[1][2:], cache) + "'", source)
        cache[name] = "data:text/javascript;base64," + base64.b64encode(source.encode()).decode()
    return cache[name]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
    parser.add_argument("--user", required=True)
    parser.add_argument("--identity", type=Path)
    parser.add_argument("--node", default="/usr/local/bin/node")
    parser.add_argument("--live", action="store_true", help="每家店發出一次診斷查詢；預設離線")
    parser.add_argument("--store", choices=["bb", "wm"])
    parser.add_argument("--timeout-ms", type=int, default=12000)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.:-]*", args.host) or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]*", args.user):
        parser.error("主機與帳號格式不符")
    if not 100 <= args.timeout_ms <= 30000:
        parser.error("timeout-ms 必須在 100–30000 之間")
    options = ["--json", "--timeout-ms", str(args.timeout_ms)]
    if not args.live:
        options.append("--offline")
    if args.store:
        options += ["--store", args.store]
    module = bundle("doctor.mjs", {})
    source = f"const {{doctorCli}}=await import({json.dumps(module)});process.exitCode=await doctorCli({json.dumps(options)});"
    command = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8"]
    if args.identity:
        command += ["-o", "IdentitiesOnly=yes", "-i", str(args.identity.expanduser())]
    command += [f"{args.user}@{args.host}", f"{shlex.quote(args.node)} --input-type=module"]
    result = subprocess.run(command, input=source, text=True, encoding="utf-8", capture_output=True, timeout=90)
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    return result.returncode


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    try:
        sys.exit(main())
    except subprocess.TimeoutExpired:
        print("SSH 診斷超過 90 秒，已停止本機連線；請檢查 NAS。", file=sys.stderr)
        sys.exit(1)
