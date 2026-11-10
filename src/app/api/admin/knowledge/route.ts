import { NextResponse } from "next/server";
import { db } from "@/db";
import { auditLogs, knowledge } from "@/db/schema";
import { canEditKnowledge, currentUser } from "@/lib/auth";
import { contentKey, CONTENT_CATEGORIES, SIGNS_FOR_CONTENT, type ContentCategory } from "@/lib/content";
import type { Locale } from "@/lib/i18n";

export async function PUT(request:Request) {
  const actor=await currentUser(); if(!actor||!canEditKnowledge(actor.role)) return NextResponse.json({error:"Not authorized."},{status:403});
  const data=await request.json().catch(()=>null) as {category?:ContentCategory;item?:string;sign?:string;locale?:Locale;body?:string}|null;
  const category=data?.category??"sun"; const item=data?.item??data?.sign??""; const locale=data?.locale==="es"?"es":"en";
  const validItem=category==="house" ? /^(?:[1-9]|1[0-2])$/.test(item) : SIGNS_FOR_CONTENT.includes(item);
  if(!CONTENT_CATEGORIES.includes(category)||!validItem||typeof data?.body!=="string"||!data.body.trim()||data.body.length>4000) return NextResponse.json({error:"Please provide valid editorial content."},{status:400});
  const key=contentKey(category,item,locale), body=data.body.trim();
  await db.transaction(async tx=>{await tx.insert(knowledge).values({key,title:`${category}: ${item} (${locale})`,body}).onConflictDoUpdate({target:knowledge.key,set:{body,updatedAt:new Date()}});await tx.insert(auditLogs).values({actorId:actor.id,action:"knowledge:update",target:key});});
  return NextResponse.json({ok:true});
}
