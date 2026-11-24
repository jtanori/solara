export type Role = "owner" | "admin" | "editor" | "user";

export type EmailTokenPurpose = "account_claim" | "email_verification" | "password_reset";

export type Place = {
  name: string;
  latitude: number;
  longitude: number;
  timezone: string;
};

export type ChartInput = {
  name: string;
  birthDate: string;
  birthTime: string;
  birthPlace: Place;
  returnPlace: Place;
  year: number;
  timeChoice?: "earlier" | "later";
};

export type Placement = {
  sign: string;
  longitude: number;
  degree: number;
};

export type ChartResult = {
  exactUtc: string;
  localTime: string;
  natalSun: Placement;
  moon: Placement;
  ascendant: Placement | null;
  sunHouse: number | null;
  houseSystem: "Whole sign";
  warnings: string[];
  engine: string;
};
