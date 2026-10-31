# Azimo – aplikacja iOS (Capacitor)

Powłoka natywna ładująca `https://gdzieponiesie.pl/gps/` (aktualizacje przez zwykłe wdrożenie na hosting).
Daje: GPS w tle, natywny głos (głosy rozszerzone iOS), ekran nie gaśnie, Live Activity (krok 2).

Build: Actions → „Build IPA (iOS)” → Run workflow → artefakt `Azimo-vX.Y.Z-buildN-unsigned.ipa` → podpis w Signulous.
Projekt Xcode (`ios/`) jest generowany w CI (`npx cap add ios`), nie trzymamy go w repo.
