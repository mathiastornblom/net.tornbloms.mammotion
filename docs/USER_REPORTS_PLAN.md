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
| ✅ **P0** | [A. Ingen statusuppdatering](#a--p0--ingen-statusuppdatering) | R5, R7, R8, R12.3, R12.5 | Alla tre orsaker åtgärdade: A1 pacing, A2 backoff per orsak + 29004 = obunden, A3 stalet-vakthund |
| **P0** | [B. Delade enheter syns inte vid parning](#b--p0--delade-enheter-syns-inte-vid-parning) | R11, R12.7 (+minst en till) | Pipeline bevisad, proben 7→4 stadier + stegvis omkörning; timing-hypotesen **försvagad** (Homey-gräns ~30 s > R11:s 13–16 s) — nästa rapport avgör |
| ✅ **P1** | [C. Task-kedjning fungerar inte](#c--p1--task-kedjning-fungerar-inte) | R1, R3, R4 | Return-avbrott före start implementerat — väntar hårdvaruverifiering |
| ✅ **P1** | [D. Klippparametrar](#d--p1--klippparametrar-går-inte-att-styra) | R9, R13 | Spacing och klipphöjd hämtas nu från klipparens egna sparade tasks |
| **P1** | [E. Bara "Task 1" listas](#e--p1--bara-task-1-listas) | R12.2 | Ej reproducerad — behöver bekräftas |
| ✅ **P2** | [F. Saknade Flow-kort](#f--p2--saknade-flow-kort) | R12.2 | `resume_mowing`-kortet tillagt |
| ✅ **P2** | [G. Robusthet och loggkvalitet](#g--p2--robusthet-och-loggkvalitet) | R1, R7, R8, R10 | Hexdump, BLE klassad+parkerad, start verifieras mot status, MQTT-stege 10 s→5 min; kvar: protobuf-längd (behöver dump), felkod 1417 (behöver tabell) |
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

Rapportörerna körde v2.5.56/v2.5.59. **Åtgärd:** ett forumsvar som pekar på korten
(utkast klart, ej postat), plus att de nu nämns i App Store-beskrivningen och README —
✅ gjort, se [H](#h--p2--dokumentation-och-upptäckbarhet).

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

**Varför det är deterministiskt, inte otur.** Basintervallen är 90 s (aktiv) / 120 s
(vila) — 360–480 anrop per enhet och fönster. **Två mowers i vila är 720 mot ett polltak på
510.** Varje tvåmower-konto nådde alltså väggen varje fönster, per konstruktion, efter
~8,5 timmar. Det är R5/R8:s konto exakt.

**Åtgärd — ✅ implementerad:**
1. ✅ **Stegvis pacing i stället för binär spärr.** `AliyunRequestGovernor.pollDelayMs(base)`
   skalar basintervallet med användningen av *polltaket*: 1× under 60 %, 2× vid 60 %,
   5× vid 80 %, 15× vid 95 % — alltså 120 s → 240 s → 600 s → 1800 s. Pollning **stannar
   bara** när enbart kommandoreserven (40 anrop av 600) återstår; det är det enda som
   någonsin ger `null`. Att nå polltaket saktar ner, det stoppar inte längre.
2. ✅ **Synligt för användaren.** Vid tier ≥ 2 sätts `setWarning` med en förklarande text på
   13 språk (`warning.aliyun_budget_throttled`), och tas bort när tiern sjunker. Medvetet
   `setWarning` och **inte** `setUnavailable`: unavailable skulle blockera användarens egna
   start/stopp-kommandon — precis det reserven finns för att skydda, och de går förbi
   pacingen helt.
3. ✅ **Ingen lockstep.** Legacy-enheter får en slumpad startförskjutning (0–60 s) och ±10 %
   jitter per tick, så två mowers som armats samtidigt vid appstart inte träffar gatewayn på
   samma millisekund (R8).
4. ✅ **Fönstret överlever omstart.** Drivern återställer `snapshot()` från `homey.settings`
   i `onInit`, sparar med 30 s debounce på varje `recordRequest`, och flushar i `onUninit`.
   Utan det började varje omstart med tomt fönster och full takt rakt in i ett konto som
   redan kunde ligga vid gränsen — det gamla "fungerar efter omstart, dör igen"-mönstret.
5. ✅ **Loggen säger något.** Den gamla raden `skipping — … 90 left` loggades varje tick
   (27 identiska rader på 55 min i R8). Nu loggas **bara tier-övergångar**:
   `Poll: Aliyun budget tier N — X/510 of the poll cap used, Y/600 left; interval now Zs`.

**Verifiering — simulerat 12 h, enheter i lockstep (värsta fallet), 120 s bas:**

| Enheter | Pacing | Skickade | Lägsta kvar | Högsta tier | Snittintervall/enhet |
|---|---|---|---|---|---|
| 1 | ja | 333 | 267 | 1 | 2,2 min — oförändrat mot i dag |
| 2 | **nej** (gammalt) | 720 | **0** | 3 | 2,0 min — kör rakt genom 600 |
| 2 | ja | 450 | 150 | 2 | **3,2 min — når aldrig tier 3** |
| 3 | ja | 498 | 102 | 3 (14 polls) | 4,3 min |
| 4 | ja | 524 | 76 | 3 (40 polls) | 5,5 min — aldrig stoppad |

R5/R8:s konto får alltså en poll var ~3:e minut per mower **hela dygnet**, i stället för
att dö efter 8,5 timmar. 15 tester i `aliyun-request-governor.test.mjs`, inklusive ett som
uttryckligen inverterar den gamla assertionen: "vid exakt polltaket SAKTAR pollning ner, den
stannar inte" — med `remaining === 90`, den frusna siffran ur båda rapporterna.

**Kvarstår:** manuellt test med två mowers på ett riktigt konto (R5/R8-användaren är den
naturliga). Simuleringen antar att alla anrop lyckas; A2:s serverbackoff ligger orörd ovanpå.

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

**Vad koden visade, utöver loggen.** Backoffen *var* exponentiell (10 s × 2ⁿ) men
**kapad vid 60 s** av `OFFLINE_POLL_MAX_MS` — ett tak avsett för "klipparen är avstängd,
kolla varje minut" som tillämpades på *alla* fel. 60 s är 720 anrop per fönster. Loopen
försörjde sin egen spärr.

**Felkod 29004 = `DEVICE_UNBOUND`** — redan dokumenterat i `commands.ts:28`, planens fråga
var besvarad i kodbasen. Det är inte throttling: klipparen är *inte längre bunden till
kontot* på Aliyun-sidan. R7:s "Geten" fick det direkt efter firmware 1.30.29.8, som rimligen
registrerade om enheten. Att polla en obunden enhet var 60:e sekund är meningslöst — det
kan aldrig lyckas förrän användaren reparerar — och det var *den* loopen som drog på sig
429:orna. R7 innehöll alltså två fel, där det ena orsakade det andra.

**Misslyckade anrop räknades redan** i budgeten: `recordRequest()` ligger före
`sendAliyunCloudCommand` i `try`. Punkt 2 nedan var sann från start.

**Åtgärd — ✅ implementerad** (`lib/mammotion/aliyun/pollBackoff.ts`, ren och testad):
1. ✅ **Tre backoff-stegar efter orsak**, inte en:
   - `device_offline` — oförändrad (20 s, 40 s, 60 s platt). En avstängd klippare som
     slås på ska märkas inom en minut.
   - `account_penalty` (429, gateway-fel, credentials/circuit) — **60 s → 2 → 4 → 8 →
     16 → 30 min**, sedan 30 min platt. **28 anrop per 12 h mot 720.**
   - `device_unbound` (29004) — **platt 30 min från första träffen**; det finns ingen stege
     att klättra. 24 anrop per 12 h mot 1 440.
2. ✅ **Komponerad med A1:s pacing — långsammast vinner** (`composeWithPacing`). En
   backoff får aldrig låta en enhet försöka *snabbare* än kontots tier tillåter; annars hade
   en offline-klippare på ett budgetsvultet konto kört var 60:e sekund rakt förbi pacingen.
3. ✅ **Räknaren persisteras** (`rateLimitFailureCount`) bredvid cooldownen, och
   `startPollTimer` kapar nu den sparade cooldownen vid **30 min i stället för 60 s** —
   den gamla kapningen trunkerade tyst varje längre cooldown vid omstart, vilket är exakt
   inkonsekvensen R7 visade (`resuming a rate-limit cooldown` följt av `failure #1`).
4. ✅ **Synligt efter N.** Kontostraff efter 3 i rad → `setWarning`
   (`warning.aliyun_rate_limited`, 13 språk). Obunden efter 2 i rad → **`setUnavailable`**
   med `error.device_unbound` som säger *reparera enheten* — unavailable med flit här: inget
   kommando kan lyckas heller, och Homeys reparationsflöde nås från en otillgänglig enhet,
   samma behandling som ogiltiga credentials redan får. Varningsplatsen delas med A1 via
   `syncDeviceWarning()`: straff vinner över budget, och ingen av dem raderar den andras.
5. ✅ **29004 besvarad** — se ovan. Klassificeras nu som egen kategori i `runPollTick`.

**Verifiering:** 9 tester i `poll-backoff.test.mjs`, inklusive R7-regressionen uttryckt i
siffror — 60 s-taket gav 720/fönster; kontostegen ger 28, obunden 24 — och att
`ALIYUN_INVOKE_CODE.DEVICE_UNBOUND === 29004` så klassificeringen inte kan glida från
konstanten. Offline-stegen mäter fortfarande 721/12 h isolerat, vilket är avsiktligt: den
ska vara snabb, och det är kompositionen med pacingen som håller den inom budget.

**Kvarstår:** bekräfta mot R7-användaren (Westberg) att Geten faktiskt är obunden efter
firmwareuppdateringen och att reparation binder om den. Om ja är det värt ett forumsvar:
"efter firmwareuppdatering, kör Reparera" — det är sannolikt fler som drabbas.

### A3. Inaktuell data presenteras som färsk

**Rapporter:** R12.3 (skärmbild), och implicit i R5/R8

**Diagnos.** Skärmbilden i R12.3 visar enhetsvyn för "Geten" den 4 augusti med
**"Senast uppdaterad 2026-07-30 05:46:53"** — fem dygn gammal data. Vyn visar samtidigt
"Fel: **Nej**", "Klipparstatus: Laddar", batterycykler, knivtid och RTK-status som om allt
vore normalt. Enda signalen är den lilla texten "fem dagar sedan" vid WiFi-värdet, och
"Anslutningstyp: Frånkopplad".

Det här är varför användarna skriver "status uppdateras inte" snarare än "appen är nere" —
**UI:t ljuger inte, men det säger inte sanningen tillräckligt tydligt.**

**Vad som gjorde A3 annorlunda efter A1/A2.** De kända orsakerna till tystnad har nu
egna signaler — budget → varning, kontostraff → varning, obunden → unavailable, bekräftat
offline → unavailable. Det som återstår är den **oförklarade** tystnaden: transporten ser
fin ut, inget fel loggas, men inget kommer. Det kräver en vakthund som inte bryr sig om
*varför*, bara om *hur länge*.

**Åtgärd — ✅ implementerad** (`lib/mammotion/staleness.ts` + vakthund i `device.ts`):
1. ✅ **Unavailable vid oförklarad tystnad.** En vakthund kollar varje minut om senaste
   telemetri är äldre än tröskeln; då `setUnavailable` med `error.telemetry_stale`
   (13 språk) — som säger det vi *vet*: inte att klipparen är offline, bara att inget hörts
   — och `mower_offline` fyras på övergången. Nästa telemetri återställer via `markOnline()`.
   En mer specifik unavailable-orsak (obunden, ogiltiga credentials, bekräftat offline)
   skrivs **inte** över.
2. ✅ **`mower_offline` fyras nu i det här läget.** Planens fråga var om triggern reagerar på
   stalet data eller bara på transportnedkoppling — svaret var bara nedkoppling. Nu fyras den
   på vakthundens övergång också, så befintliga flöden larmar utan att en ny kortsort behövs.
   Ett dedikerat "inte uppdaterad på X min"-kort med användarvald X är därmed inte
   nödvändigt; lägg till det bara om någon ber om det.

**Svaret på planens fråga 5 — tröskeln:** *inte* ett fast värde, och inte två. Tröskeln är
**tre gånger det intervall pollslingan själv senast schemalade**, med ett golv på 10 min:
`staleAfterMs(interval) = max(10 min, 3 × interval)`. Eftersom både A1:s pacing och A2:s
backoff går genom `schedulePoll`, följer vakthunden dem automatiskt — förväntar vi oss en
poll var 30:e minut är tystnad stalet först efter 90 min; vid 120 s (eller MQTT:s 5 s)
gäller golvet. Tre missade förväntade uppdateringar är punkten där transportens egen retry
uppenbart inte löst det själv. **Vakthunden kan alltså aldrig flagga en enhet som appen
själv medvetet saktat ner** — det är låst i test, inte bara avsett.

Grundlinjen sätts till *starttiden* i `startTransports`, inte till det sparade
`last_sync`-värdet: annars hade varje omstart flippat enheter till unavailable på dagar
gammal data innan transporterna hunnit försöka. Överlever transportbyten (`onSettings`).

**Verifiering:** 10 tester i `telemetry-staleness.test.mjs`, bl.a. R12.3:s fem dygn stalet
vid varje intervall appen någonsin kan schemalägga; en enhet som den *riktiga* governorn
pacat till 30 min är inte stalet vid 45 eller 89 min men vid 91; samma för A2:s
30-minutersbackoff; MQTT tyst 11 min är stalet (130 missade rapporter är ingen blipp);
regeln är monoton i både tystnad och intervall.

**Kvarstår:** inget kodmässigt. R12.3-fallet ("Geten") skulle med A2 träffas av
`device_unbound` långt före vakthunden — vakthunden är skyddsnätet för det vi *inte* har
förutsett.

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
1. ✅ Loggrad `returning N device(s) to pairing UI` på normalvägen, med upplöst
   `deviceType` och antal capabilities — och nu även **tidsåtgång i ms** från handlerns
   start. Delar problemet i två: returnerar vi noll, eller tappar Homey det vi returnerar.
2. ✅ **Den rena pipelinen är bevisat felfri för R11:s exakta indata.**
   `scripts/shared-device-pairing.test.mjs` kör `mergeDeviceContext({}, record)` →
   `resolveDeviceType` → `capabilitiesForModel` med precis den record R11 loggade:
   `Luba-VA5W38CC` → `LUBA_VA` (namnprefix, oberoende av att `deviceType` är `null` för
   delade enheter), 25 av 27 capabilities, `data.id` = iotId. Fyra assertioner, alla
   gröna. Hypotesen "tom/ogiltig capability-lista" är därmed **avförd**. Buggen ligger
   nedströms om vår kod.
3. ✅ `productKey=uY54W5rM8YH` är känd — det är samma nyckel som Mathias egen
   `Luba-VAZSPPU6` (se `device-routing.test.mjs`), som parar utan problem när den är
   *ägd*. Skillnaden mot R11 är alltså inte modellen utan att enheten är delad.
4. ✅ **Proben körs nu parallellt — men rätt sak parallelliserad, och med en rättelse av
   min egen hypotes.**

   *Rättelsen först.* `gateway.ts` visste redan Homeys parningstimeout: kommentaren där
   säger "needs to stay well under Homey's own ~30s pairing-UI timeout". R11:s 13–16 s
   ligger **under** 30 s. Timing-hypotesen är därmed *försvagad*, inte bekräftad — tids-
   loggen avgör fortfarande, men den ärliga lägesbilden är att R11 sannolikt har en annan
   orsak. Och min tidigare "halverar väntetiden" var fel räknat: det seriella arbetet
   *före* proben är ~0,7 s. Att överlappa proben med hämtningen sparar under en sekund.

   *Var tiden verkligen gick.* Proben är sju **seriella** anrop (`getRegion → connectDevice
   → loginByOAuth → aepHandle → sessionByAuthCode → listBindingByAccount →
   getShareNoticeList`), 6 s timeout vardera. R11: ~3,3 s lyckade steg, ett steg som hängde
   6 s, sedan **hela handskakningen om från början** (~6 s). Det är 15 s.

   *Vad som landade* (`AliyunLegacyProbe.ts`, testat med injicerade steg):
   - **Fyra stadier i stället för sju**, härlett ur dataflödet — inte ur pymammotion, som
     kör allt strikt seriellt: `[region ∥ connect] → [oauth ∥ aep] → session →
     [binding ∥ notiser]`. `connectDevice` tar bara utdid mot fast host; `aep` matar
     enbart credentials, inte `sessionByAuthCode`; de två sista behöver bara token.
   - **Stegvis omkörning**: ett steg som fallerar på *nätverksnivå* körs om ensamt — de
     steg som redan lyckats görs inte om. Ett logiskt avslag körs aldrig om (servern
     skulle säga nej igen).
   - **Sekventiell fallback vid logiskt fel i den omordnade handskakningen** — om Aliyun
     någonsin invänder mot ordningen körs originalsekvensen, den som är bekräftad mot
     riktigt konto, exakt en gång. Loggas som `via=sequential (parallel handshake
     failed …)` så det syns i nästa rapport. Nätverksfel triggar *inte* fallbacken:
     samma döda nät, och steget har redan fått sin andra chans.
   - **Gatewayens timeout bär nu `code: 'ETIMEDOUT'`.** Utan det klassade
     `isNetworkLevelError` vår egen timeout som logiskt fel — så varken `getRegion`s
     statiska fallback eller den stegvisa omkörningen hade slagit till på *exakt* R11:s
     fel. Latent miss som fanns sedan tidigare.
   - Proben startas direkt efter `acceptPendingShares` och överlappar hämtningen — efter
     delningssteget med flit, eftersom det kan vara vad som skapar Aliyun-bindningen
     proben sedan läser.

   *Väntad effekt på R11:s form:* ~15 s → ungefär 9–10 s (stadierna krymper de 3,3 s;
   hänget kostar fortfarande 6 s; bara det steget körs om). Friska konton: ~3,5 s → ~2 s.
   Tidsloggen `returning … after NNNNms` visar det, tillsammans med `via=`.
5. Reproducera med `scripts/test-accounts.ts` mot ett delat Luba 3-konto — kräver
   R12.7-användarens medverkan eller ett eget delat testkonto.

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

**Bekräftat i koden, inte bara hypotes:** `updateMowerStatus` fyrar `mower_job_finished`
**i samma ögonblick** status blir `returning` — kommentaren säger uttryckligen att en kedjad
task inte ska behöva vänta ut hemresan. Designen förutsatte alltså start från returläget men
hanterade aldrig att enheten släpper en start som anländer där. Varje kedjning via den här
triggern träffar det läget, per konstruktion. Det är därför det aldrig fungerade.

**Åtgärd:**
1. ✅ **Implementerad.** `interruptReturnIfNeeded()` i `device.ts`: om `mower_status` är
   `returning` skickas `pause`, sedan inväntas (max 10 s) att statusen lämnar `returning`,
   därefter skickas starten oavsett. Anropas först i **båda** startvägarna
   (`actionStartSchedule` och `actionPlanAndStartMowing`), så även generisk start och
   on/off-reglaget täcks. Ny statusväntare (`waitForStatusChange`) enligt samma mönster som
   `waitForRouteConfirmation`. 10 s är den paus R3-användarens handbyggda flöde använde;
   `pause` i stället för `cancelDock` för att pause är det som är bekräftat mot hårdvara.
2. **Kvarstår — verifiering på riktig klippare.** Mekanismen är härledd ur kod + R3:s
   fungerande workaround, inte testad end-to-end. Be R3-användaren ta bort sina manuella
   pause/vänta-kort och köra det ursprungliga flödet igen på nästa version. Loggraderna
   `Mower is returning to dock — pausing…` / `Mower left 'returning'…` visar exakt vad
   som hände.
3. Hinten på `mower_job_finished` blir sann i och med detta och lämnas som den är.
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

1. ✅ **Läs och återanvänd** — implementerad för **både spacing och klipphöjd**.
   Rena funktioner i `ScheduleParser.ts`: `resolveStoredRouteSpacing()` tar **minsta**
   värdet över enhetens tasks, `resolveStoredBladeHeight()` tar **största**. Riktningarna
   är olika med avsikt: att klippa för långt kostar en extra vända, att klippa för kort
   skalperar gräsmattan och går inte att ångra. Vid oenighet mellan tasks lämnas gräset
   längre. 0 = "inget rapporterat" filtreras bort i båda, och `buildGenerateRouteCommand`
   faller tillbaka på 25 när ingen task finns.

   **Ny datapunkt (R13, App Store-rapport 2026-09-06):** en andra användare rapporterade
   att klipparen "always does the same pattern and at the lowest setting" — och lyfte
   själv risken att klippa gräset för kort. Koden bekräftade det exakt: `start_mowing`
   har `blade_height` som *valfritt* argument i intervallet 25–70 mm, och tomt fält gav
   `?? 25` — kortets egen miniminivå. Av/på-reglaget (`onoff`) anropar
   `actionPlanAndStartMowing({})` helt utan parametrar och fick samma 25 mm varje gång.
   "Lowest setting" var alltså bokstavligt sant. Det är den rapporten som gjorde
   klipphöjden till nästa steg direkt efter spacing.

   **Medveten begränsning:** `sendBladeHeight` (den separata skriv-inställning-kommandot)
   skickas fortfarande bara när användaren *uttryckligen* angett höjd. Det återekade
   värdet används enbart i ruttplaneringen för just den körningen — ett återekat värde ska
   inte skrivas tillbaka som stående inställning på klipparen.
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
längdfel snarare än enstaka korrupta paket. **Åtgärd:** ✅ hexdump (kapad till 64 byte) vid
avkodningsfel på alla tre ställen (MQTT, BLE, Aliyun MQTT) — landade i första kodcommiten.
**Kvarstår:** längdutredningen kan inte göras ärligt utan en rapport som *bär* dumpen; R1
och R10 loggades före den fanns. Avkodaren (`Codec.ts:111`) matar buffern rakt in i
protobufjs utan egen framing, så `+ 10 >` betyder att ett längdprefix i själva payloaden
pekar 10 byte förbi slutet — trunkerat meddelande eller ett icke-protobuf-tillägg. Vilket,
säger nästa dump.

### G2. BLE-backoff utan tak eller återställning

R5/R8 visar `failure #243`, `#244`, `#245` med 1800 s backoff — flera dygns misslyckade
återanslutningar. Räknaren nollställs bara vid appomstart. Tre olika felmoder hamnar i samma
logik:

| Felmod | Rapport |
|---|---|
| `scan found 0 BLE advertisements` (radion ser ingenting) | R7 |
| Enheten syns aldrig i scannen (13–24 andra hittas) | R5, R8, R1 |
| Enheten hittas men anslutning misslyckas efter 20–37 s | R8, R10 |

**Åtgärd — ✅ implementerad** (`BleTransport.ts`, 7 nya tester i `ble-backoff.test.mjs`):
- **Tre felmoder klassificeras** i loggen i stället för en räknare och ett meddelande:
  `radio_silent` (scan gav noll annonser — R7), `out_of_range` (andra sågs, inte mowern —
  R5/R8/R1, med antalet), `connect_failed` (mowern sågs, länken föll — R8/R10).
- **Radion-tyst-notis en gång:** tre tomma scans i rad ger *en* rad som säger att det pekar
  på hubbens Bluetooth, inte på klipparen. Det är den distinktion R7 behövde.
- **Parkering efter ~6 h utom räckhåll:** efter tröskeln (5) plus 12 till vid 30-minuters-
  takten går transporten till **2 h** mellan försök, loggar *en* parkeringsrad, och sedan
  bara när felmoden *ändras* — inte tre identiska rader varje halvtimme i dagar (#245).
  Vilken lyckad anslutning som helst nollställer allt och loggar "back in range".
- Inget `setWarning` för BLE: molnet är primärt, och för `ble_only`-användare fångar A3:s
  vakthund redan "ingen data alls". Ingen ny koppling behövdes.

### G3. Kommandon kvitteras men utförs inte

R10 är det tydligaste fallet: `generate_route` + `start` skickas elva gånger på 26 minuter,
**alla får `{"code":0,"msg":"Request success"}`**, och mowern kör ändå inte (mowing → paused
→ idle inom 16 sekunder). Användaren ser samtidigt **fel 1417 i Mammotions egen app**.

Vi har alltså ingen återkoppling på om ett kommando faktiskt fick effekt.

**Åtgärd — ✅ implementerad** (`StartOutcome.ts` + `confirmStarted()` i `device.ts`):
- Efter varje start (`start_mowing`, `start_mowing_zone`, on/off, `start_mowing_schedule`)
  bevakas statusen i **25 s**. Utfallet döms rent: `confirmed` (mowing och fortfarande
  mowing vid fönstrets slut), `never_started` (aldrig mowing), eller
  **`started_then_stopped`** — R10:s form exakt: mowing vid +6 s, paused +17 s, idle +22 s.
  De två senare gör att **Flow-kortet felar synligt** med lokaliserad text på 13 språk som
  hänvisar till Mammotion-appen, och loggen får hela tidslinjen plus eventuell felkod som
  mowern pushat under fönstret. Elva "lyckade" starter blir elva tydliga fel.
- **Ärlig transportgräns:** bara på push-transporterna (BLE, MQTT). På `aliyun_legacy`
  kommer status via polling på två minuter eller långsammare — inget kan dömas inom den tid
  ett Flow-kort får ta — så där loggas "sent; not awaiting confirmation" och kortet
  returnerar som förut. R10 var MQTT.
- En kort paus följd av mowing igen inom fönstret räknas som `confirmed`; ett stopp *efter*
  fönstret ändrar inte domen — det är `mower_status_changed`-triggerns sak.

**Kvarstår: felkod 1417.** Fortfarande okänd — pymammotions tabell är inte nåbar härifrån
och `handleErrorCodeMessage` är diagnostisk. R10:s logg hade ingen `[error_code]`-rad, så
mowern pushade den inte via den vägen. Nu *namnges* koden i loggen om den kommer; att
*översätta* den kräver tabellen.

### G4. Loggspam när transporten är nere

R10, 2026-08-10 22:29–23:00: MQTT-servern `8.211.50.191:3083` vägrar anslutningar i ~30
minuter. Appen loopar en gång i minuten genom `initial sync` → `rain protection` →
`zone list` — **tre felrader per försök, ~60 rader**, alla med samma kända orsak. Ingen
backoff: exakt 60 s mellan försöken.

**Åtgärd — ✅ implementerad:**
- **Mekanismen:** `connectMqtt` startar anslutningen fire-and-forget och schemalade sedan
  *ovillkorligt* tre initiala läsningar 2 s senare. Vägrade brokern kom felet via `onClose`
  → återanslutning → samma tre läsningar mot en transport som aldrig kom upp. Nu körs
  läsningarna bara om `mqtt.isConnected` — annars tyst; återanslutningsraden säger redan
  vad som pågår. Två av tre rader per försök borta.
- **Stegen** var linjär (10 s × n, tak 60 s) — från försök 6 en gång i minuten resten av
  avbrottet. Nu `lib/mammotion/mqtt/reconnectBackoff.ts`: **10 s → 20 → 40 → 80 → 160 →
  5 min** platt. Ett 30-minutersavbrott kostar **~9 försök i stället för ~30**; första
  steget är kvar på 10 s så en blipp återhämtas snabbt. Räknaren nollställs på telemetri
  *och* på brokerns online-signal. 3 tester.

---

## H — P2 — Dokumentation och upptäckbarhet

Flera rapporter är inte buggar utan att användare inte hittar det som finns.

1. **Svara i forumtråden** med: `start_mowing_zone` finns (→ R12.4), `mower_job_finished`
   har en `task_name`-token (→ R4.2), `start_mowing_schedule` finns (→ R12.2) — och att man
   behöver v2.5.61. **Utkast klart, uppdaterat till nuläget efter A–G — postas inte utan
   godkännande.** Ligger utanför repot (scratchpad `forum-reply-draft.md`), tillsammans
   med det engelska svaret till R13 (`reply-mowing-pattern.md`).
2. ✅ **Dokumentera pause-tricket.** Nytt README-avsnitt *"Tip: run your saved tasks from
   Homey"* (paus-tricket, kedjning via `task_name`, resume vs. start) och ett nytt stycke i
   App Store-beskrivningen på alla 13 språk (`README.txt` + `README.<lang>.txt`) som nämner
   de tre korten från [§3](#3-redan-löst-i-v2561--men-användarna-vet-inte-om-det),
   `resume_mowing` och paus-tricket. Kortnamnen i varje språk är hämtade ordagrant ur
   `driver.compose.json` så att texten matchar det användaren ser i Flow-editorn.
   Hemsidan (`docs/homepage/index.html`) nämner nu sparade tasks och kedjning.
   README listar även Yuka Mini 2 1000 som bekräftad (R12.4).
3. ✅ **Väntetext vid parning** (R4.1) — **var redan levererad i v2.5.61**
   (`pair.account_setup.note` i alla 13 `locales/*.json`: "After you log in, it can take a
   moment for Homey to find your mower"). Rapportören körde en äldre version. Ingen åtgärd.
4. ✅ **Hinten på `mower_job_finished`** — behöver inte rättas: [C](#c--p1--task-kedjning-fungerar-inte)
   är implementerad, så koden håller nu hintens löfte ("Combine with *Start mowing task* to
   automatically chain the next task") istället för att motsäga det. Hinten står kvar som
   den är.

Dessutom: changelog-post för **v2.5.62** i `.homeychangelog.json` som sammanfattar A–G på
användarspråk, och versionen är höjd i `package.json`/`.homeycompose/app.json` (publicering
är fortfarande manuell via `workflow_dispatch`).

---

## I — P3 — Nya modeller och funktioner

Utrett 2026-09-07 mot pymammotion (`main`, hämtat via raw.githubusercontent.com) och
Mammotion-HA. Inget av detta är byggt — avsnittet är underlag för produktbeslut.

| Önskemål | Rapport | Utfall |
|---|---|---|
| Stöd för Luba 1 | R12.6 | Utrett, se [I1](#i1--luba-1-r126). Kräver beslut. |
| Kamerabild i error-push | R2 | **Blockerat**, se [I2](#i2--kamerabild-i-error-push-r2). Ingen ny väg sedan ROADMAP-noten. |
| Kör till specifik geopunkt | R6 | **Finns inte i protokollet**, se [I3](#i3--geopunkt-r6). Alternativ finns för användningsfallet. |
| Bekräfta Yuka mini 2-stöd | R12.4 | ✅ README och `CLAUDE.md` uppdaterade; Yuka står inte längre som "deferred". |

### I1 — Luba 1 (R12.6)

_(fylls i från arkitektutredningen nedan)_

### I2 — Kamerabild i error-push (R2)

Ingen stillbild går att hämta utan att gå med i Agora-kanalen. Kontrollerat igen mot
pymammotions nuvarande `http/http.py`: de enda kameraanropen är `get_stream_subscription`
(`POST /device-server/v1/stream/token`, returnerar Agora `appid`/`channelName`/`token`/`uid`)
och `get_video_resource` (`GET /device-server/v1/video-resource/{iotId}`); modellen
`http/model/camera_stream.py` innehåller inga bild-URL:er, bara kanal- och token-fält.
`commands/messages/video.py` har enbart `device_agora_join_channel_with_position` och
`refresh_fpv` — det vill säga "gå med i strömmen", inget "ta en bild".

Slutsatsen i `docs/ROADMAP.md` (P3, "Camera / Agora WebRTC") står sig oförändrad: Homeys
kamerastöd förväntar sig antingen en strömbar URL eller generisk SDP-signalering, och
Mammotion levererar råa Agora-SDK-uppgifter, vilket inget av Homeys två integrationsformer
kan ta emot. En bild kräver samma Agora-anslutning som hela strömmen. **Svar till
användaren:** inte möjligt från Homey-appen i dag; hans egen "ordnar det på annat sätt" (t.ex.
en skärmdump från Mammotion-appen eller en separat kamera i Homey) är rätt väg. Återbesök
bara om Mammotions API ändras.

### I3 — Geopunkt (R6)

Protokollet har inget "kör till koordinat"-kommando. Genomgång av pymammotions
`commands/messages/navigation.py` (985 rader, samtliga `def`): all navigering sker över
lagrade områden och jobb — `generate_route_information` över område-hashar, `start_job`,
`return_to_dock`, `break_point_continue` / `break_point_anywhere_continue` (fortsätt jobbet
från sparad brytpunkt respektive nuvarande position), plus kartredigering (gränser, korridorer,
tömningspunkter). `x_move`/`y_move` som förekommer i Mammotion-HA:s `services.yaml` är
SVG-kartplacering (`svg_message_t`), inte navigering.

Det enda positionsstyrande som finns är joystick-körning: `driver.py::send_movement(linear,
angular)` → `DrvMotionCtrl` (`mctrl_driver.proto`), som Mammotion-HA exponerar som fyra
knappar (fram/vänster/höger/bak, `button.py`, helst över BLE med användaren närvarande). Det är
fjärrkontroll med hastigheter, inte målstyrning. Positionen rapporteras i `NavPosUp`
(`x`, `y` i meter i RTK-basens lokala ram, `toward`, `posLevel`), så en "kör till punkt"-funktion
skulle innebära att **appen själv sluter reglerkretsen** — läser position, räknar kurs, skickar
hastigheter tills målet nås — ovanpå en maskin med roterande knivar, utan tillverkarens
hinderundvikning i den lägen. Det är en egenbyggd autopilot, inte en protokollfunktion.

Rekommendation: **bygg inte.** Två skäl som är oberoende av varandra: (1) funktionen finns inte
att exponera, bara att uppfinna; (2) användningsfallet — köra mot rörelse i carporten som
bevakning — är inte avsedd användning, och ansvaret vid tillbud skulle ligga hos appen.

**Alternativ som täcker användningsfallet med det som finns:** rita en liten zon i carporten i
Mammotion-appen och kör `start_mowing_zone` på den från rörelseflödet. Klipparen navigerar dit
med sin egen ruttplanering och hinderundvikning, och kan skickas hem med `send_to_dock` när
rörelsen upphört. Om knivarna inte ska snurra har pymammotion/Mammotion-HA en `is_mow=false`-parameter
på start-kommandot; den är **inte** portad till appens `StartMowOptions` (som i dag har
`bladeHeight`, `speed`, `channelWidth`, `isEdge`, `areas`) — en liten utökning om det
efterfrågas. Det svaret kan gå till användaren utan att något byggs.

---

## 4. Föreslagen ordning

**Steg 1 — diagnostik som är billig och låser upp resten**
- B1: loggrad på normalvägens `return list` (låser upp parningsbuggen)
- G1: hexdump vid protobuf-fel
- Begär in: R3:s logg från fungerande körning, R12.2:s diagnostik med aktuell version,
  det saknade foruminlägget som R12.7 refererar till

**Steg 2 — P0, statusproblemet**
- ✅ A1 budgetsvält — stegvis pacing, jitter, `setWarning`, persistent fönster
- ✅ A2 backoff per orsak, 29004 klassificerad som obunden, räknare persisterad
- ✅ A3 stalet-vakthund, relativ tröskel, `mower_offline` fyras
- Parallellt: utred firmwarekopplingen (A4) och `getRegion 500`-fönstret

**Steg 3 — P0/P1**
- B: parningsbuggen, utifrån vad steg 1 visade
- ✅ C: task-kedjning — implementerad, hårdvaruverifiering kvar
- D: klippparametrar

**Steg 4 — snabba vinster, kan tas när som helst**
- ✅ F: `resume_mowing`-kortet — klart
- ✅ H2: README, App Store-text (13 språk), hemsida, changelog v2.5.62
- ✅ H3: väntetext vid parning — fanns redan i v2.5.61
- ✅ H4: hinten står kvar, C gör den sann
- H1: forumsvar — utkast klart, väntar på godkännande

**Steg 5 — P2/P3**
- ✅ G2–G4 — kvar i G: längdutredningen (väntar på en rapport med hexdump) och 1417
- ✅ I: utrett (Luba 1 scopat, kamera blockerad, geopunkt finns inte, Yuka bekräftad) — beslut kvar
- E

---

## 5. Frågor som behöver Mathias beslut

1. **Klippparametrar (D):** läs-och-återanvänd är påbörjad som första steg. Kvarstår:
   ska `StartMowOptions` exponeras som användarstyrda kontroller alls, eller ska appen
   alltid eka enhetens egna sparade inställningar? Kräver att `channelWidth`-semantiken
   först fastställs mot hårdvara.
2. **Task-kedjning (C):** ska appen dölja pause/vänta-dansen internt, eller ska vi
   dokumentera workarounden och låta användaren bygga den själv?
3. **Geopunkt (R6/I):** ✅ utrett — finns inte i protokollet, rekommendationen är att inte
   bygga och i stället svara med zon-alternativet i [I3](#i3--geopunkt-r6). Kvar: godkänna
   det svaret.
4. **Luba 1 (R12.6):** utredningen är gjord, se [I1](#i1--luba-1-r126). Kvar: välja
   mellan alternativen där.
5. ✅ **`unavailable` vid inaktuell data (A3) — besvarad i implementationen:** varken ett
   värde eller två, utan *relativt*: 3 × det intervall pollslingan själv senast valde, golv
   10 min. Se A3 för resonemanget och testerna som låser att det aldrig krockar med A1/A2.
