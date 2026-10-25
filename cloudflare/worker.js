// gdzieponiesie.pl — pośrednik do OpenRouteService (Cloudflare Worker), wersja 15
// v27: własna baza ok. 20 tys. miejscowości z GeoNames (polskie nazwy), ORS tylko gdy w bazie nic nie ma.
// v26: ok. 450 miast i miejscowości turystycznych Europy w słowniku nazw.
// v25: tylko miejscowości (bez ulic i miejsc), ok. 250 polskich nazw miast Europy.
// v24: wyszukiwanie miejsc: polskie nazwy miast (Londyn, Ateny…), najpierw miejscowości bez ulic i stacji, etykiety po polsku.
// v23: więcej granic (m.in. Serbia–Macedonia, Macedonia–Grecja, Albania, Ukraina) – 42 kierunki co 3 h.
// v22: paliwo porcjami (8 krajów na uruchomienie, każdy raz na dobę), pomijanie krajów bez danych (404), 2 s odstępu.
// v21: /reverse (nazwy miejsc noclegów), więcej serwerów Overpass, krótsze limity czasu.
// v20: /poi (kempingi i miejsca dla kamperów przy noclegach) i /poi/lpg (stacje LPG wzdłuż trasy) z OpenStreetMap (Overpass), cache 7 dni.
// v19: wysokości punktów (elevation) do profilu trasy.
// v18: radiuses 5 km – punkty w porcie lub przy wodzie nie kończą się błędem „nie znaleziono drogi”.
// v17: cron pilnuje odstępów sam (kolejki min. co 3 h, paliwo raz na dobę ok. 4:00 UTC) – częstszy cron nic nie zmienia;
//      blokada przed dwoma uruchomieniami naraz; liczniki zapytań w /nk/status.
// v16: nakordoni.eu odpytywane WYŁĄCZNIE z crona (Cron Trigger) – zapytania użytkowników czytają tylko KV.
//      Paliwo raz na dobę, kolejki co 3 h. Wymaga powiązania KV o nazwie NK (patrz README).
// v15: kampery powyżej 3,5 t przyjmowane (trasa nadal profilem osobowym – lepszy do wstępnego planowania),
//      omijanie promów, odcinki promowe i płatne
//      w odpowiedzi, Węgry zawsze D2, kolejki na granicach z nakordoni.eu (/border).
// Jedno zapytanie = jeden wariant trasy, żeby wolna trasa nie blokowała pozostałych.
// Sekret w ustawieniach Workera: ORS_API_KEY

import MIASTA from './miasta.json';   // baza miejscowości z GeoNames (scripts/geonames.py)

const ORS_URL = 'https://api.openrouteservice.org/v2/directions/driving-car/geojson';
const ORS_URL_HGV = 'https://api.openrouteservice.org/v2/directions/driving-hgv/geojson';
const ALLOWED_ORIGINS = ['https://gdzieponiesie.pl', 'https://www.gdzieponiesie.pl'];
const CACHE_SECONDS = 6 * 3600;
const CACHE_VERSION = 'v27';
const GEOCODE_URL = 'https://api.openrouteservice.org/geocode/autocomplete';
const GEOCODE_CACHE_SECONDS = 24 * 3600;
const ORS_TIMEOUT_MS = 40000;

// Kalibracja czasu dla profilu osobowego ORS. Wartość startowa 1,1 (kamper jedzie wolniej niż osobówka),
// do sprawdzenia z czasami Google na kilku trasach (Kraków–Split w Google: 12 h 20 min).
const TIME_FACTOR = 1.1;

// Warianty trasy. Każdy to osobne zapytanie do ORS, wołane osobno przez stronę.
const VARIANTS = {
  fast: { title: 'Najszybsza', preference: 'fastest', tolls: true },
  shortest: { title: 'Najkrótsza', preference: 'shortest', tolls: true },
  free: { title: 'Bez opłat', preference: 'fastest', tolls: false },
};

// ---- Szacunkowe opłaty dla kampera do 3,5 t (klasa osobowa). Do zastąpienia tabelą z panelu admina. ----
const EUR_PLN = 4.25; // kurs awaryjny; normalnie bierzemy kurs średni NBP
// Awaryjne ceny paliwa (zł/l), gdy nakordoni.eu jest niedostępne: średnie z Polski z 20.10.2026 (API nakordoni.eu).
const FUEL_DEFAULTS_PLN = { diesel: 7.96, petrol: 6.98, lpg: 3.5 };
const FUEL_TYPES = new Set(['diesel', 'petrol', 'lpg']);
const FUEL_CACHE_SECONDS = 12 * 3600;
const FUEL_DOWN_SECONDS = 15 * 60; // po błędzie nie męczymy API przez 15 minut
const FX_CACHE_SECONDS = 12 * 3600;
// Kursy awaryjne (zł za 1 jednostkę), gdy NBP nie odpowiada. BAM, RSD i MKD liczone z EUR (stały lub stabilny kurs).
const FX_FALLBACK = { PLN: 1, EUR: 4.25, CZK: 0.175, HUF: 0.0108, RON: 0.85, CHF: 4.5, GBP: 4.95, DKK: 0.57, SEK: 0.385, NOK: 0.363 };
const EUR_PER = { BAM: 1.95583, RSD: 117.2, MKD: 61.5 }; // ile jednostek waluty za 1 EUR
// Winiety: cena najtańszej opcji na ok. 10 dni. Waluta lokalna przeliczana kursem NBP, reszta w EUR.
// HU: 10-dniowa winieta 2026 według kategorii z dowodu rejestracyjnego (D1: do 7 miejsc, M1, do 3,5 t; D2: pozostałe,
// m.in. N1 i powyżej 7 miejsc). D1 z NÚSZ, D2 z serwisów odsprzedaży (do weryfikacji na nemzetiutdij.hu).
const VIGNETTES = {
  AT: { eur: 12.8 },
  CZ: { cur: 'CZK', amount: 300 },
  SK: { eur: 10.8 },
  HU: { cur: 'HUF', D1: 6900, D2: 10040 },
  SI: { eur: 16 },
  BG: { eur: 10 },
  RO: { eur: 6 },
  CH: { cur: 'CHF', amount: 40 },
};
const HU_CATEGORIES = new Set(['D1', 'D2']);
// Opłaty za kilometr odcinka płatnego, w EUR/km.
const PER_KM = { HR: 0.09, IT: 0.085, FR: 0.15 };
// Kraje płatne, których nie wyceniamy (np. PL, ES, PT, GR), trafiają do listy "unpriced".

// ---- Granice. Stan na lato 2026; kontrole czasowe zmieniają się często, więc UI odsyła do listy Komisji. ----
// Państwa strefy Schengen (od 1.01.2025 Bułgaria i Rumunia także na granicach lądowych).
const SCHENGEN = new Set(['AT', 'BE', 'BG', 'CH', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IS',
  'IT', 'LI', 'LT', 'LU', 'LV', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK']);
const OPEN_MICROSTATES = new Set(['MC', 'SM', 'VA']); // granice de facto otwarte
const OUTSIDE_EU_CUSTOMS = new Set(['CH', 'LI', 'NO', 'IS']); // Schengen, ale poza unią celną
// Kraje, które w 2026 przywróciły kontrole na części granic wewnętrznych (lipiec 2026, do weryfikacji).
const CONTROLS_2026 = new Set(['DE', 'AT', 'DK', 'FR', 'IT', 'NO', 'NL', 'PL', 'SI', 'SE', 'CH']);

const isOpen = (c) => SCHENGEN.has(c) || OPEN_MICROSTATES.has(c);

function crossingKind(a, b) {
  if (!isOpen(a) || !isOpen(b)) return 'external';
  if (OUTSIDE_EU_CUSTOMS.has(a) !== OUTSIDE_EU_CUSTOMS.has(b)) return 'customs';
  return 'internal';
}

function makeCrossing(from, to, atKm, point) {
  const kind = crossingKind(from, to);
  return {
    from, to, at_km: Math.round(atKm), kind,
    at: [Math.round(point[0] * 1e4) / 1e4, Math.round(point[1] * 1e4) / 1e4],
    outside: kind === 'external' ? [from, to].filter((c) => !isOpen(c)) : [],
    controls: kind !== 'external' && (CONTROLS_2026.has(from) || CONTROLS_2026.has(to)),
  };
}

// Identyfikatory krajów ORS (countryinfo) -> kody ISO. Nieznane zostają jako "#id".
const COUNTRIES = {
  2: 'AL', 4: 'AD', 11: 'AT', 16: 'BY', 17: 'BE', 23: 'BA', 30: 'BG', 49: 'HR', 51: 'CY',
  52: 'CZ', 53: 'DK', 63: 'EE', 69: 'FI', 70: 'FR', 74: 'DE', 75: 'DE', 78: 'GR', 88: 'HU',
  89: 'IS', 94: 'IE', 97: 'IT', 106: 'XK', 110: 'LV', 115: 'LI', 116: 'LT', 117: 'LU',
  118: 'MK', 124: 'MT', 129: 'MD', 130: 'MC', 132: 'ME', 141: 'NL', 148: 'NO', 159: 'PL',
  160: 'PT', 162: 'RO', 163: 'RU', 171: 'SM', 175: 'RS', 179: 'SK', 180: 'SI', 187: 'ES',
  192: 'SE', 193: 'CH', 200: 'NL', 206: 'TR', 211: 'UA', 213: 'GB', 218: 'VA', 228: 'SI',
  231: 'GR',
};

// Kody ISO -> identyfikator ORS do opcji avoid_countries.
const ISO_TO_ID = {
  AL: 2, AD: 4, AT: 11, BY: 16, BE: 17, BA: 23, BG: 30, HR: 49, CY: 51, CZ: 52, DK: 53,
  EE: 63, FI: 69, FR: 70, DE: 74, GR: 78, HU: 88, IS: 89, IE: 94, IT: 97, XK: 106, LV: 110,
  LI: 115, LT: 116, LU: 117, MK: 118, MT: 124, MD: 129, MC: 130, ME: 132, NL: 200, NO: 148,
  PL: 159, PT: 160, RO: 162, RU: 163, SM: 171, RS: 175, SK: 179, SI: 180, ES: 187, SE: 192,
  CH: 193, TR: 206, UA: 211, GB: 213, VA: 218,
};

export default {
  // Cron Trigger: ustaw w Cloudflare „0 */3 * * *” (co 3 godziny).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runNakordoniCron(env, new Date(event.scheduledTime)));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === '/nk/status' && request.method === 'GET') {
        return json(await nkStatus(env), 200, cors);
      }
      if (url.pathname === '/health') {
        return json({ ok: true, ors_key: Boolean(env.ORS_API_KEY), version: CACHE_VERSION }, 200, cors);
      }
      if (url.pathname === '/nk/probe' && request.method === 'GET') {
        if (!ALLOWED_ORIGINS.includes(origin)) {
          return json({ error: 'Ta strona nie ma dostępu do API.' }, 403, cors);
        }
        return await handleNakordoniProbe(url, env, cors);
      }
      if (url.pathname === '/border' && request.method === 'GET') {
        if (!ALLOWED_ORIGINS.includes(origin)) {
          return json({ error: 'Ta strona nie ma dostępu do API.' }, 403, cors);
        }
        return await handleBorder(url, env, cors);
      }
      if (url.pathname === '/poi' && request.method === 'GET') {
        if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: 'Ta strona nie ma dostępu do API.' }, 403, cors);
        return await handlePoiNear(url, cors);
      }
      if (url.pathname === '/reverse' && request.method === 'GET') {
        if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: 'Ta strona nie ma dostępu do API.' }, 403, cors);
        return await handleReverse(url, env, cors);
      }
      if (url.pathname === '/poi/lpg' && request.method === 'POST') {
        if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: 'Ta strona nie ma dostępu do API.' }, 403, cors);
        return await handlePoiLpg(request, cors);
      }
      if (url.pathname === '/geocode' && request.method === 'GET') {
        if (!ALLOWED_ORIGINS.includes(origin)) {
          return json({ error: 'Ta strona nie ma dostępu do API.' }, 403, cors);
        }
        return await handleGeocode(url, env, cors);
      }
      if (url.pathname === '/route' && request.method === 'POST') {
        if (!ALLOWED_ORIGINS.includes(origin)) {
          return json({ error: 'Ta strona nie ma dostępu do API.' }, 403, cors);
        }
        return await handleRoute(request, env, cors);
      }
      return json({ error: 'Nie ma takiego adresu.' }, 404, cors);
    } catch (e) {
      return json({ error: 'Błąd Workera: ' + e.message }, 500, cors);
    }
  },
};

