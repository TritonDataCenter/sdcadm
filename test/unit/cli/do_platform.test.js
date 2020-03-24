/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

'use strict';

/*
 * Mocking stuff, to be moved into its own file
 */

const EventEmitter = require('events').EventEmitter;
const util = require('util');

const mockery = require('mockery');
const tabula = require('tabula');

// --- Mock base class

function Mock() {
    this.CALLS = {};
    this.VALUES = {};
}


Mock.prototype._handle = function (name, args, cb) {
    if (!this.CALLS.hasOwnProperty(name)) {
        this.CALLS[name] = [];
    }
    this.CALLS[name].push(args);

    if (!this.VALUES.hasOwnProperty(name)) {
        return cb(new Error(name + ' mock error: no data specified'));
    }

    var nextVal = this.VALUES[name].shift();
    if (!nextVal) {
        return cb(new Error(name + ' mock error: no call data specified'));
    }

    var err = nextVal.err || null;
    var res = nextVal.res;
    if (!err && typeof (res) === 'undefined') {
        return cb(new Error(name + ' mock error: no err or res specified'));
    }

    return cb(err, res);
};

// We don't need anything but exit code for platform testing:
function MockSpawn(command, args, opts) {
    this.command = command;
    this.args = args;
    this.opts = opts;

    EventEmitter.call(this);
    process.nextTick(() => {
        this.emit('exit', 0);
    });
}

util.inherits(MockSpawn, EventEmitter);

function Mocks() {
    this.mocks = Mocks.createMocks();

    mockery.enable({ useCleanCache: true });
    mockery.warnOnUnregistered(true);
    [
        './errors',
        'util',
        'tabula',
        'assert',
        'assert-plus',
        'stream',
        'vasync',
        'extsprintf',
        'cmdln',
        'verror',
        'dashdash',
        'os',
        'path',
        'core-util-is',
        'events',
        'child_process',
        'fs',
        '../../../lib/platform'
    ].forEach(function (mod) {
        mockery.registerAllowable(mod);
    });

    mockery.registerMock('sdc-clients', this.mocks.sdcClients);
    mockery.registerMock('./common', this.mocks.common);
    mockery.registerMock('child_process', this.mocks.cp);
    mockery.registerMock('fs', this.mocks.fs);
}

Mocks.createMocks = function () {
    const mocks = {};

    // NAPI:
    mocks.napi = new Mock();
    mocks.napi.listNetworkPools = function (params, cb) {
        return this._handle('listNetworkPools', {
            params: params
        }, cb);
    };

    mocks.napi.listNics = function (params, opts, cb) {
        if (typeof (opts) === 'function') {
            cb = opts;
            opts = {};
        }
        return this._handle('listNetworkPools', {
            params: params
        }, cb);
    };

    // CNAPI:
    mocks.cnapi = new Mock();

    mocks.cnapi.getBootParams = function (uuid, cb) {
        return this._handle('getBootParams', {
            uuid: uuid
        }, cb);
    };

    mocks.cnapi.setBootParams = function (uuid, params, opts, cb) {
        if (typeof (opts) === 'function') {
            cb = opts;
            opts = {};
        }
        return this._handle('setBootParams', {
            uuid: uuid,
            params: params
        }, cb);
    };

    mocks.cnapi.listPlatforms = function (opts, cb) {
        return this._handle('listPlatforms', {
            opts: opts
        }, cb);
    };

    mocks.cnapi.listServers = function (opts, cb) {
        return this._handle('listServers', {
            opts: opts
        }, cb);
    };

    mocks.cnapi.commandExecute =
        function (server, script, params, cb) {
        return this._handle('commandExecute', {
            server: server,
            script: script,
            params: params
        }, cb);
    };

    mocks.imgapi = new Mock();

    mocks.imgapi.listImages = function (filters, cb) {
        return this._handle('listImages', {
            filters: filters
        }, cb);
    };

    mocks.imgapi.getImage = function (uuid, cb) {
        return this._handle('getImage', {
            uuid: uuid
        }, cb);
    };

    mocks.imgapi.getImageFile = function (uuid, filepath, cb) {
        return this._handle('getImageFile', {
            uuid: uuid,
            filepath: filepath
        }, cb);
    };

    // sdc-clients

    mocks.sdcClients = {
        CNAPI: function FakeCNAPI() { },
        NAPI: function FakeNAPI() { },
        IMGAPI: function FakeIMGAPI() {}
    };

    mocks.common = new Mock();

    mocks.common.isUsbKeyMounted = function (log, cb) {
        return this._handle('isUsbKeyMounted', {
            log: log
        }, cb);
    };

    mocks.common.mountUsbKey = function (log, cb) {
        return this._handle('mountUsbKey', {
            log: log
        }, cb);
    };

    mocks.common.unmountUsbKey = function (log, cb) {
        return this._handle('unmountUsbKey', {
            log: log
        }, cb);
    };

    mocks.common.execFilePlus = function (args, cb) {
        return this._handle('execFilePlus', {
            args: args
        }, cb);
    };

    mocks.common.sortArrayOfObjects = tabula.sortArrayOfObjects;
    mocks.common.indent = console.log;
    mocks.common.promptYesNo = function (_opts, cb) {
        cb();
    };

    mocks.cp = {
        spawn: function (cmd, args, opts) {
            return (new MockSpawn(cmd, args, opts));
        }
    };

    mocks.fs = {
        unlink: function (_filepath, cb) {
            return cb(null);
        },
        existsSync: function (_filepath) {
            return false;
        }
    };

    return mocks;
};

