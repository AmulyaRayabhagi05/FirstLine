# FirstLine resident app (PWA)

The app residents use: sign up (themselves or someone they care for), then one tap for
"I'm safe" or "I need help", and answer a neighbor's request to check on them. Served at
`/app/` on the dashboard's site (`https://207-148-5-196.sslip.io/app/`) and installable
("Add to Home Screen").

```bash
cd mobile
npm install
npm run dev          # http://localhost:5175/app/   (copies the bindings from web/ first)
npm run build        # deploy/vultr/deploy.sh builds this and serves it at /app/
```

Open `/app/?demo` for a sample resident and a neighbor request that never touches the database
(for demos and the video).

## How it works
- **Account = this phone.** The first visit creates a SpacetimeDB identity; its access key stays
  on the phone (Settings shows it, to sign in on another phone). No token ships in the build.
- **Sign-up** calls `register_person`: name, age (18+), phone, language (en/es/vi), lives alone,
  mobility, powered medical device, medical needs, smartphone, home address and location
  (phone GPS, or the address looked up with OpenStreetMap). One account can register up to
  20 people, e.g. a parent without a smartphone.
- **Reads only its own rows** through the `my_*` views: `my_person`, `my_sos_event`,
  `my_assignment`, `my_household`. Nothing about other residents reaches the phone.
- **"I need help"** (`press_sos`) and **"I'm safe"** (`check_in`) go through an outbox stored on
  the phone with a client id, so they send when the signal comes back and never twice.
- **Neighbor requests:** offers to this account's people show with directions, "I'll go" /
  "I can't" (`accept_assignment` / `decline_assignment`), then "They're safe" (`mark_safe`).
- English and Spanish (follows the phone, switchable). Large type and buttons; light and dark.
- Works offline once opened: `public/sw.js` caches the app shell.

## Not built yet
- Phone-number sign-in (SMS code) instead of the access key.
- Editing your details or safety net in the app, and deleting an account (needs a reducer).
