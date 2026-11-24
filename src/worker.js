// API de IA para los colmados (Workers AI) + sitio estático.
// /api/despensa  → el cliente manda fotos de su nevera/alacena; sugerimos SOLO productos del colmado.
// /api/inventario → el colmadero manda fotos (o cuadros de un video) de su mercancía; contamos lo que se ve.
// Las fotos no se guardan: se analizan y se descartan.

const MAIN_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const BACKUP_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const MAX_IMAGES = 4;
const MAX_IMAGE_CHARS = 1_500_000; // ~1.1 MB por foto en base64

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function cleanImages(list) {
  if (!Array.isArray(list) || !list.length) throw new Error("Manda al menos una foto.");
  return list.slice(0, MAX_IMAGES).map((s) => {
    if (typeof s !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(s)) throw new Error("Formato de foto no válido.");
    if (s.length > MAX_IMAGE_CHARS) throw new Error("La foto es demasiado grande.");
    return s;
  });
}

function cleanCatalog(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 400).map((p) => ({
    id: String(p.id || "").slice(0, 40),
    n: String(p.n || "").slice(0, 60),
    u: String(p.u || "").slice(0, 30),
    ok: p.ok !== false,
  })).filter((p) => p.id && p.n);
}

function parseJSON(out) {
  if (out && typeof out === "object" && !Array.isArray(out)) {
    if (out.response && typeof out.response === "object") return out.response;
    if (typeof out.response === "string") out = out.response;
    else if (typeof out.result === "string") out = out.result;
    else return out;
  }
  const s = String(out || "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("La IA no devolvió un resultado claro. Prueba con otra foto.");
  return JSON.parse(s.slice(a, b + 1));
}

async function vision(env, system, text, images) {
  try {
    const content = [{ type: "text", text }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))];
    const out = await env.AI.run(MAIN_MODEL, {
      messages: [{ role: "system", content: system }, { role: "user", content }],
      max_tokens: 1500,
      temperature: 0.2,
    });
    return parseJSON(out);
  } catch (e) {
    if (!images.length) throw e;
    // Plan B: modelo de visión de una sola foto (pide aceptar la licencia la primera vez).
    const run = () => env.AI.run(BACKUP_MODEL, {
      messages: [{ role: "system", content: system }, { role: "user", content: text }],
      image: images[0],
      max_tokens: 1500,
    });
    let out;
    try { out = await run(); }
    catch (e2) {
      if (/agree|licen/i.test(String(e2 && e2.message))) { await env.AI.run(BACKUP_MODEL, { prompt: "agree" }); out = await run(); }
      else throw e;
    }
    return parseJSON(out);
  }
}

async function despensa(env, body) {
  const wish = String(body.texto || "").slice(0, 400).trim();
  const images = Array.isArray(body.images) && body.images.length ? cleanImages(body.images) : [];
  if (!images.length && !wish) throw new Error("Toma una foto o dime qué te falta.");
  const catalog = cleanCatalog(body.catalog).filter((p) => p.ok);
  if (!catalog.length) throw new Error("El colmado no tiene productos disponibles ahora.");
  const healthy = !!body.sano;
  const system = "Eres el ayudante de un colmado dominicano. Hablas español sencillo, cálido y respetuoso. Respondes SOLO con JSON válido, sin texto extra.";
  const text = [
    images.length ? "Estas fotos son de la nevera, la alacena o las gavetas de un cliente." : "El cliente no mandó fotos: guíate solo por lo que dice. Deja frescos vacío.",
    "1) Mira qué come normalmente, sin juzgar.",
    "2) Sugiere lo que le falta o se le está acabando, usando SOLO productos de este catálogo (usa su id). Máximo 8.",
    "3) Nunca menciones supermercados ni otras tiendas. Si algo no está en el catálogo, no lo sugieras.",
    healthy ? "4) El cliente quiere comer un poco más sano: entre las opciones del catálogo, prioriza las más sanas. Sin números, sin calorías, sin dietas." : "4) Respeta sus gustos tal como son.",
    "5) Para los alimentos frescos que se vean (frutas, vegetales, carnes, pescado, lácteos, pan, comida guardada), da los días máximos orientativos para comerlos, siendo prudente.",
    wish ? `El cliente dice: «${wish}». Tenlo en cuenta primero.` : "",
    "Catálogo (id | producto | unidad):",
    ...catalog.map((p) => `${p.id} | ${p.n} | ${p.u}`),
    'Formato exacto: {"resumen":"1 o 2 frases","sugerencias":[{"id":"...","por_que":"frase corta"}],"frescos":[{"producto":"...","dias":2,"consejo":"frase corta"}]}',
  ].filter(Boolean).join("\n");
  const r = await vision(env, system, text, images);
  const ids = new Set(catalog.map((p) => p.id));
  const seen = new Set();
  return {
    resumen: String(r.resumen || "").slice(0, 400),
    sugerencias: (Array.isArray(r.sugerencias) ? r.sugerencias : [])
      .filter((s) => s && ids.has(String(s.id)) && !seen.has(String(s.id)) && seen.add(String(s.id)))
      .slice(0, 8)
      .map((s) => ({ id: String(s.id), por_que: String(s.por_que || "").slice(0, 160) })),
    frescos: (Array.isArray(r.frescos) ? r.frescos : []).slice(0, 10).map((f) => ({
      producto: String(f.producto || "").slice(0, 60),
      dias: Math.max(0, Math.min(30, Math.round(Number(f.dias) || 0))),
      consejo: String(f.consejo || "").slice(0, 160),
    })).filter((f) => f.producto),
  };
}

