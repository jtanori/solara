import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { AuthForm } from "../src/components/auth-form";
import { HeroNameForm } from "../src/components/hero-name-form";
import { Wizard } from "../src/components/wizard";
import { LocationField } from "../src/components/location-field";
import { UsageGuide } from "../src/components/usage-guide";
import { usageGuides } from "../src/lib/usage-guide";

const router={back(){},forward(){},refresh(){},push(){},replace(){},prefetch(){}};
function render(element:React.ReactElement){return renderToStaticMarkup(React.createElement(AppRouterContext.Provider,{value:router as never},element));}
function attributes(tag:string){return Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(match=>[match[1].toLowerCase(),match[2]]));}
function input(html:string,id:string){const tag=(html.match(/<input\b[^>]*>/g)??[]).find(value=>attributes(value).id===id);assert.ok(tag,`missing ${id}`);return attributes(tag);}
function formAttributes(html:string){const tag=(html.match(/<form\b[^>]*>/g)??[])[0];assert.ok(tag,"missing form");return attributes(tag);}

test("server-rendered signup fields use safe initial hints and preserve password managers",()=>{
  const html=render(React.createElement(AuthForm,{destination:"/dashboard",locale:"en"}));
  const form=formAttributes(html);
  assert.equal(form.method,"post");assert.equal(form.action,"/api/auth");
  assert.deepEqual({name:input(html,"auth-name").name,autocomplete:input(html,"auth-name").autocomplete},{name:"name",autocomplete:"off"});
  assert.deepEqual({name:input(html,"auth-email").name,type:input(html,"auth-email").type,autocomplete:input(html,"auth-email").autocomplete},{name:"email",type:"email",autocomplete:"off"});
  assert.equal(input(html,"auth-password").name,"password");assert.equal(input(html,"auth-password").autocomplete,"new-password");
});

test("landing and onboarding use named forms with conservative initial hints",()=>{
  const hero=render(React.createElement(HeroNameForm,{locale:"es"}));assert.equal(input(hero,"hero-name").name,"name");assert.equal(input(hero,"hero-name").autocomplete,"off");
  const wizard=render(React.createElement(Wizard,{initialName:"",signedIn:false,currentYear:2026,locale:"en"}));
  const form=formAttributes(wizard);assert.equal(form.name,"solar-return");assert.equal(form.method,"post");assert.equal(input(wizard,"wizard-name").autocomplete,"off");
});

test("location and guide searches explicitly opt out of unrelated autofill",()=>{
  const location=render(React.createElement(LocationField,{value:null,onChange:()=>{},label:"Birth city",locale:"en",kind:"birth"}));
  const search=input(location,"birth-place-search");assert.equal(search.name,"birthPlaceSearch");assert.equal(search.autocomplete,"off");assert.match(location,/<label[^>]*for="birth-place-search"/);
  const guide=render(React.createElement(UsageGuide,{guides:usageGuides("en"),locale:"en",initialAudience:"visitor",signedInName:null}));
  const tag=(guide.match(/<input\b[^>]*>/g)??[]).find(value=>attributes(value).name==="query");assert.ok(tag);assert.equal(attributes(tag).autocomplete,"off");
});
