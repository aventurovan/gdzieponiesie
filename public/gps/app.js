/* Nawigacja kamper – gdzieponiesie.pl/gps  (etap 1: mapa 3D, GPS, trasa z manewrami, głos) */
'use strict';
const API = (window.GP_CONFIG && window.GP_CONFIG.routeApi) || '';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const store = {
  get: (k, d) => { try { const v = localStorage.getItem('gps.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set: (k, v) => { try { localStorage.setItem('gps.' + k, JSON.stringify(v)); } catch (e) {} },
};

/* ---------- stan ---------- */
const S = {
  veh: store.get('veh', { h: 3.1, l: 6.36, w: 2.05, t: 3.5 }),
  opt: store.get('opt', { voice: true, d3: true, night: false, sim: false }),
  mode: store.get('mode', 'fast'),
  from: null, to: null,          // {name, lon, lat} | null = bieżąca pozycja
  route: null,                   // odpowiedź /gps/route
  nav: false,                    // czy trwa jazda
  pos: null,                     // {lon, lat, speed(m/s), heading, t}
  follow: true,
  tab: 'trasa',
};
const STYLE = { light: 'https://tiles.openfreemap.org/styles/liberty', dark: 'https://tiles.openfreemap.org/styles/dark' };

/* ---------- geometria ---------- */
const R_EARTH = 6371000, rad = d => d * Math.PI / 180;
function dist(a, b) { // metry, [lon,lat]
  const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(s));
}
function bearing(a, b) {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
// rzut punktu na łamaną: najbliższy odcinek w oknie wokół ostatniego indeksu
function snap(p, coords, cum, fromIdx) {
  const cosLat = Math.cos(rad(p[1]));
  const toXY = c => [(c[0] - p[0]) * cosLat * 111320, (c[1] - p[1]) * 110540];
  let best = { d: Infinity, i: fromIdx, t: 0 };
  const lo = Math.max(0, fromIdx - 20), hi = Math.min(coords.length - 2, fromIdx + 300);
  for (let i = lo; i <= hi; i++) {
    const a = toXY(coords[i]), b = toXY(coords[i + 1]);
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    let t = l2 ? -(a[0] * dx + a[1] * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    const x = a[0] + t * dx, y = a[1] + t * dy, d = Math.hypot(x, y);
    if (d < best.d) best = { d, i, t };
  }
  const prog = cum[best.i] + (cum[best.i + 1] - cum[best.i]) * best.t;
  return { off: best.d, idx: best.i, prog };
}

/* ---------- mapa ---------- */
let map, meMarker, mapReady = false;
function initMap() {
  map = new maplibregl.Map({
    container: 'map', style: STYLE[S.opt.night ? 'dark' : 'light'], center: [19.05, 49.82], zoom: 13,
    pitch: 0, attributionControl: false, maxPitch: 70, fadeDuration: 0,
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'top-right');
  map.on('style.load', addLayers);
  map.on('rotate', () => { const el = $('#compassIco'); if (el) el.style.transform = `rotate(${-map.getBearing()}deg)`; });
  map.on('dragstart', () => { if (S.nav) { S.follow = false; $('#btnRecenter').hidden = false; } });
  map.on('load', () => { mapReady = true; if (S.route) drawRoute(); const at = document.querySelector('.maplibregl-ctrl-attrib'); if (at) at.classList.remove('maplibregl-compact-show'); });
  const el = document.createElement('div'); el.className = 'me';
  el.innerHTML = '<svg viewBox="0 0 36 36"><path d="M18 3 L31 31 L18 24 L5 31 Z" fill="#3A74FF" stroke="#fff" stroke-width="3" stroke-linejoin="round"/></svg>';
  meMarker = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' });
}
let BUD3D = null;   // id warstwy budynków 3D (ze stylu Liberty albo nasza)
function tuneStyle() {
  BUD3D = null;
  // paleta pod makietę: cieplejsze tło, zielone lasy i parki, łososiowe budynki
  const night = S.opt.night;
  for (const l of map.getStyle().layers) {
    const id = l.id.toLowerCase();
    try {
      if (l.type === 'background') map.setPaintProperty(l.id, 'background-color', night ? '#1C2029' : '#EFEBE2');
      else if (l.type === 'fill' && /wood|forest/.test(id)) { map.setPaintProperty(l.id, 'fill-color', night ? '#1F2A2C' : '#C5D9AE'); map.setPaintProperty(l.id, 'fill-opacity', 1); }
      else if (l.type === 'fill' && /park|grass|meadow|farmland|cemetery|pitch|garden|scrub/.test(id)) { map.setPaintProperty(l.id, 'fill-color', night ? '#232E30' : '#DCE7C9'); map.setPaintProperty(l.id, 'fill-opacity', 1); }
      else if (l.type === 'fill' && /residential|neighbourhood|suburb/.test(id)) map.setPaintProperty(l.id, 'fill-color', night ? '#20252F' : '#EAE4D6');
      else if (l.type === 'fill' && /building/.test(id)) { map.setPaintProperty(l.id, 'fill-color', night ? '#3B4252' : '#E3B6A2'); map.setPaintProperty(l.id, 'fill-opacity', 0.9); }
      else if (l.type === 'symbol' && /poi|transit|bus|station|airport|housenum/.test(id)) map.setLayoutProperty(l.id, 'visibility', 'none');
      else if (l.type === 'fill-extrusion') { BUD3D = l.id; map.setPaintProperty(l.id, 'fill-extrusion-color', night ? '#3B4252' : '#E3B6A2'); map.setPaintProperty(l.id, 'fill-extrusion-opacity', 0.9); }
      else if (l.type === 'fill' && /water/.test(id)) map.setPaintProperty(l.id, 'fill-color', night ? '#15202E' : '#9EC4E6');
    } catch (e) {}
  }
}
function addLayers() {
  tuneStyle();
  // budynki 3D z kafelków OpenMapTiles (warstwa building, render_height)
  if (BUD3D) { map.setLayoutProperty(BUD3D, 'visibility', S.opt.d3 ? 'visible' : 'none'); try { map.setLayerZoomRange(BUD3D, 15, 24); } catch (e) {} }
  else if (!map.getLayer('bud3d')) {
    BUD3D = 'bud3d';
    const labelId = (map.getStyle().layers.find(l => l.type === 'symbol') || {}).id;
    map.addLayer({
      id: 'bud3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 15,
      paint: {
        'fill-extrusion-color': S.opt.night ? '#3B4252' : '#E3B6A2',
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 7],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': 0.9,
        'fill-extrusion-vertical-gradient': true,
      },
    }, labelId);
    map.setLayoutProperty('bud3d', 'visibility', S.opt.d3 ? 'visible' : 'none');
  }
  if (!map.getSource('route')) {
    map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'route-case', type: 'line', source: 'route', filter: ['==', 'k', 'main'], layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#1F3F9E', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 6, 16, 16] } });
    map.addLayer({ id: 'route-line', type: 'line', source: 'route', filter: ['==', 'k', 'main'], layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#3A74FF', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 11] } });
    map.addLayer({ id: 'route-toll', type: 'line', source: 'route', filter: ['==', 'k', 'toll'], layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#F2C230', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 16, 4], 'line-dasharray': [2, 2] } });
    map.addLayer({ id: 'route-pts', type: 'circle', source: 'route', filter: ['==', 'k', 'pt'],
      paint: { 'circle-radius': 7, 'circle-color': ['get', 'c'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
  }
  if (S.route) drawRoute();
}
function drawRoute() {
  if (!map.getSource('route')) return;
  const r = S.route, f = [];
  f.push({ type: 'Feature', properties: { k: 'main' }, geometry: { type: 'LineString', coordinates: r.coords } });
  for (const [a, b] of r.tolls || []) f.push({ type: 'Feature', properties: { k: 'toll' }, geometry: { type: 'LineString', coordinates: r.coords.slice(a, b + 1) } });
  f.push({ type: 'Feature', properties: { k: 'pt', c: '#3A74FF' }, geometry: { type: 'Point', coordinates: r.coords[0] } });
  f.push({ type: 'Feature', properties: { k: 'pt', c: '#1a1d24' }, geometry: { type: 'Point', coordinates: r.coords[r.coords.length - 1] } });
  map.getSource('route').setData({ type: 'FeatureCollection', features: f });
  if (!S.nav && r.bbox) map.fitBounds([[r.bbox[0], r.bbox[1]], [r.bbox[2], r.bbox[3]]], { padding: { top: 70 + 30, bottom: window.innerHeight * 0.5 + 20, left: 40, right: 40 }, pitch: 0, bearing: 0, duration: 600 });
}
function setView3d(on) {
  S.opt.d3 = on; store.set('opt', S.opt); $('#opt3d').checked = on; $('#btnView').textContent = on ? '3D' : '2D';
  if (BUD3D && map.getLayer(BUD3D)) map.setLayoutProperty(BUD3D, 'visibility', on ? 'visible' : 'none');
  map.easeTo({ pitch: on && S.nav ? 58 : 0, duration: 500 });
}
function setNight(on) {
  S.opt.night = on; store.set('opt', S.opt); document.body.classList.toggle('night', on); $('#optNight').checked = on;
  map.setStyle(STYLE[on ? 'dark' : 'light'], { diff: false });
}

/* ---------- geokoder (Worker /geocode: miasta GeoNames + ORS) ---------- */
let suggT, suggFor;
async function suggest(inp) {
  const q = inp.value.trim(); const ul = $('#sugg');
  if (q.length < 2) { ul.classList.add('hidden'); return; }
  let j; try { const r = await fetch(API + '/geocode?q=' + encodeURIComponent(q)); j = await r.json(); } catch (e) { return; }
  if (inp.value.trim() !== q) return;
  suggFor = inp; ul.innerHTML = (j.results || []).slice(0, 6).map((x, i) => `<li data-i="${i}">${esc(x.label || x.name)}</li>`).join('');
  ul._res = j.results || []; ul.classList.toggle('hidden', !ul.innerHTML);
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
$('#sugg').addEventListener('click', e => {
  const li = e.target.closest('li'); if (!li) return;
  const x = $('#sugg')._res[+li.dataset.i]; const pt = { name: x.name, lon: x.lon, lat: x.lat };
  suggFor.value = x.name; if (suggFor.id === 'from') S.from = pt; else S.to = pt;
  $('#sugg').classList.add('hidden'); $('#btnGo').classList.add('hidden'); S.route = null; setSheetHalf(false);
});
['from', 'to'].forEach(id => {
  const inp = $('#' + id);
  inp.addEventListener('input', () => { if (id === 'from') S.from = null; else S.to = null; clearTimeout(suggT); suggT = setTimeout(() => suggest(inp), 250); });
});

/* ---------- pojazd ---------- */
function vehLine() { const v = S.veh; $('#vehLine').innerHTML = `🚐 Kamper ${fmt1(v.h)} m · ${fmt1(v.l)} m · ${fmt1(v.t)} t <a href="#veh">Zmień</a>`; }
const fmt1 = n => String(Math.round(n * 100) / 100).replace('.', ',');
const num = s => parseFloat(String(s).replace(',', '.'));
function fillVeh() { $('#vH').value = fmt1(S.veh.h); $('#vL').value = fmt1(S.veh.l); $('#vW').value = fmt1(S.veh.w); $('#vT').value = fmt1(S.veh.t); }
$('#btnVehSave').addEventListener('click', () => {
  const v = { h: num($('#vH').value), l: num($('#vL').value), w: num($('#vW').value), t: num($('#vT').value) };
  if (![v.h, v.l, v.w, v.t].every(Number.isFinite)) return alert('Wpisz liczby, np. 3,10');
  S.veh = v; store.set('veh', v); vehLine(); S.route = null; $('#btnGo').classList.add('hidden'); showTab('trasa');
});

/* ---------- trasa ---------- */
$('#modes').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  S.mode = b.dataset.mode; store.set('mode', S.mode);
  $$('#modes button').forEach(x => x.setAttribute('aria-pressed', x === b));
  if (S.route) computeRoute();
});
$('#btnRoute').addEventListener('click', () => computeRoute());
function setSheetHalf(on) { $('#sheet').classList.toggle('half', on); if (on) $('#sheet').scrollTop = 0; }
$('#sheetGrip').addEventListener('click', () => { if (S.route) setSheetHalf(!$('#sheet').classList.contains('half')); });
$('#editRoute').addEventListener('click', e => { e.preventDefault(); setSheetHalf(false); });
async function computeRoute(fromPos) {
  const msg = $('#msg'); msg.textContent = '';
  if (!API) { msg.textContent = 'Brak adresu API w assets/config.js.'; return; }
  const from = fromPos || S.from || (S.pos ? { lon: S.pos.lon, lat: S.pos.lat } : null);
  if (!from) { msg.textContent = 'Czekam na pozycję GPS… albo wpisz punkt startu.'; startGps(); return null; }
  if (!S.to) { msg.textContent = 'Wybierz cel z listy podpowiedzi.'; return null; }
  $('#btnRoute').disabled = true; msg.textContent = 'Liczę trasę…';
  const body = { from: [from.lon, from.lat], to: [S.to.lon, S.to.lat], via: [], mode: S.mode,
    camper: { height: S.veh.h, width: S.veh.w, length: S.veh.l, weight: S.veh.t }, avoid: {} };
  let j;
  try {
    const r = await fetch(API + '/gps/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    j = await r.json(); if (!r.ok) throw new Error(j.error || ('Błąd ' + r.status));
  } catch (e) { msg.textContent = e.message; $('#btnRoute').disabled = false; return null; }
  $('#btnRoute').disabled = false; msg.textContent = '';
  S.route = j; S.route.total = j.cum[j.cum.length - 1];
  if (!fromPos) { renderSummary(); setSheetHalf(true); drawRoute(); $('#btnGo').classList.remove('hidden'); }
  return j;
}
function renderSummary() {
  const r = S.route, eta = new Date(Date.now() + r.sec * 1000);
  $('#tiles').innerHTML = `<div class="tile"><b>${Math.round(r.km)} km</b><small>dystans</small></div>
    <div class="tile"><b>${hm(r.sec)}</b><small>czas jazdy</small></div>
    <div class="tile"><b>${hhmm(eta)}</b><small>${eta.getDate() !== new Date().getDate() ? 'jutro' : 'dziś'} na miejscu</small></div>`;
  const tollKm = (r.tolls || []).reduce((s, [a, b]) => s + (r.cum[b] - r.cum[a]), 0) / 1000;
  $('#routeInfo').innerHTML = `<b>Trasa przez: ${r.path.map(c => KRAJ[c] || c).join(', ')}</b>
    ${r.crossings.length ? '<span>Granice: ' + r.crossings.map(c => c.from + '→' + c.to + ' (' + Math.round(c.at / 1000) + ' km)').join(', ') + '</span>' : ''}
    <span>Odcinki płatne: ${Math.round(tollKm)} km · profil: ${r.profile === 'hgv' ? 'z ograniczeniami wysokości i masy' : 'osobowy (HGV nie znalazł trasy)'}</span>`;
}
const KRAJ = { PL: 'Polska', CZ: 'Czechy', SK: 'Słowacja', AT: 'Austria', DE: 'Niemcy', IT: 'Włochy', HU: 'Węgry', SI: 'Słowenia', HR: 'Chorwacja', FR: 'Francja', CH: 'Szwajcaria', NL: 'Holandia', BE: 'Belgia', DK: 'Dania', SE: 'Szwecja', NO: 'Norwegia', ES: 'Hiszpania', PT: 'Portugalia', LT: 'Litwa', LV: 'Łotwa', EE: 'Estonia', RO: 'Rumunia', BG: 'Bułgaria', GR: 'Grecja', RS: 'Serbia', BA: 'Bośnia', ME: 'Czarnogóra', AL: 'Albania', MK: 'Macedonia Płn.', LU: 'Luksemburg', GB: 'Wielka Brytania', IE: 'Irlandia', FI: 'Finlandia', UA: 'Ukraina' };
const hm = s => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h}:${String(m).padStart(2, '0')} h` : `${m} min`; };
const hhmm = d => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');

/* ---------- jazda ---------- */
const NAV = { idx: 0, prog: 0, offCount: 0, stepI: 0, said: {}, lastReroute: 0, lastFix: null };
$('#btnGo').addEventListener('click', () => { startNav(); });
function startNav() {
  if (!S.route) return;
  S.nav = true; S.follow = true; NAV.idx = 0; NAV.prog = 0; NAV.offCount = 0; NAV.stepI = 0; NAV.said = {};
  showTab('jazda'); $('#hud').classList.remove('hidden'); setSheetHalf(false);
  speak('Rozpoczynam nawigację.'); keepAwake();
  map.easeTo({ pitch: S.opt.d3 ? 58 : 0, zoom: 16, duration: 800 });
  if (S.opt.sim) startSim(); else startGps();
  updateHud();
}
function stopNav() {
  S.nav = false; $('#hud').classList.add('hidden'); stopSim(); $('#btnRecenter').hidden = true;
  map.easeTo({ pitch: 0, bearing: 0, zoom: 14.5, duration: 600 }); showTab('jazda');
  if (wake) { wake.release().catch(() => {}); wake = null; }
}

/* GPS */
let watchId = null;
function startGps() {
  if (watchId != null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(p => {
    const c = p.coords;
    onFix({ lon: c.longitude, lat: c.latitude, speed: c.speed, heading: c.heading, acc: c.accuracy, t: p.timestamp });
  }, e => {
    watchId = null;
    $('#msg').textContent = e.code === 1
      ? 'Brak zgody na lokalizację. Safari: „aA" w pasku adresu → Ustawienia strony → Lokalizacja → Zezwól, potem odśwież.'
      : e.code === 2 ? 'Nie udało się ustalić pozycji (brak sygnału GPS).' : 'GPS nie odpowiada – spróbuj ponownie.';
  }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
}
function onFix(f) {
  const prev = S.pos;
  // iOS nie zawsze daje heading/speed – liczymy z poprzedniej pozycji
  if (prev && (f.heading == null || Number.isNaN(f.heading)) && dist([prev.lon, prev.lat], [f.lon, f.lat]) > 3) f.heading = bearing([prev.lon, prev.lat], [f.lon, f.lat]);
  if (prev && (f.speed == null || Number.isNaN(f.speed)) && f.t > prev.t) f.speed = dist([prev.lon, prev.lat], [f.lon, f.lat]) / ((f.t - prev.t) / 1000);
  if (f.heading == null) f.heading = prev ? prev.heading : 0;
  S.pos = f;
  meMarker.setLngLat([f.lon, f.lat]).setRotation(f.heading || 0);
  if (!meMarker._added) { meMarker.addTo(map); meMarker._added = true; if (!S.nav && !S.route) map.jumpTo({ center: [f.lon, f.lat], zoom: 14.5, pitch: 0, bearing: 0 }); }
  if (!S.nav) { if (S.from === null && !$('#from').value) $('#from').placeholder = 'Bieżąca pozycja (GPS)'; return; }
  navStep(f);
}
function navStep(f) {
  const r = S.route, p = [f.lon, f.lat];
  const sn = snap(p, r.coords, r.cum, NAV.idx);
  if (sn.off > 60) { NAV.offCount++; } else { NAV.offCount = 0; NAV.idx = sn.idx; NAV.prog = sn.prog; }
  // przeliczenie tylko w ruchu (>8 km/h) – na postoju obok drogi nie zjadamy limitu ORS
  if (NAV.offCount >= 5 && (f.speed || 0) > 2.2 && Date.now() - NAV.lastReroute > 20000) reroute(f);
  // kamera
  if (S.follow) {
    const kmh = (f.speed || 0) * 3.6, zoom = kmh > 90 ? 15 : kmh > 50 ? 15.8 : 16.6;
    map.easeTo({ center: p, bearing: f.heading || 0, zoom, pitch: S.opt.d3 ? 58 : 0, duration: 900, easing: t => t, padding: { bottom: window.innerHeight * 0.35 } });
  }
  updateHud();
  // cel
  if (r.total - NAV.prog < 30 && !NAV.said.goal) { NAV.said.goal = true; speak('Jesteś u celu.'); setTimeout(stopNav, 4000); }
}
async function reroute(f) {
  NAV.lastReroute = Date.now(); NAV.offCount = 0;
  $('#manRoad').textContent = 'Przeliczam trasę…';
  const j = await computeRoute({ lon: f.lon, lat: f.lat });
  if (!j) return;
  NAV.idx = 0; NAV.prog = 0; NAV.stepI = 0; NAV.said = {}; drawRoute(); speak('Trasa przeliczona.');
}
function currentStep() {
  const r = S.route, prog = NAV.prog;
  // manewr = pierwszy krok, którego początek jest przed nami (pomijamy „wyjazd”)
  for (let i = Math.max(1, NAV.stepI); i < r.steps.length; i++) {
    const s = r.steps[i], at = r.cum[s.wp[0]];
    if (at - prog > -25) { NAV.stepI = i; return { s, at, dist: Math.max(0, at - prog), next: r.steps[i + 1] }; }
  }
  return null;
}
function updateHud() {
  const r = S.route; if (!r || !S.nav) return;
  const cs = currentStep();
  if (cs) {
    const { s, dist: d, next } = cs;
    $('#manDist').textContent = fmtDist(d);
    $('#manRoad').textContent = s.n || cleanInstr(s.i);
    $('#manIcon').innerHTML = ICONS[s.t] || ICONS[6];
    if (next && next.t !== 10) { $('#nextChip').classList.remove('hidden'); $('#nextChip').innerHTML = `potem <svg viewBox="0 0 64 64" width="22" height="22">${ICONS[next.t] || ICONS[6]}</svg> ${fmtDist(r.cum[next.wp[0]] - r.cum[s.wp[0]])}${next.n ? ' · ' + esc(next.n) : ''}`; }
    else $('#nextChip').classList.add('hidden');
    announce(s, d, cs.at);
  }
  // aktualna droga = nazwa kroku, w którym jesteśmy
  const cur = r.steps[Math.max(0, NAV.stepI - 1)]; $('#roadNow').textContent = cur && cur.n ? cur.n : '';
  const rem = Math.max(0, r.total - NAV.prog), frac = NAV.prog / r.total;
  const remSec = r.sec * (1 - frac);
  $('#etaTime').textContent = hhmm(new Date(Date.now() + remSec * 1000));
  $('#etaKm').textContent = (rem >= 10000 ? Math.round(rem / 1000) : Math.round(rem / 100) / 10) + ' km';
  $('#etaMin').textContent = hm(remSec);
  $('#progBar').style.width = (frac * 100).toFixed(1) + '%';
  const kmh = Math.round((S.pos && S.pos.speed || 0) * 3.6); $('#speedVal').textContent = kmh;
}
const fmtDist = m => m >= 1000 ? (m >= 10000 ? Math.round(m / 1000) : (Math.round(m / 100) / 10)).toString().replace('.', ',') + ' km' : Math.max(0, Math.round(m / 10) * 10) + ' m';
const cleanInstr = i => i.replace(/^(Skręć|Jedź|Kontynuuj|Trzymaj się)[^,]*,?\s*/i, '').replace(/^w (prawo|lewo)\s*/i, '');
// ORS type: 0 lewo,1 prawo,2 ostro lewo,3 ostro prawo,4 lekko lewo,5 lekko prawo,6 prosto,7 rondo,8 zjazd z ronda,9 zawróć,10 cel,11 start,12 trzymaj lewo,13 trzymaj prawo
const P = 'fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"', F = 'fill="#fff"';
const ICONS = {
  0: `<path d="M46 58 V34 Q46 22 34 22 H24" ${P}/><path d="M30 8 L12 22 L30 36 Z" ${F}/>`,
  1: `<path d="M18 58 V34 Q18 22 30 22 H40" ${P}/><path d="M34 8 L52 22 L34 36 Z" ${F}/>`,
  2: `<path d="M44 58 V30 L22 44" ${P}/><path d="M36 48 L12 52 L24 32 Z" ${F}/>`,
  3: `<path d="M20 58 V30 L42 44" ${P}/><path d="M28 48 L52 52 L40 32 Z" ${F}/>`,
  4: `<path d="M38 58 V36 L26 22" ${P}/><path d="M14 10 L34 12 L22 32 Z" ${F}/>`,
  5: `<path d="M26 58 V36 L38 22" ${P}/><path d="M50 10 L30 12 L42 32 Z" ${F}/>`,
  6: `<path d="M32 58 V22" ${P}/><path d="M18 26 L32 8 L46 26 Z" ${F}/>`,
  7: `<circle cx="32" cy="36" r="13" ${P}/><path d="M32 58 V49" ${P}/><path d="M32 23 V14" ${P}/><path d="M18 20 L32 4 L46 20 Z" ${F}/>`,
  8: `<circle cx="32" cy="36" r="13" ${P}/><path d="M32 58 V49" ${P}/><path d="M45 36 H54" ${P}/><path d="M50 22 L62 36 L50 50 Z" ${F}/>`,
  9: `<path d="M24 58 V26 Q24 14 36 14 Q46 14 46 26 V34" ${P}/><path d="M34 32 L58 32 L46 50 Z" ${F}/>`,
  10: `<rect x="18" y="8" width="28" height="22" ${F}/><rect x="18" y="8" width="14" height="11" fill="#1a1d24"/><rect x="32" y="19" width="14" height="11" fill="#1a1d24"/><path d="M18 8 V58" ${P}/>`,
  11: `<path d="M32 58 V22" ${P}/><path d="M18 26 L32 8 L46 26 Z" ${F}/>`,
  12: `<path d="M36 58 V40 L26 26" ${P}/><path d="M40 58 V40" stroke="#fff" stroke-width="5" opacity=".5"/><path d="M14 12 L34 14 L22 34 Z" ${F}/>`,
  13: `<path d="M28 58 V40 L38 26" ${P}/><path d="M24 58 V40" stroke="#fff" stroke-width="5" opacity=".5"/><path d="M50 12 L30 14 L42 34 Z" ${F}/>`,
};

/* głos: komunikat na 1 km (gdy krok długi), 300 m i 50 m przed manewrem */
function announce(s, d, at) {
  const key = at + ':' + s.t; const said = NAV.said[key] || 0;
  const kmh = (S.pos && S.pos.speed || 0) * 3.6;
  const far = kmh > 70 ? 1500 : 800, near = kmh > 70 ? 500 : 250, now = kmh > 70 ? 120 : 50;
  let lvl = 0; if (d <= now) lvl = 3; else if (d <= near) lvl = 2; else if (d <= far) lvl = 1;
  if (lvl > said) {
    NAV.said[key] = lvl;
    const txt = lvl === 3 ? s.i : 'Za ' + sayDist(d) + ' ' + s.i.charAt(0).toLowerCase() + s.i.slice(1);
    speak(txt);
  }
}
const sayDist = m => m >= 950 ? (Math.round(m / 100) / 10 + '').replace('.', ',') + ' kilometra' : Math.round(m / 50) * 50 + ' metrów';
let voicePl = null;
function speak(t) {
  if (!S.opt.voice || !('speechSynthesis' in window)) return;
  try {
    if (!voicePl) voicePl = speechSynthesis.getVoices().find(v => /^pl/i.test(v.lang)) || null;
    const u = new SpeechSynthesisUtterance(t); u.lang = 'pl-PL'; if (voicePl) u.voice = voicePl; u.rate = 1.05;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  } catch (e) {}
}
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => { voicePl = null; };

/* wake lock – ekran nie gaśnie w czasie jazdy */
let wake = null;
async function keepAwake() { try { if ('wakeLock' in navigator) { wake = await navigator.wakeLock.request('screen'); } } catch (e) {} }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.nav && !wake) keepAwake(); });

/* symulacja: jedziemy po trasie 70 km/h, do testów w przeglądarce */
let simT = null;
function startSim() {
  stopSim(); const r = S.route; let prog = 0, last = Date.now();
  const at = pr => { // punkt na trasie w odległości pr m
    let i = NAV.idx; while (i < r.cum.length - 2 && r.cum[i + 1] < pr) i++;
    const a = r.coords[i], b = r.coords[i + 1], t = (pr - r.cum[i]) / Math.max(1, r.cum[i + 1] - r.cum[i]);
    return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], h: bearing(a, b) };
  };
  simT = setInterval(() => {
    const now = Date.now(), v = 70 / 3.6; prog += v * (now - last) / 1000; last = now;
    if (prog >= r.total) { prog = r.total; }
    const q = at(prog); onFix({ lon: q.p[0], lat: q.p[1], speed: v, heading: q.h, t: now });
    if (prog >= r.total) stopSim();
  }, 1000);
}
function stopSim() { if (simT) { clearInterval(simT); simT = null; } }

/* ---------- UI ---------- */
function showTab(t) {
  S.tab = t;
  $('#sheet').classList.toggle('hidden', t !== 'trasa'); $('#veh').classList.toggle('hidden', t !== 'veh'); $('#menu').classList.toggle('hidden', t !== 'menu'); $('#poi').classList.toggle('hidden', t !== 'poi');
  $('#hud').classList.toggle('hidden', !(t === 'jazda' && S.nav));
  if (t === 'jazda' && S.nav) $('.tabs').classList.add('hidden'); else $('.tabs').classList.remove('hidden');
  $('#idle').classList.toggle('hidden', !(t === 'jazda' && !S.nav));
  if (t === 'jazda' && !S.nav) { $('#fVehTxt').textContent = `🚐 Kamper ${fmt1(S.veh.h)} m · ${fmt1(S.veh.t)} t`; $('#fViewTxt').textContent = S.opt.d3 ? '3D' : '2D'; }
  $$('.tabs button').forEach(b => { if (b.dataset.tab === t) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  if (t === 'veh') fillVeh();
}
$('.tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });
$('#vehLine').addEventListener('click', e => { if (e.target.tagName === 'A') { e.preventDefault(); showTab('veh'); } });
$('#btnView').addEventListener('click', () => setView3d(!S.opt.d3));
$('#opt3d').addEventListener('change', e => setView3d(e.target.checked));
$('#optNight').addEventListener('change', e => setNight(e.target.checked));
$('#optVoice').addEventListener('change', e => { S.opt.voice = e.target.checked; store.set('opt', S.opt); });
$('#optSim').addEventListener('change', e => { S.opt.sim = e.target.checked; store.set('opt', S.opt); if (S.nav) { if (S.opt.sim) startSim(); else stopSim(); } });
$('#fSearch').addEventListener('click', () => { showTab('trasa'); setTimeout(() => $('#to').focus(), 50); });
$('#fVeh').addEventListener('click', () => showTab('veh'));
$('#fCompass').addEventListener('click', () => map.easeTo({ bearing: 0, pitch: S.opt.d3 ? 45 : 0, duration: 400 }));
$('#fCenter').addEventListener('click', () => { if (S.pos) map.easeTo({ center: [S.pos.lon, S.pos.lat], zoom: 15, duration: 500 }); else startGps(); });
$('#fView').addEventListener('click', () => { setView3d(!S.opt.d3); $('#fViewTxt').textContent = S.opt.d3 ? '3D' : '2D'; map.easeTo({ pitch: S.opt.d3 ? 45 : 0, duration: 500 }); });
$('#btnRecenter').addEventListener('click', () => { S.follow = true; $('#btnRecenter').hidden = true; });
$('#btnPoi').addEventListener('click', () => showTab('poi'));
$('#etaBox').addEventListener('click', () => { if (confirm('Zakończyć nawigację?')) stopNav(); });

/* start */
// komputer (mysz, brak dotyku, szeroki ekran) – tylko informacja z kodem QR; ?desk=1 wymusza pełną wersję do testów
function isDesktop() {
  if (new URLSearchParams(location.search).get('desk') === '1') return false;
  const touch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
  const coarse = matchMedia('(pointer: coarse)').matches;
  return !touch && !coarse && window.innerWidth > 1024;
}
function init() {
  if (isDesktop()) { $('#desk').classList.remove('hidden'); $('.tabs').classList.add('hidden'); $('#sheet').classList.add('hidden'); return; }
  document.body.classList.toggle('night', !!S.opt.night);
  $('#optVoice').checked = !!S.opt.voice; $('#opt3d').checked = !!S.opt.d3; $('#optNight').checked = !!S.opt.night; $('#optSim').checked = !!S.opt.sim;
  $$('#modes button').forEach(x => x.setAttribute('aria-pressed', x.dataset.mode === S.mode));
  vehLine(); fillVeh(); initMap(); $('#btnView').textContent = S.opt.d3 ? '3D' : '2D';
  startGps();
  // ?to=lon,lat,Nazwa – wejście z planera
  const u = new URLSearchParams(location.search);
  if (u.get('to')) { const [lon, lat, ...n] = u.get('to').split(','); S.to = { lon: +lon, lat: +lat, name: n.join(',') || 'Cel' }; $('#to').value = S.to.name; }
  showTab(S.to ? 'trasa' : 'jazda');
}
init();
