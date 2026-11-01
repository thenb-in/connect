# Apple App Store listing — Connect

Everything needed to create the App Store Connect record and submit v1.0.
Assets live in `store/` and `screenshots-ios/`.

> ⚠️ **This is not a copy of the Play listing.** iOS gives apps **no access to the
> system call history** — Apple has no equivalent of Android's `READ_CALL_LOG`.
> The Play description leans hard on "reads the call history already on your phone",
> which is **false on iOS** and is a Guideline 2.3.1 (Accurate Metadata) rejection
> waiting to happen. The copy below describes what the iOS build actually does.

---

## 0. What the iOS build actually does (read this first)

| Capability | Android | iOS |
|---|---|---|
| Read device call history | ✅ `READ_CALL_LOG` | ❌ **impossible** — no API exists |
| Read contacts | ✅ | ✅ `NSContactsUsageDescription` |
| Log calls placed **from inside Connect** | ✅ | ✅ via `CXCallObserver` (`CallObserverModule.m`) |
| Add past calls by hand | ✅ | ✅ `AddCallLogModal` |
| Reconnect reminders / groups / milestones / notes | ✅ | ✅ |
| Auto-grouping via local heuristics | ✅ | ✅ |
| Auto-grouping via third-party LLM | ✅ | ❌ **gated off for 1.0** (§8) |

So on iOS the reconnect engine is seeded by **contacts + the calls you place through
Connect + anything you log manually**, and it gets smarter the more you use it.
`src/onboarding/steps.js:52` already skips the call-log step on iOS, so the app
handles this correctly — the *marketing copy* is the only thing that needs fixing.

---

## 1. App identity

| Field | Value |
|---|---|
| App Name (max 30) | **Connect: Stay in Touch** (22) |
| Subtitle (max 30) | **Never lose touch again** (22) |
| Bundle ID | `tech.navlakha.connect` |
| SKU | `connect-ios-001` |
| Primary language | English (U.S.) |
| Primary category | **Social Networking** |
| Secondary category | Productivity |
| Price | Free · No IAP · No ads |
| Version / Build | `1.0` / `1` |
| Min iOS | 15.1 |
| Copyright | `2026 Navlakha Technologies` |
| Team | `XCG3K93VVG` |

**App Store Connect → App Information URLs**
- Privacy Policy URL: `https://navlakha.tech/privacy` ✅ live (HTTP 200)
- Support URL: `https://navlakha.tech` ✅ live (HTTP 200)
- Marketing URL (optional): leave blank, or use `https://navlakha.tech`

> `https://navlakha.tech/connect` 404s. `APP_WEBSITE_URL` in `src/utils/appShare.js`
> now points at `https://navlakha.tech` so the in-app About link and the store's
> Support URL both resolve. If you later publish a real `/connect` page, change it
> back in one place.

---

## 2. Subtitle options (max 30 chars)

```
Never lose touch again
```
Alternates:
- `Keep your circle close` (21)
- `Gentle nudges to reconnect` (26)
- `Your people, kept close` (23)

---

## 3. Promotional text (max 170 chars — editable without a new build)

```
The people who matter drift away quietly. Connect notices who you haven't spoken to in a while, and gently nudges you to call — privately, all on your iPhone.
```
(158 chars)

---

## 4. Description (max 4000 chars) — iOS-accurate