/*
 * Real Platform testing goes here
 */
const jsprim = require('jsprim');
const testutil = require('../testutil');
const tap = require('tap');
const log = testutil.createBunyanLogger(tap);


// Note this is *intentionally* a list of platforms containing some possible
// 'errors', like Platform Versions which lack any OS and should be ignored.
const PLATFORMS_LIST = {
    '20200304T133736Z': {
        'os': 'smartos'
    },
    '20200310T072029Z': {
        'os': 'linux'
    },
    '20200310T172203Z': {},
    '20200313T113022Z': {
        'os': 'smartos'
    },
    '20200313T161129Z': {
        'os': 'linux',
        'latest': true
    },
    '20200317T114808Z': {
        'os': 'smartos',
        'latest': true
    }
};


const IMGADM_LIST_SMARTOS = [
    {
        'v': 2,
        'uuid': 'f9b3caf0-c217-46af-8692-147d44de85c6',
        'name': 'platform',
        'version': 'master-20200304T133736Z',
        'published_at': '2020-03-04T16:23:09.800Z',
        'os': 'smartos'
    },
    {
        'v': 2,
        'uuid': '7cb03032-fa99-48c9-af81-9aed97d76996',
        'name': 'platform',
        'version': 'master-20200313T113022Z',
        'published_at': '2020-03-13T14:21:06.384Z',
        'os': 'smartos'
    },
    {
        'v': 2,
        'uuid': 'eb38fd9d-e367-4587-873b-22917949907b',
        'name': 'platform',
        'version': 'master-20200320T115353Z',
        'published_at': '2020-03-20T14:39:50.627Z',
        'os': 'smartos'
    }
];

const IMGADM_LIST_LINUX = [
    {
        'v': 2,
        'uuid': '73d040d0-9606-4074-99c9-9299d9273d17',
        'name': 'platform-linux',
        'version': 'master-20200310T072029Z',
        'published_at': '2020-03-10T16:23:09.800Z',
        'os': 'linux'
    },
    {
        'v': 2,
        'uuid': '5da3f259-7f80-4897-82df-f120935fcccf',
        'name': 'platform-linux',
        'version': 'master-20200313T161129Z',
        'published_at': '2020-03-13T14:21:06.384Z',
        'os': 'linux'
    },
    {
        'v': 2,
        'uuid': 'd198e28a-2d66-436d-a530-b26941a86d62',
        'name': 'platform-linux',
        'version': 'master-20200320T115353Z',
        'published_at': '2020-03-20T14:39:50.627Z',
        'os': 'linux'
    }
];

