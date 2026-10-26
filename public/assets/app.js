/* gdzieponiesie.pl – planer trasy kamperem i zestawem z przyczepą */
(function(){
'use strict';

const CONFIG = {
  dane: 'assets/dane/',
  apiPaliwo: 'api/paliwo.php',   // {data:{PL:{on:1.79,pb:1.56},...}} – ceny w EUR/l
  apiGranice: 'api/granice.php', // {data:{"roszke-horgos":{tam:35,powrot:80},...}} – minuty
  routeApi: (window.GP_CONFIG && window.GP_CONFIG.routeApi) || '', // ustawiane w assets/config.js – puste = trasy demo
  tempo: {kamper: .9, ciezki: .85, zestaw: .8}, // demo: prędkość kampera względem auta osobowego
  czasApi: {kamper: 1.0, ciezki: 1.05, zestaw: 1.1}, // Worker mnoży czas osobówki ×1,1; cięższy kamper i zestaw jadą jeszcze wolniej
  krety: 1.18                    // ile dłuższa jest droga od linii prostej między punktami
};

/* ---------- narzędzia ---------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const fmt = (v, d = 0) => v.toLocaleString('pl-PL', {minimumFractionDigits: d, maximumFractionDigits: d});
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const store = {
  get(k, d){ try{ const v = localStorage.getItem('gp-' + k); return v == null ? d : JSON.parse(v); }catch(e){ return d; } },
  set(k, v){ try{ localStorage.setItem('gp-' + k, JSON.stringify(v)); }catch(e){} }
};
const getJSON = async url => { const r = await fetch(url, {cache: 'no-cache'}); if(!r.ok) throw new Error(url + ' ' + r.status); return r.json(); };
const hav = (a, b) => { const r = Math.PI / 180, dA = (b[1] - a[1]) * r, dO = (b[0] - a[0]) * r;
  const h = Math.sin(dA / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dO / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h)); };

const VDEF = {typ: 'kamper', dmc: 3500, dmcP: 1500, wys: 2.9, wysOs: 2.2, dl: 7.0, osie: 2, j: 'M1', kemp: true};
const S = {
  fuel: store.get('fuel', 'on'), cur: store.get('cur', 'pln'), cons: store.get('cons', 11),
  gas: store.get('gas', 'route'), svc: store.get('svc', 'list'),
  route: store.get('route', {from: 'Kraków', to: 'Budva', war: {}}),
  v: {...VDEF, ...store.get('vehicle', {})},
  opt: store.get('ropt', {avoid: [], avoidC: []}),
  dzien: store.get('dzien', 600), nightsOpen: null, elevOpen: false
};
const API = () => !!CONFIG.routeApi;
let K, KR, T, M, LST, R = null, RATE = 4.4;
let fuelSrc = '', borderSrc = null, liveBorders = {};

/* ---------- waluta ---------- */
const money = (eur, round10 = true) => S.cur === 'pln'
  ? fmt(round10 ? Math.round(eur * RATE / 10) * 10 : Math.round(eur * RATE)) + ' zł'
  : fmt(Math.round(eur)) + ' €';
const litre = eur => S.cur === 'pln' ? fmt(eur * RATE, 2) : fmt(eur, 2);
const curUnit = () => S.cur === 'pln' ? 'zł/l' : '€/l';

/* ---------- motyw ---------- */
function applyTheme(t){
  document.documentElement.dataset.theme = t;
  $('#themeBtn').setAttribute('aria-label', t === 'dark' ? 'Włącz jasny wygląd' : 'Włącz ciemny wygląd');
  $('#themeColor').setAttribute('content', t === 'dark' ? '#111317' : '#FFFFFF');
}
$('#themeBtn').onclick = () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try{ localStorage.setItem('gp-theme', t); }catch(e){}
  applyTheme(t);
  if(ML.state === 'ready'){ ML.fitKey = ML.fitKey; ML.map.setStyle(ML_STYLE[t], {diff: false}); } else drawMap();   // bez diff: pełne przeładowanie, przychodzi 'style.load' i dokładamy warstwy trasy
};

/* ---------- desktop ---------- */
const DESK = matchMedia('(min-width: 1024px)');
const isDesk = () => DESK.matches;
function placeMap(){
  const mb = $('.mapbox'), dock = $('#dock');
  const ev = $('#elev');
  if(isDesk()){ if(mb.parentNode !== dock) dock.append(mb); if(ev.parentNode !== dock) dock.append(ev); }
  else { if(mb.parentNode === dock) $('#tiles').before(mb); if(ev.parentNode === dock) $('#actions').after(ev); }
  ML.fitKey = null;
  if(R) drawMap();
}
DESK.addEventListener('change', () => { placeMap(); if(isDesk() && location.hash === '#serwis') showTab('trasa'); });
// podświetlenie kraju na mapie po najechaniu na kartę
document.addEventListener('mouseover', e => {
  const c = e.target.closest('[data-cc]'); const cc = c ? c.dataset.cc : null;
  mlHighlight(cc);
  Object.values(landByName).forEach(p => p.classList.remove('hl'));
  if(cc && KR[cc] && landByName[KR[cc].map]) landByName[KR[cc].map].classList.add('hl');
});

/* ---------- zakładki ---------- */
const TABS = ['trasa', 'noclegi', 'paliwo', 'winiety', 'gaz', 'serwis'];
function showTab(t){
  if(!TABS.includes(t) || (t === 'serwis' && isDesk())) t = 'trasa';
  S.tab = t;
  $$('.view').forEach(v => v.hidden = v.id !== 'v-' + t);
  $$('.nav a').forEach(a => a.dataset.tab === t ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  window.scrollTo(0, 0);
  if(R && (t === 'trasa' || isDesk())) drawMap();
  if(t === 'gaz' && R) renderGaz();
  if(t === 'noclegi' && R) renderExtras();
}
addEventListener('hashchange', () => showTab(location.hash.slice(1)));

/* ---------- przełączniki ---------- */
function syncSegs(){
  $$('.seg[data-set]').forEach(seg => seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', S[seg.dataset.set] === b.dataset.v)));
}
document.addEventListener('click', e => {
  const b = e.target.closest('.seg[data-set] button'); if(!b) return;
  const key = b.closest('.seg').dataset.set; S[key] = b.dataset.v; store.set(key, S[key]);
  syncSegs(); renderAll();
  if(key === 'fuel' && API() && R && R.api) setRouteApi();
});

/* ---------- pojazd ---------- */
const V = () => { const v = S.v; return {...v, ciezki: v.typ === 'ciezki', zestaw: v.typ === 'zestaw', razem: v.typ === 'zestaw' ? +v.dmc + +v.dmcP : +v.dmc}; };
const TYP_N = {kamper: 'Kamper do 3,5 t', ciezki: 'Kamper powyżej 3,5 t', zestaw: 'Auto z przyczepą'};
function vehLine(){
  const v = V();
  $('#vehLine').innerHTML = `<b>${TYP_N[v.typ]}</b><span>${fmt(+v.wys, 2)} m wys., ${fmt(+v.dl, 1)} m dł.${v.zestaw ? `, ${fmt(v.razem)} kg razem` : ''}</span>`;
  $('#vehLine').setAttribute('aria-label', 'Zmień dane pojazdu: ' + TYP_N[v.typ]);
}
const dlg = $('#veh'), vf = $('#vehForm');
function fillVeh(){
  const v = S.v;
  vf.typ.value = v.typ; ['dmc', 'dmcP', 'wys', 'wysOs', 'dl', 'osie'].forEach(k => vf[k].value = v[k]);
  vf.kemp.checked = !!v.kemp; vf.cons.value = S.cons;
  vehFormMode();
}
function vehFormMode(){
  const t = vf.typ.value;
  vf.querySelectorAll('[data-only]').forEach(x => x.hidden = x.dataset.only !== t);
  vf.querySelectorAll('[data-hide]').forEach(x => x.hidden = x.dataset.hide === t);
  $('#lDmc').textContent = t === 'zestaw' ? 'DMC auta' : 'DMC kampera';
  $('#lWysOs').textContent = t === 'zestaw' ? 'Wysokość auta nad przednią osią' : 'Wysokość nad przednią osią';
  $('#lDl').textContent = t === 'zestaw' ? 'Długość zestawu' : 'Długość';
}
vf.addEventListener('change', e => {
  if(e.target.name !== 'typ') return;
  const t = e.target.value;
  if(t === 'ciezki' && +vf.dmc.value <= 3500) vf.dmc.value = 4500;
  if(t === 'kamper' && +vf.dmc.value > 3500) vf.dmc.value = 3500;
  if(t === 'zestaw'){ if(+vf.dmc.value > 3500 || +vf.dmc.value === 3500) vf.dmc.value = 2200; if(+vf.dl.value < 9) vf.dl.value = 12; if(+vf.wysOs.value > 1.6) vf.wysOs.value = 1.2; }
  vehFormMode();
});
$('#vehBtn').onclick = $('#vehLine').onclick = () => { fillVeh(); dlg.showModal(); };
dlg.addEventListener('close', () => {
  if(dlg.returnValue !== 'ok') return;
  const n = k => parseFloat(String(vf[k].value).replace(',', '.'));
  const v = {typ: vf.typ.value, dmc: n('dmc') || 3500, dmcP: n('dmcP') || 0, wys: n('wys') || 2.9, wysOs: n('wysOs') || 2, dl: n('dl') || 7,
             osie: n('osie') || 2, kemp: vf.kemp.checked};
  if(v.typ === 'kamper' && v.dmc > 3500) v.typ = 'ciezki';
  if(v.typ === 'ciezki' && v.dmc <= 3500) v.typ = 'kamper';
  S.v = v; store.set('vehicle', v);
  const c = n('cons'); if(c){ S.cons = c; store.set('cons', c); }
  vehLine(); renderAll();
  if(API()) setRouteApi();
});

/* ---------- flagi (SVG 30×20, bez emoji – działa też na Windows) ---------- */
const H3 = (a, b, c) => `<rect width="30" height="20" fill="${a}"/><rect y="6.67" width="30" height="6.67" fill="${b}"/><rect y="13.33" width="30" height="6.67" fill="${c}"/>`;
const V3 = (a, b, c) => `<rect width="30" height="20" fill="${b}"/><rect width="10" height="20" fill="${a}"/><rect x="20" width="10" height="20" fill="${c}"/>`;
const NORD = (bg, cr, inner) => `<rect width="30" height="20" fill="${bg}"/><rect x="8" width="${inner ? 6 : 4}" height="20" fill="${cr}"/><rect y="${inner ? 7 : 8}" width="30" height="${inner ? 6 : 4}" fill="${cr}"/>${inner ? `<rect x="9.5" width="3" height="20" fill="${inner}"/><rect y="8.5" width="30" height="3" fill="${inner}"/>` : ''}`;
const FLAG = {
  PL: '<rect width="30" height="20" fill="#fff"/><rect y="10" width="30" height="10" fill="#DC143C"/>',
  CZ: '<rect width="30" height="20" fill="#fff"/><rect y="10" width="30" height="10" fill="#D7141A"/><path d="M0 0l15 10L0 20z" fill="#11457E"/>',
  SK: H3('#fff', '#0B4EA2', '#EE1C25') + '<path d="M7 4h7v6.5c0 3-3.5 4.5-3.5 4.5S7 13.5 7 10.5z" fill="#EE1C25" stroke="#fff" stroke-width=".8"/><path d="M10.5 6v7M8.7 8h3.6M9.2 10h2.6" stroke="#fff" stroke-width=".9"/>',
  HU: H3('#CD2A3E', '#fff', '#436F4D'),
  AT: H3('#ED2939', '#fff', '#ED2939'),
  SI: H3('#fff', '#0000FF', '#FF0000') + '<path d="M6 3.5h5v4.5c0 2.2-2.5 3.2-2.5 3.2S6 10.2 6 8z" fill="#0000FF" stroke="#FF0000" stroke-width=".6"/>',
  HR: H3('#FF0000', '#fff', '#171796') + '<rect x="12" y="5" width="6" height="7" fill="#fff" stroke="#FF0000" stroke-width=".5"/><path d="M12 5h2v2h-2zM16 5h2v2h-2zM14 7h2v2h-2zM12 9h2v2h-2zM16 9h2v2h-2z" fill="#FF0000"/>',
  RS: H3('#C6363C', '#0C4076', '#fff') + '<path d="M7 4h5v6c0 2.2-2.5 3-2.5 3S7 12.2 7 10z" fill="#C6363C" stroke="#EDB92E" stroke-width=".7"/>',
  ME: '<rect width="30" height="20" fill="#D4AF37"/><rect x="1.2" y="1.2" width="27.6" height="17.6" fill="#C40308"/><circle cx="15" cy="10" r="3.3" fill="#D4AF37"/>',
  BG: H3('#fff', '#00966E', '#D62612'),
  TR: '<rect width="30" height="20" fill="#E30A17"/><circle cx="11" cy="10" r="5" fill="#fff"/><circle cx="12.3" cy="10" r="4" fill="#E30A17"/><path d="M16.2 10l3.9-1.3-2.4 3.3V8l2.4 3.3z" fill="#fff"/>',
  DE: H3('#000', '#DD0000', '#FFCE00'),
  IT: V3('#009246', '#fff', '#CE2B37'),
  FR: V3('#002395', '#fff', '#ED2939'),
  ES: '<rect width="30" height="20" fill="#AA151B"/><rect y="5" width="30" height="10" fill="#F1BF00"/>',
  PT: '<rect width="30" height="20" fill="#FF0000"/><rect width="12" height="20" fill="#006600"/><circle cx="12" cy="10" r="3.6" fill="#FFCC00"/><circle cx="12" cy="10" r="2.2" fill="#FF0000" stroke="#fff" stroke-width=".6"/>',
  DK: NORD('#C8102E', '#fff'),
  SE: NORD('#006AA7', '#FECC00'),
  NO: NORD('#BA0C2F', '#fff', '#00205B'),
  NL: H3('#AE1C28', '#fff', '#21468B'),
  BE: V3('#000', '#FDDA24', '#EF3340'),
  CH: '<rect width="30" height="20" fill="#DA291C"/><rect x="13" y="4" width="4" height="12" fill="#fff"/><rect x="9" y="8" width="12" height="4" fill="#fff"/>',
  RO: V3('#002B7F', '#FCD116', '#CE1126'),
  LU: H3('#EA141D', '#fff', '#51ADDA'),
  LT: H3('#FDB913', '#006A44', '#C1272D'),
  LV: '<rect width="30" height="20" fill="#9E3039"/><rect y="8" width="30" height="4" fill="#fff"/>',
  EE: H3('#0072CE', '#000', '#fff'),
  FI: NORD('#fff', '#002F6C'),
  IS: NORD('#02529C', '#fff', '#DC1E35'),
  IE: V3('#169B62', '#fff', '#FF883E'),
  GB: '<rect width="30" height="20" fill="#012169"/><path d="M0 0L30 20M30 0L0 20" stroke="#fff" stroke-width="4"/><path d="M0 0L30 20M30 0L0 20" stroke="#C8102E" stroke-width="1.6"/><path d="M15 0v20M0 10h30" stroke="#fff" stroke-width="6"/><path d="M15 0v20M0 10h30" stroke="#C8102E" stroke-width="3.4"/>',
  UA: '<rect width="30" height="20" fill="#FFD700"/><rect width="30" height="10" fill="#0057B7"/>',
  MD: V3('#0046AE', '#FFD200', '#CC092F') + '<rect x="13" y="7" width="4" height="6" rx="1" fill="#A0522D"/>',
  BY: '<rect width="30" height="20" fill="#4AA657"/><rect width="30" height="13.3" fill="#C8313E"/><rect width="4" height="20" fill="#fff"/><path d="M2 1v18" stroke="#C8313E" stroke-width="1.4" stroke-dasharray="2 1.5"/>',
  RU: H3('#fff', '#0039A6', '#D52B1E'),
  BA: '<rect width="30" height="20" fill="#002395"/><path d="M8.5 0H22V13.5z" fill="#FECB00"/><path d="M6.5 1.5h.01M8.8 3.8h.01M11.1 6.1h.01M13.4 8.4h.01M15.7 10.7h.01M18 13h.01M20.3 15.3h.01" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>',
  AL: '<rect width="30" height="20" fill="#E41E20"/><path d="M15 4l2.6 2.4 3.2-1.2-1.6 3.4 2.4 2.6-3.2-.6L15 16l-3.4-5.4-3.2.6 2.4-2.6-1.6-3.4 3.2 1.2z" fill="#000"/>',
  MK: '<rect width="30" height="20" fill="#D20000"/><path d="M15 10L0 0M15 10L30 0M15 10L0 20M15 10L30 20M15 10L15 0M15 10L15 20M15 10L0 10M15 10L30 10" stroke="#FFE600" stroke-width="2.2"/><circle cx="15" cy="10" r="3.4" fill="#FFE600" stroke="#D20000" stroke-width=".8"/>',
  XK: '<rect width="30" height="20" fill="#244AA5"/><path d="M11 9l3-2 4 1 2 3-1 4-4 1-3-2z" fill="#D0A650"/><path d="M9 5.5h.01M11.5 4.5h.01M14 4h.01M16.5 4h.01M19 4.5h.01M21.5 5.5h.01" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>',
  LI: '<rect width="30" height="20" fill="#CE1126"/><rect width="30" height="10" fill="#002B7F"/><circle cx="7" cy="5" r="2" fill="#FFD83D"/>',
  AD: V3('#10069F', '#FEDF00', '#D50032') + '<rect x="13" y="7" width="4" height="6" rx="1" fill="#C7B37F"/>',
  MC: '<rect width="30" height="20" fill="#fff"/><rect width="30" height="10" fill="#CE1126"/>',
  SM: '<rect width="30" height="20" fill="#5EB6E4"/><rect width="30" height="10" fill="#fff"/>',
  MT: '<rect width="30" height="20" fill="#CF142B"/><rect width="15" height="20" fill="#fff"/><rect x="3" y="3" width="4" height="4" fill="#999"/>',
  CY: '<rect width="30" height="20" fill="#fff"/><path d="M9 8l5-2 7 1 2 2-5 2-6 0z" fill="#D57800"/><path d="M11 14q4 2 8 0" stroke="#4E5B31" stroke-width="1.2" fill="none"/>',
  VA: '<rect width="30" height="20" fill="#fff"/><rect width="15" height="20" fill="#FFE000"/>',
  GE: '<rect width="30" height="20" fill="#fff"/><path d="M15 0v20M0 10h30" stroke="#FF0000" stroke-width="4"/>',
  GR: '<rect width="30" height="20" fill="#0D5EAF"/><path d="M0 3.3h30M0 10h30M0 16.7h30" stroke="#fff" stroke-width="2.2"/><rect width="11.1" height="11.1" fill="#0D5EAF"/><path d="M5.55 0v11.1M0 5.55h11.1" stroke="#fff" stroke-width="2.2"/>'
};
const flagSvg = (cc, w = 22) => `<svg class="fl" width="${w}" height="${Math.round(w * 2 / 3)}" viewBox="0 0 30 20" aria-hidden="true">${FLAG[cc] || '<rect width="30" height="20" fill="#ccc"/>'}</svg>`;

/* ---------- mapa ---------- */
const svg = $('#map'), NS = 'http://www.w3.org/2000/svg';
const el = (t, a) => { const e = document.createElementNS(NS, t); for(const k in a) e.setAttribute(k, a[k]); return e; };
const gL = el('g', {}), gH = el('g', {}), gR = el('g', {}), gP = el('g', {});
const defs = el('defs', {}); defs.innerHTML = '<pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6"/></pattern>';
svg.append(defs, gL, gH, gR, gP);
const colorOf = c => 'k' + (R.order.indexOf(c) % 7);
const landByName = {};
const proj = (lon, lat) => { const l = lon * Math.PI / 180, p = lat * Math.PI / 180;
  return [M.tx + M.k * l, M.ty - M.k * Math.log(Math.tan(Math.PI / 4 + p / 2))]; };
function buildLand(){ if(Object.keys(landByName).length) return; for(const [n, d] of Object.entries(M.kraje)){ const p = el('path', {d, class: 'c'}); gL.append(p); landByName[n] = p; } }
function drawSvg(){
  if(!M) return;
  const box = svg.getBoundingClientRect(); if(!box.width) return;
  gR.textContent = ''; gP.textContent = '';
  Object.values(landByName).forEach(p => p.setAttribute('class', 'c'));
  gH.textContent = '';
  R.order.forEach(c => { const p = landByName[KR[c].map]; if(!p) return; p.setAttribute('class', 'c ' + colorOf(c));
    if(!KR[c].schengen) gH.append(el('path', {d: p.getAttribute('d'), class: 'hx'})); });
  const xy = R.chain.map(p => proj(p[1], p[2]));
  const xs = xy.map(p => p[0]), ys = xy.map(p => p[1]);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const ar = box.width / box.height, pad = Math.max(x1 - x0, y1 - y0) * .12 + 15;
  x0 -= pad; x1 += pad; y0 -= pad; y1 += pad * 1.7;
  let w = x1 - x0, h = y1 - y0;
  if(w / h > ar){ const nh = w / ar; y0 -= (nh - h) / 2; h = nh; } else { const nw = h * ar; x0 -= (nw - w) / 2; w = nw; }
  svg.setAttribute('viewBox', `${x0.toFixed(1)} ${y0.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`);
  const k = w / box.width;
  // odcinki drogowe i promowe osobno
  const runs = []; let cur = null;
  R.segs.forEach(s => { const mode = s.prom ? 'prom' : 'droga';
    if(!cur || cur.mode !== mode){ cur = {mode, pts: [proj(s.a[1], s.a[2])]}; runs.push(cur); }
    cur.pts.push(proj(s.b[1], s.b[2])); });
  const anim = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  runs.forEach(r => {
    const d = 'M' + r.pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('L');
    if(r.mode === 'prom'){ gR.append(el('path', {d, class: 'rf'})); return; }
    gR.append(el('path', {d, class: 'rc'}));
    const line = el('path', {d, class: 'rt'}); gR.append(line);
    if(anim){ const len = line.getTotalLength() / k + 20; line.style.strokeDasharray = len; line.style.strokeDashoffset = len; line.getBoundingClientRect();
      line.style.transition = 'stroke-dashoffset 1.1s cubic-bezier(.45,.05,.2,1)'; line.style.strokeDashoffset = 0; }
  });
  R.borders.forEach(b => { const [x, y] = proj(b.lon, b.lat), s = 9 * k;
    gP.append(el('rect', {x: x - s / 2, y: y - s / 2, width: s, height: s, class: 'bx', transform: `rotate(45 ${x} ${y})`})); });
  R.order.forEach(c => {
    const pts = R.chain.filter(p => p[3] === c); if(!pts.length) return;
    const m = pts[Math.floor((pts.length - 1) / 2)], [x, y] = proj(m[1], m[2]);
    const fw = 26 * k, fh = fw * 2 / 3, off = 14 * k;
    const g = el('g', {class: 'mflag' + (KR[c].schengen ? '' : ' x'), 'data-cc': c, transform: `translate(${(x + off).toFixed(1)} ${(y - fh - off / 2).toFixed(1)})`});
    g.append(el('rect', {x: -2 * k, y: -2 * k, width: fw + 4 * k, height: fh + 4 * k, rx: 3 * k, class: 'mf-frame'}));
    const s = el('svg', {width: fw, height: fh, viewBox: '0 0 30 20', preserveAspectRatio: 'none'}); s.innerHTML = FLAG[c] || ''; g.append(s);
    const t = el('title', {}); t.textContent = KR[c].n + (KR[c].schengen ? '' : ' – poza Schengen'); g.append(t);
    gP.append(g);
  });
  const a = xy[0], z = xy[xy.length - 1];
  gP.append(el('circle', {cx: a[0], cy: a[1], r: 6 * k, class: 'pin-a'}), el('circle', {cx: z[0], cy: z[1], r: 7 * k, class: 'pin-b'}));
}

/* ---------- mapa MapLibre + OpenFreeMap (zapas: rysunek SVG powyżej) ---------- */
const ML_VER = '4.7.1';
const ML_STYLE = {light: 'https://tiles.openfreemap.org/styles/positron', dark: 'https://tiles.openfreemap.org/styles/dark'};
const ML = {state: 'off', map: null, markers: [], geo: null, hl: ''};
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const themeNow = () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
function drawMap(){ if(!R) return; if(ML.state === 'ready') drawML(); else if(ML.state !== 'loading') drawSvg(); }
function loadAsset(tag, attrs){ return new Promise((ok, bad) => { const e = document.createElement(tag); Object.assign(e, attrs); e.onload = ok; e.onerror = bad; document.head.append(e); }); }
async function startML(){
  if(window.__GP_DATA || !window.WebGLRenderingContext) return mapFallback();   // podgląd w czacie / brak WebGL
  ML.state = 'loading';
  const base = `https://unpkg.com/maplibre-gl@${ML_VER}/dist/`;
  const timer = setTimeout(() => { if(ML.state === 'loading') mapFallback(); }, 12000);
  try{
    await Promise.all([loadAsset('link', {rel: 'stylesheet', href: base + 'maplibre-gl.css'}), loadAsset('script', {src: base + 'maplibre-gl.js'})]);
    ML.geo = await getJSON(CONFIG.dane + 'kraje-geo.json');
    const box = $('.mapbox'); const div = document.createElement('div'); div.id = 'mlmap'; box.prepend(div);
    const map = ML.map = new maplibregl.Map({container: div, style: ML_STYLE[themeNow()], center: [15, 50], zoom: 4,
      attributionControl: false, dragRotate: false, pitchWithRotate: false, cooperativeGestures: false});
    map.addControl(new maplibregl.AttributionControl({compact: true}), 'top-right');
    map.addControl(new maplibregl.NavigationControl({showCompass: false}), 'top-left');
    map.touchZoomRotate.disableRotation();
    map.on('style.load', () => { mlLayers(); if(ML.state === 'ready') drawML(); });
    map.once('load', () => { clearTimeout(timer); if(ML.state !== 'loading') return;
      ML.state = 'ready'; box.classList.add('ml'); drawML(); });
    map.on('error', e => { if(ML.state === 'loading'){ clearTimeout(timer); mapFallback(); } else console.warn('mapa:', e.error && e.error.message); });
  }catch(e){ clearTimeout(timer); mapFallback(); }
}
async function mapFallback(){
  if(ML.state === 'fallback') return;
  ML.state = 'fallback';
  if(ML.map){ try{ ML.map.remove(); }catch(e){} ML.map = null; }
  const d = document.getElementById('mlmap'); if(d) d.remove();
  $('.mapbox').classList.remove('ml');
  try{ if(!M) M = (window.__GP_DATA && window.__GP_DATA.mapa) || await getJSON(CONFIG.dane + 'mapa.json'); buildLand(); drawSvg(); }catch(e){ console.warn(e); }
}
function hatchImage(){
  const c = document.createElement('canvas'); c.width = c.height = 10; const g = c.getContext('2d');
  g.strokeStyle = cssVar('--hatch') || '#C98C00'; g.lineWidth = 2.2;
  g.beginPath(); g.moveTo(-2, 12); g.lineTo(12, -2); g.moveTo(-2, 2); g.lineTo(2, -2); g.moveTo(8, 12); g.lineTo(12, 8); g.stroke();
  return g.getImageData(0, 0, 10, 10);
}
function mlLayers(){
  const map = ML.map; if(!map || map.getSource('kraje')) return;
  const firstSym = (map.getStyle().layers.find(l => l.type === 'symbol') || {}).id;
  if(map.hasImage('hatch')) map.removeImage('hatch'); map.addImage('hatch', hatchImage());
  map.addSource('kraje', {type: 'geojson', data: ML.geo});
  map.addSource('trasa', {type: 'geojson', data: {type: 'FeatureCollection', features: []}});
  map.addLayer({id: 'kraje-fill', type: 'fill', source: 'kraje', paint: {'fill-color': 'rgba(0,0,0,0)', 'fill-opacity': .5}}, firstSym);
  map.addLayer({id: 'kraje-hx', type: 'fill', source: 'kraje', filter: ['in', ['get', 'cc'], ['literal', []]], paint: {'fill-pattern': 'hatch', 'fill-opacity': .55}}, firstSym);
  map.addLayer({id: 'kraje-hl', type: 'line', source: 'kraje', filter: ['==', ['get', 'cc'], ''], paint: {'line-color': cssVar('--ink'), 'line-width': 2.5}}, firstSym);
  map.addLayer({id: 'trasa-tlo', type: 'line', source: 'trasa', filter: ['==', ['get', 'm'], 'droga'], layout: {'line-join': 'round', 'line-cap': 'round'}, paint: {'line-color': cssVar('--bg'), 'line-width': 9}});
  map.addLayer({id: 'trasa', type: 'line', source: 'trasa', filter: ['==', ['get', 'm'], 'droga'], layout: {'line-join': 'round', 'line-cap': 'round'}, paint: {'line-color': cssVar('--route'), 'line-width': 4.5}});
  map.addLayer({id: 'prom', type: 'line', source: 'trasa', filter: ['==', ['get', 'm'], 'prom'], layout: {'line-cap': 'round'}, paint: {'line-color': cssVar('--route'), 'line-width': 3, 'line-dasharray': [0.5, 2.5]}});
}
function mlMarker(html, cls, lngLat, title, anchor = 'center', offset = [0, 0]){
  const e = document.createElement('div'); e.className = cls; e.innerHTML = html; if(title) e.title = title;
  const m = new maplibregl.Marker({element: e, anchor, offset}).setLngLat(lngLat).addTo(ML.map); ML.markers.push(m);
}
function drawML(){
  const map = ML.map; if(!map || !map.getSource('kraje')) return;
  map.resize();
  // kolory krajów na trasie (te same co w legendzie)
  const match = ['match', ['get', 'cc']]; R.order.forEach(c => match.push(c, cssVar('--' + colorOf(c)))); match.push('rgba(0,0,0,0)');
  map.setPaintProperty('kraje-fill', 'fill-color', R.order.length ? match : 'rgba(0,0,0,0)');
  map.setPaintProperty('kraje-fill', 'fill-opacity', themeNow() === 'dark' ? .55 : .5);
  map.setFilter('kraje-hx', ['in', ['get', 'cc'], ['literal', R.order.filter(c => !KR[c].schengen)]]);
  ['trasa', 'prom'].forEach(id => map.setPaintProperty(id, 'line-color', cssVar('--route')));
  map.setPaintProperty('trasa-tlo', 'line-color', cssVar('--bg'));
  map.setPaintProperty('kraje-hl', 'line-color', cssVar('--ink'));
  // linia trasy: odcinki drogowe i promowe
  const feats = []; let cur = null;
  R.segs.forEach(s => { const m = s.prom ? 'prom' : 'droga';
    if(!cur || cur.properties.m !== m){ cur = {type: 'Feature', properties: {m}, geometry: {type: 'LineString', coordinates: [[s.a[1], s.a[2]]]}}; feats.push(cur); }
    cur.geometry.coordinates.push([s.b[1], s.b[2]]); });
  map.getSource('trasa').setData({type: 'FeatureCollection', features: feats});
  // znaczniki: flagi krajów, granice poza Schengen, start i cel
  ML.markers.forEach(m => m.remove()); ML.markers = [];
  R.order.forEach(c => { const pts = R.chain.filter(p => p[3] === c); if(!pts.length) return;
    const m = pts[Math.floor((pts.length - 1) / 2)];
    mlMarker(flagSvg(c, 24), 'mk-flag' + (KR[c].schengen ? '' : ' x'), [m[1], m[2]], KR[c].n + (KR[c].schengen ? '' : ' – poza Schengen'), 'bottom-left', [8, -6]); });
  R.borders.forEach(b => mlMarker('', 'mk-bx', [b.lon, b.lat], `Granica: ${b.a} – ${b.b}`));
  const a = R.chain[0], z = R.chain[R.chain.length - 1];
  mlMarker('', 'mk-a', [a[1], a[2]], R.fromName); mlMarker('', 'mk-b', [z[1], z[2]], R.toName);
  (R.via || []).forEach((p, i) => mlMarker(String(i + 1), 'mk-via', [p.lon, p.lat], 'Przez: ' + p.name));
  nights().stops.forEach((s, i) => mlMarker(`<span>${i + 1}</span>`, 'mk-night', [s.lon, s.lat], `Nocleg ${i + 1}: ${s.place}`));
  if(false) campsAll().forEach(x => mlMarker(x.kind === 'kamper' ? 'P' : '⛺', 'mk-camp ' + x.kind, [x.lon, x.lat], (x.name || 'Kemping') + ` (${x.kind === 'kamper' ? 'dla kamperów' : 'kemping'})`));
  if(LPG.show && LPG.items && LPG.key === lpgKey()) LPG.items.forEach(x => mlMarker('LPG', 'mk-lpg', [x.lon, x.lat], 'LPG: ' + (x.name || 'stacja')));
  // dopasowanie widoku do trasy
  const b = new maplibregl.LngLatBounds(); R.chain.forEach(p => b.extend([p[1], p[2]]));
  const key = R.fromName + R.toName + R.km;
  if(ML.fitKey !== key){ ML.fitKey = key;
    const pd = isDesk() ? {top: 50, right: 50, bottom: 70, left: 50} : {top: 18, right: 18, bottom: 46, left: 18};
    map.fitBounds(b, {padding: pd, maxZoom: 9, duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 700}); }
}
function mlHighlight(cc){ if(ML.state !== 'ready' || !ML.map.getLayer('kraje-hl') || ML.hl === cc) return; ML.hl = cc; ML.map.setFilter('kraje-hl', ['==', ['get', 'cc'], cc || '']); }

/* ---------- trasa ---------- */
// najkrótsza droga po sieci dróg w Polsce (Dijkstra)
function plPath(from, to){
  const W = T.drogi.wezly, adj = {};
  T.drogi.drogi.forEach(([a, b, t]) => { const d = hav(W[a], W[b]);
    (adj[a] = adj[a] || []).push([b, d, t]); (adj[b] = adj[b] || []).push([a, d, t]); });
  const dist = {[from]: 0}, prev = {}, done = new Set();
  while(true){
    let u = null; for(const n in dist) if(!done.has(n) && (u === null || dist[n] < dist[u])) u = n;
    if(u === null || u === to) break; done.add(u);
    for(const [v, d, t] of adj[u] || []){ const nd = dist[u] + d; if(dist[v] == null || nd < dist[v]){ dist[v] = nd; prev[v] = [u, t]; } }
  }
  const path = [to], tolls = new Set(); let n = to;
  while(prev[n]){ if(prev[n][1]) tolls.add(prev[n][1]); n = prev[n][0]; path.unshift(n); }
  return {pts: path.map(p => [p, W[p][0], W[p][1], 'PL']), tolls};
}
const norm = s => (s || '').trim().toLowerCase();
function findRoute(from, to){
  const destKey = n => Object.keys(T.cele).find(k => norm(T.cele[k].n) === norm(n));
  const startKey = n => T.starty.find(k => norm(k) === norm(n));
  if(startKey(from) && destKey(to)) return {start: startKey(from), dest: destKey(to), rev: false};
  if(destKey(from) && startKey(to)) return {start: startKey(to), dest: destKey(from), rev: true};
  return null;
}
function buildRoute(f, warId){
  const d = T.cele[f.dest];
  const want = warId || (S.route.war || {})[f.dest];
  const war = d.warianty.find(w => w.id === want) || d.warianty[0];
  const pl = plPath(f.start, war.bramka);
  let chain = [...pl.pts, ...war.punkty];
  let segs = [];
  for(let i = 0; i < chain.length - 1; i++) segs.push({a: chain[i], b: chain[i + 1], prom: chain[i + 1][4] === 'prom'});
  let borders = (war.granice || []).map(b => ({...b}));
  if(f.rev){
    chain = chain.slice().reverse(); segs = segs.reverse().map(s => ({a: s.b, b: s.a, prom: s.prom}));
    borders = borders.reverse().map(b => ({...b, a: b.b, b: b.a, tam: b.powrot, powrot: b.tam}));
  }
  const perC = {}; let km = 0, promKm = 0;
  segs.forEach(s => {
    const len = hav([s.a[1], s.a[2]], [s.b[1], s.b[2]]) * CONFIG.krety;
    if(s.prom){ promKm += len / CONFIG.krety; return; }
    const ca = s.a[3], cb = s.b[3];
    if(ca === cb) perC[ca] = (perC[ca] || 0) + len; else { perC[ca] = (perC[ca] || 0) + len / 2; perC[cb] = (perC[cb] || 0) + len / 2; }
    km += len;
  });
  const order = []; chain.forEach(p => { if(!order.includes(p[3])) order.push(p[3]); });
  const fromName = f.rev ? d.n : f.start, toName = f.rev ? f.start : d.n;
  return {...f, d, war, chain, segs, borders, perC, km, promKm, order, fromName, toName, plTolls: pl.tolls};
}

const hoursOf = r => { const t = V().typ;
  if(r.api) return r.sec / 3600 * CONFIG.czasApi[t];
  return r.km / ((r.war.predkosc || 85) * CONFIG.tempo[t]) + (r.war.prom ? r.war.prom.h : 0); };

/* ---------- opłaty drogowe wg pojazdu ---------- */
// każda funkcja zwraca listę pozycji {k, e (EUR lub null = wg km), lok, uwaga, opis, link, free}
const est = (c, cls) => { const b = (R.war.bramki || {})[c]; const mn = (KR[c].stawki || {}).mn || {};
  return b && b.I != null ? b.I * (mn[cls] || 1) : null; };
const TOLL = {
  PL(v){
    const s = KR.PL.stawki, out = [];
    if(v.ciezki) out.push({k: 'e-TOLL, kategoria 1 (3,5–12 t)', e: null, uwaga: 'Opłata za kilometr', link: s.etoll,
      opis: 'Kamper powyżej 3,5 t płaci e-TOLL na drogach krajowych i autostradach. Zarejestruj się i włącz aplikację przed wjazdem na płatny odcinek.'});
    if(v.zestaw) out.push({k: 'Auto do 3,5 t z przyczepą – bez e-TOLL', e: 0, free: true,
      opis: 'Nowelizacja podpisana 17 lipca 2026: DMC przyczepy nie sumuje się już z autem. Na odcinkach koncesyjnych płacisz wyższą kategorię.'});
    const wyz = v.ciezki || v.zestaw;
    R.plTolls.forEach(t => { const x = s[t]; if(!x) return;
      if(t === 'A4') out.push({k: x.k, e: (wyz ? x.zlWyzsza : x.zl) / RATE, lok: (wyz ? x.zlWyzsza : x.zl) + ' zł', link: x.link, opis: wyz ? 'Wyższa kategoria dla zestawu i pojazdu powyżej 3,5 t – sprawdź kategorię na stronie operatora.' : 'Dwie bramki po 18 zł.'});
      else if(wyz) out.push({k: x.k, e: null, uwaga: 'Wyższa kategoria', link: x.link, opis: 'Stawka dla zestawu lub pojazdu powyżej 3,5 t – sprawdź cennik operatora.'});
      else out.push({k: x.k, e: x.zl / RATE, lok: fmt(x.zl, x.zl % 1 ? 2 : 0) + ' zł', link: x.link, opis: x.szacunek ? 'Kwota szacunkowa.' : ''}); });
    if(!out.length) out.push({k: 'Bez opłat na tej trasie', e: 0, free: true, opis: 'Drogi krajowe i państwowe autostrady są bezpłatne do 3,5 t.'});
    return out;
  },
  CZ(v){ const s = KR.CZ.stawki;
    if(v.ciezki) return [{k: 'Myto CZ – opłata za km', e: null, uwaga: 'Potrzebna jednostka OBU', link: s.ciezki, opis: 'Pojazdy powyżej 3,5 t płacą myto zamiast winiety. Dla kamperów obowiązuje niska stawka.'}];
    return [{k: 'Winieta elektroniczna, 10 dni', e: s.winieta10, lok: s.lok, link: s.link, opis: v.zestaw ? 'Przyczepa nie wymaga osobnej winiety – liczy się DMC auta.' : 'Kamper do 3,5 t kupuje tę samą winietę co osobowe.'}]; },
  SK(v){ const s = KR.SK.stawki;
    if(v.ciezki) return [{k: 'e-myto – opłata za km', e: null, uwaga: 'Potrzebna jednostka OBU', link: s.ciezki, opis: 'Pojazdy powyżej 3,5 t płacą też na drogach I–III klasy.'}];
    const out = [{k: 'Winieta elektroniczna, 10 dni', e: s.winieta10, link: s.link}];
    if(v.zestaw && v.razem > 3500) out.push({k: 'Winieta na przyczepę, 10 dni', e: s.przyczepa10, link: s.link, uwaga: 'Zestaw powyżej 3,5 t', opis: `Twój zestaw ma ${fmt(v.razem)} kg DMC – przyczepa potrzebuje własnej winiety.`});
    return out; },
  HU(v){ const s = KR.HU.stawki;
    if(v.zestaw) return [{k: 'e-matrica D1, 10 dni', e: s.D1, lok: s.D1lok, link: s.link,
      opis: 'Kategoria wg auta osobowego; przyczepa za autem D1 jest bez opłaty.'}];
    return [{k: 'e-matrica D2, 10 dni', e: s.D2, lok: s.D2lok, link: s.link, uwaga: 'Kamper zawsze D2',
      opis: 'Polskie dowody nie mają wypełnionego pola J, więc kontrola traktuje kampera jako D2 – za D1 grozi mandat. Od 2026 dotyczy to też kamperów powyżej 3,5 t (HU-GO już ich nie obejmuje).'}];
  },
  AT(v){ const s = KR.AT.stawki;
    if(v.ciezki) return [{k: 'GO-Maut – opłata za km', e: null, uwaga: 'Potrzebna GO-Box', link: s.ciezki, opis: 'Liczy się techniczna DMC. Kamper odciążony do 3,5 t, ale technicznie cięższy, też potrzebuje GO-Box.'}];
    const out = [{k: 'Winieta cyfrowa, 10 dni', e: s.winieta10, link: s.link, opis: v.zestaw ? 'Przyczepa nie wymaga winiety.' : ''}];
    if(R.war.brenner) out.push({k: 'Brennerautobahn A13', e: s.brenner, opis: 'Osobna opłata odcinkowa – winieta jej nie obejmuje.'});
    return out; },
  SI(v){ const s = KR.SI.stawki;
    if(v.ciezki) return [{k: 'DarsGO – opłata za km', e: null, uwaga: 'Potrzebne urządzenie DarsGO', link: s.ciezki, opis: 'Pojazdy powyżej 3,5 t (klasy R2–R4) nie kupują winiety.'}];
    const b = !v.zestaw && !v.kemp && +v.wysOs > 1.3 || v.zestaw && +v.wysOs > 1.3;
    return [{k: `e-vinjeta ${b ? '2B' : '2A'}, 7 dni`, e: b ? s['2B'] : s['2A'], link: s.link, uwaga: b ? 'Kategoria 2B' : null,
      opis: v.zestaw ? 'Winieta tylko na auto, przyczepa bez opłaty.' : v.kemp ? 'Kamper zarejestrowany jako kempingowy płaci 2A bez względu na wysokość.'
        : b ? 'Pojazd wyższy niż 1,3 m nad przednią osią i niezarejestrowany jako kamper to 2B.' : ''}]; },
  HR(v){ const cls = v.ciezki ? 'III' : v.zestaw ? (+v.wysOs > 1.9 ? 'III' : 'II') : (+v.wys > 1.9 ? 'II' : 'I');
    const b = (R.war.bramki || {}).HR;
    return [{k: `${b ? b.k : 'Bramki'}, kategoria ${cls}`, e: est('HR', cls), uwaga: cls === 'I' ? null : 'Kategoria ' + cls,
      opis: {I: 'Pojazd do 1,9 m wysokości.', II: v.zestaw ? 'Auto z przyczepą to kategoria II.' : 'Kamper wyższy niż 1,9 m i do 3,5 t.', III: 'Pojazd powyżej 3,5 t albo wysoki pojazd z przyczepą.'}[cls] + ' Kwota szacunkowa; w sezonie letnim stawki są wyższe.'}]; },
  RS(v){ const cls = v.zestaw || +v.wysOs > 1.3 || v.ciezki ? 'II' : 'I'; const b = (R.war.bramki || {}).RS;
    return [{k: `${b ? b.k : 'Bramki'}, kategoria ${cls}`, e: est('RS', cls), uwaga: cls === 'II' ? 'Kategoria II' : null,
      opis: 'Płacisz na bramkach kartą lub gotówką. Kategoria zależy od wysokości nad przednią osią i liczby osi. Kwota szacunkowa.'}]; },
  ME(v){ const cls = v.zestaw || +v.wysOs > 1.3 || v.ciezki ? 'II' : 'I'; const b = (R.war.bramki || {}).ME;
    return [{k: `${b ? b.k : 'Bramka'}, kategoria ${cls}`, e: est('ME', cls), opis: 'Jedyny płatny odcinek autostrady. Pozostałe drogi bez opłat.'}]; },
  BG(v){ const s = KR.BG.stawki;
    if(v.ciezki) return [{k: 'Opłata kilometrowa BG Toll', e: null, uwaga: 'Pojazd powyżej 3,5 t', link: s.link}];
    return [{k: 'Winieta elektroniczna, 7 dni', e: s.tydzien, link: s.link, opis: v.zestaw ? 'Winieta na auto; sprawdź przy zakupie wymagania dla przyczepy.' : ''}]; },
  TR(v){ const cls = v.zestaw ? '3' : '2'; const b = (R.war.bramki || {}).TR;
    return [{k: `${b ? b.k : 'Autostrady'} – HGS, klasa ${cls}`, e: est('TR', cls), uwaga: 'Kup HGS przed autostradą',
      opis: 'Na autostradach nie ma kas. Naklejkę HGS kupisz na poczcie PTT lub stacji tuż za granicą. Kamper z rozstawem osi od 3,2 m to klasa 2. Kwota szacunkowa.'}]; },
  DE(v){ return [{k: 'Bez opłat', e: 0, free: true,
      opis: v.ciezki ? 'Kampery powyżej 3,5 t są zwolnione z Lkw-Maut, jeśli są wyraźnie kamperami i nie wożą towarów.' : v.zestaw ? 'Zestaw z autem do 3,5 t nie płaci Maut.' : 'Autostrady bezpłatne dla pojazdów do 3,5 t.'}]; },
  IT(v){ const cls = v.zestaw || v.ciezki && +v.osie >= 3 ? '3' : +v.wysOs > 1.3 ? 'B' : 'A'; const b = (R.war.bramki || {}).IT;
    return [{k: `${b ? b.k : 'Bramki'}, klasa ${cls}`, e: est('IT', cls), uwaga: cls === 'A' ? null : 'Klasa ' + cls, link: KR.IT.stawki.link,
      opis: {A: 'Pojazd do 1,3 m nad przednią osią.', B: 'Pojazd 2-osiowy wyższy niż 1,3 m nad przednią osią.', 3: 'Pojazd z 3 osiami, także auto z przyczepą 1-osiową.'}[cls] + ' Kwota szacunkowa.'}]; },
  FR(v){ const cls = v.ciezki ? '3' : v.zestaw ? '2' : +v.wys > 3 ? '3' : +v.wys > 2 ? '2' : '1'; const b = (R.war.bramki || {}).FR;
    return [{k: `${b ? b.k : 'Péage'}, klasa ${cls}`, e: est('FR', cls), uwaga: cls === '1' ? null : 'Klasa ' + cls, link: KR.FR.stawki.link,
      opis: {1: 'Pojazd do 2 m wysokości.', 2: v.zestaw ? 'Auto z przyczepą to zwykle klasa 2.' : 'Pojazd 2–3 m wysokości, do 3,5 t.', 3: 'Pojazd wyższy niż 3 m albo powyżej 3,5 t.'}[cls] + ' Kwota szacunkowa.'}]; },
  ES(v){ const cls = v.ciezki || v.zestaw ? 'Pesados 1' : 'Ligeros'; const b = (R.war.bramki || {}).ES;
    return [{k: `${b ? b.k : 'Autopistas'}, ${cls}`, e: est('ES', cls), opis: 'Większość autostrad w Hiszpanii jest bezpłatna. Kwota szacunkowa.'}]; },
  PT(v){ const cls = v.zestaw || v.ciezki && +v.osie >= 3 ? '3' : +v.wysOs >= 1.1 ? '2' : '1'; const b = (R.war.bramki || {}).PT;
    return [{k: `${b ? b.k : 'Autostrady'}, klasa ${cls}`, e: est('PT', cls), uwaga: 'Zarejestruj EasyToll', link: KR.PT.stawki.link,
      opis: 'Część autostrad nie ma bramek – kartę zarejestrujesz zaraz po wjeździe. Kamper wyższy niż 1,1 m nad przednią osią to klasa 2. Kwota szacunkowa.'}]; },
  DK(){ return [{k: 'Bez opłat na tej trasie', e: 0, free: true, opis: 'Autostrady w Jutlandii są bezpłatne. Płatne są mosty Storebælt i Øresund.'}]; },
  SE(){ const b = (R.war.bramki || {}).SE;
    return [{k: b ? b.k : 'Bez opłat na autostradach', e: b ? null : 0, free: !b, link: KR.SE.stawki.link,
      opis: b ? 'Opłata w dni robocze przy przejeździe przez miasto. Rachunek przychodzi przez Epass24.' : ''}]; },
  NO(v){ const b = (R.war.bramki || {}).NO;
    return [{k: b ? b.k : 'Bompenger – AutoPASS', e: null, uwaga: 'Zarejestruj się w Epass24', link: KR.NO.stawki.link,
      opis: (v.ciezki ? 'Pojazd powyżej 3,5 t płaci wyższą stawkę; kamper M1 z umową AutoPASS może płacić jak osobowy. ' : '') + 'Bramki są bez szlabanów, rachunek przychodzi pocztą.'}]; }
};
const WINIETY = new Set(['CZ', 'SK', 'HU', 'AT', 'SI', 'BG', 'CH']);
const tollsFor = c => {
  if(R.api && WINIETY.has(c) && !(R.hwKm[c] > 1)) return [{k: 'Trasa bez autostrad i ekspresówek', e: 0, free: true, opis: 'Na tej trasie winieta nie jest potrzebna.'}];
  if(R.api && KR[c].stawki && KR[c].stawki.kmI && !(R.tollKm[c] > 1)) return [{k: 'Bez płatnych odcinków', e: 0, free: true}];
  if(!R.api && KR[c].stawki && KR[c].stawki.kmI && !(R.war.bramki || {})[c]) return [{k: 'Bez płatnych odcinków na tej trasie', e: 0, free: true}];
  return TOLL[c] ? TOLL[c](V()) : [];
};
function tollSum(){ let e = 0, open = 0; R.order.forEach(c => tollsFor(c).forEach(t => { if(t.e == null) open++; else e += t.e; })); return {e, open}; }
function ferryCost(){ const p = R.war.prom; if(!p || !p.od) return null; const v = V();
  const f = (1 + Math.max(0, +v.dl - 6) * .15) * (v.ciezki ? 1.1 : 1);
  return {od: p.od * f, sezon: p.sezon * f}; }
// cena w kraju bez danych (np. Kosowo) = średnia z krajów na trasie, które mają ceny
const fuelPrice = c => { const p = KR[c] && KR[c][S.fuel]; if(p > 0) return p;
  const k = R.order.map(x => KR[x] && KR[x][S.fuel]).filter(v => v > 0); return k.length ? k.reduce((s, v) => s + v, 0) / k.length : 1.8; };
const fuelCalc = () => { let e = 0, l = 0; R.order.forEach(c => { const x = (R.perC[c] || 0) * S.cons / 100; l += x; e += x * fuelPrice(c); }); return {e, l}; };
const ovalHtml = c => `<span class="oval ${KR[c].schengen ? '' : 'x'}" title="${esc(KR[c].n)}">${KR[c].o}</span>`;
const waitOf = b => b.id && liveBorders[b.id] ? (R.rev ? {tam: liveBorders[b.id].powrot, powrot: liveBorders[b.id].tam} : liveBorders[b.id]) : {tam: b.tam, powrot: b.powrot};
const mins = m => m == null ? 'brak danych' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ' ' + m % 60 + ' min' : ''}`;

/* ---------- wybór trasy: demo (warianty) albo ORS przez Workera ---------- */
const ccOfName = n => Object.keys(KR).find(c => KR[c].map === n);
function demoPick(f){
  // tryb demo: „omijaj kraj” wybiera wariant, który go nie przecina
  const d = T.cele[f.dest], av = S.opt.avoidC;
  if(!av.length) return null;
  const ok = d.warianty.find(w => !w.punkty.some(p => av.includes(p[3])));
  return ok ? ok.id : false;
}
function setRoute(force){
  if(API()) return setRouteApi(force);
  const f = findRoute($('#from').value, $('#to').value);
  if(f && R && !R.api && force !== true && f.start === R.start && f.dest === R.dest && f.rev === R.rev) return;
  if(!f){ msg('Tej trasy nie ma jeszcze w wersji demo. Wybierz miasto z listy.'); return; }
  const pick = demoPick(f);
  if(pick === false){ msg(`W wersji demo nie ma wariantu omijającego: ${S.opt.avoidC.map(c => KR[c].n).join(', ')}.`); }
  else msg('');
  R = buildRoute(f, pick || undefined);
  S.route.from = $('#from').value; S.route.to = $('#to').value; store.set('route', S.route);
  drawMap(); renderAll();
}
function msg(t){ $('#routeMsg').hidden = !t; $('#routeMsg').textContent = t; }

/* --- Worker gdzieponiesie-api (v15): geokodowanie, trasy ORS, kolejki nakordoni.eu --- */
const geoCache = {};
async function geocode(q){
  if(geoCache[q]) return geoCache[q];
  const r = await getJSON(CONFIG.routeApi + '/geocode?q=' + encodeURIComponent(q));
  return (geoCache[q] = (r.results || []).map(x => ({...x, name: x.name || x.label.split(',')[0]})));
}
let sugFor = null, sugT;
function bindSuggest(inp){
  inp.addEventListener('input', () => {
    if(!API()) return; clearTimeout(sugT);
    const q = inp.value.trim(); delete S.route[inp.id + 'Pt'];
    if(q.length < 3){ $('#sug').hidden = true; return; }
    sugT = setTimeout(async () => {
      try{ const res = await geocode(q); sugFor = inp;
        $('#sug').innerHTML = res.slice(0, 6).map((r, i) => `<li><button type="button" data-i="${i}">${esc(r.name)}<small>${esc(r.label)}</small></button></li>`).join('')
          + '<li class="sug-src">Miejscowości: GeoNames (CC BY 4.0)</li>';
        $('#sug').hidden = !res.length; $('#sug')._res = res;
      }catch(e){ $('#sug').hidden = true; }
    }, 350);
  });
}
function pickSuggestion(i){
  const r = $('#sug')._res[i]; if(!r || !sugFor) return;
  sugFor.value = r.name; S.route[sugFor.id + 'Pt'] = {name: r.name, lon: r.lon, lat: r.lat};
  if(sugFor.dataset.via != null){ S.route.via[+sugFor.dataset.via] = r.name; store.set('route', S.route); }
  $('#sug').hidden = true; setRoute(true);
}
async function pointFor(inp){
  const pt = S.route[inp.id + 'Pt'];
  if(pt && pt.name === inp.value) return pt;
  const res = await geocode(inp.value.trim()); if(!res.length) throw new Error('Nie znaleziono: ' + inp.value);
  return (S.route[inp.id + 'Pt'] = {name: res[0].name, lon: res[0].lon, lat: res[0].lat});
}
// warianty jak w Google: każdy to osobne zapytanie do Workera (Worker cache'uje je 6 h)
const ALTS_BASE = [['fast', 'Najszybsza'], ['free', 'Bez opłat drogowych'], ['shortest', 'Najkrótsza']];
const freeLabel = () => 'Bez opłat w: ' + S.opt.freeC.map(c => KR[c] ? KR[c].n : c).join(', ');
let ALTS = ALTS_BASE;
// Do Skandynawii ORS często wybiera jeden prom (np. z Gdyni). Dokładamy warianty wymuszone przez porty innych przepraw.
function ferryAlts(a, b){
  const scand = p => p.lat > 55.3 && p.lon > 4 && p.lon < 32;
  const north = scand(b) && !scand(a), south = scand(a) && !scand(b);
  if(!north && !south || S.opt.avoid.includes('ferries')) return [];
  const dest = north ? b : a, orig = north ? a : b, out = [];
  for(const f of T.promyPorty || []){
    if(f.lokalny) continue;   // krótkie przeprawy lokalne nie są wariantem do Skandynawii
    if(f.tylkoNO && !(dest.lon < 12.6 && dest.lat > 57.9)) continue;     // promy do Norwegii tylko gdy cel w Norwegii
    if(f.zachod && !(dest.lon < 7.5)) continue;                          // Hirtshals–Stavanger tylko dla zachodniej Norwegii
    if(f.wschodNie && dest.lon < 7.5) continue;
    const via = north ? [f.a, f.b] : [f.b, f.a];
    const score = hav([orig.lon, orig.lat], f.a) + hav(f.b, [dest.lon, dest.lat]) + (f.h || 0) * 25;  // godzina rejsu ≈ 25 km jazdy
    out.push(['prom-' + f.id, 'Prom ' + (north ? f.trasa : f.trasa.split(' – ').reverse().join(' – ')), via, score]);
  }
  return out.sort((x, y) => x[3] - y[3]).slice(0, 4);   // 4 najsensowniejsze przeprawy – oszczędzamy limit ORS
}
let apiSeq = 0, ALT = {}, altPts = null, computeAlt = () => {}; const PENDING = new Set();
async function setRouteApi(){
  const seq = ++apiSeq;
  msg(''); document.body.classList.add('loading');
  let a, b;
  let via = [];
  try{ a = await pointFor($('#from')); b = await pointFor($('#to'));
    for(const inp of $$('#viaRows input')) if(inp.value.trim()) via.push(await pointFor(inp)); }
  catch(e){ msg(e.message); document.body.classList.remove('loading'); return; }
  altPts = [a, b]; ALT = {};
  const v = V();
  const base = {from: [a.lon, a.lat], to: [b.lon, b.lat], via: via.map(p => [p.lon, p.lat]),
    camper: {weight: v.ciezki ? +v.dmc / 1000 : Math.min(3.5, +v.dmc / 1000), height: +v.wys, length: +v.dl},
    fuel: {l100: +S.cons, type: S.fuel === 'pb' ? 'petrol' : 'diesel'}, hu_category: 'D2',
    options: {avoid_highways: S.opt.avoid.includes('highways'), avoid_ferries: S.opt.avoid.includes('ferries'), avoid_countries: S.opt.avoidC}};
  const extra = via.length ? [] : ferryAlts(a, b);   // z własnymi przystankami trasę ustala użytkownik
  if(!S.opt.freeC) S.opt.freeC = [];
  ALTS = [...(S.opt.freeC.length ? [['mix', freeLabel()]] : []), ...ALTS_BASE, ...extra.map(([id, n]) => [id, n])];
  const viaOf = Object.fromEntries(extra.map(([id, , via]) => [id, via]));
  const sel = S.opt.freeC.length ? 'mix' : ALTS.some(([k]) => k === S.altSel) ? S.altSel : 'fast';
  const post = async body => { const r = await fetch(CONFIG.routeApi + '/route', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    const j = await r.json(); if(!r.ok) throw new Error(j.error || 'błąd ' + r.status); return j; };
  const one = async id => {
    try{
      let j;
      if(viaOf[id]){
        // wariant promowy składamy z dwóch odcinków: dojazd do portu + prom (linia prosta) + dalsza jazda.
        // Nie zależy to od tego, czy ORS zna przeprawę (np. Świnoujście – Trelleborg).
        const [A, B] = viaOf[id], f = (T.promyPorty || []).find(x => 'prom-' + x.id === id);
        const [l1, l2] = await Promise.all([post({...base, variant: 'fast', to: A, via: []}), post({...base, variant: 'fast', from: B, via: []})]);
        j = stitchFerry(l1, l2, A, B, f ? f.h : 0);
      } else if(id === 'mix'){
        // najpierw najszybsza trasa, żeby znać miejsca przekroczenia granic; potem odcinki: w wybranych krajach „bez opłat”
        const f0 = await post({...base, variant: 'fast'});
        const wp = [base.from], kinds = [];
        let cur = (f0.path || [])[0];
        (f0.crossings || []).forEach(x => { const inFree = S.opt.freeC.includes(x.from) || S.opt.freeC.includes(x.to);
          if(inFree){ kinds.push(S.opt.freeC.includes(cur) ? 'free' : 'fast'); wp.push(x.at); } cur = x.to; });
        kinds.push(S.opt.freeC.includes(cur) ? 'free' : 'fast'); wp.push(base.to);
        if(wp.length === 2 && kinds[0] === 'fast') throw new Error('Trasa nie przejeżdża przez wybrany kraj');
        const legs = await Promise.all(kinds.map((k, i) => post({...base, variant: k, from: wp[i], to: wp[i + 1], via: []})));
        j = stitchLegs(legs);
      } else j = await post({...base, variant: id});
      if(seq !== apiSeq) return;
      const built = buildFromWorker(j, a, b);
      if(viaOf[id]){
        const f = (T.promyPorty || []).find(x => 'prom-' + x.id === id);
        const fwd = viaOf[id][0][0] === f.a[0] && viaOf[id][0][1] === f.a[1];
        built.war.prom = fwd ? f : {...f, trasa: f.trasa.split(' – ').reverse().join(' – ')};
      }
      built.via = via; ALT[id] = built;
    }catch(e){ if(seq === apiSeq) ALT[id] = {error: e.message}; if(id.startsWith('prom-')) console.warn('Wariant ukryty:', id, e.message); }
    if(seq !== apiSeq) return;
    if(id === sel || (!R || !R.api) && ALT[id] && !ALT[id].error) useAlt(ALT[sel] && !ALT[sel].error ? sel : id);
    else renderTrasa();
    if(id === sel){ document.body.classList.remove('loading');
      if(ALT[id] && ALT[id].error) msg('Nie udało się wyznaczyć trasy: ' + ALT[id].error); }
    PENDING.delete(id); if(R && R.api) renderTrasa();
  };
  // oszczędzamy limit ORS: od razu liczymy tylko wybrany wariant, pozostałe po kliknięciu
  computeAlt = id => { if(ALT[id] || PENDING.has(id)) return; PENDING.add(id); renderTrasa(); one(id).then(() => { if(ALT[id] && !ALT[id].error) useAlt(id); }); };
  PENDING.clear(); PENDING.add(sel); one(sel);
}
function stitchLegs(legs){
  // sklejenie kilku odcinków drogowych w jedną trasę (indeksy płatnych odcinków i promów przesunięte)
  const out = {id: 'mix', title: freeLabel(), km: 0, hours: 0, coords: [], tolls: [], ferries: [], countries: {}, toll_by_country: {}, path: [], crossings: [], elev: [], ascent: 0, cost: {fuel_by_country: {}}};
  legs.forEach(l => {
    const off = out.coords.length, sh = arr => (arr || []).map(([s, e]) => [s + off, e + off]);
    out.coords.push(...l.coords); out.tolls.push(...sh(l.tolls)); out.ferries.push(...sh(l.ferries));
    if(out.elev) out.elev = l.elev ? out.elev.concat(l.elev) : null;
    for(const [k, v] of Object.entries(l.countries || {})) out.countries[k] = (out.countries[k] || 0) + v;
    for(const [k, v] of Object.entries(l.toll_by_country || {})) out.toll_by_country[k] = (out.toll_by_country[k] || 0) + v;
    (l.path || []).forEach(c => { if(out.path[out.path.length - 1] !== c) out.path.push(c); });
    (l.crossings || []).forEach(x => out.crossings.push({...x, at_km: x.at_km + out.km}));
    out.km += l.km || 0; out.hours += l.hours || 0; out.ascent += l.ascent || 0;
    Object.assign(out.cost.fuel_by_country, (l.cost || {}).fuel_by_country || {});
    if(!out.cost.fuel_source && l.cost) { out.cost.fuel_source = l.cost.fuel_source; out.cost.fuel_updated = l.cost.fuel_updated; }
  });
  return out;
}
function stitchFerry(l1, l2, A, B, hFerry){
  const mid = []; for(let i = 1; i < 12; i++){ const t = i / 12; mid.push([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t]); }
  const n1 = l1.coords.length, fS = n1, fE = n1 + mid.length + 1, off = fE + 1;
  const sh = arr => (arr || []).map(([s, e]) => [s + off, e + off]);
  const add = (x, y) => { const o = {...x}; for(const [k, v] of Object.entries(y || {})) o[k] = (o[k] || 0) + v; return o; };
  const path = [...(l1.path || [])]; (l2.path || []).forEach(c => { if(path[path.length - 1] !== c) path.push(c); });
  const ferryKm = hav(A, B);
  return {id: 'fast', title: 'Prom', km: (l1.km || 0) + (l2.km || 0), hours: (l1.hours || 0) + (l2.hours || 0) + hFerry,
    coords: [...l1.coords, A, ...mid, B, ...l2.coords],
    elev: l1.elev && l2.elev ? [...l1.elev, 0, ...mid.map(() => 0), 0, ...l2.elev] : null,
    ascent: (l1.ascent || 0) + (l2.ascent || 0),
    ferries: [...(l1.ferries || []), [fS, fE], ...sh(l2.ferries)], tolls: [...(l1.tolls || []), ...sh(l2.tolls)],
    countries: add(l1.countries, l2.countries), toll_by_country: add(l1.toll_by_country, l2.toll_by_country), path,
    crossings: [...(l1.crossings || []), ...(l2.crossings || []).map(x => ({...x, at_km: x.at_km + (l1.km || 0) + ferryKm}))],
    cost: {...(l1.cost || {}), fuel_by_country: {...((l1.cost || {}).fuel_by_country || {}), ...((l2.cost || {}).fuel_by_country || {})}}};
}
function cheapestAlt(){
  let best = null, bv = Infinity;
  ALTS.forEach(([k]) => { const x = ALT[k]; if(!x || x.error) return; const cx = costsOf(x); if(x.war.prom && !cx.fc) return;   // bez ceny promu nie da się porównać
    const t = cx.total; if(t < bv - 1){ bv = t; best = k; } });
  return ALTS.filter(([k]) => ALT[k] && !ALT[k].error).length > 1 ? best : null;
}
function useAlt(id){
  const r = ALT[id]; if(!r || r.error) return;
  S.altSel = id; R = r;
  S.route.from = altPts[0].name; S.route.to = altPts[1].name; store.set('route', S.route);
  drawMap(); renderAll(); loadBorderWaits(r);
}
function buildFromWorker(j, a, b){
  // kraje spoza naszej bazy – minimalny wpis, żeby nic się nie wysypało
  const SCH = new Set(['AT','BE','BG','CH','CZ','DE','DK','EE','ES','FI','FR','GR','HR','HU','IS','IT','LI','LT','LU','LV','MT','NL','NO','PL','PT','RO','SE','SI','SK']);
  const PLN = {UA: 'Ukraina', MD: 'Mołdawia', BY: 'Białoruś', LT: 'Litwa', LV: 'Łotwa', EE: 'Estonia', FI: 'Finlandia', XK: 'Kosowo', LI: 'Liechtenstein',
    AD: 'Andora', MC: 'Monako', SM: 'San Marino', IE: 'Irlandia', GB: 'Wielka Brytania', IS: 'Islandia', MT: 'Malta', CY: 'Cypr', RU: 'Rosja', GE: 'Gruzja', VA: 'Watykan'};
  const OVAL = {UA: 'UA', MD: 'MD', BY: 'BY', LT: 'LT', LV: 'LV', EE: 'EST', FI: 'FIN', XK: 'RKS', LI: 'FL', AD: 'AND', MC: 'MC', SM: 'RSM', IE: 'IRL', GB: 'UK', IS: 'IS', MT: 'M', CY: 'CY', RU: 'RUS', GE: 'GE', VA: 'V'};
  const known = c => { if(!KR[c] && /^[A-Z]{2}$/.test(c)) KR[c] = {o: OVAL[c] || c, n: PLN[c] || c, map: '', schengen: SCH.has(c), eu: SCH.has(c) && !['CH', 'NO', 'IS', 'LI'].includes(c), gaz: ['Dish'], gazOpis: ''}; return !!KR[c]; };
  const order = [...new Set((j.path || []).filter(known))];
  // kraj każdego punktu: idziemy po trasie i przełączamy kraj na kolejnych przejściach granicznych
  const C = j.coords, X = (j.crossings || []).slice().sort((x, y) => x.at_km - y.at_km);
  const ferryAt = new Uint8Array(C.length), tollAt = new Uint8Array(C.length);
  (j.ferries || []).forEach(([s, e]) => { for(let i = s; i <= e && i < C.length; i++) ferryAt[i] = 1; });
  (j.tolls || []).forEach(([s, e]) => { for(let i = s; i <= e && i < C.length; i++) tollAt[i] = 1; });
  let cc = order[0] || 'PL', xi = 0, cum = 0, last = null;
  const chain = [];
  for(let i = 0; i < C.length; i++){
    if(i) cum += hav(C[i - 1], C[i]);
    while(xi < X.length && cum >= X[xi].at_km){ if(known(X[xi].to)) cc = X[xi].to; xi++; }
    const keep = !last || i === C.length - 1 || ferryAt[i] !== last[5] || hav([last[1], last[2]], C[i]) > 1.2;
    if(keep){ last = ['', C[i][0], C[i][1], cc, (ferryAt[i] ? 8 : 0) | (tollAt[i] ? 2 : 0), ferryAt[i], j.elev ? j.elev[i] : null]; chain.push(last); }
  }
  chain[0][0] = a.name; chain[chain.length - 1][0] = b.name;
  const segs = []; let promKm = 0;
  for(let i = 0; i < chain.length - 1; i++){ const s = {a: chain[i], b: chain[i + 1], prom: !!(chain[i + 1][4] & 8)}; segs.push(s);
    if(s.prom) promKm += hav([s.a[1], s.a[2]], [s.b[1], s.b[2]]); }
  const perC = {}, tollKm = {};
  Object.entries(j.countries || {}).forEach(([c, km]) => { if(known(c)) perC[c] = km; });
  Object.entries(j.toll_by_country || {}).forEach(([c, km]) => { if(known(c)) tollKm[c] = km; });
  // ceny paliwa na żywo z Workera (nakordoni.eu), w zł/l → EUR/l
  const fuelKey = S.fuel;
  Object.entries((j.cost && j.cost.fuel_by_country) || {}).forEach(([c, f]) => { if(KR[c] && f.live && f.price > 0) KR[c][fuelKey] = f.price / RATE; });
  if(j.cost && j.cost.fuel_source && j.cost.fuel_source !== 'fallback') fuelSrc = 'nakordoni.eu' + (j.cost.fuel_updated ? ', ' + String(j.cost.fuel_updated).slice(0, 10) : '');
  // granice poza Schengen
  const borders = (j.crossings || []).filter(x => x.kind === 'external' && known(x.from) && known(x.to)).map(x => ({
    id: null, nk: [x.from, x.to], a: KR[x.from].n, b: KR[x.to].n, lon: x.at[0], lat: x.at[1], tam: null, powrot: null}));
  // prom – dopasowanie do znanych linii po portach
  let prom = null; const fi = chain.findIndex(p => p[4] & 8);
  if(fi > 0){ let li = fi; while(li + 1 < chain.length && chain[li + 1][4] & 8) li++;
    const A = chain[fi], B = chain[li];   // pierwszy i ostatni punkt odcinka promowego = porty
    (T.promyPorty || []).forEach(f => { if(prom) return;
      const pa = ['', f.a[0], f.a[1]], pb = ['', f.b[0], f.b[1]];
      if(near(A, pa[1], pa[2], 30) && near(B, pb[1], pb[2], 30)) prom = f;
      else if(near(B, pa[1], pa[2], 30) && near(A, pb[1], pb[2], 30)) prom = {...f, trasa: f.trasa.split(' – ').reverse().join(' – ')}; });
    if(!prom) Object.values(T.cele).forEach(d => d.warianty.forEach(w => { if(!w.prom || prom) return;
      const pi = w.punkty.findIndex(p => p[4] === 'prom'); const wz = T.drogi.wezly[w.bramka];
      const pa = pi > 0 ? w.punkty[pi - 1] : wz && ['', wz[0], wz[1]], pb = w.punkty[pi];
      if(pa && pb && (near(A, pa[1], pa[2], 30) && near(B, pb[1], pb[2], 30) || near(B, pa[1], pa[2], 30) && near(A, pb[1], pb[2], 30))) prom = w.prom; }));
    if(!prom) prom = {trasa: 'Przeprawa promowa', operator: 'sprawdź u przewoźnika', h: 0}; }
  // płatne odcinki koncesyjne w Polsce
  const plTolls = new Set(), PLT = {A1: [18.75, 53.48], A4: [19.40, 50.14], A2: [17.57, 52.33]};
  chain.forEach(p => { if(p[3] === 'PL' && p[4] & 2) for(const [k, [lo, la]] of Object.entries(PLT)) if(near(p, lo, la, 30)) plTolls.add(k); });
  const bramki = {}; Object.keys(tollKm).forEach(c => { const s = KR[c].stawki; if(s && s.kmI) bramki[c] = {k: `${fmt(Math.round(tollKm[c]))} km płatnych odcinków`, I: tollKm[c] * s.kmI}; });
  const brenner = chain.some(p => near(p, 11.51, 47.0, 8) && p[4] & 2);
  const war = {id: j.id || 'api', n: j.title || 'Trasa', bramki, prom, brenner};
  return {api: true, start: a.name, dest: null, rev: false, d: {n: b.name, warianty: [war]}, war, chain, segs, borders, perC, km: j.km, promKm, order,
          fromName: a.name, toName: b.name, plTolls, hwKm: tollKm, tollKm, sec: (j.hours || 0) * 3600, profile: j.profile,
          ascent: j.ascent || 0, hasElev: !!j.elev, ptA: a, ptB: b};
}
const near = (p, lon, lat, km) => hav([p[1], p[2]], [lon, lat]) < km;
// kolejki z nakordoni.eu: przejście najbliższe miejscu, w którym trasa przecina granicę
async function loadBorderWaits(r){
  const get = (f, t) => getJSON(CONFIG.routeApi + `/border?from=${f}&to=${t}`).catch(() => null);
  await Promise.all(r.borders.map(async b => {
    const [there, back] = await Promise.all([get(b.nk[0], b.nk[1]), get(b.nk[1], b.nk[0])]);
    const best = res => { const L = ((res && res.checkpoints) || []).filter(c => c.wait_min != null); if(!L.length) return null;
      const withPos = L.filter(c => c.lat != null && c.lon != null);
      return withPos.length ? withPos.sort((x, y) => hav([x.lon, x.lat], [b.lon, b.lat]) - hav([y.lon, y.lat], [b.lon, b.lat]))[0] : L[0]; };
    const t = best(there), k = best(back);
    // nakordoni.eu podaje wszystkie przejścia na tej granicy – pokazujemy listę (bez współrzędnych nie wiemy, które jest na trasie)
    const L = ((there && there.checkpoints) || []).filter(c => c.wait_min != null);
    const backBy = {}; ((back && back.checkpoints) || []).forEach(c => { if(c.name) backBy[c.name] = c.wait_min; });
    if(L.length && !L.some(c => c.lat != null)){
      b.cps = L.slice().sort((x, y) => x.wait_min - y.wait_min).slice(0, 6).map(c => ({name: c.name, tam: c.wait_min, powrot: backBy[c.name] ?? null}));
      b.tam = b.cps[0].tam; b.a = KR[b.nk[0]].n; b.b = KR[b.nk[1]].n;
    } else {
      if(t){ b.tam = t.wait_min; if(t.name) b.a = t.name; }
      if(k){ b.powrot = k.wait_min; }
    }
    if(there && there.fetched_at) borderSrc = 'aktualizacja ' + new Date(there.fetched_at * 1000).toLocaleTimeString('pl-PL', {hour: '2-digit', minute: '2-digit'});
  }));
  if(R === r) renderTrasa();
}

/* --- opcje trasy --- */
const OPTS = [['highways', 'Bez autostrad'], ['ferries', 'Bez promów']];
// kraje na trasie, w których są winiety lub bramki (tylko z nich można „zrezygnować”)
function tollC(){
  const base = ALT.fast && !ALT.fast.error ? ALT.fast : R;
  const s = new Set([...(S.opt.freeC || []), ...Object.keys(base.tollKm || {}), ...(base.plTolls && base.plTolls.size ? ['PL'] : [])]);
  return [...s].filter(c => KR[c]);
}
function renderOpts(){
  const transit = R.order.slice(1, -1).concat(S.opt.avoidC.filter(c => !R.order.includes(c)));
  const act = S.opt.avoid.length + S.opt.avoidC.length + (S.opt.freeC || []).length;
  $('#ropts').classList.toggle('open', !!S.optsOpen);
  $('#ropts').innerHTML = `<button class="ro-toggle" aria-expanded="${!!S.optsOpen}">Opcje trasy<span>${act ? act + ' aktywne' : 'najszybsza'}</span></button>
    ${API() ? `<div class="ro-row"><span class="ro-l">Trasa</span>
      ${API() ? '' : `<button class="ro" data-o="fast" aria-pressed="${!S.opt.avoid.length}">Najszybsza</button>`}
      ${API() ? OPTS.map(([k, n]) => `<button class="ro" data-o="${k}" aria-pressed="${S.opt.avoid.includes(k)}">${n}</button>`).join('') : ''}</div>` : ''}
    ${API() && tollC().length ? `<div class="ro-row"><span class="ro-l">Bez opłat w</span>${tollC().map(c => `<button class="ro" data-fc="${c}" aria-pressed="${(S.opt.freeC || []).includes(c)}">${flagSvg(c, 16)}${esc(KR[c].n)}</button>`).join('')}</div>` : ''}
    ${transit.length ? `<div class="ro-row"><span class="ro-l">Omijaj</span>${transit.map(c => `<button class="ro" data-c="${c}" aria-pressed="${S.opt.avoidC.includes(c)}">${flagSvg(c, 16)}${esc(KR[c].n)}</button>`).join('')}</div>` : ''}
    `;
}
$('#ropts').addEventListener('click', e => {
  if(e.target.closest('.ro-toggle')){ S.optsOpen = !S.optsOpen; renderOpts(); return; }
  const b = e.target.closest('.ro'); if(!b) return;
  if(b.dataset.o === 'fast') S.opt.avoid = [];
  else if(b.dataset.o){ const k = b.dataset.o; S.opt.avoid = S.opt.avoid.includes(k) ? S.opt.avoid.filter(x => x !== k) : [...S.opt.avoid, k]; }
  if(b.dataset.fc){ const c = b.dataset.fc, f = S.opt.freeC || []; S.opt.freeC = f.includes(c) ? f.filter(x => x !== c) : [...f, c]; }
  if(b.dataset.c){ const c = b.dataset.c; S.opt.avoidC = S.opt.avoidC.includes(c) ? S.opt.avoidC.filter(x => x !== c) : [...S.opt.avoidC, c]; }
  store.set('ropt', S.opt);
  if(!API() && b.dataset.o){ renderOpts(); return; }
  setRoute(true);
});

$('#from').addEventListener('change', () => { if(!API()) setRoute(); });
$('#to').addEventListener('change', () => { if(!API()) setRoute(); });
/* --- przystanki PRZEZ (maks. 5, tylko z Workerem) --- */
const VIA_MAX = 5;
function renderVia(){
  const list = S.route.via || [];
  $('#viaRows').innerHTML = list.map((v, i) => `<label class="via-row"><span>Przez</span><input id="via${i}" data-via="${i}" value="${esc(v)}" autocomplete="off" placeholder="np. Wiedeń" aria-label="Przystanek ${i + 1}">
    <button type="button" class="via-del" data-vdel="${i}" aria-label="Usuń przystanek ${i + 1}">×</button></label>`).join('');
  $('#viaAdd').hidden = !API() || list.length >= VIA_MAX;
  $$('#viaRows input').forEach(inp => { bindSuggest(inp);
    inp.addEventListener('change', () => { S.route.via[+inp.dataset.via] = inp.value; store.set('route', S.route); });
    inp.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); $('#sug').hidden = true; S.route.via[+inp.dataset.via] = inp.value; setRoute(true); } }); });
}
$('#viaAdd').onclick = () => { S.route.via = [...(S.route.via || []), ''].slice(0, VIA_MAX); renderVia(); const l = $$('#viaRows input'); l[l.length - 1].focus(); };
$('#viaRows').addEventListener('click', e => { const b = e.target.closest('[data-vdel]'); if(!b) return; const i = +b.dataset.vdel;
  S.route.via.splice(i, 1); for(let k = i; k < VIA_MAX; k++){ S.route['via' + k + 'Pt'] = S.route['via' + (k + 1) + 'Pt']; } store.set('route', S.route); renderVia(); setRoute(true); });

['#from', '#to'].forEach(s => { bindSuggest($(s)); $(s).addEventListener('keydown', e => { if(e.key === 'Enter' && API()){ e.preventDefault(); $('#sug').hidden = true; setRoute(true); } }); });
$('#sug').addEventListener('click', e => { const b = e.target.closest('[data-i]'); if(b) pickSuggestion(+b.dataset.i); });
$('#swap').onclick = () => { const a = $('#from').value; $('#from').value = $('#to').value; $('#to').value = a;
  if((S.route.via || []).length){ const n = S.route.via.length, pts = S.route.via.map((_, i) => S.route['via' + i + 'Pt']);
    S.route.via.reverse(); pts.reverse().forEach((p, i) => { S.route['via' + i + 'Pt'] = p; }); renderVia(); void n; }
  const p = S.route.fromPt; S.route.fromPt = S.route.toPt; S.route.toPt = p; setRoute(true); };
$('#variants').addEventListener('click', e => { const cb = e.target.closest('[data-calc]'); if(cb){ computeAlt(cb.dataset.calc); return; }
  const al = e.target.closest('[data-alt]'); if(al){ useAlt(al.dataset.alt); return; }
  const b = e.target.closest('[data-war]'); if(!b) return;
  S.opt.avoidC = []; store.set('ropt', S.opt);
  S.route.war = {...(S.route.war || {}), [R.dest]: b.dataset.war}; store.set('route', S.route); setRoute(true); });

let bordersOpen = false;
function renderTrasa(){
  renderOpts();
  renderExtras();
  const W = R.d.warianty;
  if(R.api){
    const isProm = id => id.startsWith('prom-');
    const promTried = ALTS.some(([id]) => isProm(id));
    $('#variants').innerHTML = ALTS.map(([id, n]) => { const x = ALT[id];
      // warianty promowe pokazujemy tylko wtedy, gdy ORS faktycznie poprowadził przez ten prom
      if(isProm(id) && x && x.error) return '';
      if(!x) return PENDING.has(id) ? `<button class="var" disabled><span>${n}<small>liczę trasę…</small></span></button>`
        : `<button class="var calc" data-calc="${id}"><span>${n}<small>pokaż ten wariant – policzę trasę</small></span></button>`;
      if(x.error) return `<button class="var" disabled><span>${n}<small>${esc(x.error)}</small></span></button>`;
      const c = costsOf(x), eco = id === cheapestAlt();
      return `<button class="var" data-alt="${id}" aria-pressed="${R === x}"><span>${n}${eco ? ' <em class="eco">najtańsza</em>' : ''}<small>${fmt(Math.round(x.km))} km, ${Math.round(c.h)} h, ok. ${money(c.total)}${x.war.prom && !c.fc ? ' + prom' : ''}${x.tollKm && Object.keys(x.tollKm).length ? '' : ', bez płatnych odcinków'}${x.war.prom && !id.startsWith('prom-') ? `<br>${c.fc ? 'z promem ' + esc(x.war.prom.trasa) + ' (cena w sumie)' : 'trasa z promem – bilet płatny osobno, cena u przewoźnika'}` : ''}</small></span></button>`; }).join('');
    if(promTried) $('#variants').insertAdjacentHTML('beforeend', `<p class="var-info">Do Skandynawii pływa więcej promów, np. Świnoujście – Malmö, Gdańsk – Nynäshamn, Rostock – Trelleborg czy Hirtshals – Larvik. Wybór portu sprawdź w nawigacji, a wybrany port dodaj jako przystanek <b>przez</b>. Linki do przewoźników są w zakładce <a href="#winiety">Winiety</a>.</p>`);
  } else
  $('#variants').innerHTML = W.length > 1 ? W.map(w => `<button class="var" data-war="${w.id}" aria-pressed="${w.id === R.war.id}"><span>${esc(w.n)}${w.prom ? `<small>prom ${esc(w.prom.operator)}, ok. ${w.prom.h} h rejsu</small>` : ''}</span></button>`).join('') : '';
  $('#codes').innerHTML = R.order.map(c => `<span data-cc="${c}" class="${KR[c].schengen ? '' : 'x'}" title="${esc(KR[c].n)}${KR[c].schengen ? '' : ' – poza Schengen'}">${flagSvg(c, 20)}${KR[c].o}</span>`).join('');
  const v = V(), f = fuelCalc(), t = tollSum(), fc = ferryCost();
  const h = hoursOf(R);
  $('#tiles').innerHTML = `
    <div class="tile"><small>${R.war.prom ? 'jazdy, plus prom' : 'dystans'}</small><b>${fmt(Math.round(R.km / 10) * 10)} km</b></div>
    <div class="tile"><small>czas w drodze</small><b>${Math.round(h)} h</b></div>
    <a class="tile" href="#winiety"><small>${t.open ? 'opłaty, część wg km' : 'winiety i bramki'}</small><b>${money(t.e)}${t.open ? '+' : ''}</b></a>
    <a class="tile" href="#paliwo"><small>paliwo ${S.fuel === 'on' ? 'ON' : 'Pb 95'}</small><b>${money(f.e)}</b></a>
    ${fc ? `<div class="tile wide"><span class="tw"><small>prom ${esc(R.war.prom.trasa)}, ${esc(R.war.prom.operator)}</small><b>od ok. ${money(fc.od)}</b></span>${R.war.prom.link ? `<a class="buy" href="${esc(R.war.prom.link)}" target="_blank" rel="noopener">Kup bilet</a>` : ''}</div>`
      : R.war.prom ? `<div class="tile wide"><span class="tw"><small>na trasie jest prom${R.war.prom.trasa && R.war.prom.trasa !== 'Przeprawa promowa' ? ' ' + esc(R.war.prom.trasa) : ''}</small><b style="font-size:17px">Bilet płatny osobno – nie ma go w sumie</b><small>Cenę sprawdź u przewoźnika. Linki do promów są w zakładce Winiety.</small></span></div>` : ''}`;
  renderDeskExtra(f, t, fc);
  $('#attr').hidden = !R.borders.length;
  const notes = R.order.filter(c => KR[c].kontrole).map(c => `<div class="calm"><b>${esc(KR[c].n)}</b>${esc(KR[c].kontrole)}</div>`).join('');
  const B = R.borders;
  if(!B.length){
    $('#borders').innerHTML = `<div class="notes">${R.order.some(c => KR[c].eu === false) ? '' : `<div class="calm"><b>Cała trasa w strefie Schengen</b>Kontrole wyrywkowe są możliwe – miej przy sobie dowód.</div>`}${notes}</div>`;
    return;
  }
  const q = m => m < 30 ? 'q-ok' : m < 90 ? 'q-mid' : 'q-bad';
  $('#borders').innerHTML = `
    <button class="amber" id="bBtn" aria-expanded="${bordersOpen}" aria-controls="bList">
      <span><b>${B.length} ${B.length === 1 ? 'granica' : 'granice'} poza Schengen</b><small>${B.map(b => b.cps ? `${esc(KR[b.nk[0]].o)}→${esc(KR[b.nk[1]].o)} od ${mins(b.cps[0].tam)}` : `${esc(b.a)}${waitOf(b).tam != null ? ' ' + mins(waitOf(b).tam) : ''}`).join(', ')}</small></span>
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg>
    </button>
    <ul class="blist" id="bList" ${bordersOpen ? '' : 'hidden'}>
      ${B.map(b => { const w = waitOf(b);
        if(b.cps) return `<li><div class="bn">${esc(b.a)} → ${esc(b.b)}</div><div class="bs">przejścia na tej granicy, osobowe i kampery – wybierz najkrótszą kolejkę</div>
          <table class="cps"><thead><tr><th>Przejście</th><th>tam</th><th>powrót</th></tr></thead><tbody>${b.cps.map((c, i) => `<tr${i === 0 ? ' class="best"' : ''}><td>${esc(c.name || '–')}</td><td><b class="${q(c.tam)}t">${mins(c.tam)}</b></td><td>${c.powrot != null ? mins(c.powrot) : '–'}</td></tr>`).join('')}</tbody></table></li>`;
        return `<li><div class="bn">${esc(b.a)} – ${esc(b.b)}</div><div class="bs">kontrola paszportowa, osobowe i kampery</div>
        <div class="q"><span>Tam</span><span class="tr"><i class="${q(w.tam || 0)}" style="width:${Math.min(100, (w.tam || 0) / 1.5)}%"></i></span><b>${mins(w.tam)}</b>
        <span>Powrót</span><span class="tr"><i class="${q(w.powrot || 0)}" style="width:${Math.min(100, (w.powrot || 0) / 1.5)}%"></i></span><b>${mins(w.powrot)}</b></div></li>`; }).join('')}
      <li class="fine" style="background:none;padding:0 4px">Dane o kolejkach na granicach: <a class="src-link" href="https://nakordoni.eu/" target="_blank" rel="noopener">Data by nakordoni.eu</a>${borderSrc ? ', ' + borderSrc : ', odświeżane co 3 h'}</li>
    </ul>${notes ? `<div class="notes" style="margin-top:8px">${notes}</div>` : ''}`;
  $('#bBtn').onclick = () => { bordersOpen = !bordersOpen; renderTrasa(); };
}

/* ---------- desktop: podsumowanie, porównanie wariantów, druk ---------- */
function costsOf(r){
  const saved = R; R = r;
  const f = fuelCalc(), t = tollSum(), fc = ferryCost(), v = V();
  const h = hoursOf(R);
  R = saved;
  return {f, t, fc, h, total: f.e + t.e + (fc ? fc.od : 0)};
}
function renderDeskExtra(f, t, fc){
  const box = $('#deskExtra'); if(!box) return;
  const total = f.e + t.e + (fc ? fc.od : 0);
  let cmp = '';
  if(!R.api && R.d.warianty.length > 1){
    const fr = {start: R.start, dest: R.dest, rev: R.rev};
    const rows = R.d.warianty.map(w => ({w, c: costsOf(buildRoute(fr, w.id)), r: buildRoute(fr, w.id)}));
    const best = Math.min(...rows.map(x => x.c.total));
    cmp = `<h2 class="sub">Porównanie wariantów</h2><div class="cmp"><table><thead><tr><th>Wariant</th><th>km</th><th>czas</th><th>razem</th></tr></thead><tbody>
      ${rows.map(x => `<tr class="${x.w.id === R.war.id ? 'on' : ''}"><td><button data-war="${x.w.id}">${esc(x.w.n)}</button></td><td>${fmt(Math.round(x.r.km / 10) * 10)}</td><td>${Math.round(x.c.h)} h</td><td><b>${money(x.c.total)}</b>${x.c.total === best ? '<small>najtaniej</small>' : ''}</td></tr>`).join('')}
      </tbody></table></div>`;
  }
  box.innerHTML = `<div class="sum-card"><div><small>Koszt podróży w jedną stronę</small><b>${money(total)}${t.open || (R.war.prom && !fc) ? '+' : ''}</b>
      <span>paliwo ${money(f.e)}, opłaty ${money(t.e)}${fc ? `, prom od ${money(fc.od)}` : R.war.prom ? ', + bilet na prom (cena u przewoźnika)' : ''}</span></div>
      <button class="btn" id="printBtn">Drukuj plan</button></div>${cmp}`;
  $('#printBtn').onclick = printPlan;
  box.querySelectorAll('[data-war]').forEach(b => b.onclick = () => { S.route.war = {...(S.route.war || {}), [R.dest]: b.dataset.war}; store.set('route', S.route); setRoute(true); });
}

/* ---------- paliwo ---------- */
function renderPaliwo(){
  const f = fuelCalc(), fn = S.fuel === 'on' ? 'ON' : 'Pb 95';
  $('#fuelHero').innerHTML = `<small>${esc(R.fromName)} – ${esc(R.toName)} w jedną stronę</small><b>${money(f.e)}</b><span>${fmt(Math.round(f.l))} l ${fn} na ${fmt(Math.round(R.km / 10) * 10)} km${R.war.prom ? ' (bez odcinka promem)' : ''}</span>`;
  $('#consVal').textContent = fmt(+S.cons, 1) + ' l';
  $('#chartTitle').textContent = `Cena ${fn} na trasie, ${curUnit()}`;
  const cs = R.order.filter(c => KR[c][S.fuel]);
  const ps = cs.map(c => KR[c][S.fuel]), min = Math.min(...ps), max = Math.max(...ps), base = min * .85;
  const cheap = cs[ps.indexOf(min)];
  $('#chart').innerHTML = cs.map((c, i) => `<div data-cc="${c}" class="col ${c === cheap ? 'c' : KR[c].schengen ? '' : 'x'}"><b>${litre(ps[i])}</b><i style="height:${Math.round(150 * (ps[i] - base) / (max - base || 1))}px"></i><span class="col-c">${flagSvg(c, 20)}${KR[c].o}</span></div>`).join('');
  $('#fuelTip').innerHTML = `<span><b>${esc(KR[cheap].n)}</b> ma najtańszy ${fn} na trasie. ${cheap === R.order[R.order.length - 1] ? 'Zatankuj do pełna przed powrotem.' : 'Zatankuj tam do pełna.'}</span>`;
  $('#fuelSrc').textContent = `Ceny: ${fuelSrc}. Kurs 1 € = ${fmt(RATE, 2)} zł${fxSrc ? ' (' + fxSrc + ')' : ''}.`;
}
$('#v-paliwo').addEventListener('click', e => {
  const b = e.target.closest('[data-cons]'); if(!b) return;
  S.cons = Math.min(30, Math.max(4, +S.cons + +b.dataset.cons)); store.set('cons', S.cons); renderAll();
});

/* ---------- winiety i promy ---------- */
function renderWiniety(){
  const t = tollSum(), v = V();
  $('#tollHero').innerHTML = `<small>${esc(R.fromName)} – ${esc(R.toName)}, ${TYP_N[v.typ].toLowerCase()}</small><b>${money(t.e)}</b><span>winiety i bramki w jedną stronę${t.open ? `, plus ${t.open} ${t.open === 1 ? 'opłata' : 'opłaty'} liczone za km` : ''}</span>`;
  $('#tolls').innerHTML = R.order.flatMap(c => tollsFor(c).map(x => `
    <li class="card" data-cc="${c}"><div class="card-h">${ovalHtml(c)}<span class="nm">${esc(KR[c].n)}<small>${esc(x.k)}</small></span>
      <span class="pr ${x.free ? 'free' : ''}">${x.free ? '0 ' + (S.cur === 'pln' ? 'zł' : '€') : x.e != null ? 'ok. ' + money(x.e, false) : 'wg km'}</span></div>
      ${(x.uwaga || x.opis || x.lok) ? `<p>${x.uwaga ? `<span class="flag">${esc(x.uwaga)}</span>` : ''}${esc(x.opis || '')}${x.lok && (S.cur === 'eur' || !/zł/.test(x.lok)) ? ` Na miejscu: ${esc(x.lok)}.` : ''}</p>` : ''}
      ${x.link ? `<a class="buy" href="${esc(x.link)}" target="_blank" rel="noopener">${/winieta|vinjeta|matrica/i.test(x.k) ? 'Kup online' : 'Strona operatora'}</a>` : ''}</li>`)).join('');
  const p = R.war.prom, fc = ferryCost();
  const other = T.promyInne.filter(o => !p || o.trasa !== p.trasa);
  const scand = R.order.some(c => ['SE', 'NO', 'DK'].includes(c));
  $('#ferries').innerHTML = (p ? `<h2 class="sub">Prom na trasie</h2>
    <div class="ferry"><div class="ferry-h"><span><b>${esc(p.trasa)}</b><small>${esc(p.operator)}${p.h ? `, rejs ok. ${p.h} h` : ''}</small></span>
      <span class="pr">${fc ? `od ok. ${money(fc.od)}<small>w sezonie ok. ${money(fc.sezon)}</small>` : '<small>cena u przewoźnika</small>'}</span></div>
      <p>${p.opis ? esc(p.opis) + ' ' : ''}${fc ? `Szacunek dla Twojego pojazdu: ${fmt(+v.dl, 1)} m długości${v.zestaw ? ', zestaw z przyczepą' : ''}.` : 'Tej przeprawy nie mamy w cenniku – sprawdź cenę u przewoźnika.'}</p>
      ${p.link ? `<a class="buy" href="${esc(p.link)}" target="_blank" rel="noopener">Kup bilet – ${esc(p.operator)}</a>` : ''}</div>` : '')
    + (scand ? `<h2 class="sub">Inne promy do Skandynawii</h2><ul class="olist">${other.map(o => `<li><span>${esc(o.trasa)}<br><small class="var-note">${esc(o.operator)}</small></span><a href="${esc(o.link)}" target="_blank" rel="noopener">Bilety</a></li>`).join('')}</ul>` : '');
  $('#tollFine').textContent = `Stawki dla: ${TYP_N[v.typ].toLowerCase()}. Kwoty „ok.” są szacunkowe – przed zakupem sprawdź na stronie operatora. Ceny promów zależą od terminu i długości pojazdu.`;
}

/* ---------- gaz ---------- */
const ADP = {
  Dish: {n: 'Dish (talerzowe)', d: 'Płaska tarcza z otworem w środku. Pistolet przykładasz i dociskasz dźwignią.',
    s: '<rect class="a-f1 a-l" x="60" y="54" width="22" height="12"/><rect class="a-f2 a-l" x="82" y="16" width="12" height="88" rx="3"/><path class="a-l" d="M94 52h4v16h-4"/><circle class="a-f2 a-l" cx="182" cy="60" r="44"/><circle class="a-t" cx="182" cy="60" r="36" stroke-dasharray="3 3"/><circle class="a-f1 a-l" cx="182" cy="60" r="11"/><circle class="a-d" cx="182" cy="60" r="4"/>'},
  ACME: {n: 'ACME (gwintowane)', d: 'Gruby gwint zewnętrzny. Pistolet nakręcasz na króciec.',
    s: '<path class="a-f2 a-l" d="M60 38h70v44H60z"/><path class="a-f2 a-l" d="M64 38l4-6h6l4 6M78 38l4-6h6l4 6M92 38l4-6h6l4 6M106 38l4-6h6l4 6M120 38l3-6h5l2 6M64 82l4 6h6l4-6M78 82l4 6h6l4-6M92 82l4 6h6l4-6M106 82l4 6h6l4-6M120 82l3 6h5l2-6"/><path class="a-l" d="M130 50h6v20h-6"/><circle class="a-f2 a-l" cx="186" cy="60" r="34"/><circle class="a-t" cx="186" cy="60" r="28" stroke-dasharray="3 3"/><circle class="a-f1 a-l" cx="186" cy="60" r="16"/><circle class="a-d" cx="186" cy="60" r="5"/>'},
  Bayonet: {n: 'Bagnet', d: 'Rura z dwoma występami. Pistolet wsuwasz i przekręcasz, aż zaskoczy.',
    s: '<rect class="a-f2 a-l" x="60" y="44" width="82" height="32" rx="2"/><rect class="a-f1 a-l" x="130" y="32" width="9" height="12"/><rect class="a-f1 a-l" x="130" y="76" width="9" height="12"/><circle class="a-f2 a-l" cx="190" cy="60" r="22"/><rect class="a-f1 a-l" x="157" y="55" width="11" height="10"/><rect class="a-f1 a-l" x="212" y="55" width="11" height="10"/><circle class="a-f1 a-l" cx="190" cy="60" r="9"/><circle class="a-d" cx="190" cy="60" r="3.5"/>'},
  Euronozzle: {n: 'Euronozzle', d: 'Długa, smukła końcówka z rowkiem. Pistolet nasuwasz, aż się zatrzaśnie.',
    s: '<path class="a-f2 a-l" d="M60 50h66v-2h6v2h14a10 10 0 0 1 0 20h-14v2h-6v-2H60z"/><path class="a-t" d="M118 50v20M114 50v20"/><circle class="a-f2 a-l" cx="196" cy="60" r="16"/><circle class="a-f1 a-l" cx="196" cy="60" r="8"/><circle class="a-d" cx="196" cy="60" r="3"/>'}
};
const STUB = '<rect class="a-f1 a-l" x="14" y="51" width="26" height="18"/><path class="a-t" d="M18 51v18M22 51v18M26 51v18M30 51v18M34 51v18"/><path class="a-f1 a-l" d="M40 44h20v32H40z"/><path class="a-t" d="M40 52h20M40 68h20"/>';
const adSvg = t => `<svg viewBox="0 0 240 120" role="img" aria-label="Rysunek złącza ${ADP[t].n}">${STUB}${ADP[t].s}<text class="a-x" x="78" y="116" text-anchor="middle">z boku</text><text class="a-x" x="190" y="116" text-anchor="middle">od czoła</text></svg>`;
let gasOpen = null;
function renderGaz(){
  const lb = $('#lpgBox'); if(lb) lb.innerHTML = `<h2 class="sub">Stacje LPG na trasie${LPG.items && LPG.items.length ? ` (${LPG.items.length})` : ''}</h2>` + lpgHtml();
  if(API() && R && R.api && !$('#v-gaz').hidden) loadLpg();
  const list = S.gas === 'route' ? R.order.slice() : Object.keys(KR);
  if(S.gas === 'all') list.sort((a, b) => (R.order.includes(b) - R.order.includes(a)));
  $('#gas').innerHTML = list.map(c => { const v = KR[c], prim = v.gaz[0], open = gasOpen === c;
    return `<li class="card" data-cc="${c}"><button class="card-h" data-gas="${c}" aria-expanded="${open}">${ovalHtml(c)}
      <span class="nm">${esc(v.n)}<small>${v.gaz.join(', ')}${v.lpg ? ` <span class="lpg">LPG ${litre(v.lpg)} ${curUnit()}</span>` : ''}</small></span>
      <span class="need ${prim === 'Dish' ? 'ok' : ''}">${prim === 'Dish' ? 'bez przejściówki' : 'przejściówka ' + prim}</span>
      <svg class="chev" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M3 6l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4"/></svg></button>
      ${open ? `<p>${esc(v.gazOpis)}</p><div class="ads">${v.gaz.map(g => `<div class="ad">${adSvg(g)}<h3>${ADP[g].n}${g === 'Dish' ? ' – jak w Polsce' : ''}</h3><p>${ADP[g].d}</p></div>`).join('')}</div>` : ''}</li>`; }).join('');
}
$('#gas').addEventListener('click', e => { const b = e.target.closest('[data-gas]'); if(!b) return; gasOpen = gasOpen === b.dataset.gas ? null : b.dataset.gas; renderGaz(); });

/* ---------- serwis: listy przed wyjazdem ---------- */
let L = store.get('lists', {checked: {}, hidden: [], custom: {}, groups: []});
const saveL = () => store.set('lists', L);
function greenCard(){
  const zk = K.zielonaKarta, codes = R.order.map(c => c === 'MK' ? 'MK' : c);
  const need = codes.filter(c => zk.wymagana.includes(c));
  const outEU = R.order.filter(c => KR[c].eu === false && !need.includes(c));
  if(need.length) return [`Zielona Karta wymagana: ${need.map(c => (KR[c] || {}).n || zk.nazwy[c]).join(', ')}`, 'Polskie OC tam nie wystarczy – kup Zieloną Kartę u ubezpieczyciela przed wyjazdem'];
  if(outEU.length) return [`Zielona Karta niepotrzebna: ${outEU.map(c => KR[c].n).join(', ')}`, 'Polskie OC jest tam ważne. Weź polisę i numer assistance'];
  return null;
}
function autoItems(){
  const o = R.order, v = V(), out = [];
  const gc = greenCard(); if(gc) out.push(gc);
  o.forEach(c => tollsFor(c).forEach(t => { if(t.link && !t.free) out.push([`${t.e != null ? 'Kup' : 'Załatw'}: ${KR[c].n} – ${t.k}`, t.link.replace(/^https?:\/\//, '')]); }));
  if(o.includes('TR')) out.push(['Paszport – sprawdź aktualne wymogi wjazdu do Turcji']);
  if(o.includes('IT')) out.push(['Tablica ostrzegawcza na bagażnik rowerowy', 'Wymagana we Włoszech']);
  if(o.includes('ES')) out.push(['Tablica ostrzegawcza V-20 na bagażnik rowerowy', 'Wymagana w Hiszpanii']);
  if(o.includes('FR')) out.push(['Naklejka Crit’Air', 'Na wjazd do stref w dużych miastach']);
  if(o.includes('DE')) out.push(['Plakietka ekologiczna Umweltplakette', 'Na wjazd do stref w miastach']);
  if(o.includes('NO')) out.push(['Rejestracja w Epass24 przed wjazdem do Norwegii', 'Bez tego zapłacisz dopłatę za ustalenie właściciela']);
  if(R.war.prom) out.push([`Bilet na prom ${R.war.prom.trasa}`, `${R.war.prom.operator} – podaj dokładną długość i wysokość pojazdu`]);
  if(v.zestaw){ out.push(['Lusterka boczne przedłużone', 'Gdy przyczepa jest szersza od auta']);
    if(o.includes('HR')) out.push(['Drugi trójkąt ostrzegawczy dla przyczepy', 'Zalecany – przydatny w Chorwacji, gdzie jest wymagany dla tamtejszych zestawów']);
    out.push(['Sprawdź nacisk na hak i ciśnienie w oponach przyczepy']); }
  if(v.ciezki){ out.push(['Prawo jazdy kat. C1 lub C', 'Kamper powyżej 3,5 t'], ['Ograniczenia prędkości dla pojazdów powyżej 3,5 t', 'W wielu krajach niższe niż dla osobowych']); }
  if(v.wys > 3.2) out.push(['Uwaga na niskie przejazdy i tunele', `Twój pojazd ma ${fmt(+v.wys, 2)} m wysokości`]);
  const seen = new Set(); return out.filter(x => !seen.has(x[0]) && seen.add(x[0]));
}
function renderLists(){
  const groups = [{id: 'auto', n: `${R.fromName} – ${R.toName}`, auto: true, p: autoItems()}, ...LST.listy, ...L.groups.map(g => ({...g, p: [], user: true}))];
  $('#groups').innerHTML = groups.map(g => {
    const items = [...g.p.map((x, j) => ({key: g.id + ':' + (g.auto ? x[0] : j), t: x[0], s: x[1]})).filter(x => !L.hidden.includes(x.key)),
                   ...(L.custom[g.id] || []).map(x => ({key: x.id, t: x.t, mine: true}))];
    if(g.auto && !items.length) return '';
    const done = items.filter(x => L.checked[x.key]).length;
    return `<section class="grp ${g.auto ? 'auto' : ''}"><div class="grp-h"><h3>${g.auto ? '<small>dla tej trasy i pojazdu</small>' : ''}${esc(g.n)}</h3>
      <span class="cnt ${done === items.length && items.length ? 'full' : ''}">${done}/${items.length}${g.user ? `<button class="del" data-dg="${g.id}" aria-label="Usuń listę ${esc(g.n)}">×</button>` : ''}</span></div>
      ${g.uwaga ? `<p class="grp-note">${esc(g.uwaga)}</p>` : ''}
      <ul class="items">${items.map(x => `<li><label><input type="checkbox" data-k="${esc(x.key)}" ${L.checked[x.key] ? 'checked' : ''}><span><span class="t">${esc(x.t)}</span>${x.mine ? '<span class="mine">własne</span>' : ''}${x.s ? `<small>${esc(x.s)}</small>` : ''}</span></label>
        <button class="del" data-del="${esc(x.key)}" data-g="${g.id}" aria-label="Usuń: ${esc(x.t)}">×</button></li>`).join('')}</ul>
      <div class="add"><input placeholder="Dodaj swój punkt" aria-label="Nowy punkt: ${esc(g.n)}" data-ag="${g.id}" enterkeyhint="done"><button data-ab="${g.id}">Dodaj</button></div></section>`; }).join('');
}
function addItem(g){
  const inp = $(`#groups input[data-ag="${g}"]`), t = inp.value.trim(); if(!t) return;
  (L.custom[g] = L.custom[g] || []).push({id: 'u' + Date.now(), t}); saveL(); renderLists();
  const n = $(`#groups input[data-ag="${g}"]`); if(n) n.focus();
}
$('#groups').addEventListener('change', e => { const x = e.target.closest('[data-k]'); if(!x) return;
  if(x.checked) L.checked[x.dataset.k] = 1; else delete L.checked[x.dataset.k]; saveL(); renderLists(); });
$('#groups').addEventListener('click', e => {
  const d = e.target.closest('[data-del]'), dg = e.target.closest('[data-dg]'), ab = e.target.closest('[data-ab]');
  if(d){ const k = d.dataset.del, g = d.dataset.g;
    if(L.custom[g] && L.custom[g].some(x => x.id === k)) L.custom[g] = L.custom[g].filter(x => x.id !== k); else L.hidden.push(k);
    delete L.checked[k]; saveL(); renderLists(); }
  if(dg && confirm('Usunąć tę listę?')){ L.groups = L.groups.filter(g => g.id !== dg.dataset.dg); delete L.custom[dg.dataset.dg]; saveL(); renderLists(); }
  if(ab) addItem(ab.dataset.ab);
});
$('#groups').addEventListener('keydown', e => { const i = e.target.closest('[data-ag]'); if(i && e.key === 'Enter') addItem(i.dataset.ag); });
$('#addGrp').onclick = () => { const t = $('#newGrp').value.trim(); if(!t) return; L.groups.push({id: 'g' + Date.now(), n: t}); $('#newGrp').value = ''; saveL(); renderLists(); };
$('#newGrp').onkeydown = e => { if(e.key === 'Enter') $('#addGrp').click(); };
$('#uncheck').onclick = () => { L.checked = {}; saveL(); renderLists(); };
$('#restore').onclick = () => { if(confirm('Przywrócić domyślne listy? Twoje własne punkty i listy zostaną usunięte.')){ L = {checked: {}, hidden: [], custom: {}, groups: []}; saveL(); renderLists(); } };

/* ---------- serwis: przeglądy ---------- */
let SV = store.get('svclog', {d: {}, odo: '', custom: [], hidden: []});
const saveS = () => store.set('svclog', SV);
const every = (m, k) => [m ? (m % 12 === 0 ? (m === 12 ? 'co rok' : `co ${m / 12} ${m / 12 < 5 ? 'lata' : 'lat'}`) : `co ${m} mies.`) : '', k ? `co ${fmt(k)} km` : ''].filter(Boolean).join(' lub ');
function renderSvc(){
  const odo = +SV.odo || 0, now = new Date();
  const rows = [...LST.przeglady.filter(r => !SV.hidden.includes(r[0])), ...SV.custom.map(c => [c.id, c.n, +c.m || 0, +c.k || 0, '', true])];
  $('#svc').innerHTML = rows.map(([id, n, m, k, hint, mine]) => {
    const d = SV.d[id] || {}, parts = []; let worst = 9;
    if(d.date && m){ const due = new Date(d.date); due.setMonth(due.getMonth() + m); const days = (due - now) / 864e5;
      const ds = due.toLocaleDateString('pl-PL', {month: 'long', year: 'numeric'}); const lv = days < 0 ? 0 : days < 60 ? 1 : 2;
      worst = Math.min(worst, lv); parts.push(lv === 0 ? `po terminie od ${ds}` : `do ${ds}`); }
    if(d.km && k && odo){ const left = +d.km + k - odo, lv = left < 0 ? 0 : left < 2000 ? 1 : 2;
      worst = Math.min(worst, lv); parts.push(left < 0 ? `przekroczone o ${fmt(-left)} km` : `za ${fmt(left)} km`); }
    const st = parts.length ? `<div class="st ${['st-bad', 'st-mid', 'st-ok'][worst]}">${['Po terminie: ', 'Wkrótce: ', 'Następny: '][worst]}${parts.join(' lub ')}</div>`
      : `<div class="st st-none">${k ? 'Wpisz datę lub przebieg ostatniej wymiany' : 'Wpisz datę ostatniej wymiany'}</div>`;
    return `<li><div class="r1"><span class="nm">${esc(n)}${mine ? '<span class="mine">własne</span>' : ''}<small>${every(m, k)}${hint ? '. ' + esc(hint) : ''}</small></span>
      <button class="del" data-sd="${id}" aria-label="Usuń: ${esc(n)}">×</button></div>
      <div class="fields"><label>Ostatnio<input type="date" data-s="${id}" data-f="date" value="${esc(d.date || '')}"></label>
      ${k ? `<label>Przy przebiegu<input type="number" inputmode="numeric" placeholder="km" data-s="${id}" data-f="km" value="${esc(d.km || '')}"></label>` : '<span></span>'}</div>
      <label class="note">Notatka<input data-s="${id}" data-f="note" placeholder="np. warsztat, numer części" value="${esc(d.note || '')}"></label>${st}</li>`; }).join('');
}
$('#svc').addEventListener('change', e => { const i = e.target.closest('[data-s]'); if(!i) return;
  const o = SV.d[i.dataset.s] = SV.d[i.dataset.s] || {}; o[i.dataset.f] = i.value; saveS(); if(i.dataset.f !== 'note') renderSvc(); });
$('#svc').addEventListener('click', e => { const b = e.target.closest('[data-sd]'); if(!b) return; const id = b.dataset.sd;
  if(!confirm('Usunąć tę pozycję?')) return;
  if(SV.custom.some(c => c.id === id)) SV.custom = SV.custom.filter(c => c.id !== id); else SV.hidden.push(id);
  delete SV.d[id]; saveS(); renderSvc(); });
$('#odo').onchange = () => { SV.odo = $('#odo').value; saveS(); renderSvc(); };
$('#sAdd').onclick = () => { const n = $('#sName').value.trim(); if(!n){ $('#sName').focus(); return; }
  if(!$('#sMon').value && !$('#sKm').value){ $('#sMon').focus(); return; }
  SV.custom.push({id: 's' + Date.now(), n, m: $('#sMon').value, k: $('#sKm').value});
  ['#sName', '#sMon', '#sKm'].forEach(s => $(s).value = ''); saveS(); renderSvc(); };
function renderSerwis(){ $('#svcList').hidden = S.svc !== 'list'; $('#svcLog').hidden = S.svc !== 'log'; renderLists(); }


/* ==========================================================================
   4. Udostępnianie linku   1. Noclegi   3. Profil wysokości   2. Zapisane trasy
   ========================================================================== */
const b64e = o => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64d = s => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))));
const ptOut = (name, pt) => pt && pt.name === name ? [name, +pt.lon.toFixed(5), +pt.lat.toFixed(5)] : name;
function tripState(){
  const via = (S.route.via || []).map((n, i) => ptOut(n, S.route['via' + i + 'Pt'])).filter(x => x && (x[0] || x));
  return {f: ptOut($('#from').value, S.route.fromPt), t: ptOut($('#to').value, S.route.toPt), p: via,
    a: S.altSel || null, w: (S.route.war || {}), o: S.opt, v: S.v, fu: S.fuel, c: +S.cons, d: S.dzien};
}
function applyTrip(st){
  const nm = x => Array.isArray(x) ? x[0] : (x || '');
  const pt = x => Array.isArray(x) ? {name: x[0], lon: x[1], lat: x[2]} : undefined;
  S.route = {from: nm(st.f), to: nm(st.t), fromPt: pt(st.f), toPt: pt(st.t), war: st.w || {}, via: (st.p || []).map(nm)};
  (st.p || []).forEach((x, i) => { S.route['via' + i + 'Pt'] = pt(x); });
  if(st.o) S.opt = st.o; if(st.v) S.v = {...VDEF, ...st.v}; if(st.fu) S.fuel = st.fu; if(st.c) S.cons = st.c; if(st.d) S.dzien = st.d;
  S.altSel = st.a || 'fast';
  ['route', 'ropt', 'vehicle', 'fuel', 'cons', 'dzien'].forEach(k => store.set(k, {route: S.route, ropt: S.opt, vehicle: S.v, fuel: S.fuel, cons: S.cons, dzien: S.dzien}[k]));
  $('#from').value = S.route.from; $('#to').value = S.route.to;
  renderVia(); vehLine(); syncSegs(); ML.fitKey = null;
  setRoute(true);
}
function readSharedLink(){
  const q = new URLSearchParams(location.search).get('t'); if(!q) return false;
  try{ const st = b64d(q); history.replaceState(null, '', location.pathname + (location.hash || '#trasa')); return st; }catch(e){ return false; }
}
function toast(t){ let el = $('#toast'); if(!el){ el = document.createElement('div'); el.id = 'toast'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.textContent = t; el.classList.add('on'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('on'), 2600); }
async function shareTrip(){
  const url = location.origin + location.pathname + '?t=' + b64e(tripState()) + '#trasa';
  const title = `${R.fromName} – ${R.toName} kamperem`;
  if(navigator.share && !isDesk()){ try{ await navigator.share({title, text: title + ' – trasa, opłaty i paliwo', url}); return; }catch(e){ if(e.name === 'AbortError') return; } }
  try{ await navigator.clipboard.writeText(url); toast('Link do trasy skopiowany'); }
  catch(e){ prompt('Skopiuj link do trasy:', url); }
}

/* --- 1. noclegi: podział trasy na dni wg limitu km dziennie --- */
let KNOWN = null;
function knownPlaces(){
  if(KNOWN) return KNOWN; KNOWN = [];
  Object.entries(T.drogi.wezly).forEach(([n, [lon, lat]]) => KNOWN.push([n, lon, lat]));
  Object.values(T.cele).forEach(d => d.warianty.forEach(w => w.punkty.forEach(p => KNOWN.push([p[0], p[1], p[2]]))));
  (T.promyPorty || []).forEach(f => f.trasa.split(' – ').forEach((n, i) => KNOWN.push([n, ...(i ? f.b : f.a)])));
  return KNOWN;
}
function placeNear(lon, lat, cc){
  let best = null, bd = 70; knownPlaces().forEach(([n, lo, la]) => { const d = hav([lon, lat], [lo, la]); if(d < bd){ bd = d; best = n; } });
  return best ? (bd < 15 ? best : 'okolice: ' + best) : (KR[cc] ? KR[cc].n : 'w trasie');
}
let nightsCache = null;
function nights(){
  const key = R && (R.fromName + R.toName + R.km + S.dzien + R.segs.length);
  if(nightsCache && nightsCache.key === key) return nightsCache;
  const lim = +S.dzien || 600, stops = [], days = [];
  const drive = R.segs.reduce((s, x) => s + (x.prom ? 0 : hav([x.a[1], x.a[2]], [x.b[1], x.b[2]])), 0) || 1;
  const scale = R.km / drive;                 // odcinki uproszczone – skalujemy do dystansu trasy
  const promH = R.war.prom && R.war.prom.h || 0, speed = R.km / Math.max(1, hoursOf(R) - promH);
  let cum = 0, next = lim, dayStart = 0, dayFerry = false, startName = R.fromName;
  R.segs.forEach(s => {
    if(s.prom){ dayFerry = true; return; }
    cum += hav([s.a[1], s.a[2]], [s.b[1], s.b[2]]) * scale;
    if(cum >= next && R.km - cum > lim * .25){
      const place = placeNear(s.b[1], s.b[2], s.b[3]);
      stops.push({lon: s.b[1], lat: s.b[2], cc: s.b[3], km: cum, place});
      days.push({from: startName, to: place, km: cum - dayStart, h: (cum - dayStart) / speed, ferry: dayFerry});
      dayStart = cum; dayFerry = false; startName = place; next = cum + lim;
    }
  });
  days.push({from: startName, to: R.toName, km: R.km - dayStart, h: (R.km - dayStart) / speed, ferry: dayFerry});
  return (nightsCache = {key, stops, days});
}


/* --- kempingi i miejsca dla kamperów przy noclegach (OpenStreetMap przez Workera) --- */
const CAMPS = {};          // klucz "lat,lon" → {loading|items|error}
const campKey = (lat, lon) => lat.toFixed(2) + ',' + lon.toFixed(2);
let campQ = [], campBusy = false;
function loadCamps(points){
  if(!API()) return;
  points.forEach(p => { const k = campKey(p.lat, p.lon); if(CAMPS[k] && !CAMPS[k].retry) return; CAMPS[k] = {loading: true}; campQ.push([k, p]); });
  pumpCamps();
}
async function pumpCamps(){   // po jednym zapytaniu naraz – Overpass nie lubi serii
  if(campBusy || !campQ.length) return; campBusy = true;
  const [k, p] = campQ.shift();
  try{ const j = await getJSON(CONFIG.routeApi + `/poi?lat=${p.lat.toFixed(4)}&lon=${p.lon.toFixed(4)}&r=15000`); CAMPS[k] = {items: j.items || [], error: j.error}; }
  catch(e){ CAMPS[k] = {items: [], error: e.message}; }
  campBusy = false;
  if(R){ renderExtras(); if(S.tab === 'noclegi') drawMap(); }
  pumpCamps();
}
document.addEventListener('click', e => { const b = e.target.closest('[data-camp-retry]'); if(!b) return;
  const [lat, lon] = b.dataset.campRetry.split(',').map(Number); CAMPS[campKey(lat, lon)] = {retry: true}; loadCamps([{lat, lon}]); renderExtras(); });
/* nazwy miejsc noclegów z geokodera (Worker /reverse) */
const NAMES = {};
function loadNames(stops){
  if(!API()) return;
  stops.forEach(s => { const k = campKey(s.lat, s.lon); if(NAMES[k]) return; NAMES[k] = {loading: true};
    getJSON(CONFIG.routeApi + `/reverse?lat=${s.lat.toFixed(4)}&lon=${s.lon.toFixed(4)}`)
      .then(j => { NAMES[k] = j; }).catch(() => { NAMES[k] = {}; }).finally(() => { if(R && S.tab === 'noclegi') renderExtras(); }); });
}
const stopName = s => { const n = NAMES[campKey(s.lat, s.lon)]; return n && n.name ? (n.d > 6 ? 'okolice: ' + n.name : n.name) : s.place; };
// park4night: mapa z miejscami w okolicy noclegu (tylko link – dane zostają u nich)
const p4n = (lat, lon) => `<a class="p4n" href="https://park4night.com/en/search?lat=${lat.toFixed(5)}&lng=${lon.toFixed(5)}&z=11" target="_blank" rel="noopener">Miejsca w okolicy na park4night <span aria-hidden="true">↗</span></a>`;
const gmaps = (lat, lon) => `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
function campsHtml(lat, lon){
  if(!API()) return '';
  const c = CAMPS[campKey(lat, lon)];
  if(!c || c.loading) return '<small class="cp-load">szukam kempingów w pobliżu…</small>';
  if(c.retry) return '<small class="cp-load">szukam kempingów w pobliżu…</small>';
  if(!c.items.length) return c.error ? `<small class="cp-load">Nie udało się pobrać kempingów (${esc(c.error)}). <button class="txtbtn" data-camp-retry="${lat},${lon}">Spróbuj ponownie</button></small>` : '<small class="cp-load">Brak kempingów w promieniu 15 km.</small>';
  return `<ul class="camps">${c.items.slice(0, 3).map(x => `<li><span class="cp-ic ${x.kind}" aria-hidden="true">${x.kind === 'kamper' ? 'P' : '⛺'}</span>
    <a href="${esc(x.web || gmaps(x.lat, x.lon))}" target="_blank" rel="noopener">${esc(x.name || (x.kind === 'kamper' ? 'Miejsce dla kamperów' : 'Kemping'))}</a>
    <small>${x.kind === 'kamper' ? 'dla kamperów' : 'kemping'}, ${fmt(x.d, 1)} km</small></li>`).join('')}</ul>`;
}
const campsAll = () => { const out = []; nights().stops.concat([{lat: R.chain[R.chain.length - 1][2], lon: R.chain[R.chain.length - 1][1]}]).forEach(s => { const c = CAMPS[campKey(s.lat, s.lon)]; if(c && c.items) out.push(...c.items.slice(0, 5)); }); return out; };

/* --- stacje LPG wzdłuż trasy --- */
let LPG = {key: null, items: null, loading: false, show: store.get('lpgShow', true)};
function lpgKey(){ return R ? R.fromName + R.toName + Math.round(R.km) : ''; }
async function loadLpg(){
  if(!API() || !R || !R.api || LPG.loading || LPG.key === lpgKey()) return;
  LPG.loading = true; LPG.key = lpgKey(); LPG.items = null; renderGaz();
  // co ok. 15 km punkt trasy (bez odcinków promowych), maks. 200 punktów
  const pts = []; let acc = 0;
  R.segs.forEach((s, i) => { if(s.prom) return; acc += hav([s.a[1], s.a[2]], [s.b[1], s.b[2]]); if(!pts.length || acc >= 15){ pts.push([s.b[1], s.b[2]]); acc = 0; } });
  const step = Math.ceil(pts.length / 200), P2 = pts.filter((_, i) => i % step === 0);
  try{
    const r = await fetch(CONFIG.routeApi + '/poi/lpg', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({pts: P2})});
    const j = await r.json(); LPG.items = (j.items || []).map(x => ({...x, ...lpgPos(x)})).sort((a, b) => a.km - b.km); LPG.error = j.error;
  }catch(e){ LPG.items = []; LPG.error = e.message; }
  LPG.loading = false; renderGaz(); drawMap();
}
function lpgPos(x){ // km od startu i kraj – najbliższy punkt trasy
  let best = 0, bd = Infinity, cum = 0, bk = 0;
  R.chain.forEach((p, i) => { if(i) cum += hav([R.chain[i - 1][1], R.chain[i - 1][2]], [p[1], p[2]]); const d = hav([p[1], p[2]], [x.lon, x.lat]); if(d < bd){ bd = d; best = i; bk = cum; } });
  return {km: bk * (R.km / (cum || 1)), cc: R.chain[best][3], off: bd};
}
function lpgHtml(){
  if(!API()) return '<p class="fine">Stacje LPG na trasie pokażemy po połączeniu z wyznaczaniem tras.</p>';
  if(LPG.loading || !LPG.items) return '<p class="fine">Szukam stacji LPG wzdłuż trasy…</p>';
  if(!LPG.items.length) return `<p class="fine">${LPG.error ? 'Nie udało się pobrać stacji: ' + esc(LPG.error) : 'Brak stacji LPG w odległości do 3 km od trasy.'}</p>`;
  return `<label class="chk lpg-show"><input type="checkbox" id="lpgShow" ${LPG.show ? 'checked' : ''}><span>Pokaż na mapie</span></label>
    <ul class="lpgl">${LPG.items.map(x => `<li><b>${fmt(Math.round(x.km))} km</b><span>${x.cc && KR[x.cc] ? flagSvg(x.cc, 16) : ''} <a href="${gmaps(x.lat, x.lon)}" target="_blank" rel="noopener">${esc(x.name || 'Stacja LPG')}</a>${x.off > 1 ? `<small>${fmt(x.off, 1)} km od trasy</small>` : ''}</span></li>`).join('')}</ul>
    <p class="fine">Dane: © współtwórcy OpenStreetMap. Stacje oznaczone w OSM jako sprzedające LPG – przed zjazdem warto sprawdzić.</p>`;
}
document.addEventListener('change', e => { if(e.target.id === 'lpgShow'){ LPG.show = e.target.checked; store.set('lpgShow', LPG.show); drawMap(); } });

/* --- 3. profil wysokości --- */
function profile(){
  if(!R.hasElev) return null;
  const pts = []; let d = 0;
  R.chain.forEach((p, i) => { if(i) d += hav([R.chain[i - 1][1], R.chain[i - 1][2]], [p[1], p[2]]); if(p[6] != null) pts.push({d, e: p[6], i}); });
  if(pts.length < 2) return null;
  const sc = R.km / (d || 1); pts.forEach(p => p.d *= sc);
  let max = pts[0], min = pts[0]; pts.forEach(p => { if(p.e > max.e) max = p; if(p.e < min.e) min = p; });
  // strome podjazdy: odcinki co najmniej 1 km ze średnim nachyleniem ≥ 6%
  const climbs = []; let s = 0;
  for(let i = 1; i < pts.length; i++){
    const g = (pts[i].e - pts[i - 1].e) / Math.max(1, (pts[i].d - pts[i - 1].d) * 1000);
    if(g < .04 || i === pts.length - 1){
      const a = pts[s], b = pts[i - 1], len = b.d - a.d;
      if(len >= 1 && (b.e - a.e) / (len * 1000) >= .06) climbs.push({from: a.d, to: b.d, gain: b.e - a.e, grade: (b.e - a.e) / (len * 10)});
      s = i;
    }
  }
  return {pts, max, min, climbs, ascent: R.ascent};
}
function elevSvg(pr, w, h){
  const pad = {l: 34, r: 8, t: 10, b: 18}, W = w - pad.l - pad.r, H = h - pad.t - pad.b;
  const top = Math.max(200, Math.ceil(pr.max.e / 200) * 200), bot = Math.min(0, Math.floor(pr.min.e / 200) * 200);
  const x = d => pad.l + d / (R.km || 1) * W, y = e => pad.t + H - (e - bot) / (top - bot) * H;
  const line = pr.pts.map((p, i) => (i ? 'L' : 'M') + x(p.d).toFixed(1) + ',' + y(p.e).toFixed(1)).join('');
  const area = line + `L${x(R.km).toFixed(1)},${pad.t + H}L${pad.l},${pad.t + H}Z`;
  const cl = pr.climbs.map(c => `<rect class="ev-climb" x="${x(c.from).toFixed(1)}" y="${pad.t}" width="${Math.max(2, x(c.to) - x(c.from)).toFixed(1)}" height="${H}"><title>Podjazd ${fmt(c.grade, 1)}%, ${fmt(c.gain)} m w górę</title></rect>`).join('');
  const ticks = [bot, (top + bot) / 2, top].map(e => `<text class="ev-t" x="${pad.l - 6}" y="${y(e) + 4}" text-anchor="end">${fmt(e)}</text><line class="ev-g" x1="${pad.l}" x2="${pad.l + W}" y1="${y(e)}" y2="${y(e)}"/>`).join('');
  const nt = nights().stops.map((s, i) => `<line class="ev-n" x1="${x(s.km)}" x2="${x(s.km)}" y1="${pad.t}" y2="${pad.t + H}"/><text class="ev-t" x="${x(s.km) + 3}" y="${pad.t + 10}">${i + 1}</text>`).join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="Profil wysokości trasy, najwyższy punkt ${fmt(pr.max.e)} m">
    ${ticks}${cl}<path class="ev-a" d="${area}"/><path class="ev-l" d="${line}"/>${nt}
    <text class="ev-t" x="${pad.l}" y="${h - 4}">0 km</text><text class="ev-t" x="${pad.l + W}" y="${h - 4}" text-anchor="end">${fmt(Math.round(R.km))} km</text>
    <line class="ev-cur" id="evCur" x1="-10" x2="-10" y1="${pad.t}" y2="${pad.t + H}"/></svg>`;
}
let hoverMk = null;
function elevHover(e, pr, box){
  const r = box.getBoundingClientRect(), w = r.width, pad = 34, W = w - pad - 8;
  const d = Math.max(0, Math.min(R.km, (e.clientX - r.left - pad) / W * R.km));
  let best = pr.pts[0]; for(const p of pr.pts){ if(Math.abs(p.d - d) < Math.abs(best.d - d)) best = p; }
  const cur = box.querySelector('#evCur'); if(cur){ const xx = pad + best.d / R.km * W; cur.setAttribute('x1', xx); cur.setAttribute('x2', xx); }
  box.closest('.elev').querySelector('.ev-info').textContent = `${fmt(Math.round(best.d))} km, ${fmt(best.e)} m n.p.m.`;
  if(ML.state === 'ready'){ const p = R.chain[best.i];
    if(!hoverMk){ const el = document.createElement('div'); el.className = 'mk-hover'; hoverMk = new maplibregl.Marker({element: el}); }
    hoverMk.setLngLat([p[1], p[2]]).addTo(ML.map); }
}

