import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { AuthForm } from "@/components/auth-form";
import { currentUser } from "@/lib/auth";
import { getLocale } from "@/lib/i18n-server";
export default async function AccountPage({ searchParams }: { searchParams: Promise<{next?:string}> }) {
  const [user, locale, params] = await Promise.all([currentUser(),getLocale(),searchParams]); const es=locale==="es";
  const next=params.next; const destination=next?.startsWith("/") && !/^\/[\\/]/.test(next) ? next : "/dashboard";
  if (user) redirect(destination);
  return <><SiteHeader /><main className="auth-layout"><div className="auth-art"><div className="eyebrow">{es ? "UN PEQUEÑO ESPACIO PARA TI" : "A LITTLE SPACE FOR YOU"}</div><h1>{es ? <>Tu próximo capítulo<br /><em>comienza aquí.</em></> : <>Your next chapter<br /><em>starts here.</em></>}</h1><p>{es ? "Guarda tu carta, vuelve a tus reflexiones y haz espacio para las posibilidades." : "Save your chart, return to your reflections, and make a little room for possibility."}</p></div><div className="auth-panel"><AuthForm destination={destination} locale={locale} /></div></main></>;
}
