/**
 * Brand colours: the single source of truth for the web app. The Android resources (android/app/src/main/res/values/colors.xml)
 * and the icon generator (scripts/make-icons.ps1) must use the same values.
 */
export const BRAND_DARK = "#0B2545"; // company dark blue (document cover pages), used behind the logo in icons
export const BRAND_GREEN = "#00C896"; // logo green
export const APP_BG = "#020617"; // app screen background

/** Current release. Keep in step with android/app/build.gradle (versionName) and public/downloads/latest.json. */
export const APP_VERSION = "2.6.0";
export const APP_VERSION_CODE = 17;