/* --- 2. zapisane trasy --- */
let SAVED = store.get('saved', []);
function saveTrip(){
  const c = costsOf(R), name = `${R.fromName} – ${R.toName}`;
  const item = {id: 's' + Date.now(), name, at: new Date().toISOString(), km: Math.round(R.km), h: Math.round(c.h), eur: c.total, st: tripState(),
    alt: R.api ? (ALTS.find(([k]) => ALT[k] === R) || [, ''])[1] : R.war.n};
  SAVED = [item, ...SAVED.filter(x => !(x.name === name && x.alt === item.alt))].slice(0, 30);
  store.set('saved', SAVED); toast('Trasa zapisana'); renderSaved();
}
let savedOpen = false;
function renderSaved(){
  const box = $('#saved'); if(!box) return;
  if(!SAVED.length){ box.innerHTML = ''; return; }
  const open = savedOpen || isDesk();
  box.innerHTML = `<button class="ro-toggle sv-t" aria-expanded="${open}">Zapisane trasy<span>${SAVED.length}</span></button>
    ${open ? `<div class="sv-list"><table><thead><tr><th>Trasa</th><th>km</th><th>czas</th><th>koszt</th><th></th></tr></thead><tbody>
      ${SAVED.map(x => `<tr><td><button class="sv-open" data-sv="${x.id}">${esc(x.name)}</button><small>${esc(x.alt || '')}${x.alt ? ', ' : ''}${new Date(x.at).toLocaleDateString('pl-PL', {day: 'numeric', month: 'short'})}</small></td>
        <td>${fmt(x.km)}</td><td>${x.h} h</td><td><b>${money(x.eur)}</b></td><td><button class="del" data-svdel="${x.id}" aria-label="Usuń zapisaną trasę ${esc(x.name)}">×</button></td></tr>`).join('')}
      </tbody></table></div>` : ''}`;
}
document.addEventListener('click', e => {
  if(e.target.closest('#shareBtn')) shareTrip();
  if(e.target.closest('#saveBtn')) saveTrip();
  if(e.target.closest('#printBtn2')) printPlan();
  if(e.target.closest('.sv-t')){ savedOpen = !savedOpen; renderSaved(); }
  const o = e.target.closest('[data-sv]'); if(o){ const x = SAVED.find(s => s.id === o.dataset.sv); if(x){ applyTrip(x.st); window.scrollTo(0, 0); } }
  const d = e.target.closest('[data-svdel]'); if(d){ SAVED = SAVED.filter(s => s.id !== d.dataset.svdel); store.set('saved', SAVED); renderSaved(); }
  const nd = e.target.closest('[data-dz]'); if(nd){ S.dzien = Math.max(200, Math.min(1200, S.dzien + +nd.dataset.dz)); store.set('dzien', S.dzien); renderExtras(); drawMap(); }
  if(e.target.closest('.ev-t-btn')){ S.elevOpen = !S.elevOpen; renderExtras(); }
});
const nightsOpenNow = () => S.nightsOpen == null ? isDesk() : S.nightsOpen;

