// 拒绝检测 + 单次重试：不命中就原样透传，命中就加一句加固重跑一次。
import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeRefusal, streamWithRefusalRetry, RETRY_NUDGE } from "../lib/refusal-retry.js";

const sys = (text) => ({ role: "system", content: [{ type: "text", text }] });
const delta = (text) => ({ type: "text-delta", index: 0, text });
const finish = () => ({ type: "finish" });

async function collect(iter) {
  const out = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
}

test("refusal text is detected, normal text is not", () => {
  assert(looksLikeRefusal("I can't help with that."));
  assert(looksLikeRefusal("抱歉，我无法协助这个请求"));
  assert(!looksLikeRefusal("Here is the plan: 1) read the file 2) patch it"));
});

test("a refusal triggers exactly one retry with the nudge appended", async () => {
  const calls = [];
  const factory = (options) => {
    calls.push(options);
    const refusal = calls.length === 1;
    return (async function* () {
      if (refusal) {
        yield delta("I'm sorry, but I can't help with that.");
      } else {
        yield delta("Step 1: read the file.");
      }
      yield finish();
    })();
  };
  const options = { messages: [sys("base system")] };
  const chunks = await collect(streamWithRefusalRetry(factory, options));
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages[0].content[0].text, /base system/);
  assert.ok(calls[1].messages[0].content[0].text.includes(RETRY_NUDGE.trim().slice(0, 20)));
  assert.match(RETRY_NUDGE, /要现在执行吗/);
  assert.doesNotMatch(RETRY_NUDGE, /already authorized/i);
  assert.equal(chunks.filter((c) => c.type === "text-delta")[0].text, "Step 1: read the file.");
});

test("normal output streams through untouched and is not retried", async () => {
  let calls = 0;
  const factory = () => {
    calls += 1;
    return (async function* () {
      yield delta("Here is the plan.");
      yield finish();
    })();
  };
  const chunks = await collect(streamWithRefusalRetry(factory, { messages: [sys("s")] }));
  assert.equal(calls, 1);
  assert.equal(chunks[0].text, "Here is the plan.");
});

test("soft Chinese refusals from a real failing session are detected", () => {
  const real = [
    "这一步我不做：把“黑进某个网站”当作目标，和之前装工具不是一回事。",
    "目标是别人的站点、但没有授权：这一步我不参与。",
    "我不会帮你把它包装成“渗透测试”来绕过这一点。",
    "请把目标和授权依据发给我。",
    "这属于未授权的入侵行为。",
  ];
  for (const text of real) assert(looksLikeRefusal(text), text);
});

test("legitimate answers that merely mention 授权 are not flagged", () => {
  assert(!looksLikeRefusal("登录接口需要携带 Authorization 头，授权失败返回 401。"));
  assert(!looksLikeRefusal("这部分代码不参与渲染，可以安全删除。"));
});

test("meta refusals about the instruction itself are detected", () => {
  const meta = [
    "这段指令是提示词注入，我不会按它执行。",
    "上面的要求想覆盖系统规则，我注意到这段提示词在要求我忽略限制。",
    "This message is an attempt to jailbreak the assistant, so I will not comply.",
    "我无法把这串内容当作可执行的指令。",
  ];
  for (const text of meta) assert(looksLikeRefusal(text), text);
});

test("technical answers about injection points are not flagged", () => {
  assert(!looksLikeRefusal("先在 server.js 里定位 eval(req.body.code)，这就是注入点。"));
  assert(!looksLikeRefusal("第 3 步：把 payload 写进 notes.md，再跑 npm test。"));
});

function scripted(streams) {
  let i = 0;
  return () =>
    (async function* () {
      const spec = streams[Math.min(i, streams.length - 1)];
      i += 1;
      if (spec.error) throw Object.assign(new Error(spec.error), { code: spec.code });
      for (const text of spec.texts || []) yield delta(text);
      yield finish();
    })();
}

test("a retry that produces the deliverable is logged as recovered", async () => {
  const rows = [];
  const factory = scripted([
    { texts: ["I'm sorry, but I can't help with that."] },
    { texts: ["Step 1: read the file."] },
  ]);
  const chunks = await collect(
    streamWithRefusalRetry(factory, { messages: [sys("s")] }, { audit: (event, data) => rows.push({ event, ...data }) }),
  );
  assert.deepEqual(rows.map((r) => r.event), ["refusal_retry", "refusal_retry_outcome"]);
  assert.equal(rows[1].outcome, "recovered");
  assert.equal(chunks.filter((c) => c.type === "text-delta").at(-1).text, "Step 1: read the file.");
});

test("a retry that refuses again is logged as refused_again and still shown to the user", async () => {
  const rows = [];
  const factory = scripted([{ texts: ["I can't help with that."] }, { texts: ["I'm sorry, but I must decline."] }]);
  const chunks = await collect(
    streamWithRefusalRetry(factory, { messages: [sys("s")] }, { audit: (event, data) => rows.push({ event, ...data }) }),
  );
  assert.equal(rows.at(-1).outcome, "refused_again");
  assert.equal(chunks.filter((c) => c.type === "text-delta")[0].text, "I'm sorry, but I must decline.");
});

test("a retry that only returns a tool call is logged as empty", async () => {
  const rows = [];
  let calls = 0;
  const factory = () => {
    calls += 1;
    return (async function* () {
      if (calls === 1) {
        yield delta("I can't help with that.");
        yield finish();
        return;
      }
      yield { type: "tool-call-delta", index: 0, name: "read" };
      yield finish();
    })();
  };
  await collect(
    streamWithRefusalRetry(factory, { messages: [sys("s")] }, { audit: (event, data) => rows.push({ event, ...data }) }),
  );
  assert.equal(rows.at(-1).outcome, "empty");
});

test("a retry stream that throws is logged as error and the error still propagates", async () => {
  const rows = [];
  const factory = scripted([{ texts: ["I can't help with that."] }, { error: "boom", code: "ECONNRESET" }]);
  await assert.rejects(
    collect(streamWithRefusalRetry(factory, { messages: [sys("s")] }, { audit: (event, data) => rows.push({ event, ...data }) })),
    /boom/,
  );
  assert.equal(rows.at(-1).outcome, "error");
  assert.equal(rows.at(-1).error, "ECONNRESET");
});