```
Connect is a calmer way to stay in touch with the people who matter.

We all have people we mean to call back — an old college friend, a cousin, a former colleague — and somehow months slip by. Connect quietly keeps track of who you've drifted from and nudges you to reach out, before the silence becomes a year.

No new social network. No feed. No noise. Just a gentle daily reminder of one or two people worth a quick call.

HOW IT WORKS ON iPHONE

Connect builds a private picture of your circle from your contacts, and from the calls you place through the app. Every time you call someone from Connect, it quietly notes it — so it always knows who you last spoke to and who's gone quiet. During setup you can tell it roughly when you last spoke to the people you pick, and you can add past calls by hand. Nothing leaves your phone.

WHAT CONNECT DOES

• Reconnect today — a spotlight on the people you haven't spoken to in a while, so you always know who to call next.
• Want to connect — hand-pick the people you most want to keep close, and Connect keeps them front and centre.
• Groups — organise your circle into Family, College friends, Office, and more. A person can belong to many groups.
• Say hi today — one gentle, randomised suggestion per group, so it never feels like a to-do list.
• Milestones — light, optional streaks and goals that make staying in touch feel rewarding rather than like a chore.
• Notes — jot a quick note on anyone ("loves long calls on Sundays") so you always pick up where you left off.
• One-tap calling, SMS and WhatsApp from every person.
• Export and import everything as portable JSON. Your data, your control.

PRIVATE BY DESIGN

Your relationships are nobody's business but yours.

• Everything lives on your iPhone. There is no account, no server, and no sync.
• Read-only with your contacts — Connect never edits, deletes, or posts anything.
• No ads. No analytics. No tracking. No third-party SDKs watching you.

A HEAD START ON GROUPING

Sorting a few hundred contacts by hand is nobody's idea of fun, so Connect can take a first pass for you and let you correct whatever it gets wrong. It runs entirely on your iPhone — no key to set up, no network request, nothing sent anywhere.

Connect is for anyone who wants to be a little more present with the people they love — without another noisy app demanding their attention.

Stay in touch with the people who matter.
```

---

## 5. Keywords (max 100 chars, comma-separated, no spaces after commas)

```
reconnect,contacts,relationships,reminder,friends,family,call,network,crm,keep in touch,private
```
(99 chars)

Notes: don't repeat words already in the app name/subtitle (Apple indexes those
separately) — that's why "connect", "touch", and "stay" are absent.

---

## 6. Screenshots

The 11 files in `screenshots/` are **1080×1920 Android** captures — wrong aspect
ratio and visibly Android. They are not usable here. Fresh iOS captures live in
**`screenshots-ios/`** at **1290×2796**.

