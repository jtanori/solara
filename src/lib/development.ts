// Keep the guide unavailable in production builds, including staging previews.
export function isDevelopmentMode(environment: string | undefined = process.env.NODE_ENV) {
  return environment === "development";
}
