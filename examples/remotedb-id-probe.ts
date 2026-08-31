/**
 * RemoteDB Device-ID Probe
 *
 * Empirically tests which device IDs a player will answer remotedb metadata
 * queries for. The library assumes a host announcing an ID outside 1-6 cannot
 * use the remotedb at all (REMOTEDB_MAX_DEVICE_ID); the dysentery analysis
 * instead says what matters is the requesting-device byte *inside* the query,
 * and gives different rules for it (1-4, present on the network, not the
 * player being queried). This probe separates the two claims:
 *
 * - The network announces itself once, as --vcdj (default 7).
 * - It then opens an independent remotedb connection per candidate ID in
 *   --ids, introducing itself with that ID and requesting metadata for the
 *   track currently loaded on the target player.
 *
 * Setup: a player on the Pro DJ Link network with a track loaded from its own
 * USB. Run from the package root:
 *
 *   npx ts-node examples/remotedb-id-probe.ts [--vcdj 7] [--player 2] [--ids 7,5,4,1,2,15,33]
 *
 * Pass --fixed to skip the matrix and instead query through the network's own
 * RemoteDatabase — the path the library actually uses — verifying that it
 * picks a working in-protocol ID on its own.
 *
 * Findings from the first run (2026-08-30, CDJ-3000 ×2 as players 1/2 behind
 * a DJM-V5, announced as VCDJ 7 throughout): D=1-6 all ANSWERED — including
 * absent players and the target's own ID — while D=7, 15, and 33 were
 * silently ignored (Introduce succeeds, the query never gets a response).
 */

import {bringOnline} from 'src/network';
import RemoteDatabase, {MenuTarget, Query} from 'src/remotedb';
import {CDJStatus, Device, DeviceType} from 'src/types';
import {getMatchingInterface} from 'src/utils';

const args = process.argv.slice(2);
const getArg = (key: string, fallback: string) => {
  const idx = args.indexOf(`--${key}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
};

const ANNOUNCE_ID = parseInt(getArg('vcdj', '7'), 10);
const TARGET_PLAYER = parseInt(getArg('player', '2'), 10);
const CANDIDATE_IDS = getArg('ids', '7,5,4,1,2,15,33')
  .split(',')
  .map(s => parseInt(s.trim(), 10));
const STEP_TIMEOUT_MS = 10_000;

const withTimeout = <T>(p: Promise<T>, label: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${STEP_TIMEOUT_MS}ms`)),
        STEP_TIMEOUT_MS
      )
    ),
  ]);

async function main() {
  const network = await bringOnline();
  console.log(`Waiting for a device announce to pick the interface...`);

  const firstDevice = await new Promise<Device>(resolve =>
    network.deviceManager.once('connected', resolve)
  );
  const iface = getMatchingInterface(firstDevice.ip);
  if (!iface || iface.family !== 'IPv4') {
    throw new Error('Unable to determine network interface');
  }

  network.configure({iface, vcdjId: ANNOUNCE_ID, fullStartup: true});
  await network.connect();
  console.log(`Announced as VCDJ ${ANNOUNCE_ID} on ${iface.address}\n`);

  network.deviceManager.on('connected', d =>
    console.log(`  device ${d.id}: ${d.name} (${DeviceType[d.type]}) @ ${d.ip.address}`)
  );

  // Wait for a status packet from the target player that has a track loaded
  console.log(`Waiting for player ${TARGET_PLAYER} to report a loaded track...`);
  const state = await new Promise<CDJStatus.State>(resolve => {
    const onStatus = (s: CDJStatus.State) => {
      if (s.deviceId !== TARGET_PLAYER) {
        return;
      }
      if (s.trackId === 0) {
        return; // nothing loaded yet
      }
      network.statusEmitter!.off('status', onStatus);
      resolve(s);
    };
    network.statusEmitter!.on('status', onStatus);
  });

  const targetId = state.trackDeviceId;
  const target = network.deviceManager.devices.get(targetId);
  if (!target) {
    throw new Error(
      `Track is loaded from device ${targetId}, which is not on the network`
    );
  }

  console.log(
    `Track ${state.trackId} loaded from device ${targetId} slot ${state.trackSlot} type ${state.trackType}\n`
  );

  const queryDescriptor = {
    menuTarget: MenuTarget.Main,
    trackSlot: state.trackSlot,
    trackType: state.trackType,
  };

  if (args.includes('--fixed')) {
    const queryInterface = await withTimeout(
      network.remotedb!.get(targetId),
      'connect/introduce'
    );
    if (queryInterface === null) {
      throw new Error('device exports no remotedb service');
    }
    const track = await withTimeout(
      queryInterface.query({
        query: Query.GetMetadata,
        queryDescriptor,
        args: {trackId: state.trackId},
      }),
      'GetMetadata'
    );
    console.log(
      `Library-picked query ID ANSWERED: ${track.artist?.name ?? '?'} - ${track.title}`
    );
    process.exit(0);
  }

  const results: Array<{id: number; outcome: string}> = [];

  for (const id of CANDIDATE_IDS) {
    // An independent RemoteDatabase per candidate: its own TCP connection,
    // introducing itself with this ID, which is also the requesting-device
    // byte in the query itself. pickQueryId is off so out-of-range candidates
    // reach the wire raw instead of being substituted with a working ID.
    const hostDevice = {...target, id, name: 'probe'} as Device;
    const rdb = new RemoteDatabase(network.deviceManager, hostDevice, {
      pickQueryId: false,
    });
    process.stdout.write(`D=${String(id).padStart(2)} ... `);

    try {
      const queryInterface = await withTimeout(rdb.get(targetId), 'connect/introduce');
      if (queryInterface === null) {
        throw new Error('device exports no remotedb service');
      }

      const track = await withTimeout(
        queryInterface.query({
          query: Query.GetMetadata,
          queryDescriptor,
          args: {trackId: state.trackId},
        }),
        'GetMetadata'
      );

      const outcome = `ANSWERED: ${track.artist?.name ?? '?'} - ${track.title}`;
      console.log(outcome);
      results.push({id, outcome});
    } catch (err) {
      const outcome = `FAILED: ${err instanceof Error ? err.message : String(err)}`;
      console.log(outcome);
      results.push({id, outcome});
    } finally {
      try {
        await withTimeout(rdb.disconnectFromDevice(target), 'disconnect');
      } catch {
        // the socket may already be dead; the next candidate opens its own
      }
    }
  }

  console.log(
    `\n=== Results (announced as VCDJ ${ANNOUNCE_ID}, querying device ${targetId}) ===`
  );
  for (const {id, outcome} of results) {
    console.log(`  D=${String(id).padStart(2)}  ${outcome}`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