function corsHeaders(origin) {
  const h = {
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (ALLOWED_ORIGINS.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(obj, status, cors, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors, ...extra },
  });
}

function isPoint(p) {
  return Array.isArray(p) && p.length === 2 &&
    typeof p[0] === 'number' && typeof p[1] === 'number' &&
    p[0] >= -25 && p[0] <= 45 && p[1] >= 30 && p[1] <= 72; // Europa
}

function clampNum(v, min, max, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- Diagnostyka API nakordoni.eu (tymczasowa) ----
// Pokazuje prawdziwą odpowiedź API (przycięte listy), żeby zbudować integrację na faktycznych danych.
// Sekret w ustawieniach Workera: NAKORDONI_KEY
const NK_BASE = 'https://nakordoni.eu';

// Numery krajów w API nakordoni.eu (lista z Sandboxa, 20.10.2026).
const NK_COUNTRY_IDS = {
  UA: 1, PL: 2, SK: 3, HU: 4, RO: 5, MD: 6, BY: 7, LT: 8, LV: 9, SI: 11, BG: 12, RS: 13, TR: 14,
  MK: 15, HR: 16, BA: 17, DE: 18, GR: 19, IT: 20, AL: 21, ME: 22, XK: 23,
};

// Ścieżka kolejek na granicy: "HU>RS" (kierunek jazdy), "HU>RS/4" (z typem) albo "4/13/4". Typ 4 = samochód.
function nkBorderPath(param, version) {
  let m = /^([A-Z]{2})>([A-Z]{2})(?:\/(\d{1,2}))?$/.exec(param);
  if (m) {
    const o = NK_COUNTRY_IDS[m[1]], d = NK_COUNTRY_IDS[m[2]];
    if (!o || !d) return null;
    return '/api/' + version + '/data/border/' + o + '/' + d + '/' + (m[3] || 4) + '?lang=en';
  }
  m = /^(\d{1,3})\/(\d{1,3})\/(\d{1,2})$/.exec(param);
  return m ? '/api/' + version + '/data/border/' + param + '?lang=en' : null;
}

function nkPath(what, param) {
  if (what === 'border4') return nkBorderPath(param, 'v4');
  if (what === 'checkpoints') return '/api/v1/data/checkpoints?lang=en';
  if (what === 'search' && /^[\p{L}\p{N} ,.'-]{2,60}$/u.test(param)) return '/api/v1/data/search?lang=en&name=' + encodeURIComponent(param);
  if (what === 'update-info' && /^id_\d{1,6}$/.test(param)) return '/api/v1/data/update-info?ppid=' + param;
  if (what === 'queue' && /^id_\d{1,6}$/.test(param)) return '/api/v1/data/queue?ppid=' + param;
  if (what === 'border' && /^(\d{1,3}|all)\/(\d{1,3}(,\d{1,3})*|all)\/\d{1,2}$/.test(param)) return '/api/v2/data/border/' + param + '?lang=en';
  return null;
}

// Przycina listy i długie teksty, żeby odpowiedź dało się wkleić do czatu.
function trimForProbe(v, depth = 0) {
  if (Array.isArray(v)) {
    const out = v.slice(0, 3).map((x) => trimForProbe(x, depth + 1));
    if (v.length > 3) out.push('… i ' + (v.length - 3) + ' kolejnych (łącznie ' + v.length + ')');
    return out;
  }
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trimForProbe(x, depth + 1)]));
  }
  if (typeof v === 'string' && v.length > 200) return v.slice(0, 200) + '…';
  return v;
}

// Zamienia HTML na czytelny tekst (bez skryptów, stylów i znaczników).
function visibleText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