**Requirement:** a 6.9" iPhone set is mandatory. Accepted portrait sizes are
`1320×2868`, `1290×2796`, or `1260×2736`; `1284×2778` (6.5") is the only accepted
alternative. **6.1" — 1170×2532 — does not satisfy it**, which is why an iPhone 13
Pro can't be used as the capture device. Apple scales the 6.9" set down for every
smaller iPhone, so this one set is all you need. No iPad set is required (§7).

Captured on the **iPhone 16 Plus simulator**, which is in Apple's 6.9" group and
renders natively at 1290×2796:
```bash
xcrun simctl boot "iPhone 16 Plus"
xcrun simctl install booted <path>/connect.app
xcrun simctl status_bar booted override --time "9:41" \
  --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3
xcrun simctl io booted screenshot screenshots-ios/01-home-reconnect.png
```

### Upload order + what each shot shows

| # | File | Shows |
|---|---|---|
| 1 | `01-home-reconnect.png` | Home — "Reconnect today", Vikram Shetty, 212 days quiet |
| 2 | `02-reconnect-list.png` | The full reconnect list, ranked by who's most overdue |
| 3 | `03-groups.png` | Groups by category — Friends / Family / Office / Helpers |
| 4 | `04-group-detail.png` | Inside a group, "sorted by who to reach out to first" |
| 5 | `05-contact-detail.png` | One person: stats, recent calls, group tags |
| 6 | `06-milestones.png` | Milestones — "Three in a row" earned |
| 7 | `07-settings.png` | Export/import, saved call logs, delete-all — the privacy story |

All seven are 1290×2796, RGB, **no alpha channel** (Apple rejects alpha).

> **All data in these screenshots is fabricated.** They were captured from a build
> carrying a temporary seed of invented names on the `+91 98765 0XXXX` block, so no
> real contact appears in a public listing. That seed was deleted after capture —
> `App.js` and the source tree contain no seeding code, and the archive was rebuilt
> from the clean tree afterwards. If you re-shoot, seed fake data again rather than
> pointing a build at real contacts.

---

## 7. Status of the blocking items

| # | Item | Status |
|---|---|---|
| 1 | Support URL 404 | ✅ fixed — `APP_WEBSITE_URL` → `https://navlakha.tech` |
| 2 | iPhone-only target | ✅ `TARGETED_DEVICE_FAMILY = 1` pinned in both configs |
| 3 | Export compliance | ✅ `ITSAppUsesNonExemptEncryption = false` in Info.plist |
| 4 | AI grouping / privacy labels | ✅ gated off on iOS → "Data Not Collected" (§8) |
| 5 | iOS screenshots | ✅ 7 shots at 1290×2796, no alpha → `screenshots-ios/` |
| 6 | Release archive builds | ✅ `** ARCHIVE SUCCEEDED **`, v1.0 (1) |
| 6b | iOS-wrong copy | ✅ "Play Store link" / "iOS coming soon" removed from the iOS UI |
| 7 | **Distribution signing** | ❌ **blocked — needs your Apple ID** |
| 8 | **App Store Connect record** | ❌ **blocked — needs your login** |
| 9 | `IOS_STORE_URL` | ⏳ post-launch — fill in for 1.0.1 |

**7 — Distribution signing (blocks the upload).** The export fails with:
```
error: exportArchive No Account for Team "XCG3K93VVG".
error: exportArchive No signing certificate "iOS Distribution" found
```
The keychain only holds an *Apple Development* identity. Fix either way:
- **Xcode:** Settings → Accounts → **+** → Apple ID → sign in with the account
  holding the new paid membership. Xcode then creates the Apple Distribution cert
  and the App Store profile on the next export.
- **CLI (better for repeat builds):** App Store Connect → Users and Access →
  Integrations → App Store Connect API → generate a key with **App Manager** role,
  save the `.p8` to `~/.appstoreconnect/private_keys/`, then pass
  `-authenticationKeyPath / -authenticationKeyID / -authenticationKeyIssuerID`
  to `xcodebuild -exportArchive` and `xcrun altool`.

**8 — App Store Connect record.** The app doesn't exist in ASC yet, and a build
can't be uploaded until it does. This needs a browser login (§11 steps 1–5).

**9 — `IOS_STORE_URL`.** `src/utils/appShare.js` still has `IOS_STORE_URL = null`,
so Share says "Coming soon to iOS". Set it to `https://apps.apple.com/app/id<APP_ID>`
once the App ID exists and ship it in the first update.

---

## 8. App Privacy ("nutrition labels")

**Answer: "Data Not Collected."**

AI grouping — the only code path that ever transmitted anything — is compiled out
of the iOS build for 1.0 (`src/featureFlags.js`, `AI_GROUPING_ENABLED = false` on
iOS). Nothing else in the app makes a network request, so the iOS binary has no
data-collection surface at all:

- The LLM key UI is hidden in Settings and on the Groups screen.
- `proposeContactGroups` is pinned to the on-device heuristic path, so the
  Gemini / OpenAI / OpenRouter calls are unreachable even if a UI entry point
  were missed. Grouping still works — it just runs locally.
- Contacts, call records, and notes never leave the device.

Answer **No** to "Used for Tracking" throughout — there is no ATT prompt and no
`NSUserTrackingUsageDescription`, which is correct.

`PrivacyInfo.xcprivacy` already declares `NSPrivacyCollectedDataTypes` as an empty
array and `NSPrivacyTracking` as false. That now matches the nutrition labels
exactly — no change needed.

> **When you re-enable AI grouping (1.1+):** flip `AI_GROUPING_ENABLED`, then you
> must also switch the labels to **Contacts → Name · Collected · Not linked · Not
> for tracking · App Functionality**, add a matching `NSPrivacyCollectedDataTypes`
> entry, and describe the third-party transmission in the privacy policy. Shipping
> the feature without those is a Guideline 5.1.1 problem.

---

## 9. Age rating

Run the questionnaire; answer **No** to all violence/sexual/gambling/horror/drugs
categories. Expected result: **4+**.

There's no user-generated content, no chat, and no web browsing, so none of the
UGC follow-up questions apply.

---

## 10. App Review notes (paste into "Notes" on the submission)

```
Connect helps people keep in touch with contacts they haven't spoken to in a while.

NO SIGN-IN REQUIRED
There is no account system. Launch the app and the full feature set is available.

PERMISSIONS
• Contacts (NSContactsUsageDescription) — read-only, used to build the user's circle.
  The app never modifies, deletes, or uploads contacts. If you decline the prompt,
  the app still runs; you can add people manually to see the rest of the features.
• Notifications — optional. A local daily reminder suggesting someone to call, scheduled
  on the device and switchable in Settings. No push server is involved.

FIRST RUN
Tap "Get started", allow Contacts, pick a few people, then choose roughly when you last
spoke to each. With at least 3 people answered, the Reconnect card appears on Home.

HOW THE RECONNECT ENGINE GETS ITS DATA ON iOS
iOS provides no access to the system call history, so Connect does not attempt to
read it. Instead it records the calls the user places from inside the app, using
CXCallObserver to detect when the call connects and ends (CallObserverModule.m).
Users can also add past calls manually. The reconnect suggestions are derived from
that on-device record. Nothing is uploaded.

BACKGROUND TASK
When the user taps to call, the app begins a short UIApplication background task so
CXCallObserver can report the call's duration after the system Phone app takes over.
It ends as soon as the call ends (typically well under 30 seconds). It is not used
for any background processing beyond recording call duration.

AUTO-CATEGORISATION
Groups can be filled in automatically. On iOS this runs entirely on-device using
local heuristics — no network request is involved and no key is required.

PRIVACY
This build makes no network requests at all. No accounts, no analytics, no ads, no
third-party trackers, and no backend of any kind. All user data stays in on-device
storage and can be exported or deleted from Settings. The App Privacy answer is
"Data Not Collected", which reflects the binary exactly.
```

---

## 11. Submission flow

1. **Apple Developer** → confirm the paid membership is active and agreements are
   signed (App Store Connect → Business → Agreements, Tax, and Banking → *Free Apps*
   agreement must show **Active**, or the app can't be distributed).
2. **Certificates, Identifiers & Profiles** → register the App ID `tech.navlakha.connect`
   (Xcode's automatic signing will do this for you on first archive).
3. **App Store Connect → My Apps → +** → New App → iOS → name, language, bundle ID, SKU.
4. Fill **App Information** (§1), **Pricing** (Free), **App Privacy** (§8), **Age Rating** (§9).
5. Fill the **1.0 version page**: promo text (§3), description (§4), keywords (§5),
   screenshots (§6), support URL, copyright, review notes (§10).
6. **Upload the build:**
   ```bash
   # archive
   xcodebuild -workspace ios/connect.xcworkspace -scheme connect \
     -configuration Release -destination 'generic/platform=iOS' \
     -archivePath build/Connect.xcarchive archive -allowProvisioningUpdates

   # export
   xcodebuild -exportArchive -archivePath build/Connect.xcarchive \
     -exportPath build/ipa -exportOptionsPlist ios/ExportOptions.plist \
     -allowProvisioningUpdates

   # upload (needs an App Store Connect API key in ~/.appstoreconnect/private_keys/)
   xcrun altool --upload-app -f build/ipa/connect.ipa -t ios \
     --apiKey <KEY_ID> --apiIssuer <ISSUER_ID>
   ```
   Or simply: Xcode → Product → Archive → Distribute App → App Store Connect.
7. Wait ~10–30 min for processing, attach the build to the 1.0 version, then
   **Add for Review** → **Submit**.

> Build note: the Android screenshots came from a debug build with seeded demo data.
> The iOS release build must go through the real onboarding flow — `devSeed` is gone,
> so seed the simulator with realistic fake contacts by hand before capturing.
