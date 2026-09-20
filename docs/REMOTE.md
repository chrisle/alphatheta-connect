# alphatheta-remote

A CDJ remote for integration tests and hand use. It joins the Pro DJ Link
network as a Stagehand (the iPad app's persona, the one players accept
transport commands from), serves a REST API to drive the players, and switches
the booth's power through the Hue room its gear is plugged into.

This package provides the pieces (`Remote`, `Hue`, `createRemoteServer`); the
CLI lives in the Now Playing monorepo at `dev-tools/alphatheta-remote`.

```
yarn build                                       # here, so lib/ has the exports
../../dev-tools/alphatheta-remote/alphatheta-remote serve --iface en11
../../dev-tools/alphatheta-remote/alphatheta-remote hue pair   # press the bridge's link button
../../dev-tools/alphatheta-remote/alphatheta-remote hue groups
```

Options for `serve`: `--iface <name|ip>` (default: the interface the first
player heard is on), `--number <141-211>` (default: derived from the
interface's MAC, so it is the same on every run), `--port` (5030), `--booth`
(`DJ Booth`), `--cue-op <byte>`, `--no-hue`, `--verbose`. Each has an
environment variable (`ALPHATHETA_REMOTE_IFACE`, `_NUMBER`, `_PORT`, `_GROUP`,
`_CUE_OP`). `HUE_BRIDGE` and `HUE_APP_KEY` stand in for the paired config file
(`~/.config/alphatheta-remote/hue.json`).

rekordbox and anything else on the link hold ports 50000–50002; quit them (and
rekordboxAgent) first.

## The API

JSON in and out. Errors are `{"error": "…"}`: 404 for a player or group that is
not there, 400 for a bad body, 501 for what is not configured (Hue) or not known
(cue), 502 when the link or the bridge fails.

| Route | Body | What it does |
| --- | --- | --- |
| `GET /` | | who we are, every device heard, the players, the booth's power |
| `GET /players` | | the players with the last status each sent (`CDJStatus.State`) |
| `GET /players/{n}/media` | | what is in the player's USB and SD slots |
| `POST /players/{n}/play` | | |
| `POST /players/{n}/pause` | | |
| `POST /players/{n}/cue` | | needs `--cue-op`; see below |
| `POST /players/{n}/ff` | `{"hold_ms": 500}` | hold fast-forward, then release |
| `POST /players/{n}/rew` | `{"hold_ms": 500}` | hold rewind, then release |
| `POST /players/{n}/skip` | `{"direction": "forward"}` | track skip |
| `POST /players/{n}/op` | `{"op": 26, "press": true}` | one raw transport packet |
| `POST /players/{n}/load` | `{"track_id": 1, "source": {"device": 2, "slot": "usb"}}` | the Load Track command; slot `usb`, `sd` or `rekordbox` |
| `GET /booth` | | the Hue group and whether it is on |
| `PUT /booth` | `{"on": true}` | |
| `POST /booth/on`, `POST /booth/off` | | |
| `GET /hue/groups` | | every room and zone the bridge has |

The same is available in-process: `Remote.join(...)` and
`createRemoteServer(...)` from the package.

## What is verified on hardware (CDJ-3000, 2026-09-19)

- Join, device discovery, live player status and media queries.
- `load`: a track from player 2's USB stick loaded onto player 1 (the player
  answered and its status showed the track, cued, with its BPM).
- `load` from a **rekordbox source over the link** (`source.slot: "rekordbox"`,
  device 17 = rbxport's link export on another Mac): player 1 loaded the
  track and its status named it, device 17, slot 4, cued, with the BPM
  (2026-09-19, remote on chris-m2-mac's wired interface, firmware 3.20).
  Only from a host whose address has claimed under **one** identity since
  the player last booted - see below. **Seen once and not reproduced:** later
  that day, both players freshly power-cycled and the remote the only
  identity from its address, the same `0x19` (checked byte for byte with
  tcpdump on the remote's host) drew no `0x1a` and no metadata request on
  three runs, while the link-export host's own `0x19` (device 17, type
  `04`) was acked within 1 ms. Treat `load` from a rekordbox source as
  unverified until the discriminator is found; rbxport's real-deck test
  pushes through the app instead.

## What is not, yet

- **Transport (play, pause, ff, rew, skip).** The packets are now byte for byte
  what the iPad app sends (captured, pinned in `tests/control`), but the two
  CDJ-3000s on the test LAN did not act on them from this host. The players
  also did not answer the Stagehand heartbeat (`0x68`) with their `0x69` state
  the way they do for the app. The library's own note applies: a CDJ-3000
  keeps one record per peer address and ignores a later claim from that
  address under another number or MAC until it reboots, and this host had
  presented several identities that day (rekordbox, then Stagehand under
  random numbers). The number is now stable per interface. The next step is a
  player power-cycle (which is what `POST /booth/off` / `on` is for) and a
  retest.

  Retested 2026-09-19 from a second Mac (chris-m2-mac, wired, a fresh
  address the players had no record of, the stable number): still not
  honoured, and still no `0x69` to the heartbeat and no `0x0b` push, while
  `load` from the same identity worked. Also tried, each alone, by replaying
  the pinned frames from a script: the keep-alive's member counter at
  `0x30` set to the number of other devices (the iPad's value); a fresh
  ephemeral source port per unicast datagram, as the iPad sends; the
  broadcasts from ephemeral ports too (then the player sent the host nothing
  at all); a fresh number and claim MAC per run. None paired. The mixer-style
  fader-start packet (`0x02` on 50001) is ignored as well. So the stale-record
  theory is not the whole story. Every iPad capture had a DJM-A9 on the
  network; this LAN has a DJM-V5, which never sends the paired `06 02`
  keep-alive - whether pairing needs the A9 is the open question
  (hypothesis, untested).

  What *does* break `load`: claiming from the remote's address under other
  numbers or MACs while the players are up (a probe script did, 2026-09-19).
  Afterwards both players kept unicasting status to the remote's original
  identity but dropped its Load Track, and served the newer numbers nothing.
  Recovery is a player power-cycle. One identity per address, always.
- **Cue.** The Stagehand app has no cue button, so no cue opcode was captured.
  `--cue-op` takes one once it is found; `POST /players/{n}/op` is there to
  probe for it.
