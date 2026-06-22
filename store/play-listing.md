# Google Play listing — Connect

Everything needed to create the Play Console listing. Copy/paste each block.
Assets live in this `store/` folder and in `../screenshots/`.

---

## 1. App identity

| Field | Value |
|---|---|
| App name (Play title) | **Connect: Stay in Touch** |
| Package name | `tech.navlakha.connect` |
| Default language | English (United States) – `en-US` |
| App or game | App |
| Free or paid | Free |
| Contains ads | No |
| In-app purchases | No |
| Category | **Social** |
| Tags (pick ≤5) | Relationships, Productivity, Personal, Reminders, Address book |
| Developer / company | Navlakha Technologies |
| Version (this release) | versionName `1.0`, versionCode `1` |
| minSdk / targetSdk | 24 / 34 |

Contact details (Store listing → Store settings):
- Email: `support@navlakha.tech`
- Website: `https://navlakha.tech/connect`
- Phone (optional): `+91 82752 69688` (WhatsApp support line)
- Privacy policy: `https://navlakha.tech/privacy`  ⚠️ must be live & reachable before review

---

## 2. Short description (max 80 chars)

```
Reconnect with people who matter — gentle nudges from your own call history.
```
(75 chars)

Alternates:
- `Stay close to the people who matter. Private, on-device reconnect reminders.` (75)
- `Your circle, kept warm. Quiet reminders to reconnect — all on your device.` (73)

---

## 3. Full description (max 4000 chars)

```
Connect is a calmer way to stay in touch with the people who matter.

We all have people we mean to call back — an old college friend, a cousin, a former colleague — and somehow months slip by. Connect quietly notices who you've drifted from and gently nudges you to reach out, before the silence becomes a year.

It works from the call history already on your phone. No new social network, no feed, no noise — just a gentle daily reminder of one or two people worth a quick call.

WHAT CONNECT DOES

• Reconnect today — a spotlight on the people you used to talk to often but haven't in a while, so you always know who to call next.
• Missed connections — surfaces calls you never returned, so nobody slips through the cracks.
• Want to connect — hand-pick the people you most want to keep close, and Connect keeps them front and centre.
• Groups — organise your circle into Family, College friends, Office, and more. A person can belong to many groups.
• Milestones — light, optional streaks and goals that make staying in touch feel rewarding, not like a chore.
• Notes — jot a quick note on anyone ("loves long calls on Sundays") so you always pick up where you left off.
• One-tap calling, SMS and WhatsApp right from each person.

PRIVATE BY DESIGN

Your relationships are nobody's business but yours.

• Everything lives on your device. By default, nothing is uploaded to any server.
• Read-only — Connect reads your contacts and call log to surface reminders. It never edits, deletes, or posts anything.
• No account required. No feed. No ads. No tracking.

WHY THE CALL LOG?

Connect's whole point is to spot relationships going quiet. Your call history is the honest signal for that — it shows who you actually talk to and when you last did. Connect reads it only on your device, to power your reconnect reminders. You can use the app without granting it, but the reminders are far better with it.

OPTIONAL AI GROUPING

If you want, you can add your own AI key (Google AI Studio, OpenAI, or OpenRouter) to auto-sort contacts into groups. This is entirely optional and off by default. When enabled, only contact names are sent to the provider you choose, using your own key.

Connect is for anyone who wants to be a little more present with the people they love — without another noisy app demanding their attention.

Stay in touch with the people who matter.
```

---

## 4. Release notes ("What's new" — max 500 chars)

```
First release of Connect 🎉
• Reconnect today, Missed connections, and Want to connect — always know who to call next
• Organise your circle into groups
• Milestones to keep your streak going
• Quick notes per person
• 100% on your device — private by design
```

---

## 5. Graphic assets

| Asset | Spec | File |
|---|---|---|
| App icon (hi-res) | 512×512, 32-bit PNG, no alpha needed | `store/play-icon-512.png` ✅ generated |
| Feature graphic | 1024×500, PNG/JPG, no transparency | `store/feature-graphic-1024x500.png` ✅ generated |
| Phone screenshots | 1080×1920 (9:16), 2–8 required | `screenshots/01..11-*.png` ✅ (11 available) |

Notes:
- **App icon** was downscaled from the existing 1024 master (`ios/.../icon-1024.png`) — the teal tile with the cream "C" and terracotta node. Play applies its own rounded-corner + shadow mask, so the square full-bleed PNG is correct; don't pre-round it.
- **Feature graphic** is brand-matched (teal gradient, the icon, "Connect" wordmark + tagline). It's shown at the top of the listing and in some promo placements. Keep critical content away from the edges (Play may overlay UI). Regenerate any time with `store/generate-store-assets.ps1`.
- (Optional) Tablet screenshots (7"/10") improve eligibility for tablet/ChromeOS surfacing — not required for launch.

