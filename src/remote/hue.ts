/**
 * The Hue bridge: the room or zone the booth's gear is plugged into, switched
 * as one group over the bridge's v1 API (plain HTTP, no certificate dance).
 *
 * The application key comes from `hue pair`, which asks the bridge for one
 * while its link button is pressed, and is kept in a config file.
 */
import {promises as fs} from 'fs';
import {hostname} from 'os';
import path from 'path';

export interface HueConfig {
  bridge: string;
  appKey: string;
}

/**
 * One group as the bridge lists it: a room or a zone.
 */
export interface HueGroup {
  id: string;
  name: string;
  type: string;
  lights: string[];
  /** Every light in the group is on. */
  allOn: boolean;
  /** At least one light in the group is on. */
  anyOn: boolean;
}

export class HueError extends Error {}

/**
 * Raised when nothing has been paired and the environment names no bridge.
 */
export class HueUnconfiguredError extends HueError {
  constructor() {
    super(
      'Hue is not configured: run `alphatheta-remote hue pair` (or set HUE_BRIDGE and HUE_APP_KEY)'
    );
  }
}

/**
 * Raised when the bridge has no group by the name asked for.
 */
export class HueNoGroupError extends HueError {
  constructor(name: string, groups: HueGroup[]) {
    const have = groups.map(g => JSON.stringify(g.name)).join(', ');
    super(`no Hue group named ${JSON.stringify(name)}; the bridge has: ${have}`);
  }
}

const REQUEST_TIMEOUT = 10_000;

export function hueConfigPath() {
  const base =
    process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? '.', '.config');
  return path.join(base, 'alphatheta-remote', 'hue.json');
}

/**
 * The environment first (`HUE_BRIDGE`, `HUE_APP_KEY`), then the file `hue
 * pair` wrote; `null` when neither is there.
 */
export async function loadHueConfig(): Promise<HueConfig | null> {
  const {HUE_BRIDGE, HUE_APP_KEY} = process.env;
  if (HUE_BRIDGE && HUE_APP_KEY) {
    return {bridge: HUE_BRIDGE, appKey: HUE_APP_KEY};
  }
  try {
    const text = await fs.readFile(hueConfigPath(), 'utf8');
    const parsed = JSON.parse(text);
    if (typeof parsed.bridge !== 'string' || typeof parsed.appKey !== 'string') {
      throw new HueError(`${hueConfigPath()}: expected {bridge, appKey}`);
    }
    return {bridge: parsed.bridge, appKey: parsed.appKey};
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw e;
  }
}

export async function saveHueConfig(config: HueConfig) {
  const file = hueConfigPath();
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, {mode: 0o600});
  return file;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
  if (!response.ok) {
    throw new HueError(`hue bridge: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/**
 * A v1 reply is a list of `{success: …}` / `{error: …}` items; any error
 * item fails the call.
 */
function bridgeErrors(reply: unknown) {
  if (!Array.isArray(reply)) {
    return;
  }
  const errors = reply
    .map(item => item?.error?.description)
    .filter((d): d is string => typeof d === 'string');
  if (errors.length > 0) {
    throw new HueError(`hue bridge answered: ${errors.join('; ')}`);
  }
}

export class Hue {
  #config: HueConfig;

  constructor(config: HueConfig) {
    this.#config = config;
  }

  get bridge() {
    return this.#config.bridge;
  }

  #url(tail: string) {
    return `http://${this.#config.bridge}/api/${this.#config.appKey}/${tail}`;
  }

  /**
   * Every room and zone on the bridge, by name.
   */
  async groups(): Promise<HueGroup[]> {
    type Raw = Record<
      string,
      {
        name: string;
        type: string;
        lights?: string[];
        state?: {all_on?: boolean; any_on?: boolean};
      }
    >;
    const raw = await request<Raw>(this.#url('groups'));
    bridgeErrors(raw);
    return Object.entries(raw)
      .map(([id, g]) => ({
        id,
        name: g.name,
        type: g.type,
        lights: g.lights ?? [],
        allOn: g.state?.all_on ?? false,
        anyOn: g.state?.any_on ?? false,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * The group called `name`, matched without regard to case.
   */
  async groupNamed(name: string): Promise<HueGroup> {
    const groups = await this.groups();
    const wanted = name.trim().toLowerCase();
    const group = groups.find(g => g.name.trim().toLowerCase() === wanted);
    if (group === undefined) {
      throw new HueNoGroupError(name, groups);
    }
    return group;
  }

  /**
   * Switch every light (and plug) in the group.
   */
  async setGroupOn(groupId: string, on: boolean) {
    const reply = await request(this.#url(`groups/${groupId}/action`), {
      method: 'PUT',
      body: JSON.stringify({on}),
    });
    bridgeErrors(reply);
  }
}

/**
 * Ask the bridge for an application key. The bridge only issues one in the
 * thirty seconds after its link button is pressed, so this asks once a second
 * until it does or `waitMs` runs out.
 */
export async function pairHue(bridge: string, waitMs = 60_000): Promise<HueConfig> {
  const deadline = Date.now() + waitMs;
  // The bridge takes `<application>#<device>` with the device name at most
  // 19 characters, so the host's name is cut at its first dot and there.
  const host = hostname().split('.')[0].slice(0, 19);
  const body = JSON.stringify({devicetype: `alphatheta-remote#${host}`});
  for (;;) {
    const reply = await request<any[]>(`http://${bridge}/api`, {method: 'POST', body});
    const key = reply?.[0]?.success?.username;
    if (typeof key === 'string') {
      return {bridge, appKey: key};
    }
    const linkButtonNotPressed = reply?.[0]?.error?.type === 101;
    if (!linkButtonNotPressed) {
      bridgeErrors(reply);
    }
    if (Date.now() >= deadline) {
      throw new HueError('hue bridge: link button was not pressed in time');
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

/**
 * Where the bridge is: `HUE_BRIDGE`, else Signify's discovery service, which
 * lists the bridges that have phoned home from this public address.
 */
export async function discoverHueBridge(): Promise<string> {
  if (process.env.HUE_BRIDGE) {
    return process.env.HUE_BRIDGE;
  }
  const found = await request<Array<{internalipaddress: string}>>(
    'https://discovery.meethue.com'
  );
  const bridge = found[0]?.internalipaddress;
  if (bridge === undefined) {
    throw new HueError('no Hue bridge found; set HUE_BRIDGE to its address');
  }
  return bridge;
}
