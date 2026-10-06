// Explicit SrouterDev launcher flag, never NODE_ENV alone. A production build
// remains hidden even if it inherits the dev launcher's environment.
export function developerSettingsAvailable(env = process.env) {
  return env.NODE_ENV !== "production" && env.SROUTER_DEV_MIRROR_REFRESH === "1";
}
