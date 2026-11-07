"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Locale } from "@/lib/i18n";
export function DeleteReading({id,locale}:{id:string;locale:Locale}) {
  const es=locale==="es";const router=useRouter();const [error,setError]=useState("");
  async function remove(){if(!window.confirm(es?"¿Eliminar esta carta guardada? No se puede deshacer.":"Delete this saved chart? This cannot be undone."))return;try{const response=await fetch(`/api/readings/${id}`,{method:"DELETE"});if(!response.ok){setError(es?"No pudimos eliminar esta carta.":"Could not delete this chart.");return;}router.push("/dashboard");router.refresh();}catch{setError(es?"No pudimos eliminar esta carta.":"Could not delete this chart.");}}
  return <div><button className="danger-button" onClick={remove}>{es?"Eliminar esta carta":"Delete this chart"}</button>{error&&<p className="error">{error}</p>}</div>;
}
