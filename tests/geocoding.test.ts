import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { GET } from "../src/app/api/places/route";

test("geocoding selects the right endpoint and never exposes the customer key",async()=>{
  const originalFetch=globalThis.fetch;const originalKey=process.env.OPEN_METEO_API_KEY;const key=randomBytes(20).toString("hex");let requested="";
  try{
    globalThis.fetch=async(input)=>{requested=String(input);return new Response(JSON.stringify({results:[{name:"Mérida",latitude:20.967,longitude:-89.623,timezone:"America/Merida",country:"México"}]}),{status:200,headers:{"Content-Type":"application/json"}});};
    delete process.env.OPEN_METEO_API_KEY;
    const free=await GET(new Request("http://localhost/api/places?q=Merida&lang=es"));
    assert.equal(new URL(requested).hostname,"geocoding-api.open-meteo.com");assert.equal(new URL(requested).searchParams.get("language"),"es");assert.equal(free.status,200);
    process.env.OPEN_METEO_API_KEY=key;
    const commercial=await GET(new Request("http://localhost/api/places?q=Merida&lang=es"));
    assert.equal(new URL(requested).hostname,"customer-geocoding-api.open-meteo.com");assert.equal(new URL(requested).searchParams.get("apikey"),key);assert.ok(!(await commercial.text()).includes(key));
    globalThis.fetch=async()=>{throw new Error(`provider error ${key}`);};
    const failed=await GET(new Request("http://localhost/api/places?q=Merida"));assert.equal(failed.status,503);assert.ok(!(await failed.text()).includes(key));
  }finally{globalThis.fetch=originalFetch;if(originalKey===undefined)delete process.env.OPEN_METEO_API_KEY;else process.env.OPEN_METEO_API_KEY=originalKey;}
});