const DEFAULT_BOOT_PARAMS = {
    'platform': '20200304T133736Z',
    'kernel_args': {
        'rabbitmq': 'guest:guest:10.99.99.20:5672',
        'smt_enabled': true,
        'rabbitmq_dns': 'guest:guest:rabbitmq.coal.joyent.us:5672'
    },
    'kernel_flags': {},
    'boot_modules': [],
    'default_console': 'serial',
    'serial': 'ttyb'
};

const SERVER_LIST = [
    {
        uuid: '564d99da-f14e-94aa-d8b9-18e5c9d50ba6',
        hostname: 'headnode',
        current_platform: '20200304T133736Z',
        boot_platform: '20200313T113022Z',
        headnode: true
    },
    {
        uuid: '564d98bb-68c2-7688-1b89-cbe1ad480216',
        hostname: 'smartoscn',
        current_platform: '20200304T133736Z',
        boot_platform: '20200313T113022Z',
        headnode: false
    },
    {
        uuid: '564d7287-6210-cfdc-9cf9-c3600aec8187',
        hostname: 'linuxcn',
        current_platform: '20200310T072029Z',
        boot_platform: '20200313T161129Z',
        headnode: false
    }
];

const CNAPI_IMG = {
    'v': 2,
    'uuid': '7a0429e7-de28-45ea-9e17-afd048ec0da8',
    'owner': '930896af-bf8c-48d4-885c-6573a94b1853',
    'name': 'cnapi',
    'version': 'master-20200310T190435Z-g4869d31',
    'published_at': '2020-03-10T19:08:26.567Z'
};

// We really need the macs only.
const SERVERS_NICS = [
    {
        'belongs_to_type': 'server',
        'belongs_to_uuid': '564d7287-6210-cfdc-9cf9-c3600aec8187',
        'mac': '00:0c:29:ec:81:87',
        'ip': '10.99.99.40',
        'mtu': 1500,
        'netmask': '255.255.255.0',
        'nic_tag': 'admin',
        'resolvers': [
          '10.99.99.11'
        ],
        'vlan_id': 0,
        'nic_tags_provided': [
          'admin'
        ]
    },
    {
        'belongs_to_type': 'server',
        'belongs_to_uuid': '564d98bb-68c2-7688-1b89-cbe1ad480216',
        'mac': '00:0c:29:48:02:16',
        'ip': '10.99.99.37',
        'netmask': '255.255.255.0',
        'nic_tag': 'admin',
        'resolvers': [
          '10.99.99.11'
        ],
        'vlan_id': 0,
        'nic_tags_provided': [
          'admin'
        ]
    },
    {
        'belongs_to_type': 'server',
        'belongs_to_uuid': '564d99da-f14e-94aa-d8b9-18e5c9d50ba6',
        'mac': '00:50:56:34:60:4c',
        'primary': false,
        'ip': '10.99.99.7',
        'netmask': '255.255.255.0',
        'nic_tag': 'admin',
        'resolvers': [
          '10.99.99.11'
        ],
        'vlan_id': 0,
        'nic_tags_provided': [
          'admin'
        ]
    }
];

