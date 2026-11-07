import Link from "next/link";
import { ArrowUpRight, BookOpen, Sparkles } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { isDevelopmentMode } from "@/lib/development";
import { getLocale } from "@/lib/i18n-server";
import { LanguageSwitcher } from "@/components/language-switcher";

export async function SiteHeader() {
  const [user,locale]=await Promise.all([currentUser(),getLocale()]);const es=locale==="es";const dev=isDevelopmentMode();
  return <header className="site-header"><div className="header-inner"><Link href="/" className="brand" aria-label={es?"Inicio Solara":"Solara home"}><span className="brand-mark">✳</span><span>solara<span className="brand-dot">.</span></span></Link><nav className="main-nav" aria-label={es?"Navegación principal":"Main navigation"}><Link href="/#about">{es?"La experiencia":"The experience"}</Link><Link href="/#how-it-works">{es?"Cómo funciona":"How it works"}</Link><Link href="/pricing">{es?"Planes":"Our plans"}</Link>{dev&&<Link href="/blueprint">{es?"El proyecto":"The blueprint"}</Link>}{dev&&<Link href="/setup">{es?"Configuración":"Setup"}</Link>}{dev&&<Link href="/usage-guide" className="usage-nav-link">{es?"Guía de uso":"Usage guide"}<span>DEV</span></Link>}</nav><div className="header-actions"><LanguageSwitcher locale={locale}/>{user?<Link href="/dashboard" className="header-signin">{es?"Mi cuenta":"My account"}</Link>:<Link href="/account" className="header-signin">{es?"Iniciar sesión":"Sign in"}</Link>}<Link href="/create" className="button button-small">{es?"Crear mi carta":"Start your chart"} <ArrowUpRight size={15}/></Link></div>{dev&&<Link href="/usage-guide" className="mobile-usage-guide" aria-label={es?"Guía de uso (solo desarrollo)":"Usage guide (development only)"}><BookOpen size={19}/></Link>}<Link href={user?"/dashboard":"/account"} className="mobile-account" aria-label={es?"Mi cuenta":"My account"}><Sparkles size={20}/></Link></div></header>;
}