// Wyciąga z HTML-a strony blokady Cloudflare tytuł, kod błędu i Ray ID.
function describeCloudflareBlock(html) {
  if (!/cloudflare/i.test(html)) return null;
  const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || null;
  const code = (html.match(/Error(?: code)?\s*(\d{3,4})/i) || [])[1] || null;
  const ray = (html.match(/Ray ID:\s*(?:<[^>]*>\s*)*([0-9a-f]{10,})/i) || [])[1] || null;
  const heading = visibleText((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '') || null;
  return { title, heading, error_code: code, ray_id: ray };
}

// Zdejmuje spacje, znaki nowej linii i cudzysłowy, które łatwo wkleić razem z kluczem.
function cleanNakordoniKey(raw) {
  return String(raw || '').trim().replace(/^["']+|["']+$/g, '').trim();
}

// Klucz gotowy do użycia albo null, gdy go brak lub ma zły format (złych kluczy nie wysyłamy).
function nakordoniKey(env) {
  const key = cleanNakordoniKey(env.NAKORDONI_KEY);
  return /^NKD-[A-Za-z0-9-]{6,}$/.test(key) ? key : null;
}

async function handleNakordoniProbe(url, env, cors) {
  const key = cleanNakordoniKey(env.NAKORDONI_KEY);
  if (!key) {
    return json({ error: 'Worker nie ma sekretu NAKORDONI_KEY. Dodaj go w Settings → Variables and Secrets.' }, 500, cors);
  }
  // nakordoni.eu blokuje nieznane adresy IP już po 2 błędnych kluczach, więc złego klucza nie wysyłamy wcale.
  if (!/^NKD-[A-Za-z0-9-]{6,}$/.test(key)) {
    return json({ error: 'Sekret NAKORDONI_KEY ma niepoprawny format (klucz zaczyna się od NKD-). Nie wysłano zapytania, żeby nie zużywać prób: nakordoni.eu blokuje nieznane adresy IP po 2 błędnych kluczach. Wklej klucz jeszcze raz, bez cudzysłowów i spacji.' }, 500, cors);
  }
  const what = url.searchParams.get('what') || '';
  const param = (url.searchParams.get('param') || '').trim();
  const path = nkPath(what, param);
  if (!path) {
    return json({ error: 'Niepoprawny rodzaj zapytania albo parametr. Dozwolone: checkpoints, search (nazwa), update-info i queue (ppid, np. id_13), border (np. 2/4/4), border4 (np. HU>RS).' }, 400, cors);
  }

  let res;
  try {
    res = await fetch(NK_BASE + path, {
      headers: {
        Authorization: 'Bearer ' + key,
        Accept: 'application/json',
        'User-Agent': 'gdzieponiesie.pl/1.0 (+https://gdzieponiesie.pl; planer tras kamperem)',
      },
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    return json({ error: 'nakordoni.eu nie odpowiedziało: ' + e.message }, 504, cors);
  }

  const text = await res.text();
  let body;
  let isJson = true;
  try { body = trimForProbe(JSON.parse(text)); } catch { isJson = false; body = visibleText(text).slice(0, 700); }
  return json({
    path, http: res.status, json: isJson,
    content_type: res.headers.get('content-type'),
    headers: {
      cf_mitigated: res.headers.get('cf-mitigated'),
      cf_ray: res.headers.get('cf-ray'),
      server: res.headers.get('server'),
      retry_after: res.headers.get('retry-after'),
    },
    cloudflare_block: isJson ? null : describeCloudflareBlock(text),
    body,
  }, 200, cors);
}

// Kody krajów z geokodera (ISO 3166-1 alfa-3) -> kody ISO używane w reszcie planera.
const ISO3_TO_ISO2 = {
  ALB: 'AL', AND: 'AD', AUT: 'AT', BLR: 'BY', BEL: 'BE', BIH: 'BA', BGR: 'BG', HRV: 'HR', CYP: 'CY',
  CZE: 'CZ', DNK: 'DK', EST: 'EE', FIN: 'FI', FRA: 'FR', DEU: 'DE', GRC: 'GR', HUN: 'HU', ISL: 'IS',
  IRL: 'IE', ITA: 'IT', XKX: 'XK', LVA: 'LV', LIE: 'LI', LTU: 'LT', LUX: 'LU', MKD: 'MK', MLT: 'MT',
  MDA: 'MD', MCO: 'MC', MNE: 'ME', NLD: 'NL', NOR: 'NO', POL: 'PL', PRT: 'PT', ROU: 'RO', RUS: 'RU',
  SMR: 'SM', SRB: 'RS', SVK: 'SK', SVN: 'SI', ESP: 'ES', SWE: 'SE', CHE: 'CH', TUR: 'TR', UKR: 'UA',
  GBR: 'GB', VAT: 'VA',
};

// Podpowiedzi adresów: ORS (Pelias) przez Workera, z zapamiętywaniem na 24 h.
// Polskie nazwy miast Europy → nazwa w geokoderze (bez polskich znaków w kluczu). [szukana, wyświetlana]
const EXONYMS = Object.fromEntries(Object.entries({
  'Londyn': 'London', 'Edynburg': 'Edinburgh', 'Dublin': 'Dublin', 'Dover': 'Dover', 'Bruksela': 'Bruxelles',
  'Antwerpia': 'Antwerpen', 'Brugia': 'Brugge', 'Gandawa': 'Gent', 'Haga': 'Den Haag', 'Luksemburg': 'Luxembourg',
  'Paryż': 'Paris', 'Marsylia': 'Marseille', 'Nicea': 'Nice', 'Strasburg': 'Strasbourg', 'Tuluza': 'Toulouse',
  'Awinion': 'Avignon', 'Orlean': 'Orléans', 'Lille': 'Lille', 'Rouen': 'Rouen', 'Nantes': 'Nantes',
  'Reims': 'Reims', 'Metz': 'Metz', 'Grenoble': 'Grenoble', 'Dijon': 'Dijon', 'Calais': 'Calais',
  'Madryt': 'Madrid', 'Sewilla': 'Sevilla', 'Walencja': 'València', 'Saragossa': 'Zaragoza', 'Kordoba': 'Córdoba',
  'Grenada': 'Granada', 'Kadyks': 'Cádiz', 'Malaga': 'Málaga', 'Barcelona': 'Barcelona', 'Bilbao': 'Bilbao',
  'San Sebastian': 'Donostia', 'Lizbona': 'Lisboa', 'Porto': 'Porto', 'Koimbra': 'Coimbra', 'Faro': 'Faro',
  'Monachium': 'München', 'Kolonia': 'Köln', 'Akwizgran': 'Aachen', 'Norymberga': 'Nürnberg', 'Lipsk': 'Leipzig',
  'Drezno': 'Dresden', 'Ratyzbona': 'Regensburg', 'Pasawa': 'Passau', 'Moguncja': 'Mainz', 'Brema': 'Bremen',
  'Hanower': 'Hannover', 'Brunszwik': 'Braunschweig', 'Getynga': 'Göttingen', 'Trewir': 'Trier', 'Koblencja': 'Koblenz',
  'Fryburg': 'Freiburg im Breisgau', 'Frankfurt nad Menem': 'Frankfurt am Main', 'Frankfurt nad Odrą': 'Frankfurt (Oder)', 'Lubeka': 'Lübeck', 'Kilonia': 'Kiel',
  'Szlezwik': 'Schleswig', 'Berlin': 'Berlin', 'Hamburg': 'Hamburg', 'Rostock': 'Rostock', 'Stuttgart': 'Stuttgart',
  'Augsburg': 'Augsburg', 'Budziszyn': 'Bautzen', 'Chociebuż': 'Cottbus', 'Poczdam': 'Potsdam', 'Genewa': 'Genève',
  'Zurych': 'Zürich', 'Bazylea': 'Basel', 'Berno': 'Bern', 'Lozanna': 'Lausanne', 'Lucerna': 'Luzern',
  'Lugano': 'Lugano', 'Wiedeń': 'Wien', 'Grac': 'Graz', 'Salzburg': 'Salzburg', 'Innsbruck': 'Innsbruck',
  'Klagenfurt': 'Klagenfurt', 'Linz': 'Linz', 'Rzym': 'Roma', 'Mediolan': 'Milano', 'Wenecja': 'Venezia',
  'Neapol': 'Napoli', 'Florencja': 'Firenze', 'Turyn': 'Torino', 'Genua': 'Genova', 'Bolonia': 'Bologna',
  'Werona': 'Verona', 'Piza': 'Pisa', 'Padwa': 'Padova', 'Triest': 'Trieste', 'Trydent': 'Trento',
  'Bozen': 'Bolzano', 'Mesyna': 'Messina', 'Ankona': 'Ancona', 'Rawenna': 'Ravenna', 'Mantua': 'Mantova',
  'Lukka': 'Lucca', 'Asyż': 'Assisi', 'Bari': 'Bari', 'Palermo': 'Palermo', 'Rimini': 'Rimini',
  'Kopenhaga': 'København', 'Sztokholm': 'Stockholm', 'Goteborg': 'Göteborg', 'Malmo': 'Malmö', 'Uppsala': 'Uppsala',
  'Oslo': 'Oslo', 'Bergen': 'Bergen', 'Stavanger': 'Stavanger', 'Trondheim': 'Trondheim', 'Tromso': 'Tromsø',
  'Odense': 'Odense', 'Aarhus': 'Aarhus', 'Helsinki': 'Helsinki', 'Wilno': 'Vilnius', 'Kowno': 'Kaunas',
  'Kłajpeda': 'Klaipėda', 'Ryga': 'Riga', 'Tallin': 'Tallinn', 'Parnawa': 'Pärnu', 'Tartu': 'Tartu',
  'Praga': 'Praha', 'Brno': 'Brno', 'Ołomuniec': 'Olomouc', 'Ostrawa': 'Ostrava', 'Pilzno': 'Plzeň',
  'Karlowe Wary': 'Karlovy Vary', 'Czeskie Budziejowice': 'České Budějovice', 'Hradec Kralowe': 'Hradec Králové', 'Bratysława': 'Bratislava', 'Koszyce': 'Košice',
  'Żylina': 'Žilina', 'Preszów': 'Prešov', 'Bańska Bystrzyca': 'Banská Bystrica', 'Trenczyn': 'Trenčín', 'Poprad': 'Poprad',
  'Nitra': 'Nitra', 'Budapeszt': 'Budapest', 'Segedyn': 'Szeged', 'Debreczyn': 'Debrecen', 'Pecz': 'Pécs',
  'Egier': 'Eger', 'Siofok': 'Siófok', 'Lublana': 'Ljubljana', 'Maribor': 'Maribor', 'Bled': 'Bled',
  'Piran': 'Piran', 'Koper': 'Koper', 'Zagrzeb': 'Zagreb', 'Rijeka': 'Rijeka', 'Zadar': 'Zadar',
  'Szybenik': 'Šibenik', 'Split': 'Split', 'Trogir': 'Trogir', 'Makarska': 'Makarska', 'Omisz': 'Omiš',
  'Dubrownik': 'Dubrovnik', 'Pula': 'Pula', 'Rowinj': 'Rovinj', 'Porecz': 'Poreč', 'Sarajewo': 'Sarajevo',
  'Mostar': 'Mostar', 'Banja Luka': 'Banja Luka', 'Medziugorie': 'Međugorje', 'Belgrad': 'Beograd', 'Nowy Sad': 'Novi Sad',
  'Nisz': 'Niš', 'Kragujewac': 'Kragujevac', 'Subotica': 'Subotica', 'Nowy Pazar': 'Novi Pazar', 'Podgorica': 'Podgorica',
  'Kotor': 'Kotor', 'Budwa': 'Budva', 'Herceg Nowi': 'Herceg Novi', 'Ulcinj': 'Ulcinj', 'Bar': 'Bar',
  'Cetynia': 'Cetinje', 'Żabljak': 'Žabljak', 'Prisztina': 'Prishtinë', 'Prizren': 'Prizren', 'Tirana': 'Tirana',
  'Durres': 'Durrës', 'Szkodra': 'Shkodër', 'Wlora': 'Vlorë', 'Saranda': 'Sarandë', 'Gjirokastra': 'Gjirokastër',
  'Berat': 'Berat', 'Skopje': 'Skopje', 'Ochryda': 'Ohrid', 'Bitola': 'Bitola', 'Struga': 'Struga',
  'Ateny': 'Athens', 'Saloniki': 'Thessaloniki', 'Kawala': 'Kavala', 'Wolos': 'Volos', 'Larisa': 'Larissa',
  'Joanina': 'Ioannina', 'Patras': 'Patra', 'Kalamata': 'Kalamata', 'Korynt': 'Korinthos', 'Nauplion': 'Nafplio',
  'Igumenitsa': 'Igoumenitsa', 'Delfy': 'Delfoi', 'Kalambaka': 'Kalabaka', 'Parga': 'Parga', 'Lamia': 'Lamia',
  'Heraklion': 'Irakleio', 'Sofia': 'Sofia', 'Warna': 'Varna', 'Burgas': 'Burgas', 'Płowdiw': 'Plovdiv',
  'Wielkie Tyrnowo': 'Veliko Tarnovo', 'Ruse': 'Ruse', 'Słoneczny Brzeg': 'Slanchev Bryag', 'Złote Piaski': 'Zlatni Pyasatsi', 'Nesebyr': 'Nesebar',
  'Bukareszt': 'București', 'Kluż': 'Cluj-Napoca', 'Konstanca': 'Constanța', 'Braszów': 'Brașov', 'Sybin': 'Sibiu',
  'Jassy': 'Iași', 'Timiszoara': 'Timișoara', 'Oradea': 'Oradea', 'Sighișoara': 'Sighișoara', 'Stambuł': 'İstanbul',
  'Adrianopol': 'Edirne', 'Edirne': 'Edirne', 'Smyrna': 'İzmir', 'Izmir': 'İzmir', 'Ankara': 'Ankara',
  'Antalya': 'Antalya', 'Kiszyniów': 'Chișinău', 'Lwów': 'Lviv', 'Kijów': 'Kyiv', 'Odessa': 'Odesa',
  'Użhorod': 'Uzhhorod', 'Czerniowce': 'Chernivtsi', 'Opatija': 'Opatija', 'Krk': 'Krk', 'Hvar': 'Hvar',
  'Korczula': 'Korčula', 'Bol': 'Bol', 'Supetar': 'Supetar', 'Biograd na Moru': 'Biograd na Moru', 'Vodice': 'Vodice',
  'Primošten': 'Primošten', 'Baška Voda': 'Baška Voda', 'Tučepi': 'Tučepi', 'Podgora': 'Podgora', 'Brela': 'Brela',
  'Cavtat': 'Cavtat', 'Ston': 'Ston', 'Plitwice': 'Plitvička Jezera', 'Nin': 'Nin', 'Novalja': 'Novalja',
  'Senj': 'Senj', 'Crikvenica': 'Crikvenica', 'Umag': 'Umag', 'Novigrad': 'Novigrad', 'Labin': 'Labin',
  'Rab': 'Rab', 'Bohinj': 'Bohinjska Bistrica', 'Postojna': 'Postojna', 'Kranjska Gora': 'Kranjska Gora', 'Portorož': 'Portorož',
  'Izola': 'Izola', 'Tivat': 'Tivat', 'Petrowac': 'Petrovac', 'Sveti Stefan': 'Sveti Stefan', 'Virpazar': 'Virpazar',
  'Ksamil': 'Ksamil', 'Himara': 'Himarë', 'Pogradec': 'Pogradec', 'Korcza': 'Korçë', 'Meteory': 'Kalabaka',
  'Olimpia': 'Archaia Olympia', 'Mykeny': 'Mykines', 'Epidaur': 'Epidavros', 'Sparta': 'Sparti', 'Monemwazja': 'Monemvasia',
  'Pireus': 'Peiraias', 'Katerini': 'Katerini', 'Litochoro': 'Litochoro', 'Neos Marmaras': 'Neos Marmaras', 'Platamonas': 'Platamonas',
  'Sarti': 'Sarti', 'Korfu': 'Kerkyra', 'Lefkada': 'Lefkada', 'Preweza': 'Preveza', 'Nafpaktos': 'Nafpaktos',
  'Galaksidi': 'Galaxidi', 'Areopoli': 'Areopoli', 'Gythio': 'Gytheio', 'Chania': 'Chania', 'Retimno': 'Rethymno',
  'Riva del Garda': 'Riva del Garda', 'Sirmione': 'Sirmione', 'Desenzano': 'Desenzano del Garda', 'Malcesine': 'Malcesine', 'Bardolino': 'Bardolino',
  'Lazise': 'Lazise', 'Limone sul Garda': 'Limone sul Garda', 'Como': 'Como', 'Bellagio': 'Bellagio', 'Stresa': 'Stresa',
  'Verbania': 'Verbania', 'Monterosso': 'Monterosso al Mare', 'La Spezia': 'La Spezia', 'Sorrento': 'Sorrento', 'Amalfi': 'Amalfi',
  'Positano': 'Positano', 'Salerno': 'Salerno', 'Pompeje': 'Pompei', 'Tropea': 'Tropea', 'Taormina': 'Taormina',
  'Katania': 'Catania', 'Syrakuzy': 'Siracusa', 'Agrygent': 'Agrigento', 'Lecce': 'Lecce', 'Alberobello': 'Alberobello',
  'Matera': 'Matera', 'Caorle': 'Caorle', 'Bibione': 'Bibione', 'Lignano': 'Lignano Sabbiadoro', 'Jesolo': 'Jesolo',
  'Chioggia': 'Chioggia', 'Orvieto': 'Orvieto', 'San Gimignano': 'San Gimignano', 'Livorno': 'Livorno', 'Viareggio': 'Viareggio',
  'Akwileja': 'Aquileia', 'Udine': 'Udine', 'Meran': 'Merano', 'Siena': 'Siena', 'Hallstatt': 'Hallstatt',
  'Zell am See': 'Zell am See', 'Bad Gastein': 'Bad Gastein', 'Villach': 'Villach', 'Lienz': 'Lienz', 'Kitzbühel': 'Kitzbühel',
  'Mayrhofen': 'Mayrhofen', 'Sölden': 'Sölden', 'Bad Ischl': 'Bad Ischl', 'Sankt Wolfgang': 'Sankt Wolfgang im Salzkammergut', 'Berchtesgaden': 'Berchtesgaden',
  'Garmisch-Partenkirchen': 'Garmisch-Partenkirchen', 'Füssen': 'Füssen', 'Lindau': 'Lindau', 'Konstancja': 'Konstanz', 'Heidelberg': 'Heidelberg',
  'Rothenburg': 'Rothenburg ob der Tauber', 'Bamberga': 'Bamberg', 'Wirzburg': 'Würzburg', 'Binz': 'Binz', 'Sassnitz': 'Sassnitz',
  'Stralsund': 'Stralsund', 'Warnemünde': 'Warnemünde', 'Heringsdorf': 'Heringsdorf', 'Ahlbeck': 'Ahlbeck', 'Interlaken': 'Interlaken',
  'Zermatt': 'Zermatt', 'Grindelwald': 'Grindelwald', 'Montreux': 'Montreux', 'Sankt Moritz': 'St. Moritz', 'Annecy': 'Annecy',
  'Chamonix': 'Chamonix-Mont-Blanc', 'Carcassonne': 'Carcassonne', 'Arles': 'Arles', 'Nimes': 'Nîmes', 'Biarritz': 'Biarritz',
  'La Rochelle': 'La Rochelle', 'Saint-Malo': 'Saint-Malo', 'Mont-Saint-Michel': 'Le Mont-Saint-Michel', 'Kolmar': 'Colmar', 'Cannes': 'Cannes',
  'Antibes': 'Antibes', 'Menton': 'Menton', 'Monako': 'Monaco', 'Saint-Tropez': 'Saint-Tropez', 'Ajaccio': 'Ajaccio',
  'Benidorm': 'Benidorm', 'Alicante': 'Alicante', 'Tarragona': 'Tarragona', 'Salou': 'Salou', 'Lloret de Mar': 'Lloret de Mar',
  'Toledo': 'Toledo', 'Segowia': 'Segovia', 'Salamanka': 'Salamanca', 'Gibraltar': 'Gibraltar', 'Marbella': 'Marbella',
  'Ronda': 'Ronda', 'Lagos': 'Lagos', 'Albufeira': 'Albufeira', 'Sintra': 'Sintra', 'Nazare': 'Nazaré',
  'Fatima': 'Fátima', 'Evora': 'Évora', 'Czeski Krumlow': 'Český Krumlov', 'Kutna Hora': 'Kutná Hora', 'Mariańskie Łaźnie': 'Mariánské Lázně',
  'Liberec': 'Liberec', 'Szpindlerowy Młyn': 'Špindlerův Mlýn', 'Stary Smokowiec': 'Starý Smokovec', 'Lewocza': 'Levoča', 'Bardiów': 'Bardejov',
  'Liptowski Mikułasz': 'Liptovský Mikuláš', 'Hévíz': 'Hévíz', 'Keszthely': 'Keszthely', 'Tihany': 'Tihany', 'Szentendre': 'Szentendre',
  'Wyszehrad': 'Visegrád', 'Ostrzyhom': 'Esztergom', 'Tokaj': 'Tokaj', 'Miszkolc': 'Miskolc', 'Sozopol': 'Sozopol',
  'Bansko': 'Bansko', 'Bałczik': 'Balchik', 'Pomorie': 'Pomorie', 'Mamaja': 'Mamaia', 'Suczawa': 'Suceava',
  'Sinaia': 'Sinaia', 'Bran': 'Bran', 'Amsterdam': 'Amsterdam', 'Rotterdam': 'Rotterdam', 'Utrecht': 'Utrecht',
  'Maastricht': 'Maastricht', 'Lowanium': 'Leuven', 'Ostenda': 'Oostende', 'Dinant': 'Dinant', 'Alesund': 'Ålesund',
  'Geiranger': 'Geiranger', 'Flam': 'Flåm', 'Svolvaer': 'Svolvær', 'Kristiansand': 'Kristiansand', 'Larvik': 'Larvik',
  'Visby': 'Visby', 'Kalmar': 'Kalmar', 'Ystad': 'Ystad', 'Karlskrona': 'Karlskrona', 'Kiruna': 'Kiruna',
  'Skagen': 'Skagen', 'Ribe': 'Ribe', 'Esbjerg': 'Esbjerg', 'Hirtshals': 'Hirtshals', 'Troki': 'Trakai',
  'Połąga': 'Palanga', 'Jurmała': 'Jūrmala', 'Turku': 'Turku', 'Rovaniemi': 'Rovaniemi', 'Goreme': 'Göreme',
  'Kapadocja': 'Göreme', 'Efez': 'Selçuk', 'Bodrum': 'Bodrum', 'Fethiye': 'Fethiye', 'Marmaris': 'Marmaris',
  'Kusadasi': 'Kuşadası',
}).map(([pl, local]) => [pl.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l'), [local, pl]]));

const KRAJ_PL = { AD: 'Andora', AL: 'Albania', AT: 'Austria', BA: 'Bośnia i Hercegowina', BE: 'Belgia', BG: 'Bułgaria', BY: 'Białoruś',
  CH: 'Szwajcaria', CY: 'Cypr', CZ: 'Czechy', DE: 'Niemcy', DK: 'Dania', EE: 'Estonia', ES: 'Hiszpania', FI: 'Finlandia', FR: 'Francja',
  GB: 'Wielka Brytania', GE: 'Gruzja', GI: 'Gibraltar', GR: 'Grecja', HR: 'Chorwacja', HU: 'Węgry', IE: 'Irlandia', IS: 'Islandia', IT: 'Włochy',
  LI: 'Liechtenstein', LT: 'Litwa', LU: 'Luksemburg', LV: 'Łotwa', MC: 'Monako', MD: 'Mołdawia', ME: 'Czarnogóra', MK: 'Macedonia Północna',
  MT: 'Malta', NL: 'Holandia', NO: 'Norwegia', PL: 'Polska', PT: 'Portugalia', RO: 'Rumunia', RS: 'Serbia', SE: 'Szwecja', SI: 'Słowenia',
  SK: 'Słowacja', SM: 'San Marino', TR: 'Turcja', UA: 'Ukraina', VA: 'Watykan', XK: 'Kosowo' };
const foldName = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').replace(/ß/g, 'ss');

// indeks miejscowości budowany raz na instancję Workera
let CITY_IDX = null;
function cityIndex() {
  if (CITY_IDX) return CITY_IDX;
  // polska nazwa → nazwa lokalna ze słownika (np. Wiedeń → Wien), żeby działało też „Wien”
  const exLocalByPl = {}, exPlByLocal = {};
  for (const [, [local, pl]] of Object.entries(EXONYMS)) { exLocalByPl[foldName(pl)] = local; exPlByLocal[foldName(local)] = pl; }
  CITY_IDX = MIASTA.miasta.map(([name, pl, ascii, lat, lon, cc, pop]) => {
    const plName = pl || exPlByLocal[foldName(name)] || exPlByLocal[foldName(ascii || name)] || '';
    const keys = new Set([name, pl, ascii, plName, exLocalByPl[foldName(plName)] || ''].filter(Boolean).map(foldName));
    return { name, pl: plName, lat, lon, cc, pop, keys: [...keys] };
  });
  return CITY_IDX;
}
function searchCities(q) {
  const fq = foldName(q.trim());
  if (fq.length < 2) return [];
  const hits = [];
  for (const c of cityIndex()) {
    let s = 0;
    for (const k of c.keys) {
      if (k === fq) { s = 3; break; }
      if (k.startsWith(fq)) s = Math.max(s, 2);
      else if (s < 1 && (k.includes(' ' + fq) || k.includes('-' + fq))) s = 1;
    }
    if (s) hits.push([s, c]);
  }
  hits.sort((a, b) => b[0] - a[0] || b[1].pop - a[1].pop);
  return hits.slice(0, 6).map(([, c]) => {
    const shown = c.pl || c.name;
    return { name: shown, label: shown + (c.pl && foldName(c.pl) !== foldName(c.name) ? ' (' + c.name + ')' : '') + ', ' + (KRAJ_PL[c.cc] || c.cc),
      lon: c.lon, lat: c.lat, country: c.cc };
  });
}

async function handleGeocode(url, env, cors) {
  if (!env.ORS_API_KEY) {
    return json({ error: 'Worker nie ma sekretu ORS_API_KEY.' }, 500, cors);
  }
  const q = (url.searchParams.get('q') || '').replace(/\s+/g, ' ').trim();
  if (q.length < 3 || q.length > 80) {
    return json({ error: 'Wpisz od 3 do 80 znaków.' }, 400, cors);
  }

  const cacheKey = new Request('https://cache.gdzieponiesie.internal/geo/' + await sha256('g5|' + q.toLowerCase()));
  const cached = await caches.default.match(cacheKey);
  if (cached) return json(await cached.json(), 200, cors, { 'X-Cache': 'HIT' });

  // 0) własna baza miejscowości (GeoNames): polskie i oryginalne nazwy, duże miasta na górze
  const local = searchCities(q);
  if (local.length) return json({ results: local, source: 'geonames' }, 200, cors, { 'X-Source': 'geonames' });

  // 1) polskie nazwy miast (Londyn, Ateny, Wiedeń…) → nazwa, którą zna geokoder
  const fold = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l');
  const ex = EXONYMS[fold(q)] || (fold(q).length >= 5 ? Object.entries(EXONYMS).find(([k]) => k.startsWith(fold(q)))?.[1] : null);
  const text = ex ? ex[0] : q;

  const ask = async (layers, txt = text) => {
    const params = new URLSearchParams({
      api_key: env.ORS_API_KEY, text: txt, size: '8', lang: 'pl',
      'boundary.rect.min_lon': '-25', 'boundary.rect.min_lat': '30', 'boundary.rect.max_lon': '45', 'boundary.rect.max_lat': '72',
    });
    if (layers) params.set('layers', layers);
    const res = await fetch(GEOCODE_URL + '?' + params, { signal: AbortSignal.timeout(8000) });
    if (res.status === 429) throw Object.assign(new Error('Limit wyszukiwań adresów wyczerpany. Spróbuj później.'), { code: 429 });
    if (!res.ok) throw Object.assign(new Error('Wyszukiwarka adresów zwróciła błąd (' + res.status + ').'), { code: 502 });
    return (await res.json()).features || [];
  };

  // 2) najpierw miejscowości i regiony (bez ulic, sklepów i stacji), dopiero potem wszystko
  let feats;
  try {
    // tylko miejscowości (miasta, wsie, gminy) – bez ulic, sklepów, stacji i regionów
    const COARSE = 'locality,localadmin';
    feats = await ask(COARSE);
    if (ex) feats = feats.concat(await ask(COARSE, q));   // np. „Praga” – także dzielnica Warszawy
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return json({ error: 'Wyszukiwarka adresów nie odpowiedziała. Spróbuj ponownie.' }, 504, cors);
    return json({ error: e.message }, e.code || 502, cors);
  }

  const seen = new Set();
  const results = [];
  for (const f of feats) {
    const [lon, lat] = f.geometry?.coordinates || [];
    let label = f.properties?.label;
    if (typeof lon !== 'number' || typeof lat !== 'number' || !label || seen.has(label)) continue;
    seen.add(label);
    // znana polska nazwa miasta na początku etykiety (Ateny, Grecja zamiast Athens, Greece)
    if (ex && results.length === 0 && ['locality', 'localadmin', 'borough'].includes(f.properties?.layer)) label = ex[1] + ', ' + label.split(', ').slice(1).join(', ');
    results.push({ label, lon: Math.round(lon * 1e5) / 1e5, lat: Math.round(lat * 1e5) / 1e5, country: ISO3_TO_ISO2[f.properties?.country_a] || null });
    if (results.length >= 6) break;
  }

  const body = { results };
  await caches.default.put(cacheKey, new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=' + GEOCODE_CACHE_SECONDS },
  }));
  return json(body, 200, cors, { 'X-Cache': 'MISS' });
}

async function handleRoute(request, env, cors) {
  if (!env.ORS_API_KEY) {
    return json({ error: 'Worker nie ma sekretu ORS_API_KEY.' }, 500, cors);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Niepoprawny JSON.' }, 400, cors); }

  const via = Array.isArray(body.via) ? body.via : [];
  const points = [body.from, ...via, body.to];
  if (points.length > 8 || !points.every(isPoint)) {
    return json({ error: 'Punkty muszą być w formacie [długość, szerokość], w Europie, maks. 8.' }, 400, cors);
  }

  // Zawsze profil osobowy ORS – w testach sprawdzał się lepiej niż ciężarowy przy wstępnym planowaniu.
  // Masa powyżej 3,5 t jest przyjmowana; inne opłaty dla cięższych kamperów liczy strona.
  // Żeby wrócić do profilu ciężarowego, ustaw USE_HGV = true.
  const USE_HGV = false;
  const weight = clampNum(body.camper?.weight, 1, 18, 3.5);
  const heavy = USE_HGV && weight > 3.5;
  const dims = heavy ? {
    weight: Math.round(weight * 10) / 10,
    height: clampNum(body.camper?.height, 2, 4.5, 3.2),
    length: clampNum(body.camper?.length, 4, 18, 8),
    width: clampNum(body.camper?.width, 1.8, 2.6, 2.35),
  } : null;
  const fuel = {
    l100: clampNum(body.fuel?.l100, 4, 30, 10),
    type: FUEL_TYPES.has(body.fuel?.type) ? body.fuel.type : 'diesel',
  };

  // Węgry: kamper zawsze D2 (polskie dowody nie mają pola J – za D1 grozi mandat).
  const huCategory = 'D2';

  const variantId = body.variant;
  const variant = Object.prototype.hasOwnProperty.call(VARIANTS, variantId) ? VARIANTS[variantId] : null;
  if (!variant) {
    return json({ error: 'Nieznany wariant trasy (fast, shortest albo free).' }, 400, cors);
  }

  const o = body.options || {};
  const avoidHighways = o.avoid_highways === true;
  const avoidFerries = o.avoid_ferries === true;
  const avoidCountries = Array.isArray(o.avoid_countries) ? [...new Set(o.avoid_countries)].sort() : [];
  if (avoidCountries.length > 10 || !avoidCountries.every((k) => typeof k === 'string' && ISO_TO_ID[k])) {
    return json({ error: 'Niepoprawna lista krajów do ominięcia (maks. 10, kody ISO, np. AT, SK).' }, 400, cors);
  }

  // W cache trzymamy samą trasę. Koszt zależy od paliwa, więc liczymy go przy każdej odpowiedzi.
  const cacheKey = new Request('https://cache.gdzieponiesie.internal/route/' + await sha256(JSON.stringify({
    v: CACHE_VERSION, variantId, points, avoidHighways, avoidFerries, avoidCountries, dims,
  })));
  let route;
  let hit = false;
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    route = await cached.json();
    hit = true;
  } else {
    const res = await orsRoute(buildPayload(variant, { points, avoidHighways, avoidFerries, avoidCountries, dims }), env, heavy);
    if (!res.ok) return json({ error: res.error }, res.status || 502, cors);
    // profil ciężarowy ma już wolniejsze prędkości, więc bez dodatkowego mnożnika
    route = { id: variantId, title: variant.title, profile: heavy ? 'hgv' : 'car', ...summarize(res.data, heavy ? 1 : TIME_FACTOR) };
    await caches.default.put(cacheKey, new Response(JSON.stringify(route), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=' + CACHE_SECONDS },
    }));
  }

  const [fx, fuelData] = await Promise.all([getFx(), getFuelPrices(Object.keys(route.countries), env)]);
  const cost = estimateCost(route, fuel, fx, fuelData, huCategory);
  return json({
    ...route, cost,
    fuel: { type: fuel.type, source: cost.fuel_source, updated: cost.fuel_updated, fx_source: fx.source },
    options: { avoid_highways: avoidHighways, avoid_ferries: avoidFerries, avoid_countries: avoidCountries },
  }, 200, cors, { 'X-Cache': hit ? 'HIT' : 'MISS' });
}

function buildPayload(variant, { points, avoidHighways, avoidFerries, avoidCountries, dims }) {
  const options = {};
  if (dims) {
    options.vehicle_type = 'hgv';
    options.profile_params = { restrictions: dims };
  }
  if (avoidCountries.length) options.avoid_countries = avoidCountries.map((k) => ISO_TO_ID[k]);
  const features = [];
  if (avoidHighways) features.push('highways');
  if (avoidFerries) features.push('ferries');
  if (!variant.tolls) features.push('tollways');
  if (features.length) options.avoid_features = features;

  const payload = {
    coordinates: points,
    // promień „przyciągania” punktu do drogi: porty promowe i punkty z geokodera często leżą kilkaset metrów od drogi
    radiuses: points.map(() => 5000),
    preference: variant.preference,
    extra_info: ['tollways', 'countryinfo', 'waycategory'],
    elevation: true, // wysokości punktów – do wykresu profilu trasy
  };
  if (Object.keys(options).length) payload.options = options;
  return payload;
}

async function orsRoute(payload, env, heavy = false) {
  // Jedno ponowienie po timeoucie, błędzie sieci albo błędzie 5xx. Błędy 4xx są ostateczne.
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    last = await orsOnce(payload, env, heavy ? ORS_URL_HGV : ORS_URL);
    if (last.ok || !last.retry) return last;
  }
  return last;
}

async function orsOnce(payload, env, endpoint = ORS_URL) {
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: env.ORS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/geo+json, application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ORS_TIMEOUT_MS),
    });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || /timeout|aborted/i.test(String(e.message)));
    return {
      ok: false, status: 504, retry: true,
      error: timeout
        ? 'ORS nie zdążył policzyć tej trasy (publiczny serwer jest wolny). Spróbuj ponownie albo zmień ustawienia.'
        : 'ORS nie odpowiedział: ' + e.message,
    };
  }

  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* zostaje null */ }

  if (res.status === 429) return { ok: false, status: 429, error: 'Limit zapytań ORS wyczerpany. Spróbuj później.' };
  if (res.status === 404) {
    return { ok: false, status: 404, error: 'Nie znaleziono trasy przy tych ograniczeniach. Odznacz część omijanych krajów albo autostrad.' };
  }
  if (!res.ok || !data?.features?.[0]) {
    const msg = data?.error?.message || (typeof data?.error === 'string' ? data.error : text.slice(0, 300));
    return { ok: false, status: 502, retry: res.status >= 500, error: `ORS odpowiedział kodem ${res.status}: ${msg}` };
  }
  return { ok: true, data };
}