tap.test('Platform list test', function (suite) {
    const myMocks = new Mocks();
    const top = {
        sdcadm: {
            log: log,
            cnapi: myMocks.mocks.cnapi
        },
        log: log,
        progress: tap.comment
    };

    const Platform = require('../../../lib/platform').Platform;
    const platf = new Platform(top);

    myMocks.mocks.cnapi.VALUES = {
        listPlatforms: [],
        getBootParams: [],
        listServers: []
    };

    myMocks.mocks.common.VALUES = {
        execFilePlus: [],
        mountUsbKey: [],
        unmountUsbKey: [],
        isUsbKeyMounted: []
    };

    // This suite tests intentionally check each individual method
    // invoked by Platform.listPlatforms before testing it so we can detect
    // where are failures faster:
    suite.test('getLatestPlatformInstalled', function (t) {
        myMocks.mocks.cnapi.VALUES.listPlatforms.push(
            { res: jsprim.deepCopy(PLATFORMS_LIST) },
            { res: jsprim.deepCopy(PLATFORMS_LIST) }
        );
        platf.getLatestPlatformInstalled(function (err, latest) {
            t.ifError(err, 'error getting latest platform');
            t.equal(latest, '20200317T114808Z', 'latest smartos platform');
            platf.getLatestPlatformInstalled('linux', function (err2, linux) {
                t.ifError(err2, 'error getting latest linux platform');
                t.equal(linux, '20200313T161129Z', 'latest linux platform');
                t.end();
            });
        });
    });

    suite.test('getDefaultBootPlatform', function (t) {
        myMocks.mocks.cnapi.VALUES.getBootParams.push(
            { res: jsprim.deepCopy(DEFAULT_BOOT_PARAMS) }
        );
        platf.getDefaultBootPlatform(function (err, defPlatf) {
            t.ifError(err, 'error getting default boot platform');
            t.equal(defPlatf, DEFAULT_BOOT_PARAMS.platform,
                'default boot params platform');
            t.end();
        });
    });

    suite.test('getPlatformsWithServers', function (t) {
        myMocks.mocks.cnapi.VALUES.listPlatforms.push(
            { res: jsprim.deepCopy(PLATFORMS_LIST) }
        );
        myMocks.mocks.cnapi.VALUES.listServers.push(
            { res: jsprim.deepCopy(SERVER_LIST) }
        );
        platf.getPlatformsWithServers(function (err, platforms) {
            t.ifError(err, 'error getting platforms with servers');
            t.equal(platforms['20200304T133736Z'].current_platform.length, 2,
                'Current SmartOS Servers Platform');
            t.equal(platforms['20200313T113022Z'].boot_platform.length, 2,
                'SmartOS Servers Boot Platform');
            t.equal(platforms['20200310T072029Z'].current_platform.length, 1,
                'Current Linux Servers Platform');
            t.equal(platforms['20200313T161129Z'].boot_platform.length, 1,
                'Linux Servers Boot Platform');
            t.end();
        });
    });

    suite.test('listUSBKeyPlatforms', function (t) {
        myMocks.mocks.common.VALUES.execFilePlus.push(
            { res: '20200304t133736z\n20200313t113022z\n' }
        );
        myMocks.mocks.common.VALUES.isUsbKeyMounted.push(
            { err: null, res: false }
        );
        myMocks.mocks.common.VALUES.mountUsbKey.push(
            { err: null, res: true }
        );
        myMocks.mocks.common.VALUES.unmountUsbKey.push(
            { err: null, res: true }
        );
        platf.listUSBKeyPlatforms(function (err, platfs) {
            t.ifError(err, 'listUSBKeyPlatforms error');
            t.ok(Array.isArray(platfs), 'expected listUSBKeyPlatforms array');
            t.equal(platfs.length, 2, 'listUSBKeyPlatforms length');
            t.end();
        });
    });

    suite.test('list', function (t) {
        myMocks.mocks.cnapi.VALUES.getBootParams.push(
            { res: jsprim.deepCopy(DEFAULT_BOOT_PARAMS) }
        );
        myMocks.mocks.cnapi.VALUES.listPlatforms.push(
            { res: jsprim.deepCopy(PLATFORMS_LIST) }
        );
        myMocks.mocks.cnapi.VALUES.listServers.push(
            { res: jsprim.deepCopy(SERVER_LIST) }
        );
        myMocks.mocks.common.VALUES.execFilePlus.push(
            { res: '20200304t133736z\n20200313t113022z\n' }
        );
        myMocks.mocks.common.VALUES.isUsbKeyMounted.push(
            { err: null, res: false }
        );
        myMocks.mocks.common.VALUES.mountUsbKey.push(
            { err: null, res: true }
        );
        myMocks.mocks.common.VALUES.unmountUsbKey.push(
            { err: null, res: true }
        );
        platf.list(function (err, platforms) {
            t.ifError(err, 'listPlatforms error');
            t.ok(Array.isArray(platforms), 'expected list of platforms');
            t.equal(Object.keys(PLATFORMS_LIST).length, platforms.length,
                'expected platforms length');
            platforms.forEach(function (p) {
                if (p.os === 'smartos' && (
                    p.boot_platform.some(function (s) {
                        return s.hostname === 'headnode';
                    }) || p.current_platform.some(function (s) {
                        return s.hostname === 'headnode';
                    }))) {
                    t.ok(p.usb_key, 'Headnode SmartOS PI in USB Key');
                } else {
                    t.notOk(p.usb_key, 'Not in USB Key');
                }
            });
            t.end();
        });
    });

    suite.test('teardown', function (t) {
        mockery.disable();
        t.end();
    });

    suite.end();
});


