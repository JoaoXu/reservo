# Architecture and security

## Shape

```
     business domains (mare.reservo.joaoxu.dev, later casalotus.pt, …)        media.<domain>
                               │                                                    │
                       load balancer / TLS                                     CloudFront
                               │                                                    │
            ┌──────────────────┴──────────────────┐                                 │
            │  app (N stateless containers)        │── put/delete (task role) ──► S3 (private)
            │  site · booking · dashboard · hooks  │──── ifthenpay API (MB WAY, Multibanco, card)
            └──────────────────┬──────────────────┘──── Brevo (email, SMS) · Meta (WhatsApp)
                               │
                         PostgreSQL 16  ◄── EventBridge: POST /internal/cron every minute
```

On AWS this is ECS Fargate behind an ALB, RDS, S3 + CloudFront and
EventBridge, all in Terraform (`deploy/aws/`).

- **Multi-tenant, one database.** Every table carries `tenant_id`. Composite
  foreign keys `(tenant_id, id)` mean a booking can only point at a therapist,
  service or customer of the same studio, enforced by the database. The studio
  is resolved from the request's Host header (custom domain, or
  `<slug>.<PLATFORM_DOMAIN>`), cached for 30 s per instance.
- **One template system, many businesses.** A business is rows plus a client
  file (`clients/<slug>.json`): business type (wording), template, curated
  palette and fonts, sections, services, team, hours. Site content is
  versioned: edits are drafts, publishing copies a version into the tenant
  row, any earlier version can be restored.
- **Images stay inside their business.** Files live at `t/<tenant_id>/<file>`;
  pages store only file names and build URLs with the tenant's own id, so a
  name copied from another business points at nothing. Team photos also have a
  composite foreign key into the business's own media.
- **Stateless app.** Sessions, rate limits and job locks live in Postgres, so
  you can run 1 or 50 containers with no sticky sessions or Redis.
- **No framework.** `node:http` plus a 60-line router. One runtime dependency
  (`postgres`). Small attack surface; starts in under half a second and runs in about 100 MB of RAM.

## Booking correctness

- Availability is a pure function (`src/domain/availability.ts`) of weekly
  hours, time off and existing bookings, computed in the studio's time zone.
  Local times are converted through the zone rules, so the March and October
  clock changes produce no phantom or missing slots.
- **Double booking is impossible at the database level:**
  ```sql
  exclude using gist (staff_id with =, tstzrange(starts_at, blocked_until, '[)') with &&)
  where (status in ('pending_payment','confirmed'))
  ```
  `blocked_until` includes the clean-up buffer. Two simultaneous requests for
  the same therapist and time: one commits, the other gets a constraint
  violation and either tries the next free therapist ("no preference") or
  returns "that time was just taken". Postgres can also report such a race as
  a deadlock (40P01); that is retried the same way.
- **Holds.** A booking waiting for payment holds its slot until
  `hold_expires_at` (MB WAY 10 min, card 30 min, Multibanco 24 h by default).
  Expired holds are released by the job runner, and also inside any booking
  transaction that would overlap them.
- **Payment outcomes are idempotent.** Callback, MB WAY notification, status
  polling and the reconcile job all go through `applyPaymentOutcome`, which
  locks the payment row. ifthenpay retries callbacks up to 13 times; duplicates
  are harmless. A payment that arrives after its hold expired re-confirms the
  booking if the slot is still free; otherwise the owner gets an alert.

## Payments

- Each studio signs its own ifthenpay contract. Money goes directly from the
  customer to the studio; Reservo never holds funds, so it needs no payment
  licence and carries no chargeback risk.
- Keys (MB WAY, MB KEY, CCARD KEY, anti-phishing key) are stored encrypted with
  AES-256-GCM under `DATA_ENCRYPTION_KEY`. They are write-only in the dashboard.
- Callback verification: anti-phishing key compared in constant time, order
  must exist for that studio, and the amount must match to the cent.
- MB WAY status notifications are verified with HMAC-SHA256 as specified by
  ifthenpay (orderId + amount + requestId, keyed with the MB WAY key).
- Card payments use ifthenpay's hosted page; card data never touches Reservo
  (PCI scope: SAQ A).

## Web security

| Threat | Control |
|---|---|
| XSS | Every value in templates is escaped by default (`html` tagged template). Browser JS builds DOM with `textContent`. Strict CSP: `script-src 'self'`, styles only from our files or a per-response nonce, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`. |
| CSRF | All POSTs require a same-origin `Origin`/`Referer`; dashboard POSTs also need a per-session token. Session cookie is `SameSite=Lax`, `HttpOnly`, and `__Host-` prefixed with `Secure` over HTTPS. |
| SQL injection | All queries are parameterised tagged templates. |
| Credential attacks | scrypt (N=2^15) password hashes; login rate-limited per IP and per account; equal timing for unknown emails; changing password signs out other devices. |
| Enumeration | Booking links carry an HMAC token derived from the booking id; refs alone reveal nothing. |
| Abuse | Rate limits on slots, booking, status polling, retries and webhooks; honeypot field on the booking form; request body capped at 64 KB; request and header timeouts. |
| Clickjacking, sniffing | `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS over HTTPS. |
| Open redirects | Redirects are only to relative paths. |
| CSV injection | Exported cells starting with `= + - @` are neutralised. |
| Image uploads | Owner only, CSRF token in a header plus same-origin check, 5 MB cap while reading, 200 per business. Format decided from the bytes (JPEG, PNG, WebP; never SVG or the file name), dimensions read without decoding, metadata stripped. Stored under server-generated names; served from a separate origin (CloudFront) with `nosniff`. CSP `img-src` allows only our own origin and the media origin. |
| Secrets in logs | Logger redacts key/token/password fields; recipients are masked in the notifications table. |

## Privacy (RGPD / GDPR)

- Each studio is the **controller**; you (Reservo) are the **processor**. Sign
  an art. 28 processing agreement with every studio (template to prepare with
  a lawyer) listing sub-processors: hosting (AWS, eu-west-1; uploaded images are
  also cached at CloudFront edges in Europe and North America), Brevo, Meta
  (WhatsApp), ifthenpay (the studio's own processor for payments).
- Data minimisation: name, phone, optional email and note. Explicit privacy
  consent stored per customer; marketing consent separate and opt-in.
- Rights: the owner can export customers (CSV) and erase a customer, which
  anonymises personal data while keeping booking history for accounting.
- Retention: customers with no bookings for `CUSTOMER_RETENTION_MONTHS`
  (default 24) are anonymised automatically.
- Fonts are self-hosted (no Google Fonts requests) and there are no
  third-party scripts or trackers on studio sites.
- Photos are re-encoded in the owner's browser before upload and stripped of
  metadata again on the server, so a phone photo's GPS position (often the
  therapist's home) never reaches the server. Deleting a photo removes the
  file; S3 keeps a deleted version for 30 days.

## Scaling notes

- Up to a few hundred studios fit on the smallest Cloud SQL / RDS instance.
  Booking traffic is tiny; the heaviest query is the slot search, three
  indexed queries per day viewed.
- Watch connection count: instances × `DB_POOL_MAX` must stay below Postgres
  `max_connections`. Add PgBouncer or RDS Proxy before ~200 connections.
- Tenant cache is per instance (30 s). Settings changes show up on other
  instances within 30 s.
- Static assets are served with ETags and immutable caching when versioned;
  put a CDN (Cloud CDN / CloudFront) in front when traffic grows. Uploaded
  images already go through CloudFront.
- Images are served at upload size (at most 2000px). Thumbnails would need
  server-side resizing (`sharp`) or an image CDN.
