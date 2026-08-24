/**
 * Visual-identity preview switch (task #398, phase 1). Two candidate looks live in globals.css as
 * `[data-brand="a"]` ("Ink & teal") and `[data-brand="b"]` ("Graphite & amber") on top of the same
 * `--p-*` tokens dark mode switches through `[data-theme]`. Nothing is applied unless the visitor
 * opts in: `?brand=a|b` in the URL stores the choice in localStorage (`markdoc:brand`); `?brand=off`
 * (or any other value) clears it. The boot script runs before hydration so there is no flash, like
 * the theme one in src/lib/theme.ts. Phase 2 picks one, makes it the default and removes this file.
 */
export type Brand = "a" | "b";

export const BRAND_STORAGE_KEY = "markdoc:brand";
export const BRAND_QUERY_PARAM = "brand";

export function isBrand(value: unknown): value is Brand {
  return value === "a" || value === "b";
}

export const BRAND_BOOT_SCRIPT = `(function(){try{var k=${JSON.stringify(BRAND_STORAGE_KEY)};var q=new URLSearchParams(location.search).get(${JSON.stringify(BRAND_QUERY_PARAM)});var b=q===null?localStorage.getItem(k):q;if(b==="a"||b==="b"){if(q!==null)localStorage.setItem(k,b);document.documentElement.setAttribute("data-brand",b);}else{if(q!==null)localStorage.removeItem(k);document.documentElement.removeAttribute("data-brand");}}catch(e){}})();`;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readBrand(): Brand | null {
  const value = storage()?.getItem(BRAND_STORAGE_KEY);
  return isBrand(value) ? value : null;
}

export function applyBrand(brand: Brand | null) {
  if (typeof document === "undefined") return;
  if (brand) document.documentElement.setAttribute("data-brand", brand);
  else document.documentElement.removeAttribute("data-brand");
}

export function setBrand(brand: Brand | null) {
  const s = storage();
  if (brand) s?.setItem(BRAND_STORAGE_KEY, brand);
  else s?.removeItem(BRAND_STORAGE_KEY);
  applyBrand(brand);
}
