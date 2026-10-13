/**
 * A random id that identifies THIS phone for team sign-in. It is created the first time it is needed and kept in the
 * browser's storage; the server stores only a hash of it. A team member's account is tied to the phone they activated
 * on, so a leaked link or a copied number cannot be used from another device.
 */
const KEY = "2pay:device";

export function getDeviceId(): string {
  try {
    const have = localStorage.getItem(KEY);
    if (have && /^[A-Za-z0-9_-]{16,64}$/.test(have)) return have;
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return "";
  }
}