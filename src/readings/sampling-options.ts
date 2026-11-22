import type { Locale } from "@/lib/i18n";
import { isPaidProfile, PAID_PROFILE, type PaidProfile } from "@/readings/paid-contract";
import { SamplingError } from "@/readings/sampling";

/*
 * Pure CLI contract for the bounded genuine sampling pilot (#103). Kept separate
 * from the script so refusal paths are testable without spawning a process or
 * reading the real environment.
 */

// Per-invocation cap. The pilot total (core + rich) is two explicit
// invocations; a third invocation or a new pilot id is a new authorization.
export const PILOT_HARD_CAP_MICROS = 10_000_000;

export type SamplingCliOptions = {
  pilot: string;
  profile: PaidProfile;
  locale: Locale;
  cases: string[];
  capMicros: number;
  output: string | undefined;
};

const VALUE_FLAGS = new Set(["--pilot", "--profile", "--locale", "--cases", "--max-spend-mxn", "--output"]);

export function parseSamplingOptions(argv: string[], env: Record<string, string | undefined>): SamplingCliOptions {
  if (env.VERCEL || env.NODE_ENV === "production") throw new SamplingError("sampling_authorization_missing");

  const values: Record<string, string> = {};
  let authorize = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--authorize-pilot") {
      if (authorize) throw new SamplingError("sampling_authorization_missing");
      authorize = true;
      continue;
    }
    if (!VALUE_FLAGS.has(arg) || values[arg] !== undefined) throw new SamplingError("sampling_authorization_missing");
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new SamplingError("sampling_authorization_missing");
    values[arg] = value;
    index += 1;
  }
  if (!authorize) throw new SamplingError("sampling_authorization_missing");

  const pilot = values["--pilot"];
  if (!pilot || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(pilot)) throw new SamplingError("sampling_authorization_missing");

  const locale = values["--locale"] ?? "es";
  if (locale !== "es" && locale !== "en") throw new SamplingError("sampling_authorization_missing");

  const cases = [...new Set((values["--cases"] ?? "").split(",").map(value => value.trim()).filter(Boolean))];
  if (cases.length === 0 || cases.some(id => !/^[a-z0-9-]{1,80}$/.test(id))) {
    throw new SamplingError("sampling_authorization_missing");
  }

  const capMxn = Number(values["--max-spend-mxn"]);
  if (!Number.isFinite(capMxn) || capMxn <= 0) throw new SamplingError("sampling_cap_invalid");
  const capMicros = Math.round(capMxn * 1_000_000);
  if (!Number.isSafeInteger(capMicros) || capMicros <= 0 || capMicros > PILOT_HARD_CAP_MICROS) {
    throw new SamplingError("sampling_cap_invalid");
  }

  const envProfile = env.READINGS_PAID_PROFILE;
  const profile = values["--profile"] ?? envProfile ?? PAID_PROFILE;
  if (!isPaidProfile(profile) || (envProfile !== undefined && envProfile !== profile)) {
    throw new SamplingError("sampling_profile_mismatch");
  }

  return { pilot, profile, locale, cases, capMicros, output: values["--output"] };
}
