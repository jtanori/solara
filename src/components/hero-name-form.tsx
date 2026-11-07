"use client";
import { ArrowRight } from "lucide-react";
import { useBraveAutofill } from "@/components/use-brave-autofill";
import { personalAutocomplete } from "@/lib/autofill";
import type { Locale } from "@/lib/i18n";

export function HeroNameForm({ locale }: { locale:Locale }) {
  const es=locale==="es"; const limitProfileAutofill=useBraveAutofill();
  return <form name="start-chart" action="/create" method="get" autoComplete="on" className="hero-form"><label className="sr-only" htmlFor="hero-name">{es?"Tu nombre":"Your first name"}</label><input id="hero-name" name="name" type="text" autoComplete={personalAutocomplete("given-name",limitProfileAutofill)} placeholder={es?"Tu nombre":"Your first name"} maxLength={100} /><button className="button button-full" type="submit">{es?"Comenzar mi revolución solar":"Begin my solar return"} <ArrowRight size={17} /></button></form>;
}
