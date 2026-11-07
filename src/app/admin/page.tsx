import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { AdminPanel } from "@/components/admin-panel";
import { canEditKnowledge, canManageUsers, currentUser } from "@/lib/auth";
import { getLocale } from "@/lib/i18n-server";
import { db } from "@/db";
import { knowledge, users } from "@/db/schema";
export default async function AdminPage(){
  const [user,locale]=await Promise.all([currentUser(),getLocale()]);const es=locale==="es";if(!user)redirect("/account?next=%2Fadmin");if(!canManageUsers(user.role)&&!canEditKnowledge(user.role))redirect("/dashboard");
  const members=canManageUsers(user.role)?await db.select({id:users.id,name:users.name,email:users.email,role:users.role}).from(users).orderBy(asc(users.createdAt)):[];
  const notes=canEditKnowledge(user.role)?await db.select({key:knowledge.key,body:knowledge.body}).from(knowledge):[];const content=Object.fromEntries(notes.map(note=>[note.key,note.body]));
  return <><SiteHeader /><main className="app-page"><div className="app-wrap"><div className="app-heading"><div><div className="eyebrow">{es?"UN ESPACIO PARA ADMINISTRAR SOLARA":"A THOUGHTFUL SPACE TO MANAGE SOLARA"}</div><h1>{es?"Detrás de las estrellas.":"Behind the stars."}</h1><p>{es?"Sesión de":"Signed in as"} {user.name} · {user.role}</p></div></div><div className="notice" style={{marginBottom:24}}>{es?"Los cambios de roles y contenido se autorizan en el servidor y quedan registrados. El flujo editorial de revisión sigue pendiente.":"Role changes and editorial edits are server-authorized and audited. A review and publishing workflow is still planned."}</div><AdminPanel members={members} content={content} role={user.role} currentUserId={user.id} locale={locale} /></div></main><SiteFooter /></>;
}
