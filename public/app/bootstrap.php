<?php
declare(strict_types=1);

const APP_DIR  = __DIR__;
const DATA_DIR = __DIR__ . '/../data';

function config(string $key, $default = null)
{
    static $cfg = null;
    if ($cfg === null) {
        $file = APP_DIR . '/config.php';
        $cfg = is_file($file) ? (require $file) : [];
    }
    return $cfg[$key] ?? $default;
}

/** Odległość w km między dwoma punktami [lon, lat]. */
function haversine_km(array $a, array $b): float
{
    $r = 6371.0;
    $dLat = deg2rad($b[1] - $a[1]);
    $dLon = deg2rad($b[0] - $a[0]);
    $h = sin($dLat / 2) ** 2 + cos(deg2rad($a[1])) * cos(deg2rad($b[1])) * sin($dLon / 2) ** 2;
    return 2 * $r * asin(min(1.0, sqrt($h)));
}

/** Długość fragmentu linii między indeksami punktów. */
function segment_km(array $coords, int $from, int $to): float
{
    $km = 0.0;
    for ($i = $from; $i < $to && isset($coords[$i + 1]); $i++) {
        $km += haversine_km($coords[$i], $coords[$i + 1]);
    }
    return $km;
}

/** Zapytanie o trasę do OpenRouteService (profil ciężarowy z wymiarami kampera). */
function ors_route(array $body): array
{
    $key = (string) config('ors_api_key', '');
    if ($key === '') {
        return ['ok' => false, 'error' => 'Brak klucza ORS w konfiguracji. Sprawdź sekret ORS_API_KEY na GitHubie.'];
    }

    $ch = curl_init('https://api.openrouteservice.org/v2/directions/driving-hgv/geojson');
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => json_encode($body),
        CURLOPT_HTTPHEADER     => [
            'Authorization: ' . $key,
            'Content-Type: application/json',
            'Accept: application/geo+json, application/json',
        ],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 40,
    ]);
    $res  = curl_exec($ch);
    $err  = curl_error($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($res === false) {
        return ['ok' => false, 'error' => 'Serwer nie połączył się z ORS (cURL): ' . $err];
    }
    $data = json_decode((string) $res, true);
    if ($code !== 200 || !isset($data['features'][0])) {
        $msg = $data['error']['message'] ?? (is_string($data['error'] ?? null) ? $data['error'] : substr((string) $res, 0, 300));
        return ['ok' => false, 'error' => "ORS odpowiedział kodem $code: $msg"];
    }
    return ['ok' => true, 'data' => $data];
}

/** Podsumowanie trasy: km, czas, km płatne, km w każdym kraju. */
function summarize_route(array $geo): array
{
    $f      = $geo['features'][0];
    $coords = $f['geometry']['coordinates'];
    $props  = $f['properties'];

    $tollKm = 0.0;
    foreach ($props['extras']['tollways']['values'] ?? [] as [$a, $b, $v]) {
        if ((int) $v === 1) {
            $tollKm += segment_km($coords, (int) $a, (int) $b);
        }
    }

    $countries = [];
    foreach ($props['extras']['countryinfo']['values'] ?? [] as [$a, $b, $v]) {
        $countries[(string) $v] = ($countries[(string) $v] ?? 0) + segment_km($coords, (int) $a, (int) $b);
    }
    arsort($countries);

    return [
        'km'        => round(($props['summary']['distance'] ?? 0) / 1000),
        'hours'     => ($props['summary']['duration'] ?? 0) / 3600,
        'toll_km'   => round($tollKm),
        'countries' => array_map(fn ($km) => round($km), $countries),
        'coords'    => $coords,
    ];
}
