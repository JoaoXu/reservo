# Onboarding a business

## Before the visit: write their client file

Each business is one file, `clients/<slug>.json`: texts, colours, sections,
services, team and hours, gathered from their Instagram, Google listing or
price sheet. Owners rarely do this themselves, and a site with their real
prices is what sells it. Start from the fictional demo closest to them:
`clients/mare.json` (massage, Classic template) or `clients/navalha.json`
(barbershop, Studio template).

```bash
cp clients/mare.json clients/casa-lotus.json   # then edit it
npm run tenant:apply -- clients/casa-lotus.json --dry-run   # shows what would change
npm run tenant:apply -- clients/casa-lotus.json
```

The first run creates the business and prints the owner's one-time password.
The site is live at `https://casa-lotus.<platform domain>` straight away
(today `casa-lotus.reservo.joaoxu.dev`). Re-running applies only what changed,
so the file is also how you update it while setting it up. Commit the file.

Against production, run it as a one-off task from `deploy/aws`:
`./run-task.sh node scripts/tenant-apply.ts clients/casa-lotus.json` (the
file must be in the deployed image, so commit and release first). The
password appears in the task output printed by `run-task.sh`.

### File format

| Field | Notes |
|---|---|
| `slug` | Lowercase letters, digits, dashes. Becomes `<slug>.<platform domain>`. |
| `name`, `business_type` | `massage`, `salon`, `barber` or `beauty`. The type sets the wording ("Terapeuta", "Barbeiro", "Serviços"...). |
| `status` | `trial` (default for new), `active`, or `demo` (simulated payments; only for the fictional demos). |
| `owner` | `{ "email", "name" }`. Created once; an existing password is never touched. Demos only: `password`, so the demo login can be shared. |
| `booking` | `slot_interval_min` (10/15/20/30/60), `min_lead_hours`, `max_advance_days`, `cancel_window_hours`. |
| `payments` | `mode` (`none`/`deposit`/`full`), `deposit_percent`, `pay_at_studio_allowed`, `provider` (`none`/`ifthenpay`). Keys are never in the file: enter them in the dashboard. |
| `site.content` | Texts in `_pt`/`_en`, address, `map_url` (https), `phone`, `whatsapp` (`+351…`), `email`, `instagram`, `legal_name`, `nif`. |
| `site.template` | `classic` (calm, serif; massage, spa, beauty) or `studio` (bold, dark; barbers, salons). |
| `site.theme` | `palette`: `salvia`, `terracota`, `carvao`, `rosa`, `oceano`, `oliva`; any of `ink`, `paper`, `accent`, `soft` (`#rrggbb`) override it and must keep 4.5:1 contrast. `font`: `serif` or `sans` (defaults to the template's). `logo` and `cover`: image paths (see below). |
| `site.sections` | Order and visibility of `hero`, `services`, `about`, `team`, `gallery`, `testimonials`, `faq`, `visit`. Services can't be hidden; empty sections don't show. |
| `site.gallery[]` | Up to 12 `{ "image", "alt_pt", "alt_en" }`. |
| `site.testimonials[]` | Up to 6 `{ "quote_pt", "quote_en", "author" }`. Real clients, with permission. |
| `site.faq[]` | Up to 12 `{ "q_pt", "a_pt", "q_en", "a_en" }`. |
| `services[]` | `name_pt` (the key, keep it stable), `name_en`, `category`, `category_en`, descriptions, `duration_min`, `buffer_min`, `price_eur`. |
| `staff[]` | `name` (the key), titles and bios, optional `photo` (image path), `services` (`"all"` or a list of `name_pt`), `hours` like `{ "mon": ["10:00-13:00", "14:00-19:00"] }`. |

**Images** are paths relative to the client file, e.g. put the business's
photos in `clients/casa-lotus/` and write `"cover": "casa-lotus/sala.jpg"`.
`tenant:apply` uploads them into the business's photo library (named by
content, so re-applying never duplicates) after the same checks as dashboard
uploads: JPEG, PNG or WebP by content, metadata stripped. Resize big photos to
about 2000px first. Owners can also upload in the dashboard under **Fotos**.

Services and people are matched by name. Remove one from the file and it is
deactivated (past bookings keep pointing at it); rename one and it counts as
removed plus added.

**After hand-over the owner edits in the dashboard.** If they have published
their own site changes, `tenant:apply` leaves the site alone and says so;
`--overwrite-site` replaces it (their versions stay in the history). Services,
team and hours in the file always win, so stop applying the file once the
owner manages those themselves.

## Website edits: draft, preview, publish

In the dashboard, **Fotos** is the photo library (uploads are resized on the
owner's phone and stripped of GPS location before they leave it), and
**Site** holds the texts, look (template, colours, font, logo, cover photo),
section order, gallery, testimonials and FAQ. Changes go into a draft; **Preview** shows it on their real site to signed-in users only;
**Publish** makes it live; **History** can restore any earlier version.

## Payments (ifthenpay)

1. The studio signs up at ifthenpay (free to join; a sole trader can sign with
   ID, proof of address, VAT status certificate and IBAN). Ask for **MB WAY**
   and **Multibanco (dynamic references, MB KEY)**, plus **card (CCARD KEY)**
   if they get many tourists.
2. In **Settings → Payments**: choose ifthenpay, paste the keys, and choose a
   deposit (30% is a good default for massage; it cuts no-shows without
   scaring people off).
3. Copy the callback URLs shown on that page and email them to ifthenpay
   support asking them to activate the callback for each key, with an
   anti-phishing key of your choosing (enter the same key in the dashboard).
4. Test with a €1 treatment: book it, pay with MB WAY, check it shows as paid,
   then refund from the ifthenpay back office.

## Domain (optional)

If they own `casalotus.pt`:
1. They (or you) add a CNAME `www` → your load balancer host, and an A/ALIAS
   for the root if supported.
2. Add the domain to the certificate (see DEPLOY.md) and to the studio:
   ```sql
   insert into tenant_domains (domain, tenant_id, is_primary)
   select 'casalotus.pt', id, true from tenants where slug = 'casa-lotus';
   update tenant_domains set is_primary = false where domain = 'casa-lotus.reservo.pt';
   ```

## Messages

- Email works as soon as Brevo is configured (sent from your domain with the
  studio's name and reply-to address).
- WhatsApp needs two templates approved once in your Meta Business account
  (Utility category, language pt_PT), shared by all studios:
  - `booking_confirmed`: "Olá {{1}}, a sua marcação de {{2}} está confirmada para {{3}}. Código {{4}}. Gerir: {{5}}"
  - `booking_reminder`: "Olá {{1}}, lembramos a sua marcação de {{2}} amanhã, {{3}}. Se não puder vir, cancele aqui: {{4}}"

## Hand-over (15 minutes with the owner)

- Log in on their phone, add the dashboard to the home screen.
- Show the agenda, and how to add a phone/WhatsApp booking with **Nova**.
- Show how to block a day off and how to record a cash payment.
- Put the booking link in their Instagram bio and Google Business profile,
  and set their WhatsApp Business away message to point to it.
- Agree the trial end date and monthly price in writing.
