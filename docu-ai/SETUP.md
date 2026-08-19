# Setup

Two one-time steps, both of which need you rather than the agent: installing a Node runtime, and
creating an OAuth client in Google Cloud.

## 1. Node

There is no Node runtime on this machine yet. On Arch:

    sudo pacman -S nodejs npm

Then:

    npm install

## 2. A Google OAuth client

**Desktop app is the dev credential, not the production one.** It is the only client type whose
redirect URI may be `http://localhost:<any port>`, which is what the loopback flow in
`src/auth/google.ts` needs — it binds an ephemeral port and builds the redirect from whatever it got.
A Web application client requires pre-registered exact redirect URIs, so it needs a fixed port (or a
deployed callback URL) that does not exist yet. When the web interface arrives it gets its own Web
client in the same project; the two coexist and this one stays for CLI work.

1. Open <https://console.cloud.google.com/> and create a project (or pick an existing one).
2. **APIs & Services → Library**: enable **Google Docs API** and **Google Drive API**.
   Drive is needed to export the document to PDF, which is how fonts get verified.
3. **APIs & Services → OAuth consent screen**: choose **Internal**. This is not just tidiness —
   **External + "Testing" issues refresh tokens that expire after 7 days**, so you would be re-running
   `npm run auth` every week. Internal has no such expiry and no 100-test-user cap. If only External is
   available, add yourself under *Test users* and expect the weekly re-auth until the app is published.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Desktop app**
   - Download the JSON and save it in the repo root as `credentials.json` (already gitignored).

   The scopes requested at runtime are `documents` and `drive.file`. `drive.file` limits this app to
   files it created — it cannot see the rest of your Drive.

Alternatively, skip the file and export the pair directly:

    export DOCU_AI_CLIENT_ID=...
    export DOCU_AI_CLIENT_SECRET=...

## 3. Run it

    npm run auth     # browser consent once; refresh token cached in ~/.config/docu-ai/token.json
    npm run probe    # verify assumptions against the live API — read this before trusting anything
    npm run m0       # build the M0 proof document

`npm test` needs none of the above and must always pass without credentials.

## What the probe tells you

`npm run probe` exists because two things cannot be settled by reading documentation:

- **Which fonts actually render.** Docs substitutes Arial for a font it does not recognise, and does
  it at render time, so `documents.get` keeps reporting the font we asked for. The probe exports the
  document to PDF and runs `pdffonts` to see which fonts were really embedded.
- **Whether `addDocumentTab` works.** It is present in the API's discovery document but Google's own
  tabs guide claims tab creation is UI-only. The probe settles it by creating one.

Read the CONTROLS block of the report first. It applies Arial (which must embed) and a deliberately
fake font (which must fall back). If those two do not behave, the probe cannot detect failure and
none of its other font results mean anything.

Whatever passes goes into `VERIFIED_FONTS` in `src/theme/fonts.ts`; the theme presets may only use
fonts from that list, and `assertVerifiedFonts` blocks a build that breaks the rule.
