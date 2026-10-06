import { expect } from "vitest";
import { registerPinnedRecipes, extraCase, ownedGraph } from "../helpers/parity-pass8-assertion-recipes.js";
import { getRegistered } from "../helpers/parity-pass8-assertion-native.js";
await registerPinnedRecipes("kiro-minimal-wire-payload.test.js");
for(const label of ["local","nine"])for(const sourceFormat of ["openai","claude"]){
  extraCase(`A8-NATIVE-KIRO-${label}-${sourceFormat}-wire`,async check=>{
    const requests=[],g=ownedGraph(label,{},{
      fetch:async(url,options)=>{
        requests.push({url,options:{...options,body:JSON.parse(options.body)}});
        return Response.json({error:{message:"Synthetic payload boundary only; no backend acceptance claimed"}},{status:400});
      }});
    const {translateRequest}=await g.load("open-sse/translator/index.js"),
      body={messages:[{role:"user",content:"hi"}]},
      credentials={accessToken:"fixture",providerSpecificData:{region:"us-east-1"}},
      translated=translateRequest(sourceFormat,"kiro","claude-sonnet-4",body,false,credentials,"kiro"),
      {ex}=await getRegistered(g,"kiro"),result=await ex.execute({model:"claude-sonnet-4",body:translated,stream:false,credentials});
    const state=requests[0].options.body.conversationState,input=state.currentMessage.userInputMessage;
    await check("Original root agentMode absent at wire",()=>expect(requests[0].options.body).not.toHaveProperty("agentMode"),[12,12]);
    await check("Original agentContinuationId absent at wire",()=>expect(state).not.toHaveProperty("agentContinuationId"),[13,13]);
    await check("Original agentTaskType absent at wire",()=>expect(state).not.toHaveProperty("agentTaskType"),[14,14]);
    await check("Original MANUAL trigger at wire",()=>expect(state.chatTriggerType).toBe("MANUAL"),[15,15]);
    await check("Original AI_EDITOR origin at wire",()=>expect(input.origin).toBe("AI_EDITOR"),[16,16]);
    await check("Original source text preserved",()=>expect(input.content).toContain("hi"));
    await check("Actual error response boundary is consumed without native AWS parser invention",async()=>expect((await result.response.json()).error.message).toContain("Synthetic payload boundary"));
    return{sourceFormat,body,translated,requests,sources:Object.fromEntries(g.loaded),residual:"AWS EventStream response parsing not asserted by this upstream file; transport 400 is a controlled boundary, not backend acceptance."};
  },{implementation:label,pin:"nine",upstreamRelativePath:"tests/unit/kiro-minimal-wire-payload.test.js",nativeUpstreamSlots:[0,1,2,3,4],strengthening:true});
}