tap.test('Platform available test', function (suite) {
    mockery.deregisterAll();
    const myMocks = new Mocks();
    const top = {
        sdcadm: {
            log: log,
            cnapi: myMocks.mocks.cnapi,
            ensureSdcApp: function (_opts, cb) {
                top.sdcadm.sdcApp = {};
                cb();
            },
            updates: myMocks.mocks.imgapi
        },
        log: log,
        progress: tap.comment
    };

    const Platform = require('../../../lib/platform').Platform;
    const platf = new Platform(top);

    myMocks.mocks.cnapi.VALUES = {
        listPlatforms: [],
        getBootParams: [],
        listServers: []
    };

    myMocks.mocks.common.VALUES = {
        execFilePlus: [],
        mountUsbKey: [],
        unmountUsbKey: [],
        isUsbKeyMounted: []
    };

    myMocks.mocks.imgapi.VALUES = {
        listImages: []
    };

    suite.test('platform avail (no os given)', function (t) {
        myMocks.mocks.cnapi.VALUES.listPlatforms.push(
            { res: jsprim.deepCopy(PLATFORMS_LIST) },
            { res: jsprim.deepCopy(PLATFORMS_LIST) }
        );
        myMocks.mocks.imgapi.VALUES.listImages.push(
            { res: [].concat(IMGADM_LIST_SMARTOS, IMGADM_LIST_LINUX) }
        );
        platf.available({}, function (err, platforms) {
            t.ifError(err, 'Platform available error');
            t.ok(Array.isArray(platforms), 'Updates platforms array');
            t.equal(2, platforms.length, 'Expected two platforms avail');
            t.end();
        });
    });

    suite.test('platform avail (os=linux)', function (t) {
        myMocks.mocks.cnapi.VALUES.listPlatforms.push(
            { res: jsprim.deepCopy(PLATFORMS_LIST) },
            { res: jsprim.deepCopy(PLATFORMS_LIST) }
        );
        myMocks.mocks.imgapi.VALUES.listImages.push(
            { res: IMGADM_LIST_LINUX }
        );
        platf.available({os: 'linux'}, function (err, platforms) {
            t.ifError(err, 'Platform available error');
            t.ok(Array.isArray(platforms), 'Updates platforms array');
            t.equal(1, platforms.length, 'Expected one platform avail');
            t.equal('linux', platforms[0].os, 'Expected linux');
            t.end();
        });
    });

    suite.test('platform avail (os=smartos)', function (t) {
        myMocks.mocks.cnapi.VALUES.listPlatforms.push(
            { res: jsprim.deepCopy(PLATFORMS_LIST) },
            { res: jsprim.deepCopy(PLATFORMS_LIST) }
        );
        myMocks.mocks.imgapi.VALUES.listImages.push(
            { res: IMGADM_LIST_SMARTOS }
        );
        platf.available({os: 'smartos'}, function (err, platforms) {
            t.ifError(err, 'Platform available error');
            t.ok(Array.isArray(platforms), 'Updates platforms array');
            t.equal(1, platforms.length, 'Expected one platform avail');
            t.equal('smartos', platforms[0].os, 'Expected smartos');
            t.end();
        });
    });

    suite.test('teardown', function (t) {
        mockery.disable();
        t.end();
    });

    suite.end();
});


