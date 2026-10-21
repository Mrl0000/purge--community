// 开关变更留痕 + 注入段位 setter：一次操作只留一条 tuning_setting。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readAudit } from "../lib/audit.js";
import { readTuning, writeTuning } from "../lib/tuning.js";

const cli = path.join(import.meta.dirname, "..", "bin", "community.js");

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "purge-tuning-"));
  try {
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function run(home, ...args) {
  const env = { ...process.env, DSH_HOME: home };
  const out = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
  let json = null;
  try {
    json = JSON.parse(out.stdout);
  } catch {
    json = null;
  }
  return { status: out.status, json, stdout: out.stdout, stderr: out.stderr };
}

test("每一处真正变化的键写一条 tuning_setting，值没变就不写", () => {
  withHome((home) => {
    writeTuning({ boost: false, injectPosition: "tail" }, home);
    let rows = readAudit({ limit: 20, home }).filter((r) => r.event === "tuning_setting");
    assert.deepEqual(
      rows.map((r) => [r.key, r.from, r.to]).sort(),
      [
        ["boost", true, false],
        ["injectPosition", "head", "tail"],
      ],
    );

    // 同值再写一次：不该产生新行
    writeTuning({ boost: false }, home);
    rows = readAudit({ limit: 20, home }).filter((r) => r.event === "tuning_setting");
    assert.equal(rows.length, 2);
  });
});

test("purge-community inject 能设置段位，并明确需要重载插件", () => {
  withHome((home) => {
    const result = run(home, "inject", "tail");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.injectPosition, "tail");
    assert.equal(result.json.restart_required, true);
    assert.equal(result.json.effective, "next-load");
    assert.equal(readTuning(home).injectPosition, "tail");

    const rows = readAudit({ limit: 20, home }).filter((r) => r.event === "tuning_setting");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key, "injectPosition");
    assert.equal(rows[0].to, "tail");
  });
});

test("inject 只接受 head / tail / both，状态查询不改值", () => {
  withHome((home) => {
    const bad = run(home, "inject", "middle");
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /head\|tail\|both/);
    assert.equal(readTuning(home).injectPosition, "head");

    const status = run(home, "inject");
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.json.injectPosition, "head");
    assert.equal(readAudit({ limit: 20, home }).filter((r) => r.event === "tuning_setting").length, 0);
  });
});

test("retry 不需要重启：下一轮对话即生效，且不再写专用事件", () => {
  withHome((home) => {
    const result = run(home, "retry", "on");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.restart_required, false);
    assert.equal(result.json.effective, "next-turn");
    const events = readAudit({ limit: 20, home }).map((r) => r.event);
    assert.deepEqual(events, ["tuning_setting"]);
  });
});
