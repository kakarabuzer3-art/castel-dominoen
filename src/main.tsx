import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

/**
 * Production URL configuration.
 * Set VITE_SITE_URL at build time (e.g. https://play.yourdomain.com);
 * otherwise the app canonicalises itself to the served origin at boot,
 * so deployment never publishes placeholder domains.
 */
function applySiteUrl(): void {
  const env = (import.meta.env.VITE_SITE_URL as string | undefined)?.replace(
    /\/+$/,
    "",
  );
  const site = env && /^https?:\/\//.test(env) ? env : window.location.origin;
  const set = (sel: string, attr: string, val: string) => {
    const n = document.querySelector(sel);
    if (n) n.setAttribute(attr, val);
  };
  set('link[rel="canonical"]', "href", site + "/");
  set('meta[property="og:url"]', "content", site + "/");
  set('meta[property="og:image"]', "content", site + "/og-cover.png");
  set('meta[name="twitter:image"]', "content", site + "/og-cover.png");
  const ld = document.querySelector('script[type="application/ld+json"]');
  if (ld && ld.textContent) {
    try {
      const data = JSON.parse(ld.textContent) as { url?: string; image?: string };
      data.url = site + "/";
      data.image = site + "/og-cover.png";
      ld.textContent = JSON.stringify(data);
    } catch {
      /* keep shipped JSON-LD */
    }
  }
}
applySiteUrl();

const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);
