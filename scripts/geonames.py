#!/usr/bin/env python3
"""
Buduje cloudflare/miasta.json – bazę miejscowości Europy dla wyszukiwarki gdzieponiesie.pl.
Źródło: GeoNames (https://www.geonames.org), licencja CC BY 4.0.

- wszystkie miejscowości powyżej 5000 mieszkańców (cities5000) w krajach z listy KRAJE,
- do tego miejscowości turystyczne ze słownika Workera (cloudflare/worker.js, EXONYMS), nawet mniejsze (cities1000),
- polskie nazwy z plików alternatenames/<KRAJ>.zip (język „pl”, bez historycznych i potocznych).

Format wiersza: [nazwa, polska_nazwa_lub_"", nazwa_ascii, lat, lon, kraj_ISO2, ludność]
"""
import csv, io, json, re, sys, unicodedata, urllib.request, zipfile

BASE = 'https://download.geonames.org/export/dump/'
KRAJE = ['AD', 'AL', 'AT', 'BA', 'BE', 'BG', 'BY', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GE', 'GI', 'GR', 'HR', 'HU',
         'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MC', 'MD', 'ME', 'MK', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'RS', 'SE', 'SI', 'SK', 'SM',
         'TR', 'UA', 'VA', 'XK']
csv.field_size_limit(10 ** 8)

def get(name):
    print('pobieram', name, file=sys.stderr)
    req = urllib.request.Request(BASE + name, headers={'User-Agent': 'gdzieponiesie.pl (baza miast, GitHub Actions)'})
    return urllib.request.urlopen(req, timeout=300).read()

def rows(zipbytes, member):
    with zipfile.ZipFile(io.BytesIO(zipbytes)) as z:
        with z.open(member) as f:
            for line in io.TextIOWrapper(f, encoding='utf-8'):
                yield line.rstrip('\n').split('\t')

def fold(s):
    s = unicodedata.normalize('NFD', s.lower())
    return ''.join(c for c in s if unicodedata.category(c) != 'Mn').replace('ł', 'l').replace('ß', 'ss')

# miejscowości turystyczne ze słownika Workera (lokalne nazwy)
worker = open('cloudflare/worker.js', encoding='utf-8').read()
blok = worker[worker.index('const EXONYMS'):worker.index('}).map(([pl, local])')]
turystyczne = {fold(v) for _, v in re.findall(r"'([^']+)': '([^']+)'", blok)}

kraje = set(KRAJE)
miasta = {}
for r in rows(get('cities5000.zip'), 'cities5000.txt'):
    if r[8] in kraje and r[6] == 'P':
        miasta[r[0]] = r
dodane = 0
for r in rows(get('cities1000.zip'), 'cities1000.txt'):
    if r[8] in kraje and r[6] == 'P' and r[0] not in miasta and (fold(r[1]) in turystyczne or fold(r[2]) in turystyczne):
        miasta[r[0]] = r; dodane += 1
print('miejscowości:', len(miasta), '(w tym turystyczne < 5000:', dodane, ')', file=sys.stderr)

# polskie nazwy
pl = {}
for kraj in KRAJE:
    try:
        data = get('alternatenames/' + kraj + '.zip')
    except Exception as e:
        print('brak nazw alternatywnych dla', kraj, e, file=sys.stderr); continue
    for r in rows(data, kraj + '.txt'):
        # alternateNameId, geonameid, isolanguage, nazwa, isPreferred, isShort, isColloquial, isHistoric, from, to
        if len(r) < 8 or r[2] != 'pl' or r[1] not in miasta or r[6] == '1' or r[7] == '1':
            continue
        if r[1] not in pl or r[4] == '1':
            pl[r[1]] = r[3]

out = []
for gid, r in miasta.items():
    nazwa, ascii_, lat, lon, kraj, lud = r[1], r[2], float(r[4]), float(r[5]), r[8], int(r[14] or 0)
    p = pl.get(gid, '')
    if p == nazwa:
        p = ''
    out.append([nazwa, p, ascii_ if ascii_ != nazwa else '', round(lat, 4), round(lon, 4), kraj, lud])
out.sort(key=lambda x: -x[6])
with open('cloudflare/miasta.json', 'w', encoding='utf-8') as f:
    json.dump({'zrodlo': 'GeoNames (www.geonames.org), CC BY 4.0', 'miasta': out}, f, ensure_ascii=False, separators=(',', ':'))
print('zapisano', len(out), 'miejscowości, z polską nazwą:', sum(1 for x in out if x[1]), file=sys.stderr)
