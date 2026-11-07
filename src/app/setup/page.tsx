import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { SetupGuide } from "@/components/setup-guide";
import { getLocale } from "@/lib/i18n-server";

export default async function SetupPage() {
  const locale=await getLocale();const es=locale==="es";
  return <><SiteHeader /><main className="setup-page"><div className="wrap setup-wrap"><Link href="/blueprint" className="back-link setup-back"><ArrowLeft size={15} /> {es?"Volver al proyecto":"Back to the blueprint"}</Link><div className="setup-hero"><div><div className="eyebrow">✦ &nbsp; {es?"LA GUÍA DE SOLARA":"THE SOLARA PLAYBOOK"}</div><h1>{es?<>De una idea<br /><em>a cada entorno.</em></>:<>From a little idea<br /><em>to every environment.</em></>}</h1><p>{es?"Una guía práctica para configurar cada parte de Solara, desde tu computadora hasta producción.":"A thoughtful, practical guide to setting up every part of Solara—from your computer to production."}</p><div className="setup-hero-meta"><span>✳ &nbsp; {es?"6 GUÍAS":"6 SETUP GUIDES"}</span><span>◇ &nbsp; {es?"3 ENTORNOS":"3 ENVIRONMENTS"}</span><span>⌁ &nbsp; {es?"PASO A PASO":"STEP BY STEP"}</span></div></div><div className="setup-hero-card"><div className="setup-orbit">✳</div><span className="tiny-label">{es?"TU CAMINO AL LANZAMIENTO":"YOUR PATH TO LAUNCH"}</span><div className="setup-path"><div><span>01</span><strong>Local</strong><small>{es?"Construir y explorar":"Build & explore"}</small></div><div><span>02</span><strong>Staging</strong><small>{es?"Probar con seguridad":"Test safely"}</small></div><div><span>03</span><strong>{es?"Producción":"Production"}</strong><small>{es?"Lanzar con cuidado":"Launch thoughtfully"}</small></div></div></div></div><SetupGuide locale={locale} /></div></main><SiteFooter /></>;
}
