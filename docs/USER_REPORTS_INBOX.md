# User Reports Inbox — insamling pågår

Rå insamling av rapporter från användare: diagnostikloggar, e-post, forumtrådar
(Homey Community), GitHub-issues. Inget är analyserat eller prioriterat ännu —
det här är bara råmaterialet.

**Status:** 📥 Insamling pågår. När Mathias säger till stängs insamlingen och vi
bygger en strukturerad åtgärdsplan utifrån innehållet här.

**Insamling startad:** 2026-08-17

---

## Innehållsförteckning

| # | Källa | Datum | Kort beskrivning | App-version |
|---|-------|-------|------------------|-------------|
| [R1](#r1--diagnostik--triggerkort-startar-inte-nästa-task-mowern-åker-till-laddstationen) | Diagnostik (manuellt inskickad) | 2026-07-20 | Triggerkort "klippt klart" startar inte task 2 — mowern åker till laddstationen istället | v2.5.59 |
| [R2](#r2--förfrågan--kamerabild-i-error-push) | Meddelande från användare | — | Önskemål: bifoga kamerabild från klipparen i en error-push | — |
| [R3](#r3--uppföljning-på-r1--workaround-med-pause--fördröjning-fungerar) | Meddelande från användare (samma som R1/R2) | — | Workaround: `Pause mowing` + 20 s fördröjning före nästa task fungerar. Frågar om det är rätt upplägg, erbjuder loggar från riktig klippning | — |
| [R4](#r4--uppföljning--parningstext-och-task-taggning-på-triggerkortet) | Meddelande från användare (samma som R1–R3) | — | Två önskemål: (a) text vid parning om att det kan ta en stund innan klipparen hittas, (b) tagga vilken task som avslutades på `Mower finished a mowing job` för jobbkö | — |
| [R5](#r5--diagnostik--snabba-statusväxlingar-charging--paused-och-enheter-går-offline) | Diagnostik (manuellt inskickad) | 2026-07-23 | Snabba statusväxlingar (charging/paused/charging/paused) och enheter går offline. Aliyun-budget slut, BLE-fel #243–245, `getRegion failed: code=500` | v2.5.56 |

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
