/**
 * Brand colours: the single source of truth for the web app. The Android resources (android/app/src/main/res/values/colors.xml)
 * and the icon generator (scripts/make-icons.ps1) must use the same values.
 */
export const BRAND_DARK = "#0B2545"; // company dark blue (document cover pages), used behind the logo in icons
export const BRAND_GREEN = "#00C896"; // logo green
export const APP_BG = "#020617"; // app screen background

/** Current release of the web app. The Android app (android/app/build.gradle versionName, public/downloads/latest.json) only moves when the APK itself changes: V2.7 changed no native code, so it stays 2.6.0. */
export const APP_VERSION = "2.7.0";
export const APP_VERSION_CODE = 17;
