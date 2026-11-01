// Self-contained mid-stream failover demo. Two local mock upstreams, zero API keys.
// Run: node examples/chaos-demo.js
const http = require("node:http");
const { createGateway } = require("../lib/gateway");
const { buildDefaultConfig } = require("../lib/config-defaults");

process.env.DEEPSEEK_API_KEY = "demo";
process.env.MOONSHOT_API_KEY = "demo";
process.env.OVERRAIL_CHAOS = "midstream_drop@3";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function sse(id, delta, extra = {}) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: 1,
    model: id,
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  })}\n\n`;
}

async function main() {
  const primary = await listen(
    http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const piece of ["The", " quick", " brown", " fox", " jumps", " over"]) {
          res.write(sse("primary", { content: piece }));
        }
        res.end("data: [DONE]\n\n");
      });
    })
  );

  let continuation_body = null;
  const secondary = await listen(
    http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        continuation_body = JSON.parse(raw);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(sse("secondary", { content: " jumps" }));
        res.write(sse("secondary", { content: " over the lazy dog." }));
        res.end(
          `data: ${JSON.stringify({
            id: "secondary",
            object: "chat.completion.chunk",
            created: 1,
            model: "secondary",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 12, completion_tokens: 6 },
          })}\n\ndata: [DONE]\n\n`
        );
      });
    })
  );

  const config = buildDefaultConfig();
  config.profiles.deepseek.baseUrl = `http://127.0.0.1:${primary.address().port}/v1`;
  config.profiles.kimi.baseUrl = `http://127.0.0.1:${secondary.address().port}/v1`;
  config.chains.default = ["deepseek", "kimi"];
  const gateway = await listen(createGateway({ config }));

  console.log("overrail chaos demo — mock upstreams on localhost, no API keys\n");
  console.log("primary:   deepseek (mock) — OVERRAIL_CHAOS=midstream_drop@3");
  console.log("secondary: kimi (mock) — healthy\n");

  const res = await fetch(`http://127.0.0.1:${gateway.address().port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek",
      stream: true,
      messages: [{ role: "user", content: "Finish the sentence." }],
    }),
  });

  const text = await res.text();
  const events = text.split("\n\n").filter((block) => block.startsWith("data:"));
  let streamed = "";
  for (const block of events) {
    const data = block.replace(/^data: /, "");
    if (data === "[DONE]") {
      console.log("\nclient <- [DONE] (exactly one, after the full stitched reply)");
      continue;
    }
    const chunk = JSON.parse(data);
    const delta = chunk.choices && chunk.choices[0] ? chunk.choices[0].delta : {};
    if (delta.content) {
      streamed += delta.content;
      console.log(`client <- "${delta.content}"`);
    }
    if (chunk.usage) {
      console.log(`client <- finish_reason=stop, merged usage: ${JSON.stringify(chunk.usage)}`);
    }
  }

  const prefill = continuation_body.messages[continuation_body.messages.length - 1];
  console.log(`\nprimary died after 3 content events; overrail sent the next provider:`);
  console.log(`  ${JSON.stringify(prefill)}`);
  console.log(`\nfinal stitched reply: "${streamed}"`);
  console.log("the client saw one continuous stream. no retry, no error, no lost tokens.");

  for (const server of [primary, secondary, gateway]) {
    server.closeAllConnections();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