tap.test('Platform assign test', function (suite) {
    mockery.deregisterAll();
    const myMocks = new Mocks();
    const top = {
        sdcadm: {
            log: log,
            cnapi: myMocks.mocks.cnapi,
            napi: myMocks.mocks.napi,
            ensureSdcApp: function (_opts, cb) {
                top.sdcadm.sdcApp = {};
                cb();
            },
            updates: myMocks.mocks.imgapi,
            getImgsForSvcVms: function (_opts, cb) {
                myMocks.mocks.imgapi.getImage(CNAPI_IMG.uuid,
                    function (err, img) {
                    if (err) {
                        cb(err);
                        return;
                    }

                    cb(null, {
                        imgs: [img]
                    });
                });
            }
        },
        log: log,
        progress: tap.comment
    };

    const Platform = require('../../../lib/platform').Platform;
    const platf = new Platform(top);

    myMocks.mocks.cnapi.VALUES = {
        listPlatforms: [],
        getBootParams: [],
        setBootParams: [],
        listServers: [],
        commandExecute: []
    };

    myMocks.mocks.common.VALUES = {
        execFilePlus: [],
        mountUsbKey: [],
        unmountUsbKey: [],
        isUsbKeyMounted: []
    };

    myMocks.mocks.imgapi.VALUES = {
        listImages: [],
        getImage: []
    };

    myMocks.mocks.napi.VALUES = {
        listNetworkPools: [ { res: [] }, { res: [] } ],
        listNics: []
    };

    suite.test('Get CNAPI version test', function (t) {
        myMocks.mocks.imgapi.VALUES.getImage.push({
            res: jsprim.deepCopy(CNAPI_IMG)
        });
        platf.getCNAPIVersion(function (err, version) {
            t.ifError(err, 'Get CNAPI version error');
            t.equal(version, '20200310', 'CNAPI version');
            t.end();
        });
    });

    suite.test('Assign latest platform to all servers test', function (t) {
        myMocks.mocks.cnapi.VALUES.listPlatforms.push(
            { res: jsprim.deepCopy(PLATFORMS_LIST) },
            { res: jsprim.deepCopy(PLATFORMS_LIST) },
            { res: jsprim.deepCopy(PLATFORMS_LIST) },
            { res: jsprim.deepCopy(PLATFORMS_LIST) }
        );
        myMocks.mocks.cnapi.VALUES.listServers.push(
            { res: jsprim.deepCopy(SERVER_LIST) },
            { res: jsprim.deepCopy(SERVER_LIST).map(function (s) {
                if (s.hostname === 'linuxcn') {
                    s.boot_platform = '20200313T161129Z';
                } else {
                    s.boot_platform = '20200317T114808Z';
                }
                return s;
            }) }
        );
        myMocks.mocks.cnapi.VALUES.setBootParams.push(
            { res: {} },
            { res: {} },
            { res: {} },
            { res: {} }
        );
        myMocks.mocks.cnapi.VALUES.commandExecute.push(
            { res: ['==> Mounting USB key',
                    '/mnt/usbkey',
                    '==> Updating Loader configuration',
                    '==> Updating cnapi',
                    '==> Unmounting USB Key',
                    '==> Done!' ].join('\n') },
            { res: 'Done!' }
        );
        myMocks.mocks.napi.VALUES.listNics.push(
            { res: jsprim.deepCopy(SERVERS_NICS) }
        );
        myMocks.mocks.imgapi.VALUES.getImage.push({
            res: jsprim.deepCopy(CNAPI_IMG)
        });

        myMocks.mocks.cnapi.VALUES.getBootParams.push(
            { res: jsprim.deepCopy(DEFAULT_BOOT_PARAMS) },
            { res: jsprim.deepCopy(DEFAULT_BOOT_PARAMS) }
        );

        myMocks.mocks.common.VALUES.execFilePlus.push(
            { res: '\n' }
        );
        platf.assign({
            all: true,
            platform: 'latest'
        }, function (err) {
            t.ifError(err, 'assign platform error');
            t.end();
        });
    });

    suite.test('Assign wrong OS platform to setup server', function (t) {
        myMocks.mocks.cnapi.VALUES.listPlatforms.push(
            { res: jsprim.deepCopy(PLATFORMS_LIST) }
        );
        myMocks.mocks.cnapi.VALUES.listServers.push(
            { res: jsprim.deepCopy(SERVER_LIST) }
        );
        platf.assign({
            platform: '20200317T114808Z',
            server: ['564d7287-6210-cfdc-9cf9-c3600aec8187']
        }, function (err) {
            t.ok(err, 'expected error');
            t.ok(err.message, 'expected error message');
            t.ok(/operating system/i.test(err.message),
                'expected message contains OS');
            t.ok(/factory reset/i.test(err.message),
                'expected message contains factory reset');
            t.end();
        });
    });

    suite.test('teardown', function (t) {
        mockery.disable();
        t.end();
    });

    suite.end();
});


