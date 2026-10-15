"use client";

import { apiUrl, installApiBase } from "@/lib/api-base";

// Runs when the page's code loads, before any screen asks for data.
installApiBase();

/** Mounted once in the root layout. Renders nothing; its job is the line above. */
export function ApiBase() {
  return null;
}

export { apiUrl };
