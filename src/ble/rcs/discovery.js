//
// RCS-Service-Discovery für den Zwift Click V2 (zwiftboard-Vorbild).
//
// Der Click V2 exponiert die RCS-Characteristics (00000002/0003/0004-19ca-...)
// im Zwift Service 0000fc82-... — NICHT im erwarteten 00000001-19ca-...
// Service (nRF-Dump beider Pods: Service 0000fc82, Primary, mit allen
// Characteristics). Zudem liefert Chrome nach dem Connect oft nur eine
// partial Service-Liste (WinRT-Discovery-Timeout ~180s, danach nur z.B.
// battery).
//
// Vorgehen (nach zwiftboard ble.go: "Match characteristics by UUID across
// every service ... the service UUID is not needed"):
//   1. gezielte Service-Discovery per UUID (beide bekannten UUIDs)
//   2. Retry: WinRT liefert manchmal erst beim zweiten Zugriff das
//      vollständige Ergebnis
//   3. characteristic-basierter Scan über alle Services
//
import { exists, wait, print, } from '../../functions.js';
import { uuids, } from '../web-ble.js';

// BluetoothRemoteGATTServer, {}, {retryDelayMs} -> BluetoothRemoteGATTService?
async function discoverRcsService(server, primaryServices, opts = {}) {
    const retryDelayMs = opts.retryDelayMs ?? 1000;

    if (!exists(server)) return null;

    const rcsCharUuids = [
        uuids.raceControllerMeasurement,
        uuids.raceControllerControlPoint,
        uuids.raceControllerResponse,
    ];

    // enthält der Service die drei RCS-Characteristics?
    async function hasRcsCharacteristics(svc) {
        if (!exists(svc) || !exists(svc.getCharacteristics)) return false;
        try {
            const chars = await svc.getCharacteristics();
            const charUuids = chars.map(c => (c.uuid || '').toLowerCase());
            return rcsCharUuids.every(u => charUuids.includes(u));
        } catch (e) {
            // Service nicht freigegeben (optionalServices) oder partial
            return false;
        }
    }

    async function tryGetService(uuid) {
        if (!exists(server.getPrimaryService)) return null;
        try {
            const svc = await server.getPrimaryService(uuid);
            if (await hasRcsCharacteristics(svc)) return svc;
            return null;
        } catch (e) {
            return null; // NotFound
        }
    }

    async function scanAllServices() {
        if (!exists(server.getPrimaryServices)) return null;
        let svcs = [];
        try {
            svcs = await server.getPrimaryServices();
        } catch (e) {
            return null;
        }
        for (const svc of svcs) {
            if (await hasRcsCharacteristics(svc)) return svc;
        }
        return null;
    }

    // unter der erwarteten UUID eintragen, damit hasService/getService im
    // weiteren Setup funktionieren — egal welche reale Service-UUID der Pod
    // nutzt (00000001-19ca-... oder 0000fc82-...)
    function register(svc) {
        primaryServices[uuids.raceController] = svc;
        print.log(`ble: rcs: discovery: RCS service gefunden (uuid: ${svc.uuid})`);
        return svc;
    }

    // 1. gezielte Discovery per UUID (beide bekannten Service-UUIDs)
    for (const uuid of [uuids.raceController, uuids.raceControllerZwift]) {
        const svc = await tryGetService(uuid);
        if (exists(svc)) return register(svc);
    }

    // 2. Retry: WinRT partial listing — nachliefern
    for (let i = 0; i < 2; i++) {
        await wait(retryDelayMs);
        print.log(`ble: rcs: discovery: retry ${i + 1}/2`);
        const svc = await scanAllServices();
        if (exists(svc)) return register(svc);
        for (const uuid of [uuids.raceController, uuids.raceControllerZwift]) {
            const s = await tryGetService(uuid);
            if (exists(s)) return register(s);
        }
    }

    print.warn(`ble: rcs: discovery: fehlgeschlagen — Pod locked/schlafend oder Chrome-GATT-Cache stale (Gerät in chrome://bluetooth-internals forget + neu pairen)`);
    return null;
}

export {
    discoverRcsService,
};

export default discoverRcsService;
