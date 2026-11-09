"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { useBraveAutofill } from "@/components/use-brave-autofill";
import { personalAutocomplete } from "@/lib/autofill";
import type { Locale } from "@/lib/i18n";

export function AuthForm({ destination, locale }: { destination:string; locale:Locale }) {
  const es=locale==="es"; const router=useRouter(); const limitProfileAutofill=useBraveAutofill();
  const [mode,setMode]=useState<"signup"|"login">("signup"); const [name,setName]=useState(""); const [email,setEmail]=useState(""); const [password,setPassword]=useState(""); const [error,setError]=useState(""); const [loading,setLoading]=useState(false);
  async function submit(event:React.FormEvent<HTMLFormElement>) {
    event.preventDefault();setError("");setLoading(true);
    try {
      const response=await fetch("/api/auth",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode,name,email,password})});
      const data=await response.json();
      if(!response.ok){setError(data.error??(es?"Inténtalo de nuevo.":"Please try again."));setLoading(false);return;}
      router.push(destination);router.refresh();
    } catch {setError(es?"No pudimos conectar. Inténtalo de nuevo.":"Could not connect. Please try again.");setLoading(false);}
  }
  return <div className="auth-box"><div className="eyebrow">{mode==="signup"?(es?"BIENVENIDA A SOLARA":"WELCOME TO SOLARA"):(es?"QUÉ GUSTO VERTE":"WELCOME BACK")}</div><h2>{mode==="signup"?(es?"Un espacio para ti.":"Make a little space."):(es?"Qué bueno verte.":"It’s good to see you.")}</h2><p>{mode==="signup"?(es?"Crea una cuenta gratuita para guardar tu revolución solar y volver cuando quieras.":"Create a free account to save your solar return and come back to it anytime."):(es?"Inicia sesión para continuar tu viaje alrededor del Sol.":"Sign in to continue your journey around the Sun.")}</p><form name={mode} action="/api/auth" method="post" autoComplete="on" onSubmit={submit} className="field-stack">{mode==="signup" && <div><label className="field-label" htmlFor="auth-name">{es?"Tu nombre":"Your name"}</label><input className="field-input" id="auth-name" name="name" type="text" autoComplete={personalAutocomplete("name",limitProfileAutofill)} required maxLength={100} value={name} onChange={e=>setName(e.target.value)} placeholder={es?"¿Cómo te llamas?":"What should we call you?"} /></div>}<div><label className="field-label" htmlFor="auth-email">{es?"Correo electrónico":"Email address"}</label><input className="field-input" id="auth-email" name="email" required type="email" inputMode="email" autoCapitalize="none" spellCheck={false} maxLength={254} value={email} onChange={e=>setEmail(e.target.value)} placeholder={es?"tu@ejemplo.com":"you@example.com"} autoComplete={personalAutocomplete("email",limitProfileAutofill)} /></div><div><label className="field-label" htmlFor="auth-password">{es?"Contraseña":"Password"}</label><input className="field-input" id="auth-password" name="password" required type="password" minLength={10} maxLength={128} value={password} onChange={e=>setPassword(e.target.value)} placeholder={es?"Al menos 10 caracteres":"At least 10 characters"} autoComplete={mode==="signup"?"new-password":"current-password"} /></div>{error && <div className="error" role="alert">{error}</div>}<button type="submit" className="button button-full" disabled={loading}>{loading?(es?"Un momento…":"One moment…"):mode==="signup"?(es?"Crear mi cuenta gratuita":"Create my free account"):(es?"Iniciar sesión":"Sign in")} <ArrowRight size={16} /></button></form><div className="auth-switch">{mode==="signup"?(es?"¿Ya tienes cuenta? ":"Already have an account? "):(es?"¿Eres nueva en Solara? ":"New to Solara? ")}<button type="button" onClick={()=>{setMode(mode==="signup"?"login":"signup");setError("");}}>{mode==="signup"?(es?"Inicia sesión":"Sign in"):(es?"Crear una cuenta":"Create an account")}</button></div><p className="auth-legal">{es?"Revisa tu correo para verificar tu dirección. La recuperación de contraseña y otros controles de seguridad siguen pendientes.":"Check your email to verify your address. Password recovery and additional production security controls are still planned."}</p></div>;
}
