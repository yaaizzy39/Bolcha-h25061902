// Utility to call custom GAS translation API endpoints in a round-robin fashion
// GAS endpoint list is provided via `VITE_GAS_ENDPOINTS` (comma-separated URLs)
// Additionally, admin can manage endpoints via Firestore doc `admin/config` field `gasEndpoints`.


const initialEndpoints = (import.meta.env.VITE_GAS_ENDPOINTS as string | undefined)
  ?.split(/[, ]+/)
  .filter(Boolean) || [];

const endpoints: string[] = [...initialEndpoints];

import { db } from "./firebase";
import { doc, onSnapshot } from "firebase/firestore";

let primary = 0;           // index of the preferred endpoint
let failStreak = 0;        // consecutive failures of the current primary
const FAIL_THRESHOLD = 2;  // switch primary after this many consecutive failures

// simple promise queue to ensure only one request at a time
let chain: Promise<any> = Promise.resolve();

// Runtime load of endpoints from Firestore (admin-configurable)
try {
  const cfgRef = doc(db, "admin", "config");
  onSnapshot(cfgRef, (snap) => {
    const data = snap.data();
    if (data && Array.isArray(data.gasEndpoints)) {
      if (data.gasEndpoints.length) {
        endpoints.splice(0, endpoints.length, ...data.gasEndpoints.filter(Boolean));
        console.info("[translation] endpoints updated from Firestore", endpoints);
      } else {
        // empty list ⇒ revert to initial .env endpoints
        endpoints.splice(0, endpoints.length, ...initialEndpoints);
        console.info("[translation] endpoints reset to .env list", endpoints);
      }
      primary = 0;
      failStreak = 0;
    }
  });
} catch {
  // ignore if Firestore not ready
}


// Try translating via one endpoint: POST first, then GET fallback
async function attemptTranslate(
  url: string,
  text: string,
  targetLang: string
): Promise<string | null> {
  try {
    const postRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, target: targetLang }),
    });
    if (postRes.ok) {
      const maybeJson = await safeParse(postRes);
      return handleResult(maybeJson, text);
    }
  } catch {
    // network / CORS errors fall through to GET
  }

  try {
    const params = new URLSearchParams({ text, target: targetLang });
    const getRes = await fetch(`${url}?${params.toString()}`);
    if (getRes.ok) {
      const maybeJson = await safeParse(getRes);
      return handleResult(maybeJson, text);
    }
  } catch {
    // ignore
  }
  return null;
}

async function doTranslate(text: string, targetLang: string): Promise<string | null> {
  if (!endpoints.length) {
    console.warn("No GAS endpoints configured");
    return null;
  }
  // Iterate over endpoints, starting with the current primary, until one succeeds
  for (let i = 0; i < endpoints.length; i++) {
    const idx = (primary + i) % endpoints.length;
    const url = endpoints[idx];

    const maybe = await attemptTranslate(url, text, targetLang);
    if (maybe !== null) {
      // Success → promote this index to be the primary
      primary = idx;
      failStreak = 0;
      return maybe;
    }
  }

  // All endpoints failed this round
  failStreak += 1;
  if (failStreak >= FAIL_THRESHOLD) {
    primary = (primary + 1) % endpoints.length; // shift to next endpoint
    failStreak = 0;
  }
  return null;
}


export function translateText(text: string, targetLang: string): Promise<string | null> {
  const next = chain.then(async () => {
    const res = await doTranslate(text, targetLang);
    // small delay between requests to avoid hitting quota hard
    await new Promise((r) => setTimeout(r, 300));
    return res;
  });
  // update chain but swallow result so the queue never rejects
  chain = next.then(
    () => {},
    () => {}
  );
  return next;
}


function handleResult(maybeJson: string | null, text: string): string | null {
  if (typeof maybeJson === "string") {
    return preserveBlankLines(text, maybeJson);
  }
  return maybeJson;
}

async function safeParse(res: Response): Promise<string | null> {
  try {
    const txt = await res.text();
    if (!txt) return null;
    try {
      const obj = JSON.parse(txt);
      // tolerate different property names
      const raw = obj.translatedText || obj.text || obj.translation || null;
      if (typeof raw === "string") {
        const normalized = raw.replace(/\\n/g, "\n").replace(/<br\s*\/?>/gi, "\n");
        return normalized;
      }
      return raw;
    } catch {
      return txt.replace(/\\n/g, "\n").replace(/<br\s*\/?>/gi, "\n"); // plain text with normalized breaks
    }
  } catch {
    return null;
  }
}

// keep blank-line count same as source
function preserveBlankLines(src: string, dest: string): string {
  const s = src.split("\n");
  const d = dest.split("\n");
  const out: string[] = [];
  let j = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i].trim() === "") {
      out.push("");
      if (d[j]?.trim() === "") j++;
    } else {
      out.push(d[j] ?? "");
      j++;
    }
  }
  while (j < d.length) out.push(d[j++]);
  return out.join("\n");
}
