/* Nawigacja kamper – gdzieponiesie.pl/gps  (etap 1: mapa 3D, GPS, trasa z manewrami, głos) */
'use strict';
const API = (window.GP_CONFIG && window.GP_CONFIG.routeApi) || '';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const store = {
  get: (k, d) => { try { const v = localStorage.getItem('gps.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set: (k, v) => { try { localStorage.setItem('gps.' + k, JSON.stringify(v)); } catch (e) {} },
};

/* ---------- most do aplikacji natywnej (Capacitor, wersja IPA) ---------- */
const NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
function plugin(name) { try { const C = window.Capacitor; if (!C) return null; if (C.Plugins && C.Plugins[name]) return C.Plugins[name]; if (C.registerPlugin) return C.registerPlugin(name); } catch (e) {} return null; }
const NTTS = NATIVE ? plugin('TextToSpeech') : null, NBG = NATIVE ? plugin('BackgroundGeolocation') : null, NKA = NATIVE ? plugin('KeepAwake') : null, NLA = NATIVE ? plugin('LiveActivity') : null;
// Live Activity (ekran blokady / Dynamic Island) – tylko w aplikacji natywnej
const LA = { on: false, last: 0, key: '' };
function laPayload() {
  const r = S.route, cs = currentStep(); const rem = Math.max(0, r.total - NAV.prog), remSec = r.sec * (1 - NAV.prog / r.total);
  const lim = (r.limits || []).find(l => NAV.idx >= l.a && NAV.idx < l.b);
  const ahead = (r.traffic || []).filter(t => t.b > NAV.idx).reduce((s, t) => s + t.delay, 0);
  return { dest: S.to ? S.to.name : 'Cel', dist: cs ? fmtDist(cs.dist) : '', instr: cs ? (cs.s.n || cleanInstr(cs.s.i)) : '', maneuver: cs ? cs.s.t : 6,
    eta: hhmm(new Date(Date.now() + remSec * 1000)), remKm: (rem >= 10000 ? Math.round(rem / 1000) : Math.round(rem / 100) / 10) + ' km', remTime: hm(remSec),
    limit: lim ? lim.kmh : 0, progress: Math.min(1, NAV.prog / r.total), delay: ahead > 60 ? '+' + Math.round(ahead / 60) + ' min' : '' };
}
async function laStart() { if (!NLA || !S.route) return; try { const j = await NLA.start(laPayload()); LA.on = !!(j && j.ok); } catch (e) { LA.on = false; } }
function laUpdate() {
  if (!NLA || !LA.on || !S.route) return;
  const p = laPayload(); const key = p.dist + '|' + p.instr + '|' + p.limit + '|' + p.eta; const now = Date.now();
  if (key === LA.key && now - LA.last < 15000) return; if (now - LA.last < 2000) return;
  LA.key = key; LA.last = now; NLA.update(p).catch(() => {});
}
async function laEnd() { if (!NLA) return; LA.on = false; try { await NLA.end(); } catch (e) {} }

/* ---------- stan ---------- */
const S = {
  veh: store.get('veh', { h: 3.1, l: 6.36, w: 2.05, t: 3.5 }),
  profiles: store.get('profiles', null), vehId: store.get('vehId', null),
  opt: Object.assign({ voice: true, d3: true, night: false, sim: false, roadNow: true, poiCol: true, events: true, nextChip: true, autoNight: false }, store.get('opt', {})),
  via: [], avoid: store.get('avoid', { highways: false, tolls: false }), avoidCC: store.get('avoidCC', {}),
  mode: store.get('mode', 'fast'),
  from: null, to: null,          // {name, lon, lat} | null = bieżąca pozycja
  route: null,                   // odpowiedź /gps/route
  nav: false,                    // czy trwa jazda
  pos: null,                     // {lon, lat, speed(m/s), heading, t}
  follow: true,
  tab: 'trasa',
};
const STYLE = { light: 'https://tiles.openfreemap.org/styles/liberty', dark: 'https://tiles.openfreemap.org/styles/dark' };
const styleUrl = () => STYLE[S.opt.night ? 'dark' : 'light'];
S.opt.mapSrc = 'osm';

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
    container: 'map', style: styleUrl(), center: [19.05, 49.82], zoom: 13,
    pitch: 0, attributionControl: false, maxPitch: 70, fadeDuration: 0,
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'top-right');
  map.on('style.load', addLayers);
  // PWA na iOS: po starcie i po powrocie z tła kontener zmienia rozmiar bez zdarzenia resize
  const kick = () => { try { map.resize(); } catch (e) {} };
  [100, 400, 1000, 2500].forEach(t => setTimeout(kick, t));
  window.addEventListener('orientationchange', () => setTimeout(kick, 300));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(kick, 200); });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', () => setTimeout(kick, 50));
  map.on('resize', () => { if (S.tab === 'trasa' && S.route && document.activeElement && document.activeElement.tagName !== 'INPUT') fitRoute(); });
  map.on('rotate', () => { const el = $('#compassIco'); if (el) el.style.transform = `rotate(${-map.getBearing()}deg)`; });
  map.on('dragstart', () => { if (S.nav) { S.follow = false; $('#btnRecenter').hidden = false; clearTimeout(S.followT); S.followT = setTimeout(() => { S.follow = true; $('#btnRecenter').hidden = true; }, 30000); } });
  map.on('load', () => { mapReady = true; if (S.route) drawRoute(); const at = document.querySelector('.maplibregl-ctrl-attrib'); if (at) at.classList.remove('maplibregl-compact-show'); });
  const el = document.createElement('div'); el.className = 'me';
  el.innerHTML = '<svg viewBox="0 0 36 36"><path d="M18 3 L31 31 L18 24 L5 31 Z" fill="#3A74FF" stroke="#fff" stroke-width="3" stroke-linejoin="round"/></svg>';
  meMarker = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' });
}
let BUD3D = null;   // id warstwy budynków 3D (ze stylu Liberty albo nasza)
function tuneStyle() {
  BUD3D = null;
  document.getElementById('map').style.filter = (S.opt.mapSrc === 'tomtom' && S.opt.night) ? 'invert(0.9) hue-rotate(180deg) saturate(0.7) brightness(0.9)' : '';
  if (S.opt.mapSrc === 'tomtom') return;
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
  else if (!map.getLayer('bud3d') && map.getSource('openmaptiles')) {
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
    map.addLayer({ id: 'route-traffic', type: 'line', source: 'route', filter: ['==', 'k', 'tr'], layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'c'], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 9] } });
    map.addLayer({ id: 'route-pts', type: 'circle', source: 'route', filter: ['==', 'k', 'pt'],
      paint: { 'circle-radius': 7, 'circle-color': ['get', 'c'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
  }
  if (!map.getSource('poi')) {
    map.addSource('poi', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'poi-pts', type: 'circle', source: 'poi', minzoom: 9,
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 4, 14, 9], 'circle-color': ['match', ['get', 'kind'], 'fuel', '#F2C230', 'dump', '#3A74FF', 'caravan', '#1E8A4C', 'mop', '#5A6478', 'rest', '#5A6478', 'parking', '#5A6478', '#1E8A4C'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    map.on('click', 'poi-pts', e => { const f = e.features[0]; if (f) openPoi(f.properties.id); });
  }
  if (S.route) drawRoute();
  if (S.routes && !S.nav) drawAlts();
  if (S.poi) drawPoi();
}
const TRAFFIC_COLOR = m => m >= 3 ? '#D92D20' : m === 2 ? '#F2A33A' : '#F2C230';
function fitRoute() {
  const r = S.route; if (!r || !r.bbox) return;
  const bb = (S.routes || [r]).reduce((b, x) => [Math.min(b[0], x.bbox[0]), Math.min(b[1], x.bbox[1]), Math.max(b[2], x.bbox[2]), Math.max(b[3], x.bbox[3])], r.bbox.slice());
  map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: { top: ($('#sheet .top')?.offsetHeight || 230) + 40, bottom: ($('#tBottom')?.offsetHeight || 180) + 40, left: 40, right: 40 }, pitch: 0, bearing: 0, duration: 600 });
}
function drawRoute() {
  if (!map.getSource('route')) return;
  const r = S.route, f = [];
  f.push({ type: 'Feature', properties: { k: 'main' }, geometry: { type: 'LineString', coordinates: r.coords } });
  for (const t of r.traffic || []) if (t.b > t.a) f.push({ type: 'Feature', properties: { k: 'tr', c: TRAFFIC_COLOR(t.mag) }, geometry: { type: 'LineString', coordinates: r.coords.slice(t.a, t.b + 1) } });
  f.push({ type: 'Feature', properties: { k: 'pt', c: '#3A74FF' }, geometry: { type: 'Point', coordinates: r.coords[0] } });
  f.push({ type: 'Feature', properties: { k: 'pt', c: '#1a1d24' }, geometry: { type: 'Point', coordinates: r.coords[r.coords.length - 1] } });
  map.getSource('route').setData({ type: 'FeatureCollection', features: f });
  if (!S.nav) fitRoute();
}
function setView3d(on) {
  S.opt.d3 = on; store.set('opt', S.opt); $('#opt3d').checked = on; $('#btnView').textContent = on ? '3D' : '2D';
  if (BUD3D && map.getLayer(BUD3D)) map.setLayoutProperty(BUD3D, 'visibility', on ? 'visible' : 'none');
  map.easeTo({ pitch: on && S.nav ? 58 : 0, duration: 500 });
}
function setNight(on) {
  S.opt.night = on; store.set('opt', S.opt); document.body.classList.toggle('night', on); $('#optNight').checked = on;
  map.setStyle(styleUrl(), { diff: false });
}

/* ---------- wyszukiwanie (karta jak w Sygic) ---------- */
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const HIST = { get: () => store.get('hist', []), add: (p) => { const h = HIST.get().filter(x => !(Math.abs(x.lon - p.lon) < 1e-4 && Math.abs(x.lat - p.lat) < 1e-4)); h.unshift({ name: p.name, label: p.label || '', lon: p.lon, lat: p.lat, t: Date.now() }); store.set('hist', h.slice(0, 15)); }, clear: () => store.set('hist', []) };
const FAV = { get: () => store.get('fav', []), set: (f) => store.set('fav', f),
  has: (p) => FAV.get().some(x => Math.abs(x.lon - p.lon) < 1e-4 && Math.abs(x.lat - p.lat) < 1e-4),
  toggle: (p) => { const f = FAV.get(); const i = f.findIndex(x => Math.abs(x.lon - p.lon) < 1e-4 && Math.abs(x.lat - p.lat) < 1e-4); if (i >= 0) f.splice(i, 1); else f.push({ name: p.name, label: p.label || '', lon: p.lon, lat: p.lat }); FAV.set(f); } };
let SF = { field: 'to', cat: null, results: [] };
function setField(field, pt) {
  if (field === 'from') { S.from = pt; $('#from').textContent = pt ? pt.name : 'Bieżąca pozycja'; $('#from').classList.toggle('empty', !pt); }
  else if (field === 'to') { S.to = pt; $('#to').textContent = pt ? pt.name : 'Dokąd jedziemy?'; $('#to').classList.toggle('empty', !pt); }
  else if (field === 'via' && pt) { S.via.push(pt); renderViaChips(); }
  if (pt && field !== 'from') HIST.add(pt);
  if (S.to) computeRoute(); else { S.route = null; S.routes = null; $('#btnGo').classList.add('hidden'); $('#tSum').classList.add('hidden'); $('#tDots').innerHTML = ''; altMarkers.forEach(m => m.remove()); altMarkers = []; if (map.getSource('route')) map.getSource('route').setData({ type: 'FeatureCollection', features: [] }); if (map.getSource('alts')) map.getSource('alts').setData({ type: 'FeatureCollection', features: [] }); }
}
function openSearch(field) {
  SF = { field, cat: null, results: [] };
  $('#sInput').value = ''; $('#sInput').placeholder = field === 'from' ? 'Skąd?' : field === 'via' ? 'Punkt pośredni' : 'Dokąd?';
  $('#sugg').classList.add('hidden'); $('#sClear').hidden = true;
  $$('#search .scats button').forEach(b => b.removeAttribute('aria-pressed'));
  renderSearchHome(); showTab('search'); setTimeout(() => $('#sInput').focus(), 80);
}
function closeSearch() { $('#sInput').blur(); showTab('trasa'); }
function pick(pt) { setField(SF.field, pt); closeSearch(); }
const ICO_PIN = '<svg viewBox="0 0 24 24" width="24" height="24" fill="#D92D20"><path d="M12 22s-7-6.6-7-12a7 7 0 0 1 14 0c0 5.4-7 12-7 12z"/><circle cx="12" cy="10" r="2.5" fill="#fff"/></svg>';
const ICO_NAV = '<svg viewBox="0 0 24 24" width="24" height="24" fill="#5B8CFF"><path d="M12 2 L21 21 L12 16 L3 21 Z"/></svg>';
const ICO_HOME = '<svg viewBox="0 0 24 24" width="24" height="24" fill="#fff"><path d="M3 11 L12 3 L21 11 V21 H14 V15 H10 V21 H3 Z"/></svg>';
const ICO_MAP = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#5B8CFF" stroke-width="2"><path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/></svg>';
const ICO_STAR = '<svg viewBox="0 0 24 24" width="24" height="24" fill="#F2C230"><path d="M12 2l3 7 7 .6-5.3 4.6 1.7 7L12 17.5 5.6 21.2l1.7-7L2 9.6 9 9z"/></svg>';
function rowHtml({ ic, name, sub, subCls = '', data = '', star = null }) {
  return `<div class="si" ${data}><span class="ic">${ic}</span><div><b>${esc(name)}</b>${sub ? `<small class="${subCls}">${esc(sub)}</small>` : ''}</div>${star !== null ? `<button type="button" class="star${star ? ' on' : ''}" data-star aria-label="Ulubione">★</button>` : ''}</div>`;
}
function renderSearchHome() {
  const L = $('#sList'); let html = '';
  html += rowHtml({ ic: ICO_MAP, name: 'Wybierz z mapy', data: 'data-act="map"' });
  if (SF.field === 'from') html += rowHtml({ ic: ICO_NAV, name: 'Bieżąca pozycja', sub: S.pos ? 'GPS' : 'czekam na GPS…', data: 'data-act="gps"' });
  const home = FAV.get().find(f => f.home);
  html += home ? rowHtml({ ic: ICO_HOME, name: 'Dom', sub: home.name, data: `data-pt="${esc(JSON.stringify(home))}"` }) : rowHtml({ ic: ICO_HOME, name: 'Ustaw Dom', sub: 'zapisz bieżącą pozycję jako Dom', data: 'data-act="sethome"' });
  const favs = FAV.get().filter(f => !f.home);
  if (favs.length) { html += '<div class="sh"><span>Ulubione</span></div>'; html += favs.map(f => rowHtml({ ic: ICO_STAR, name: f.name, sub: f.label, data: `data-pt="${esc(JSON.stringify(f))}"`, star: true })).join(''); }
  const hist = HIST.get();
  if (hist.length) { html += '<div class="sh"><span>Ostatnie wyszukiwania</span><button type="button" data-act="clearhist">Wyczyść historię</button></div>'; html += hist.map(x => rowHtml({ ic: ICO_PIN, name: x.name, sub: (x.t ? new Date(x.t).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' }) + ' • ' : '') + (x.label || ''), data: `data-pt="${esc(JSON.stringify(x))}"`, star: FAV.has(x) })).join(''); }
  L.innerHTML = html;
}
let suggT;
async function suggest(q) {
  const ul = $('#sugg'); if (q.length < 2) { ul.classList.add('hidden'); return; }
  let j; try { j = await (await fetch(API + '/geocode?q=' + encodeURIComponent(q))).json(); } catch (e) { return; }
  if ($('#sInput').value.trim() !== q) return;
  ul._res = j.results || []; ul.innerHTML = ul._res.slice(0, 8).map((x, i) => `<li data-i="${i}">${esc(x.label || x.name)}</li>`).join(''); ul.classList.toggle('hidden', !ul.innerHTML);
}
$('#sInput').addEventListener('input', () => { const q = $('#sInput').value.trim(); $('#sClear').hidden = !q; clearTimeout(suggT); suggT = setTimeout(() => suggest(q), 250); });
$('#sClear').addEventListener('click', () => { $('#sInput').value = ''; $('#sClear').hidden = true; $('#sugg').classList.add('hidden'); $('#sInput').focus(); });
$('#sBack').addEventListener('click', closeSearch);
$('#sugg').addEventListener('click', e => { const li = e.target.closest('li'); if (!li) return; const x = $('#sugg')._res[+li.dataset.i]; pick({ name: x.name, label: x.label || '', lon: x.lon, lat: x.lat }); });
$('#sList').addEventListener('click', async e => {
  const st = e.target.closest('[data-star]'); if (st) { const row = st.closest('[data-pt]'); if (row) { FAV.toggle(JSON.parse(row.dataset.pt)); SF.cat ? renderCat() : renderSearchHome(); } return; }
  const row = e.target.closest('.si, .sh button'); if (!row) return;
  const act = row.dataset.act;
  if (act === 'map') { startPick(); return; }
  if (act === 'gps') { if (!S.pos) { startGps(); return; } pick({ name: 'Bieżąca pozycja', lon: S.pos.lon, lat: S.pos.lat }); return; }
  if (act === 'sethome') { if (!S.pos) { alert('Czekam na pozycję GPS.'); return; } let name = 'Dom'; try { const j = await (await fetch(API + `/gps/revgeo?lat=${S.pos.lat}&lon=${S.pos.lon}`)).json(); name = j.name || name; } catch (e) {} const f = FAV.get().filter(x => !x.home); f.unshift({ name, lon: S.pos.lon, lat: S.pos.lat, home: true }); FAV.set(f); renderSearchHome(); return; }
  if (act === 'clearhist') { HIST.clear(); renderSearchHome(); return; }
  if (row.dataset.pt) { const p = JSON.parse(row.dataset.pt); pick({ name: p.home ? 'Dom' : p.name, label: p.label || '', lon: p.lon, lat: p.lat }); }
});
// kategorie w pobliżu (OSM przez Worker, promień 15 km wokół pozycji)
$('#search .scats').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return; const cat = b.dataset.cat;
  if (SF.cat === cat) { SF.cat = null; b.removeAttribute('aria-pressed'); renderSearchHome(); return; }
  $$('#search .scats button').forEach(x => x.removeAttribute('aria-pressed')); b.setAttribute('aria-pressed', 'true'); SF.cat = cat;
  if (cat === 'fav') { const favs = FAV.get(); $('#sList').innerHTML = favs.length ? favs.map(f => rowHtml({ ic: f.home ? ICO_HOME : ICO_STAR, name: f.home ? 'Dom' : f.name, sub: f.label || f.name, data: `data-pt="${esc(JSON.stringify(f))}"`, star: !f.home })).join('') : '<p class="note">Brak ulubionych. Dodaj ★ przy wyniku lub w historii.</p>'; return; }
  if (!S.pos) { $('#sList').innerHTML = '<p class="note">Czekam na pozycję GPS…</p>'; return; }
  $('#sList').innerHTML = '<p class="note">Szukam w pobliżu…</p>';
  const c = [S.pos.lon, S.pos.lat], d = 0.02;
  try {
    const j = await (await fetch(API + '/gps/poi', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ coords: [[c[0] - d, c[1]], [c[0] + d, c[1]]], radius: 10000 }) })).json();
    const kinds = { parking: ['mop', 'rest', 'parking'], fuel: ['fuel'], camp: ['camp', 'caravan'], dump: ['dump'] }[cat] || [];
    SF.results = (j.items || []).filter(p => kinds.includes(p.kind) || (cat === 'dump' && p.dump)).map(p => ({ ...p, dist: dist(c, [p.lon, p.lat]) })).sort((x, y) => x.dist - y.dist).slice(0, 30);
    renderCat();
  } catch (e) { $('#sList').innerHTML = '<p class="note">Nie udało się pobrać miejsc.</p>'; }
});
function renderCat() {
  const L = $('#sList'); if (!SF.results.length) { L.innerHTML = '<p class="note">Nic w pobliżu (15 km).</p>'; return; }
  L.innerHTML = SF.results.map(p => { const [label] = POI_KIND[p.kind] || POI_KIND.camp; const pt = { name: p.name || label, label, lon: p.lon, lat: p.lat }; return rowHtml({ ic: ICO_PIN, name: pt.name, sub: label + ' · ' + fmtDist(p.dist), subCls: 'g', data: `data-pt="${esc(JSON.stringify(pt))}"`, star: FAV.has(pt) }); }).join('');
}
// wybór z mapy: celownik na środku, nazwa z reverse geocodingu
let pickT;
function startPick() {
  $('#search').classList.add('hidden'); $('#sheet').classList.add('hidden'); $('#pick').classList.remove('hidden');
  map.easeTo({ pitch: 0, duration: 300 }); updatePickName();
  map.on('moveend', updatePickName);
}
async function updatePickName() {
  clearTimeout(pickT); pickT = setTimeout(async () => { const c = map.getCenter(); $('#pickName').textContent = '…'; try { const j = await (await fetch(API + `/gps/revgeo?lat=${c.lat}&lon=${c.lng}`)).json(); $('#pickName').textContent = j.name || ''; $('#pickName').dataset.name = j.name || ''; } catch (e) { $('#pickName').textContent = c.lat.toFixed(4) + ', ' + c.lng.toFixed(4); } }, 300);
}
function endPick(ok) {
  map.off('moveend', updatePickName); $('#pick').classList.add('hidden');
  if (ok) { const c = map.getCenter(); pick({ name: $('#pickName').dataset.name || $('#pickName').textContent || 'Punkt z mapy', lon: c.lng, lat: c.lat }); }
  else showTab('search');
}
$('#pickOk').addEventListener('click', () => endPick(true));
$('#pickCancel').addEventListener('click', () => endPick(false));
$('#sheet').addEventListener('click', e => { const b = e.target.closest('button[data-field]'); if (!b) return; openSearch(b.dataset.field); });
function renderViaChips() { $('#viaChips').innerHTML = S.via.map((v, i) => `<span>${esc(v.name)}<button type="button" data-vrm="${i}" aria-label="Usuń">✕</button></span>`).join(''); }
$('#viaChips').addEventListener('click', e => { const b = e.target.closest('[data-vrm]'); if (!b) return; S.via.splice(+b.dataset.vrm, 1); renderViaChips(); if (S.to) computeRoute(); });

/* ---------- pojazd: kilka profili ---------- */
function vehInit() {
  if (!S.profiles || !S.profiles.length) { S.profiles = [{ id: 'p1', name: 'Kamper', ...S.veh }]; S.vehId = 'p1'; store.set('profiles', S.profiles); store.set('vehId', S.vehId); }
  const cur = S.profiles.find(p => p.id === S.vehId) || S.profiles[0]; S.vehId = cur.id; S.veh = { h: cur.h, l: cur.l, w: cur.w, t: cur.t }; store.set('veh', S.veh);
}
function vehLine() { const p = S.profiles.find(x => x.id === S.vehId) || {}; $('#tVehTxt').textContent = `${p.name || 'Kamper'} · ${fmt1(S.veh.h)} m · ${fmt1(S.veh.t)} t`; }
const fmt1 = n => String(Math.round(n * 100) / 100).replace('.', ',');
const num = s => parseFloat(String(s).replace(',', '.'));
let vehEdit = null; // id edytowanego profilu
function renderVehList() {
  $('#vehList').innerHTML = S.profiles.map(p => `<div class="vp${p.id === S.vehId ? ' on' : ''}" data-vid="${p.id}"><i></i><div><b>${esc(p.name)}</b><small>${fmt1(p.h)} m · ${fmt1(p.l)} m · ${fmt1(p.w)} m · ${fmt1(p.t)} t</small></div></div>`).join('');
}
function fillVeh(id) {
  vehEdit = id || S.vehId; const p = S.profiles.find(x => x.id === vehEdit) || S.profiles[0];
  $('#vName').value = p.name; $('#vH').value = fmt1(p.h); $('#vL').value = fmt1(p.l); $('#vW').value = fmt1(p.w); $('#vT').value = fmt1(p.t);
  $('#btnVehDel').disabled = S.profiles.length < 2; renderVehList();
}
$('#vehList').addEventListener('click', e => { const r = e.target.closest('[data-vid]'); if (!r) return; S.vehId = r.dataset.vid; store.set('vehId', S.vehId); vehInit(); vehLine(); fillVeh(S.vehId); S.route = null; $('#btnGo').classList.add('hidden'); });
$('#vehAdd').addEventListener('click', () => { const id = 'p' + Date.now(); S.profiles.push({ id, name: 'Nowy profil', ...S.veh }); store.set('profiles', S.profiles); fillVeh(id); $('#vName').focus(); $('#vName').select(); });
$('#btnVehSave').addEventListener('click', () => {
  const v = { h: num($('#vH').value), l: num($('#vL').value), w: num($('#vW').value), t: num($('#vT').value) };
  if (![v.h, v.l, v.w, v.t].every(Number.isFinite)) return alert('Wpisz liczby, np. 3,10');
  const p = S.profiles.find(x => x.id === vehEdit); if (!p) return;
  Object.assign(p, v, { name: ($('#vName').value.trim() || 'Kamper') }); S.vehId = p.id; store.set('profiles', S.profiles); store.set('vehId', S.vehId);
  vehInit(); vehLine(); S.route = null; $('#btnGo').classList.add('hidden'); showTab(S.nav ? 'jazda' : (S.openedFrom === 'trasa' ? 'trasa' : 'jazda')); S.openedFrom = null; if (S.to && !S.nav) computeRoute();
});
$('#btnVehDel').addEventListener('click', () => {
  if (S.profiles.length < 2) return; const p = S.profiles.find(x => x.id === vehEdit); if (!p || !confirm('Usunąć profil „' + p.name + '"?')) return;
  S.profiles = S.profiles.filter(x => x.id !== vehEdit); if (S.vehId === vehEdit) S.vehId = S.profiles[0].id; store.set('profiles', S.profiles); store.set('vehId', S.vehId); vehInit(); vehLine(); fillVeh(S.vehId);
});

/* ---------- trasa ---------- */
$('#modes').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  S.mode = b.dataset.mode; store.set('mode', S.mode);
  $$('#modes button').forEach(x => x.setAttribute('aria-pressed', x === b));
  if (S.route) computeRoute();
});
$('#btnRoute').addEventListener('click', () => computeRoute());
function setSheetHalf() {}
async function computeRoute(fromPos) {
  const msg = $('#msg'); msg.textContent = '';
  if (!API) { msg.textContent = 'Brak adresu API w assets/config.js.'; return; }
  const from = fromPos || S.from || (S.pos ? { lon: S.pos.lon, lat: S.pos.lat } : null);
  if (!from) { msg.textContent = 'Czekam na pozycję GPS… albo wpisz punkt startu.'; startGps(); return null; }
  if (!S.to) { msg.textContent = 'Wybierz cel z listy podpowiedzi.'; return null; }
  $('#btnRoute').disabled = true; msg.textContent = 'Liczę trasę…';
  const body = { from: [from.lon, from.lat], to: [S.to.lon, S.to.lat], via: S.via.map(v => [v.lon, v.lat]), mode: S.mode,
    camper: { height: S.veh.h, width: S.veh.w, length: S.veh.l, weight: S.veh.t }, avoid: { highways: !!S.avoid.highways, tolls: !!S.avoid.tolls }, avoidByCountry: S.avoidCC };
  let j;
  try {
    const r = await fetch(API + '/gps/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    j = await r.json(); if (!r.ok) throw new Error(j.error || ('Błąd ' + r.status));
  } catch (e) { msg.textContent = e.message; $('#btnRoute').disabled = false; return null; }
  $('#btnRoute').disabled = false; msg.textContent = '';
  j.total = j.cum[j.cum.length - 1];
  // warianty z TomTom: główna + alternatywy, każda jako pełna trasa
  S.routes = fromPos ? [j] : [j, ...(j.alts || []).map(alt => ({ ...j, ...alt, alts: undefined, total: alt.cum[alt.cum.length - 1] }))];
  delete j.alts; S.altIdx = 0; S.route = j;
  if (!fromPos) { renderSummary(); drawRoute(); drawAlts(); $('#btnGo').classList.remove('hidden'); }
  return j;
}
function selectAlt(i) {
  if (!S.routes || !S.routes[i]) return;
  S.altIdx = i; S.route = S.routes[i]; renderSummary(); drawRoute(); drawAlts();
  if (S.nav) { NAV.idx = 0; NAV.prog = 0; NAV.stepI = 0; NAV.said = {}; drawProgressMarks(); }
}
let altMarkers = [];
function drawAlts() {
  altMarkers.forEach(m => m.remove()); altMarkers = [];
  if (!mapReady || !map.getLayer('route-case')) return;
  if (!map.getSource('alts')) { map.addSource('alts', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'alts-line', type: 'line', source: 'alts', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#8E95A3', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 4, 14, 9], 'line-opacity': 0.9 } }, 'route-case');
    map.on('click', 'alts-line', e => { const f = e.features[0]; if (f) selectAlt(f.properties.i); }); }
  const rs = S.routes || []; const feats = [];
  rs.forEach((r, i) => {
    if (i !== S.altIdx) feats.push({ type: 'Feature', properties: { i }, geometry: { type: 'LineString', coordinates: r.coords } });
    if (rs.length > 1 && S.tab === 'trasa') {
      const mid = r.coords[Math.floor(r.coords.length * (0.4 + i * 0.1))];
      const el = document.createElement('div'); el.className = 'bub' + (i === S.altIdx ? ' on' : ''); el.textContent = hm(r.sec); el.addEventListener('click', () => selectAlt(i));
      altMarkers.push(new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(mid).addTo(map));
    }
  });
  map.getSource('alts').setData({ type: 'FeatureCollection', features: feats });
  $('#tDots').innerHTML = rs.length > 1 ? rs.map((_, i) => `<i data-alt="${i}" class="${i === S.altIdx ? 'on' : ''}"></i>`).join('') : '';
}
$('#tDots').addEventListener('click', e => { const d = e.target.closest('[data-alt]'); if (d) selectAlt(+d.dataset.alt); });
// przesunięcie palcem po dolnej karcie przełącza wariant
let swX = null;
$('#tBottom').addEventListener('touchstart', e => { swX = e.touches[0].clientX; }, { passive: true });
$('#tBottom').addEventListener('touchend', e => { if (swX == null || !S.routes || S.routes.length < 2) return; const dx = e.changedTouches[0].clientX - swX; swX = null; if (Math.abs(dx) < 40) return; selectAlt((S.altIdx + (dx < 0 ? 1 : S.routes.length - 1)) % S.routes.length); });
function renderSummary() {
  const r = S.route, eta = new Date(Date.now() + r.sec * 1000);
  const tunnelsTxt = (r.tunnels || []).length ? `<span class="tag">tunele ${r.tunnels.length}</span>` : '';
  $('#tSum').classList.remove('hidden');
  $('#tSum').innerHTML = `<div class="l1"><b>${hm(r.sec)}</b><i>•</i><span>${hhmm(eta)}${eta.getDate() !== new Date().getDate() ? ' jutro' : ''}</span><i>•</i><span>${Math.round(r.km)} km</span></div>
    <div class="l2">${r.engine === 'tomtom' ? (r.delay > 60 ? '<span class="bad">🚗 +' + Math.round(r.delay / 60) + ' min przez ruch</span>' : '<span class="ok">🚗 Brak opóźnień</span>') : '<span>ORS</span>'}
    <span class="tag">${(r.path || []).join(' › ')}</span>${tunnelsTxt}${r.ttError ? '<span class="bad">TomTom: ' + esc(r.ttError) + '</span>' : ''}</div>`;
  $('#tOptsTxt').textContent = ({ fast: 'Szybka', main: 'Główne drogi', notoll: 'Bez opłat', eco: 'Ekonomiczna' })[S.mode] + ' · Unikaj';
  drawProgressMarks(); fillCountryTable($('#rCcTable')); fillRouteOpts();
  loadPoi(); loadLimits();
}
const KRAJ = { PL: 'Polska', CZ: 'Czechy', SK: 'Słowacja', AT: 'Austria', DE: 'Niemcy', IT: 'Włochy', HU: 'Węgry', SI: 'Słowenia', HR: 'Chorwacja', FR: 'Francja', CH: 'Szwajcaria', NL: 'Holandia', BE: 'Belgia', DK: 'Dania', SE: 'Szwecja', NO: 'Norwegia', ES: 'Hiszpania', PT: 'Portugalia', LT: 'Litwa', LV: 'Łotwa', EE: 'Estonia', RO: 'Rumunia', BG: 'Bułgaria', GR: 'Grecja', RS: 'Serbia', BA: 'Bośnia', ME: 'Czarnogóra', AL: 'Albania', MK: 'Macedonia Płn.', LU: 'Luksemburg', GB: 'Wielka Brytania', IE: 'Irlandia', FI: 'Finlandia', UA: 'Ukraina' };
const hm = s => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h}:${String(m).padStart(2, '0')} h` : `${m} min`; };
const hhmm = d => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');

/* ---------- ograniczenia prędkości (TomTom Snap to Roads) ---------- */
async function loadLimits() {
  const r = S.route; if (!r || !API) return;
  // próbkujemy co ~300 m (maks. 1200 punktów) – Snap to Roads zwraca odcinki dróg z limitami
  const every = Math.max(300, r.total / 1200);
  const coords = []; let next = 0;
  for (let i = 0; i < r.coords.length; i++) { if (r.cum[i] >= next) { coords.push(r.coords[i]); next = r.cum[i] + every; } }
  if (coords[coords.length - 1] !== r.coords[r.coords.length - 1]) coords.push(r.coords[r.coords.length - 1]);
  let j;
  try { const res = await fetch(API + '/gps/limits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ coords }) }); j = await res.json(); if (!res.ok) throw new Error(j.error); }
  catch (e) { console.warn('limits', e); return; }
  if (S.route !== r) return;
  // odcinek z limitem → indeksy naszej trasy (przez próbkę co ~600 pkt)
  const samp = r.coords.map((c, i) => [c, i]).filter((_, i) => i % Math.max(1, Math.ceil(r.coords.length / 1500)) === 0);
  const near = p => { let best = Infinity, bi = 0; for (const [c, i] of samp) { const d = dist(c, p); if (d < best) { best = d; bi = i; } } return best < 150 ? bi : -1; };
  const lim = [];
  for (const [x1, y1, x2, y2, kmh] of j.segs || []) {
    const a = near([x1, y1]), b = near([x2, y2]); if (a < 0 || b < 0) continue;
    lim.push({ a: Math.min(a, b), b: Math.max(a, b) + 1, kmh });
  }
  lim.sort((p, q) => p.a - q.a);
  r.limits = lim;
}

/* ---------- asystent pasów: OSM turn:lanes przy manewrach ---------- */
async function loadLanes() {
  const r = S.route; if (!r || !API) return; r.lanes = null;
  const idx = []; for (let i = 1; i < r.steps.length; i++) { const t = r.steps[i].t; if (t !== 6 && t !== 10 && t !== 11) idx.push(i); }
  const take = idx.slice(0, 80); if (!take.length) return;
  try {
    const j = await (await fetch(API + '/gps/lanes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ points: take.map(i => r.coords[r.steps[i].wp[0]]) }) })).json();
    if (S.route !== r) return; r.lanes = {}; take.forEach((i, k) => { if (j.lanes && j.lanes[k]) r.lanes[i] = j.lanes[k].l; });
  } catch (e) {}
}
const LANE_DIR = { 0: 'left', 1: 'right', 2: 'left', 3: 'right', 4: 'slight_left', 5: 'slight_right', 9: 'reverse', 12: 'slight_left', 13: 'slight_right', 7: 'through', 8: 'right' };
const LANE_ARROW = { left: 'M12 20V10a4 4 0 0 1 4-4h0', right: 'M12 20V10a4 4 0 0 0-4-4h0', through: 'M12 20V5', slight_left: 'M12 20V12l-4-5', slight_right: 'M12 20V12l4-5', sharp_left: 'M12 20V13L5 9', sharp_right: 'M12 20V13l7-4', reverse: 'M12 20V9a3 3 0 0 1 6 0v3', merge_to_left: 'M12 20V12l-4-5', merge_to_right: 'M12 20V12l4-5', none: 'M12 20V5' };
const LANE_HEAD = { left: 'M9 6l-3 0 0 3', right: 'M15 6l3 0 0 3', through: 'M8 9l4-4 4 4', slight_left: 'M8 11V7h4', slight_right: 'M16 11V7h-4', sharp_left: 'M9 12L5 9l3-3', sharp_right: 'M15 12l4-3-3-3', reverse: 'M15 12l3 3 3-3', merge_to_left: 'M8 11V7h4', merge_to_right: 'M16 11V7h-4', none: 'M8 9l4-4 4 4' };
function renderLanes(stepI, distM) {
  const box = $('#lanes'); const r = S.route;
  const spec = r && r.lanes && r.lanes[stepI]; if (!spec || distM > 700) { box.classList.add('hidden'); return; }
  const want = LANE_DIR[r.steps[stepI].t] || 'through';
  const match = d => d === want || (want === 'left' && (d === 'slight_left' || d === 'sharp_left')) || (want === 'right' && (d === 'slight_right' || d === 'sharp_right')) || (want === 'slight_left' && d === 'left') || (want === 'slight_right' && d === 'right');
  const lanes = spec.split('|').map(l => (l || 'none').split(';'));
  box.innerHTML = lanes.map(ds => { const on = ds.some(match); return `<span class="ln${on ? ' on' : ''}">${ds.map(d => `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="${LANE_ARROW[d] || LANE_ARROW.none}"/><path d="${LANE_HEAD[d] || LANE_HEAD.none}"/></svg>`).join('')}</span>`; }).join('<i></i>');
  box.classList.remove('hidden');
}

/* ---------- POI przy trasie ---------- */
let PRICES = null;
async function loadPrices() { if (PRICES) return PRICES; try { const r = await fetch(API + '/prices'); PRICES = (await r.json()).prices || {}; } catch (e) { PRICES = {}; } return PRICES; }
async function loadPoi() {
  const r = S.route; if (!r || !API) return;
  S.poi = null; S.poiStatus = 'loading'; renderPoi();
  const step = Math.max(1, Math.ceil(r.coords.length / 250));
  const coords = r.coords.filter((_, i) => i % step === 0 || i === r.coords.length - 1);
  let j;
  try { const res = await fetch(API + '/gps/poi', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ coords, radius: 3000 }) }); j = await res.json(); if (!res.ok) throw new Error(j.error); }
  catch (e) { S.poiStatus = 'error:' + (e.message || 'błąd'); renderPoi(); return; }
  await loadPrices();
  // rzut każdego POI na trasę: indeks najbliższego punktu (po próbce) → dystans po trasie, kraj, zjazd
  const samp = r.coords.map((c, i) => [c, i]).filter((_, i) => i % Math.max(1, Math.ceil(r.coords.length / 600)) === 0);
  for (const p of j.items) {
    let best = Infinity, bi = 0;
    for (const [c, i] of samp) { const d = dist(c, [p.lon, p.lat]); if (d < best) { best = d; bi = i; } }
    p.at = r.cum[bi]; p.off = Math.round(best); p.idx = bi;
    const cr = (r.crossings || []).filter(c => c.idx <= bi); p.cc = cr.length ? cr[cr.length - 1].to : (r.path || [])[0] || '';
  }
  j.items.sort((x, y) => x.at - y.at);
  S.poi = j.items; S.poiFilter = S.poiFilter || 'all'; S.poiStatus = 'ok:' + j.count;
  drawPoi(); renderPoi(); updatePoiCol();
}
const POI_KIND = { camp: ['Kemping', '#1E8A4C'], caravan: ['Kemping (kampery)', '#1E8A4C'], dump: ['Zrzut / woda', '#3A74FF'], fuel: ['Stacja', '#B7791F'], mop: ['MOP', '#5A6478'], rest: ['Parking przy drodze', '#5A6478'], parking: ['Parking dla kamperów', '#5A6478'] };
function drawPoi() {
  if (!map.getSource('poi') || !S.poi) return;
  map.getSource('poi').setData({ type: 'FeatureCollection', features: S.poi.map(p => ({ type: 'Feature', properties: { id: p.id, kind: p.kind }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } })) });
}
function renderPoi() {
  const list = $('#poiList'); const st = S.poiStatus || '';
  $('#poiStatus').textContent = st === 'loading' ? 'Szukam w OSM…' : st.startsWith('error:') ? 'Błąd: ' + st.slice(6) : st.startsWith('ok:') ? st.slice(3) + ' miejsc przy trasie' : '';
  if (!S.poi) { list.innerHTML = '<p class="note">' + (st === 'loading' ? 'Szukam kempingów, zrzutów, parkingów i stacji wzdłuż trasy…' : st.startsWith('error:') ? 'Nie udało się pobrać POI. Spróbuj „Odśwież".' : 'Wyznacz trasę — pokażę kempingi, zrzuty, wodę, LPG, parkingi i stacje wzdłuż niej.') + '</p>'; return; }
  const f = S.poiFilter, prog = S.nav ? NAV.prog : 0;
  const items = S.poi.filter(p => p.at >= prog - 500 && (f === 'all' || (f === 'camp' && (p.kind === 'camp' || p.kind === 'caravan')) || (f === 'dump' && (p.kind === 'dump' || p.dump)) || (f === 'water' && (p.water || p.kind === 'dump')) || (f === 'fuel' && p.kind === 'fuel') || (f === 'park' && ['mop', 'rest', 'parking'].includes(p.kind))));
  if (!items.length) { list.innerHTML = '<p class="note">Nic takiego przy trasie.</p>'; return; }
  list.innerHTML = items.slice(0, 80).map(p => {
    const [label, col] = POI_KIND[p.kind] || POI_KIND.camp; const pr = PRICES && PRICES[p.cc];
    let sub = '';
    if (p.kind === 'fuel') sub = [pr && pr.diesel ? 'ON ~' + fmt1(pr.diesel) + ' zł' : '', p.h24 ? '24 h' : ''].filter(Boolean).join(' · ');
    else sub = [p.dump ? 'zrzut' : '', p.water ? 'woda' : '', p.motorhome ? 'kampery' : '', p.fee === 'no' ? 'bezpłatny' : '', p.hours].filter(Boolean).join(' · ');
    return `<div class="poi-it" data-id="${p.id}"><i style="background:${col}"></i><div><b>${esc(p.name || label)}</b><small>${esc(label + (sub ? ' · ' + sub : ''))}</small></div><div class="r"><b>${fmtDist(Math.max(0, p.at - prog))}</b><small>${p.off < 300 ? 'przy trasie' : '+' + fmtDist(p.off) + ' zjazd'}</small></div></div>`;
  }).join('');
}
function openPoi(id) {
  const p = (S.poi || []).find(x => x.id === id); if (!p) return;
  const [label] = POI_KIND[p.kind] || POI_KIND.camp;
  const html = `<b>${esc(p.name || label)}</b><br><small>${esc(label)}${p.hours ? ' · ' + esc(p.hours) : ''}</small><br>
    <button type="button" data-go="${p.id}" style="margin-top:8px;height:36px;border:0;border-radius:10px;background:#3A74FF;color:#fff;font-weight:700;padding:0 12px">Nawiguj tutaj</button>`;
  const pop = new maplibregl.Popup({ offset: 10, closeButton: true }).setLngLat([p.lon, p.lat]).setHTML(html).addTo(map);
  pop.getElement().querySelector('[data-go]').addEventListener('click', () => { pop.remove(); goTo(p); });
}
function goTo(p) {
  S.to = { name: p.name || (POI_KIND[p.kind] || POI_KIND.camp)[0], lon: p.lon, lat: p.lat }; $('#to').textContent = S.to.name; $('#to').classList.remove('empty'); HIST.add(S.to);
  const wasNav = S.nav; if (wasNav) stopNav();
  showTab('trasa'); computeRoute().then(j => { if (j && wasNav) startNav(); });
}
$('#poiList').addEventListener('click', e => { const it = e.target.closest('.poi-it'); if (it) { const p = S.poi.find(x => x.id === it.dataset.id); if (p) { showTab('jazda'); map.easeTo({ center: [p.lon, p.lat], zoom: 14, pitch: 0, duration: 500 }); setTimeout(() => openPoi(p.id), 550); } } });
$('#poiReload').addEventListener('click', () => loadPoi());
$('#poiChips').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.poiFilter = b.dataset.f; $$('#poiChips button').forEach(x => x.setAttribute('aria-pressed', x === b)); renderPoi(); });

// przeliczenie w trakcie jazdy po zmianie opcji / punktu pośredniego – bez wychodzenia z nawigacji
async function recalcKeepNav() {
  if (!S.nav || !S.pos) { if (S.route) computeRoute(); return; }
  $('#manRoad').textContent = 'Przeliczam trasę…';
  const j = await computeRoute({ lon: S.pos.lon, lat: S.pos.lat }); if (!j) return;
  NAV.idx = 0; NAV.prog = 0; NAV.stepI = 0; NAV.said = {}; NAV.lastReroute = Date.now();
  drawRoute(); drawProgressMarks(); loadPoi(); loadLimits(); loadLanes(); updateHud(); speak('Trasa przeliczona.');
}

function fillRouteOpts() {
  $$('#rModes button').forEach(x => x.setAttribute('aria-pressed', x.dataset.mode === S.mode));
  $('#rAvoidMoto').checked = !!S.avoid.highways; $('#rAvoidToll').checked = !!S.avoid.tolls;
  const r = S.route; $('#rNote').textContent = r ? `${Math.round(r.km)} km · ${hm(r.sec)}${r.byCountry ? ' · odcinkami między granicami' : ''}` : '';
  fillCountryTable($('#rCcTable'));
}
document.addEventListener('click', e => {
  const cl = e.target.closest('#veh [data-close], #menu [data-close], #poi [data-close]');
  if (cl) { const cur = S.tab; const back = cur === 'menu' ? 'jazda' : (S.openedFrom && S.openedFrom !== cur ? S.openedFrom : 'jazda'); S.openedFrom = null; showTab(back); return; }
  const go = e.target.closest('#menu [data-go]'); if (go) { e.preventDefault(); S.openedFrom = 'menu'; showTab(go.dataset.go); }
});
$('#tBack').addEventListener('click', () => showTab('jazda'));
$('#fMenu').addEventListener('click', () => { S.openedFrom = 'jazda'; showTab('menu'); });
$('#tOpts').addEventListener('click', () => { fillRouteOpts(); $('#ropts').classList.remove('hidden'); });
$('#roptsClose').addEventListener('click', () => $('#ropts').classList.add('hidden'));
$('#tVeh').addEventListener('click', () => { S.openedFrom = 'trasa'; showTab('veh'); });
$('#rModes').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.mode = b.dataset.mode; store.set('mode', S.mode); fillRouteOpts(); if (S.to) computeRoute().then(fillRouteOpts); });
$('#rAvoidMoto').addEventListener('change', e => { S.avoid.highways = e.target.checked; store.set('avoid', S.avoid); if (S.to) computeRoute().then(fillRouteOpts); });
$('#rAvoidToll').addEventListener('change', e => { S.avoid.tolls = e.target.checked; store.set('avoid', S.avoid); if (S.to) computeRoute().then(fillRouteOpts); });

/* ---------- jazda ---------- */
const NAV = { idx: 0, prog: 0, offCount: 0, stepI: 0, said: {}, lastReroute: 0, lastFix: null, onRoute: false, fixT: 0, speed: 0, zoomT: 16.5 };
$('#btnGo').addEventListener('click', () => { startNav(); });
function startNav() {
  if (!S.route) return;
  S.nav = true; S.follow = true; NAV.idx = 0; NAV.prog = 0; NAV.offCount = 0; NAV.stepI = 0; NAV.said = {};
  showTab('jazda'); $('#hud').classList.remove('hidden'); altMarkers.forEach(m => m.remove()); altMarkers = []; if (map.getSource('alts')) map.getSource('alts').setData({ type: 'FeatureCollection', features: [] });
  speak('Rozpoczynam nawigację.'); keepAwake(); if (NBG) startBgGps(); setTimeout(laStart, 800);
  MK.zoom = 16; NAV.zoomT = 16.5; map.jumpTo({ pitch: S.opt.d3 ? 60 : 0, zoom: 16 });
  if (S.opt.sim) startSim(); else startGps();
  updateHud(); updatePoiCol(); applyOpts(); autoNight();
}
function stopNav() {
  S.nav = false; $('#poiCol').innerHTML = ''; $('#quick').classList.add('hidden'); $('#hud').classList.add('hidden'); stopSim(); $('#btnRecenter').hidden = true;
  map.easeTo({ pitch: 0, bearing: 0, zoom: 14.5, duration: 600 }); showTab('jazda');
  if (wake) { wake.release().catch(() => {}); wake = null; }
  stopBgGps(); laEnd(); if (NKA) NKA.allowSleep().catch(() => {});
}

/* płynna strzałka + kamera: jedna pętla rAF; między pozycjami GPS pozycja jest przewidywana wzdłuż trasy */
const MK = { cur: null, curH: 0, zoom: 16.5, raf: null, last: null };
function setMarkerTarget(p, heading) { if (!MK.cur) { MK.cur = p; MK.curH = heading; } MK.tgt = p; MK.tgtH = heading; MK.tgtT = performance.now(); if (!MK.raf) MK.raf = requestAnimationFrame(tickMarker); }
function routePointAt(prog) {
  const r = S.route; let i = Math.max(0, Math.min(NAV.idx, r.cum.length - 2));
  while (i < r.cum.length - 2 && r.cum[i + 1] < prog) i++;
  while (i > 0 && r.cum[i] > prog) i--;
  const a = r.coords[i], b = r.coords[i + 1], t = Math.max(0, Math.min(1, (prog - r.cum[i]) / Math.max(1, r.cum[i + 1] - r.cum[i])));
  return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], h: bearing(a, b) };
}
function tickMarker(now) {
  MK.raf = requestAnimationFrame(tickMarker);
  let p, h;
  if (S.nav && NAV.onRoute && S.route) {
    // przewidywanie po trasie: ostatni postęp + prędkość × czas od ostatniej pozycji (maks. 2 s w przód)
    const dt = Math.min(2, Math.max(0, (now - NAV.fixT) / 1000));
    const q = routePointAt(NAV.prog + NAV.speed * dt); p = q.p; h = NAV.speed > 1.5 ? q.h : MK.curH;
  } else if (MK.tgt) {
    // poza trasą: interpolacja do ostatniej pozycji
    const k = Math.min(1, (now - MK.tgtT) / 700);
    p = [MK.cur[0] + (MK.tgt[0] - MK.cur[0]) * k, MK.cur[1] + (MK.tgt[1] - MK.cur[1]) * k]; h = MK.tgtH;
  } else return;
  // wygładzenie obrotu
  let dh = ((h - MK.curH + 540) % 360) - 180; MK.curH = (MK.curH + dh * 0.15 + 360) % 360;
  MK.cur = p;
  meMarker.setLngLat(p).setRotation(MK.curH);
  if (S.nav && S.follow && S.tab === 'jazda') {
    MK.zoom += (NAV.zoomT - MK.zoom) * 0.05;
    map.jumpTo({ center: p, bearing: MK.curH, zoom: MK.zoom, pitch: S.opt.d3 ? 60 : 0, padding: { top: window.innerHeight * 0.38, bottom: 0 } });
  }
}

/* GPS */
let watchId = null, bgWatch = null;
async function startBgGps() {
  if (!NBG || bgWatch) return;
  try {
    bgWatch = await NBG.addWatcher({ backgroundMessage: 'Nawigacja prowadzi po trasie.', backgroundTitle: 'GdziePoniesie GPS', requestPermissions: true, stale: false, distanceFilter: 3 },
      (loc, err) => { if (err || !loc) return; onFix({ lon: loc.longitude, lat: loc.latitude, speed: loc.speed, heading: loc.bearing, acc: loc.accuracy, t: loc.time || Date.now() }); });
  } catch (e) { bgWatch = null; }
}
async function stopBgGps() { if (NBG && bgWatch) { try { await NBG.removeWatcher({ id: bgWatch }); } catch (e) {} bgWatch = null; } }
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
  setMarkerTarget([f.lon, f.lat], f.heading || 0);
  if (!meMarker._added) { meMarker.addTo(map); meMarker._added = true; setTimeout(() => autoNight(), 500); if (!S.nav && !S.route) map.jumpTo({ center: [f.lon, f.lat], zoom: 14.5, pitch: 0, bearing: 0 }); }
  if (!S.nav) { if (S.from === null) $('#from').textContent = 'Bieżąca pozycja (GPS)'; if (S.to && !S.route && !onFix._auto) { onFix._auto = true; computeRoute(); } return; }
  navStep(f);
}
function navStep(f) {
  const r = S.route, p = [f.lon, f.lat];
  const sn = snap(p, r.coords, r.cum, NAV.idx);
  if (sn.off > 60) { NAV.offCount++; } else { NAV.offCount = 0; NAV.idx = sn.idx; NAV.prog = sn.prog; }
  // przeliczenie tylko w ruchu (>8 km/h) – na postoju obok drogi nie zjadamy limitu
  if (NAV.offCount >= 5 && (f.speed || 0) > 2.2 && Date.now() - NAV.lastReroute > 20000) reroute(f);
  NAV.onRoute = sn.off <= 35; NAV.fixT = performance.now(); NAV.speed = f.speed || 0;
  if (!NAV.onRoute) { NAV.zoomT = 16; }
  else {
    const kmh = NAV.speed * 3.6; let zoom = kmh > 90 ? 15.6 : kmh > 50 ? 16.3 : 17;
    const cs = currentStep(); if (cs && cs.dist < 600 && cs.s.t !== 10) zoom = Math.max(zoom, cs.dist < 250 ? 17.8 : 17.2);
    NAV.zoomT = zoom;
  }
  if (!S.follow) { /* mapa odsunięta ręcznie – pętla rAF nie rusza kamery */ }
  updateHud();
  // cel
  if (r.total - NAV.prog < 30 && !NAV.said.goal) { NAV.said.goal = true; speak('Jesteś u celu.'); setTimeout(stopNav, 4000); }
}
function dropPassedVia() {
  if (!S.route || !S.via.length) return;
  S.via = S.via.filter(v => { const i = nearestIdx([v.lon, v.lat]); return i < 0 || S.route.cum[i] > NAV.prog + 300; });
}
function nearestIdx(p) { const r = S.route; let best = Infinity, bi = -1; for (let i = 0; i < r.coords.length; i += 3) { const d = dist(r.coords[i], p); if (d < best) { best = d; bi = i; } } return best < 2000 ? bi : -1; }
async function reroute(f) {
  NAV.lastReroute = Date.now(); NAV.offCount = 0; dropPassedVia();
  $('#manRoad').textContent = 'Przeliczam trasę…';
  const j = await computeRoute({ lon: f.lon, lat: f.lat });
  if (!j) return;
  NAV.idx = 0; NAV.prog = 0; NAV.stepI = 0; NAV.said = {}; drawRoute(); drawProgressMarks(); speak('Trasa przeliczona.');
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
    announce(s, d, cs.at); renderLanes(NAV.stepI, d);
  } else $('#lanes').classList.add('hidden');
  // aktualna droga = nazwa kroku, w którym jesteśmy
  const cur = r.steps[Math.max(0, NAV.stepI - 1)]; const rn = cur && cur.n ? cur.n : ''; $('#roadNow').textContent = rn; $('#roadNow').classList.toggle('hidden', !rn);
  const rem = Math.max(0, r.total - NAV.prog), frac = NAV.prog / r.total;
  const remSec = r.sec * (1 - frac);
  $('#etaTime').textContent = hhmm(new Date(Date.now() + remSec * 1000));
  $('#etaKm').textContent = (rem >= 10000 ? Math.round(rem / 1000) : Math.round(rem / 100) / 10) + ' km';
  $('#etaMin').textContent = hm(remSec);
  $('#progBar').style.width = (frac * 100).toFixed(1) + '%';
  const kmh = Math.round((S.pos && S.pos.speed || 0) * 3.6); $('#speedVal').textContent = kmh;
  // limit prędkości na bieżącym odcinku (TomTom speedLimit)
  const lim = (r.limits || []).find(l => NAV.idx >= l.a && NAV.idx < l.b);
  $('#limit').classList.toggle('hidden', !lim); if (lim) $('#limitVal').textContent = lim.kmh;
  $('#speedBox').classList.toggle('over', !!lim && kmh > lim.kmh + 5);
  // korki: opóźnienie przed nami
  const ahead = (r.traffic || []).filter(t => t.b > NAV.idx).reduce((s, t) => s + t.delay, 0);
  $('#etaNote').textContent = ahead > 60 ? '+' + Math.round(ahead / 60) + ' min przez ruch' : '';
  // nadchodzące: tunel / prom / korek w zasięgu 20 km
  const ev = [];
  for (const t of r.tunnels || []) if (t.at - NAV.prog > -t.len && t.at - NAV.prog < 20000) ev.push({ at: t.at, txt: 'Tunel' + (t.len > 500 ? ' ' + (t.len / 1000).toFixed(1).replace('.', ',') + ' km' : ''), sub: t.cat ? 'kat. ' + t.cat + (/[CDE]/.test(t.cat) ? ' · uwaga: butle gazowe' : ' · gaz OK') : 'gaz OK' });
  for (const t of r.ferries || []) if (t.at - NAV.prog > -200 && t.at - NAV.prog < 20000) ev.push({ at: t.at, txt: 'Prom', sub: 'przygotuj bilet' });
  for (const t of r.traffic || []) if (t.mag >= 2 && r.cum[t.a] - NAV.prog > -200 && r.cum[t.a] - NAV.prog < 20000) ev.push({ at: r.cum[t.a], txt: 'Korek +' + Math.round(t.delay / 60) + ' min', sub: (r.cum[t.b] - r.cum[t.a]) / 1000 > 0.5 ? ((r.cum[t.b] - r.cum[t.a]) / 1000).toFixed(1).replace('.', ',') + ' km' : '' });
  ev.sort((x, y) => x.at - y.at);
  const box = $('#events'); box.classList.toggle('hidden', !ev.length);
  box.innerHTML = ev.slice(0, 3).map(e => `<div><b>${e.txt}</b><small>za ${fmtDist(Math.max(0, e.at - NAV.prog))}${e.sub ? ' · ' + e.sub : ''}</small></div>`).join('');
  if (!updateHud._rb || Date.now() - updateHud._rb > 3000) { updateHud._rb = Date.now(); updatePoiCol(); }
  laUpdate();
}
function drawProgressMarks() {
  const r = S.route, el = $('#progMarks'); if (!el || !r) return;
  el.innerHTML = (r.traffic || []).map(t => `<i style="left:${(r.cum[t.a] / r.total * 100).toFixed(1)}%;width:${Math.max(0.8, (r.cum[t.b] - r.cum[t.a]) / r.total * 100).toFixed(1)}%;background:${TRAFFIC_COLOR(t.mag)}"></i>`).join('');
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
    speak(txt, lvl === 3);
  }
}
const sayDist = m => m >= 950 ? (Math.round(m / 100) / 10 + '').replace('.', ',') + ' kilometra' : Math.round(m / 50) * 50 + ' metrów';
let voicePl = null; const VQ = []; let vBusy = false; window._utt = null;
function speak(t, urgent) {
  if (!S.opt.voice || !('speechSynthesis' in window)) return;
  // iOS ucina komunikat, gdy od razu po nim wywołać cancel() lub gdy obiekt utterance zostanie zwolniony – kolejkujemy i trzymamy referencję
  if (urgent) { VQ.length = 0; try { speechSynthesis.cancel(); } catch (e) {} vBusy = true; setTimeout(() => { vBusy = false; VQ.push(t); vNext(); }, 300); return; }
  VQ.push(t); if (!vBusy) vNext();
}
let nativeVoices = null;
async function vNext() {
  const t = VQ.shift(); if (!t) { vBusy = false; return; }
  vBusy = true;
  if (NTTS) {
    try {
      if (!nativeVoices) { try { nativeVoices = (await NTTS.getSupportedVoices()).voices || []; } catch (e) { nativeVoices = []; } }
      let vi; if (S.opt.voiceName) { vi = nativeVoices.findIndex(v => v.name === S.opt.voiceName || v.voiceURI === S.opt.voiceName); }
      if (vi == null || vi < 0) { vi = nativeVoices.findIndex(v => /^pl/i.test(v.lang) && /premium|enhanced|rozszerz/i.test(v.name + ' ' + (v.voiceURI || ''))); }
      if (vi < 0) vi = nativeVoices.findIndex(v => /^pl/i.test(v.lang));
      await NTTS.speak({ text: t, lang: 'pl-PL', rate: S.opt.rate || 1.0, pitch: 1.0, volume: 1.0, category: 'playback', ...(vi >= 0 ? { voice: vi } : {}) });
    } catch (e) {}
    vBusy = false; setTimeout(vNext, 120); return;
  }
  try {
    const vs = speechSynthesis.getVoices();
    voicePl = (S.opt.voiceName && vs.find(v => v.name === S.opt.voiceName)) || vs.find(v => /^pl/i.test(v.lang) && /premium|enhanced|rozszerz/i.test(v.name)) || vs.find(v => /^pl/i.test(v.lang)) || null;
    const u = new SpeechSynthesisUtterance(t); u.lang = 'pl-PL'; if (voicePl) u.voice = voicePl; u.rate = S.opt.rate || 1.0;
    u.onend = u.onerror = () => { window._utt = null; setTimeout(vNext, 150); };
    window._utt = u; speechSynthesis.resume(); speechSynthesis.speak(u);
    setTimeout(() => { if (window._utt === u) { window._utt = null; vBusy = false; vNext(); } }, 12000);
  } catch (e) { vBusy = false; }
}
async function fillVoices() {
  const sel = $('#optVoiceName'); if (!sel) return;
  if (NTTS) {
    try { nativeVoices = (await NTTS.getSupportedVoices()).voices || []; } catch (e) { nativeVoices = []; }
    const vs = nativeVoices.filter(v => /^pl/i.test(v.lang));
    sel.innerHTML = '<option value="">Automatycznie (najlepszy polski)</option>' + vs.map(v => `<option value="${esc(v.name)}">${esc(v.name)}${/premium|enhanced|rozszerz/i.test(v.name + ' ' + (v.voiceURI || '')) ? ' ★' : ''}</option>`).join('');
    sel.value = S.opt.voiceName || ''; $('#voiceHint').textContent = vs.length + ' polskie głosy iOS (★ rozszerzone)'; return;
  }
  if (!('speechSynthesis' in window)) return;
  const vs = speechSynthesis.getVoices().filter(v => /^pl/i.test(v.lang));
  sel.innerHTML = '<option value="">Automatycznie</option>' + vs.map(v => `<option value="${esc(v.name)}">${esc(v.name.replace(/\s*\(.*?\)/g, ''))}${/premium|enhanced|rozszerz/i.test(v.name) ? ' ★' : ''}</option>`).join('');
  sel.value = S.opt.voiceName || '';
  $('#voiceHint').textContent = vs.length > 1 ? vs.length + ' polskie głosy z systemu' : 'Safari udostępnia tylko podstawowy głos iOS (Zosia); wersja rozszerzona będzie w aplikacji natywnej';
}
if ('speechSynthesis' in window) { speechSynthesis.onvoiceschanged = () => { voicePl = null; fillVoices(); }; setTimeout(fillVoices, 500); }
$('#optVoiceName').addEventListener('change', e => { S.opt.voiceName = e.target.value; store.set('opt', S.opt); voicePl = null; });
$('#optRate').addEventListener('input', e => { S.opt.rate = +e.target.value; store.set('opt', S.opt); $('#rateTxt').textContent = S.opt.rate.toFixed(2).replace('.', ',').replace(/0$/, '') + '×'; });
$('#voiceTest').addEventListener('click', () => { const was = S.opt.voice; S.opt.voice = true; speak('Za 300 metrów skręć w prawo.', true); S.opt.voice = was; setTimeout(fillVoices, 1500); });

/* wake lock – ekran nie gaśnie w czasie jazdy */
let wake = null;
async function keepAwake() { try { if (NKA) { await NKA.keepAwake(); return; } if ('wakeLock' in navigator) { wake = await navigator.wakeLock.request('screen'); } } catch (e) {} }
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
    const now = Date.now();
    // zwalniamy przed manewrem jak kierowca: 70 km/h, przed skrętem 30
    const cs = currentStep(); const v = (cs && cs.dist < 150 && cs.s.t !== 6) ? 30 / 3.6 : 70 / 3.6;
    prog += v * (now - last) / 1000; last = now;
    if (prog >= r.total) { prog = r.total; }
    const q = at(prog); onFix({ lon: q.p[0], lat: q.p[1], speed: v, heading: q.h, t: now });
    if (prog >= r.total) stopSim();
  }, 200);
}
function stopSim() { if (simT) { clearInterval(simT); simT = null; } }

/* ---------- UI ---------- */
function showTab(t) {
  if (t !== S.tab) S.prevTab = S.tab;
  S.tab = t;
  $('#sheet').classList.toggle('hidden', t !== 'trasa'); $('#veh').classList.toggle('hidden', t !== 'veh'); $('#menu').classList.toggle('hidden', t !== 'menu'); $('#poi').classList.toggle('hidden', t !== 'poi'); $('#search').classList.toggle('hidden', t !== 'search'); $('#pick').classList.add('hidden');
  $('#hud').classList.toggle('hidden', !(t === 'jazda' && S.nav));
  if (t === 'menu') { fillVoices(); if (NATIVE) { const AP = plugin('App'); (AP ? AP.getInfo() : Promise.resolve(null)).then(i => { $('#about').textContent = $('#about').textContent.replace(/\s*·\s*aplikacja natywna.*$/, '') + ' · aplikacja natywna' + (i ? ' v' + i.version + ' (build ' + i.build + ')' : ''); }).catch(() => {}); } }
  if (t === 'menu') { const p = S.profiles.find(x => x.id === S.vehId) || {}; $('#menuVeh').textContent = `${p.name || 'Kamper'} · ${fmt1(S.veh.h)} m · ${fmt1(S.veh.l)} m · ${fmt1(S.veh.t)} t`; }
  $('#idle').classList.toggle('hidden', !(t === 'jazda' && !S.nav));
  if (t === 'jazda' && !S.nav) { const p = S.profiles.find(x => x.id === S.vehId) || {}; $('#fVehTxt').textContent = `🚐 ${p.name || 'Kamper'} · ${fmt1(S.veh.h)} m · ${fmt1(S.veh.t)} t`; $('#fViewTxt').textContent = S.opt.d3 ? '3D' : '2D'; }
  $$('.tabs button').forEach(b => { if (b.dataset.tab === t) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  if (t === 'veh') fillVeh(S.vehId);
  if (t === 'trasa' && S.route) setTimeout(() => { fitRoute(); drawAlts(); }, 50);
  if (t === 'jazda' && S.nav) { S.follow = true; $('#btnRecenter').hidden = true; }
  if (t !== 'trasa') { altMarkers.forEach(m => m.remove()); altMarkers = []; }
  if (t === 'poi') renderPoi();
}
$('#btnView').addEventListener('click', () => setView3d(!S.opt.d3));
$('#opt3d').addEventListener('change', e => setView3d(e.target.checked));
$('#optNight').addEventListener('change', e => setNight(e.target.checked));

$('#optVoice').addEventListener('change', e => { S.opt.voice = e.target.checked; store.set('opt', S.opt); });
$('#optSim').addEventListener('change', e => { S.opt.sim = e.target.checked; store.set('opt', S.opt); if (S.nav) { if (S.opt.sim) startSim(); else stopSim(); } });
$('#fSearch').addEventListener('click', () => { showTab('trasa'); if (!S.to) setTimeout(() => $('#to').focus(), 50); });
$('#fVeh').addEventListener('click', () => { S.openedFrom = 'jazda'; showTab('veh'); });
$('#fCompass').addEventListener('click', () => map.easeTo({ bearing: 0, pitch: S.opt.d3 ? 45 : 0, duration: 400 }));
$('#fCenter').addEventListener('click', () => { if (S.pos) map.easeTo({ center: [S.pos.lon, S.pos.lat], zoom: 15, duration: 500 }); else startGps(); });
$('#fView').addEventListener('click', () => { setView3d(!S.opt.d3); $('#fViewTxt').textContent = S.opt.d3 ? '3D' : '2D'; map.easeTo({ pitch: S.opt.d3 ? 45 : 0, duration: 500 }); });
$('#btnRecenter').addEventListener('click', () => { S.follow = true; $('#btnRecenter').hidden = true; });
$('#bbSearch').addEventListener('click', () => { S.openedFrom = 'jazda'; showTab('poi'); });
$('#bbMenu').addEventListener('click', openQuick);
function qPanel(name) { $$('#quick .qp').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== name)); $('#quick').scrollTop = 0; }
$('#quick').addEventListener('click', e => {
  if (e.target.closest('[data-close]')) { $('#quick').classList.add('hidden'); return; }
  if (e.target.closest('[data-back]')) { qPanel('main'); return; }
  const b = e.target.closest('button[data-q]'); if (!b) return; const q = b.dataset.q;
  if (q === 'route') { fillRoutePanel(); qPanel('route'); }
  else if (q === 'tools') qPanel('tools');
  else if (q === 'settings') { fillSettings(); qPanel('settings'); }
  else if (q === 'voice') { S.opt.voice = !S.opt.voice; store.set('opt', S.opt); $('#optVoice').checked = S.opt.voice; fillQuick(); if (S.opt.voice) speak('Dźwięk włączony.'); else speechSynthesis.cancel(); }
  else if (q === 'via') { fillVia(); qPanel('via'); setTimeout(() => $('#viaInput').focus(), 50); }
  else if (q === 'share') shareRoute();
  else if (q === 'steps') { fillSteps(); qPanel('steps'); }
  else if (q === 'data') { fillData(); qPanel('data'); }
  else if (q === 'poi') { $('#quick').classList.add('hidden'); S.openedFrom = 'jazda'; showTab('poi'); }
  else if (q === 'recenter') { S.follow = true; $('#btnRecenter').hidden = true; $('#quick').classList.add('hidden'); }
  else if (q === 'menu') { $('#quick').classList.add('hidden'); S.openedFrom = 'jazda'; showTab('menu'); }
});
$('#qCancel').addEventListener('click', () => { $('#quick').classList.add('hidden'); stopNav(); });
function fillQuick() {
  $('#qVoiceIco').innerHTML = S.opt.voice ? ICO_SOUND : ICO_MUTE; $('#qVoiceTxt').textContent = S.opt.voice ? 'Dźwięk włączony' : 'Dźwięk wyłączony';
}
const ICO_SOUND = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10v4h4l5 4V6L8 10z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M18.5 6.5a7.5 7.5 0 0 1 0 11"/></svg>';
const ICO_MUTE = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10v4h4l5 4V6L8 10z"/><path d="M17 9l4 6M21 9l-4 6"/></svg>';
function openQuick() {
  const r = S.route; if (!r) return;
  $('#qDest').textContent = S.to ? S.to.name : 'Cel';
  const rem = Math.max(0, r.total - NAV.prog), remSec = r.sec * (1 - NAV.prog / r.total);
  $('#qDestSub').textContent = hhmm(new Date(Date.now() + remSec * 1000)) + ' · ' + Math.round(rem / 1000) + ' km';
  fillQuick(); qPanel('main'); $('#quick').classList.remove('hidden');
}
// --- opcje trasy (zmiana od razu przelicza, nawigacja trwa)
function fillRoutePanel() {
  $$('#qModes button').forEach(x => x.setAttribute('aria-pressed', x.dataset.mode === S.mode));
  $('#qAvoidMoto').checked = !!S.avoid.highways; $('#qAvoidToll').checked = !!S.avoid.tolls || S.mode === 'notoll';
  const r = S.route; $('#qRouteNote').textContent = r ? `${Math.round(r.km)} km · ${hm(r.sec)} · ${r.engine === 'tomtom' ? 'TomTom' : 'ORS'}${r.delay > 60 ? ' · korki +' + Math.round(r.delay / 60) + ' min' : ' · brak opóźnień'}` : '';
  fillCountryTable($('#qCcTable'));
}
$('#qModes').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.mode = b.dataset.mode; store.set('mode', S.mode); $$('#modes button').forEach(x => x.setAttribute('aria-pressed', x.dataset.mode === S.mode)); fillRoutePanel(); recalcKeepNav().then(fillRoutePanel); });
$('#qAvoidMoto').addEventListener('change', e => { S.avoid.highways = e.target.checked; store.set('avoid', S.avoid); recalcKeepNav().then(fillRoutePanel); });
$('#qAvoidToll').addEventListener('change', e => { S.avoid.tolls = e.target.checked; store.set('avoid', S.avoid); recalcKeepNav().then(fillRoutePanel); });
// --- unikanie per kraj (tabela jak w planerze): płatne / autostrady
function fillCountryTable(el) {
  const r = S.route; if (!el) return;
  if (!r || !r.path || !r.path.length) { el.innerHTML = ''; el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = '<div class="cc-h"><span>Kraj na trasie</span><span>Płatne</span><span>Autostrady</span></div>' + r.path.map(cc => {
    const v = S.avoidCC[cc] || {};
    return `<div class="cc-r"><span><b>${cc}</b> ${esc(KRAJ[cc] || '')}</span><input type="checkbox" data-cc="${cc}" data-k="tolls" ${v.tolls ? '' : 'checked'}><input type="checkbox" data-cc="${cc}" data-k="highways" ${v.highways ? '' : 'checked'}></div>`;
  }).join('') + (r.byCountry ? '<small class="cc-n">Trasa liczona odcinkami między granicami wg tych ustawień.</small>' : '');
}
document.addEventListener('change', e => {
  const i = e.target.closest('input[data-cc]'); if (!i) return;
  const cc = i.dataset.cc, k = i.dataset.k; S.avoidCC[cc] = S.avoidCC[cc] || {}; S.avoidCC[cc][k] = !i.checked; store.set('avoidCC', S.avoidCC);
  $$(`input[data-cc="${cc}"][data-k="${k}"]`).forEach(x => { x.checked = i.checked; });
  recalcKeepNav().then(() => { fillCountryTable($('#ccTable')); fillCountryTable($('#qCcTable')); fillRoutePanel(); });
});
// --- szybkie ustawienia (przełączniki działają od razu)
const OPT_EL = { roadNow: '#roadNow', poiCol: '#poiCol', events: '#events', nextChip: '#nextChip' };
function applyOpts() { for (const k in OPT_EL) $(OPT_EL[k]).classList.toggle('off', !S.opt[k]); }
function fillSettings() { $$('#quick [data-opt]').forEach(i => { i.checked = !!S.opt[i.dataset.opt]; }); }
$('#quick').addEventListener('change', e => {
  const i = e.target.closest('[data-opt]'); if (!i) return; const k = i.dataset.opt;
  if (k === 'd3') { setView3d(i.checked); return; }
  if (k === 'night') { setNight(i.checked); return; }
  S.opt[k] = i.checked; store.set('opt', S.opt); applyOpts(); if (k === 'autoNight') autoNight(true);
});
// --- punkty pośrednie
let viaT;
$('#viaInput').addEventListener('input', () => { clearTimeout(viaT); viaT = setTimeout(async () => {
  const q = $('#viaInput').value.trim(); const ul = $('#viaSugg'); if (q.length < 2) { ul.classList.add('hidden'); return; }
  let j; try { j = await (await fetch(API + '/geocode?q=' + encodeURIComponent(q))).json(); } catch (e) { return; }
  ul._res = j.results || []; ul.innerHTML = ul._res.slice(0, 6).map((x, i) => `<li data-i="${i}">${esc(x.label || x.name)}</li>`).join(''); ul.classList.toggle('hidden', !ul.innerHTML);
}, 250); });
$('#viaSugg').addEventListener('click', e => { const li = e.target.closest('li'); if (!li) return; const x = $('#viaSugg')._res[+li.dataset.i]; S.via.push({ name: x.name, lon: x.lon, lat: x.lat }); $('#viaInput').value = ''; $('#viaSugg').classList.add('hidden'); fillVia(); recalcKeepNav(); });
function fillVia() { $('#viaList').innerHTML = S.via.length ? S.via.map((v, i) => `<div class="via"><b>${esc(v.name)}</b><button type="button" data-rm="${i}">Usuń</button></div>`).join('') : '<div class="via" style="color:#8b93a5">Brak punktów pośrednich</div>'; }
$('#viaList').addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (!b) return; S.via.splice(+b.dataset.rm, 1); fillVia(); recalcKeepNav(); });
// --- instrukcje i dane trasy
function fillSteps() {
  const r = S.route; if (!r) return;
  $('#qSteps').innerHTML = r.steps.map((s, i) => `<div class="st${i === NAV.stepI ? ' cur' : ''}"><svg viewBox="0 0 64 64">${ICONS[s.t] || ICONS[6]}</svg><div><b>${esc(s.i || s.n || '')}</b><small>${s.n ? esc(s.n) + ' · ' : ''}${fmtDist(r.cum[s.wp[0]])} od startu${s.d ? ' · odcinek ' + fmtDist(s.d) : ''}</small></div></div>`).join('');
  const cur = $('#qSteps .cur'); if (cur) cur.scrollIntoView({ block: 'center' });
}
function fillData() {
  const r = S.route; if (!r) return;
  const tollKm = (r.tolls || []).reduce((s, [a, b]) => s + (r.cum[b] - r.cum[a]), 0) / 1000;
  const rows = [['Dystans', Math.round(r.km) + ' km'], ['Czas jazdy', hm(r.sec)], ['Korki', r.delay > 60 ? '+' + Math.round(r.delay / 60) + ' min' : 'brak'], ['Kraje', (r.path || []).map(c => KRAJ[c] || c).join(', ')], ['Granice', (r.crossings || []).map(c => c.from + '→' + c.to).join(', ') || '—'], ['Odcinki płatne', Math.round(tollKm) + ' km'], ['Tunele', (r.tunnels || []).length], ['Promy', (r.ferries || []).length], ['Silnik', r.engine === 'tomtom' ? 'TomTom (profil kampera)' : 'openrouteservice'], ['Profil', `${fmt1(S.veh.h)} m · ${fmt1(S.veh.l)} m · ${fmt1(S.veh.t)} t`]];
  $('#qData').innerHTML = rows.map(([k, v]) => `<div class="kv"><span>${k}</span><b>${esc(String(v))}</b></div>`).join('');
}
async function shareRoute() {
  if (!S.to) return;
  const url = location.origin + '/gps/?to=' + encodeURIComponent(S.to.lon + ',' + S.to.lat + ',' + S.to.name);
  try { if (navigator.share) await navigator.share({ title: 'Trasa do ' + S.to.name, url }); else { await navigator.clipboard.writeText(url); alert('Link skopiowany.'); } } catch (e) {}
}
// --- noc automatycznie: wysokość Słońca < -3° wg pozycji
function sunElev(lat, lon, d = new Date()) {
  const rad = Math.PI / 180, day = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5);
  const decl = 23.44 * rad * Math.sin(rad * 360 / 365 * (day - 81));
  const ut = d.getUTCHours() + d.getUTCMinutes() / 60; const ha = (15 * (ut - 12) + lon) * rad;
  return Math.asin(Math.sin(lat * rad) * Math.sin(decl) + Math.cos(lat * rad) * Math.cos(decl) * Math.cos(ha)) / rad;
}
function autoNight(force) {
  if (!S.opt.autoNight || !S.pos) return;
  const night = sunElev(S.pos.lat, S.pos.lon) < -3;
  if (night !== !!S.opt.night) setNight(night);
}
setInterval(() => autoNight(), 60000);
const SVG = (p) => `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const POI_ICON = {
  fuel: SVG('<path d="M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/><path d="M3 21h14"/><path d="M15 9h3a2 2 0 0 1 2 2v5a2 2 0 0 1-4 0v-4"/><path d="M7 7h6"/>'),
  mop: SVG('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M9 17V7h4a3 3 0 0 1 0 6H9"/>'),
  rest: SVG('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M9 17V7h4a3 3 0 0 1 0 6H9"/>'),
  parking: SVG('<path d="M3 16V8h11l3 3h4v5z"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>'),
  camp: SVG('<path d="M3 20L12 4l9 16z"/><path d="M9 20l3-6 3 6"/>'), caravan: SVG('<path d="M3 20L12 4l9 16z"/><path d="M9 20l3-6 3 6"/>'),
  dump: SVG('<path d="M12 3S5 11 5 15a7 7 0 0 0 14 0c0-4-7-12-7-12z"/>'),
};
function updatePoiCol() {
  const r = S.route, el = $('#poiCol'); if (!el || !r || !S.poi) return;
  const prog = NAV.prog;
  const items = S.poi.filter(p => p.at >= prog - 100 && p.off < 1500 && ['fuel', 'mop', 'rest', 'parking'].includes(p.kind)).slice(0, 3);
  el.innerHTML = items.map(p => {
    const pr = PRICES && PRICES[p.cc]; const price = p.kind === 'fuel' && pr && pr.diesel ? `<small>${fmt1(pr.diesel)} zł</small>` : '';
    return `<div class="pc" data-id="${p.id}"><span class="ic">${POI_ICON[p.kind] || POI_ICON.camp}</span><b>${fmtDist(Math.max(0, p.at - prog))}</b>${price}</div>`;
  }).join('');
}
$('#poiCol').addEventListener('click', e => { const it = e.target.closest('.pc'); if (!it) return; const p = S.poi.find(x => x.id === it.dataset.id); if (p && confirm('Nawigować do: ' + (p.name || POI_KIND[p.kind]?.[0] || 'miejsce') + '?')) goTo(p); });


/* start */
// komputer (mysz, brak dotyku, szeroki ekran) – tylko informacja z kodem QR; ?desk=1 wymusza pełną wersję do testów
function isDesktop() {
  if (NATIVE || new URLSearchParams(location.search).get('desk') === '1') return false;
  const touch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
  const coarse = matchMedia('(pointer: coarse)').matches;
  return !touch && !coarse && window.innerWidth > 1024;
}
function init() {
  if (isDesktop()) { $('#desk').classList.remove('hidden'); $('#sheet').classList.add('hidden'); return; }
  document.body.classList.toggle('night', !!S.opt.night);
  $('#optVoice').checked = !!S.opt.voice; $('#opt3d').checked = !!S.opt.d3; $('#optRate').value = S.opt.rate || 1; $('#rateTxt').textContent = (S.opt.rate || 1).toFixed(2).replace('.', ',').replace(/0$/, '') + '×'; $('#optNight').checked = !!S.opt.night; $('#optSim').checked = !!S.opt.sim;
  $$('#modes button').forEach(x => x.setAttribute('aria-pressed', x.dataset.mode === S.mode));
  vehInit(); vehLine(); fillVeh(S.vehId); initMap(); $('#btnView').textContent = S.opt.d3 ? '3D' : '2D';
  startGps();
  // ?to=lon,lat,Nazwa – wejście z planera
  const u = new URLSearchParams(location.search);
  if (u.get('to')) { const [lon, lat, ...n] = u.get('to').split(','); S.to = { lon: +lon, lat: +lat, name: n.join(',') || 'Cel' }; $('#to').textContent = S.to.name; $('#to').classList.remove('empty'); } else { $('#to').classList.add('empty'); }
  $('#from').classList.add('empty'); $('#viaAdd').classList.add('empty');
  showTab(S.to ? 'trasa' : 'jazda');
}
init();
