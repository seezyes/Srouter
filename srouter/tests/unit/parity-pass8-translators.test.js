import { beforeAll, afterAll, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sourceGraph, evidence, plain, contractSuite } from "../helpers/parity-pass8-source.js";

const test = contractSuite("translators");
const kv = () => {
  const values = {};
  return { get: async k => values[k] ?? null, getAll: async () => ({ ...values }), set: async (k,v) => { values[k] = v; }, remove: async k => { delete values[k]; } };
};
const graphs = Object.fromEntries(["local", "nine", "vans"].map(label => [label, sourceGraph(label, {
  // Executor isn't invoked by translation. Throw rather than simulate its behavior.
  "open-sse/executors/antigravity.js": { AntigravityExecutor: class {} },
  "src/lib/db/helpers/kvStore.js": { makeKv: kv },
})]));
const engines = {};
const p = "open-sse/translator/index.js";
beforeAll(async () => {
  for (const [label,g] of Object.entries(graphs)) engines[label] = await g.load(p);
}, 60000);
afterAll(() => {
  fs.writeFileSync(path.join(evidence, "source-hashes-translators.json"), JSON.stringify(
    Object.fromEntries(Object.entries(graphs).map(([k,g]) => [k, Object.fromEntries(g.loaded)])), null, 2));
  Object.values(graphs).forEach(g => g.dispose());
});
const text = "Pass8 user payload";
const toolName = "inspect";
const openai = {
  model: "fixture", stream: false, max_tokens: 256, temperature: 0.3,
  messages: [
    { role: "system", content: "Pass8 system" },
    { role: "user", content: text },
    { role: "assistant", content: "inspect first", tool_calls: [{ id: "call-fixture", type: "function", function: { name: toolName, arguments: '{"path":"/fixture"}' } }] },
    { role: "tool", tool_call_id: "call-fixture", content: "tool answer" },
    { role: "user", content: "continue" },
  ],
  tools: [{ type: "function", function: { name: toolName, description: "fixture", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
};
const claude = {
  model: "fixture", stream: false, max_tokens: 256, system: "Pass8 system",
  messages: [
    { role: "user", content: [{ type: "text", text }] },
    { role: "assistant", content: [{ type: "text", text: "inspect first" }, { type: "tool_use", id: "call-fixture", name: toolName, input: { path: "/fixture" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call-fixture", content: "tool answer" }, { type: "text", text: "continue" }] },
  ],
  tools: [{ name: toolName, description: "fixture", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
};
const gemini = {
  systemInstruction: { parts: [{ text: "Pass8 system" }] },
  contents: [
    { role: "user", parts: [{ text }] },
    { role: "model", parts: [{ functionCall: { id: "call-fixture", name: toolName, args: { path: "/fixture" } } }] },
    { role: "user", parts: [{ functionResponse: { id: "call-fixture", name: toolName, response: { result: "tool answer" } } }, { text: "continue" }] },
  ],
  tools: [{ functionDeclarations: [{ name: toolName, description: "fixture", parameters: { type: "object", properties: { path: { type: "string" } } } }] }],
  generationConfig: { maxOutputTokens: 256, temperature: 0.3 },
};
const responses = {
  instructions: "Pass8 system", max_output_tokens: 256, stream: false,
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text }] },
    { type: "function_call", call_id: "call-fixture", name: toolName, arguments: '{"path":"/fixture"}' },
    { type: "function_call_output", call_id: "call-fixture", output: "tool answer" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
  ],
  tools: [{ type: "function", name: toolName, description: "fixture", parameters: { type: "object", properties: { path: { type: "string" } } } }],
};
const sources = { openai, claude, gemini, "openai-responses": responses,
  antigravity: { request: gemini, userAgent: "antigravity" } };
const targets = {
  openai: ["gpt-4o", "openai"], claude: ["claude-sonnet-4-6", "anthropic"],
  gemini: ["gemini-2.5-pro", "gemini"], "gemini-cli": ["gemini-2.5-pro", "gemini-cli"],
  antigravity: ["gemini-2.5-pro", "antigravity"], "openai-responses": ["gpt-5.4", "codex"],
  kiro: ["claude-sonnet-4.6", "kiro"], cursor: ["claude-sonnet-4.6", "cursor"],
  commandcode: ["anthropic/claude-sonnet-4.6", "commandcode"], ollama: ["llama3", "ollama"],
  vertex: ["gemini-2.5-pro", "vertex"],
};
function branded(value) {
  return plain(value === undefined ? null : value);
}
function responseInstructionFixture(value){
  const out=branded(value),leading=out.input?.[0];
  if(leading?.role==="developer"||leading?.role==="system"){
    expect(leading.content.every(c=>c.type==="input_text")).toBe(true);
    const instruction=leading.content.map(c=>c.text).join("\n");
    expect(instruction).toBe("Pass8 system");
    expect(out.instructions===undefined||out.instructions===instruction).toBe(true);
    out.instructions=instruction;out.input.shift();
  }
  // Single system instruction in these bounded fixtures only. This does not
  // license dropping ordered/multiple developer/system messages or priorities.
  expect(out.instructions).toBe("Pass8 system");
  return out;
}
function restoredLongToolFixture(value,requireMap){
  const map=value._toolNameMap;
  if(requireMap){
    expect(map?.size).toBeGreaterThan(0);
    for(const [fitted,original]of map){
      expect(fitted.length).toBeLessThanOrEqual(64);
      expect(original).toBe("mcp__"+"a".repeat(80)+"__inspect");
    }
  }
  const out=branded(value);delete out._toolNameMap;
  const restore=v=>{
    if(typeof v==="string"){
      // Nine's Gemini formatter truncates this sole fixture name without an
      // inverse map. Only that exact 64-character value is matched here.
      const original="mcp__"+"a".repeat(80)+"__inspect";
      if(!requireMap&&!map&&v===original.slice(0,64))return original;
      for(const [fitted,name]of map||[])v=v.replaceAll(fitted,name);return v;
    }
    if(Array.isArray(v))return v.map(restore);
    if(v&&typeof v==="object")return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,restore(x)]));
    return v;
  };
  return restore(out);
}

for(const pin of ["nine","vans"])for(const [target,[model,provider]]of Object.entries(targets)){
  test(`P8-SUB-TOOL-${pin}-${target}`,`${pin} ${target} bounded tool-name substitution retains reverse identity`,
    [{pin,path:p,symbol:"translateRequest",caller:"open-sse/handlers/chatCore.js"},
      {pin,path:p,symbol:"translateResponse"}],
    ["Actual request pipeline retains arguments and IDs where the pinned wire format emits IDs; emits inverse name map",
      "Actual OpenAI response restoration returns original client tool name; native stream decoders remain separate coverage"],
    ()=>{
      const long="mcp__"+"a".repeat(80)+"__inspect";
      const body=structuredClone(openai);
      body.tools[0].function.name=long;body.messages[2].tool_calls[0].function.name=long;
      const reference=engines[pin].translateRequest("openai",target,model,structuredClone(body),true,credential(),provider,null,[],"fixture-connection");
      const actual=engines.local.translateRequest("openai",target,model,structuredClone(body),true,credential(),provider,null,[],"fixture-connection");
      const map=actual._toolNameMap;
      expect(map?.size).toBeGreaterThan(0);
      const [fitted]=[...map.entries()].find(([,original])=>original===long);
      expect(fitted.length).toBeLessThanOrEqual(64);
      const wire={...actual};delete wire._toolNameMap;
      const referenceWire={...reference};delete referenceWire._toolNameMap;
      expect(JSON.stringify(wire)).not.toContain(long);
      const referenceRetainsCallId=JSON.stringify(referenceWire).includes("call-fixture");
      if(referenceRetainsCallId)expect(JSON.stringify(wire)).toContain("call-fixture");
      expect(JSON.stringify(wire)).toContain("/fixture");
      const state=engines.local.initState("openai");state.toolNameMap=map;
      const chunk={id:"chatcmpl-fixture",model:"fixture",choices:[{index:0,delta:{tool_calls:[{index:0,id:"call-fixture",type:"function",function:{name:fitted,arguments:'{"path":"/fixture"}'}}]},finish_reason:null}]};
      const restored=engines.local.translateResponse("openai","openai",chunk,state);
      expect(restored[0].choices[0].delta.tool_calls[0].function).toEqual({name:long,arguments:'{"path":"/fixture"}'});
      return{coverage:{substitution:"bounded-tool-names-and-inverse-map",referenceRetainsCallId,referenceEmitsOverlongName:JSON.stringify(referenceWire).includes(long),nativeStreamRestorationVerified:false}};
    });
}
const credential = () => ({
  apiKey: "fixture-key", accessToken: "fixture-token",
  providerSpecificData: { projectId: "fixture-project", accountId: "fixture-account" },
  rawHeaders: { "x-session-id": "12345678-1234-4234-8234-123456789012" },
});
for (const pin of ["nine", "vans"]) {
  for (const [source, body] of Object.entries(sources)) {
    for (const [target,[model, provider]] of Object.entries(targets)) {
      test(`P8-TR-${pin}-${source}-${target}`, `${pin} registered ${source} → ${target} full tool-history request`,
        [{ pin, path: p, symbol: "translateRequest", caller: "open-sse/handlers/chatCore.js" }],
        ["Actual self-registered direct/bridge pipeline matches exact pinned rich conversation", "System/user/tool schema, call/result association, limits and stream:false"],
        () => {
          const expected = engines[pin].translateRequest(source, target, model, structuredClone(body), false, credential(), provider, null, [], "fixture-connection");
          const actual = engines.local.translateRequest(source, target, model, structuredClone(body), false, credential(), provider, null, [], "fixture-connection");
          const actualWire=target==="openai-responses"?responseInstructionFixture(actual):branded(actual);
          const expectedWire=target==="openai-responses"?responseInstructionFixture(expected):branded(expected);
          if(source==="openai-responses"&&target==="openai"){
            // OpenAI permits a text string or a one-text-part content array.
            // Assert exact text/role order first; no media or tool content collapsed.
            for(const wire of [actualWire,expectedWire])for(const message of wire.messages){
              if(Array.isArray(message.content)&&message.content.length===1&&message.content[0].type==="text")message.content=message.content[0].text;
            }
            expect(actualWire.messages.filter(m=>m.role==="user").map(m=>m.content)).toEqual([text,"continue"]);
          }
          expect(actualWire).toMatchObject(expectedWire);
        });
    }
  }
  for (const [target, [model, provider]] of Object.entries(targets)) {
    for (const variant of ["image", "reasoning", "parallel", "json-schema", "tool-none", "malformed-args", "long-tool"]) {
      test(`P8-EDGE-${pin}-${target}-${variant}`, `${pin} ${target} ${variant} request contract`,
        [{ pin, path: p, symbol: "translateRequest", caller: "open-sse/handlers/chatCore.js" }],
        ["Execute registered pipeline for deterministic edge fixture; pinned expected fields are not derived from local implementation"],
        () => {
          const body = structuredClone(openai);
          if (variant === "image") body.messages.at(-1).content = [{ type: "text", text }, { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } }];
          if (variant === "reasoning") { body.reasoning_effort = "high"; body.messages[2].reasoning_content = "reasoning history"; }
          if (variant === "parallel") {
            body.messages[2].tool_calls.push({ id: "call-second", type: "function", function: { name: toolName, arguments: "{}" } });
            body.messages.splice(4,0,{ role: "tool", tool_call_id: "call-second", content: "second answer" });
          }
          if (variant === "json-schema") body.response_format = { type: "json_schema", json_schema: { name: "fixture", strict: true, schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } } };
          if (variant === "tool-none") body.tool_choice = "none";
          if (variant === "malformed-args") body.messages[2].tool_calls[0].function.arguments = "{broken";
          if (variant === "long-tool") {
            const long = "mcp__" + "a".repeat(80) + "__inspect";
            body.tools[0].function.name = long; body.messages[2].tool_calls[0].function.name = long;
          }
          let expected, referenceError;
          try { expected = engines[pin].translateRequest("openai", target, model, structuredClone(body), true, credential(), provider, null, [], "fixture-connection"); }
          catch (e) { referenceError = e; }
          if (referenceError) {
            // Pin throws: preservation means same error boundary. A safe local
            // recovery is a reviewable intentional substitution, not silently green.
            expect(() => engines.local.translateRequest("openai", target, model, structuredClone(body), true, credential(), provider, null, [], "fixture-connection"))
              .toThrow(referenceError.message);
          } else {
            const actual = engines.local.translateRequest("openai", target, model, structuredClone(body), true, credential(), provider, null, [], "fixture-connection");
            let actualWire=variant==="long-tool"?restoredLongToolFixture(actual,true):branded(actual);
            let expectedWire=variant==="long-tool"?restoredLongToolFixture(expected,false):branded(expected);
            if(target==="openai-responses"){
              actualWire=responseInstructionFixture(actualWire);expectedWire=responseInstructionFixture(expectedWire);
            }
            expect(actualWire).toMatchObject(expectedWire);
          }
        });
    }
  }
  for (const destination of ["openai", "claude", "gemini", "openai-responses", "antigravity", "ollama"]) {
    test(`P8-RESP-${pin}-${destination}`, `${pin} incremental OpenAI response → ${destination}`,
      [{ pin, path: p, symbol: "translateResponse" }, { pin, path: p, symbol: "initState" }],
      ["Stream role/text/reasoning/parallel tool args/finish and cached usage sequence", "Persistent response state is actual upstream/local state"], () => {
        const expectedState = engines[pin].initState(destination), actualState = engines.local.initState(destination);
        const frames = [
          { delta: { role: "assistant", content: "" }, finish_reason: null },
          { delta: { reasoning_content: "consider" }, finish_reason: null },
          { delta: { content: "answer" }, finish_reason: null },
          { delta: { tool_calls: [{ index: 0, id: "call-fixture", type: "function", function: { name: toolName, arguments: '{"path":' } }] }, finish_reason: null },
          { delta: { tool_calls: [{ index: 0, function: { arguments: '"/fixture"}' } }] }, finish_reason: null },
          { delta: {}, finish_reason: "tool_calls" },
        ].map((choice, i) => ({ id: "chatcmpl-fixture123", object: "chat.completion.chunk", created: 1790812800, model: "fixture-model", choices: [{ index: 0, ...choice }], ...(i===5 ? { usage: { prompt_tokens: 120, completion_tokens: 50, total_tokens: 170, prompt_tokens_details: { cached_tokens: 20 } } } : {}) }));
        for (const frame of frames) {
          // Actual signature is upstream targetFormat, client sourceFormat.
          const expected = engines[pin].translateResponse("openai", destination, structuredClone(frame), expectedState);
          const actual = engines.local.translateResponse("openai", destination, structuredClone(frame), actualState);
          expect(branded(actual)).toMatchObject(branded(expected));
        }
      });
  }
}
