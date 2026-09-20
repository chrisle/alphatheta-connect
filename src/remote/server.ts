/**
 * The REST API over a {@link Remote}. JSON in and out; every error is
 * `{"error": "…"}` with a status that says whose fault it was.
 *
 *   GET  /                       who we are, every device heard, the booth's power
 *   GET  /players                the players with their last status
 *   GET  /players/{n}/media      what is in the player's USB and SD slots
 *   POST /players/{n}/play
 *   POST /players/{n}/pause
 *   POST /players/{n}/cue
 *   POST /players/{n}/ff         {"hold_ms": 500}   hold fast-forward, then release
 *   POST /players/{n}/rew        {"hold_ms": 500}
 *   POST /players/{n}/skip       {"direction": "forward" | "backward"}
 *   POST /players/{n}/op         {"op": 26, "press": true}   one raw transport packet
 *   POST /players/{n}/load       {"track_id": 1, "source": {"device": 2, "slot": "usb"}}
 *   GET  /booth                  the Hue group and whether it is on
 *   PUT  /booth                  {"on": true}
 *   POST /booth/on
 *   POST /booth/off
 *   GET  /hue/groups             every room and zone the bridge has
 */
import http from 'http';

import {Logger} from 'src/logger';
import {MediaSlot} from 'src/types';

import {Hue, HueNoGroupError, HueUnconfiguredError} from './hue';
import {CueUnknownError, NoPlayerError, Remote} from './index';

export interface ServerOptions {
  remote: Remote;
  hue: Hue | null;
  /** The Hue room or zone the booth's gear is plugged into. */
  boothGroup: string;
  logger?: Logger;
}

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_HOLD_MS = 30_000;
const DEFAULT_HOLD_MS = 500;

const SLOTS: Record<string, MediaSlot> = {
  rekordbox: MediaSlot.RB,
  rb: MediaSlot.RB,
  usb: MediaSlot.USB,
  sd: MediaSlot.SD,
};

function statusOf(e: unknown) {
  if (e instanceof HttpError) {
    return e.status;
  }
  if (e instanceof NoPlayerError || e instanceof HueNoGroupError) {
    return 404;
  }
  if (e instanceof CueUnknownError || e instanceof HueUnconfiguredError) {
    return 501;
  }
  return 502;
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new HttpError(400, `body is not JSON: ${(e as Error).message}`);
  }
}

function integer(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new HttpError(400, `${name} must be an integer in ${min}..${max}`);
  }
  return value;
}

function holdMs(body: any) {
  if (body.hold_ms === undefined) {
    return DEFAULT_HOLD_MS;
  }
  return integer(body.hold_ms, 'hold_ms', 0, MAX_HOLD_MS);
}

export function createServer({remote, hue, boothGroup, logger}: ServerOptions) {
  const needHue = () => {
    if (hue === null) {
      throw new HueUnconfiguredError();
    }
    return hue;
  };

  const boothState = async () => {
    const group = await needHue().groupNamed(boothGroup);
    return {
      group: group.name,
      id: group.id,
      type: group.type,
      on: group.anyOn,
      all_on: group.allOn,
      lights: group.lights,
    };
  };

  const setBooth = async (on: boolean) => {
    const bridge = needHue();
    const group = await bridge.groupNamed(boothGroup);
    await bridge.setGroupOn(group.id, on);
    logger?.info(`booth "${group.name}" switched ${on ? 'on' : 'off'}`);
    return {group: group.name, on};
  };

  const ok = {ok: true};

  const route = async (method: string, path: string, body: () => Promise<any>) => {
    const parts = path.split('/').filter(p => p !== '');

    if (parts.length === 0 && method === 'GET') {
      const me = remote.me;
      const booth = await boothState().catch(e => ({
        group: boothGroup,
        error: e.message,
      }));
      return {
        stagehand: me && {name: me.name, number: me.id, ip: me.ip.address},
        devices: remote.devices.map(d => ({
          number: d.id,
          name: d.name,
          type: d.type,
          ip: d.ip.address,
        })),
        players: remote.players,
        booth,
      };
    }

    if (parts[0] === 'players') {
      if (parts.length === 1 && method === 'GET') {
        return remote.players;
      }
      const n = parseInt(parts[1], 10);
      if (!Number.isInteger(n)) {
        throw new HttpError(404, `no route ${method} ${path}`);
      }
      const action = parts[2];
      if (parts.length !== 3) {
        throw new HttpError(404, `no route ${method} ${path}`);
      }
      if (method === 'GET' && action === 'media') {
        return remote.media(n);
      }
      if (method !== 'POST') {
        throw new HttpError(405, `${method} not allowed on ${path}`);
      }
      switch (action) {
        case 'play':
          await remote.play(n);
          return ok;
        case 'pause':
          await remote.pause(n);
          return ok;
        case 'cue':
          await remote.cue(n);
          return ok;
        case 'ff':
          await remote.fastForward(n, holdMs(await body()));
          return ok;
        case 'rew':
          await remote.rewind(n, holdMs(await body()));
          return ok;
        case 'skip': {
          const {direction} = await body();
          if (direction === 'forward') {
            await remote.skipForward(n);
          } else if (direction === 'backward') {
            await remote.skipBackward(n);
          } else {
            throw new HttpError(400, 'direction must be "forward" or "backward"');
          }
          return ok;
        }
        case 'op': {
          const b = await body();
          await remote.transport(n, integer(b.op, 'op', 0, 255), b.press !== false);
          return ok;
        }
        case 'load': {
          const b = await body();
          const trackId = integer(b.track_id, 'track_id', 1, 0xffffffff);
          const source = b.source ?? {};
          const device = integer(source.device, 'source.device', 1, 255);
          const slotName = String(source.slot ?? 'rekordbox').toLowerCase();
          const slot = SLOTS[slotName];
          if (slot === undefined) {
            throw new HttpError(400, 'source.slot must be "rekordbox", "usb" or "sd"');
          }
          await remote.loadTrack(n, trackId, {deviceId: device, slot});
          return ok;
        }
        default:
          throw new HttpError(404, `no route ${method} ${path}`);
      }
    }

    if (parts[0] === 'booth') {
      if (parts.length === 1) {
        if (method === 'GET') {
          return boothState();
        }
        if (method === 'PUT') {
          const {on} = await body();
          if (typeof on !== 'boolean') {
            throw new HttpError(400, 'on must be true or false');
          }
          return setBooth(on);
        }
      }
      if (parts.length === 2 && method === 'POST') {
        if (parts[1] === 'on') {
          return setBooth(true);
        }
        if (parts[1] === 'off') {
          return setBooth(false);
        }
      }
    }

    if (
      parts[0] === 'hue' &&
      parts[1] === 'groups' &&
      parts.length === 2 &&
      method === 'GET'
    ) {
      return needHue().groups();
    }

    throw new HttpError(404, `no route ${method} ${path}`);
  };

  return http.createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const path = (req.url ?? '/').split('?')[0];
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, {'content-type': 'application/json'});
      res.end(`${JSON.stringify(payload)}\n`);
    };
    try {
      send(200, await route(method, path, () => readJson(req)));
    } catch (e) {
      const status = statusOf(e);
      const message = e instanceof Error ? e.message : String(e);
      if (status >= 500) {
        logger?.warn(`${method} ${path}: ${message}`);
      }
      send(status, {error: message});
    }
  });
}
