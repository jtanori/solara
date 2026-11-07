"use client";
import { useState } from "react";
import { divIcon } from "leaflet";
import { MapContainer, Marker, TileLayer, useMapEvents } from "react-leaflet";
import tzlookup from "tz-lookup";
import type { Place } from "@/lib/types";
import type { Locale } from "@/lib/i18n";

const pin = divIcon({ className:"solara-map-pin", html:"<span></span>", iconSize:[24,24], iconAnchor:[12,12] });
const tileUrl = process.env.NEXT_PUBLIC_MAP_TILE_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
// Provider attribution is plain text; escape it before Leaflet inserts attribution HTML.
const providerAttribution = (process.env.NEXT_PUBLIC_MAP_ATTRIBUTION || "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[char] || char));
const attribution = `&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors${providerAttribution ? ` | ${providerAttribution}` : ""}`;
function MapClick({ onPick }: { onPick: (latitude:number, longitude:number) => void }) {
  useMapEvents({ click(event) { onPick(event.latlng.lat, event.latlng.lng); } });
  return null;
}
export default function MapPicker({ initial, locale, onChoose }: { initial: Place | null; locale: Locale; onChoose: (place:Place) => void }) {
  const es = locale === "es";
  const [selected, setSelected] = useState<Place | null>(initial);
  const [error, setError] = useState("");
  const center: [number,number] = initial ? [initial.latitude, initial.longitude] : [19.4326, -99.1332];
  function pick(latitude:number, longitude:number) {
    try {
      const timezone = tzlookup(latitude, longitude);
      const name = `${es ? "Punto en el mapa" : "Map location"} (${latitude.toFixed(4)}, ${longitude.toFixed(4)})`;
      setSelected({ name, latitude, longitude, timezone }); setError("");
    } catch { setError(es ? "No se pudo determinar la zona horaria para este punto." : "The time zone could not be determined for this point."); }
  }
  return <div className="map-picker"><p className="field-help">{es ? "Haz clic en el mapa para elegir una ubicación. Puedes acercar o mover el mapa." : "Click the map to select a location. You can zoom or move the map."}</p><MapContainer center={center} zoom={initial ? 8 : 4} scrollWheelZoom={false} className="location-map"><TileLayer url={tileUrl} attribution={attribution} /><MapClick onPick={pick} />{selected && <Marker position={[selected.latitude, selected.longitude]} icon={pin} />}</MapContainer>{selected && <div className="selected-place"><span><strong>{selected.name}</strong><br />{selected.timezone}</span></div>}{error && <div className="error" style={{marginTop:8}}>{error}</div>}<p className="field-help">{es ? "Verifica la zona horaria histórica; los límites actuales pueden diferir." : "Check the historical time zone; current geographic boundaries can differ."}</p><button type="button" className="outline-button" style={{marginTop:10, width:"100%"}} disabled={!selected} onClick={() => selected && onChoose(selected)}>{es ? "Usar esta ubicación" : "Use this location"}</button></div>;
}