tap.test('Platform usage', function (suite) {
    mockery.deregisterAll();
    const myMocks = new Mocks();
    const top = {
        sdcadm: {
            log: log,
            cnapi: myMocks.mocks.cnapi,
            napi: myMocks.mocks.napi,
            ensureSdcApp: function (_opts, cb) {
                top.sdcadm.sdcApp = {};
                cb();
            },
            updates: myMocks.mocks.imgapi,
            getImgsForSvcVms: function (_opts, cb) {
                myMocks.mocks.imgapi.getImage(CNAPI_IMG.uuid,
                    function (err, img) {
                    if (err) {
                        cb(err);
                        return;
                    }

                    cb(null, {
                        imgs: [img]
                    });
                });
            }
        },
        log: log,
        progress: tap.comment
    };

    const Platform = require('../../../lib/platform').Platform;
    const platf = new Platform(top);

    myMocks.mocks.cnapi.VALUES = {
        listPlatforms: [],
        listServers: []
    };

    suite.test('Platform Usage', function (t) {
        myMocks.mocks.cnapi.VALUES.listPlatforms.push(
            { res: jsprim.deepCopy(PLATFORMS_LIST) }
        );
        myMocks.mocks.cnapi.VALUES.listServers.push(
            { res: jsprim.deepCopy(SERVER_LIST) }
        );

        platf.usage('20200304T133736Z', function (err, usageRows) {
            t.ifError(err, 'platform usage error');
            t.ok(Array.isArray(usageRows), 'Expected array of servers');
            t.equal(2, usageRows.length, 'Expected 2 servers');
            t.end();
        });
    });

    suite.test('teardown', function (t) {
        mockery.disable();
        t.end();
    });

    suite.end();
});


tap.test('Platform remove', function (suite) {
    mockery.deregisterAll();
    const myMocks = new Mocks();
    const top = {
        sdcadm: {
            log: log,
            cnapi: myMocks.mocks.cnapi,
            getImgsForSvcVms: function (_opts, cb) {
                myMocks.mocks.imgapi.getImage(CNAPI_IMG.uuid,
                    function (err, img) {
                    if (err) {
                        cb(err);
                        return;
                    }

                    cb(null, {
                        imgs: [img]
                    });
                });
            }
        },
        log: log,
        progress: tap.comment
    };

    const Platform = require('../../../lib/platform').Platform;
    const platf = new Platform(top);

    myMocks.mocks.cnapi.VALUES = {
        listPlatforms: [],
        getBootParams: [],
        listServers: []
    };

    myMocks.mocks.common.VALUES = {
        execFilePlus: [],
        mountUsbKey: [],
        unmountUsbKey: [],
        isUsbKeyMounted: []
    };

    myMocks.mocks.imgapi.VALUES = {
        listImages: [],
        getImage: [],
        getImageFile: []
    };

    suite.test('remove', function (t) {
        myMocks.mocks.common.VALUES.isUsbKeyMounted.push(
            { err: null, res: false }
        );
        myMocks.mocks.common.VALUES.mountUsbKey.push(
            { err: null, res: true }
        );
        myMocks.mocks.common.VALUES.unmountUsbKey.push(
            { err: null, res: true }
        );
        myMocks.mocks.common.VALUES.execFilePlus.push(
            { res: '\n' },
            { res: '\n' }
        );
        myMocks.mocks.imgapi.VALUES.getImage.push({
            res: jsprim.deepCopy(CNAPI_IMG)
        });

        platf.remove({
            cleanup_cache: true,
            yes: true,
            remove: ['20200317T114808Z']
        }, function (err) {
            t.ifError(err, 'platform remove error');
            t.end();
        });
    });
    suite.test('teardown', function (t) {
        mockery.disable();
        t.end();
    });
    suite.end();
});

