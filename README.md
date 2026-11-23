# Fotokiste

A private photo box for our vacations. Everyone opens one link, types the group password, taps their name, and can upload, browse and download photos. Runs entirely on Cloudflare's free tier.

## What it does

- **Upload** any image format from phone or computer (tap the button or drag files in). Originals are stored byte for byte; R2 verifies a SHA-256 fingerprint on arrival and rejects anything that changed in transit.
- **Previews** are made in the browser at upload time: JPEG, PNG, WebP, AVIF, GIF directly; HEIC (iPhone) and TIFF via bundled decoders; camera RAW (DNG, CR2, CR3, NEF, ARW, RAF, ORF, RW2 …) via the full-size preview the camera embeds in the file. Formats without a preview still upload and download normally.
- **Sorted by capture time** (camera clock), grouped by day. Files without capture data use the file date.
- **No duplicates**: the exact same file uploaded twice into one album is skipped.
- **Private albums**: an album can be listed for one name only and need its own password, entered once per browser.
- **Filter by person**: who uploaded what. Each person has a signature color, shown on the filter and as an edge on their photos.
- **Albums**, one level, no nested folders.
- **Download**: a single photo (original, plus a JPEG copy for HEIC/TIFF/RAW), a selection, or a whole album as ZIP. ZIP files contain the untouched originals, named `2026-07-14 09.12.00 Leon IMG_1000.JPG` so they sort by time in any folder.
- **Trash**: anyone can delete anything, but deleted photos and albums stay restorable for 30 days, then are removed automatically.
- **No location shown or stored.** Note: the original files keep whatever GPS data the phone wrote, because the files are never modified.

## Live

**https://photo-sharing.leon-roesch28.workers.dev** (Worker `photo-sharing`, R2 bucket `photos`, D1 database `photo-sharing-db`).

To deploy changes from a terminal with a Cloudflare API token: `npx wrangler deploy`. The website files are packed into the Worker automatically before every deploy.

## Setup from scratch (for a new Cloudflare account)

1. **Enable R2.** In the Cloudflare dashboard open *R2 Object Storage* and activate it. Cloudflare asks for a payment method even for the free tier (10 GB free, after that about $0.015 per GB per month).
2. **Connect the repository.** Dashboard → *Workers & Pages* → *Create* → *Import a repository* → connect GitHub → pick `Photo-Sharing`. Leave the build command empty and the deploy command as `npx wrangler deploy`. Deploy.
   The first deploy creates the database (`photo-sharing-db`) automatically. Create an R2 bucket named `photos` beforehand, or change `bucket_name` in `wrangler.jsonc`. After the first deploy, put the new database's ID into `database_id` in `wrangler.jsonc`.
3. **Set the group password.** Open the new Worker → *Settings* → *Variables and Secrets* → *Add* → type **Secret**, name `APP_PASSWORD`, value: the password you will give your friends. Save.
4. **Open the site** at the `…workers.dev` address shown on the Worker's page. Send that link and the password to the group.

From then on, every change pushed to the main branch goes live by itself.

### Changing things later

- **Names on the start screen:** `NAMES` in `wrangler.jsonc` (comma separated, up to four get distinct colors).
- **Trash duration:** `TRASH_DAYS` in `wrangler.jsonc`.
- **Private album with its own password:** `node scripts/album-lock.mjs "Name" Leon <password>` prints an SQL line; run it with `npx wrangler d1 execute photo-sharing-db --remote --command "<that line>"`. The album then appears only for that name, and opening it asks for the password once per browser. Its photos stay blocked on the server for any browser that has not entered it. Names are not accounts: anyone with the group password can tap that name and see that the album exists, so the album password is the real protection.
- **Locking everyone out:** change `APP_PASSWORD`. All existing logins stop working immediately.

## Limits worth knowing

- **100 MB per file.** That is the largest request a Cloudflare Worker accepts on the free plan. Photos, including most RAW files, are far below it.
- **Keep the screen on while uploading from a phone.** The site asks the phone to stay awake, but a locked screen stops the upload. Failed files can be retried with one tap; nothing is uploaded twice.
- **iPhone:** to get the original HEIC rather than a converted JPEG, pick photos via the normal photo picker. If iOS ever offers a "Most Compatible" option there, choose "Current"/original.
- **Big album downloads** stream straight to disk in Chrome and Edge on a computer, at any size. Other browsers get the album in parts of up to 1 GB.

## How it is built

| Part | Where |
|---|---|
| Website (HTML, CSS, JS) | `public/`, packed into the Worker by `scripts/build-site.mjs` on every deploy |
| API: login, albums, uploads, trash, daily cleanup | `src/index.js` (Cloudflare Worker) |
| Photo files | Cloudflare R2 |
| Albums, uploader, capture time, trash | Cloudflare D1 (SQLite) |
| Browser libraries and fonts, served from the site itself | `public/vendor/`, `public/fonts/` (refresh with `npm run vendor`) |

Fonts are self-hosted on purpose: embedding Google Fonts from Google's servers has been ruled a GDPR violation in Germany.

### Running it locally

```bash
npm install
```

```bash
echo 'APP_PASSWORD=test123' > .dev.vars
```

```bash
npm run dev
```

Then open http://localhost:8787. Storage and database are simulated locally.