// Zamienia kwotę w walucie kraju na złote.
function toPln(value, currency, fx) {
  if (typeof value !== 'number' || !(value > 0) || !currency) return null;
  const rate = fx.rates[currency.toUpperCase()];
  return rate ? value * rate : null;
}

function estimateCost(r, fuel, fx, fuelData, huCategory = 'D2') {
  // Paliwo liczymy osobno dla każdego kraju: litry z km w kraju razy lokalna cena (po przeliczeniu na zł).
  const liveCountries = fuelData.byCountry;
  const livePrices = [];
  for (const code of Object.keys(r.countries)) {
    const p = livePrice(liveCountries[code], fuel.type, fx);
    if (p !== null) livePrices.push(p);
  }
  const avgLive = livePrices.length ? livePrices.reduce((a, b) => a + b, 0) / livePrices.length : null;
  const fallbackPrice = avgLive ?? FUEL_DEFAULTS_PLN[fuel.type];

  let fuelPln = 0, liveKm = 0, totalKm = 0;
  const fuelByCountry = {};
  for (const [code, km] of Object.entries(r.countries)) {
    const live = livePrice(liveCountries[code], fuel.type, fx);
    const price = live ?? fallbackPrice;
    const pln = (km * fuel.l100 / 100) * price;
    fuelPln += pln;
    fuelByCountry[code] = { pln: Math.round(pln), price: Math.round(price * 100) / 100, live: live !== null };
    totalKm += km;
    if (live !== null) liveKm += km;
  }
  const source = liveKm === 0 ? 'fallback' : (liveKm >= totalKm * 0.999 ? 'live' : 'mixed');
  const updatedDates = Object.values(liveCountries).map((c) => c?.updated).filter(Boolean).sort();

  const byCountry = {};
  const unpriced = [];
  let tollsPln = 0;
  for (const [code, km] of Object.entries(r.toll_by_country)) {
    let pln = null;
    const v = VIGNETTES[code];
    if (v) {
      if (v.eur !== undefined) pln = v.eur * fx.rates.EUR;
      else {
        const amount = code === 'HU' ? v[huCategory] : v.amount;
        pln = toPln(amount, v.cur, fx);
      }
    } else if (PER_KM[code] !== undefined) {
      pln = km * PER_KM[code] * fx.rates.EUR;
    }
    if (pln === null) { unpriced.push(code); continue; }
    tollsPln += pln;
    byCountry[code] = Math.round(pln);
  }
  return {
    fuel_pln: Math.round(fuelPln),
    tolls_pln: Math.round(tollsPln),
    total_pln: Math.round(fuelPln + tollsPln),
    tolls_by_country_pln: byCountry,
    fuel_by_country: fuelByCountry,
    fuel_source: source,
    fuel_updated: updatedDates.length ? updatedDates[updatedDates.length - 1] : null,
    unpriced,
  };
}

