# gdzieponiesie.pl

- `public/` – strona (to trafia na hosting Kylos)
- `public/gps/` – nawigacja kamper (PWA, gdzieponiesie.pl/gps), używa Workera `/gps/route`
- `cloudflare/worker.js` – Worker `gdzieponiesie-api` (wklejany ręcznie w Cloudflare, nie idzie na hosting)
- `.github/workflows/deploy.yml` – wysyłka `public/` na hosting przez FTP, **uruchamiana ręcznie**
  (Actions → Wdrożenie na Kylos → Run workflow)

Po zmianie `assets/app.js` lub `assets/style.css` podbij `?v=` w `public/index.html`.
