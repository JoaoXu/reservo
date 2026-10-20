# Onboarding a studio (about one hour of your time)

## Before the visit

1. Create the studio:
   ```bash
   npm run tenant:create -- --slug casa-lotus --name "Casa Lótus" \
     --owner-email ana@casalotus.pt --owner-name "Ana Lima" --trial-days 30
   ```
   It prints a one-time password. The site is live at
   `https://casa-lotus.reservo.pt` straight away.
2. From their Instagram, Google listing or price sheet, fill in **Settings →
   Studio and texts** (headline, intro, address, map link, phone, WhatsApp),
   **Treatments** (names, length, break after, price, both languages) and
   **Team** (each person's weekly hours). Owners rarely do this themselves,
   and a site with their real prices is what sells it.

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
