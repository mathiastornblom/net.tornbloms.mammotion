# Åtgärdsplan — användarrapporter R1–R12

Strukturerad plan utifrån de tolv rapporterna i
[`docs/USER_REPORTS_INBOX.md`](./USER_REPORTS_INBOX.md), insamlade 2026-07-20 → 2026-08-15
och stängda 2026-08-17.

**Kodbas vid analystillfället:** `test` @ v2.5.61. Rapporterna kommer från v2.5.56 och
v2.5.59 — några av det som rapporteras som saknat finns redan i v2.5.61, se
[§3 Redan löst](#3-redan-löst-i-v2561--men-användarna-vet-inte-om-det).

---

## 1. Sammanfattning

Tolv rapporter från **minst åtta olika användare** faller i nio kluster. Två av dem är
akuta: appen slutar leverera status för en betydande andel användare, och delade enheter
går inte att para. Resten är förbättringar och önskemål.

| Prio | Kluster | Rapporter | Kärnproblem |
|---|---|---|---|
| **P0** | [A. Ingen statusuppdatering](#a--p0--ingen-statusuppdatering) | R5, R7, R8, R12.3, R12.5 | Tre separata orsaker som alla ger samma symptom |
| **P0** | [B. Delade enheter syns inte vid parning](#b--p0--delade-enheter-syns-inte-vid-parning) | R11, R12.7 (+minst en till) | `records=1` men tom lista i UI:t |
| **P1** | [C. Task-kedjning fungerar inte](#c--p1--task-kedjning-fungerar-inte) | R1, R3, R4 | Vår egen hint lovar något appen inte gör |
| **P1** | [D. Klippparametrar](#d--p1--klippparametrar-går-inte-att-styra) | R9 | `channelWidth` hårdkodad till 25 på den generiska startvägen |
| **P1** | [E. Bara "Task 1" listas](#e--p1--bara-task-1-listas) | R12.2 | Ej reproducerad — behöver bekräftas |
| ✅ **P2** | [F. Saknade Flow-kort](#f--p2--saknade-flow-kort) | R12.2 | `resume_mowing`-kortet tillagt |
| **P2** | [G. Robusthet och loggkvalitet](#g--p2--robusthet-och-loggkvalitet) | R1, R7, R8, R10 | Protobuf-fel, BLE-backoff utan tak, loggspam |
| **P2** | [H. Dokumentation och upptäckbarhet](#h--p2--dokumentation-och-upptäckbarhet) | R4, R12.1, R12.2, R12.4 | Funktioner finns men hittas inte |
| **P3** | [I. Nya modeller och funktioner](#i--p3--nya-modeller-och-funktioner) | R2, R6, R12.4, R12.6 | Luba 1, kamera, geopunkt |

---

## 2. Tvärsnitt: vad rapporterna säger om användarbasen

**Modeller i faktisk drift** (bredare än `CLAUDE.md`:s "Luba 2 + Luba 3"):

| Modell | Källa | Status |
|---|---|---|
| Luba 2 | R1–R4, R5/R8, R10 | Fungerar |
| Luba 2 3000 (2024) | R12.3 | Statusproblem efter firmware 1.30.29.8 |
| Luba 3 | R11/R12.7 | Går inte att para när den är delad |
| Luba mini | R12.5 | Statusproblem |
| Yuka mini 2 1000 | R12.4 | **"works perfectly"** |
| Luba 1 | R12.6 | Ej stött, efterfrågat |

**Homey-hårdvara:** Pro Early 2023 (`homey5q`) i de flesta; Pro Early 2019 (`homey3d`) i
R10. **Firmware:** v13.2.4 → v13.4.1-rc.3.

**Transporter:** `mqtt` (R1, R10), `aliyun_legacy` (R5, R7, R8). Statusproblemen finns i
**båda**, men med olika orsaker.

---

## 3. Redan löst i v2.5.61 — men användarna vet inte om det

Kontrollerat mot `app.json` på `test`. Detta är **inte** utvecklingsarbete utan
kommunikation:

| Efterfrågat | Status i v2.5.61 |
|---|---|
| R4.2 — tagga vilken task som avslutades | ✅ `mower_job_finished` har token `task_name` |
| R12.4 — välja zon från Flow | ✅ `start_mowing_zone` med zon-autocomplete |
| R12.2 — starta en namngiven task | ✅ `start_mowing_schedule` med task-autocomplete |

Rapportörerna körde v2.5.56/v2.5.59. **Åtgärd:** ett forumsvar som pekar på korten, plus
att de nämns i App Store-beskrivningen. Se [H](#h--p2--dokumentation-och-upptäckbarhet).

---

## A — P0 — Ingen statusuppdatering

**Fem rapporter, minst fyra användare, tre olika modeller.** Detta är appens mest
utbredda problem. Symptomet är ett, orsakerna är tre.

### A1. Budgetsvält — polling stannar i upp till 12 timmar

**Rapporter:** R5, R8 (samma användare, två mowers, 13 dagar isär)

**Diagnos — bekräftad i koden.** `lib/mammotion/aliyun/RequestGovernor.ts`:

```
ALIYUN_SEND_LIMIT   = 600 requests / rullande 12 h
POLL_SAFETY_MARGIN  = 0.85  →  tröskel 510
shouldSkipPoll()    → true när timestamps.length >= 510
remaining()         → 600 - timestamps.length
```

När `length` når exakt 510 slutar polling, och `remaining()` rapporterar `600 − 510 = **90**`.
Det förklarar exakt varför loggarna visar `90 left` — och varför siffran **aldrig rör sig**:
så snart polling skippas registreras inga nya requests, så räknaren fryser på tröskeln.
Den lossnar först när de gamla tidsstämplarna åldras ut ur 12-timmarsfönstret.

Konsekvensen: **appen kan sluta uppdatera status i upp till 12 timmar utan att något
händer, utan återhämtningsmekanism och utan att användaren får veta något.** R8 visar noll
telemetriuppdateringar på 55 minuter medan båda klipparna jobbade.

Att båda enheterna i R8 pollar i **exakt samma millisekund** (i R5 var de förskjutna ~80 s)
förvärrar dessutom bursten.

**Åtgärd:**
1. Exponera budgettillståndet för användaren — sätt enheten `unavailable` med en begriplig
   text när polling är strypt, istället för att visa gammal data som om den vore färsk.
2. Gradvis strypning istället för binär: när budgeten börjar ta slut, öka pollintervallet
   successivt (t.ex. 2 min → 10 min → 30 min) så att *något* fortsätter komma in, i stället
   för att gå från full takt till noll.
3. Sprid pollningen mellan enheter på samma konto (jitter/offset) så att multi-mower-konton
   inte skickar samtidiga burstar.
4. Överväg att persista fönstret över omstart. I dag nollställs `timestamps` vid omstart
   medan loggen samtidigt säger `resuming a rate-limit cooldown from before restart` — de
   två tillstånden är inte synkade (se även A2).

**Verifiering:** enhetstest av `AliyunRequestGovernor` som simulerar 510 requests och
kontrollerar att intervallet trappas upp i stället för att nollställas; manuellt test med
två mowers på ett konto.

### A2. Retry-loop som äter sin egen budget

**Rapporter:** R7 / R12.3

**Diagnos.** R7 visar `Poll: rate-limited by Aliyun — next check in 60s` och
`Poll: Aliyun gateway error (29004) — next check in 60s` i en obruten loop upp till
**failure #1374** — cirka ett dygn av oavbrutna misslyckanden. Ett försök var 60:e sekund
är **720 requests per 12 h**, alltså över Aliyuns eget tak på 600. Retry-loopen kan därmed
underhålla den rate-limit den försöker återhämta sig från.

Failure-räknaren nollställs vid appomstart medan meddelandet
`resuming a rate-limit cooldown from before restart` antyder att kylperioden är persistent.
Efter användarens "repair" (nya credentials, 08:25:50) återkom felen omedelbart — problemet
är alltså knutet till kontot, inte till sessionen.

**Åtgärd:**
1. Riktig exponentiell backoff på pollfel, med tak (t.ex. 60 s → 2 → 5 → 15 → 30 min).
   Nuvarande fasta 60 s är för aggressiv för ett dygnslångt felläge.
2. Räkna in misslyckade försök i budgeten och gör backoffen budgetmedveten.
3. Synka failure-räknare och cooldown så båda överlever omstart, eller ingen.
4. Efter N misslyckanden: markera enheten `unavailable` med orsaken synlig.
5. **Ta reda på vad felkod 29004 betyder** — den styr valet av strategi (är det throttling,
   auth, eller enhet offline?).

### A3. Inaktuell data presenteras som färsk

**Rapporter:** R12.3 (skärmbild), och implicit i R5/R8

**Diagnos.** Skärmbilden i R12.3 visar enhetsvyn för "Geten" den 4 augusti med
**"Senast uppdaterad 2026-07-30 05:46:53"** — fem dygn gammal data. Vyn visar samtidigt
"Fel: **Nej**", "Klipparstatus: Laddar", batterycykler, knivtid och RTK-status som om allt
vore normalt. Enda signalen är den lilla texten "fem dagar sedan" vid WiFi-värdet, och
"Anslutningstyp: Frånkopplad".

Det här är varför användarna skriver "status uppdateras inte" snarare än "appen är nere" —
**UI:t ljuger inte, men det säger inte sanningen tillräckligt tydligt.**

**Åtgärd:**
1. Sätt enheten `unavailable` i Homey när ingen telemetri kommit in på X minuter (X bör
   vara transportberoende — `aliyun_legacy` är långsammare än `mqtt` även när allt fungerar).
2. En Flow-trigger "status har inte uppdaterats på X minuter" så användare kan larma själva.
   `mower_offline`-triggern finns redan — kontrollera om den faktiskt fyras av i det här
   läget, eller om den bara reagerar på transportnedkoppling.

### A4. Att undersöka separat

- **Firmwarekopplingen.** R12.3 säger att problemet började efter uppdatering till
  **1.30.29.8** på en Luba 2 3000 (2024). Verifiera om övriga statusrapportörer också
  uppdaterat. Om ja är detta en firmwareregression och prioriteringen ändras.
- **`getRegion failed: code=500`** inträffar i R5 och R8 **en gång per dygn vid ~07:43–07:55
  UTC**, hos två olika användare, tre veckor isär. Det ser ut som ett återkommande fönster
  på Aliyuns sida — men det slår igenom som `registerAliyunDevice failed`, dvs. enheterna
  registreras aldrig. Kontrollera: försöker vi igen efter ett sådant misslyckande, eller
  ligger enheterna oregistrerade till nästa omstart?
- **`skewIfSeconds ≈ 204 800 s` (~56,8 h)** i R5/R8 mot 1–7 s i R1/R10. Antingen är
  enhetens klocka fel eller så tolkar vi `sysTimeStamp` fel för `aliyun_legacy`. Påverkar
  all tidsbaserad logik.

---

## B — P0 — Delade enheter syns inte vid parning

**Rapporter:** R11 / R12.7. R12.7 skriver **"I have the same issue"** — det finns alltså
minst en tidigare rapportör i forumtråden som inte finns med i materialet och som bör letas upp.

**Diagnos — delvis.** Loggen i R11 visar att enheten faktiskt hittas:

```
list_devices: owned=0 records=1 total=1 msg="Request success"
              {"records":[{"iotId":"4ErGSfNpYF1uLdM5RdmL4bnViY",
                           "deviceName":"Luba-VA5W38CC","productKey":"uY54W5rM8YH"}]}
list_devices: legacy Aliyun probe — bound=0 shareNotifications=0 []
```

Koden ser rätt ut vid första anblick: `buildDeviceList()` i `drivers/luba/driver.ts:529`
mappar från **`records`**, inte från `owned`, och kommenterar uttryckligen att
"the owned-devices endpoint returns nothing for mowers that were shared to this account".
Med `records.length === 1` borde `if (list.length > 0) return list;` returnera en enhet.

**Men vi kan inte se om det faktiskt hände.** Det finns en loggrad
`list_devices: returning N device(s) to pairing UI` — men **bara i legacy-grenen**.
Normalvägens `return list` loggar ingenting. Det är den enda grenen som inte är
instrumenterad, och det är precis den grenen den här buggen ligger i.

**Åtgärd, i ordning:**
1. **Först:** lägg samma `returning N device(s) to pairing UI`-loggrad på normalvägen.
   Billigt, och delar problemet i två: antingen returnerar vi noll enheter (bugg före
   returen) eller så tappar Homey dem (bugg i capabilities/data-formatet).
2. Logga också den byggda enhetens `capabilities`-array och upplösta `deviceType`.
   Hypotes värd att testa: `resolveDeviceType('Luba-VA5W38CC', 'uY54W5rM8YH')` ger
   `LUBA_VA` via namnprefixet — men om `capabilitiesForModel()` returnerar en tom eller
   ogiltig lista kan Homey tyst förkasta enheten.
3. Reproducera med `scripts/test-accounts.ts` mot ett delat Luba 3-konto.
4. Kontrollera om `productKey=uY54W5rM8YH` är känd i `deviceType.ts`.

**Varför P0:** `CLAUDE.md` föreskriver dedikerat andrakonto med delad mower som det normala
sättet att köra appen. Om delade enheter inte går att para är det den **rekommenderade
uppsättningen som är trasig**.

---

## C — P1 — Task-kedjning fungerar inte

**Rapporter:** R1 (diagnostik), R3 (workaround), R4 (samma användare)

**Diagnos.** Hinten på `mower_job_finished` i `app.json` säger ordagrant:

> "Combine with **'Start mowing task'** to automatically chain the next task."

Det är exakt vad användaren gjorde i R1/R4 — och det fungerade inte: mowern åkte till
laddstationen i stället för att starta task 2. **Vi lovar ett beteende appen inte levererar.**

Användaren hittade själv en workaround (R3) som fungerar:
`Pause mowing` efter 10 s + `Start mowing task` efter 20 s.

R1:s logg visar att `sysStatus` går 13 (mowing) → 14 (returning) och att inget utgående
`start_mow`/`bidireReqconverPath` skickas efter det. Sannolik mekanism: ett `start`-kommando
som anländer medan mowern är i return-to-dock ignoreras av enheten, medan en `pause` först
avbryter returen. **Detta är en hypotes, inte verifierad.**

**Åtgärd:**
1. Bekräfta mekanismen — be R3-användaren om den logg hen redan erbjudit sig att skicka
   från en fungerande körning, och jämför mot R1.
2. Om hypotesen håller: låt `start_mowing_schedule` internt skicka `pause` (eller
   `cancelDock`, som redan finns som `DeviceCommand`) och invänta att `sysStatus` lämnar 14
   innan `start` skickas. Då fungerar användarens ursprungliga flöde utan manuella
   fördröjningar.
3. Tills dess: rätta hinten så den beskriver det som faktiskt fungerar.
4. Verifiera kommandoutfall generellt — se [G3](#g3-kommandon-kvitteras-men-utförs-inte).

**Ta med:** frågan om tidsmarginalerna (10 s/20 s) är fältberoende. Om appen sköter
övergången själv försvinner frågan.

---

## D — P1 — Klippparametrar går inte att styra

**Rapport:** R9

Användaren kör 8 cm banavstånd i Mammotions app men får 12 cm när klippning startas via
Homey.

### Vad koden faktiskt gör

Det finns **två helt skilda startvägar**, och bara den ena skickar ruttparametrar.

**Väg 1 — generisk start.** `start_mowing`, `start_mowing_zone` och `onoff` går via
`LubaDevice.actionPlanAndStartMowing()` → `buildGenerateRouteCommand()`
(`lib/mammotion/commands/LubaCommands.ts:519`). Där ligger parametrarna dels genomkopplade,
dels som literaler:

```ts
knifeHeight:  Math.trunc(options.bladeHeight ?? 25),   // genomkopplad via StartMowOptions
speed:        options.speed ?? 0.3,                     // genomkopplad via StartMowOptions
channelWidth: 25,                                       // HÅRDKODAD
UltraWave:    2,                                        // hårdkodad (ultraljudskänslighet)
channelMode:  0,                                        // hårdkodad
toward: 0,  towardMode: 0,  towardIncludedAngle: 0,     // hårdkodade
```

Funktionens egen doc-kommentar säger rakt ut att de icke-exponerade parametrarna använder
"the same fixed defaults pymammotion's OperationSettings does" — det är alltså ett medvetet
uppskjutet val, inte ett förbiseende.

**Väg 2 — starta en sparad task.** `start_mowing_schedule` går via
`LubaDevice.actionStartSchedule()` → `buildStartScheduleCommand()`, som skickar **enbart**:

```ts
nav: { planTaskExecute: { subCmd: 1, id: planId } }
```

Inga ruttparametrar alls. Enheten kör tasken med sina **egna sparade inställningar**.

**Konsekvens:** R9-användaren får sina 8 cm automatiskt om hen startar via task-kortet.
Problemet finns bara på den generiska vägen. Vilket kort användaren faktiskt använde är
inte känt och **bör frågas innan något ändras**.

### Den olösta siffran

Vi skickar `25`. Användaren rapporterar `12`. Fyra värden är i omlopp:

| Värde | Källa |
|---|---|
| 8 cm | Användarens inställning i Mammotion-appen |
| 12 cm | Vad användaren observerar när start sker via Homey (R9) |
| 25 | Vad `buildGenerateRouteCommand` hårdkodar |
| 22 | `channelWidth: 22` i R1:s `bidireReqconverPath` (mottaget från enheten) |

Vår siffra är alltså inte den som landar. **Innan ett reglage byggs måste fältets semantik
fastställas** — enhet (cm/mm) och om det är banavstånd eller överlapp. Det kräver ett test
mot riktig hårdvara; det går inte att läsa sig till.

### Billig väg som löser R9 utan nya kontroller

`NavPlanJobSet` bär spacing som **`route_spacing` (fält 21)** — *inte* som `channelWidth`;
fält 7 på det meddelandet är `userId`. De två meddelandena döper alltså samma begrepp olika:
den sparade tasken säger `route_spacing`, ruttplaneringen säger `channel_width`.

Fällan är att protobufjs **tyst slänger** en okänd nyckel vid encode, så fel fältnamn ger
`0` för alltid i stället för ett fel — exakt samma sak som `PlanIndex`-buggen som redan har
ett regressionstest. Det här kostade en felaktig första implementation innan descriptorn
lästes ordentligt.

`ScheduleParser.ts` läser redan `knifeHeight` och `speed` ur samma meddelande, så vi kan
**läsa användarens eget värde** ur hens task och använda det som default på den generiska
vägen i stället för hårdkodade 25.

Då beter sig båda vägarna likadant, ingen behöver ställa något, och vi behöver inte veta
fältets exakta enhet — vi ekar tillbaka enhetens egen siffra.

**Kostnad:** ett fält i `ScheduleParser`, ett i `StartMowOptions`, en rad i
`buildGenerateRouteCommand`, plus fallback när ingen task finns. Ingen manifest- eller
locale-ändring.

Övriga hårdkodade ruttfält har motsvarigheter i samma meddelande om vi vill gå längre:
`routeAngle` (19) ↔ `toward`, `routeModel` (20) ↔ `channelMode`, `ultrasonicBarrier` (22)
↔ `UltraWave`. De är inte användarsynliga inställningar i officiella appen på samma sätt,
så de lämnas orörda tills någon rapporterar dem.

### Åtgärd, i ordning

1. ✅ **Läs och återanvänd** — implementerad. `ScheduleParser` läser `routeSpacing`,
   `LubaDevice.storedChannelWidth()` väljer det lägsta rapporterade värdet över enhetens
   tasks (0 = "inget rapporterat" filtreras bort), och `buildGenerateRouteCommand` faller
   tillbaka på 25 när ingen task finns.
2. Fråga R9-användaren vilket Flow-kort som användes. Om det var task-kortet är det inte
   den här buggen utan något annat.
3. Fastställ `channelWidth`-semantiken mot hårdvara innan något reglage byggs.
4. Först därefter: principbeslutet om `StartMowOptions` ska exponeras samlat
   (`blade_height`, `speed`, `channel_width`, `channel_mode`, `rain_tactics`) som
   Flow-argument, enhetsinställningar eller båda. Gör det samlat, inte styckvis.

---

## E — P1 — Bara "Task 1" listas

**Rapport:** R12.2

Användaren får bara "Task 1" i task-autocompleten, trots att fler tasks finns i
Mammotion-appen. **Ej reproducerad.** Motstridig datapunkt: R1:s användare skrev
"alla task fanns nu", och R1:s logg listar åtta zoner korrekt.

Möjliga förklaringar att testa: pausade tasks i mobilappen listas annorlunda (R12.2:s
användare hade uttryckligen pausat sina tasks), autocompleten filtrerar på något, eller det
var ett fel i v2.5.56 som redan är åtgärdat.

**Åtgärd:** be användaren om en diagnostik med aktuell version innan något ändras.

---

## F — P2 — Saknade Flow-kort

**Rapport:** R12.2 — "what flow card to use, to get the robot to resume a cutting task?"

**Bekräftat:** det finns inget `resume`-actionkort i `app.json` (åtgärder i v2.5.61:
`start_mowing`, `start_mowing_zone`, `start_mowing_schedule`, `send_to_dock`,
`pause_mowing`, `stop_mowing`, `read_schedule`, `set_rain_protection`, `set_blade_speed`).

**Men protokollkommandot finns redan:** `lib/mammotion/commands/LubaCommands.ts:16` deklarerar
`'resume'` som `DeviceCommand` med opcode `3`.

**Åtgärd:** ✅ **Implementerad.** `resume_mowing` finns nu som actionkort:
`LubaDevice.actionResume()` skickar `resume` via den befintliga `sendTaskControlRaw`,
handlern är registrerad i `driver.ts`, och kortet är deklarerat i `driver.compose.json`
med titel och hint på alla 13 språk.

**Notis om var Flow-kort faktiskt bor:** de authoras i `$flow` i
`drivers/luba/driver.compose.json`, **inte** i `app.json` — `app.json` är genererad och
skrivs över av `homey app validate`/`compose`, så en redigering där försvinner tyst.
`locales/*.json` innehåller flow-strängar för tre gamla kort (`start_mowing`,
`pause_mowing`, `send_to_dock`) men är föråldrade: nyare kort ligger inte där alls.
Enda källan är alltså `driver.compose.json`. Ett nytt test (`scripts/flow-cards.test.mjs`)
vaktar att varje kort har titel, hint och argumenttitlar på alla 13 språk, eftersom ett
kort med bara `en` validerar och publiceras utan invändning.

---

## G — P2 — Robusthet och loggkvalitet

### G1. Protobuf-avkodningsfel

Fyra fel över tre dagar i R10, ett i R1. Två distinkta signaturer:

- `index out of range: N + 10 > N` — R1 (`31 + 10 > 31`), R10 (`41 + 10 > 41`, `42 + 10 > 42`)
- `invalid wire type X at offset 35` — R10 (`wire type 6`, `wire type 4`)

Att `+ 10 >` -mönstret återkommer med olika N hos olika användare tyder på ett systematiskt
längdfel snarare än enstaka korrupta paket. **Åtgärd:** undersök längdhanteringen; logga
den råa payloaden (hexdump, begränsad längd) vid avkodningsfel så nästa rapport blir
diagnostiserbar.

### G2. BLE-backoff utan tak eller återställning

R5/R8 visar `failure #243`, `#244`, `#245` med 1800 s backoff — flera dygns misslyckade
återanslutningar. Räknaren nollställs bara vid appomstart. Tre olika felmoder hamnar i samma
logik:

| Felmod | Rapport |
|---|---|
| `scan found 0 BLE advertisements` (radion ser ingenting) | R7 |
| Enheten syns aldrig i scannen (13–24 andra hittas) | R5, R8, R1 |
| Enheten hittas men anslutning misslyckas efter 20–37 s | R8, R10 |

**Åtgärd:** skilj på fallen; sluta scanna efter N misslyckanden när mowern konsekvent är
utom räckhåll; informera användaren om BLE varit nere i dagar i stället för att tyst
fortsätta.

### G3. Kommandon kvitteras men utförs inte

R10 är det tydligaste fallet: `generate_route` + `start` skickas elva gånger på 26 minuter,
**alla får `{"code":0,"msg":"Request success"}`**, och mowern kör ändå inte (mowing → paused
→ idle inom 16 sekunder). Användaren ser samtidigt **fel 1417 i Mammotions egen app**.

Vi har alltså ingen återkoppling på om ett kommando faktiskt fick effekt. **Åtgärd:**
verifiera `start` mot efterföljande `sysStatus` och rapportera ett begripligt fel i Homey
när körningen inte startar. Ta också reda på vad **felkod 1417** betyder — om det är ett
enhetsfel (kniv, lyftsensor, RTK) bör det gå att visa i Homey i stället för tystnad.

### G4. Loggspam när transporten är nere

R10, 2026-08-10 22:29–23:00: MQTT-servern `8.211.50.191:3083` vägrar anslutningar i ~30
minuter. Appen loopar en gång i minuten genom `initial sync` → `rain protection` →
`zone list` — **tre felrader per försök, ~60 rader**, alla med samma kända orsak. Ingen
backoff: exakt 60 s mellan försöken.

**Åtgärd:** dämpa `No transport available for command: …` när transporten redan är känt
nere; lägg backoff på initial-sync-loopen.

---

## H — P2 — Dokumentation och upptäckbarhet

Flera rapporter är inte buggar utan att användare inte hittar det som finns.

1. **Svara i forumtråden** med: `start_mowing_zone` finns (→ R12.4), `mower_job_finished`
   har en `task_name`-token (→ R4.2), `start_mowing_schedule` finns (→ R12.2) — och att man
   behöver v2.5.61.
2. **Dokumentera pause-tricket.** R12.1/R12.2:s användare kom själv på att man pausar tasken
   i mobilappen så att bara Homey kör den. Det är icke-uppenbart och alla som kedjar tasks
   kommer att behöva det. Hör hemma i README och App Store-beskrivningen.
3. **Väntetext vid parning** (R4.1) — informera om att det kan dröja innan klipparen hittas.
   Berör `drivers/luba/pair/*` och alla 13 språk.
4. **Rätta hinten på `mower_job_finished`** tills [C](#c--p1--task-kedjning-fungerar-inte)
   är löst.

---

## I — P3 — Nya modeller och funktioner

| Önskemål | Rapport | Bedömning |
|---|---|---|
| Stöd för Luba 1 | R12.6 | Kräver protokollutredning — annan generation. Arkitektarbete innan något lovas. |
| Kamerabild i error-push | R2 | Kamera/Agora WebRTC ligger i fas 7. Utred om en stillbild går att hämta utan full WebRTC-stack, och om den kan exponeras som Homey-image-token. |
| Kör till specifik geopunkt | R6 | Undersök om protokollet har ett "goto point"-kommando eller bara zon-/jobbnavigering. Notera att det efterfrågade användningsfallet (köra mot rörelse som bevakning) inte är avsedd användning — kräver ett ställningstagande. |
| Bekräfta Yuka mini 2-stöd | R12.4 | Fungerar enligt användare. Uppdatera `CLAUDE.md` och App Store-listan så Yuka inte längre står som "deferred". |

---

## 4. Föreslagen ordning

**Steg 1 — diagnostik som är billig och låser upp resten**
- B1: loggrad på normalvägens `return list` (låser upp parningsbuggen)
- G1: hexdump vid protobuf-fel
- Begär in: R3:s logg från fungerande körning, R12.2:s diagnostik med aktuell version,
  det saknade foruminlägget som R12.7 refererar till

**Steg 2 — P0, statusproblemet**
- A1 budgetsvält (gradvis strypning + jitter + synligt tillstånd)
- A2 backoff på pollfel
- A3 `unavailable` vid inaktuell data
- Parallellt: utred firmwarekopplingen (A4) och `getRegion 500`-fönstret

**Steg 3 — P0/P1**
- B: parningsbuggen, utifrån vad steg 1 visade
- C: task-kedjning
- D: klippparametrar

**Steg 4 — snabba vinster, kan tas när som helst**
- ✅ F: `resume_mowing`-kortet — klart
- H1/H2: forumsvar och dokumentation
- H3: väntetext vid parning

**Steg 5 — P2/P3**
- G2–G4, E, I

---

## 5. Frågor som behöver Mathias beslut

1. **Klippparametrar (D):** läs-och-återanvänd är påbörjad som första steg. Kvarstår:
   ska `StartMowOptions` exponeras som användarstyrda kontroller alls, eller ska appen
   alltid eka enhetens egna sparade inställningar? Kräver att `channelWidth`-semantiken
   först fastställs mot hårdvara.
2. **Task-kedjning (C):** ska appen dölja pause/vänta-dansen internt, eller ska vi
   dokumentera workarounden och låta användaren bygga den själv?
3. **Geopunkt (R6/I):** vill vi bygga en funktion vars beskrivna användningsfall är att köra
   klipparen mot rörelse?
4. **Luba 1 (R12.6):** värt en protokollutredning nu, eller ska vi svara "inte planerat"?
5. **`unavailable` vid inaktuell data (A3):** hur länge ska vi vänta innan en enhet markeras
   otillgänglig? Går det att sätta ett värde som fungerar för både `mqtt` och
   `aliyun_legacy`, eller behövs olika?
