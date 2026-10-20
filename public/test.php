<?php
declare(strict_types=1);
require __DIR__ . '/app/bootstrap.php';

// ---------- 1. Sprawdzenie serwera ----------
$checks = [];
$checks[] = ['PHP 8.1 lub nowszy', version_compare(PHP_VERSION, '8.1.0', '>='), 'Wersja: ' . PHP_VERSION];
$checks[] = ['Rozszerzenie cURL', extension_loaded('curl'), extension_loaded('curl') ? 'Dostępne' : 'Włącz cURL w ustawieniach PHP domeny'];
$checks[] = ['Rozszerzenie PDO SQLite', extension_loaded('pdo_sqlite'), extension_loaded('pdo_sqlite') ? 'Dostępne' : 'Włącz pdo_sqlite w ustawieniach PHP domeny'];
$checks[] = ['Konfiguracja z GitHuba', is_file(APP_DIR . '/config.php'), is_file(APP_DIR . '/config.php') ? 'Wdrożono: ' . config('deployed_at', '?') : 'Brak pliku app/config.php — wdrożenie nie przeszło przez GitHub Actions'];
$checks[] = ['Klucz ORS', config('ors_api_key', '') !== '', config('ors_api_key', '') !== '' ? 'Ustawiony' : 'Dodaj sekret ORS_API_KEY i uruchom wdrożenie ponownie'];

