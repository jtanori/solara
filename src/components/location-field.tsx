"use client";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { MapPin } from "lucide-react";
import type { Place } from "@/lib/types";
import type { Locale } from "@/lib/i18n";

const MapPicker = dynamic(() => import("@/components/map-picker"), { ssr:false, loading:() => <div className="map-loading">✧</div> });
export function LocationField({ value, onChange, label, locale, kind }: { value:Place|null; onChange:(place:Place|null)=>void; label:string; locale:Locale; kind:"birth"|"return" }) {
  const es=locale==="es"; const prefix=`${kind}-place`;
  const [query,setQuery]=useState(value?.name??""); const [results,setResults]=useState<Place[]>([]); const [message,setMessage]=useState("");
  const [manual,setManual]=useState(false); const [showMap,setShowMap]=useState(false);
  const [manualName,setManualName]=useState(value?.name??""); const [lat,setLat]=useState(value?.latitude?.toString()??""); const [lon,setLon]=useState(value?.longitude?.toString()??""); const [zone,setZone]=useState(value?.timezone??""); const [manualError,setManualError]=useState("");
  useEffect(()=>{
    if(value||query.trim().length<2)return;
    const controller=new AbortController();
    const timer=setTimeout(async()=>{
      try {
        const response=await fetch(`/api/places?q=${encodeURIComponent(query.trim())}&lang=${locale}`,{signal:controller.signal}); const data=await response.json();
        setResults(data.places??[]);
        setMessage(data.error?(es?"La búsqueda no está disponible. Puedes usar el mapa o introducir coordenadas.":"Location search is unavailable. Use the map or enter coordinates."):((data.places??[]).length?"":(es?"No encontramos lugares. Prueba otra búsqueda o el mapa.":"No locations found. Try another search or use the map.")));
      } catch(error) {if((error as Error).name!=="AbortError")setMessage(es?"La búsqueda no está disponible. Usa el mapa o las coordenadas.":"Location search is unavailable. Use the map or coordinates.");}
    },400);
    return()=>{clearTimeout(timer);controller.abort();};
  },[query,value,locale,es]);
  function choose(place:Place){onChange(place);setQuery(place.name);setResults([]);setMessage("");setManual(false);setShowMap(false);}
  function useManual(){
    const latitude=Number(lat),longitude=Number(lon);let validZone=false;
    try{new Intl.DateTimeFormat("en",{timeZone:zone.trim()});validZone=true;}catch{validZone=false;}
    if(!manualName.trim()||!lat.trim()||!lon.trim()||!Number.isFinite(latitude)||Math.abs(latitude)>90||!Number.isFinite(longitude)||Math.abs(longitude)>180||!validZone){setManualError(es?"Escribe un lugar, coordenadas válidas y una zona horaria IANA (por ejemplo, America/Mexico_City).":"Enter a place, valid coordinates, and an IANA time zone (for example, America/New_York).");return;}
    setManualError("");choose({name:manualName.trim(),latitude,longitude,timezone:zone.trim()});
  }
  return <div><label className="field-label" htmlFor={`${prefix}-search`}>{label}</label><input id={`${prefix}-search`} name={`${kind}PlaceSearch`} type="text" className="field-input" value={query} onChange={event=>{setQuery(event.target.value);onChange(null);setResults([]);setMessage("");}} placeholder={es?"Busca una ciudad":"Search for a city"} autoComplete="off" spellCheck={false} />{!value&&results.length>0&&<div className="location-results">{results.map((place,i)=><button type="button" className="location-result" key={`${place.name}-${i}`} onClick={()=>choose(place)}><MapPin size={13} style={{display:"inline",marginRight:6,color:"#a33f20"}} />{place.name} <span className="muted">· {place.timezone}</span></button>)}</div>}{value&&<div className="selected-place"><MapPin size={15} /><span><strong>{value.name}</strong><br />{value.latitude.toFixed(3)}°, {value.longitude.toFixed(3)}° · {value.timezone}</span></div>}{!value&&message&&<p className="field-help">{message}</p>}<div className="location-actions"><button type="button" className="manual-toggle" onClick={()=>{setShowMap(!showMap);setManual(false);}}>{showMap?(es?"Cerrar mapa":"Close map"):(es?"Elegir en el mapa":"Choose on map")}</button><button type="button" className="manual-toggle" onClick={()=>{setManual(!manual);setShowMap(false);}}>{manual?(es?"Cerrar entrada manual":"Close manual entry"):(es?"Introducir coordenadas":"Enter coordinates")}</button></div>{showMap&&<MapPicker initial={value} locale={locale} onChoose={choose} />}{manual&&<div className="manual-fields"><label className="sr-only" htmlFor={`${prefix}-name`}>{es?"Ciudad o lugar":"City or place name"}</label><input id={`${prefix}-name`} name={`${kind}PlaceName`} type="text" autoComplete="off" className="field-input" placeholder={es?"Ciudad o lugar":"City or place name"} value={manualName} onChange={e=>setManualName(e.target.value)} /><div className="field-grid"><label className="sr-only" htmlFor={`${prefix}-latitude`}>{es?"Latitud":"Latitude"}</label><input id={`${prefix}-latitude`} name={`${kind}Latitude`} autoComplete="off" className="field-input" type="number" step="any" placeholder={es?"Latitud":"Latitude"} value={lat} onChange={e=>setLat(e.target.value)} /><label className="sr-only" htmlFor={`${prefix}-longitude`}>{es?"Longitud":"Longitude"}</label><input id={`${prefix}-longitude`} name={`${kind}Longitude`} autoComplete="off" className="field-input" type="number" step="any" placeholder={es?"Longitud":"Longitude"} value={lon} onChange={e=>setLon(e.target.value)} /></div><label className="sr-only" htmlFor={`${prefix}-timezone`}>{es?"Zona horaria":"Time zone"}</label><input id={`${prefix}-timezone`} name={`${kind}Timezone`} type="text" autoComplete="off" spellCheck={false} className="field-input" placeholder={es?"Zona horaria, ej. America/Mexico_City":"Time zone, e.g. America/New_York"} value={zone} onChange={e=>setZone(e.target.value)} />{manualError&&<div className="error">{manualError}</div>}<button type="button" className="outline-button" onClick={useManual}>{es?"Usar esta ubicación":"Use this location"}</button></div>}</div>;
}
