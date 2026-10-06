import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { afterAll, expect } from "vitest";
import { sourceGraph, evidence, contractSuite } from "../helpers/parity-pass8-protocol-source.js";
const test=contractSuite("protocol-zed-negative"),graphs=[],results=[];
afterAll(()=>{
  fs.writeFileSync(path.join(evidence,"zed-negative-results.json"),JSON.stringify(results,null,2));
  fs.writeFileSync(path.join(evidence,"source-hashes-protocol-zed-negative.json"),JSON.stringify(graphs.map(g=>({label:g.label,files:Object.fromEntries(g.loaded)})),null,2));
  graphs.forEach(g=>g.dispose());
});
for(const label of ["local","nine","vans"])for(const kind of ["empty","clean-garbage","invalid-utf8","both-throw","oaep-empty","oaep-control"]){
  test(`P8P-ZED-${label}-${kind}`,`${label} ${kind} decrypt rejection ${label==="vans"?"at actual helper (native exchange absent)":"through actual callback/exchange/mapTokens"}`,
    [{pin:label,path:"open-sse/shared/zedAuth.js",symbol:"decryptZedAccessToken"},
      {pin:label,path:"src/lib/oauth/providers/zed.js",symbol:"exchangeToken",caller:"src/lib/oauth/index.js"}],
    ["Crypto only is synthetic; actual parser/decrypt execute; local/Nine actual callback exchange and mapTokens also execute","Vans has no native exchange provider; helper acceptance is not called session completion","Wrong-key implicit rejection must not become a token; red assertions preserve unsafe acceptances"],async()=>{
      const calls=[];
      const g=sourceGraph(label,{}, {fetch:async()=>new Response("{}",{status:401}),crypto:{privateDecrypt(options){
        calls.push(options.padding===crypto.constants.RSA_PKCS1_OAEP_PADDING?"oaep":"pkcs1");
        if(kind.startsWith("oaep-"))return kind==="oaep-empty"?Buffer.alloc(0):Buffer.from([0,1,2]);
        if(options.padding===crypto.constants.RSA_PKCS1_OAEP_PADDING||kind==="both-throw")throw new Error("synthetic wrong-key boundary");
        if(kind==="empty")return Buffer.alloc(0);
        if(kind==="invalid-utf8")return Buffer.from([255,254]);
        return Buffer.from("clean ASCII non-token garbage");
      }}});
      graphs.push(g);
      const auth=await g.load("open-sse/shared/zedAuth.js"),provider=label==="vans"?null:(await g.load("src/lib/oauth/providers/zed.js")).default;
      const verifier=auth.encodeZedPrivateKeyVerifier("synthetic private boundary"),callback="/?user_id=fixture-user&access_token=AQID";
      let accepted=false,mapped=false,error=false;
      try{
        if(provider){
          const tokens=await provider.exchangeToken({systemId:"prepared-system"},callback,null,verifier,null,{systemId:"registered-system"});
          accepted=true;
          expect(tokens.systemId).toBe("registered-system");
          const extra=await provider.postExchange(tokens);
          const stored=provider.mapTokens(tokens,extra);
          mapped=typeof stored.accessToken==="string";
        }else{
          const parsed=auth.parseZedCallbackPayload("http://127.0.0.1/"+callback.slice(1));
          auth.decryptZedAccessToken(parsed.encryptedAccessToken,verifier);accepted=true;
        }
      }catch{error=true;}
      results.push({label,kind,calls,accepted,mapped,error}); // Never persist returned bytes/private material.
      expect(calls).toEqual(kind.startsWith("oaep-")?["oaep"]:["oaep","pkcs1"]);
      expect(accepted,"Invalid crypto output must not be accepted by callback exchange").toBe(false);
      expect(mapped).toBe(false);
    });
}
for(const label of ["local","nine","vans"])for(const padding of ["oaep","legacy"]){
  test(`P8P-ZED-VALID-${label}-${padding}`,`${label} actual real RSA ${padding} supported synthetic-token roundtrip`,
    [{pin:label,path:"open-sse/shared/zedAuth.js",symbol:"decryptZedAccessToken"}],
    ["Independent publicEncrypt/privateDecrypt roundtrip; no credentials serialized","OAEP sha256 and documented legacy PKCS1 branch remain supported"],async()=>{
      const g=sourceGraph(label);graphs.push(g);
      const auth=await g.load("open-sse/shared/zedAuth.js");
      const {publicKey,privateKey}=crypto.generateKeyPairSync("rsa",{modulusLength:2048,privateKeyEncoding:{type:"pkcs1",format:"pem"},publicKeyEncoding:{type:"pkcs1",format:"pem"}});
      const original="fixture-valid-zed-token";
      const bytes=crypto.publicEncrypt({key:publicKey,padding:padding==="oaep"?crypto.constants.RSA_PKCS1_OAEP_PADDING:crypto.constants.RSA_PKCS1_PADDING,...(padding==="oaep"?{oaepHash:"sha256"}:{})},Buffer.from(original));
      expect(auth.decryptZedAccessToken(bytes.toString("base64url"),auth.encodeZedPrivateKeyVerifier(privateKey))).toBe(original);
    });
}
for(const label of ["local","nine"])for(const kind of ["empty","clean-garbage","invalid-utf8","both-throw","cross-origin","stray"]){
  test(`P8P-ZED-SESSION-${label}-${kind}`,`${label} actual callback listener → exchangeTokens → session/store boundary ${kind}`,
    [{pin:label,path:"src/lib/oauth/utils/server.js",symbol:"startZedProxy"},
      {pin:label,path:"src/lib/oauth/providers/index.js",symbol:"exchangeTokens"},
      {pin:label,path:"open-sse/shared/zedAuth.js",symbol:"decryptZedAccessToken"}],
    ["No socket: synthetic http captures actual request callback; source session and exchange run unchanged","Wrong-key output cannot set session done, stop listener or request connection storage","Origin and stray-callback guards stay effective"],async()=>{
      let handler,closed=0,stored=0,status;
      const mocks={
        http:{default:{createServer(fn){handler=fn;const server=new EventEmitter();server.listen=(port,host,cb)=>cb();server.address=()=>({port:29999});server.close=()=>closed++;return server;}}},
        url:{URL},
        "open-sse/index.js":{},
        "src/lib/oauth/providerHelpers.js":{extractCodexAccountInfo(){throw new Error("foreign provider");},fetchKiroProfileArn(){throw new Error("foreign provider");}},
        "src/models/index.js":{createProviderConnection:async()=>{stored++;return{id:"fixture-connection"};}},
      };
      const g=sourceGraph(label,mocks,{fetch:async()=>new Response("{}",{status:401}),crypto:{privateDecrypt(options){
        if(options.padding===crypto.constants.RSA_PKCS1_OAEP_PADDING||kind==="both-throw")throw new Error("synthetic wrong-key");
        return kind==="empty"?Buffer.alloc(0):kind==="invalid-utf8"?Buffer.from([255]):Buffer.from("clean ASCII non-token garbage");
      }}});graphs.push(g);
      const registration=fs.readFileSync(path.join(g.root,"src/lib/oauth/providers/index.js"),"utf8");
      for(const m of registration.matchAll(/^import\s+\w+\s+from\s+"\.\/([^"]+)";/gm)){
        if(m[1]!=="zed.js")g.mocks["src/lib/oauth/providers/"+m[1]]={default:{}};
      }
      const auth=await g.load("open-sse/shared/zedAuth.js"),server=await g.load("src/lib/oauth/utils/server.js");
      server.registerZedSession({state:"fixture-state",codeVerifier:auth.encodeZedPrivateKeyVerifier("synthetic key"),systemId:"registered-system"});
      await server.startZedProxy(0);
      await handler({method:"GET",url:kind==="stray"?"/":"/?user_id=fixture-user&access_token=AQID",headers:kind==="cross-origin"?{origin:"https://attacker.invalid"}:{}},{writeHead(n){status=n;},end(){}});
      const session=server.getZedSessionStatus("fixture-state");
      results.push({label,kind:"session-"+kind,sessionStatus:session.status,stored,closed,httpStatus:status});
      const expected=["cross-origin","stray"].includes(kind)?"pending":"error";
      expect.soft(session.status).toBe(expected);expect.soft(stored).toBe(0);expect.soft(closed).toBe(0);
      if(kind==="cross-origin")expect(status).toBe(403);
      server.stopZedProxy();
    },30000);
}
