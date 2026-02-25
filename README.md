# Stream RPG Overlay - Komendy Czatowe

Ten dokument opisuje wszystkie komendy, ktore mozna wpisac na czacie i ktore sa obslugiwane przez aplikacje.

## Local dev: admin panel

Minimalny panel admina jest serwowany z backendu pod `/admin` i korzysta z API `/api/admin/*`.
W deploymencie Docker panel wymaga, aby katalog `admin/` byl obecny w obrazie (COPY `admin ./admin`).

1. Ustaw w `.env`:
   - `PORT=3001`
   - `ADMIN_API_TOKEN=<dlugi_losowy_token>`
   - (opcjonalnie na lokalu) `KICK_ENABLED=false`, `TIPPLY_WEBHOOK_ENABLED=false`
2. Uruchom aplikacje:
   - lokalnie: `npm install && npm run dev`
   - Docker: `docker compose -f docker-compose.local.yml up --build`
3. Sprawdz endpointy:
   - health: `http://localhost:3001/health`
   - overlay: `http://localhost:3001/overlay`
   - admin panel: `http://localhost:3001/admin`
4. API admina wymaga headera Bearer:
   - `Authorization: Bearer <ADMIN_API_TOKEN>`
   - opcjonalnie dla audytu: `X-Admin-Actor: twoj_login`
   - przyklad:
     `curl -X POST http://localhost:3001/api/admin/pause -H "Authorization: Bearer <ADMIN_API_TOKEN>"`

Zmiany z panelu sa broadcastowane przez Socket.IO, wiec overlay odswieza sie od razu.

## Role i uprawnienia

- `viewer`: kazdy zwykly widz.
- `mod`: moderator.
- `admin`: administrator (streamer).

Jak aplikacja rozpoznaje role:

- Cloudbot:
  - `admin`: poziom `broadcaster`, `streamer`, `owner` lub `admin`
  - `mod`: poziom `mod` lub `moderator`
  - pozostale poziomy -> `viewer`
- Kick:
  - `admin`: `ADMIN_USERNAME` lub uzytkownik z `KICK_ADMIN_USERS`
  - `mod`: uzytkownik z `KICK_MOD_USERS`
  - pozostali -> `viewer`

`ADMIN_USERNAME` ma uprawnienia admina niezaleznie od zrodla.

## Komendy `viewer`

### `!attack`

- Dostepna dla: `viewer`, `mod`, `admin`
- Dzialanie:
  - zadaje obrazenia bossowi
  - daje `+2 XP`
  - zapisuje timestamp ataku (`last_attack_ms`)
  - zapisuje event `chat_attack`
- Cooldown:
  - `CHAT_ATTACK_COOLDOWN_MS` (domyslnie `60000 ms`)
  - w cooldownie komenda jest ignorowana bez komunikatu
- Gdy boss padnie:
  - zapisywane jest `top 3` po XP jako `phaseWinners`
  - startuje nowa faza
- Uwagi:
  - na Kick (dokladnie `!attack`) dmg skaluje z levelem:
    - `CHAT_ATTACK_DAMAGE + floor((level - 1) * 0.5)`
  - w sciezce Cloudbot dmg to:
    - `clamp(CHAT_ATTACK_DAMAGE, 1, 9999)`

### `!heal`

- Dostepna dla: `viewer`, `mod`, `admin`
- Dzialanie:
  - leczy bossa o `15 HP` (do limitu `bossMaxHp`)
  - daje `+5 XP`
  - zapisuje timestamp heala (`last_heal_ms`)
  - zapisuje event `chat_heal`
- Cooldown:
  - `CHAT_HEAL_COOLDOWN_MS` (domyslnie `120000 ms`)
  - w cooldownie komenda jest ignorowana bez komunikatu
- Uwaga:
  - to celowo "troll heal": podnosi HP bossa

### `!bosshp`

- Dostepna dla: `viewer`, `mod`, `admin`
- Dzialanie:
  - zwraca aktualne HP bossa na czat:
    - `Boss HP: <hp>/<max> (phase <n>)`
- Uwaga:
  - komenda informacyjna, dziala rowniez gdy gra jest w `paused`

### `!xp`

- Dostepna dla: `viewer`, `mod`, `admin`
- Dzialanie:
  - zwraca XP i level autora komendy na czat:
    - `<user>: <xp> XP (lvl <level>)`
- Uwaga:
  - komenda informacyjna, dziala rowniez gdy gra jest w `paused`

### `!stats` (Kick)