function renderExtras(){
  // przyciski
  $('#actions').innerHTML = `<button class="btn ghost" id="shareBtn"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13"/></svg>Udostępnij</button>
    <button class="btn ghost" id="saveBtn"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>Zapisz trasę</button>
    <button class="btn ghost" id="printBtn2" aria-label="Drukuj plan"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9V3h12v6M6 18H4v-7h16v7h-2M6 14h12v7H6z"/></svg><span class="pr-l">Drukuj</span></button>`;
  // noclegi – osobna zakładka
  const n = nights();
  $('#nightsHead').innerHTML = `<small>${esc(R.fromName)} – ${esc(R.toName)}, ${fmt(Math.round(R.km))} km</small><b>${n.stops.length ? `${n.stops.length} ${n.stops.length === 1 ? 'nocleg' : n.stops.length < 5 ? 'noclegi' : 'noclegów'}` : 'Bez noclegu'}</b><span>${n.days.length} ${n.days.length === 1 ? 'dzień' : 'dni'} jazdy po maks. ${fmt(S.dzien)} km</span>`;
  $('#nights').innerHTML = `<div class="nt-lim"><span>Dziennie jadę do</span><span class="st-ctl"><button class="round sm" data-dz="-50" aria-label="Mniej km dziennie">−</button><b>${fmt(S.dzien)} km</b><button class="round sm" data-dz="50" aria-label="Więcej km dziennie">+</button></span></div>
      <ol class="days">${n.days.map((d, i) => { const s = n.stops[i] || {lat: R.chain[R.chain.length - 1][2], lon: R.chain[R.chain.length - 1][1]};
        const from = i === 0 ? R.fromName : stopName(n.stops[i - 1]), to = i < n.stops.length ? stopName(n.stops[i]) : R.toName;
        return `<li><span class="dn">${i + 1}</span><span class="dd"><b>${esc(from)} → ${esc(to)}</b><small>${fmt(Math.round(d.km))} km, ok. ${fmt(d.h, 1)} h jazdy${d.ferry ? ', z promem' : ''}</small>${p4n(s.lat, s.lon)}</span></li>`; }).join('')}</ol>
      <p class="fine">Miejsca noclegów są orientacyjne – punkty na trasie po przejechaniu dziennego limitu. Konkretne miejsca na nocleg w okolicy sprawdzisz w park4night.</p>`;
  if(S.tab === 'noclegi') loadNames(n.stops);
  if(false) loadCamps(n.stops.concat([{lat: R.chain[R.chain.length - 1][2], lon: R.chain[R.chain.length - 1][1]}]));
  // profil wysokości
  const pr = profile(), ev = $('#elev');
  if(!pr){ ev.hidden = true; ev.innerHTML = ''; }
  else {
    ev.hidden = false;
    const showChart = isDesk() || S.elevOpen;
    ev.innerHTML = `<div class="ev-h"><button class="ev-t-btn" aria-expanded="${showChart}" ${isDesk() ? 'disabled' : ''}><b>Profil trasy</b>
      <span>najwyżej ${fmt(pr.max.e)} m, w górę ${fmt(pr.ascent)} m${pr.climbs.length ? `, ${pr.climbs.length} ${pr.climbs.length === 1 ? 'stromy podjazd' : 'strome podjazdy'}` : ''}</span></button><span class="ev-info"></span></div>
      ${showChart ? `<div class="ev-c">${elevSvg(pr, Math.max(300, Math.round((isDesk() ? $('#dock').clientWidth - 24 : $('main').clientWidth - 36))), isDesk() ? 110 : 120)}</div>` : ''}`;
    const c = ev.querySelector('.ev-c');
    if(c){ c.addEventListener('mousemove', e => elevHover(e, pr, c)); c.addEventListener('touchmove', e => elevHover(e.touches[0], pr, c), {passive: true});
      c.addEventListener('mouseleave', () => { if(hoverMk) hoverMk.remove(); }); }
  }
  renderSaved();
}