### Recommended screenshot order + captions
Upload in this order; captions are for an optional framed/marketing version (Play itself shows no caption on raw screenshots):

1. `01-home-reconnect.png` — "Always know who to call next"
2. `03-home-missed.png` — "Never leave a call unreturned"
3. `04-home-want.png` — "Keep the people you choose close"
4. `02-home-milestones.png` — "Make staying in touch rewarding"
5. `06-groups.png` — "Organise your whole circle"
6. `08-contact-detail.png` — "Every relationship, at a glance"
7. `09-contact-notes.png` — "Tag groups and keep notes"
8. `05-reconnect-tab.png` — "Your full reconnect list"

---

## 6. Data safety form  ⚠️ read carefully

The marketing says "on-device", and that's true **by default**. But the optional
AI grouping feature sends **contact names** to a third-party LLM when a user turns
it on with their own key. The form must reflect reality. Two compliant paths:

**Option A — keep the AI feature, declare it (recommended if you want AI in v1):**
- Does your app collect or share user data? **Yes**
- Data type: **Contacts → Name**
  - Collected: **Yes** · Shared: **Yes** (sent to the LLM provider the user selects)
  - Purpose: **App functionality** (personalisation/grouping)
  - Processed ephemerally: as applicable · Not used for ads
  - User can choose whether it's collected: **Yes** (feature is opt-in)
- Everything else: **Not collected**
- Encrypted in transit: **Yes** (HTTPS)

**Option B — ship v1 without AI grouping (cleanest, matches "local-only"):**
- Gate/remove the LLM key feature from the Play build, then answer:
- Does your app collect or share user data? **No data collected or shared**
- This is the simplest path through review and matches the privacy messaging.

> Recommendation: if AI grouping isn't essential for launch, go **Option B** for v1,
> then add AI + the Option A disclosure in a later update. Either way, the privacy
> policy at `navlakha.tech/privacy` must describe the contacts/call-log usage and,
> for Option A, the third-party LLM transmission.

---

## 7. App content (Policy → App content)

**Privacy policy:** `https://navlakha.tech/privacy` (required — sensitive permissions in use).

**Sensitive permissions declaration — Call Log (`READ_CALL_LOG`)**  ⚠️ blocking item
This permission is restricted; you must justify it or the app is rejected.
- Core purpose: *"Connect's core function is to remind users who they've fallen out of touch with. It analyses the user's own call history entirely on-device to detect dormant relationships and surface reconnect/missed-call reminders. The call log is the primary signal for this; without it the app's main purpose cannot work."*
- Is it core to the app: **Yes**
- Alternative (non–call-log) implementation possible: **No**
- Be ready to provide a short **demo video** (Play often asks) showing the reconnect/missed-call features that use the call log.

**Other permissions** (for your reference; declared in AndroidManifest):
`READ_CONTACTS` (read circle), `CALL_PHONE` (one-tap call), `INTERNET` + `ACCESS_NETWORK_STATE` (only used by the optional AI grouping call).

**Content rating questionnaire:** category Social/Utility; answer No to all violence/sexual/gambling/etc. → expected rating **Everyone / PEGI 3 / IARC 3+**.

**Target audience & content:** target age **18 and over** (app reads personal communications data; keeps it out of Families policy scope). Not designed for children. No ads.

**Government apps / Financial features / Health:** No to all.

**News app:** No.

**Data deletion:** the app stores data on-device only; the in-app *Settings → Delete data* removes it. Provide that, plus the support email, as the deletion method.

---

## 8. Console flow (order of operations)

1. Play Console → **Create app** → name `Connect: Stay in Touch`, language en-US, App, Free, accept declarations.
2. **Store listing**: paste short + full description, upload `play-icon-512.png`, `feature-graphic-1024x500.png`, and the 8 screenshots (section 5 order). Set category **Social** + tags + contact details.
3. **Store settings**: category, contact email/website/phone.
4. **App content** (section 7): privacy policy, ads = No, content rating, target audience = 18+, data safety (section 6), **Call Log permission declaration**, government/financial/health = No.
5. **Production → Create release**: upload the signed **AAB** (`./gradlew bundleRelease` → `android/app/build/outputs/bundle/release/app-release.aab`; needs an upload keystore + Play App Signing). Add release notes (section 4).
6. Set countries/regions (e.g. India + worldwide), review, and **submit for review**.

> Build note: the screenshots were taken from a debug build with seeded demo data.
> The release build must use the real onboarding flow — do **not** ship `devSeed`
> (it was already removed). Generate the release AAB with your production keystore.
```