$sqliteOk = false;
$sqliteMsg = 'Pominięto (brak pdo_sqlite)';
if (extension_loaded('pdo_sqlite')) {
    try {
        $file = DATA_DIR . '/_test.sqlite';
        $db = new PDO('sqlite:' . $file, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $db->exec('CREATE TABLE IF NOT EXISTS t (v TEXT)');
        $db->exec("INSERT INTO t VALUES ('ok')");
        $sqliteOk = $db->query('SELECT v FROM t LIMIT 1')->fetchColumn() === 'ok';
        $db = null;
        @unlink($file);
        $sqliteMsg = $sqliteOk ? 'Zapis i odczyt w katalogu data/ działa' : 'Baza nie zwróciła zapisanej wartości';
    } catch (Throwable $e) {
        $sqliteMsg = 'Błąd: ' . $e->getMessage();
    }
}
$checks[] = ['Zapis bazy SQLite', $sqliteOk, $sqliteMsg];

// ---------- 2. Próbna trasa (wynik trzymany 1 h, żeby nie zużywać limitu ORS) ----------
$camper = ['height' => 2.9, 'length' => 6.4, 'width' => 2.1, 'weight' => 3.5];
$from = [19.9450, 50.0647]; // Kraków
$to   = [16.4402, 43.5081]; // Split

$routes = null;
$routeError = null;
$cacheFile = DATA_DIR . '/_test_route.json';

if (is_file($cacheFile) && filemtime($cacheFile) > time() - 3600) {
    $routes = json_decode((string) file_get_contents($cacheFile), true);
} elseif (extension_loaded('curl') && config('ors_api_key', '') !== '') {
    $base = [
        'coordinates' => [$from, $to],
        'extra_info'  => ['tollways', 'countryinfo'],
        'options'     => [
            'vehicle_type'   => 'hgv',
            'profile_params' => ['restrictions' => $camper],
        ],
    ];
    $noToll = $base;
    $noToll['options']['avoid_features'] = ['tollways'];

    $a = ors_route($base);
    $b = $a['ok'] ? ors_route($noToll) : $a;

    if ($a['ok'] && $b['ok']) {
        $routes = ['fast' => summarize_route($a['data']), 'free' => summarize_route($b['data'])];
        @file_put_contents($cacheFile, json_encode($routes));
    } else {
        $routeError = $a['ok'] ? $b['error'] : $a['error'];
    }
} else {
    $routeError = 'Trasa nie została policzona, bo brakuje cURL albo klucza ORS (patrz wyżej).';
}

$allOk = !in_array(false, array_column($checks, 1), true) && $routes !== null;

function h(string $s): string { return htmlspecialchars($s, ENT_QUOTES, 'UTF-8'); }
function fmt_h(float $h): string { $m = (int) round($h * 60); return intdiv($m, 60) . ' h ' . str_pad((string) ($m % 60), 2, '0', STR_PAD_LEFT) . ' min'; }
?>
<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>gdzieponiesie.pl — test serwera</title>
<link href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css" rel="stylesheet">
<style>
  :root {
    --bg: #eef1ec; --ink: #1f2a24; --muted: #5b675f; --panel: #ffffff;
    --line: #d5dbd3; --fast: #2457c5; --free: #1e8a4c; --bad: #b3261e;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #151a17; --ink: #e6ebe6; --muted: #9aa69d; --panel: #1e2520;
            --line: #2e3831; --fast: #7aa2ff; --free: #5fd18f; --bad: #ff8a80; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
         font: 16px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 1.6rem; margin: 0 0 4px; }
  .lead { color: var(--muted); margin: 0 0 24px; }
  h2 { font-size: 1.1rem; margin: 32px 0 8px; }
  ul.checks { list-style: none; padding: 0; margin: 0; background: var(--panel);
              border: 1px solid var(--line); border-radius: 10px; }
  ul.checks li { display: grid; grid-template-columns: 28px 1fr; gap: 2px 8px;
                 padding: 10px 14px; border-top: 1px solid var(--line); }
  ul.checks li:first-child { border-top: 0; }
  .mark { font-weight: 700; grid-row: span 2; }
  .ok .mark { color: var(--free); } .fail .mark { color: var(--bad); }
  .detail { color: var(--muted); font-size: .9rem; }
  .verdict { padding: 12px 14px; border-radius: 10px; font-weight: 600; margin-bottom: 8px;
             background: var(--panel); border-left: 5px solid var(--free); }
  .verdict.fail { border-left-color: var(--bad); }
  #map { height: 420px; border-radius: 10px; border: 1px solid var(--line); }
  .cmp { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }
  .route { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
           padding: 12px 14px; border-top: 5px solid var(--fast); }
  .route.free { border-top-color: var(--free); }
  .route h3 { margin: 0 0 6px; font-size: 1rem; }
  .route p { margin: 2px 0; }
  .countries { color: var(--muted); font-size: .85rem; margin-top: 6px; }
  .error { color: var(--bad); }
  .note { color: var(--muted); font-size: .9rem; }
  @media (max-width: 520px) { .cmp { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
  <h1>Test serwera gdzieponiesie.pl</h1>
  <p class="lead">Sprawdza hosting i liczy próbną trasę kamperem 2,9 m / 3,5 t z Krakowa do Splitu.</p>

  <div class="verdict <?= $allOk ? '' : 'fail' ?>">
    <?= $allOk ? 'Wszystko działa. Fundament jest gotowy.' : 'Coś wymaga poprawki — szczegóły poniżej.' ?>
  </div>

  <h2>Serwer</h2>
  <ul class="checks">
    <?php foreach ($checks as [$name, $ok, $detail]): ?>
      <li class="<?= $ok ? 'ok' : 'fail' ?>">
        <span class="mark"><?= $ok ? '✓' : '✗' ?></span>
        <span><?= h($name) ?></span>
        <span class="detail"><?= h($detail) ?></span>
      </li>
    <?php endforeach; ?>
  </ul>

  <h2>Próbna trasa</h2>
  <?php if ($routes): ?>
    <div id="map"></div>
    <div class="cmp">
      <?php foreach (['fast' => 'Najszybsza', 'free' => 'Bez płatnych dróg'] as $k => $label): $r = $routes[$k]; ?>
        <div class="route <?= $k ?>">
          <h3><?= $label ?></h3>
          <p><?= number_format($r['km'], 0, ',', ' ') ?> km, <?= fmt_h($r['hours']) ?></p>
          <p>Odcinki płatne: <?= number_format($r['toll_km'], 0, ',', ' ') ?> km</p>
          <p class="countries">Km w krajach (kody ORS):
            <?php foreach ($r['countries'] as $cid => $km): ?>
              #<?= h((string) $cid) ?>: <?= $km ?> km&nbsp;
            <?php endforeach; ?>
          </p>
        </div>
      <?php endforeach; ?>
    </div>
    <p class="note">Czasy są liczone profilem ciężarowym ORS, więc wyjdą dłuższe niż w Google Maps. Dostroimy to w kolejnych krokach. Wynik jest zapamiętany na godzinę.</p>
  <?php else: ?>
    <p class="error"><?= h((string) $routeError) ?></p>
  <?php endif; ?>
</main>

<?php if ($routes): ?>
<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
<script>
  const routes = <?= json_encode(['fast' => $routes['fast']['coords'], 'free' => $routes['free']['coords']]) ?>;
  const css = getComputedStyle(document.documentElement);
  const map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    bounds: [[16.0, 43.2], [20.5, 50.4]],
    fitBoundsOptions: { padding: 30 }
  });
  map.addControl(new maplibregl.NavigationControl());
  map.on('load', () => {
    [['free', '--free', 7], ['fast', '--fast', 4]].forEach(([id, color, width]) => {
      map.addSource(id, { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: routes[id] } } });
      map.addLayer({ id, type: 'line', source: id,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': css.getPropertyValue(color).trim(), 'line-width': width, 'line-opacity': 0.85 } });
    });
  });
</script>
<?php endif; ?>
</body>
</html>
