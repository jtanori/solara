import assert from "node:assert/strict";
import test from "node:test";
import { SolarReturnDocument } from "../src/components/solar-pdf";
import { calculateSolarReturn } from "../src/lib/solar";
import { defaultNote } from "../src/lib/content";
import type { ChartInput } from "../src/lib/types";

const input:ChartInput={name:"Example",birthDate:"1984-05-16",birthTime:"01:00",birthPlace:{name:"Mexicali, Mexico",latitude:32.6393,longitude:-115.4747,timezone:"America/Tijuana"},returnPlace:{name:"New York, United States",latitude:40.7128,longitude:-74.006,timezone:"America/New_York"},year:2026};
const result=calculateSolarReturn(input);
function pageCount(buffer:Buffer){return (buffer.toString("latin1").match(/\/Type\s*\/Page\b/g)??[]).length;}
test("generates editorial free and premium PDF editions",async()=>{
  const notes={sun:defaultNote("sun",result.natalSun.sign,"es"),moon:defaultNote("moon",result.moon.sign,"es"),ascendant:result.ascendant?defaultNote("ascendant",result.ascendant.sign,"es"):null,house:result.sunHouse?defaultNote("house",String(result.sunHouse),"es"):null};
  assert.ok(notes.sun,"Spanish Sun interpretation must exist");
  const renderer=await import("@react-pdf/renderer");
  const free=await renderer.renderToBuffer(SolarReturnDocument({input,result,notes,locale:"es",premium:false,renderer}));
  const premium=await renderer.renderToBuffer(SolarReturnDocument({input,result,notes,locale:"es",premium:true,renderer}));
  assert.equal(free.subarray(0,5).toString(),"%PDF-");assert.equal(pageCount(free),2);assert.equal(pageCount(premium),3);
});
