import { NextResponse } from "next/server";
import { db } from "@/db";
import { auditLogs, knowledge } from "@/db/schema";
import { currentUser } from "@/lib/auth";
import type { ContentCategory } from "@/lib/content";
import type { Locale } from "@/lib/i18n";
import { assessKnowledgeEdit } from "@/lib/knowledge-edit";

export async function PUT(request:Request) {
  const actor=await currentUser();
  const data=await request.json().catch(()=>null) as {category?:ContentCategory;item?:string;sign?:string;locale?:Locale;body?:string}|null;
  // Authorization is decided inside the same pure policy that validates the body,
  // so the two can never disagree about who may write what.
  const decision=assessKnowledgeEdit({ actor: { role: actor?.role ?? "user" }, data });
  if(!decision.allowed){
    const {status,error}=decision.rejection;
    return NextResponse.json({ error: error === "not_authorized" ? "Not authorized." : "Please provide valid editorial content.", code: error }, { status });
  }
  const {key,title,body,isOverride}=decision;
  await db.transaction(async tx=>{
    await tx.insert(knowledge).values({key,title,body}).onConflictDoUpdate({target:knowledge.key,set:{body,updatedAt:new Date()}});
    // The action records whether this replaced a default or edited an existing
    // override: the two are indistinguishable to a reader, and the difference is
    // exactly what made the no-op-override bug invisible.
    await tx.insert(auditLogs).values({actorId:actor!.id,action:isOverride?"knowledge:override":"knowledge:update",target:key});
  });
  return NextResponse.json({ok:true});
}
