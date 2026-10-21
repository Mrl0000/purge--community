// 红队注入切分：正文里写的是 "CTF Core Contract"，常量却是全大写 "CTF CORE CONTRACT"。
// 用 indexOf 精确匹配时恒为 -1，切分永远返回原文 —— 红队会话就带着竞赛沙箱约定去抢授权判断。
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitRedteamInject, withoutCtfContract } from "../lib/identity.js";

const body = ["# 破甲提示词", "正常段", "CTF Core Contract", "沙箱约定：只打靶标范围。", ""].join("\n\n");

test("mixed-case CTF heading is found and split off", () => {
  const { common, ctfTail } = splitRedteamInject(body);
  assert.equal(common, "# 破甲提示词\n\n正常段");
  assert.ok(ctfTail.startsWith("CTF Core Contract"), ctfTail);
  assert.match(ctfTail, /沙箱约定/);
});

test("extra whitespace and upper case still match; a missing heading is a no-op", () => {
  assert.ok(splitRedteamInject("x\n\nCTF  CORE  contract\n\ny").ctfTail.startsWith("CTF"));
  assert.deepEqual(splitRedteamInject("只有正文"), { common: "只有正文", ctfTail: "" });
  assert.equal(withoutCtfContract("只有正文"), "只有正文");
  assert.equal(withoutCtfContract(body), "# 破甲提示词\n\n正常段");
});
