# Luach Dashboard PWA installation

## Files
Upload the complete folder contents to the root of one HTTPS web site or GitHub Pages repository:

- index.html
- dashboard.js
- manifest.webmanifest
- service-worker.js
- icons/icon-192.png
- icons/icon-512.png

Keep the directory structure unchanged.

## Configuration
Open `dashboard.js` and edit the `CONFIG` object near the top if the latitude, longitude, or IANA timezone need to change.

## GitHub Pages
1. Create a repository such as `luach-dashboard`.
2. Upload all files and the `icons` folder to the repository root.
3. Open repository Settings -> Pages.
4. Under Build and deployment choose `Deploy from a branch`.
5. Choose branch `main`, folder `/(root)`, and Save.
6. Wait for the Pages deployment to finish, then open the HTTPS Pages URL.

## Install on ChromeOS
1. Open the HTTPS dashboard URL in Chrome on the Chromebox.
2. Wait for the page to load successfully.
3. If the dashboard shows an `Install app` button at the bottom, click it and accept the prompt. If not, use Chrome's Install icon/menu for the site.
4. Launch `Luach Dashboard` from the ChromeOS Launcher. Its manifest requests fullscreen landscape display.

## Updating
Replace files on the host. The service worker prefers fresh network copies of app files and keeps cached copies for offline use. If you make a major cache-policy change, increment the cache version strings near the top of `service-worker.js` so obsolete caches are removed.

## Offline behavior
The app shell is cached after first successful installation/load. Hebcal API responses are cached per exact URL as a fallback. With no Internet connection the app can launch and may reuse the most recently cached response for a matching API URL, but it cannot calculate newly fetched calendar data until Internet connectivity returns.

## Important
Service workers/PWA installation require a secure context. Use HTTPS (or localhost for development). Opening `index.html` directly from a USB drive with a `file://` URL will not provide the complete PWA installation/offline behavior.


## Latest dashboard additions

The Daily Zmanim panel now includes **Chatzot (Midnight)** after **Tzeit HaKochavim (42m)**, using Hebcal's `chatzotNight` value.

## Kabbalat Shabbat panel
On Fridays, the Tefillah Modifications panel includes a Kabbalat Shabbat section after Mincha. It shows Full Kabbalat Shabbat on an ordinary Friday and Shortened Kabbalat Shabbat when the incoming Shabbat coincides with Yom Tov or Chol HaMoed, or when Shabbat begins immediately after the concluding festival day.


## Changing location

The dashboard now includes a **Change location** button in the footer. Search by city name or postal code and select a result. The selected city, coordinates, country code, and IANA timezone are stored in the browser's `localStorage`, so each Chromebox/computer can remember a different location without changing the GitHub-hosted files. The dashboard uses Open-Meteo's geocoding search to find cities and then sends the selected latitude, longitude, and timezone to Hebcal for calendar/zmanim calculations.
