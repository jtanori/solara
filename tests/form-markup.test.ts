import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

function tsxFiles(directory:string):string[] {
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?tsxFiles(join(directory,entry.name)):entry.name.endsWith(".tsx")?[join(directory,entry.name)]:[]);
}
function parse(file:string){return ts.createSourceFile(file,readFileSync(file,"utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);}
type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;
function attributes(node:Opening){return node.attributes.properties.filter(ts.isJsxAttribute);}
function attribute(node:Opening,name:string){return attributes(node).find(item=>item.name.getText()===name);}
function literal(node:Opening,name:string){const value=attribute(node,name)?.initializer;return value&&ts.isStringLiteral(value)?value.text:undefined;}
function openings(source:ts.SourceFile,tag:string){const found:Opening[]=[];function visit(node:ts.Node){if((ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node))&&node.tagName.getText(source)===tag)found.push(node);ts.forEachChild(node,visit);}visit(source);return found;}
function insideForm(node:ts.Node){let parent=node.parent;while(parent){if(ts.isJsxElement(parent)&&parent.openingElement.tagName.getText()==="form")return true;parent=parent.parent;}return false;}

test("all input, select and textarea controls have explicit names and autocomplete hints",()=>{
  let count=0;const missing:string[]=[];
  for(const file of tsxFiles("src")){const source=parse(file);for(const tag of ["input","select","textarea"]){for(const control of openings(source,tag)){count++;if(!attribute(control,"name")||!attribute(control,"autoComplete"))missing.push(`${file}:${source.getLineAndCharacterOfPosition(control.getStart(source)).line+1} <${tag}>`);}}}
  assert.ok(count>=20,"the audit should cover the application's controls");assert.deepEqual(missing,[]);
});

test("authentication fields stay in a named POST form with password-manager tokens",()=>{
  const source=parse("src/components/auth-form.tsx");const inputs=openings(source,"input");
  const email=inputs.find(input=>literal(input,"id")==="auth-email");const password=inputs.find(input=>literal(input,"id")==="auth-password");const name=inputs.find(input=>literal(input,"id")==="auth-name");
  assert.ok(email&&password&&name);assert.equal(literal(email,"name"),"email");assert.equal(literal(email,"type"),"email");assert.match(attribute(email,"autoComplete")!.getText(source),/personalAutocomplete\("email",\s*limitProfileAutofill\)/);
  assert.equal(literal(name,"name"),"name");assert.equal(literal(password,"name"),"password");assert.match(attribute(password,"autoComplete")!.getText(source),/current-password/);
  assert.ok(inputs.every(insideForm));const form=openings(source,"form")[0];assert.equal(literal(form,"method"),"post");assert.equal(literal(form,"action"),"/api/auth");
});

test("onboarding controls are owned by a form and review edits never submit",()=>{
  const wizard=parse("src/components/wizard.tsx");const form=openings(wizard,"form").find(item=>literal(item,"name")==="solar-return");assert.ok(form);assert.equal(literal(form,"method"),"post");assert.ok(attribute(form,"onSubmit"));assert.ok(openings(wizard,"input").every(insideForm));
  const locations=openings(wizard,"LocationField");assert.equal(locations.length,2);assert.ok(locations.every(insideForm));
  const editButtons=openings(wizard,"button").filter(button=>attribute(button,"onClick")?.getText(wizard).includes("setStep"));assert.equal(editButtons.length,5);assert.ok(editButtons.every(button=>literal(button,"type")==="button"));
});
