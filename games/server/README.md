# Baby Cheetah save server

A small service that keeps one saved game (stars, stickers, letters, math, settings and artwork) per **family code**, so every device shows the same history.

- No accounts and no personal details. The 12-character family code is the only key; treat it like a password.
- Data is JSON files on a Fly volume mounted at `/data`.
- One file of code (`server.js`), no dependencies.

## Deploy to Fly.io (one time)

From this folder, with `flyctl` installed and signed in to the Fly account:

```sh
fly apps create baby-cheetah-save            # pick any free name; put the same name in fly.toml
fly volumes create cheetah_data --size 1 --region sjc --app baby-cheetah-save --yes
fly deploy
```

Check it: `https://<app name>.fly.dev/healthz` should answer `{"ok":true,...}`.

## Point the game at it

Put the address in `games/sync-config.json`:

```json
{ "url": "https://baby-cheetah-save.fly.dev" }
```

then run `node games/build-app.js` and push. The game then shows "Save to the family server" in the grown-ups settings.

## Updating

`fly deploy` again after any change to `server.js`. The volume and its saved games are kept.

## API

| Request | What it does |
|---|---|
| `GET /healthz` | health check |
| `GET /v1/s/<code>/progress` | the progress record, or 404 if the code has no saved game |
| `PUT /v1/s/<code>/progress` | replace the progress record (creates the family on first use) |
| `GET /v1/s/<code>/art` | list of picture ids |
| `GET` / `PUT` / `DELETE /v1/s/<code>/art/<id>` | one picture: `{ "u": "data:image/...", "t": 1234567890 }` |

Limits (environment variables): `MAX_FAMILIES` (default 200), `MAX_ART` per family (default 2000).
