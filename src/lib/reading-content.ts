import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { knowledge } from "@/db/schema";
import { contentKey, defaultNote, type ContentCategory } from "@/lib/content";
import type { Locale } from "@/lib/i18n";
import type { ChartResult } from "@/lib/types";

export type ReadingNotes = { sun:string; moon:string; ascendant:string | null; house:string | null };
export async function getReadingNotes(result:ChartResult, locale:Locale):Promise<ReadingNotes> {
  const entries: { category:ContentCategory; item:string }[] = [{category:"sun",item:result.natalSun.sign},{category:"moon",item:result.moon.sign}];
  if(result.ascendant) entries.push({category:"ascendant",item:result.ascendant.sign});
  if(result.sunHouse) entries.push({category:"house",item:String(result.sunHouse)});
  const keys=entries.map(entry=>contentKey(entry.category,entry.item,locale));
  const saved=await db.select({key:knowledge.key,body:knowledge.body}).from(knowledge).where(inArray(knowledge.key,keys));
  const find=(category:ContentCategory,item:string) => saved.find(note=>note.key===contentKey(category,item,locale))?.body ?? defaultNote(category,item,locale);
  return {sun:find("sun",result.natalSun.sign),moon:find("moon",result.moon.sign),ascendant:result.ascendant?find("ascendant",result.ascendant.sign):null,house:result.sunHouse?find("house",String(result.sunHouse)):null};
}