// Cena wybranego paliwa w zł/l dla kraju z danych API (albo null, gdy brak).
function livePrice(c, type, fx) {
  if (!c) return null;
  const local = toPln(c[type], c.currency, fx);
  if (local !== null) return local;
  if (type === 'lpg' && typeof c.lpg_eur === 'number' && c.lpg_eur > 0) return c.lpg_eur * fx.rates.EUR;
  return null;
}

// ---- Kursy walut z NBP (tabela A, średnie kursy w zł) ----
async function getFx() {
  const key = new Request('https://cache.gdzieponiesie.internal/fx/nbp-a');
  const cached = await caches.default.match(key);
  if (cached) return await cached.json();

  let fx = { source: 'fallback', rates: { ...FX_FALLBACK } };
  try {
    const res = await fetch('https://api.nbp.pl/api/exchangerates/tables/A/?format=json', {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const table = (await res.json())?.[0];
      const rates = { PLN: 1 };
      for (const r of table?.rates || []) if (r.code && r.mid > 0) rates[r.code] = r.mid;
      if (rates.EUR) {
        for (const [cur, perEur] of Object.entries(EUR_PER)) rates[cur] = rates.EUR / perEur;
        fx = { source: 'nbp', date: table.effectiveDate || null, rates: { ...FX_FALLBACK, ...rates } };
      }
    }
  } catch { /* zostają kursy awaryjne */ }
  for (const [cur, perEur] of Object.entries(EUR_PER)) fx.rates[cur] ??= fx.rates.EUR / perEur;

  await caches.default.put(key, new Response(JSON.stringify(fx), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=' + (fx.source === 'nbp' ? FX_CACHE_SECONDS : 600) },
  }));
  return fx;
}

