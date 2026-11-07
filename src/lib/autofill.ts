export type PersonalAutocomplete = "name" | "given-name" | "email" | "bday";

type BraveNavigator = { brave?: { isBrave?: () => boolean | Promise<boolean> } };

/**
 * Temporary mitigation for Brave's reported address-suggestion crash.
 * This is a browser hint, not a guarantee: browsers can ignore autocomplete.
 * No browser information is stored or transmitted.
 */
export async function shouldLimitProfileAutofill(navigatorValue: unknown): Promise<boolean> {
  try {
    if (!navigatorValue || (typeof navigatorValue !== "object" && typeof navigatorValue !== "function")) return true;
    const brave = (navigatorValue as BraveNavigator).brave;
    if (!brave) return false;
    if (typeof brave.isBrave !== "function") return true;
    return Boolean(await brave.isBrave());
  } catch {
    // Fail cautiously if a Brave-like API exists but cannot be evaluated.
    return true;
  }
}

export function personalAutocomplete(token: PersonalAutocomplete, limitProfileAutofill: boolean) {
  return limitProfileAutofill ? "off" : token;
}
