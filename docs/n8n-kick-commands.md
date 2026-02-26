# n8n -> Kick Chat Commands -> RPG Overlay

Docelowy przeplyw:

Kick chat -> n8n workflow -> `POST /api/cmd` -> overlay toast/state update.

Backend nie odpisuje na czat Kick (overlay-only).

## 1) Trigger w n8n

Uzyj node'a, ktory czyta wiadomosci Kick chat (np. websocket/trigger).

Z wiadomosci wyciagnij:
- `user` (nick autora)
- `text` (tresc wiadomosci)
- `level` (`viewer` / `mod` / `admin`, jesli dostepne)
- `isSub` (`true` / `false`, jesli dostepne)
- `messageId` (unikalny ID wiadomosci, jesli dostepny)
- `ts` (timestamp z triggera)

## 2) Filtr komend

Dodaj warunek:
- tylko wiadomosci, gdzie `text` zaczyna sie od `!`

Reszte ignoruj.

## 3) HTTP Request do aplikacji

Node: HTTP Request

- Method: `POST`
- URL: `https://rpg-overlay.olcha.cloud/api/cmd?secret=<CMD_WEBHOOK_SECRET>`
  - alternatywnie: bez query, z headerem `x-cmd-secret: <CMD_WEBHOOK_SECRET>`
- Body Content Type: JSON
- Body:

```json
{
  "user": "nick",
  "text": "!attack",
  "level": "viewer",
  "isSub": false,
  "source": "n8n",
  "messageId": "optional-id",
  "ts": 1730000000000
}
```

## 4) Retry i timeout

Ustaw:
- timeout: wg standardu n8n dla HTTP node
- retry: `2-3`

App ma deduplikacje po `messageId` (TTL ~5 min, limit 500), wiec retry nie powinien naliczyc ataku 2x.

## 5) Oczekiwana odpowiedz API

Przy poprawnym wywolaniu:

```json
{
  "ok": true,
  "result": {
    "ok": true
  }
}
```

Przy zduplikowanym `messageId`:

```json
{
  "ok": true,
  "result": {
    "ok": true,
    "dedup": true
  }
}
```