async function inventario(env, body) {
  const images = cleanImages(body.images);
  const catalog = cleanCatalog(body.catalog);
  const system = "Eres el ayudante de inventario de un colmado dominicano. Cuentas mercancía en fotos de estantes, neveras, cajas y pacas. Respondes SOLO con JSON válido, sin texto extra.";
  const text = [
    "Cuenta las unidades que se ven de cada producto. Si varias fotos muestran el mismo estante, no cuentes dos veces lo mismo.",
    "Relaciona cada producto con este catálogo (usa su id). Si ves algo que no está en el catálogo, ponlo con id null.",
    "Si no se puede contar bien (tapado, borroso, cajas cerradas), pon seguro:false y estima con prudencia. No inventes productos que no se ven.",
    "Catálogo (id | producto | unidad):",
    ...catalog.map((p) => `${p.id} | ${p.n} | ${p.u}`),
    'Formato exacto: {"items":[{"id":"p1","nombre":"Arroz","cantidad":12,"seguro":true}],"nota":"frase corta"}',
  ].join("\n");
  const r = await vision(env, system, text, images);
  const ids = new Set(catalog.map((p) => p.id));
  return {
    nota: String(r.nota || "").slice(0, 300),
    items: (Array.isArray(r.items) ? r.items : []).slice(0, 80).map((i) => ({
      id: ids.has(String(i.id)) ? String(i.id) : null,
      nombre: String(i.nombre || "").slice(0, 60),
      cantidad: Math.max(0, Math.min(9999, Math.round(Number(i.cantidad) || 0))),
      seguro: i.seguro !== false,
    })).filter((i) => i.nombre || i.id),
  };
}


// ---------- Tiendas reales (pilotos) ----------
// Datos guardados en KV (binding TIENDAS). Solo el dueño, con su PIN, puede leer el fiao/ventas y guardar cambios.
const REG = {"los-muchachos": {"name": "Colmado Los Muchachos", "barrio": "Bella Vista, Santo Domingo", "h": "4c9c7bb8c8b52fcc47ebc8371c3a4460cb1c4d2773851a5e557becfa0a5f39b4", "wa": "809-530-4923"}, "victoria": {"name": "Colmado Victoria", "barrio": "Bella Vista, Santo Domingo", "h": "1f1e3cc2803b2561ca37cb263ba0cd8abc5e5c82b17b3c4b10b23b9211d175d8", "wa": "809-535-5055"}};
const PUBLIC_KEYS = ["name","barrio","address","hours","open","delivery","fee","wa","voice","products","iceAmts"];
async function sha(s){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("")}
async function checkPin(slug,pin){const r=REG[slug];if(!r)return false;return (await sha(`kolmado:${slug}:${String(pin||"")}`))===r.h}
const slugOf=(s)=>String(s||"").toLowerCase().replace(/[^a-z0-9-]/g,"").slice(0,60);
async function tiendas(request, env, url){
  if(!env.TIENDAS) throw new Error("Almacenamiento no disponible.");
  if(url.pathname==="/api/tienda" && request.method==="GET"){
    const slug=slugOf(url.searchParams.get("c"));
    if(!REG[slug]) return json({error:"Colmado no encontrado."},404);
    const doc=await env.TIENDAS.get("t:"+slug,"json");
    const pub={};if(doc)PUBLIC_KEYS.forEach(k=>{if(doc[k]!==undefined)pub[k]=doc[k]});
    return json({exists:!!doc,reg:{name:REG[slug].name,barrio:REG[slug].barrio,wa:REG[slug].wa||""},data:doc?pub:null});
  }
  if(url.pathname==="/api/panel" && request.method==="POST"){
    const body=await request.json().catch(()=>({}));
    const slug=slugOf(body.c);
    if(!(await checkPin(slug,body.pin))) return json({error:"PIN incorrecto."},401);
    if(body.data===undefined){const doc=await env.TIENDAS.get("t:"+slug,"json");return json({ok:true,data:doc})}
    const raw=JSON.stringify(body.data||{});
    if(raw.length>8_000_000) throw new Error("Demasiadas fotos: borra algunas e intenta otra vez.");
    const data=JSON.parse(raw);delete data.pin;
    await env.TIENDAS.put("t:"+slug,JSON.stringify(data));
    return json({ok:true});
  }
  return json({error:"Ruta no encontrada."},404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/tienda" || url.pathname === "/api/panel") {
      try { return await tiendas(request, env, url); }
      catch (e) { return json({ error: String((e && e.message) || e).slice(0, 200) }, 400); }
    }
    if (url.pathname.startsWith("/api/")) {
      if (request.method !== "POST") return json({ error: "Usa POST." }, 405);
      if (!env.AI) return json({ error: "La IA no está conectada todavía." }, 503);
      try {
        const body = await request.json();
        if (url.pathname === "/api/despensa") return json(await despensa(env, body));
        if (url.pathname === "/api/inventario") return json(await inventario(env, body));
        return json({ error: "No existe." }, 404);
      } catch (e) {
        return json({ error: String((e && e.message) || e).slice(0, 200) }, 400);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
