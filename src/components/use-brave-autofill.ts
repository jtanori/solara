"use client";
import { useEffect, useState } from "react";
import { shouldLimitProfileAutofill } from "@/lib/autofill";

/** Keep the conservative hint until the browser has been identified after hydration. */
export function useBraveAutofill() {
  const [limitProfileAutofill, setLimitProfileAutofill] = useState(true);
  useEffect(() => {
    let mounted = true;
    void shouldLimitProfileAutofill(window.navigator).then(value => {
      if (mounted) setLimitProfileAutofill(value);
    });
    return () => { mounted = false; };
  }, []);
  return limitProfileAutofill;
}