- Dostepna dla: `viewer`, `mod`, `admin`
- Dzialanie:
  - zapisuje event `chat_stats`
  - nie wysyla odpowiedzi na overlay i nie wysyla wiadomosci zwrotnej na czat
- Uwaga:
  - ta komenda jest obsluzona tylko na sciezce Kick

## Komendy `mod`

### `!maybechaos`

- Dostepna dla: `mod`, `admin`
- Dzialanie:
  - losuje zadanie z puli `CHAOS_TASKS`
  - ustawia `state.chaosLast = { kind: "TASK", text, ts }`
  - wysyla event do overlay (`chaos` + toast)
  - opcjonalnie strzela webhookiem, jesli ustawione `CHAOS_TASK_WEBHOOK_URL`

### `!makechaos` (alias)

- Dostepna dla: `mod`, `admin`
- Dzialanie:
  - alias do `!maybechaos`
  - efekt identyczny jak wyzej

## Komendy `admin`

Wszystkie ponizsze komendy admina mozna wpisac:

- bezposrednio, np. `!sethp 900`
- albo przez alias `!boss`, np. `!boss sethp 900`

### `!reset` / `!boss reset`

- Dzialanie:
  - resetuje bossa do fazy `1` (`setBossPhase(1)`)
  - HP wraca do max fazy 1
  - dopisuje wpis systemowy do `lastHits`
- Czego NIE robi:
  - nie resetuje XP uzytkownikow
  - nie czysci eventow

### `!sethp <hp>` / `!boss sethp <hp>`

- Dzialanie:
  - ustawia aktualne HP bossa na podana wartosc
  - wartosc jest clampowana do zakresu `0..bossMaxHp`

### `!bosshit <dmg>` / `!boss bosshit <dmg>`

- Dzialanie:
  - zadaje bossowi obrazenia administracyjne
  - zapisuje event `admin_bosshit`
  - przy ubiciu bossa zamyka faze i liczy `phaseWinners`
- Ograniczenia:
  - `dmg` clamp do `0..999999`
  - `dmg <= 0` zwraca blad uzycia: `usage: !bosshit 500`

Dodatkowy format:

- `!bosshit500`
- `!bosshit+500`

### `!phase <n>` / `!boss phase <n>`

- Dzialanie:
  - wymusza faze `n`
  - skaluje `bossMaxHp` zgodnie z mechanika faz
  - ustawia aktualne HP na nowe maksimum fazy
- Ograniczenia:
  - `n` clampowane do `1..9999`

### `!pause` / `!boss pause`

- Dzialanie:
  - ustawia `state.paused = true`
  - blokuje standardowe komendy graczy (`!attack`, `!heal`)

### `!resume` / `!boss resume`

- Dzialanie:
  - ustawia `state.paused = false`
  - przywraca normalne dzialanie komend graczy

### `!setmult <key> <value>` / `!boss setmult <key> <value>`

- Dzialanie:
  - zapisuje runtime override w `state.runtimeOverrides[key] = value`
- Przyklad:
  - `!setmult donate 12`
- Uwaga:
  - to ustawienie jest tylko zapisywane w stanie runtime; nie kazdy klucz musi byc pozniej uzywany przez logike obrazen

### `!clearchaos` / `!boss clearchaos`

- Dzialanie:
  - czysci aktualny chaos (`state.chaosLast = null`)
  - wysyla update do overlay, przez co pole chaos znika

### `!clearhits` / `!boss clearhits`

- Dzialanie:
  - czysci liste ostatnich hitow (`state.lastHits = []`)

### `!resetxp` / `!boss resetxp`

- Dzialanie (SQL):
  - wszystkim uzytkownikom ustawia:
    - `xp = 0`
    - `level = 1`
    - `last_attack_ms = 0`
    - `last_heal_ms = 0`
- Czego NIE robi:
  - nie usuwa historii eventow
  - nie resetuje samego bossa

### `!resetall` / `!boss resetall`

- Dzialanie:
  - resetuje bossa do fazy `1`
  - czysci `lastHits`
  - usuwa wszystkie eventy (`DELETE FROM events`)
  - resetuje wszystkich uzytkownikow (XP/level/cooldowny jak w `resetxp`)

## Zachowanie wspolne

- Nieznane komendy sa ignorowane (brak efektu).
- Gdy komenda wymaga wyzszych uprawnien, backend zwraca `nope`.
- Cooldowny `!attack` i `!heal` sa ciche (bez komunikatu o odrzuceniu).
