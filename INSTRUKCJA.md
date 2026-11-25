# DendroTeren – inwentaryzacja drzew w terenie

Aplikacja webowa (PWA) na iPhone i Android. Działa bez internetu po pierwszym otwarciu.
Dane (pomiary, zdjęcia, warstwy) są zapisane **tylko w telefonie**. Po każdym dniu pracy rób eksport ZIP.

## Uruchomienie na telefonie
GPS, aparat i czujnik nachylenia działają tylko przez **HTTPS**, dlatego folder `DendroTeren`
trzeba opublikować na darmowym hostingu (np. GitHub Pages, Netlify, Cloudflare Pages).
Wystarczy wgrać całą zawartość folderu – nie ma żadnego budowania.

Instalacja na ekranie głównym:
- **iPhone (Safari):** Udostępnij → „Do ekranu początkowego”. Ważne: bez instalacji Safari może po kilku dniach usunąć dane.
- **Android (Chrome):** baner „Zainstaluj” albo menu ⋮ → „Zainstaluj aplikację”.

Test na komputerze: `python -m http.server 8765 --directory DendroTeren` → http://localhost:8765

## Praca w terenie
- **Nr** – automatycznie +1; możesz wpisać własny w dowolnej chwili, kolejne liczą się od niego.
- **Gatunek** zostaje dla kolejnych drzew, dopóki go nie zmienisz. Lista podpowiedzi przewija się palcem;
  przycisk ▾ otwiera wszystkie gatunki bez pisania. Ostatnio używane gatunki usuwasz krzyżykiem ×.
- **Lokalizacja** – GPS na żywo; „Zatwierdź tutaj”, „Uśrednij 10 s” albo „Popraw na mapie” (przeciągnij punkt).
  Przy pomiarze wysokości położenie zatwierdza się samo, zanim odejdziesz od pnia.
  Mapka podglądu pokazuje Twoje położenie z GPS (niebieska kropka z kołem dokładności), punkt drzewa
  (pomarańczowy) i wcześniej zapisane drzewa (zielone kropki). „Zwiń mapkę” chowa podgląd, ⌖ wyśrodkowuje.
- **Wysokość telefonem** – celownik na podstawę (1), potem na wierzchołek (2).
  Tryb „Znam odległość” (taśma, dalmierz, kroki) albo „Z wysokości oczu” (teren płaski).
- Wszystkie pola są opcjonalne. Suwaki włączasz w zakładce Projekt.
- Próg z art. 83f uoop (obwód na 5 cm: 50/65/80 cm, krzewy 25 m²) jest orientacyjny – sprawdź przepisy.

## Mapa i własne warstwy
Podkłady: ortofotomapa Geoportalu (WMTS), OSM, działki ewidencyjne (KIEG). Oglądane fragmenty
zapisują się do pracy offline – przejrzyj teren na mapie przed wyjazdem.

„Warstwy” → „Wgraj plik z telefonu”:
- wektor: GeoJSON, KML/KMZ, GPX, Shapefile spakowany w ZIP (.shp .shx .dbf .prj),
- raster: GeoTIFF albo JPG/PNG + plik world (.jgw/.pgw/.wld) – zaznacz oba pliki naraz,
- obraz bez georeferencji (skan planu) – dopasujesz przeciągając narożniki 1–3 i środek ✥.

Układy: EPSG:2180, PUWG 2000 (2176–2179), WGS84, UTM 33/34. Z QGIS najprościej:
wektor → GeoJSON w EPSG:2180, raster → GeoTIFF w EPSG:2180 (do ~4000 px boku).

## Eksport (EPSG:2180)
- **GeoJSON** – punkty w EPSG:2180, QGIS rozpoznaje układ sam (przeciągnij plik do QGIS).
- **CSV** (Excel, separator `;`) – kolumny `X EPSG:2180 (północ)` i `Y EPSG:2180 (wschód)`.
  Przy wczytaniu CSV do QGIS: pole X = „Y … (wschód)”, pole Y = „X … (północ)”, przecinek dziesiętny.
- **ZIP** – CSV + GeoJSON + zdjęcia (`zdjecia/nr_1.jpg`, pole `foto1` do podglądu w QGIS)
  + kopia `kopia_dendroteren.json` do wczytania na innym telefonie (Projekt → Wczytaj kopię).
