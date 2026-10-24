// Test für die characteristic-basierte RCS-Service-Discovery
// (zwiftboard-Vorbild: "Match characteristics by UUID across every
// service ... the service UUID is not needed").
//
// Der Click V2 exponiert die RCS-Characteristics (00000002/0003/0004-19ca-...)
// im Zwift Service 0000fc82-... — nicht im erwarteten 00000001-19ca-...
// Service (nRF-Dump beider Pods: Service 0000fc82, Primary, mit allen
// Characteristics). Zudem liefert Chrome nach dem Connect oft nur eine
// partial Service-Liste (WinRT-Discovery-Timeout).
const { discoverRcsService, } = require('../../src/ble/rcs/discovery.js');

const RCS_SERVICE = '00000001-19ca-4651-86e5-fa29dcdd09d1';
const ZWIFT_SERVICE = '0000fc82-0000-1000-8000-00805f9b34fb';
const ASYNC = '00000002-19ca-4651-86e5-fa29dcdd09d1';
const SYNC_RX = '00000003-19ca-4651-86e5-fa29dcdd09d1';
const SYNC_TX = '00000004-19ca-4651-86e5-fa29dcdd09d1';
const BATTERY = '0000180f-0000-1000-8000-00805f9b34fb';

const RCS_CHARS = [ASYNC, SYNC_RX, SYNC_TX];

function mockService(uuid, charUuids = []) {
    return {
        uuid,
        getCharacteristics: async () => charUuids.map(u => ({uuid: u})),
    };
}

function mockServer(services, opts = {}) {
    const failGetPrimaryService = opts.failGetPrimaryService ?? false;
    return {
        getPrimaryServices: async () => services,
        getPrimaryService: async (uuid) => {
            if (failGetPrimaryService) throw new Error('NotFound');
            const svc = services.find(
                s => (s.uuid || '').toLowerCase() === (uuid || '').toLowerCase()
            );
            if (!svc) throw new Error('NotFound');
            return svc;
        },
    };
}

describe('discoverRcsService (characteristic-basiert, zwiftboard-Vorbild)', () => {
    test('findet den Zwift Service 0000fc82 über gezielte Discovery', async () => {
        const zwiftSvc = mockService(ZWIFT_SERVICE, RCS_CHARS);
        const server = mockServer([mockService(BATTERY), zwiftSvc]);
        const primaryServices = {};

        const res = await discoverRcsService(server, primaryServices, {retryDelayMs: 1});

        expect(res).toBe(zwiftSvc);
        // wird unter der erwarteten UUID eingetragen, damit das weitere
        // Setup (hasService/getService) funktioniert
        expect(primaryServices[RCS_SERVICE]).toBe(zwiftSvc);
    });

    test('findet den 00000001-19ca- Service (ältere Firmware)', async () => {
        const rcsSvc = mockService(RCS_SERVICE, RCS_CHARS);
        const server = mockServer([mockService(BATTERY), rcsSvc]);
        const primaryServices = {};

        const res = await discoverRcsService(server, primaryServices, {retryDelayMs: 1});

        expect(res).toBe(rcsSvc);
        expect(primaryServices[RCS_SERVICE]).toBe(rcsSvc);
    });

    test('gezielte Discovery schlägt fehl -> characteristic-basierter Scan greift', async () => {
        // simuliert: Chrome kennt den Service im Cache nicht (getPrimaryService
        // wirft), die Service-Liste liefert ihn aber
        const zwiftSvc = mockService(ZWIFT_SERVICE, RCS_CHARS);
        const server = mockServer([mockService(BATTERY), zwiftSvc], {failGetPrimaryService: true});
        const primaryServices = {};

        const res = await discoverRcsService(server, primaryServices, {retryDelayMs: 1});

        expect(res).toBe(zwiftSvc);
        expect(primaryServices[RCS_SERVICE]).toBe(zwiftSvc);
    });

    test('Service ohne RCS-Characteristics wird verworfen', async () => {
        const battery = mockService(BATTERY, ['00002a19-0000-1000-8000-00805f9b34fb']);
        const server = mockServer([battery]);
        const primaryServices = {};

        const res = await discoverRcsService(server, primaryServices, {retryDelayMs: 1});

        expect(res).toBe(null);
        expect(Object.keys(primaryServices).length).toBe(0);
    });

    test('kein Service gefunden -> null (kein Throw)', async () => {
        const server = mockServer([mockService(BATTERY)]);
        const primaryServices = {};

        const res = await discoverRcsService(server, primaryServices, {retryDelayMs: 1});

        expect(res).toBe(null);
    });

    test('kein Server / keine API -> null (kein Throw)', async () => {
        expect(await discoverRcsService(null, {}, {retryDelayMs: 1})).toBe(null);
        expect(await discoverRcsService({}, {}, {retryDelayMs: 1})).toBe(null);
        expect(await discoverRcsService(undefined, {}, {retryDelayMs: 1})).toBe(null);
    });
});