/* ---------- wydruk planu: strona 1 – podsumowanie, strona 2 – lista do odhaczenia ---------- */
function printPlan(){ buildPrint(); window.print(); }
addEventListener('beforeprint', () => { if(R) buildPrint(); });
function buildPrint(){
  let el = document.getElementById('printDoc'); if(!el){ el = document.createElement('div'); el.id = 'printDoc'; document.body.append(el); }
  const v = V(), c = costsOf(R), n = nights(), fc = ferryCost();
  const alt = R.api ? ((ALTS.find(([k]) => ALT[k] === R) || [, ''])[1]) : R.war.n;
  const fn = S.fuel === 'on' ? 'ON' : 'Pb 95';
  const date = new Date().toLocaleDateString('pl-PL');
  const head = sub => `<header class="pd-h"><div><small>Plan podróży${sub}</small><h1>${esc(R.fromName)} → ${esc(R.toName)}</h1>
    <small>${esc(alt || '')}${alt ? ', ' : ''}${TYP_N[v.typ].toLowerCase()}, ${fmt(+v.wys, 2)} m wys., ${fmt(+v.dl, 1)} m dł., ${fn} ${fmt(+S.cons, 1)} l/100 km</small></div>
    <div class="pd-brand"><b>gdzieponiesie.pl</b><small>wydruk ${date}</small></div></header>`;
  const stat = (b, s) => `<div class="pd-stat"><small>${s}</small><b>${b}</b></div>`;
  const sec = t => `<h2>${t}</h2>`;
  const box = (t, s) => `<div class="pd-box"><i></i><span>${esc(t)}${s ? `<small>${esc(s)}</small>` : ''}</span></div>`;
  const stopNm = i => i < n.stops.length ? stopName(n.stops[i]) : R.toName;
  // opłaty
  const tolls = R.order.flatMap(cc => tollsFor(cc).map(x => ({cc, ...x})));
  const tsum = tollSum();
  const tRows = tolls.map(x => `<tr><td>${esc(KR[x.cc].n)}</td><td>${esc(x.k || '')}</td><td class="r"><b>${x.free ? money(0, false) : x.e != null ? 'ok. ' + money(x.e, false) : 'wg km'}</b></td></tr>`).join('');
  // paliwo
  const cs = R.order.filter(cc => KR[cc][S.fuel]); const min = Math.min(...cs.map(cc => KR[cc][S.fuel]));
  const cheap = cs.find(cc => KR[cc][S.fuel] === min);
  const fRows = cs.map(cc => `<tr><td>${esc(KR[cc].n)}</td><td class="r">${litre(KR[cc][S.fuel])} ${curUnit()}</td></tr>`).join('');
  // noclegi
  const dRows = n.days.map((d, i) => `<tr><td><b>${i + 1}</b></td><td>${esc(i === 0 ? R.fromName : stopNm(i - 1))} → ${esc(stopNm(i))}</td><td class="r">${fmt(Math.round(d.km))} km</td><td class="r">${fmt(d.h, 1)} h</td></tr>`).join('');
  // granice
  const B = R.borders;
  const bRows = B.map(b => { const w = b.cps ? b.cps[0] : waitOf(b);
    return `<tr><td>${esc(KR[b.nk ? b.nk[0] : 'PL'] ? (b.nk ? KR[b.nk[0]].n + ' → ' + KR[b.nk[1]].n : b.a + ' – ' + b.b) : '')}</td><td>${esc(b.cps ? (b.cps[0].name || '') : b.a + ' – ' + b.b)}</td><td class="r">${w.tam != null ? mins(w.tam) : '–'}</td><td class="r">${w.powrot != null ? mins(w.powrot) : '–'}</td></tr>`; }).join('');
  const gc = greenCard();
  const countries = R.order.map(cc => KR[cc].schengen ? esc(KR[cc].n) : `<b>${esc(KR[cc].n)}*</b>`).join(' › ');
  const nonS = R.order.some(cc => !KR[cc].schengen);
  // strona 2 – do kupienia
  const buy = tolls.filter(x => x.link && !x.free).map(x => box(`${KR[x.cc].n}: ${x.k}`, x.link.replace(/^https?:\/\//, '')));
  if(R.war.prom) buy.push(box(`Bilet na prom ${R.war.prom.trasa}`, R.war.prom.operator));
  if(R.order.some(cc => ['RS', 'ME', 'HR', 'IT', 'FR', 'ES', 'PT', 'TR'].includes(cc))) buy.push(box('Gotówka lub karta na bramki'));
  const eq = (LST.listy.find(g => g.id === 'eq') || {p: []}).p.map(p => box(p[0], p[1] && p[1].length < 60 ? p[1] : ''));
  const start = (LST.listy.find(g => g.id === 'start') || {p: []}).p.slice(0, 7).map(p => box(p[0]));
  const docs = [box('Paszport lub dowód dla każdego'), box('Prawo jazdy, dowód rejestracyjny'), box('Polisa OC i assistance', gc ? gc[0] : ''), box('EKUZ i ubezpieczenie turystyczne')];
  const foot = `<footer class="pd-f">Kwoty orientacyjne – przed zakupem sprawdź na stronach operatorów.${B.length ? ' Kolejki na granicach: Data by nakordoni.eu.' : ''} Mapy: © OpenStreetMap.</footer>`;
  el.innerHTML = `<section class="pd-page">${head('')}
    <div class="pd-stats">${stat(fmt(Math.round(R.km)) + ' km', 'dystans')}${stat(Math.round(c.h) + ' h', 'czas w drodze')}${stat(money(c.total) + (tsum.open || (R.war.prom && !fc) ? '+' : ''), fc ? 'paliwo, opłaty i prom' : R.war.prom ? 'paliwo i opłaty, bez biletu na prom' : 'paliwo i opłaty')}${stat(n.days.length + ' ' + (n.days.length === 1 ? 'dzień' : 'dni'), 'po maks. ' + fmt(S.dzien) + ' km')}</div>
    <p class="pd-c"><b>Kraje:</b> ${countries}${nonS ? ' <span>(* poza Schengen – kontrola paszportowa)</span>' : ''}</p>
    <div class="pd-2">
      <div>${sec('Winiety i opłaty – razem ' + money(tsum.e) + (tsum.open ? ' + wg km' : ''))}<table><tr><th>Kraj</th><th>Co</th><th class="r">Kwota</th></tr>${tRows}</table></div>
      <div>${sec(`Paliwo ${fn} – razem ${money(c.f.e)}`)}<table><tr><th>Kraj</th><th class="r">cena</th></tr>${fRows}</table>${cheap ? `<p class="pd-n">Najtaniej: <b>${esc(KR[cheap].n)}</b> – tam zatankuj do pełna.</p>` : ''}</div>
    </div>
    ${fc ? `<div>${sec('Prom')}<p class="pd-n"><b>${esc(R.war.prom.trasa)}</b>, ${esc(R.war.prom.operator)} – od ok. ${money(fc.od)}, w sezonie ok. ${money(fc.sezon)}</p></div>` : ''}
    <div>${sec('Noclegi')}<table><tr><th>Dzień</th><th>Odcinek</th><th class="r">km</th><th class="r">jazda</th></tr>${dRows}</table></div>
    ${B.length ? `<div>${sec('Granice poza Schengen')}<table><tr><th>Granica</th><th>Przejście (najkrótsza kolejka)</th><th class="r">tam</th><th class="r">powrót</th></tr>${bRows}</table></div>` : ''}
    ${gc ? `<p class="pd-n">${esc(gc[0])}. ${esc(gc[1] || '')}</p>` : ''}
    ${foot}</section>
  <section class="pd-page">${head(' – lista przed wyjazdem')}
    <div class="pd-cols">
      <div class="pd-l">
        <div class="pd-stats v">${stat(fmt(Math.round(R.km)) + ' km', 'dystans, ok. ' + Math.round(c.h) + ' h w drodze')}${stat(money(c.total), 'koszt w jedną stronę')}</div>
        <div>${sec('Trasa')}<ol class="pd-days">${n.days.map((d, i) => `<li>${i === 0 ? esc(R.fromName) + ' → ' : '→ '}${esc(stopNm(i))}, ${fmt(Math.round(d.km))} km</li>`).join('')}</ol></div>
        ${B.length ? `<div>${sec('Granice poza Schengen')}<p class="pd-n">${B.map(b => b.nk ? esc(KR[b.nk[0]].n + ' → ' + KR[b.nk[1]].n) : esc(b.a + ' – ' + b.b)).join('<br>')}<br><span>kolejki sprawdź w dniu wyjazdu na gdzieponiesie.pl</span></p></div>` : ''}
        <div>${sec('Ważne numery')}<p class="pd-lines">Assistance: ______________________<br>Ubezpieczenie: ___________________<br>Nocleg dzień 1: ___________________<br>Kontakt w kraju: __________________</p></div>
      </div>
      <div class="pd-r">
        ${buy.length ? `<div>${sec('Do kupienia przed wyjazdem')}${buy.join('')}</div>` : ''}
        <div>${sec('Dokumenty')}${docs.join('')}</div>
        <div>${sec('Wyposażenie')}${eq.join('')}</div>
        <div>${sec('Zanim ruszysz')}${start.join('')}</div>
      </div>
    </div>
    ${foot}</section>`;
}

/* ---------- całość ---------- */
function renderAll(){ if(!R) return; renderTrasa(); renderPaliwo(); renderWiniety(); renderGaz(); renderSerwis(); }

// Ceny paliwa (nakordoni.eu, z crona Workera) i kurs EUR (NBP) – pobierane przy starcie, niezależnie od wyznaczania tras.
let fxSrc = '';
async function loadLive(){
  if(!API()) return;
  try{
    const j = await getJSON(CONFIG.routeApi + '/prices');
    if(j.eur_pln > 3 && j.eur_pln < 6){ RATE = j.eur_pln; fxSrc = j.fx_source === 'nbp' ? 'NBP' + (j.fx_date ? ' z ' + new Date(j.fx_date).toLocaleDateString('pl-PL') : '') : ''; }
    let n = 0;
    for(const [c, p] of Object.entries(j.prices || {})){
      if(!KR[c]) continue;
      if(p.diesel > 0){ KR[c].on = p.diesel / RATE; n++; }
      if(p.petrol > 0) KR[c].pb = p.petrol / RATE;
      if(p.lpg > 0 && KR[c].lpg != null) KR[c].lpg = typeof KR[c].lpg === 'object' ? KR[c].lpg : p.lpg / RATE;
    }
    if(n) fuelSrc = 'nakordoni.eu' + (j.fuel_updated ? ', aktualizacja ' + new Date(j.fuel_updated).toLocaleDateString('pl-PL') : '') + ' (kraje bez danych: tolls.eu, 19.10.2026)';
    if(R) renderAll();
  }catch(e){ /* zostają ceny z pliku */ }
}

async function init(){
  applyTheme(document.documentElement.dataset.theme || 'light');
  const D = window.__GP_DATA;
  [K, T, LST] = D ? [D.kraje, D.trasy, D.lista]
    : await Promise.all(['kraje.json', 'trasy-demo.json', 'lista.json'].map(f => getJSON(CONFIG.dane + f)));
  KR = K.kraje; RATE = K.kurs || RATE; fuelSrc = K.paliwoZrodlo || 'przykładowe';
  $('#places').innerHTML = [...T.starty, ...Object.values(T.cele).map(c => c.n)].map(n => `<option value="${esc(n)}">`).join('');
  if(API()) $('#places').innerHTML = '';
  // w trybie z Workerem zostawiamy dowolne miejsca z poprzedniej wizyty; demo zna tylko swoje miasta
  const f0 = findRoute(S.route.from, S.route.to) || findRoute('Kraków', 'Budva');
  if(!API() && !findRoute(S.route.from, S.route.to)){ S.route.from = 'Kraków'; S.route.to = 'Budva'; }
  $('#from').value = S.route.from || 'Kraków'; $('#to').value = S.route.to || 'Budva';
  syncSegs(); vehLine(); renderVia();
  const shared = readSharedLink();
  R = buildRoute(f0, demoPick(f0) || undefined);
  if(API()) setRouteApi(true);
  placeMap();
  showTab(location.hash.slice(1));
  renderAll(); startML();
  if(shared) applyTrip(shared);
  if(!D) loadLive();
  let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if(!$('#v-trasa').hidden) drawMap(); }, 150); });
}
// PWA: instalacja na ekranie głównym i działanie bez internetu (pliki strony)
if('serviceWorker' in navigator && location.protocol === 'https:') addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
init().catch(err => { document.querySelector('main').insertAdjacentHTML('afterbegin', `<p class="msg">Nie udało się wczytać danych (${esc(err.message)}).</p>`); console.error(err); });
})();
