import assert from "node:assert/strict";
import test from "node:test";
import { isDevelopmentMode } from "../src/lib/development";
import { isUsageAudience, usageAudienceFor, usageGuides, USAGE_AUDIENCES } from "../src/lib/usage-guide";

test("the guide is enabled only for the development environment",()=>{
  assert.equal(isDevelopmentMode("development"),true);
  for(const environment of ["production","test","staging",""]) assert.equal(isDevelopmentMode(environment),false);
});
test("the default guide follows the user's real role and plan",()=>{
  assert.equal(usageAudienceFor(null),"visitor");
  assert.equal(usageAudienceFor({role:"user",plan:"free"}),"free");
  assert.equal(usageAudienceFor({role:"user",plan:"paid"}),"premium");
  for(const role of ["editor","admin","owner"] as const) assert.equal(usageAudienceFor({role,plan:"paid"}),role);
  assert.equal(isUsageAudience("owner"),true);assert.equal(isUsageAudience("administrator"),false);
});
test("each role has actionable guides in English and Spanish",()=>{
  for(const locale of ["en","es"] as const){
    const guides=usageGuides(locale);assert.deepEqual(guides.map(guide=>guide.id),[...USAGE_AUDIENCES]);
    for(const guide of guides){assert.ok(guide.can.length&&guide.cannot.length);assert.ok(guide.sections.length>=3);assert.equal(new Set(guide.sections.map(section=>section.id)).size,guide.sections.length);for(const section of guide.sections){assert.ok(section.steps.length>=2);if(section.link)assert.ok(section.link.href.startsWith("/"));}}
  }
});