// ---- Ceny paliwa: tylko odczyt z KV (zapisuje je cron raz na dobę) ----
let fuelMem = null, fuelMemAt = 0;
async function getFuelPrices(codes, env) {
  if (!env.NK) return { byCountry: {} };
  if (!fuelMem || Date.now() - fuelMemAt > 10 * 60 * 1000) {
    fuelMem = (await env.NK.get('fuel', 'json')) || { byCountry: {} };
    fuelMemAt = Date.now();
  }
  const byCountry = {};
  for (const c of new Set(codes)) if (fuelMem.byCountry?.[c]) byCountry[c] = fuelMem.byCountry[c];
  return { byCountry };
}

function haversineKm(a, b) {
  const r = 6371, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

function roundSorted(map) {
  return Object.fromEntries(
    Object.entries(map).map(([k, v]) => [k, Math.round(v)]).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1])
  );
}

function summarize(geo, timeFactor) {
  const f = geo.features[0];
  const coords = f.geometry.coordinates;
  const p = f.properties;
  const n = Math.max(coords.length - 1, 0);

  // Kraj i płatność każdego odcinka między kolejnymi punktami trasy.
  const countryAt = new Array(n).fill('?');
  for (const [a, b, id] of p.extras?.countryinfo?.values ?? []) {
    const code = COUNTRIES[id] || '#' + id;
    for (let i = a; i < b && i < n; i++) countryAt[i] = code;
  }
  const tollAt = new Array(n).fill(false);
  const tolls = [];
  for (const [a, b, v] of p.extras?.tollways?.values ?? []) {
    if (v === 1) { tolls.push([a, b]); for (let i = a; i < b && i < n; i++) tollAt[i] = true; }
  }
  // odcinki promowe (waycategory, bit 8 = prom)
  const ferries = [];
  for (const [a, b, v] of p.extras?.waycategory?.values ?? []) {
    if (v & 8) {
      const last = ferries[ferries.length - 1];
      if (last && last[1] === a) last[1] = b; else ferries.push([a, b]);
    }
  }

  const km = {}, toll = {};
  let tollTotal = 0, cum = 0, prev = null;
  const crossings = [], path = [];
  for (let i = 0; i < n; i++) {
    const d = haversineKm(coords[i], coords[i + 1]);
    const c = countryAt[i];
    km[c] = (km[c] || 0) + d;
    if (tollAt[i]) { toll[c] = (toll[c] || 0) + d; tollTotal += d; }
    if (c !== '?' && c[0] !== '#' && c !== prev) {
      if (prev) crossings.push(makeCrossing(prev, c, cum, coords[i]));
      path.push(c);
      prev = c;
    }
    cum += d;
  }

  const orsHours = (p.summary?.duration ?? 0) / 3600;
  return {
    km: Math.round((p.summary?.distance ?? 0) / 1000),
    hours: orsHours * timeFactor,
    hours_ors: orsHours,
    toll_km: Math.round(tollTotal),
    countries: roundSorted(km),
    toll_by_country: roundSorted(toll),
    ends: n ? [countryAt[0], countryAt[n - 1]] : [],
    path,
    crossings,
    tolls,
    ferries,
    coords: coords.map(([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5]),
    // wysokości n.p.m. (m) dla tych samych punktów; ascent/descent – suma podjazdów i zjazdów z ORS
    elev: coords.length && coords[0].length > 2 ? coords.map((c) => Math.round(c[2])) : null,
    ascent: Math.round(p.ascent ?? 0),
    descent: Math.round(p.descent ?? 0),
  };
}


// ---- Kolejki na granicach: tylko odczyt z KV (zapisuje je cron co 3 h) ----
// GET /border?from=HU&to=RS → przejścia dla samochodów osobowych w kierunku HU → RS.
async function handleBorder(url, env, cors) {
  const from = (url.searchParams.get('from') || '').toUpperCase();
  const to = (url.searchParams.get('to') || '').toUpperCase();
  if (!env.NK) return json({ checkpoints: [], note: 'brak powiązania KV (NK)' }, 200, cors);
  const all = await env.NK.get('borders', 'json');
  const hit = all?.pairs?.[from + '>' + to];
  if (!hit) return json({ from, to, checkpoints: [], note: 'brak danych dla tej granicy' }, 200, cors, { 'Cache-Control': 'public, max-age=600' });
  return json({ from, to, ...hit, source: 'nakordoni.eu' }, 200, cors, { 'Cache-Control': 'public, max-age=600' });
}

// ===================== CRON: jedyne miejsce, które pyta nakordoni.eu =====================
// Kraje, dla których pobieramy ceny paliwa (raz na dobę). Każdy kraj = 1 zapytanie.
const FUEL_COUNTRIES = ['PL', 'CZ', 'SK', 'HU', 'AT', 'SI', 'HR', 'MK', 'BG', 'RO', 'GR', 'TR',
  'DE', 'IT', 'FR', 'ES', 'PT', 'NL', 'BE', 'LU', 'CH', 'DK', 'SE', 'NO', 'LT', 'LV', 'EE', 'UA', 'MD'];
// Pary granic poza Schengen pobierane co 3 h (oba kierunki osobno). Każda para = 1 zapytanie.
// Lista celowo krótka: tylko granice z tras planera. Dopisz parę, gdy dojdzie nowy kierunek.
const BORDER_PAIRS = (() => {
  // granice poza Schengen na trasach z Polski na Bałkany, do Turcji i na wschód (oba kierunki)
  const g = [['HU', 'RS'], ['HR', 'RS'], ['HR', 'BA'], ['HR', 'ME'], ['RS', 'ME'], ['RS', 'BA'], ['BA', 'ME'], ['RS', 'MK'], ['RS', 'BG'],
    ['RS', 'RO'], ['MK', 'GR'], ['MK', 'BG'], ['MK', 'AL'], ['ME', 'AL'], ['AL', 'GR'], ['BG', 'TR'], ['GR', 'TR'],
    ['PL', 'UA'], ['SK', 'UA'], ['HU', 'UA'], ['RO', 'MD']];
  return g.flatMap(([a, b]) => [a + '>' + b, b + '>' + a]);
})();
const FUEL_EVERY_H = 24;   // paliwo: raz na dobę
const FUEL_PER_RUN = 8;    // ile krajów paliwa na jedno uruchomienie crona (reszta w kolejnych)
const FUEL_HOUR_UTC = 4;   // …o tej godzinie UTC (pierwsze uruchomienie crona po niej)
const BORDERS_EVERY_H = 3; // kolejki: nie częściej niż co 3 h
const PAUSE_MS = 2000;     // 2 s między zapytaniami – nakordoni.eu odcina serie (429)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function nkFetch(path, key) {
  const res = await fetch(NK_BASE + path, {
    headers: {
      Authorization: 'Bearer ' + key, Accept: 'application/json',
      'User-Agent': 'gdzieponiesie.pl/1.0 (+https://gdzieponiesie.pl; planer tras kamperem)',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json(); // strona blokady (HTML) też skończy się tu błędem
}

async function runNakordoniCron(env, now) {
  if (!env.NK) return;
  const key = nakordoniKey(env);
  if (!key) return; // zły lub brak klucza – nic nie wysyłamy (nakordoni blokuje IP po 2 błędnych kluczach)

  // blokada: dwa uruchomienia naraz nie pytają API podwójnie
  const lock = await env.NK.get('cron:lock');
  if (lock && now - new Date(lock) < 10 * 60 * 1000) return;
  await env.NK.put('cron:lock', now.toISOString(), { expirationTtl: 900 });

  const status = (await env.NK.get('status', 'json')) || {};
  const today = now.toISOString().slice(0, 10);
  if (status.day !== today) { status.day = today; status.calls_today = 0; status.border_calls_today = 0; status.fuel_calls_today = 0; }
  const log = { started: now.toISOString(), border_calls: 0, fuel_calls: 0, errors: [] };
  const hoursSince = (iso) => iso ? (now - new Date(iso)) / 3600000 : Infinity;
  let stop = false;

  // --- kolejki: nie częściej niż co 3 h, niezależnie od tego, jak często chodzi cron ---
  const prev = (await env.NK.get('borders', 'json')) || { pairs: {} };
  if (hoursSince(prev.updated) >= BORDERS_EVERY_H - 0.25) {
    const pairs = { ...prev.pairs };
    for (const p of BORDER_PAIRS) {
      if (stop) break;
      const path = nkBorderPath(p, 'v4');
      if (!path) continue;
      try {
        log.border_calls++;
        const data = await nkFetch(path, key);
        pairs[p] = { ...normalizeBorder(data), fetched_at: Math.floor(Date.now() / 1000) };
      } catch (e) {
        log.errors.push(p + ': ' + e.message);
        if (/HTTP (401|403|429)/.test(e.message)) stop = true; // blokada lub limit – kończymy do następnego okna
      }
      await sleep(PAUSE_MS);
    }
    await env.NK.put('borders', JSON.stringify({ pairs, updated: now.toISOString() }));
  } else log.borders = 'pominięte – dane z ' + prev.updated;

  // --- paliwo: każdy kraj raz na dobę, porcjami po FUEL_PER_RUN krajów na uruchomienie (bez serii zapytań) ---
  // Kraje, których nakordoni.eu nie obsługuje (404), pomijamy przez 30 dni.
  const fuelPrev = (await env.NK.get('fuel', 'json')) || { byCountry: {} };
  const skip = fuelPrev.skip || {};
  const fetchedAt = fuelPrev.fetchedAt || {};
  const due = FUEL_COUNTRIES.filter((c) => !(skip[c] && new Date(skip[c]) > now) && hoursSince(fetchedAt[c]) >= 23).slice(0, FUEL_PER_RUN);
  if (!stop && due.length) {
    const byCountry = { ...fuelPrev.byCountry };
    for (const c of due) {
      try {
        log.fuel_calls++;
        const payload = await nkFetch('/api/v1/data/fuel?lang=en&country=' + c, key);
        const d = payload?.data?.data ?? payload?.data ?? payload;
        if (d && ['diesel', 'petrol', 'lpg'].some((t) => typeof d[t] === 'number' && d[t] > 0)) {
          byCountry[c] = { country: c, currency: d.currency || null, diesel: d.diesel ?? null, petrol: d.petrol ?? null,
            lpg: d.lpg ?? null, lpg_eur: d.lpg_eur ?? null, updated: d.updated || null };
        }
        fetchedAt[c] = now.toISOString();
      } catch (e) {
        log.errors.push('paliwo ' + c + ': ' + e.message);
        if (/HTTP 404/.test(e.message)) { skip[c] = new Date(now.getTime() + 30 * 864e5).toISOString(); fetchedAt[c] = now.toISOString(); }
        if (/HTTP (401|403|429)/.test(e.message)) break;   // limit – reszta w następnym uruchomieniu
      }
      await sleep(PAUSE_MS);
    }
    await env.NK.put('fuel', JSON.stringify({ byCountry, fetchedAt, skip, updated: now.toISOString() }));
    status.fuel_at = now.toISOString();
  } else log.fuel = due.length ? 'pominięte – blokada po błędzie kolejek' : 'wszystkie kraje aktualne';

  status.last_run = log;
  status.border_calls_today += log.border_calls;
  status.fuel_calls_today += log.fuel_calls;
  status.calls_today = status.border_calls_today + status.fuel_calls_today;
  if (log.border_calls) status.borders_at = now.toISOString();
  await env.NK.put('status', JSON.stringify(status));
  await env.NK.delete('cron:lock');
}

async function nkStatus(env) {
  if (!env.NK) return { error: 'Worker nie ma powiązania KV o nazwie NK.' };
  const [status, borders, fuel] = await Promise.all([env.NK.get('status', 'json'), env.NK.get('borders', 'json'), env.NK.get('fuel', 'json')]);
  const pairs = borders?.pairs || {};
  return {
    status: status || 'cron jeszcze nie działał',
    borders: { updated: borders?.updated || null, pairs: Object.keys(pairs).length,
      sample: Object.entries(pairs).slice(0, 1).map(([k, v]) => ({ pair: k, checkpoints: v.checkpoints?.slice(0, 2), raw: v.sample })) },
    fuel: { updated: fuel?.updated || null, countries: Object.keys(fuel?.byCountry || {}) },
  };
}

// Odpowiedź v4 sprowadzona do {checkpoints:[{name, lat, lon, wait_min, updated}]}.
// UWAGA: nazwy pól dobrane ostrożnie (kilka wariantów). Gdy nic nie pasuje, zwracamy "sample"
// z kluczami pierwszego elementu, żeby można było szybko poprawić mapowanie.
function normalizeBorder(payload) {
  const root = payload?.data?.data ?? payload?.data ?? payload;
  const list = Array.isArray(root) ? root
    : (root?.checkpoints || root?.items || root?.points || root?.list || []);
  const pick = (o, keys) => { for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; return undefined; };
  const checkpoints = [];
  for (const it of Array.isArray(list) ? list : []) {
    const name = pick(it, ['name', 'title', 'checkpoint', 'name_en', 'pp_name', 'point']);
    const lat = Number(pick(it, ['lat', 'latitude']) ?? pick(it.coords || it.location || {}, ['lat', 'latitude']));
    const lon = Number(pick(it, ['lon', 'lng', 'longitude']) ?? pick(it.coords || it.location || {}, ['lon', 'lng', 'longitude']));
    const wait = parseWait(pick(it, ['wait_min', 'wait_minutes', 'waiting_time', 'wait_time', 'queue_time', 'time', 'wait', 'queue']));
    const updated = pick(it, ['updated', 'updated_at', 'last_update', 'time_update']);
    if (name || wait !== null) checkpoints.push({ name: name ? String(name) : null, lat: Number.isFinite(lat) ? lat : null, lon: Number.isFinite(lon) ? lon : null, wait_min: wait, updated: updated || null });
  }
  const out = { checkpoints };
  if (!checkpoints.some((c) => c.wait_min !== null)) {
    const first = Array.isArray(list) ? list[0] : list;
    out.sample = first && typeof first === 'object' ? trimForProbe(first) : trimForProbe(root);
  }
  return out;
}

// "2h 30m", "02:30", "150", 150, "1.5 h" → minuty
function parseWait(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return v >= 0 ? Math.round(v) : null;
  const s = String(v).toLowerCase().trim();
  let m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) return +m[1] * 60 + +m[2];
  const h = /(\d+(?:[.,]\d+)?)\s*(h|godz|hour)/.exec(s), mi = /(\d+)\s*(m|min)/.exec(s);
  if (h || mi) return Math.round((h ? parseFloat(h[1].replace(',', '.')) * 60 : 0) + (mi ? +mi[1] : 0));
  return /^\d+$/.test(s) ? +s : null;
}


// ===================== Miejsca z OpenStreetMap (Overpass) =====================
// Dane © współtwórcy OpenStreetMap (ODbL). Wyniki cache'ujemy 7 dni, żeby nie obciążać Overpass.
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const POI_CACHE_SECONDS = 7 * 24 * 3600;

async function overpass(query) {
  let last = 'brak odpowiedzi';
  for (const ep of OVERPASS) {
    try {
      const res = await fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'gdzieponiesie.pl/1.0 (+https://gdzieponiesie.pl)' },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) return (await res.json()).elements || [];
      last = ep.split('/')[2] + ': ' + res.status;
    } catch (e) { last = ep.split('/')[2] + ': ' + String(e.message || e); }
  }
  throw new Error(last);
}
const poiPoint = (e) => ({ lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon });
async function poiCached(key, make, cors) {
  const req = new Request('https://cache.gdzieponiesie.internal/poi/' + CACHE_VERSION + '/' + key);
  const hit = await caches.default.match(req);
  if (hit) return json(await hit.json(), 200, cors, { 'X-Cache': 'HIT' });
  let body;
  try { body = await make(); } catch (e) { return json({ items: [], error: 'Mapa miejsc chwilowo niedostępna: ' + e.message }, 200, cors); }
  await caches.default.put(req, new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=' + POI_CACHE_SECONDS } }));
  return json(body, 200, cors, { 'X-Cache': 'MISS' });
}

// GET /poi?lat=..&lon=..&r=15000 → kempingi (camp_site) i miejsca dla kamperów (caravan_site) w promieniu r metrów
async function handlePoiNear(url, cors) {
  const lat = Number(url.searchParams.get('lat')), lon = Number(url.searchParams.get('lon'));
  const r = clampNum(url.searchParams.get('r'), 2000, 30000, 15000);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json({ error: 'brak lat/lon' }, 400, cors);
  const key = 'near/' + lat.toFixed(2) + ',' + lon.toFixed(2) + '/' + r;
  return poiCached(key, async () => {
    const q = `[out:json][timeout:12];(nwr["tourism"="camp_site"](around:${r},${lat},${lon});nwr["tourism"="caravan_site"](around:${r},${lat},${lon}););out center tags 60;`;
    const items = (await overpass(q)).map((e) => {
      const p = poiPoint(e), t = e.tags || {};
      return { id: e.type[0] + e.id, name: t.name || null, kind: t.tourism === 'caravan_site' ? 'kamper' : 'kemping',
        lat: p.lat, lon: p.lon, web: t.website || t['contact:website'] || null, tel: t.phone || t['contact:phone'] || null,
        fee: t.fee || null, power: t.power_supply || null, d: Math.round(haversineKm([lon, lat], [p.lon, p.lat]) * 10) / 10 };
    }).filter((x) => Number.isFinite(x.lat)).sort((a, b) => a.d - b.d).slice(0, 12);
    return { items, source: 'OpenStreetMap' };
  }, cors);
}

// POST /poi/lpg {pts:[[lon,lat],...]} (do 200 punktów wzdłuż trasy) → stacje z LPG w odległości do 3 km od trasy
async function handlePoiLpg(request, cors) {
  let b; try { b = await request.json(); } catch (e) { return json({ error: 'zły JSON' }, 400, cors); }
  const pts = (Array.isArray(b.pts) ? b.pts : []).filter(isPoint).slice(0, 200);
  if (pts.length < 2) return json({ error: 'za mało punktów' }, 400, cors);
  const key = 'lpg/' + (await sha256(JSON.stringify(pts.map(([x, y]) => [x.toFixed(2), y.toFixed(2)]))));
  return poiCached(key, async () => {
    const line = pts.map(([x, y]) => `${y.toFixed(4)},${x.toFixed(4)}`).join(',');
    const q = `[out:json][timeout:25];nwr["amenity"="fuel"]["fuel:lpg"="yes"](around:3000,${line});out center tags 400;`;
    const items = (await overpass(q)).map((e) => { const p = poiPoint(e), t = e.tags || {};
      return { id: e.type[0] + e.id, name: t.name || t.brand || null, brand: t.brand || null, lat: p.lat, lon: p.lon, hours: t.opening_hours || null }; })
      .filter((x) => Number.isFinite(x.lat));
    return { items, source: 'OpenStreetMap' };
  }, cors);
}


// GET /reverse?lat=..&lon=.. → nazwa najbliższej miejscowości (ORS, cache 30 dni) – do nazw noclegów
async function handleReverse(url, env, cors) {
  const lat = Number(url.searchParams.get('lat')), lon = Number(url.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json({ error: 'brak lat/lon' }, 400, cors);
  const req = new Request('https://cache.gdzieponiesie.internal/rev/' + lat.toFixed(2) + ',' + lon.toFixed(2));
  const hit = await caches.default.match(req);
  if (hit) return json(await hit.json(), 200, cors, { 'X-Cache': 'HIT' });
  const params = new URLSearchParams({ api_key: env.ORS_API_KEY || '', 'point.lat': lat, 'point.lon': lon, size: '1', layers: 'locality,localadmin' });
  let body = { name: null };
  try {
    const res = await fetch('https://api.openrouteservice.org/geocode/reverse?' + params, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const f = (await res.json()).features?.[0];
      if (f) body = { name: f.properties?.name || null, country: ISO3_TO_ISO2[f.properties?.country_a] || null,
        d: Math.round((f.properties?.distance ?? 0) * 10) / 10 };
    } else return json({ name: null, error: 'ORS ' + res.status }, 200, cors);
  } catch (e) { return json({ name: null, error: String(e.message || e) }, 200, cors); }
  await caches.default.put(req, new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=' + 30 * 24 * 3600 } }));
  return json(body, 200, cors, { 'X-Cache': 'MISS' });
}
