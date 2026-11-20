#!/usr/bin/env python3
"""Regenerate probe-stream.jsonl from the stream-json probe logs.

The probe (docs/changes/2026-11-13-dual-mode/evidence/probe-stream-json.md)
drove real claude 2.1.210 and logged every stdout line under
.devflow-tmp/probe/logs/<scenario>.ndjson as {"_dir":"in","msg":{...}}.
This keeps the first sample of every message kind (plus a few extra variants
the client parser must handle), strips personal paths and shortens long
lists. TestFakeClaudeMatchesProbe compares the fake claude against it.

    python3 testdata/gen-probe-stream.py <repo>/.devflow-tmp/probe/logs > testdata/probe-stream.jsonl
"""
import json
import os
import sys

SCENARIOS = ["v2", "v3", "v4a", "v6a", "v6b", "v7", "v9", "v11", "v12", "v12b", "v14", "v18b", "v21"]
# Kinds that get every distinct text variant, not just the first sample.
ALL_VARIANTS = {"user/str", "user/text", "user/tool_result+error"}
LIST_CAP = 3
STR_CAP = 400
PATHS = [
    ("/Users/mac/github/vibe-remote/.devflow-tmp/probe/", "/home/user/project/"),
    ("-Users-mac-github-vibe-remote--devflow-tmp-probe-", "-home-user-project-"),
    ("/Users/mac/", "/home/user/"),
]


def kind(m):
    """Must match messageKind in fakeclaude_test.go."""
    t = m.get("type")
    if t == "system":
        st = m.get("subtype")
        k = "system/" + str(st)
        if st == "status":
            if m.get("status"):
                k += ":" + m["status"]
            for f in ("permissionMode", "compact_result"):
                if f in m:
                    k += "+" + f
        return k
    if t == "stream_event":
        e = m["event"]
        k = "stream_event/" + e["type"]
        if e["type"] == "content_block_delta":
            k += "/" + e["delta"]["type"]
        if e["type"] == "content_block_start":
            k += "/" + e["content_block"]["type"]
        return k
    if t == "assistant":
        return "assistant/" + ",".join(b["type"] for b in m["message"]["content"])
    if t == "user":
        c = m["message"]["content"]
        if isinstance(c, str):
            return "user/str"
        k = "user/" + ",".join(b["type"] for b in c)
        if any(isinstance(b, dict) and b.get("is_error") for b in c):
            k += "+error"
        return k
    if t == "result":
        return "result/%s/%s" % (m.get("subtype"), m.get("terminal_reason", ""))
    if t == "control_request":
        r = m["request"]
        k = "control_request/" + r["subtype"]
        if r["subtype"] == "can_use_tool":
            k += "/" + r["tool_name"]
        return k
    if t == "control_response":
        r = m["response"].get("response") or {}
        if "commands" in r:
            return "control_response/initialize"
        if "still_queued" in r:
            return "control_response/interrupt"
        if "mode" in r:
            return "control_response/set_permission_mode"
        return "control_response/other"
    return str(t)


def scrub(v):
    if isinstance(v, dict):
        return {k: scrub(x) for k, x in v.items()}
    if isinstance(v, list):
        return [scrub(x) for x in v[:LIST_CAP]]
    if isinstance(v, str):
        for old, new in PATHS:
            v = v.replace(old, new)
        if len(v) > STR_CAP:
            v = v[:STR_CAP] + "…"
    return v


def main(logdir):
    seen = {}
    out = []
    for name in SCENARIOS:
        with open(os.path.join(logdir, name + ".ndjson")) as f:
            for line in f:
                rec = json.loads(line)
                m = rec.get("msg")
                if rec.get("_dir") != "in" or not isinstance(m, dict):
                    continue
                k = kind(m)
                if k in seen:
                    if k not in ALL_VARIANTS:
                        continue
                    text = json.dumps(m["message"]["content"])[:80]
                    if text in seen[k]:
                        continue
                    seen[k].add(text)
                else:
                    seen[k] = {json.dumps(m.get("message", {}).get("content", ""))[:80]}
                out.append(scrub(m))
    for m in out:
        sys.stdout.write(json.dumps(m, ensure_ascii=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main(sys.argv[1])