tap.test('Platform install', function (suite) {
    mockery.deregisterAll();
    const myMocks = new Mocks();
    const top = {
        sdcadm: {
            log: log,
            cnapi: myMocks.mocks.cnapi,
            napi: myMocks.mocks.napi,
            ensureSdcApp: function (_opts, cb) {
                top.sdcadm.sdcApp = {};
                cb();
            },
            updates: myMocks.mocks.imgapi,
            getImgsForSvcVms: function (_opts, cb) {
                myMocks.mocks.imgapi.getImage(CNAPI_IMG.uuid,
                    function (err, img) {
                    if (err) {
                        cb(err);
                        return;
                    }

                    cb(null, {
                        imgs: [img]
                    });
                });
            },
            getDefaultChannel: function (cb) {
                cb(null, 'dev');
            }
        },
        log: log,
        progress: tap.comment
    };

    const Platform = require('../../../lib/platform').Platform;
    const platf = new Platform(top);

    myMocks.mocks.cnapi.VALUES = {
        listPlatforms: [],
        getBootParams: [],
        listServers: []
    };

    myMocks.mocks.imgapi.VALUES = {
        listImages: [],
        getImage: [],
        getImageFile: []
    };

    myMocks.mocks.common.VALUES = {
        execFilePlus: [],
        mountUsbKey: [],
        unmountUsbKey: [],
        isUsbKeyMounted: []
    };

    suite.test('Platform install', function (t) {
        myMocks.mocks.cnapi.VALUES.listPlatforms.push(
            { res: jsprim.deepCopy(PLATFORMS_LIST) },
            { res: jsprim.deepCopy(PLATFORMS_LIST) }
        );
        myMocks.mocks.cnapi.VALUES.listServers.push(
            { res: jsprim.deepCopy(SERVER_LIST) }
        );
        myMocks.mocks.cnapi.VALUES.getBootParams.push(
            { res: jsprim.deepCopy(DEFAULT_BOOT_PARAMS) },
            { res: jsprim.deepCopy(DEFAULT_BOOT_PARAMS) }
        );
        myMocks.mocks.imgapi.VALUES.listImages.push(
            { res: IMGADM_LIST_SMARTOS }
        );
        myMocks.mocks.imgapi.VALUES.getImageFile.push(
            { res: {} }
        );
        myMocks.mocks.common.VALUES.execFilePlus.push(
            { res: '           178884278           310814720' +
                '  42.4% /var/tmp/platform-master-20200324T020911Z.tar' },
            { res: [ 'Filesystem           1024-blocks        Used   ' +
                'Available Capacity  Mounted on',
                '/dev/dsk/c1d0s2          3604862     3110440      ' +
                '494422    87%    /mnt/usbkey' ].join('\n') }
        );
        myMocks.mocks.common.VALUES.isUsbKeyMounted.push(
            { err: null, res: false }
        );
        myMocks.mocks.common.VALUES.mountUsbKey.push(
            { err: null, res: true }
        );
        myMocks.mocks.common.VALUES.unmountUsbKey.push(
            { err: null, res: true }
        );

        myMocks.mocks.imgapi.VALUES.getImage.push({
            res: jsprim.deepCopy(CNAPI_IMG)
        });

        platf.install({
            image: 'latest'
        }, function (err) {
            t.ifError(err, 'Install platform error');
            t.end();
        });
    });

    suite.test('teardown', function (t) {
        mockery.disable();
        t.end();
    });

    suite.end();
});
