# User Reports Inbox — insamling pågår

Rå insamling av rapporter från användare: diagnostikloggar, e-post, forumtrådar
(Homey Community), GitHub-issues. Inget är analyserat eller prioriterat ännu —
det här är bara råmaterialet.

**Status:** ✅ Insamling avslutad 2026-08-17. Åtgärdsplanen finns i
[`docs/USER_REPORTS_PLAN.md`](./USER_REPORTS_PLAN.md).

**Insamling startad:** 2026-08-17 · **Antal rapporter:** 13 (R1–R12, plus R13 tillagd 2026-09-06)

---

## Innehållsförteckning

| # | Källa | Datum | Kort beskrivning | App-version |
|---|-------|-------|------------------|-------------|
| [R1](#r1--diagnostik--triggerkort-startar-inte-nästa-task-mowern-åker-till-laddstationen) | Diagnostik (manuellt inskickad) | 2026-07-20 | Triggerkort "klippt klart" startar inte task 2 — mowern åker till laddstationen istället | v2.5.59 |
| [R2](#r2--förfrågan--kamerabild-i-error-push) | Meddelande från användare | — | Önskemål: bifoga kamerabild från klipparen i en error-push | — |
| [R3](#r3--uppföljning-på-r1--workaround-med-pause--fördröjning-fungerar) | Meddelande från användare (samma som R1/R2) | — | Workaround: `Pause mowing` + 20 s fördröjning före nästa task fungerar. Frågar om det är rätt upplägg, erbjuder loggar från riktig klippning | — |
| [R4](#r4--uppföljning--parningstext-och-task-taggning-på-triggerkortet) | Meddelande från användare (samma som R1–R3) | — | Två önskemål: (a) text vid parning om att det kan ta en stund innan klipparen hittas, (b) tagga vilken task som avslutades på `Mower finished a mowing job` för jobbkö | — |
| [R5](#r5--diagnostik--snabba-statusväxlingar-charging--paused-och-enheter-går-offline) | Diagnostik (manuellt inskickad) | 2026-07-23 | Snabba statusväxlingar (charging/paused/charging/paused) och enheter går offline. Aliyun-budget slut, BLE-fel #243–245, `getRegion failed: code=500` | v2.5.56 |
| [R6](#r6--förslag--skicka-klipparen-till-en-specifik-geopunkt) | App Store-förslag via Homey | 2026-08-17 | Önskemål: kunna skicka klipparen till en specifik geopunkt, t.ex. vid rörelse i carporten — som en del av bevakning | — |
| [R7](#r7--diagnostik--status-uppdateras-inte-aliyun-rate-limit-och-gateway-error-29004) | Diagnostik (manuellt inskickad) | 2026-08-04 | "Status do not update". Poll rate-limitad av Aliyun i oändlig loop (failure #1374), gateway error 29004, BLE hittar 0 advertisements | v2.5.56 |
| [R8](#r8--diagnostik--inga-statusuppdateringar-alls-trots-att-båda-klipparna-jobbar) | Diagnostik (manuellt inskickad, samma användare som R5) | 2026-08-05 | Inga statusuppdateringar alls under dagen fast båda klipparna jobbar. Budget fortfarande fast på 90, `registerAliyunDevice failed: code=500` | v2.5.56 |
| [R9](#r9--förslag--ställbart-avstånd-mellan-klippbanor-channel-width) | App Store-förslag via Homey | 2026-08-17 | Vill kunna ställa avstånd mellan klippbanor. Kör 8 cm i Mammotion-appen, men Homey-appen väljer 12 cm | — |
| [R10](#r10--diagnostik--fel-1417-i-mammotions-egen-app-klippare-startar-inte) | Diagnostik (manuellt inskickad) | 2026-08-11 | Fel 1417 i Mammotions **egen** app vid varje startförsök. Homey skickar `generate_route`+`start` om och om igen, mowern går mowing→paused→idle | v2.5.56 |
| [R11](#r11--diagnostik--luba-3-delad-till-andrakonto-syns-inte-vid-homey-parning) | Diagnostik (manuellt inskickad) | 2026-08-15 | Luba 3 delad till sekundärkonto syns och styrs i Mammotion-appen, men inga enheter visas vid Homey-parning. `owned=0 records=1` | v2.5.56 |
| [R12](#r12--forumtråd--homey-community-2026-07-26--2026-08-15) | Homey Community-forum | 2026-07-26 → 2026-08-15 | Sju inlägg: task/schema-krock, saknade tasks, resume-kort, utebliven status efter firmwareuppdatering, zonval för Yuka, Luba mini utan status, Luba 1-stöd, Luba 3-parning | v2.5.56 |
| [R13](#r13--app-store-rapport--klipparen-kör-samma-mönster-på-lägsta-höjd) | App Store-förslag via Homey | 2026-09-06 | Vill köra sina sparade tasks. Generisk start ger alltid samma mönster på lägsta klipphöjd — användaren lyfter själv risken att klippa för kort | — |

> **Notis om personuppgifter:** det här dokumentet ligger i ett publikt repo. Namn har
> förkortats och e-postadresser maskerats. Fullständiga uppgifter finns i originalkällan
> (Homeys diagnostik-inkorg respektive App Store-förslagen).

---

<!-- Nya rapporter läggs till nedan, en per ## -rubrik, i den ordning de kommer in. -->

## R1 — Diagnostik — triggerkort startar inte nästa task, mowern åker till laddstationen

**Källa:** Homey diagnostikrapport, manuellt inskickad av användare
**Log ID:** `087258b1-d66f-43cd-b16b-146d2f5f0c55`
**Loggens tidsspann:** 2026-07-20 21:16–21:42 UTC
**App-version:** v2.5.59
**Homey-firmware:** v13.4.0-rc.6
**Homey-modell:** Homey Pro (Early 2023) — `homey5q`
**Device ID:** `c62cf2de-fba6-4166-afb5-5fd7ce1f768b`
**Mower:** Luba 2 (`Luba-VATBJL64`), BLE MAC `6cd5520b5552`, deviceId `4EQxAgN5L3xR1HpspUNxvpa7Xe`
**Mower-firmware:** `2.3.27.20` (MCU `5.1.2.2809`, GNSS UM960E `25385`, X5 MidWare `6.0.0.386`)

### Användarens egna ord (ordagrant)

```
alla task fanns nu
startade task 1
triggerkort när den klippt klart, starta task 2
startar ej task 2 utan kör till laddstationen
```

### Miljö enligt telemetrin

- **Nätverk:** mowern kör över mobilnät (`linkType: 3`, `usedNet: 1`, LTE-modem EC200A,
  operator 24008 / Telenor SE, `mnetRssi` −63…−69). WiFi-RSSI ligger på **−78…−88 dBm**
  under klippningen, dvs. i praktiken utanför räckhåll, och stiger till −58 först när
  mowern närmar sig laddstationen.
- **RTK:** `status: 4`, `posLevel: 1`, 35–39 GPS-satelliter — bra fix hela vägen.
- **Zoner (8 st):** Baksida hus `455397280968893214`, våran äng `846511490366652149`,
  Kortsidan mot Ivan `2373291065508953062`, mellan bro å uppfart `3283318388993397894`,
  garagetält `5032808759549717382`, Brevlåda `5204327171181430349`, hjärtäng
  `8013794177423212063`, sandra skogen `8620773569458201394`.
- **Underhållsdata:** 65 batterycykler, blad 71,2 h (`bladeUsedTime 256456` av
  `bladeUsedWarnTime 360000`), 168,9 km, 162,6 h drifttid.

### Tidslinje (app-nivåhändelser, ordagrant)

```
21:16:09 → 21:22:27  [err] Poll sync failed: Mammotion invoke request timed out after 8000ms  (×14)
21:31:46 → 21:33:04  [err] Poll sync failed: ... timed out after 8000ms                       (×5)

21:33:19  telemetry: sysStatus=13 (mowing), progress≈28 %, battery 95 %, wifi −87, area 1703951
21:33:21  Zones: <8 zoner listade>  (toappAllHashName)
21:33:25  [mqtt] telemetry changed: progress=28 wifi=-85 [skewIfSeconds=7s]
21:33:30  [mqtt] telemetry changed: progress=31 gps=39 speed=-0.11
21:33:33  [update_buf] device reported systemUpdateBuf=[3,0,1,8,2]
21:33:35  nav.coverPathUpload pathHash=6806655667893296693 totalPathNum=2 validPathNum=1
21:33:39  [ManagerBLE] connection failed: Could not connect to peripheral 6cd5520b5552
21:33:39  [BLE] BLE: connect failed / BLE: disconnected (active was mqtt)
21:33:39  [BLE] BLE: scheduling reconnect in 240s (failure #4)
21:33:55  [mqtt] telemetry changed: progress=37 wifi=-88
21:33:55  nav.bidireReqconverPath  jobId=17845348865978272 jobMode=4 subCmd=2 edgeMode=0
          knifeHeight=70 channelWidth=22 UltraWave=10 channelMode=0 toward=64 speed=0.6
          pathHash=8913521363695530063 towardMode=2 towardIncludedAngle=26
          zoneHashs=[5032808759549717382, 0 ×99]
21:34:00  [mqtt] telemetry changed: progress=39
21:34:06  [mqtt] telemetry changed: progress=40 elapsed=4
21:34:11  [mqtt] telemetry changed: progress=41 left=3
21:34:16  [mqtt] telemetry changed: progress=45
21:34:29 → 21:38:48  [err] Poll sync failed: ... timed out after 8000ms  (×20, var ~13:e sekund)

21:35:43  MQTT: offline
21:35:43  Transport switch: mqtt → none
21:37:14  Transport switch: none → mqtt
21:37:14  [mqtt] telemetry changed: battery=93 progress=95 wifi=-83 elapsed=7 left=1
21:37:49  [BLE] BLE: cached UUID not found, falling back to full scan
21:37:49  [BLE] BLE: scan found 22 BLE advertisements
21:37:49  [BLE] BLE: device Luba-VATBJL64 not found in scan
21:37:49  [BLE] BLE: scheduling reconnect in 240s (failure #5)
21:37:52  MQTT: offline
21:37:52  Transport switch: mqtt → none
21:38:47  Transport switch: none → mqtt
21:38:47  [mqtt] telemetry changed: progress=99 wifi=-79 gps=37 elapsed=8 left=0
          [skewIfSeconds=40s]
21:38:47  MQTT: offline
21:38:47  Transport switch: mqtt → none
21:38:49  mul.setAudio{auLanguage:0}  (msgtype 249, sender 21)
21:38:49  Transport switch: none → mqtt
21:38:49  [mqtt] telemetry changed: battery=92 status=returning(14,charge=0) progress=100
          wifi=-78 gps=38 speed=0.29 sensorStatusRaw=1 bladeActive=false
          ← sysStatus 13 → 14, lastStatus=13, cutterWorkModeInfo{currentCutterMode:2, rpm:0}
21:38:50  Zones: <samma 8 zoner>  (toappAllHashName ×2 i rad)
21:38:52  [err] [MQTT] protobuf decode failed: index out of range: 31 + 10 > 31
21:38:55  telemetry: zoneHash byter till 6147089372010075918 (ej i den namngivna zonlistan)
21:39:00  [update_buf] systemUpdateBuf=[3,0,1,8,5]
21:39:00  [update_buf] systemUpdateBuf=[1,17,0,90,0,113282860,33979166,1010,-2720,1,0,0,2,
          -269340007,0,-160000002,-80000001]
21:39:05  telemetry: zoneHash 3283318388993397894 ("mellan bro å uppfart"), fortsatt sysStatus 14
21:39:05  [mqtt] telemetry changed: cycles=65 blade=71.2h distance=168.9km worktime=162.6h
21:39:10  [mqtt] telemetry changed: wifi=-58 ble=-90 gps=38
21:41:59  [BLE] BLE: scan found 24 BLE advertisements
21:41:59  [BLE] BLE: device Luba-VATBJL64 not found in scan
21:41:59  [BLE] BLE: scheduling reconnect in 960s (failure #6)
```

### Råa observationer ur telemetrin (ingen tolkning, bara vad som står)

- `work.progress` i råprotokollet går `262151 → 262152 → 196615 → 65544 → 8`, medan
  app-nivåns `progress`-capability rapporteras som 28 → 31 → 37 → … → 99 → 100 %.
- `work.pathHash` byter flera gånger under passet: `613927167155397436` →
  `660728003081644689` → `159106096271050471` → `8176616966891122280` →
  `2311180875277142641` → `0` (vid `sysStatus 14`).
- `work.cutterWidth` växlar mellan `0.4` och `-1` mellan på varandra följande rapporter.
  `manRunSpeed` växlar mellan positiva och negativa värden (`29`, `-11`, `12`, `-21`).
- Varje `[mqtt] telemetry changed`-rad bär `[diagnostic; skewIfSeconds=7–40s
  skewIfMs≈1782798…ms]` — dvs. `sysTimeStamp` tolkad som ms ger ~1,78e12 ms skew,
  tolkad som sekunder ger 7–40 s.
- Transport-flapp: `mqtt → none → mqtt` tre gånger på fem minuter (21:35–21:39).
- BLE-backoff eskalerar 240 s → 240 s → 960 s (failure #4, #5, #6). Enheten syns
  aldrig i scannen (22 respektive 24 advertisements hittade, men inte `Luba-VATBJL64`).
- Ett enskilt protobuf-avkodningsfel: `index out of range: 31 + 10 > 31` (21:38:52).

### Vad som INTE finns i loggen

- Inga rader från Flow-motorn: varken att triggerkortet "mower finished mowing" /
  "klippt klart" fyrades av eller att åtgärdskortet för task 2 anropades.
- Ingen `start_mow` / `bidireReqconverPath` utgående efter att `sysStatus` gick till 14.
- Ingen felrad kring själva Flow-anropet.

_(De repetitiva `[debug] received:`-raderna med `toappReportData` var ~5:e sekund och de
identiska `toappGetCommondataAck`-paketen är sammanfattade ovan i stället för att
återges ordagrant — samtliga skiljande fält är extraherade. Den fullständiga råloggen
finns hos Homey under Log ID ovan.)_

---

## R2 — Förfrågan — kamerabild i error-push

**Källa:** Meddelande från användare
**Samma användare som:** [R1](#r1--diagnostik--triggerkort-startar-inte-nästa-task-mowern-åker-till-laddstationen), [R3](#r3--uppföljning-på-r1--workaround-med-pause--fördröjning-fungerar) (mower `Luba-VATBJL64`)

### Användarens egna ord (ordagrant)

```
Hej, Har du några funderingar att koppla kameran på klipparen till appen?
Skulle göra en error-push och skulle vara najs att skicka med en bild från kameran samtidigt =)
Om inte ordnar jag det på annat sätt =)

La upp flow såhär:  (Se bild)

Sen har jag separat flow där jag ställer när och vad som ska trigga flow.
```

_(Meddelandet inkom två gånger; den andra gången med den avslutande meningen om separat
schemaflöde tillagd. Sammanslaget här.)_

### Bifogad skärmbild — Advanced Flow (kedjade klippjobb)

Skärmbilden visar en Homey Advanced Flow med tre grenar. Kort transkribering av korten:

**Gren 1 (manuell start):**
`This Flow is started with a Yes/No-tag` → `Luba-VATBJL64 · Start mowing task Framsida stripes`

**Gren 2:**
`Luba-VATBJL64 · Mower finished a mowing job` → `Logic: Task is exactly Framsida stripes` → två utgångar:
- `Luba-VATBJL64 · Pause mowing`
- `20 sec` (fördröjning) → `Luba-VATBJL64 · Start mowing task Kortsida mot Ivan stripe`

**Gren 3:**
`Luba-VATBJL64 · Mower finished a mowing job` → `Logic: Task is exactly Kortsida mot Ivan stripe` → två utgångar:
- `Luba-VATBJL64 · Pause mowing`
- `20 sec` (fördröjning) → `Luba-VATBJL64 · Start mowing task Baksida stripes`

Anmärkning: triggerkortet `Mower finished a mowing job` exponerar en `Task`-token som
användaren matchar mot i Logic-kortet. Enhetsnamnet visas som `Luba-VATBJL64 - b0nd3n3`.

### Öppen fråga att besvara i planfasen

- Går det att exponera kameraströmmen/en stillbild från klipparen som en Homey-image-token
  som kan bifogas i en push? (Kamera/Agora WebRTC ligger i fas 7 enligt `CLAUDE.md`.)

---

## R3 — Uppföljning på R1 — workaround med Pause + fördröjning fungerar

**Källa:** Meddelande från användare
**Samma användare som:** [R1](#r1--diagnostik--triggerkort-startar-inte-nästa-task-mowern-åker-till-laddstationen), [R2](#r2--förfrågan--kamerabild-i-error-push) (mower `Luba-VATBJL64`)

### Användarens egna ord (ordagrant)

```
Detta funkar =) Man får väl optimera tiderna i framtiden. Är detta samma upplägg som du tänker
eller har du andra tankar hur man kan göra? Kan skicka loggar sen om du vill då jag kör en
riktig klippning.
```

### Bifogad skärmbild — Advanced Flow (testuppsättning som fungerar)

**Gren 1 (schemalagd start):**
`Date & Time: The time is 22:24` → `Luba-VATBJL64 · Start mowing task test task1 garagetält`

**Gren 2:**
`Luba-VATBJL64 · Mower finished a mowing job` → `Logic: Task is exactly test task1 garagetält`
→ två utgångar från samma nod:
- `10 sec` (fördröjning) → `Luba-VATBJL64 · Pause mowing`
- `20 sec` (fördröjning) → `Luba-VATBJL64 · Start mowing task test task2 stripe ivan`

Skillnad mot skärmbilden i R2: `Pause mowing` ligger nu bakom en **10 s** fördröjning
(inte direkt på Logic-kortet), och nästa task startar efter **20 s**. Det är den varianten
användaren rapporterar som fungerande.

### Fakta att bära med till planfasen

- Direkt `Start mowing task` efter `Mower finished a mowing job` startar **inte** nästa
  task (R1) — mowern går till laddstationen.
- Sekvensen `Pause mowing` (efter 10 s) + `Start mowing task` (efter 20 s) **fungerar**.
- Användaren erbjuder sig att skicka diagnostiklogg från en riktig klippning med det
  fungerande flödet. **Ej inhämtad ännu.**

### Öppna frågor att besvara i planfasen

- Är Pause + fördröjning det upplägg vi vill rekommendera, eller ska appen själv hantera
  övergången (t.ex. kö av tasks, eller att `start_mow` implicit stoppar pågående
  return-to-dock)?
- Vilka tider behövs egentligen — går de att fastställa, eller är de fältberoende?
- Bör vi be om loggen från den fungerande körningen som referens mot R1?

---

## R4 — Uppföljning — parningstext och task-taggning på triggerkortet

**Källa:** Meddelande från användare
**Samma användare som:** R1–R3 (mower `Luba-VATBJL64`)
**Refererar till Log ID:** `087258b1-d66f-43cd-b16b-146d2f5f0c55` (= samma logg som [R1](#r1--diagnostik--triggerkort-startar-inte-nästa-task-mowern-åker-till-laddstationen))

### Användarens egna ord (ordagrant)

```
087258b1-d66f-43cd-b16b-146d2f5f0c55

efter man lägger in user och pass
kan vara bara bra att det står att det kan ta en stund innan klipparen hittas (när man lagt in user/pass)

mower finished a mower job, vore bra om man kunde tagga vilken task den gjorde så kan ha många jobb i kö och den
```

_(Sista meningen är avhuggen i originalet.)_

### Bifogad skärmbild — Advanced Flow (minimal variant, utan Pause/fördröjning)

**Gren 1 (schemalagd start):**
`Date & Time: The time is 23:30` → `Luba-VATBJL64 · Start mowing task test task1 garagetält`

**Gren 2:**
`Luba-VATBJL64 · Mower finished a mowing job` → `Luba-VATBJL64 · Start mowing task test task2 stripe ivan`

Ingen `Logic`-nod, ingen `Pause mowing`, ingen fördröjning. Detta är alltså den variant
som motsvarar felbeskrivningen i R1 (task 2 startar inte, mowern åker till laddstationen),
till skillnad från R3:s variant med Pause + 10/20 s fördröjning som fungerar.

### Två konkreta önskemål

1. **Parningsflödet:** visa en text efter att användaren angett användarnamn/lösenord om
   att det kan dröja innan klipparen hittas.
2. **Triggerkortet `Mower finished a mowing job`:** tagga vilken task som avslutades, så
   att man kan köa flera jobb.

### Öppna frågor att besvara i planfasen

- Önskemål 2 ser ut att redan finnas: skärmbilderna i R2 och R3 visar en `Task`-token från
  just det triggerkortet, som användaren matchar mot i ett Logic-kort. Är önskemålet då
  (a) upptäckbarhet/dokumentation, (b) något som saknas i en viss app-version, eller
  (c) något mer, t.ex. en riktig jobbkö i appen? **Behöver klarläggas med användaren.**
- Vilken exakt formulering och var i parningsflödet ska väntetexten ligga? Berör
  `drivers/luba/pair/*` och samtliga 13 språk i `locales/`.

---

## R5 — Diagnostik — snabba statusväxlingar (charging/paused) och enheter går offline

**Källa:** Homey diagnostikrapport, manuellt inskickad av användare
**Log ID:** `537eaf78-212d-4d80-a284-f93b2c2c5e21`
**Loggens tidsspann:** stdout 2026-07-23 18:21–19:35 UTC, stderr 2026-07-19 → 2026-07-23
**App-version:** v2.5.56
**Homey-firmware:** v13.3.0
**Homey-modell:** Homey Pro (Early 2023) — `homey5q`
**Annan användare än R1–R4** (två mowers på samma konto)

**Enheter:**
| Device ID | Mower |
|---|---|
| `a9ad8707-aa02-4711-ad28-7548c1529416` | `Luba-MNJR4AS3` |
| `bb498b9b-688f-4d49-80f3-ec8c231c204f` | `Luba-VPB9JXRA` |

### Användarens egna ord (ordagrant)

```
Får fortfarande snabba status-uppdateringar (charging, paused, charging, paused) samt de blir offline.
```

Ordet "fortfarande" antyder att detta rapporterats tidigare. **Tidigare tråd/rapport ej
inhämtad — behöver letas upp.**

### Dominerande mönster i stdout

Nästan varje rad i hela loggen (18:21–19:35, ~75 min) är någon av dessa två:

```
Poll: skipping — account-wide Aliyun request budget nearly exhausted (90 left in the current 12h window)
```

- Loggas för **båda** enheterna, växelvis. `a9ad8707` var ~120:e sekund,
  `bb498b9b` var ~120:e sekund, förskjutna ca 80 s från varandra.
- Antalet kvarvarande requests står **konstant på `90`** under hela loggen — det räknas
  aldrig ner och aldrig upp under de 75 minuterna.

```
[BLE] BLE: scan found N BLE advertisements
[BLE] BLE: device Luba-XXXXXXXX not found in scan
[BLE] BLE: scheduling reconnect in 1800s (failure #NNN)
```

- Fyra scanrundor i loggen: 18:34 (#243), 19:04 (#244), 19:34 (#245) — plus båda
  enheterna scannar samtidigt, inom samma millisekund.
- 19–22 advertisements hittas varje gång, men aldrig någon av de två mowrarna.
- Backoff ligger fast på 1800 s. Räknaren har alltså nått **#243–245** — flera dygns
  misslyckade återanslutningar.

### Transport-händelser (samtliga i loggen)

```
18:31:29  a9ad8707  [Aliyun] offline
18:31:29  a9ad8707  Transport switch: aliyun_legacy → none
18:39:48  a9ad8707  Transport switch: none → aliyun_legacy
18:39:48  a9ad8707  [aliyun_legacy] telemetry changed: battery=100 gps=24
                    [skewIfSeconds=204403s skewIfMs=1783047360992ms]
18:59:35  a9ad8707  [aliyun_legacy] telemetry changed: wifi=-77       [skewIfSeconds=204562s]
19:08:24  bb498b9b  [aliyun_legacy] telemetry changed: battery=100 gps=28 [skewIfSeconds=204604s]
19:30:36  a9ad8707  [aliyun_legacy] telemetry changed: wifi=-75 gps=26  [skewIfSeconds=204831s]
```

- Under 75 minuter kommer **fyra** telemetriuppdateringar totalt, för två enheter.
- `skewIfSeconds` ligger på **~204 400–204 800 sekunder ≈ 56,8 timmar** och växer
  monotont genom loggen. (Jämför R1, där samma diagnostik gav 7–40 s.)
- Transporten är `aliyun_legacy`, inte `mqtt` som i R1.

### stderr — hela innehållet (14 rader, 2026-07-19 → 2026-07-23)

```
[Aliyun credentials] Aliyun credentials refresh failed: getRegion failed: code=500
```

Tidsstämplar: 07-19 07:43/07:44/07:45 · 07-20 07:46/07:46/07:48 · 07-21 07:49/07:50/07:51
· 07-22 07:52/07:52 · 07-23 07:53/07:54/07:55.

- Inträffar **en gång per dygn, alltid ca 07:43–07:55 UTC**, i grupper om 2–3 försök,
  och tidpunkten kryper framåt ~1 minut per dag.
- Inga andra fel i stderr under hela femdagarsperioden.

### Observationer utan tolkning

- Den rapporterade symptomen (snabb växling charging ↔ paused) syns **inte** i den här
  loggens telemetrirader — de fyra uppdateringarna innehåller bara battery/gps/wifi,
  ingen statusändring. Loggfönstret kan ha missat händelsen.
- Ingen `MQTT`-transport nämns alls; enheterna kör `aliyun_legacy`.
- Båda enheterna delar samma Aliyun-budget ("account-wide") och båda pollar var 120:e
  sekund trots att varje poll hoppas över.

### Öppna frågor att besvara i planfasen

- Varför står budgeten still på `90`? Är fönstret på 12 h aldrig återställt, eller läses
  värdet från ett cachat svar?
- Hur relaterar den skippade pollningen till de rapporterade snabba statusväxlingarna —
  är det stale-data som studsar mellan två cachade värden?
- `getRegion failed: code=500` en gång per dygn på fast klockslag: serversidans
  underhållsfönster, eller vår egen refresh-schemaläggning?
- BLE-failure #245 med 1800 s backoff: bör räknaren/backoffen nollställas någon gång,
  och bör användaren informeras när BLE varit nere i dagar?
- Var finns den tidigare rapporten som "fortfarande" refererar till?

---

## R6 — Förslag — skicka klipparen till en specifik geopunkt

**Källa:** App Store-förslag, vidarebefordrat via Homeys notismejl
**Inkom:** 2026-08-17
**Från:** Marcus I. (fullständigt namn i Homeys förslagsinkorg)

### Användarens egna ord (ordagrant)

```
Möjlighet att skicka enheten till en specifik geopunkt. Jag skulle då köra ett flöde som
aktiveras när det är rörelse i vår carport och då låta klipparen köra dit för att "säga hej".
Se det som en del i övervarkning.
```

### Vad som efterfrågas

- Ett Flow-actionkort: "kör till punkt (X, Y)" — inte en zon, utan en godtycklig koordinat.
- Användningsfall: rörelsedetektor i carporten triggar ett flöde som skickar klipparen dit.
  Användaren beskriver det som en del av bevakning/övervakning.

### Öppna frågor att besvara i planfasen

- Finns det ett "goto point"-kommando i protokollet, eller är navigering begränsad till
  zoner/jobb? (Behöver undersökas mot `pymammotion`.)
- Hur ska en punkt anges i Homey-UI:t — RTK-koordinater, lat/long, eller punkter som
  användaren först sparat?
- Säkerhets- och ansvarsaspekt: att köra klipparen mot rörelse är inte en avsedd
  användning från tillverkaren. Bör vi bygga det, och i så fall med vilka varningar?

---

## R7 — Diagnostik — status uppdateras inte, Aliyun rate limit och gateway error 29004

**Källa:** Homey diagnostikrapport, manuellt inskickad av användare
**Log ID:** `b8926efe-41bb-460d-82b3-e42899fd8157`
**Loggens tidsspann:** stdout 2026-08-04 08:04–08:27 UTC, stderr 2026-07-15 → 2026-08-03
**App-version:** v2.5.56
**Homey-firmware:** v13.4.0
**Homey-modell:** Homey Pro (Early 2023) — `homey5q`
**Device ID:** `d362d922-f6e7-4f54-9322-13a3dc3864b1` — enhetsnamn "Geten", mower `Luba-VSTQBP9H`
**Aliyun-konto:** maskerat (`familjenwj@…` i originalloggen, rad `Repaired with account:`)
**Aliyun product key:** `a5vlvzwIhhj`, region `eu-central-1`

### Användarens egna ord (ordagrant)

```
Status do not update
```

### Dominerande mönster i stdout

Loopen `[Aliyun] sending command: requestSync` → `Poll: <fel> — next check in 60s` körs
en gång per minut genom hela loggen. Felet växlar mellan två varianter:

```
Poll: rate-limited by Aliyun — next check in 60s (failure #NNNN)
Poll: Aliyun gateway error (29004) — next check in 60s (failure #NNNN)
```

- **Räknaren står på #1368–#1374 när loggen börjar.** Vid 60 s per försök motsvarar det
  ungefär ett dygn av oavbrutna misslyckanden.
- Inte en enda lyckad poll i hela loggen. Ingen `telemetry changed`-rad förekommer.
- `29004` uppträder blandat med rate-limit, ungefär var tredje till fjärde försök.

### Två omstarter i loggen

**08:10:52 — appen startar om:**
```
[MammotionApp] Mammotion app initialized (v2.5.56)
LubaDevice Geten initializing (preference=auto)
startTransports: preference=auto transportKind=aliyun_legacy
[Aliyun] registered on shared transport
Poll: resuming a rate-limit cooldown from before restart — first check in 41s
[Aliyun] Aliyun MQTT connected / bind message sent
```
Nio topics prenumereras (`post_reply`, `wifi/status/notify`, `_thing/event/notify`,
`account/bind_reply`, `thing/properties`, `wifi/connect/event/notify`, `thing/events`,
`thing/model/down_raw`, `thing/status`).

Efter omstarten **nollställs failure-räknaren till #1** och backoffen börjar om på
20 s → 40 s → 60 s. Samma två fel återkommer omedelbart.

**08:25:50 — användaren kör "repair":**
```
Repaired with account: <maskerad>
Retrying all transports after repair
[Aliyun credentials] credentials refreshed, valid until 2026-08-05T04:25:59.403Z
Poll: resuming a rate-limit cooldown from before restart — first check in 41s
```
Trots färska credentials fortsätter felen direkt: 08:26:40 `gateway error (29004)`,
08:27:00 `rate-limited`.

### BLE

```
[BLE] BLE: cached UUID not found, falling back to full scan
[BLE] BLE: scan found 0 BLE advertisements
[BLE] BLE: device Luba-VSTQBP9H not found in scan
```

- **Noll advertisements** i varje scan — inte "hittade 20 men inte vår". Homeys
  BLE-radio ser ingenting alls.
- Backoff 30 s → 60 s → 120 s → 240 s → 240 s → 960 s (failure #1–#6), nollställd vid
  varje omstart.

### stderr — mönster över tre veckor (2026-07-15 → 2026-08-03)

| Fel | Förekomst |
|---|---|
| `getaddrinfo EAI_AGAIN a5vlvzwihhj.iot-as-mqtt.eu-central-1.aliyuncs.com` | 07-15 (kluster), 08-02 (kluster) |
| `getaddrinfo EAI_AGAIN eu-central-1.api-iot.aliyuncs.com` | 07-15, 08-02, 08-03 |
| `Aliyun credentials refresh failed: getRegion failed: code=500` | 07-29, 07-30 ×2, 07-31, 08-01, 08-02, 08-03 — alltid i grupper om 3 |
| `Poll sync failed: Aliyun request timed out after 6000ms` | 07-29, 07-30, 07-31, 08-01 ×5, 08-02 ×4 |
| `Aliyun MQTT error: Keepalive timeout` | 08-02 ×3 |
| `Aliyun MQTT bind rejected (code=2043)` | 08-02 ×3 |

`EAI_AGAIN` är DNS-uppslag som misslyckas — det pekar mot Homeys nätverk eller
DNS-server, inte mot vår kod.

### Öppna frågor att besvara i planfasen

- Vad betyder Aliyun-felkod **29004** exakt? Och **2043** vid bind?
- Räknaren nådde #1374 utan att appen gav upp, bytte strategi eller informerade
  användaren. Bör det finnas ett tak, en längre backoff, eller ett synligt felmeddelande
  i enhetsvyn efter N misslyckanden?
- Varför nollställs failure-räknaren vid omstart medan `resuming a rate-limit cooldown
  from before restart` antyder att kylperioden *är* persistent? Inkonsekvent state.
- "Repair" gav nya credentials men löste ingenting — är rate-limiten knuten till kontot
  snarare än till sessionen?
- `scan found 0 BLE advertisements` skiljer sig kvalitativt från R1/R5/R8 där 13–24
  hittades. Separat problem (BLE-radio nere på den Homeyn)?

---

## R8 — Diagnostik — inga statusuppdateringar alls trots att båda klipparna jobbar

**Källa:** Homey diagnostikrapport, manuellt inskickad av användare
**Log ID:** `97e6da56-7bbb-4ea5-ac4c-cdb4e3e391cb`
**Loggens tidsspann:** stdout 2026-08-05 06:53–07:48 UTC, stderr 2026-08-03 → 2026-08-05
**App-version:** v2.5.56
**Homey-firmware:** v13.4.0 (R5 hade v13.3.0)
**Homey-modell:** Homey Pro (Early 2023) — `homey5q`
**Samma användare och samma enheter som:** [R5](#r5--diagnostik--snabba-statusväxlingar-charging--paused-och-enheter-går-offline)

| Device ID | Enhetsnamn | Mower | BLE MAC |
|---|---|---|---|
| `a9ad8707-aa02-4711-ad28-7548c1529416` | Shaun | `Luba-MNJR4AS3` | `fc23cd7c98d9` |
| `bb498b9b-688f-4d49-80f3-ec8c231c204f` | YSS robot | `Luba-VPB9JXRA` | — |

### Användarens egna ord (ordagrant)

```
Status-uppdateringar fungerar väldigt dåligt, idag har jag tex inte fått någon alls fast båda jobbar.
```

### Uppföljning på R5 — vad som ändrats och inte

| | R5 (2026-07-23) | R8 (2026-08-05) |
|---|---|---|
| Homey-firmware | v13.3.0 | v13.4.0 |
| Budgetrad | `90 left in the current 12h window` | `90 left in the current 12h window` — **oförändrat värde 13 dagar senare** |
| Pollintervall | 120 s, enheterna förskjutna ~80 s | 120 s, **båda enheterna loggar på samma millisekund** |
| BLE failure-räknare | #243, #244, #245 | #100, #101 (lägre — har nollställts däremellan) |
| Telemetriuppdateringar | 4 st på 75 min | **0 st på 55 min** |
| Transport | `aliyun_legacy` | `aliyun_legacy` |

### BLE i den här loggen

Till skillnad från R5 **hittas** en av mowrarna den här gången:

```
07:19:36  a9ad8707  BLE: scan found 20 BLE advertisements
07:19:36  a9ad8707  BLE: found Luba-MNJR4AS3 (RSSI -93)
07:19:36  [BlePeripheral] [fc23cd7c98d9] Peripheral fc23cd7c98d9: connecting
07:20:13  [BlePeripheral] [fc23cd7c98d9] connection failed: Could not connect to peripheral
07:20:13  a9ad8707  BLE: disconnected (active was none)
07:20:13  a9ad8707  BLE: scheduling reconnect in 1800s (failure #100)
```

Anslutningsförsöket tar **37 sekunder** innan det ger upp. `Luba-VPB9JXRA` syns aldrig i
någon scan (13–23 advertisements hittas varje gång).

### Appomstart 07:46:30

```
[MammotionApp] Mammotion app initialized (v2.5.56)
LubaDevice Shaun initializing (preference=auto)
LubaDevice YSS robot initializing (preference=auto)
startTransports: preference=auto transportKind=aliyun_legacy   (båda)
BLE: found Luba-MNJR4AS3 via cached UUID (RSSI -88)
```

Efter omstarten görs tre BLE-försök mot `Luba-MNJR4AS3` (RSSI −88, −94), alla
misslyckas efter 20–23 s. Failure-räknaren nollställs till #1 och backoffen börjar om
på 30 s. **Inga `Poll: skipping`-rader alls efter omstarten** — pollningen verkar inte
ha kommit igång inom loggens sista 2 minuter.

### stderr

```
2026-08-03 07:50  [Aliyun credentials] refresh failed: getRegion failed: code=500
2026-08-03 07:50  bb498b9b  [Aliyun] registerAliyunDevice failed: getRegion failed: code=500
2026-08-03 07:50  a9ad8707  [Aliyun] registerAliyunDevice failed: getRegion failed: code=500
2026-08-03 07:52  [Aliyun credentials] refresh failed: getRegion failed: code=500
2026-08-04 07:53 / 07:54 / 07:55  [Aliyun credentials] refresh failed: getRegion failed: code=500
2026-08-04 08:05  bb498b9b  Poll sync failed: Aliyun request timed out after 6000ms
2026-08-04 11:09  a9ad8707 + bb498b9b  Poll sync failed: Aliyun request timed out after 6000ms
2026-08-05 07:46  [Aliyun credentials] refresh failed: getRegion failed: code=500
2026-08-05 07:46  a9ad8707 + bb498b9b  [Aliyun] registerAliyunDevice failed: getRegion failed: code=500
```

- `getRegion failed: code=500` fortsätter dygnsvis kring 07:50–07:55 UTC, precis som i R5
  (som hade 07:43–07:55). **Samma tidsfönster, två olika användare, tre veckors mellanrum.**
- Nytt jämfört med R5: felet slår nu även igenom som `registerAliyunDevice failed`, dvs.
  enheterna kan inte registreras alls — och det inträffar **exakt vid appstart 07:46:34**.

### Öppna frågor att besvara i planfasen

- Budgeten står på exakt `90` i både R5 och R8, 13 dagar isär, på samma konto. Är
  räknaren trasig, persistent lagrad utan återställning, eller läses den från ett svar
  som alltid returnerar 90?
- Om `registerAliyunDevice` misslyckas vid appstart — försöker appen någonsin igen, eller
  fastnar enheterna utan registrering till nästa omstart?
- BLE: en mower hittas men går inte att ansluta (37 s timeout, RSSI −88…−94), den andra
  syns aldrig. Två olika grundorsaker som båda hamnar i samma backoff-logik.
- Att båda enheterna nu pollar i exakt samma millisekund — förvärrar det rate-limiten?

---

## R9 — Förslag — ställbart avstånd mellan klippbanor (channel width)

**Källa:** App Store-förslag, vidarebefordrat via Homeys notismejl
**Inkom:** 2026-08-17
**Från:** Martin E. (fullständigt namn i Homeys förslagsinkorg)

### Användarens egna ord (ordagrant)

```
Kanonbra app! Det enda jag saknar är att man kan ställa in avstånd mellan klippbanor.
Jag brukar köra på 8 cm men av någon anledning när jag startar via din app på Homeyn
så väljer den default 12 cm
Med vänlig hälsning,
Martin
```

### Vad som rapporteras

1. Avstånd mellan klippbanor går inte att ställa in från Homey-appen.
2. När klippning startas via Homey används **12 cm**, trots att användaren kör **8 cm** i
   Mammotions egen app.

### Relaterade fakta i repot och i övriga rapporter

- `CLAUDE.md` dokumenterar `channel_width` i `StartMowOptions` som `5–35 cm, default 25`.
  Användaren rapporterar 12 cm — **stämmer varken med 25 eller med hans egna 8**.
- I [R1](#r1--diagnostik--triggerkort-startar-inte-nästa-task-mowern-åker-till-laddstationen)s
  logg visar `nav.bidireReqconverPath` att enheten faktiskt körde med `channelWidth: 22`.
  Ytterligare ett tredje värde.

### Öppna frågor att besvara i planfasen

- Var kommer 12 kommer ifrån? Hårdkodad default, felaktig enhet (mm/cm), eller ärvs
  värdet från något annat än användarens inställning?
- Ska `channel_width` exponeras som (a) parameter på Flow-actionkortet, (b) enhetsinställning,
  eller (c) båda — och ska appen istället läsa och återanvända mowerns eget sparade värde?
- Samma fråga gäller sannolikt övriga `StartMowOptions` (`blade_height`, `speed`,
  `channel_mode`, `rain_tactics`) — bör hanteras samlat, inte styckvis.

---

## R10 — Diagnostik — fel 1417 i Mammotions egen app, klippare startar inte

**Källa:** Homey diagnostikrapport, manuellt inskickad av användare
**Log ID:** `45d0c8c3-a423-4183-a8f1-9497ea66d10b`
**Loggens tidsspann:** stdout 2026-08-11 05:54–06:20 UTC, stderr 2026-08-09 → 2026-08-11
**App-version:** v2.5.56
**Homey-firmware:** v13.2.4
**Homey-modell:** **Homey Pro (Early 2019)** — `homey3d` (första rapporten från 2019-modellen)
**Device ID:** `1310dfe9-0907-409f-92db-fde7ee00e973`, mower `Luba-LAKZWD56`, BLE MAC `140a027bdd1b`
**Transport:** `mqtt`

### Användarens egna ord (ordagrant)

```
Jag får fel 1417 i Mammotion appen utanför Homey, varje gång jag försöker starta min klippare
antingen mot en zon eller om jag bara "aktiverar" den.
```

**Viktigt:** felet 1417 uppstår i **Mammotions egen app**, inte i Homey-appen. Loggen är
alltså insänd som kontext till ett problem som kanske ligger utanför vår kod.

### Zoner och schema

```
Zones: Backen(2888170610755110472), Slänt(4118593319985794593), Framsida(4635523089980977832),
       Baksida(7319018239694699107), Utsida(7344990239119767691)
Schedule [1/1] id=17859922618887078063 name="Klippning-1" 07:00- week=0 weeks=[3,5]
       dates=-..- blade=50mm speed=0.30000001192092896m/s
```

### Startsekvensen upprepas nio gånger på 26 minuter

Mönstret `generate_route` → `start` (båda med `{"code":0,"msg":"Request success"}`) skickas
vid: 05:56:15, 05:56:52, 05:57:52, 05:58:32, 05:59:38, 06:08:10, 06:10:13, 06:12:33,
06:17:11, 06:18:34, 06:20:02. Dessutom ett ensamt `start` redan 05:54:48.

**Alla kommandon får `code:0 Request success`** — molnet accepterar dem. Ändå:

```
05:56:24  status=mowing(13,charge=0)   left=35
05:56:30  speed=0.21
05:56:35  status=paused(19,charge=0)   speed=0
05:56:40  status=idle(11,charge=0)     left=36
...
05:57:07  status=mowing(13)  area=75  speed=0.16  left=37
05:57:44  status=returning(14)  speed=0.26
...
06:01:10  status=charging(11,charge=1)  left=26
```

Mowern går alltså **mowing → paused → idle** inom 16 sekunder, och senare
**mowing → returning → charging**. Efter 06:01 kommer inga fler statusändringar — bara
`wifi`/`sysTimeStampRaw` — trots att `generate_route`+`start` fortsätter skickas till 06:20.

### Övrigt i stdout

- `Skipping duplicate get_area_name_list command sent 1254ms after the previous one` och
  `...475ms after...` — dedupliceringen slår till, men `get_area_name_list` skickas ändå
  påfallande ofta (05:54:59, 05:55:01, 05:56:41, 05:56:43, 05:57:38, 05:57:41, 05:59:10,
  05:59:12).
- `systemUpdateBuf` växlar: `[3,0,1,2,5]` → `[3,0,1,1,2]` → `[3,0,1,1,5]` → `[3,0,1,5,2]`
  → `[3,0,1,5,5]` → `[3,0,1,4,5]`. Den långa varianten
  `[1,17,0,89,0,98918531,22567525,-89,-40,1,0,0,2,-243406189,0,0,0]` är konstant.
- `skewIfSeconds` är **1–2 s** här — alltså rimligt, till skillnad från R5/R8 (~56 h).
- BLE: `found Luba-LAKZWD56 via cached UUID (RSSI -85)` → `connection failed: BLE Timeout`
  efter 30 s → `scheduling reconnect in 1800s (failure #94)`.
- `ble`-värdet i telemetrin hoppar mellan `0`, `-70`, `-78`, `-94`, `-96`, `-100`, `-102`,
  `-106`. Värdet `0` verkar betyda "inget värde", inte 0 dBm.

### stderr — mönster 2026-08-09 → 2026-08-11

| Fel | Förekomst |
|---|---|
| `Poll sync failed: Mammotion invoke request timed out after 8000ms` | ~45 ggr, 08-09 och 08-10 |
| `[MQTT] MQTT error: Keepalive timeout` | 08-09 ×3 |
| `[MQTT] protobuf decode failed: index out of range: 41 + 10 > 41` | 08-09 |
| `[MQTT] protobuf decode failed: invalid wire type 6 at offset 35` | 08-10, 08-11 |
| `[MQTT] protobuf decode failed: invalid wire type 4 at offset 35` | 08-11 |
| `[MQTT] protobuf decode failed: index out of range: 42 + 10 > 42` | 08-11 |
| `Client network socket disconnected before secure TLS connection was established` | 08-10 22:31–22:39, många |
| `read ECONNRESET` | 08-10 ×3 |
| `connack timeout` | 08-10 |
| `connect ECONNREFUSED 8.211.50.191:3083` | 08-10 22:41–22:58, **~30 ggr** |
| `Initial rain-protection state read failed: No transport available for command: read_rain_protection` | 08-10, ~20 ggr |
| `Initial zone list read failed: No transport available for command: get_area_name_list` | 08-10, ~20 ggr |
| `Initial sync failed: Device Luba-LAKZWD56 is offline` | 08-10, ~20 ggr |

**08-10 22:29–23:00** är ett sammanhängande ~30-minuters haveri: MQTT-servern
`8.211.50.191:3083` vägrar anslutningar, och appen loopar en gång i minuten genom
`initial sync` → `rain protection` → `zone list`, alla misslyckade.

### Observationer utan tolkning

- Fyra olika protobuf-avkodningsfel på tre dagar. Två distinkta signaturer:
  `index out of range: N + 10 > N` (samma som i R1) och `invalid wire type X at offset 35`.
- `No transport available for command: …` loggas som fel även när orsaken redan är känd
  (MQTT nere) — tre fel per försök, en gång i minuten, i en halvtimme.
- Ingen retry-backoff syns på `initial sync`-loopen: exakt 60 s mellan varje försök.

### Öppna frågor att besvara i planfasen

- Vad är Mammotion-felkod **1417**? Om det är ett enhetsfel (t.ex. blockerad kniv,
  lyftsensor, RTK) — kan vi upptäcka och visa det i Homey istället för tyst
  mowing→paused→idle?
- Loggen visar att `start` accepteras av molnet men mowern ändå inte kör. **Vi har ingen
  återkoppling på om kommandot faktiskt utfördes.** Bör `start` verifieras mot efterföljande
  `sysStatus` och rapportera fel i Homey om körningen inte startar?
- Protobuf-avkodningsfelen: samma `+ 10 >` -signatur som R1. Trunkerad payload eller
  felaktig längdhantering i vår avkodare?
- `ECONNREFUSED 8.211.50.191:3083` — molnsidans avbrott, men vår logg spammar. Bör
  `No transport available`-felen dämpas när transporten redan är känt nere?
- Första rapporten från Homey Pro **2019** (`homey3d`). Något som är specifikt för den
  hårdvaran (BLE, minne, TLS)?

---

## R11 — Diagnostik — Luba 3 delad till andrakonto syns inte vid Homey-parning

**Källa:** Homey diagnostikrapport, manuellt inskickad av användare
**Log ID:** `35d61dfe-fa0d-4b5f-84de-248bc609d9f8`
**Loggens tidsspann:** 2026-08-13 01:49 → 2026-08-15 20:48 UTC
**App-version:** v2.5.56
**Homey-firmware:** v13.4.1-rc.3
**Homey-modell:** Homey Pro (Early 2023) — `homey5q`
**Mower:** `Luba-VA5W38CC` (**Luba 3**), `iotId=4ErGSfNpYF1uLdM5RdmL4bnViY`,
`productKey=uY54W5rM8YH`
**Konto:** maskerat (`renekemps@…` i originalloggen)

### Användarens egna ord (ordagrant)

```
LUBA 3 is shared to secondary Mammotion account. Visible and controllable in Mammotion app,
but no devices shown during Homey pairing.
```

Det här är precis det scenario som `CLAUDE.md` föreskriver för molntestning: dedikerat
andrakonto med mowern delad till sig.

### Kärnraderna — fyra parningsförsök, identiskt utfall

```
Authenticated: <maskerad>
list_devices: share invitations found=0 accepted=0
list_devices: owned=0 records=1 total=1 msg="Request success"
              {"owned":[],"records":[{"iotId":"4ErGSfNpYF1uLdM5RdmL4bnViY",
                                      "deviceName":"Luba-VA5W38CC",
                                      "productKey":"uY54W5rM8YH"}]}
list_devices: Aliyun connectivity check (api.link.aliyun.com) — OK after 1358ms
list_devices: legacy Aliyun probe — bound=0 shareNotifications=0 []
```

Upprepas 20:37:33, 20:38:35, 20:43:56, 20:48:30.

**Enheten finns i `records` men `owned` är tom.** Samtidigt returnerar den legacy
Aliyun-proben `bound=0 shareNotifications=0 []` — inga bindningar, inga delningsnotiser.
Trots det visas ingen enhet i parningsdialogen.

### Övriga observationer

- `share invitations found=0 accepted=0` — Mammotions delnings-API rapporterar noll
  inbjudningar, fast användaren uppger att delningen är genomförd och fungerar i appen.
- Vid 20:44:03 gav anslutningskontrollen `TIMEOUT after 5005ms`; vid övriga försök `OK`
  efter 1,3–1,9 s. Alltså inte konsekvent nätverksproblem.
- Första inloggningen loggas med versal: `Authenticated: Renekemps@…`, resten gemener.
  Användaren skrev tydligen adressen olika — utfallet blev identiskt.

### stderr — hela innehållet

```
probeLegacyAliyunDevices failed (attempt 1): Error: Aliyun request timed out after 6000ms
    at ClientRequest.<anonymous> (file:///app/lib/mammotion/aliyun/gateway.js:61:45)
    ...
```

Endast ett fel, "attempt 1" — retryn lyckades uppenbarligen (proben returnerade sedan
`bound=0`).

### Öppna frågor att besvara i planfasen

- **Varför visas ingen enhet när `records` innehåller en?** Filtrerar parningskoden på
  `owned` och ignorerar `records`? Det är den mest direkta ledtråden i hela loggen och
  bör verifieras mot `drivers/luba/driver.ts` först av allt.
- Är `productKey=uY54W5rM8YH` (Luba 3) känd av appen, eller filtreras okända productKeys
  bort?
- Delningsflödet: `share invitations found=0` trots aktiv delning — läser vi rätt endpoint,
  eller kräver delade enheter en annan väg (t.ex. Aliyun-bindning som andrakontot måste
  göra separat)?
- `bound=0` från legacy-proben på ett konto där appen fungerar: behöver enheten bindas
  till Aliyun-kontot innan den blir synlig, och kan appen i så fall trigga det?
- Berör detta alla delade enheter, eller specifikt Luba 3? Jämför med rapportörerna i
  R1–R10 som alla kör Luba 2.

---

## R12 — Forumtråd — Homey Community, 2026-07-26 → 2026-08-15

**Källa:** Homey Community-forumet, appens supporttråd
**Namn nedan är publika forumhandtag** och återges som de står.

### R12.1 — Esben, 26 juli — task i Homey vs. schema i Mammotion-appen

```
Thanks a lot @MathiasT for the work on getting the app to work - much appreciated.

I am trying to set up a flow which starts the mower at sunrise every second day.

Now I select "Start mowing 'Task 1' ".

However, this made me wonder: In the Mammotion smartphone app, the 'Task 1' is comprised of
mowing settings + a mowing schedule (currently 5 AM on certain weekdays).

If Homey initiates 'Task 1' - should I then deactivate 'Task 1' in the Mammotion smartphone
app - or what do I do to prevent the task being run in both the Mammotion smartphone app and
in Homey?
```

### R12.2 — Esben, 29 juli — svarar sig själv, två kvarstående frågor

```
OK, so I tested and realized that you can pause Tasks in the smartphone app - yet you can
still access those tasks in Homey.

This is great for running tasks via Homey while avoiding duplicated commands from the
Mammotion cloud.

I still haven't figured out how to get the Mammotion Homey App to see/list other tasks
besides "Task 1" (see my previous reply in this thread)?

I am almost done creating my initial cutting flow in Homey - however, now I wonder what flow
card to use, to get the robot to resume a cutting task?
```

**Tre punkter härifrån:**
1. *Löst av användaren själv:* pausa tasken i mobilappen så kör bara Homey den. **Bör
   dokumenteras** — det är en icke-uppenbar lösning som fler kommer att behöva.
2. **Bugg/brist:** bara "Task 1" listas i Homey, inte övriga tasks.
3. **Saknad funktion:** inget Flow-kort för att återuppta (resume) en pausad klippning.

### R12.3 — Westberg, 4 augusti — ingen status efter firmwareuppdatering

```
Hi Mathias, thanks for your great work! I updated my Luba 2 3000 (2024) with the new software
1.30.29.8 some days ago and now i do not get any update from the mower anymore.
I have tried to repair the connection and reboot the app, but still not update.
I made a diagnostic report : b8926efe-41bb-460d-82b3-e42899fd8157
```

**Detta är samma diagnostik som [R7](#r7--diagnostik--status-uppdateras-inte-aliyun-rate-limit-och-gateway-error-29004)**
(`b8926efe-41bb-460d-82b3-e42899fd8157`). R12.3 ger den kontext R7 saknade:

- Mower: **Luba 2 3000 (2024)**, enhetsnamn "Geten".
- Symptomet började **efter en firmwareuppdatering till 1.30.29.8**.
- Användaren har redan provat "repair" och omstart av appen — vilket loggen i R7 bekräftar
  (raden `Repaired with account:` 08:25:50) och som inte hjälpte.

#### Bifogad skärmbild — enhetsvyn för "Geten"

| Fält | Värde |
|---|---|
| Fel | Nej |
| Klipparstatus | Laddar |
| Klippframsteg | 0 % |
| Klippt yta | 61 m² |
| WiFi | **−77 dBm — "fem dagar sedan"** |
| Bluetooth-signal | 0 dBm |
| GPS-satelliter | 8 |
| Klipphastighet | 0 m/s |
| Förfluten tid / Återstående tid | 0 min / 0 min |
| Anslutningstyp | **Frånkopplad** |
| Senast uppdaterad | **2026-07-30 05:46:53** |
| RTK-position | RTK Float |
| Batterycykler | 338 |
| Knivanvändningstid | 50,1 h |
| Stötfångarstatus | OK |

Skärmbilden är tagen kring 2026-08-04 (samma dag som diagnostiken) och visar
"Senast uppdaterad **2026-07-30**" — data är **fem dygn gammal**. Enhetsvyn visar ändå
"Fel: Nej" och plausibla värden, dvs. **inget i UI:t signalerar att datan är inaktuell**
annat än den lilla texten "fem dagar sedan".

### R12.4 — Richard_Antrobus, 6 augusti — Yuka mini 2 fungerar, vill ha zonval

```
Your app works perfectly with the Yuka mini 2 1000 - Giving Homey the ability to select which
zone to mow directly would be a massive benefit, Controllable from Homey Flows. Thank you so
much for all your hard work
```

- **Positiv datapunkt:** appen fungerar på **Yuka mini 2 1000**, trots att Yuka enligt
  `CLAUDE.md` är "deferred to later phases".
- Önskemål: välja zon direkt från ett Flow-kort.

### R12.5 — Anders_Gregow, 7 augusti — Luba mini utan status

```
I still see problems with no updates of status for Luba mini. Anyone else having this?
```

- Ordet "still" antyder tidigare rapport i tråden. Ingen diagnostik bifogad.
- **Fjärde oberoende rapporten om utebliven status** (R5, R7/R12.3, R8, R12.5) — nu även
  på **Luba mini**.

### R12.6 — Tomas_O, 11 augusti — stöd för Luba 1

```
First of all, really happy to see Mammotion support in Homey — this has been something I've
been hoping for for a long time! Great work!

I'm still using a first-generation LUBA, and I was wondering if there is any possibility of
adding support for the LUBA 1 as well?

I realise the API/integration may be different from the newer models, but I'd be very
interested to know whether support is technically possible or something that could be
considered in the future.
```

### R12.7 — Rene_Kemps, 15 augusti — Luba 3, tom enhetslista vid parning

```
Hi Mathias,
I have the same issue with a LUBA 3 and app version 2.5.56.
I created a secondary Mammotion account and shared the mower with it. The LUBA 3 is visible
and fully controllable when logged into the official Mammotion app with the secondary account.

When I pair Mammotion in Homey using that same secondary account, login succeeds but the
device list is empty.

Diagnostics ID: 35d61dfe-fa0d-4b5f-84de-248bc609d9f8
```

**Samma diagnostik som [R11](#r11--diagnostik--luba-3-delad-till-andrakonto-syns-inte-vid-homey-parning)**
(`35d61dfe-fa0d-4b5f-84de-248bc609d9f8`). Nyckelordet är **"I have the same issue"** —
det finns alltså **minst en tidigare rapportör** med samma parningsproblem i tråden.
Den posten är inte inkluderad i det inklistrade materialet och **behöver letas upp**.

### Öppna frågor att besvara i planfasen

- Vilken/vilka tidigare inlägg refererar R12.5 ("still") och R12.7 ("same issue") till?
- Vilka modeller är egentligen i drift bland användarna? Hittills bekräftat i rapporterna:
  Luba 2 (flera), Luba 2 3000 (2024), Luba 3, Luba mini, Yuka mini 2 1000 — plus önskemål
  om Luba 1. Det är bredare än `CLAUDE.md`:s "Luba 2 + Luba 3".
- Ska "pausa tasken i mobilappen"-tricket in i README/App Store-beskrivningen?

---

## R13 — App Store-rapport — klipparen kör samma mönster på lägsta höjd

**Källa:** App Store-förslag, vidarebefordrat via Homeys notismejl
**Inkom:** 2026-09-06 (efter att insamlingen stängts — tillagd i efterhand eftersom den
bekräftar D-klustret exakt)
**Från:** anonymt i det inklistrade materialet

### Användarens egna ord (ordagrant)

```
Thank you very much for this app. I've been waiting en hoping for this for a long time.
Installation went well.

I mis one feature that would be really nice. I use customized Mowing angle pattern and
cutting height etc. Would it be possible to run on of these tasks as programmed in the
mammotion app?

Everytime it starts now it does the same pattern and at the lowest setting. That is also a
big risk if that does not get adjusted of cutting the gras far to short. Hope to hear from
you and thanks again!!
```

### Vad som rapporteras

1. Vill köra sina sparade tasks (eget klippmönster, egen klipphöjd) från Homey.
2. Generisk start ger alltid **samma mönster** och **lägsta klipphöjd**.
3. Användaren lyfter själv **säkerhetsrisken**: att klippa gräset alldeles för kort.

### Varför den är viktig

Andra oberoende rapporten om samma sak som R9, men nu med **klipphöjd** utöver spacing —
och med en uttalad skadeaspekt. Koden bekräftade beskrivningen ordagrant, se
[D i planen](./USER_REPORTS_PLAN.md#d--p1--klippparametrar-går-inte-att-styra): tomt
`blade_height`-fält gav 25 mm, kortets egen miniminivå, och av/på-reglaget skickade inga
parametrar alls. "Lowest setting" var bokstavligt sant.

Det användaren efterfrågar i punkt 1 **finns redan**: `start_mowing_schedule`
("Start mowing task") kör den sparade tasken med dess egna inställningar.

---

## Insamlingen avslutad

Mathias stängde insamlingen 2026-08-17 ("Det var alla för denna gång"). Rapporterna
R1–R12 utgör underlaget för åtgärdsplanen i
[`docs/USER_REPORTS_PLAN.md`](./USER_REPORTS_PLAN.md).

Om fler rapporter kommer in läggs de till här som R13 och framåt, och planen uppdateras.
