/**
 * Business categories chosen at registration (a required choice). Stored values: Fuel, Supermarket, Service, Ride, Merchant.
 * `Retail` is what businesses registered before V2.7 have; it stays valid and reads as "Merchant".
 */
export const REGISTRATION_CATEGORIES = ["Fuel", "Supermarket", "Service", "Ride", "Merchant"] as const;
export type RegistrationCategory = (typeof REGISTRATION_CATEGORIES)[number];
export type Category = RegistrationCategory | "Retail";

export const isRegistrationCategory = (v: unknown): v is RegistrationCategory => typeof v === "string" && (REGISTRATION_CATEGORIES as readonly string[]).includes(v);

/** English names, as the person sees them. (The screens translate through the i18n keys auth.type.* and terminal.category.*.) */
export const CATEGORY_LABEL: Record<Category, string> = {
  Fuel: "Fuel Station",
  Supermarket: "Supermarket",
  Service: "Service",
  Ride: "Ride Service",
  Merchant: "Merchant",
  Retail: "Merchant",
};

/** A "Ride Service" registration is an individual driver; everything else is a business. */
export const kindFor = (category: Category): "DRIVER" | "MERCHANT" => (category === "Ride" ? "DRIVER" : "MERCHANT");

/**
 * Advertising is targeted at fuel stations or everyone else (the two groups ad campaigns have always used), so every other
 * category receives the "Retail" group's ads.
 */
export const adTargetFor = (category: string): "Fuel" | "Retail" => (category === "Fuel" ? "Fuel" : "Retail");

/** ISO 18245 merchant category codes for the national QR: fuel 5541, grocery 5411, restaurants 5812, taxis and ride services 4121, other 5999. */
export const MCC_BY_CATEGORY: Record<string, string> = { Fuel: "5541", Retail: "5411", Supermarket: "5411", Service: "5812", Ride: "4121", Merchant: "5999" };
