/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Core SdcAdm class.
 */

var assert = require('assert-plus');
var child_process = require('child_process'),
    spawn = child_process.spawn,
    exec = child_process.exec;
var util = require('util'),
    format = util.format;
var fs = require('fs');
var http  = require('http');
var https = require('https');
var path = require('path');
var crypto = require('crypto');
var mkdirp = require('mkdirp');
var once = require('once');
var sdcClients = require('sdc-clients');
var semver = require('semver');
var sprintf = require('extsprintf').sprintf;
var urclient = require('urclient');
var vasync = require('vasync');
var WfClient = require('wf-client');
var uuid = require('node-uuid');
var ProgressBar = require('progbar').ProgressBar;

var common = require('./common');
var svcadm = require('./svcadm');
var errors = require('./errors');
var lock = require('./locker').lock;
var pkg = require('../package.json');
var procedures = require('./procedures');
var History = require('./history').History;
var ur = require('./ur');

var UA = format('%s/%s (node/%s; openssl/%s)', pkg.name, pkg.version,
        process.versions.node, process.versions.openssl);
var UPDATE_PLAN_FORMAT_VER = 1;


//---- UpdatePlan class
// A light data object with some conveninence functions.

function UpdatePlan(options) {
    assert.object(options, 'options');
    assert.arrayOfObject(options.curr, 'options.curr');
    assert.arrayOfObject(options.targ, 'options.targ');
    assert.arrayOfObject(options.changes, 'options.changes');
    assert.bool(options.justImages, 'options.justImages');
    assert.optionalBool(options.rollback, 'options.rollback');

    this.v = UPDATE_PLAN_FORMAT_VER;
    this.curr = options.curr;
    this.targ = options.targ;
    this.changes = options.changes;
    this.justImages = options.justImages;
    this.rollback = options.rollback || false;
}

UpdatePlan.prototype.serialize = function serialize() {
    return JSON.stringify({
        v: this.v,
        targ: this.targ,
        changes: this.changes,
        justImages: this.justImages
    }, null, 4);
};



//---- SdcAdm class

/**
 * Create a SdcAdm.
 *
 * @param options {Object}
 *      - log {Bunyan Logger}
 */
function SdcAdm(options) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');

    // A unique UUID for this sdcadm run -- used for client req_id's below,
    // and for sdcadm history entries.
    if (!options.uuid) {
        options.uuid = uuid();
    }

    if (!options.username) {
        options.username = process.env.USER;
    }

    var self = this;

    this.log = options.log;
    this.uuid = options.uuid;
    this.username = options.username;

    self._lockPath = '/var/run/sdcadm.lock';
    self._reprovFailLockPath = '/var/sdcadm/reprovFailLock.json';

    self.userAgent = UA;
    Object.defineProperty(this, 'sapi', {
        get: function () {
            if (self._sapi === undefined) {
                self._sapi = new sdcClients.SAPI({
                    url: self.config.sapi.url,
                    agent: false,
                    userAgent: self.userAgent,
                    log: self.log,
                    headers: {
                        'x-request-id': self.uuid
                    }
                });
            }
            return self._sapi;
        }
    });
    Object.defineProperty(this, 'cnapi', {
        get: function () {
            if (self._cnapi === undefined) {
                self._cnapi = new sdcClients.CNAPI({
                    url: self.config.cnapi.url,
                    agent: false,
                    userAgent: self.userAgent,
                    log: self.log,
                    headers: {
                        'x-request-id': self.uuid
                    },
                    requestTimeout: 180000
                });
            }
            return self._cnapi;
        }
    });
    Object.defineProperty(this, 'papi', {
        get: function () {
            if (self._papi === undefined) {
                self._papi = new sdcClients.PAPI({
                    url: self.config.papi.url,
                    agent: false,
                    userAgent: self.userAgent,
                    log: self.log,
                    headers: {
                        'x-request-id': self.uuid
                    }
                });
            }
            return self._papi;
        }
    });
    Object.defineProperty(this, 'vmapi', {
        get: function () {
            if (self._vmapi === undefined) {
                self._vmapi = new sdcClients.VMAPI({
                    url: self.config.vmapi.url,
                    agent: false,
                    userAgent: self.userAgent,
                    log: self.log,
                    headers: {
                        'x-request-id': self.uuid
                    }
                });
            }
            return self._vmapi;
        }
    });
    Object.defineProperty(this, 'imgapi', {
        get: function () {
            if (self._imgapi === undefined) {
                var opts = {
                    url: self.config.imgapi.url,
                    agent: false,
                    userAgent: self.userAgent,
                    /*
                     * Don't *need* API version 2 and doing so breaks GetImage
                     * with an old IMGAPI before:
                     *      commit de5c9bea58c934273b7efc7caa4ff46eeea380f6
                     *      Date:   Fri Aug 1 22:50:32 2014 -0700
                     * which currently is possible with the svcMinImages.imgapi
                     * config in defaults.json.
                     */
                    // version: '~2',
                    log: self.log,
                    headers: {
                        'x-request-id': self.uuid
                    }
                };
                self._imgapi = new sdcClients.IMGAPI(opts);
            }
            return self._imgapi;
        }
    });
    Object.defineProperty(this, 'updates', {
        get: function () {
            if (self._updates === undefined) {
                assert.object(self.sdc, 'self.sdc (the SAPI "sdc" app) '
                    + 'must be retrieved for client config');
                var opts = {
                    url: self.config.updatesServerUrl,
                    proxy: self.sdc.metadata.http_proxy || false,
                    userAgent: self.userAgent,
                    log: self.log,
                    headers: {
                        'x-request-id': self.uuid
                    }
                };
                if (self.sdc.metadata.update_channel) {
                    opts.channel = self.sdc.metadata.update_channel;
                }
                self._updates = new sdcClients.IMGAPI(opts);
            }
            return self._updates;
        }
    });
    Object.defineProperty(this, 'imagesJo', {
        get: function () {
            if (self._imagesJo === undefined) {
                assert.object(self.sdc, 'self.sdc (the SAPI "sdc" app) '
                    + 'must be retrieved for client config');
                var opts = {
                    url: 'https://images.joyent.com',
                    proxy: self.sdc.metadata.http_proxy || false,
                    userAgent: self.userAgent,
                    log: self.log,
                    headers: {
                        'x-request-id': self.uuid
                    }
                };
                self._imagesJo = new sdcClients.IMGAPI(opts);
            }
            return self._imagesJo;
        }
    });
    Object.defineProperty(this, 'napi', {
        get: function () {
            if (self._napi === undefined) {
                self._napi = new sdcClients.NAPI({
                    url: self.config.napi.url,
                    agent: false,
                    userAgent: self.userAgent,
                    log: self.log,
                    headers: {
                        'x-request-id': self.uuid
                    }
                });
            }
            return self._napi;
        }
    });
    Object.defineProperty(this, 'wfapi', {
        get: function () {
            if (self._wfapi === undefined) {
                self._wfapi = new WfClient({
                    url: self.config.wfapi.url,
                    agent: false,
                    path: './not/used/because/we/do/not/loadWorkflows',
                    // TODO: Get wf-client to take `userAgent`.
                    //userAgent: self.userAgent,
                    log: self.log.child({client: 'wfapi'}, true),
                    headers: {
                        'x-request-id': self.uuid
                    }
                });
            }
            return self._wfapi;
        }
    });
    // NOTE: A method using self.ufds should take care of
    // calling self._ufds.close(function (err) {}); Yuck.
    Object.defineProperty(this, 'ufds', {
        get: function () {
            if (self._ufds === undefined) {
                self._ufds = new sdcClients.UFDS({
                    url: self.config.ufds.url,
                    bindDN: self.config.ufds.bindDN,
                    bindPassword: self.config.ufds.bindPassword,
                    maxConnections: 1,
                    retry: {
                        initialDelay: 1000
                    },
                    clientTimeout: 120000,
                    tlsOptions: {
                        rejectUnauthorized: false
                    },
                    log: self.log
                });
                self._ufds.once('error', function (err) {
                    throw err;
                });

                self._ufds.once('connect', function () {
                    self._ufds.removeAllListeners('error');
                    self._ufds.on('error', function (err) {
                        self.log.info('UFDS disconnected');
                    });
                    self._ufds.on('connect', function () {
                        self.log.info('UFDS reconnected');
                    });
                    self._ufds.on('timeout', function (msg) {
                        self.log.error(msg);
                        self._ufds.client.socket.destroy();
                    });
                });

            }
            return self._ufds;
        }
    });

    this.urConnTimedOut = false;

    Object.defineProperty(this, 'ur', {
        get: function () {
            if (self._ur === undefined && !self.urConnTimedOut) {
                self._ur = urclient.create_ur_client({
                    connect_timeout: 5000,  // in ms
                    enable_http: false,
                    amqp_config: self.config.amqp,
                    log: self.log.child({client: 'ur'}, true)
                });
                // Handle connection errors:
                self._ur.ur_urconn.on('error', function urErr(err) {
                    self.log.error({
                        err: err
                    }, 'Ur Connection Error');
                    self.urConnTimedOut = true;
                });
            }
            return self._ur;
        }
    });
}

// This function defines the sdcadm properties which require async callbacks
// to be used: 'config', 'history' and 'sdc' application.
SdcAdm.prototype.init = function init(cb) {
    var self = this;
    common.loadConfig({log: self.log}, function (err, config) {
        if (err) {
            return cb(err);
        }

        self.config = config;
        if (self.config.serverUuid) {
            self.userAgent += ' server=' + self.config.serverUuid;
        }

        self.history = new History({sdcadm: self});

        self.getApp({app: 'sdc'}, function (appErr, app) {
            if (appErr) {
                // Couple known issues we can help operators with a friendly
                // message instead of the default "ENO..." errors:
                if (appErr.message) {
                    if (appErr.message.match(/getaddrinfo ENOTFOUND/)) {
                        console.log('Binder service seems to be down. ' +
                                'Please review it before proceeding');
                    } else if (appErr.message.match(/connect ECONNREFUSED/)) {
                        console.log('Sapi service seems to be down. ' +
                                'Please review it before proceeding');
                    }
                }
                return cb(appErr);
            }
            self.sdc = app;
            return self.history.init(cb);
        });
    });
};


/*
 * Cleanly close this SdcAdm instance.
 */
SdcAdm.prototype.fini = function fini() {
    var self = this;
    if (self._updates) {
        self._updates.close();
    }
    if (self._imagesJo) {
        self._imagesJo.close();
    }
};


/**
 * Gather a JSON object for every (or specified subset of) installed SDC
 * service instance.
 *
 * "Services" include: SDC core vms and agents.
 *
 * All types will have these fields:
 *      type            type of service, one of 'vm' or 'agent'
 *      instance        (Note: Agents don't current have a instance UUID
 *                      exposed.)
 *      service         name of service, e.g. 'vmapi, 'provisioner'
 *      image           image UUID (Note: Agents aren't
 *                      currently distributed as separate "images" in
 *                      updates.joyent.com. Until they are `image === null`.)
 *      version         version string, e.g. '1.2.3'
 *      server          server uuid (if available)
 *      hostname        server hostname (if available)
 *      server_ip       'admin' network IP for the server (if available)
 *
 * Other fields for type=vm instances:
 *      ip              'admin' network IP (for type=vm instances)
 *      state           the VM state from VMAPI, e.g. 'running', 'provisioning'
 *      zonename
 *
 * @param opts {Object} Optional
 *      - types {Array} instance types to which to limit results. Valid values
 *        are 'vm' or 'agent'.
 *      - svcs {Array} service names to which to limit results.
 * @param cb {Function} `function (err, insts)`
 */
SdcAdm.prototype.listInsts = function listInsts(opts, cb) {
    var self = this;
    if (cb === undefined) {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'opts');
    assert.optionalArrayOfString(opts.types, 'opts.types');
    assert.optionalArrayOfString(opts.svcs, 'opts.svcs');
    assert.func(cb, 'cb');

    var isWantedSvc = null;
    if (opts.svcs) {
        isWantedSvc = {};
        for (var j = 0; j < opts.svcs.length; j++) {
            isWantedSvc[opts.svcs[j]] = true;
        }
    }

    var context = {
        insts: []
    };
    vasync.pipeline({arg: context, funcs: [
        function getServers(ctx, next) {
            ctx.serverFromUuid = {};
            ctx.serverAdminIpFromUuid = {};

            var serverOpts = {
                extras: 'sysinfo,agents'
            };
            self.cnapi.listServers(serverOpts, function (serversErr, servers) {
                if (serversErr) {
                    return next(new errors.SDCClientError(serversErr, 'cnapi'));
                }
                for (var i = 0; i < servers.length; i++) {
                    var server = servers[i];
                    ctx.serverFromUuid[server.uuid] = server;

                    var nics = server.sysinfo['Network Interfaces'] || {};
                    var adminIp = Object.keys(nics).map(function (nicName) {
                        return nics[nicName];
                    }).filter(function (nic) {
                        return nic['NIC Names'].indexOf('admin') !== -1;
                    }).map(function (nic) {
                        return nic.ip4addr;
                    })[0];
                    ctx.serverAdminIpFromUuid[server.uuid] = adminIp;
                }
                next();
            });
        },

        /*
         * Right now we don't have a way to match an agent inst in SAPI to
         * the server on which it lives. That's kind of lame. However a
         * proper answer should eventually come with sdc-update M10 work
         * to get agents individually managed.
         */
        function fillOutAgentInsts(ctx, next) {
            if (opts.types && opts.types.indexOf('agent') === -1) {
                return next();
            }

            var serverUuids = Object.keys(ctx.serverFromUuid);
            for (var i = 0; i < serverUuids.length; i++) {
                var server = ctx.serverFromUuid[serverUuids[i]];
                (server.agents || server.sysinfo['SDC Agents'] || []).forEach(
                        function (agent) {
                    if (!isWantedSvc || isWantedSvc[agent.name]) {
                        var inst = {
                            type: 'agent',
                            service: agent.name,
                            instance: agent.uuid,
                            version: agent.version,
                            image: agent.image_uuid,
                            server: server.uuid,
                            hostname: server.hostname,
                            server_ip: ctx.serverAdminIpFromUuid[server.uuid]
                        };
                        ctx.insts.push(inst);
                    }
                });
            }
            next();
        },

        /*
         * Note: For *now* we gather for VMs that aren't listed as SAPI
         * instances because, e.g., SDC doesn't add an "assets" service.
         * It should.
         *
         * As a result, instead of SAPI being the authority on insts, it is
         * instead a VMAPI query for admin-owned VMs with `tags.smartdc_role`.
         */
        function getVmInfo(ctx, next) {
            if (opts.types && opts.types.indexOf('vm') === -1) {
                return next();
            }

            ctx.vmFromUuid = {};
            /**
             * Instead of getting each VM (there could be up to dozens),
             * lets get all of admin's VMs in one req and filter those.
             *
             * 'cloudapi' zones typically don't have
             * `tags.smartdc_core=true` so we can't filter on that. And
             * VMAPI doesn't support filtering on presence of a tag
             * (e.g. `smartdc_role`).
             */
            var filters = {
                state: 'active',
                owner_uuid: self.config.ufds_admin_uuid
            };
            self.vmapi.listVms(filters, function (err, vms) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'vmapi'));
                }

                for (var i = 0; i < vms.length; i++) {
                    var vm = vms[i];
                    if (vm.tags && vm.tags.smartdc_role) {
                        if (!isWantedSvc || isWantedSvc[vm.tags.smartdc_role])
                        {
                            ctx.vmFromUuid[vm.uuid] = vm;
                        }
                    }
                }
                next();
            });
        },

        function getImgs(ctx, next) {
            if (opts.types && opts.types.indexOf('vm') === -1) {
                return next();
            }

            ctx.imgFromUuid = {};

            // Prefer *vmFromUuid* to *sapiInstFromUuid* b/c no 'assets' svc.
            var vmUuids = Object.keys(ctx.vmFromUuid);
            for (var i = 0; i < vmUuids.length; i++) {
                var vm = ctx.vmFromUuid[vmUuids[i]];
                ctx.imgFromUuid[vm.image_uuid] = null;
            }

            var imgUuids = Object.keys(ctx.imgFromUuid);
            self.log.trace({imgUuids: imgUuids}, 'listInsts imgUuids');
            vasync.forEachParallel({
                inputs: imgUuids,
                func: function getOneImg(imgUuid, nextImg) {
                    self.imgapi.getImage(imgUuid, function (err, img) {
                        if (!err) {
                            ctx.imgFromUuid[imgUuid] = img;
                            nextImg();
                        } else if (err.restCode !== 'ResourceNotFound') {
                            nextImg(new errors.SDCClientError(
                                err, 'imgapi'));
                        } else {
                            nextImg();
                        }
                    });
                }
            }, next);
        },

        function fillOutVmInsts(ctx, next) {
            if (opts.types && opts.types.indexOf('vm') === -1) {
                return next();
            }

            // Prefer *vmFromUuid* to *sapiInstFromUuid* b/c no 'assets' svc.
            var uuids = Object.keys(ctx.vmFromUuid);
            for (var i = 0; i < uuids.length; i++) {
                var vm = ctx.vmFromUuid[uuids[i]];
                var img = ctx.imgFromUuid[vm.image_uuid];

                var inst = {
                    type: 'vm',
                    alias: vm.alias,
                    version: null,
                    instance: vm.uuid,
                    zonename: vm.uuid,
                    service: vm.tags.smartdc_role,
                    image: vm.image_uuid,
                    state: vm.state,
                    server: null,
                    hostname: null,
                    server_ip: null
                };
                if (img) {
                    inst.version = img.version;
                }
                // A state='provisioning' VM might not yet have a
                // 'server_uuid'.
                if (vm.server_uuid) {
                    inst.server = vm.server_uuid;
                    inst.hostname = ctx.serverFromUuid[
                        vm.server_uuid].hostname;
                    inst.server_ip = ctx.serverAdminIpFromUuid[
                        vm.server_uuid];
                }

                var adminIp = vm.nics.filter(function (nic) {
                    return nic.nic_tag === 'admin';
                }).map(function (nic) {
                    return nic.ip;
                })[0];

                if (adminIp) {
                    inst.ip = adminIp;
                }

                ctx.insts.push(inst);
            }

            next();
        },
        function findMissingInstImgs(ctx, next) {
            vasync.forEachParallel({
                inputs: ctx.insts,
                func: function imgadmGetImg(inst, nextInst) {
                    if (inst.version || !inst.server) {
                        return nextInst();
                    }
                    common.imgadmGetRemote({
                        img_uuid: inst.image,
                        server: inst.server,
                        log: self.log
                    }, function (err, img) {
                        if (err) {
                            self.log.error({err: err}, 'imgadm error');
                            return nextInst();
                        }
                        if (img && img.manifest && img.manifest.version) {
                            inst.version = img.manifest.version;
                        }
                        return nextInst();
                    });
                }
            }, next);
        }
    ]}, function (err) {
        cb(err, context.insts);
    });
};


/**
 * Gather a JSON object for each installed SDC service.
 *
 * "Services" include: SDC core vms and agents.
 */
SdcAdm.prototype.getServices = function getServices(opts, cb) {
    var self = this;
    assert.object(opts, 'opts');
    assert.func(cb, 'cb');

    var app = self.sdc;
    var svcs = [];
    vasync.pipeline({funcs: [
        function getSapiSvcs(_, next) {
            // 'cloudapi' zones typically don't have `tags.smartdc_core=true`
            // so we can't filter on that. And VMAPI doesn't support filtering
            // on presence of a tag (e.g. `smartdc_role`.)
            var filters = {
                application_uuid: app.uuid
            };

            if (opts.type) {
                filters.type = opts.type;
            }
            self.sapi.listServices(filters, function (svcsErr, svcs_) {
                if (svcsErr) {
                    return next(new errors.SDCClientError(svcsErr, 'sapi'));
                }
                svcs = svcs_;
                var haveAssets = false;
                svcs.forEach(function (svc) {
                    // TODO(trent): want SAPI to have this eventually.
                    // TOOLS-724: new SAPI instances will have this type
                    // member. Do not override it when already present.
                    if (!svc.type) {
                        svc.type = 'vm';
                    }
                    if (svc.name === 'assets') {
                        haveAssets = true;
                    }
                });
                // TODO: get assets service in SAPI. Hack it in for now.
                // Not having 'assets' service mucks up update type guessing
                // in 'sdcadm update assets', for example.
                if (!haveAssets) {
                    svcs.push({
                        type: 'vm',
                        name: 'assets'
                    });
                }

                next();
            });
        },
        function getAgents(_, next) {
            // TODO: Remove these hardcoded values
            // Hardcode "known" agents for now until SAPI handles agents.
            // Excluding "marlin". Should we include hagfish-watcher?
            [
                {
                    'name': 'cabase'
                },
                {
                    'name': 'hagfish-watcher'
                },
                {
                    'name': 'agents_core'
                },
                {
                    'name': 'firewaller'
                },
                {
                    'name': 'amon-agent'
                },
                {
                    'name': 'cainstsvc'
                },
                {
                    'name': 'provisioner'
                },
                {
                    'name': 'amon-relay'
                },
                {
                    'name': 'heartbeater'
                },
                {
                    'name': 'smartlogin'
                },
                {
                    'name': 'zonetracker'
                }
            ].forEach(function (agent) {
                var exists = svcs.filter(function (s) {
                    return (s.name === agent.name);
                }).length;
                if (!exists) {
                    agent.type = 'agent';
                    svcs.push(agent);
                }
            });
            next();
        }
    ]}, function (err) {
        cb(err, svcs);
    });
};


/**
 * Get the full image object for the given image UUID from either the local
 * IMGAPI or the updates server.
 *
 * @param opts {Object} Required.
 *      - uuid {UUID} Required. The image uuid.
 * @param cb {Function} `function (err, img)`
 */
SdcAdm.prototype.getImage = function getImage(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.uuid, 'opts.uuid');
    assert.func(cb, 'cb');
    var self = this;

    self.imgapi.getImage(opts.uuid, function (iErr, iImg) {
        if (iErr && iErr.body && iErr.body.code === 'ResourceNotFound') {
            self.updates.getImage(opts.uuid, cb);
        } else {
            cb(iErr, iImg);
        }
    });
};


/**
 * Get a SAPI application.
 *
 * @param opts {Object} Required.
 *      - app {String|UUID} Required. The application name or UUID.
 * @param cb {Function} `function (err, app)`
 */
SdcAdm.prototype.getApp = function getApp(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.app, 'opts.app');
    assert.func(cb, 'cb');

    if (opts.app === 'sdc' && this.sdc) {
        cb(null, this.sdc);
    } else if (common.UUID_RE.test(opts.app)) {
        this.sapi.getApplication(opts.app, errors.sdcClientErrWrap(cb, 'sapi'));
    } else {
        this.sapi.listApplications({name: opts.app}, function (err, apps) {
            if (err) {
                cb(new errors.SDCClientError(err, 'sapi'));
            } else if (apps.length !== 1) {
                cb(new errors.InternalError({
                    message: format('unexpected number of "%s" apps: %d',
                        opts.app, apps.length)
                }));
            } else {
                cb(null, apps[0]);
            }
        });
    }
};

/**
 * Get a SAPI service.
 *
 * Dev Note: Why 'getSvc' and not 'getService'? I want to move to
 * app/svc/inst/img for naming in functions as well.
 *
 * @param opts {Object} Required.
 *      - app {String|UUID} Required. The application name or UUID.
 *      - svc {String|UUID} Required. The service name or UUID.
 *      - allowNone {Boolean} Optional. Default false. Set `true` to return
 *        `cb()` if there is no such service. By default an InternalError is
 *        returned.
 * @param cb {Function} `function (err, svc)`
 */
SdcAdm.prototype.getSvc = function getSvc(opts, cb) {
    var self = this;
    assert.optionalBool(opts.allowNone, 'opts.allowNone');

    self.getApp({app: opts.app}, function (appErr, app) {
        if (appErr) {
            return cb(appErr);
        }

        if (common.UUID_RE.test(opts.svc)) {
            self.sapi.getService(opts.svc, function (svcErr, svc) {
                if (svcErr) {
                    return cb(new errors.SDCClientError(svcErr, 'sapi'));
                } else if (svc.application_uuid !== app.uuid) {
                    cb(new errors.ValidationError(format(
                        'given svc "%s" does not belong to the "%s" app',
                        opts.svc, opts.app)));
                } else {
                    cb(null, svc);
                }
            });
        } else {
            var filters = {
                application_uuid: app.uuid,
                name: opts.svc
            };
            self.sapi.listServices(filters, function (svcsErr, svcs) {
                if (svcsErr) {
                    return cb(new errors.SDCClientError(svcsErr, 'sapi'));
                } else if (svcs.length > 1) {
                    cb(new errors.InternalError({
                        message: format('unexpected number of "%s" svcs: %d',
                            opts.svc, svcs.length)
                    }));
                } else if (svcs.length === 0) {
                    if (opts.allowNone) {
                        cb(null);
                    } else {
                        cb(new errors.InternalError({
                            message: format('no "%s" service found', opts.svc)
                        }));
                    }
                } else {
                    cb(null, svcs[0]);
                }
            });
        }
    });
};


/**
 * Get the image version for all the active VMs of the given service.
 *
 * @type obj {Object} including:
 * @prop vms {Array} of VMAPI vms
 * @prop imgs {Array} of IMGAPI imgs (only different images, if all the
 * VMs are using the same image, only one image will be returned here).
 *
 * @params svc {String|UUID} Required. The service name or UUID.
 * @param cb {Function} `function (err, obj)`
 */
SdcAdm.prototype.getImgsForSvcVms = function getImgsForSvcVms(opts, cb) {
    var self = this;
    assert.object(opts, 'opts');
    assert.optionalString(opts.app, 'opts.app');
    assert.string(opts.svc, 'opts.svc');
    assert.func(cb, 'cb');

    if (!opts.app) {
        opts.app = 'sdc';
    }
    var svc, vms;

    vasync.pipeline({funcs: [
            function _getSvc(_, next) {
                self.getSvc(opts, function (err, service) {
                    if (err) {
                        return next(err);
                    }
                    svc = service;
                    return next();
                });
            },
            function _getVms(_, next) {
                self.vmapi.listVms({
                    'tag.smartdc_role': svc.name,
                    state: 'active'
                }, function (vmsErr, vms_) {
                    if (vmsErr) {
                        return next(vmsErr);
                    }
                    if (!vms_.length) {
                        return next(new errors.SDCClientError(new Error(format(
                             'Unable to find %s VMs', svc.name)),
                             'vmapi'));
                    }

                    vms = vms_;
                    return next();
                });
            }
    ]}, function pipeCb(err) {
        if (err) {
            return cb(err);
        }

        var imgs = [];

        var differentImgUUIDs = vms.map(function (vm) {
            return (vm.image_uuid);
        }).sort().filter(function (id, pos, ary) {
            // Once we've sorted out the array, we can remove any duplicates
            // just by looking up at the previous element. Obviously, first one
            // will never be removed.
            return (!pos || id !== ary[pos - 1]);
        });

        vasync.forEachParallel({
            func: function _getImg(id, next) {
                self.getImage({uuid: id}, function (er3, img) {
                    if (er3) {
                        return next(er3);
                    }
                    imgs.push(img);
                    return next();
                });
            },
            inputs: differentImgUUIDs
        }, function paraCb(err2) {
            if (err2) {
                return cb(err2);
            }
            return cb(null, {imgs: imgs, vms: vms});
        });
    });
};


/**
 * Get the default channel used to retrieve images for updates.
 *
 * This may be either the local channel when set, or the default remote, when
 * there is no local setting.
 *
 * @param cb {Function} `function (err, channel)`
 */
SdcAdm.prototype.getDefaultChannel = function getDefaultChannel(cb) {
    var self = this;

    var app = self.sdc;

    if (self.updates.channel) {
        cb(null, self.updates.channel);
    } else if (app.metadata.update_channel) {
        cb(null, app.metadata.update_channel);
    } else {
        self.updates.listChannels({}, function (err, channels) {
            if (err) {
                var e = new errors.SDCClientError(err, 'imgapi');
                return cb(e);
            }

            var remote = channels.filter(function (c) {
                return (c['default']);
            }).shift();

            return cb(null, remote.name);
        });

    }
};



/*
 * Fetch a given agent installer image (or if desired, latest), download it,
 * then deploy it on the selected servers.
 *
 * @param options.agentsshar {String} A string indicating the agentsshar to
 *      which to update. This is the string 'latest', an updates server UUID, or
 *      a path to a locally downloaded agentsshar.
 * @param options.all {Boolean} Update on all setup servers.
 *      One of `options.all` or `options.servers` must be specified.
 * @param options.servers {Array} Array of server hostnames or UUIDs on which
 *      to update. One of `options.all` or `options.servers` must be specified.
 * ...
 *
 * TODO: finish documenting
 * TODO: refactor to lib/steps/, separate out the image lookup, the download
 */
SdcAdm.prototype.updateAgents = function updateAgents(options, callback) {
    assert.object(options, 'options');
    assert.string(options.agentsshar, 'options.agentsshar');
    assert.optionalBool(options.justDownload, 'options.justDownload');
    assert.optionalBool(options.yes, 'options.yes');
    assert.optionalBool(options.all, 'options.all');
    assert.optionalArrayOfString(options.servers, 'options.servers');
    assert.func(options.progress, 'options.progress');
    assert.func(callback, 'callback');

    if ((options.all && options.servers) ||
        (!options.all && !options.servers)) {
        return callback(new Error(
            'must specify exactly one of "options.all" or "options.servers"'));
    }

    var self = this;
    var log = self.log;

    var startTime = Date.now();
    var downloadDir = '/var/tmp';
    var filepath;
    var channel;
    var image;
    // The file name, to be used by ur:
    var fname;
    var progress = options.progress;
    var justDownload = options.justDownload;
    var hist;

    function setImageToLatest(cb) {
        var filter = {
            name: 'agentsshar'
        };
        progress('Finding latest "agentsshar" on updates server (channel "%s")',
            channel);
        self.updates.listImages(filter, function (err, images) {
            if (err) {
                cb(new errors.SDCClientError(err, 'updates'));
                return;
            }
            if (Array.isArray(images) && !images.length) {
                return cb(new errors.UpdateError('no images found'));
            }
            common.sortArrayOfObjects(images, ['published_at']);
            image = images[images.length - 1];
            progress('Latest is agentsshar %s (%s)', image.uuid, image.version);
            cb();
        });
    }

    function setImageFromUuid(imageUuid, cb) {
        self.updates.getImage(imageUuid, function (err, foundImage) {
            if (err) {
                cb(new errors.SDCClientError(err, 'updates'));
                return;
            }
            image = foundImage;
            progress('Found agentsshar %s (%s)', image.uuid, image.version);
            cb();
        });
    }

    function sha1Path(filePath, cb) {
        var hash = crypto.createHash('sha1');
        var s = fs.createReadStream(filePath);
        s.on('data', function (d) {
            hash.update(d);
        });
        s.on('end', function () {
            cb(null, hash.digest('hex'));
        });
    }

    vasync.pipeline({arg: {}, funcs: [
        function getChannelIfNeeded(_, next) {
            if (options.agentsshar === 'latest' ||
                common.UUID_RE.test(options.agentsshar))
            {
                self.getDefaultChannel(function (err, ch) {
                    channel = ch;
                    next(err);
                });
            } else {
                next();
            }
        },

        function setImageOrFilepath(_, next) {
            if (options.agentsshar === 'latest') {
                setImageToLatest(next);
            } else if (common.UUID_RE.test(options.agentsshar)) {
                setImageFromUuid(options.agentsshar, next);
            } else if (fs.existsSync(options.agentsshar)) {
                filepath = options.agentsshar;
                next();
            } else {
                next(new Error(format('could not find agentsshar: "%s" is ' +
                    'not a UUID or an existing file', options.agentsshar)));
            }
        },

        /*
         * If we are about to download an image, first check to see if that
         * image is already available locally (verifying via checksum).
         * If so, then switch to using that file.
         */
        function haveSharAlready_candidate1(ctx, next) {
            if (filepath) {
                return next();
            }

            // lla == "Latest Local Agentsshar"
            var llaLink = '/usbkey/extra/agents/latest';
            fs.exists(llaLink, function (exists) {
                if (!exists) {
                    log.debug({llaLink: llaLink}, 'symlink to latest ' +
                        'agentsshar is missing, skipping shortcut');
                    return next();
                }
                fs.readlink(llaLink, function (err, linkTarget) {
                    if (err) {
                        log.error({err: err, llaLink: llaLink},
                            'could not read agents "latest" symlink');
                        return next(new errors.UpdateError(err,
                            'could not read agents "latest" symlink, ' +
                            llaLink));
                    }

                    var llaPath = path.resolve(
                        path.dirname(llaLink), linkTarget);
                    log.debug({llaPath: llaPath}, 'latest local agentsshar');
                    sha1Path(llaPath, function (checksumErr, checksum) {
                        if (checksumErr) {
                            return next(checksumErr);
                        }
                        if (checksum === image.files[0].sha1) {
                            progress('The %s agentsshar already exists ' +
                                'at %s, using it', options.agentsshar,
                                llaPath);
                            filepath = llaPath;
                        }
                        next();
                    });
                });
            });
        },
        function haveSharAlready_candidate2(ctx, next) {
            if (filepath) {
                return next();
            }

            var predownloadedPath = path.resolve(downloadDir,
                'agent-' + image.uuid + '.sh');
            fs.exists(predownloadedPath, function (exists) {
                if (!exists) {
                    return next();
                }
                sha1Path(predownloadedPath, function (checksumErr, checksum) {
                    if (checksumErr) {
                        return next(checksumErr);
                    }
                    if (checksum === image.files[0].sha1) {
                        progress('The %s agentsshar already exists ' +
                            'at %s, using it', options.agentsshar,
                            predownloadedPath);
                        filepath = predownloadedPath;
                    }
                    next();
                });
            });
        },

        function listServers(ctx, next) {
            if (justDownload) {
                return next();
            }
            progress('Finding servers to update');
            // Get all servers to validate if unsetup servers are selected.
            self.cnapi.listServers({}, function (err, servers) {
                if (err) {
                    return next(err);
                }
                ctx.allServers = servers;
                next();
            });
        },

        function findServersToUpdate(ctx, next) {
            if (justDownload) {
                return next();
            }

            if (options.all) {
                ctx.serversToUpdate = ctx.allServers.filter(function (svr) {
                    return svr.setup;
                });
                next();
            } else {
                var i, s;
                var serverFromUuid = {};
                var serverFromHostname = {};
                for (i = 0; i < ctx.allServers.length; i++) {
                    s = ctx.allServers[i];
                    serverFromUuid[s.uuid] = s;
                    serverFromHostname[s.hostname] = s;
                }

                ctx.serversToUpdate = [];
                var serverToUpdateFromUuid = {};
                var unsetupServerIds = [];
                var notFoundServerIds = [];
                for (i = 0; i < options.servers.length; i++) {
                    var id = options.servers[i];
                    s = serverFromUuid[id] || serverFromHostname[id];
                    if (s) {
                        // Avoid drop dupes in `opts.servers`.
                        if (! serverToUpdateFromUuid[s.uuid]) {
                            ctx.serversToUpdate.push(s);
                            serverToUpdateFromUuid[s.uuid] = true;
                        }
                        if (!s.setup) {
                            unsetupServerIds.push(id);
                        }
                    } else {
                        notFoundServerIds.push(id);
                    }
                }
                if (notFoundServerIds.length) {
                    next(new Error(format(
                        '%d of %d selected servers were not found in CNAPI: %s',
                        notFoundServerIds.length, options.servers.length,
                        notFoundServerIds.join(', '))));
                } else if (unsetupServerIds.length) {
                    next(new Error(format(
                        '%d of %d selected servers are not setup: %s',
                        unsetupServerIds.length, options.servers.length,
                        unsetupServerIds.join(', '))));
                } else {
                    next();
                }
            }
        },

        function urDiscoveryGetReady(_, next) {
            if (justDownload) {
                return next();
            }

            self.ur.once('error', function (err) {
                log.debug({err: err}, 'Ur error');
                return next(new errors.InternalError({
                    cause: err,
                    message: 'Error Connecting to Ur'
                }));
            });

            // If the connection times out, this will never be reached, and the
            // function above should call next
            self.ur.once('ready', function () {
                log.debug('ur ready');
                return next();
            });
        },

        function urDiscovery(ctx, next) {
            if (justDownload) {
                return next();
            }

            ctx.urServersToUpdate = [];
            var onceNext = once(next);

            var disco = self.ur.discover({
                timeout: 10 * 1000,
                exclude_headnode: false,
                node_list: ctx.serversToUpdate.map(
                    function (s) { return s.uuid; })
            });

            disco.on('server', function discoServer(urServer) {
                log.trace({urServer: urServer}, 'discoServer');
                ctx.urServersToUpdate.push(urServer);
            });

            disco.on('error', function discoError(err) {
                if (err.nodes_missing && err.nodes_missing.length) {
                    log.debug({nodes_missing: err.nodes_missing},
                        'ur disco nodes missing');
                    progress('Could not find %d servers (ur did not ' +
                        'respond to discovery): %s', err.nodes_missing.length,
                        err.nodes_missing.join(', '));
                } else {
                    progress('Unexpected ur discovery failure:', err);
                }
                onceNext(err);
            });

            disco.on('duplicate', function discoDup(dupUuid, dupHostname) {
                var err = new errors.InternalError({
                    message: format('Duplicate server found during ur ' +
                        'discovery: uuid=%s dupHostname=%s',
                        dupUuid, dupHostname)
                });
                err.duplicate = [dupUuid, dupHostname];

                /*
                 * We are done with this discovery session.  Cancel it and
                 * ignore future error/end events.
                 */
                disco.cancel();
                onceNext(err);
            });

            disco.on('end', function discoEnd() {
                log.trace('discoEnd');
                next();
            });
        },

        function earlyAbortForJustDownload(ctx, next) {
            if (justDownload && filepath) {
                progress('Agentsshar is already downloaded to %s', filepath);
                next(true); // early abort signal
            } else {
                next();
            }
        },

        function confirm(ctx, next) {
            progress('\nThis update will make the following changes:');
            if (!filepath) {
                assert.object(image, 'image');
                progress(common.indent(format(
                    'Download agentsshar %s\n    (%s)',
                    image.uuid, image.version)));
            }
            if (!justDownload) {
                progress(common.indent(format(
                    'Update GZ agents on %d (of %d) servers using\n' +
                    '    agentsshar %s', ctx.serversToUpdate.length,
                    ctx.allServers.length,
                    (filepath ? filepath : image.version))));
            }
            progress('');
            if (options.yes) {
                return next();
            }
            var msg = 'Would you like to continue? [y/N] ';
            common.promptYesNo({msg: msg, default: 'n'}, function (answer) {
                if (answer !== 'y') {
                    progress('Aborting agents update');
                    return callback();
                }
                progress('');
                startTime = Date.now(); // Reset to not count confirm time.
                return next();
            });
        },

        function saveChangesToHistory(_, next) {
            if (justDownload) {
                return next();
            }
            var change = {
                service: {
                    name: 'agentsshar'
                },
                type: 'update-service',
                img: (image ? image : options.agentsshar)
            };

            self.history.saveHistory({
                changes: [change]
            }, function (err, hst) {
                if (err) {
                    return next(err);
                }
                hist = hst;
                return next();
            });
        },

        function downloadAgentsshar(ctx, next) {
            if (filepath) {
                return next();
            }
            filepath = path.resolve(downloadDir,
                'agent-' + image.uuid + '.sh');
            ctx.deleteAgentssharOnFinish = true;
            progress('Downloading agentsshar from updates server ' +
                '(channel "%s")\n    to %s', channel, filepath);
            self.updates.getImageFile(image.uuid, filepath, function (err) {
                if (err) {
                    next(new errors.SDCClientError(err, 'updates'));
                } else {
                    next();
                }
            });
        },

        function copyFileToAssetsDir(_, next) {
            if (justDownload) {
                return next();
            }
            var assetsdir = '/usbkey/extra/agents';
            if (path.dirname(filepath) === assetsdir) {
                return next();
            }
            progress('Copy agentsshar to assets dir:', assetsdir);
            var argv = ['cp', filepath, assetsdir];
            mkdirp.sync(assetsdir);
            common.execFilePlus({
                argv: argv,
                log: self.log
            }, function (err, stderr, stdout) {
                self.log.trace({
                    cmd: argv.join(' '),
                    err: err,
                    stdout: stdout,
                    stderr: stderr
                }, 'ran cp command');
                if (err) {
                    return next(new errors.InternalError({
                        message: format('error copying shar file to %s',
                                         assetsdir),
                        cmd: argv.join(' '),
                        stdout: stdout,
                        stderr: stderr,
                        cause: err
                    }));
                }
                next();
            });
        },

        function createLatestSymlink(_, next) {
            if (justDownload) {
                return next();
            }
            // TODO: this should just use `fs.unlink/symlink`.
            progress('Create /usbkey/extra/agents/latest symlink');
            common.execFilePlus({
                argv: [ 'rm', '-f', '/usbkey/extra/agents/latest' ],
                log: self.log
            }, function (rmErr) {
                if (rmErr) {
                    return next(rmErr);
                }
                fname = path.basename(filepath);
                common.execFilePlus({
                    argv: ['ln', '-s', fname, 'latest'],
                    cwd: '/usbkey/extra/agents',
                    log: self.log
                }, function (lnErr) {
                    if (lnErr) {
                        return next(lnErr);
                    }
                    return next();
                });
            });
        },

        function updateCNAgents(ctx, next) {
            if (justDownload) {
                return next();
            }

            progress('Starting agentsshar update on %d servers',
                ctx.urServersToUpdate.length);

            var ip = self.config.assets_admin_ip;
            var f = fname;
            var ff = '/var/tmp/' + f;
            // Do not override log file if we run installer more than once for
            // the same version.
            // TODO(trent): Won't these build up? Should clean these out.
            var lf = '/var/tmp/' + f + '_' + uuid() + '_install.log';
            var nodeConfigCmd = [
                'cd /var/tmp;',
                '',
                /*
                 * Rename previous node.config file, if exists
                 */
                'if [[ -f /var/tmp/node.config/node.config ]]; then',
                '   mv /var/tmp/node.config/node.config ' +
                    '/var/tmp/node.config/node.\$\$.config',
                'fi',
                '',
                /*
                 * Update node.config first, just in case
                 *
                 * Exit 33 if cannot download the node.config file
                 */
                'if [[ -z "$(bootparams | grep \'^headnode=true\')" ]]; then',
                '   if [[ ! -d  /var/tmp/node.config ]]; then',
                '       rm /var/tmp/node.config',
                '       mkdir -p /var/tmp/node.config',
                '   fi',
                '',
                '   /usr/bin/curl -ksf ' + ip +
                        ':/extra/joysetup/node.config' +
                        ' -o /var/tmp/node.config/node.config',
                '   if [[ "$?" -ne "0" ]]; then',
                '       exit 33',
                '   fi',
                '',
                /*
                 * Exit non zero if config dir does not exist
                 */
                '   if [[ ! -d  /opt/smartdc/config && -z "$IS_CN" ]]; then',
                '       exit 44',
                '   fi',
                '',
                '   /usr/bin/cp /var/tmp/node.config/node.config '+
                '/opt/smartdc/config/',
                'fi',
                ''
            ].join('\n');

            var downloadCmd = [
                'cd /var/tmp;',
                /*
                 * Exit non zero if agents dir does not exist
                 */
                'if [[ ! -d  /opt/smartdc/agents/lib ]]; then',
                '   exit 50',
                'fi',
                '',
                /*
                 * Exit 22 if cannot download the installer file (curl code)
                 */
                '/usr/bin/curl -kOsf ' + ip + ':/extra/agents/' + f,
                'if [[ "$?" -ne "0" ]]; then',
                '   exit $?',
                'fi',
                ''
            ].join('\n');

            var installCmd = [
                'cd /var/tmp;',
                '',
                /*
                 * Exit 60 if installer fails
                 */
                '/usr/bin/bash ' + ff + ' </dev/null >' + lf +' 2>&1',
                'if [[ "$?" -ne "0" ]]; then',
                '   exit 60',
                'fi',
                ''
            ].join('\n');

            vasync.forEachPipeline({
                inputs: [
                    {
                        str: nodeConfigCmd,
                        progbarName: 'Updating node.config'
                    },
                    {
                        str: downloadCmd,
                        progbarName: 'Downloading agentsshar'
                    },
                    {
                        str: installCmd,
                        progbarName: 'Installing agentsshar',
                        logFile: lf
                    }
                ],
                func: function runUrQueue(cmd, nextCmd) {
                    var queueOpts = {
                        sdcadm: self,
                        log: self.log,
                        progress: progress,
                        command: cmd.str,
                        concurrency: options.rate,
                        timeout: 10 * 60 * 1000
                    };

                    var bar;
                    if (process.stderr.isTTY) {
                        bar = new ProgressBar({
                            size: ctx.urServersToUpdate.length,
                            bytes: false,
                            filename: cmd.progbarName
                        });
                        queueOpts.progbar = bar;
                        bar.advance(0); // Draw initial progbar at 0.
                    }
                    self.log.trace(
                        {command: cmd.str, concurrency: options.rate},
                        'runUrQueue');

                    var rq = ur.runQueue(queueOpts, function (err, results) {
                        if (err) {
                            return nextCmd(new errors.UpdateError(
                                err, 'unexpected runQueue error'));
                        }

                        var errs = [];
                        results.forEach(function (r) {
                            if (r.error || r.result.exit_status !== 0) {
                                errs.push(new errors.UpdateError(format(
                                    '%s failed on server %s (%s): %j',
                                    cmd.progbarName, r.uuid, r.hostname,
                                    r.error || r.result)));
                            }
                        });
                        if (errs.length === 1) {
                            nextCmd(errs[0]);
                        } else if (errs.length > 1) {
                            nextCmd(new errors.MultiError(errs));
                        } else {
                            nextCmd();
                        }
                    });

                    rq.on('success', function onSuccess(server, result) {
                        // A non-zero exit from the command is a "success".
                        if (result.exit_status !== 0) {
                            var errmsg = format(
                                '%s failed on server %s (%s): %j',
                                cmd.progbarName, server.uuid,
                                server.hostname, result);
                            if (cmd.logFile) {
                                errmsg += ' (log file on server: ' +
                                    cmd.logFile + ')';
                            }
                            if (bar) {
                                bar.log(errmsg);
                            } else {
                                console.log(errmsg);
                            }
                        }
                    });

                    rq.start();
                    ctx.urServersToUpdate.forEach(function (us) {
                        rq.add_server(us);
                    });
                    rq.close();
                }
            }, function doneCmds(err, _) {
                next(err);
            });
        },

        function closeUr(_, next) {
            if (justDownload) {
                return next();
            }
            self.ur.close();
            next();
        },

        function doCleanup(ctx, next) {
            if (justDownload) {
                return next();
            }
            if (ctx.deleteAgentssharOnFinish) {
                progress('Deleting temporary %s', filepath);
                fs.unlink(filepath, function (err) {
                    if (err) {
                        self.log.warn(err, 'could not unlink %s', filepath);
                    }
                    next();
                });
            } else {
                next();
            }
        },

        // At this point we can consider the update complete. The next step
        // is just about providing accurate information when listing agent
        // instances and until we move from update agents using a shar file
        // to the individual agents update.
        function refreshSysinfo(ctx, next) {
            if (justDownload) {
                return next();
            }

            progress('Reloading sysinfo on updated servers');

            var queue = vasync.queue(
                function upSysinfo(server, cb) {
                    self.cnapi.refreshSysinfoAndWait(
                        server.uuid,
                        self.config.wfapi.url,
                        {},
                        function cnapiCb(err, job) {
                        if (err) {
                            self.log.error({
                                err: err,
                                server: server
                            }, 'CNAPI sysinfo-refresh');
                        }
                        if (job && job.execution === 'failed') {
                            self.log.debug({
                                job: job,
                                server: server
                            }, 'CNAPI sysinfo-refresh job failed');

                        }
                        return cb();
                    });
                },
                10);

            queue.push(ctx.serversToUpdate); // No need for per task done cb
            queue.close();
            queue.on('end', function done() {
                progress('Sysinfo reloaded for all the running servers');
                next();
            });
        },

        /*
         * This is a HACK workaround for a possible race in config-agent
         * restarts. See TOOLS-1084. This doesn't actually fully close the
         * race.
         */
        function refreshConfigAgents(ctx, next) {
            if (justDownload) {
                return next();
            }
            progress('Refreshing config-agent on all the updated servers');

            var queue = vasync.queue(
                function refreshCfgAgent(server, cb) {
                    svcadm.svcadmRefresh({
                        server_uuid: server.uuid,
                        wait: false,
                        fmri: 'config-agent',
                        sdcadm: self,
                        log: self.log
                    }, cb);
                },
                10);
            queue.push(ctx.serversToUpdate); // No need for per task done cb
            queue.close();
            queue.on('end', function done() {
                progress('Config-agent refreshed on updated servers');
                next();
            });
        }

    ]}, function finishUpdateAgents(err) {
        if (err === true) { // early abort signal
            err = null;
        }
        if (justDownload) {
            return callback(err);
        }

        if (!hist) {
            callback(err);
        } else {
            hist.error = err;
            self.history.updateHistory(hist, function (histErr) {
                if (err) {
                    return callback(err);
                }
                progress('Successfully updated agents (%s)',
                    common.humanDurationFromMs(Date.now() - startTime));
                callback(histErr);
            });
        }
    });
};


/*
 * Fetch a given gz-tools tarball image (or if desired, latest), download it,
 * then do the following:
 *
 * - Update SDC zone tools (tools.tar.gz)
 * - Update GZ scripts
 * - Update /usbkey/default
 * - Update cn_tools.tar.gz on all Compute Nodes
 */
SdcAdm.prototype.updateGzTools = function updateGzTools(options, callback) {
    assert.object(options, 'options');
    assert.string(options.image, 'options.image');
    assert.func(options.progress, 'opts.progress');

    var self = this;
    var localdir = '/var/tmp';
    var deleteOnFinish = true;
    var filepath;
    var image;
    var sdcZone;
    var progress = options.progress;
    var timestamp = Math.floor(new Date().getTime() / 1000);
    var tmpToolsDir = format('%s/gz-tools', localdir);
    var justDownload = options.justDownload;
    var forceReinstall = options.forceReinstall;
    var localVersion;
    // Used by sdcadm history:
    var changes = [];
    var hist;

    function findTarballImageLatest(cb) {
        var filter = {
            name: 'gz-tools'
        };
        self.updates.listImages(filter, function (err, images) {
            if (err) {
                cb(new errors.SDCClientError(err, 'updates'));
                return;
            }
            if (Array.isArray(images) && !images.length) {
                return cb(new errors.UpdateError('no images found'));
            }
            common.sortArrayOfObjects(images, ['published_at']);
            image = images[images.length - 1];

            cb();
        });
        return;
    }

    function findTarballImageByUuid(cb) {
        self.updates.getImage(options.image, function (err, foundImage) {
            if (err) {
                cb(new errors.SDCClientError(err, 'updates'));
                return;
            }
            image = foundImage;
            cb();
        });
    }

    function downloadTarballImage(cb) {
        progress('Downloading gz-tools');
        progress(common.indent(util.format('image: %s (%s)',
                        image.uuid, image.version)));
        progress(common.indent(util.format('to: %s', filepath)));

        function onImage(err) {
            if (err) {
                cb(new errors.SDCClientError(err, 'updates'));
                return;
            }
            cb();
        }

        self.updates.getImageFile(image.uuid, filepath, onImage);
    }

    function updateSdcFiles(cb) {
        progress('Updating "sdc" zone tools');
        vasync.pipeline({funcs: [
            function removeSymlink(_, next) {
                var argv = ['rm', '-rf', '/opt/smartdc/sdc'];
                common.execFilePlus({argv: argv, log: self.log}, next);
            },
            function reSymlink(_, next) {
                var argv = [
                    'ln', '-s',
                    '/zones/' + sdcZone.uuid + '/root/opt/smartdc/sdc',
                    '/opt/smartdc/sdc'
                ];
                common.execFilePlus({argv: argv, log: self.log}, next);
            },
            function decompressTools(_, next) {
                // tools.tar.gz will be located at $tmpToolsDir/tools.tar.gz
                var argv = [
                    '/usr/bin/tar',
                    'xzof',
                    tmpToolsDir + '/tools.tar.gz',
                    '-C', '/opt/smartdc'
                ];
                common.execFilePlus({argv: argv, log: self.log}, next);
            },
            function cleanupSemverFile(_, next) {
                // Remove semver.js from an old sdc-clients-light version
                var sverFile = '/opt/smartdc/node_modules/sdc-clients/' +
                    'node_modules/semver.js';

                if (!fs.existsSync(sverFile)) {
                    next();
                    return;
                }

                fs.unlink(sverFile, function (err) {
                    if (err) {
                        self.log.warn(err, 'unlinking %s', sverFile);
                    }
                    next();
                });
            }
        ]}, function (err) {
            cb(err);
        });
    }

    function updateScripts(cb) {
        progress('Updating global zone scripts');
        vasync.pipeline({funcs: [
            function mountUsbKey(_, next) {
                progress('Mounting USB key');
                var argv = ['/usbkey/scripts/mount-usb.sh'];
                common.execFilePlus({argv: argv, log: self.log}, next);
            },

            function backupScriptsDir(_, next) {
                var argv = [
                    'cp', '-Rp',
                    '/usbkey/scripts',
                    localdir + '/pre-upgrade.scripts.' + timestamp
                ];
                common.execFilePlus({argv: argv, log: self.log}, next);
            },

            function backupToolsFile(_, next) {
                if (!fs.existsSync('/usbkey/tools.tar.gz')) {
                    next();
                    return;
                }
                var argv = [
                    'cp',
                    '/usbkey/tools.tar.gz',
                    localdir + '/pre-upgrade.tools.' + timestamp + '.tar.gz'
                ];
                common.execFilePlus({argv: argv, log: self.log}, next);
            },

            function removeScriptsDir(_, next) {
                var argv = [
                    'rm', '-rf',
                    '/mnt/usbkey/scripts'
                ];
                common.execFilePlus({argv: argv, log: self.log}, next);
            },

            function copyScriptsToUSBKey(_, next) {
                var argv = [
                    'cp', '-Rp',
                    tmpToolsDir + '/scripts',
                    '/mnt/usbkey/'
                ];
                common.execFilePlus({argv: argv, log: self.log}, next);
            },

            function copyToolsToUSBKey(_, next) {
                var argv = [
                    'cp',
                    tmpToolsDir + '/tools.tar.gz',
                    '/mnt/usbkey/tools.tar.gz'
                ];
                common.execFilePlus({argv: argv, log: self.log}, next);
            },

            function copyDefaultDirToUsbKey(_, next) {
                var cmd = ['cp', tmpToolsDir + '/default/*',
                    '/mnt/usbkey/default'];

                exec(cmd.join(' '), function (err, stdout, stderr) {
                    self.log.trace({cmd: cmd, err: err, stdout: stdout,
                        stderr: stderr}, 'ran cp command');
                    if (err) {
                        return next(new errors.InternalError({
                            message: 'error running cp command',
                            cmd: cmd,
                            stdout: stdout,
                            stderr: stderr,
                            cause: err
                        }));
                    }
                    next();
                });
            },

            function rsyncScriptsToCache(_, next) {
                var argv = [
                    'rsync', '-avi',
                    '--exclude', 'private',
                    '--exclude', 'os',
                    '/mnt/usbkey/', '/usbkey/'
                ];
                common.execFilePlus({argv: argv, log: self.log}, next);
            },

            function copyJoysetup(_, next) {
                var argv = [
                    'cp',
                    tmpToolsDir + '/scripts/joysetup.sh',
                    '/usbkey/extra/joysetup/'
                ];
                common.execFilePlus({argv: argv, log: self.log}, next);
            },

            function copyAgentSetup(_, next) {
                var argv = [
                    'cp',
                    tmpToolsDir + '/scripts/agentsetup.sh',
                    '/usbkey/extra/joysetup/'
                ];
                common.execFilePlus({argv: argv, log: self.log}, next);
            },


            function unmountUsbKey(_, next) {
                progress('Unmounting USB key');
                var argv = ['/usr/sbin/umount', '/mnt/usbkey'];
                common.execFilePlus({argv: argv, log: self.log}, next);
            }
        ]}, function (err) {
            cb(err);
        });
    }

    function updateCnTools(cb) {
        progress('Updating cn_tools on all compute nodes');

        var argv = [
            '/usbkey/scripts/update_cn_tools', '-f',
            tmpToolsDir + '/cn_tools.tar.gz'
        ];
        common.execFilePlus({argv: argv, log: self.log}, cb);
    }

    function cleanup(cb) {
        progress('Cleaning up gz-tools tarball');
        fs.unlink(filepath, function (err) {
            if (err) {
                self.log.warn(err, 'unlinking %s', filepath);
            }
            cb();
        });
    }

    vasync.pipeline({funcs: [
        function getChannelIfNeeded(_, next) {
            self.getDefaultChannel(function (err, channel) {
                // Will not fail the whole operation due to channel not found
                if (err) {
                    return next();
                }
                if (options.image === 'latest' ||
                        !fs.existsSync(options.image)) {
                    progress('Using channel %s', channel);
                }
                return next();
            });
        },

        function findImage(_, next) {
            if (options.image === 'latest') {
                findTarballImageLatest(next);
            // Check if the value of the parameter `image` is a file
            } else if (fs.existsSync(options.image)) {
                filepath = options.image;
                deleteOnFinish = false;
                next();
            } else {
                findTarballImageByUuid(next);
            }
        },

        function checkLocalToolsVersion(_, next) {
            var toolsImg = '/opt/smartdc/etc/gz-tools.image';
            fs.stat(toolsImg, function (err, st) {
                if (err) {
                    // Just ignore the previous version if cannot read the file
                    return next();
                }
                fs.readFile(toolsImg, 'utf8', function (er2, data) {
                    if (er2) {
                        return next();
                    }
                    localVersion = data.trim();
                    progress('UUID of latest installed gz-tools image ' +
                                    'is:\n  %s\n', localVersion);
                    if (localVersion === image.uuid && !forceReinstall) {
                        progress('Image %s is already installed.',
                                localVersion);
                        progress('Please re-run with `--force-reinstall` ' +
                                'if you want to override installed image');
                        return callback();
                    }
                    return next();
                });

            });
        },
        function ensureSdcInstance(_, next) {
            var filters = {
                state: 'active',
                owner_uuid: self.config.ufds_admin_uuid,
                'tag.smartdc_role': 'sdc'
            };
            self.vmapi.listVms(filters, function (vmsErr, vms) {
                if (vmsErr) {
                    return next(vmsErr);
                }
                if (Array.isArray(vms) && !vms.length) {
                    return next(new errors.UpdateError('no "sdc" VM ' +
                        'instance found'));
                }
                sdcZone = vms[0];
                return next();
            });
        },
        function saveHistory(_, next) {
            if (justDownload) {
                return next();
            }
            changes.push({
                service: {
                    name: 'gz-tools'
                },
                type: 'update-service',
                img: (image ? image : options.image)
            });
            self.history.saveHistory({
                changes: changes
            }, function (err, hst) {
                if (err) {
                    return next(err);
                }
                hist = hst;
                return next();
            });
        },
        function downloadTarball(_, next) {
            if (filepath) {
                progress('Using gz-tools tarball file %s', filepath);
                next();
            } else {
                if (image.name !== 'gz-tools' && !options.force) {
                    callback(new errors.UsageError(
                        'name of image by given uuid is not \'gz-tools\''));
                }
                filepath = format('%s/gz-tools-%s.tgz', localdir, image.uuid);

                if (fs.existsSync(filepath)) {
                    progress('Using gz-tools tarball file %s ' +
                            'from previous download', filepath);
                    next();
                } else {
                    downloadTarballImage(next);
                }
            }
        },
        function decompressTarball(_, next) {
            if (justDownload) {
                deleteOnFinish = false;
                return next();
            }
            var argv = [
                '/usr/bin/tar',
                'xzvof',
                filepath,
                '-C', localdir
            ];

            progress('Decompressing gz-tools tarball');
            common.execFilePlus({argv: argv, log: self.log}, next);
        },
        function (_, next) {
            if (justDownload) {
                return next();
            }
            updateSdcFiles(next);
        },
        function (_, next) {
            if (justDownload) {
                return next();
            }
            updateScripts(next);
        },
        function (_, next) {
            if (justDownload) {
                return next();
            }
            updateCnTools(next);
        },
        function (_, next) {
            if (deleteOnFinish) {
                cleanup(next);
            } else {
                next();
            }
        }
    ]}, function (err) {
        if (justDownload) {
            callback(err);
        } else if (hist) {
            if (err) {
                if (!hist) {
                    self.log.warn('History not saved for update-gz-tools');
                    return callback(err);
                }
                hist.error = err;
            }

            if (!hist) {
                self.log.warn('History not saved for update-gz-tools');
                return callback();
            }
            self.history.updateHistory(hist, function (err2) {
                if (err) {
                    callback(err);
                } else if (err2) {
                    callback(err2);
                } else {
                    callback();
                }
            });
        } else {
            callback(err);
        }
    });
};


/**
 * Return an array of candidate images (the full image objects) for a
 * give service update. If available, the oldest current instance image is
 * included.
 *
 * TODO: support this for a particular instance as well by passing in `inst`.
 *
 * @param options {Object} Required.
 *      - service {Object} Required. The service object as from `getServices()`.
 *      - insts {Array} Required. Current DC instances as from `listInsts()`.
 * @param cb {Function} `function (err, img)`
 */
SdcAdm.prototype.getCandidateImages = function getCandidateImages(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.service, 'opts.service');
    assert.arrayOfObject(opts.insts, 'opts.insts');
    assert.func(cb, 'cb');
    var self = this;

    var currImgs = [];
    var imgs;

    vasync.pipeline({funcs: [
        function getCurrImgs(_, next) {
            var currImgUuids = {};
            opts.insts.forEach(function (inst) {
                if (inst.service === opts.service.name) {
                    currImgUuids[inst.image] = true;
                }
            });
            currImgUuids = Object.keys(currImgUuids);
            if (currImgUuids.length === 0) {
                // No insts -> use the image_uuid set on the service.
                assert.ok(opts.service.params.image_uuid,
                    'service object has no "params.image_uuid": '
                    + JSON.stringify(opts.service));
                currImgUuids.push(opts.service.params.image_uuid);
            }

            self.log.debug({currImgUuids: currImgUuids},
                'getCandidateImages: getCurrImgs');
            vasync.forEachParallel({inputs: currImgUuids, func:
                function getImg(imgUuid, nextImg) {
                    self.getImage({uuid: imgUuid}, function (iErr, img) {
                        if (iErr && iErr.body &&
                            iErr.body.code === 'ResourceNotFound')
                        {
                            /**
                             * Don't error out for those weird cases where
                             * (a) the image was removed from local imgapi; and
                             * (b) is so old it isn't in the updates server.
                             */
                            nextImg();
                        } else if (iErr) {
                            nextImg(iErr);
                        } else {
                            currImgs.push(img);
                            nextImg();
                        }
                    });
                }
            }, next);
        },

        function getCandidates(_, next) {
            /**
             * Which images to consider for an update? Consider a service with
             * 3 instances at image versions A, A and C. (Note that
             * `published_at` is the field used to order images with the
             * same name.)
             *
             * Ideally we allow 'B', 'C' and anything after 'C' as candidate
             * updates. So we'll look for images published after 'A'
             * (including 'A' to allow same-image updates for dev/testing).
             */
            common.sortArrayOfObjects(currImgs, ['published_at']);
            var name = self.config.imgNameFromSvcName[opts.service.name];
            if (!name) {
                return next(new errors.InternalError({
                    message: format('do not know image name for service "%s"',
                        opts.service.name)
                }));
            }
            var filter = {
                name: name,
                marker: (currImgs.length > 0
                    ? currImgs[0].published_at : undefined)
            };

            self.log.debug({filter: filter},
                'getCandidateImages: getCandidates');
            self.updates.listImages(filter, function (uErr, followingImgs) {
                if (uErr) {
                    return next(uErr);
                }

                // TOOLS-745: Validate that the name of the retrieved images
                // matches the name of the service we're trying to update:
                followingImgs = followingImgs.filter(function (i) {
                    return (i.name ===
                            self.config.imgNameFromSvcName[opts.service.name]);
                });
                if (currImgs.length > 0) {
                    // TODO this is wrong, I think we can drop it now
                    //      with marker=published_at
                    imgs = [currImgs[0]].concat(followingImgs);
                } else {
                    imgs = followingImgs;
                }
                next();
            });
        }
    ]}, function done(err) {
        cb(err, imgs);
    });
};


SdcAdm.prototype.acquireLock = function acquireLock(opts, cb) {
    assert.object(opts, 'opts');
    assert.func(opts.progress, 'opts.progress');
    assert.func(cb, 'cb');
    var self = this;
    var log = self.log;

    var acquireLogTimeout = setTimeout(function () {
        opts.progress('Waiting for sdcadm lock');
    }, 1000);
    log.debug({lockPath: self._lockPath}, 'acquire lock');
    lock(self._lockPath, function (lockErr, unlock) {
        if (acquireLogTimeout) {
            clearTimeout(acquireLogTimeout);
        }
        if (lockErr) {
            cb(new errors.InternalError({
                message: 'error acquiring lock',
                lockPath: self._lockPath,
                cause: lockErr
            }));
            return;
        }
        log.debug({lockPath: self._lockPath}, 'acquired lock');
        cb(null, unlock);
    });
};

SdcAdm.prototype.releaseLock = function releaseLock(opts, cb) {
    assert.object(opts, 'opts');
    assert.func(opts.unlock, 'opts.unlock');
    assert.func(cb, 'cb');
    var self = this;
    var log = this.log;

    if (!opts.unlock) {
        return cb();
    }
    log.debug({lockPath: self._lockPath}, 'releasing lock');
    opts.unlock(function (unlockErr) {
        if (unlockErr) {
            cb(new errors.InternalError({
                message: 'error releasing lock',
                lockPath: self._lockPath,
                cause: unlockErr
            }));
            return;
        }
        log.debug({lockPath: self._lockPath}, 'released lock');
        cb();
    });
};


/*
 * Save the given reprovision failure message into the _reprovFailLockPath
 * file for future checks.
 */
SdcAdm.prototype.reprovFailLock_Lock =
function reprovFailLock_Lock(reason, cb) {
    var self = this;
    assert.string(reason, 'reason');
    assert.func(cb, 'cb');
    fs.writeFile(self._reprovFailLockPath, JSON.stringify({
        reason: reason
    }), 'utf8', cb);
};


/*
 * In case reprovision failed on a previous run and nobody took care of the
 * lock file, this method will return the reason of such reprovision failure
 * using signature `cb(null, reason <STRING>)`. Otherwise, it will return
 * `cb(err)`
 */
SdcAdm.prototype.reprovFailLock_IsLocked =
function reprovFailLock_IsLocked(cb) {
    var self = this;
    assert.func(cb, 'cb');
    fs.readFile(self._reprovFailLockPath, 'utf8', function (err, data) {
        if (err) {
            return cb(err);
        }
        return cb(null, data);
    });
};

/*
 * Just remove the _reprovFailLockPath file.
 */
SdcAdm.prototype.reprovFailLock_Unlock = function reprovFailLock_Unlock(cb) {
    var self = this;
    assert.func(cb, 'cb');
    fs.unlink(self._reprovFailLockPath, cb);
};



/**
 * Generate an update plan according to the given changes.
 * The caller should be holding a `<SdcAdm>.acquireLock()`.
 *
 * `changes` is an array of objects of the following form:
 *
 * 1. create-instance: 'type:create-instance' and 'service' and 'server'
 * 2. agent delete-instance:
 *          'type:delete-instance' and 'service' and 'server'
 *    or
 *          'type:delete-instance' and 'instance'
 *    Where 'instance' for an agent is '$server/$service', e.g.
 *    'c26c3aba-405b-d04b-b51d-5a68d8f950d7/provisioner'.
 * 3. vm delete-instance: 'type:delete' and 'instance' (the VM uuid or alias)
 * 4. delete-service: 'type:delete-service' and 'service'
 * 5. vm update-instance: 'instance', optional 'type:update-instance'
 * 6. agent update-instance:
 *          'service' and 'server'
 *    or
 *          'instance'
 *    with optional 'type:update-instance'.
 * 7. update-service: 'service', optional 'type:update-service'.
 *
 * Except for 'delete-service', 'image' is optional for all, otherwise the
 * latest available image is implied.
 *
 * @param options {Object}  Required.
 *      - changes {Array} Required. The update spec array of objects.
 *      - progress {Function} Optional. A function that is called
 *        with progress messages. Called like printf, i.e. passing in
 *        `console.log` or a Bunyan `log.info.bind(log)` is fine.
 *      - forceDataPath {Boolean} Optional. Allows data path components to be
 *        updated. Currently: portolan.
 *      - forceRabbitmq {Boolean} Optional. Allow rabbitmq to be updated, as it
 *        will not be by default
 *      - forceSameImage {Boolean} Optional. Allow an update to proceed even
 *        if the target image is the same as that of the current instance(s).
 *      - skipHACheck {Boolean} Optional. Allow instance creation even
 *        if the service is not supossed to have more than one instance
 *      - justImages {Boolean} Optional. Generate a plan that just imports
 *        the images. Default false.
 *      - updateAll {Boolean} Optional. genUpdatePlan will produce a less noisy
 *        output when updating all existing instances. Default false.
 *      - justAvailable {Boolean} Optional. Given genUpdatePlan is used by both
 *        do_available and do_update, we want to make some differences
 *        between these (avail for example includes sdcadm into the list of
 *        services to check for new available images).
 * @param cb {Function} Callback of the form `function (err, plan)`.
 */
SdcAdm.prototype.genUpdatePlan = function genUpdatePlan(options, cb) {
    assert.object(options, 'options');
    assert.arrayOfObject(options.changes, 'options.changes');
    assert.optionalFunc(options.progress, 'options.progress');
    assert.optionalBool(options.justImages, 'options.justImages');
    assert.optionalBool(options.updateAll, 'options.updateAll');
    assert.optionalBool(options.forceDataPath, 'opts.forceDataPath');
    assert.optionalBool(options.forceRabbitmq, 'options.forceRabbitmq');
    assert.optionalBool(options.forceSameImage, 'options.forceSameImage');
    assert.optionalString(options.uuid, 'options.uuid');
    assert.optionalBool(options.keepAllImages, 'options.keepAllImages');
    assert.optionalBool(options.noVerbose, 'options.noVerbose');
    assert.optionalBool(options.justAvailable, 'options.justAvailable');
    // Create instance:
    assert.optionalBool(options.skipHACheck, 'options.skipHACheck');
    assert.func(cb, 'cb');
    var self = this;
    var log = self.log;
    var progress = options.progress || function () {};
    var justImages = Boolean(options.justImages);
    var updateAll = Boolean(options.updateAll);

    var changes = common.deepObjCopy(options.changes);
    var servers;
    var serverFromUuidOrHostname;
    var svcs;
    var svcFromName;
    var insts;
    var plan;
    vasync.pipeline({funcs: [
        /**
         * Basic validation of keys of the changes. Validation of values is
         * later.
         */
        function validateChanges(_, next) {
            var errs = [];
            for (var i = 0; i < changes.length; i++) {
                var change = changes[i];
                var repr = JSON.stringify(change);
                if (change.image) {
                    validateString(change.image, '"image" in ' + repr);
                }
                if (change.type === 'create') {
                    // 1. create-instance
                    validateString(change.service, '"service" in ' + repr);
                    validateString(change.server, '"server" in ' + repr);
                    validateKeys(['type', 'server', 'service', 'image'],
                        change, repr);
                } else if (change.type === 'delete' && change.service &&
                        change.server) {
                    // 2. agent delete-instance
                    validateString(change.service, '"service" in ' + repr);
                    validateString(change.server, '"server" in ' + repr);
                    validateKeys(['type', 'server', 'service', 'image'],
                        change, repr);
                } else if (change.type === 'delete') {
                    // 2. agent delete-instance
                    // 3. vm delete-instance
                    validateString(change.instance, '"instance" in ' + repr);
                    validateKeys(['type', 'instance', 'image'], change, repr);
                } else if (change.type === 'delete-service') {
                    // 4. delete-service
                    validateString(change.service, '"service" in ' + repr);
                    validateKeys(['type', 'service'], change, repr);
                } else if (change.service && change.server) {
                    // 6. agent update-instance
                    if (change.type && change.type !== 'update-instance') {
                        errs.push(new errors.ValidationError(
                            'invalid type "update-instance" change in ' +
                            repr));
                    } else {
                        change.type = 'update-instance';
                    }
                    validateString(change.service, '"service" in ' + repr);
                    validateString(change.server, '"server" in ' + repr);
                    validateKeys(['type', 'server', 'service', 'image'],
                        change, repr);
                } else if (change.instance) {
                    // 5. vm update-instance
                    // 6. agent update-instance
                    // SPECIAL: sdcadm available updates
                    if (change.type && change.type !== 'update-instance') {
                        errs.push(new errors.ValidationError(
                            'invalid type "update-instance" change in ' +
                            repr));
                    } else {
                        change.type = 'update-instance';
                    }
                    validateString(change.instance, '"instance" in ' + repr);
                    validateKeys([
                            'type', 'instance', 'image', 'version'
                    ], change, repr);
                    if (change.instance === 'sdcadm' && options.justAvailable) {
                        change.service = 'sdcadm';
                        change.type = 'update-service';
                    }
                } else if (change.service) {
                    // 7. update-service
                    if (change.type && change.type !== 'update-service') {
                        errs.push(new errors.ValidationError(
                            'invalid type "update-service" change in ' +
                            repr));
                    } else {
                        change.type = 'update-service';
                    }
                    validateString(change.service, '"service" in ' + repr);
                    validateKeys([
                            'type', 'service', 'image', 'version'
                    ], change, repr);
                } else {
                    errs.push(new errors.ValidationError(
                        'invalid change: ' + repr));
                }
            }
            if (errs.length === 1) {
                next(errs[0]);
            } else if (errs.length > 1) {
                next(new errors.MultiError(errs));
            } else {
                next();
            }

            function validateString(value, msg) {
                if (typeof (value) !== 'string') {
                    errs.push(new errors.ValidationError(
                        msg + ' (string) is required'));
                }
            }
            function validateKeys(allowed, change_, repr_) {
                var extraKeys = Object.keys(change_).filter(function (k) {
                    return !~allowed.indexOf(k);
                });
                if (extraKeys.length) {
                    errs.push(new errors.ValidationError(format(
                        'invalid extra fields "%s" in %s',
                        extraKeys.join('", "'), repr_)));
                }
            }
        },

        function getServers(_, next) {
            self.cnapi.listServers({
                agents: true
            }, function (err, servers_) {
                servers = servers_ || [];
                serverFromUuidOrHostname = {};
                for (var i = 0; i < servers.length; i++) {
                    serverFromUuidOrHostname[servers[i].uuid] = servers[i];
                    serverFromUuidOrHostname[servers[i].hostname] = servers[i];
                }
                next(err);
            });
        },

        function getSvcs(_, next) {
            self.getServices({}, function (err, svcs_) {
                svcs = svcs_ || [];
                svcFromName = {};
                for (var i = 0; i < svcs.length; i++) {
                    svcFromName[svcs[i].name] = svcs[i];
                }
                if (options.justAvailable) {
                    svcFromName['sdcadm'] = {
                        name: 'sdcadm',
                        type: 'other'
                    };
                }
                next(err);
            });
        },

        function getInsts(_, next) {
            self.listInsts(function (err, insts_) {
                insts = insts_;
                next(err);
            });
        },

        /**
         * Normalize fields in each change in the `changes` array from the
         * convenience inputs (e.g. service="imgapi") to full details
         * (e.g. service=<the full imgapi SAPI service object>).
         */
        function normalizeChanges(_, next) {
            if (updateAll) {
                var serviceNames = changes.map(function (ch) {
                    return ch.service;
                }).join(', ');

                if (!options.noVerbose) {
                    var out = util.format('Finding candidate update images' +
                        ' for %s services (%s).',
                        changes.length, serviceNames);
                    progress(common.splitStr(out).join('\n'));
                }
            }

            vasync.forEachParallel({inputs: changes, func:
                function resolveChange(ch, nextChange) {
                    var changeRepr = JSON.stringify(ch);
                    var i, found;
                    if (ch.service) {
                        if (!svcFromName[ch.service]) {
                            return nextChange(new errors.UpdateError(format(
                                'unknown service "%s" from %s', ch.service,
                                changeRepr)));
                        } else {
                            ch.service = svcFromName[ch.service];
                        }
                    }
                    if (ch.uuid) {
                        found = false;
                        for (i = 0; i < insts.length; i++) {
                            if (insts[i].uuid === ch.uuid) {
                                ch.instance = insts[i];
                                found = true;
                                break;
                            }
                        }
                        if (!found) {
                            return nextChange(new errors.UpdateError(format(
                                'unknown SDC instance uuid "%s" from %s',
                                ch.uuid, changeRepr)));
                        }
                    } else if (ch.alias) {
                        found = false;
                        for (i = 0; i < insts.length; i++) {
                            if (insts[i].alias === ch.alias) {
                                ch.instance = insts[i];
                                found = true;
                                break;
                            }
                        }
                        if (!found) {
                            return nextChange(new errors.UpdateError(format(
                                'unknown SDC instance alias "%s" from %s',
                                ch.alias, changeRepr)));
                        }
                    }
                    if (!ch.service) {
                        console.error('TODO instance (what is service?):',
                            ch.instance, ch);
                        throw new Error('TODO');
                        // ch.server = TODO;
                    }
                    if (ch.server) {
                        found = false;
                        for (i = 0; i < servers.length; i++) {
                            if (servers[i].uuid === ch.server ||
                                servers[i].hostname === ch.server)
                            {
                                found = true;
                                break;
                            }
                        }
                        if (!found) {
                            return nextChange(new errors.UpdateError(format(
                                'unknown SDC server "%s" from %s',
                                ch.server, changeRepr)));
                        }
                    }

                    // All candidate images to `ch.images`. Just the single
                    // image if one was specified.
                    if (ch.image) {
                        self.getImage({uuid: ch.image}, function (iErr, img) {
                            if (iErr) {
                                return nextChange(new errors.UpdateError(
                                    iErr,
                                    format('unknown image "%s" from %s',
                                        ch.image, changeRepr)));
                            }
                            ch.images = [img];
                            delete ch.image;
                            nextChange();
                        });
                    } else if (ch.version) {
                        self.updates.listImages({
                            version: ch.version,
                            name: ch.service.name
                        }, function (iErr, img) {
                            if (iErr) {
                                return nextChange(new errors.UpdateError(
                                    iErr,
                                    format('unknown image "%s" from %s',
                                        ch.version, changeRepr)));
                            }
                            if (!img.length) {
                                return nextChange(new errors.UpdateError(
                                    format('unknown image "%s" from %s',
                                        ch.version, changeRepr)));
                            }
                            ch.images = [img][0];
                            delete ch.version;
                            nextChange();
                        });
                    } else {
                        if (!updateAll && !options.noVerbose) {
                            progress('Finding candidate update images '
                                + 'for the "%s" service.', ch.service.name);
                        }
                        // Special case for 'sdcadm', given it's not really a
                        // service and we get the images on a different way:
                        if (ch.service.name === 'sdcadm') {
                            self._selfAvailable(function (iErr, imgs) {
                                if (iErr) {
                                    return nextChange(iErr);
                                }
                                ch.images = imgs;
                                log.debug({serviceName: ch.service.name},
                                    '%d candidate images (including current)',
                                    imgs.length);
                                nextChange();
                            });
                        } else {
                            self.getCandidateImages({
                                service: ch.service,
                                insts: insts
                            }, function (iErr, imgs) {
                                if (iErr) {
                                    return nextChange(iErr);
                                }
                                ch.images = imgs;
                                log.debug({serviceName: ch.service.name},
                                    '%d candidate images (including current)',
                                    imgs.length);
                                nextChange();
                            });
                        }
                    }
                }
            }, next);
        },

        /**
         * Kinds of conflicts:
         * - action on a service *and* an instance of the same service
         * - two actions on the same service
         * - two actions on the same instance
         */
        function checkForConflictingChanges(_, next) {
            function reprFromChange(ch_) {
                return JSON.stringify({
                    type: ch_.type,
                    service: ch_.service.name,
                    instance: ch_.instance && ch_.instance.instance
                });
            }

            var changeFromSvc = {};
            var changeFromInst = {};
            var i, ch, typeTarg, svc;
            for (i = 0; i < changes.length; i++) {
                ch = changes[i];
                // e.g. 'update-service' -> 'service'
                // (Some instance changes like 'delete' or 'create' do not
                // include the two pieces).
                typeTarg = ch.type.split('-')[1] || 'instance';
                if (typeTarg === 'service') {
                    svc = ch.service.name;
                    if (changeFromSvc[svc]) {
                        return next(new errors.UpdateError(format(
                            'conflict: cannot make multiple changes to the ' +
                            'same service: %s and %s', reprFromChange(ch),
                            reprFromChange(changeFromSvc[svc]))));
                    }
                    changeFromSvc[svc] = ch;
                } else {
                    assert.equal(typeTarg, 'instance');
                    var inst = (ch.instance) ? ch.instance.instance : null;
                    if (changeFromInst[inst]) {
                        return next(new errors.UpdateError(format(
                            'conflict: cannot make multiple changes to the ' +
                            'same instance: %s and %s', reprFromChange(ch),
                            reprFromChange(changeFromInst[inst]))));
                    }
                    changeFromInst[inst] = ch;
                }
            }
            for (i = 0; i < changes.length; i++) {
                ch = changes[i];
                typeTarg = ch.type.split('-')[1] || 'instance';
                if (typeTarg === 'instance') {
                    svc = ch.service.name;
                    if (changeFromSvc[svc]) {
                        return next(new errors.UpdateError(format(
                            'conflict: cannot make changes to a service and ' +
                            'an instance of that service: %s and %s',
                            reprFromChange(ch),
                            reprFromChange(changeFromSvc[svc]))));
                    }
                }
            }
            next();
        },

        /**
         * Drop service or inst updates that have no available update
         * candidates.
         */
        function dropNoops(_, next) {
            changes = changes.filter(function (ch) {
                if (ch.type === 'update-service' ||
                    ch.type === 'update-instance')
                {
                    if (ch.images.length === 0) {
                        // No available update candidates were found.
                        log.debug({change: ch},
                            'dropNoop: no update candidates');
                        return false;
                    }

                    // Exclude update to the same image as all current insts,
                    // unless --force-same-image.
                    if (!options.forceSameImage) {
                        var currImgUuids = {};
                        insts.forEach(function (inst) {
                            if (inst.service === ch.service.name) {
                                currImgUuids[inst.image] = true;
                            }
                        });
                        currImgUuids = Object.keys(currImgUuids);
                        if (currImgUuids.length === 0 &&
                                ch.service.name !== 'sdcadm') {
                            // No insts -> use the image_uuid set on the
                            // service.
                            assert.ok(ch.service.params.image_uuid,
                                'service object has no "params.image_uuid": '
                                + JSON.stringify(ch.service));
                            currImgUuids.push(ch.service.params.image_uuid);
                        }
                        if (currImgUuids.length === 1) {
                            var sansCurr = ch.images.filter(function (img) {
                                return (img.uuid !== currImgUuids[0]);
                            });

                            if (sansCurr.length === 0) {
                                log.debug(
                                    {change: ch, currImgUuids: currImgUuids},
                                    'dropNoop: same image as all insts');
                                return false;
                            }
                        }
                    }
                }
                return true;
            });
            next();
        },

        /**
         * This is where we use inter-image dependencies to (a) resolve
         * candidate `images` for each change down to a single `image`, and
         * (b) add additional updates if required.
         *
         * We don't yet support deps (see: sdc-update project M9), so the
         * only step here is to select the latest candidate image.
         */
        function resolveDeps(_, next) {
            log.debug({changes: changes}, 'resolveDeps');
            for (var i = 0; i < changes.length; i++) {
                var ch = changes[i];
                if (!ch.image && ch.images.length) {
                    assert.arrayOfObject(ch.images,
                        'changes['+i+'].images');
                    // Assuming that `ch.images` is already sorted by
                    // `published_at`.
                    ch.images.sort(function (a, b) {
                        return common.cmp(a.published_at, b.published_at);
                    });
                    ch.image = ch.images[ch.images.length - 1];
                }
                if (!options.keepAllImages) {
                    delete ch.images;
                }
            }
            next();
        },

        function disallowRabbitmqUpdates(_, next) {
            for (var i = 0; i < changes.length; i++) {
                var ch = changes[i];
                if (ch.service && ch.service.name === 'rabbitmq' &&
                    !options.forceRabbitmq)
                {
                        var changeRepr = JSON.stringify({
                             type: ch.type,
                             service: ch.service.name,
                             instance: ch.instance && ch.instance.instance
                        });
                        return next(new errors.UpdateError(format(
                            'rabbitmq updates are locked: %s ' +
                            '(use --force-rabbitmq flag)', changeRepr)));
                }
            }
            next();
        },

        function disallowDataPathUpdates(_, next) {
            var dataPath = ['portolan'];

            for (var i = 0; i < changes.length; i++) {
                var ch = changes[i];
                if (ch.service && dataPath.indexOf(ch.service.name) !== -1 &&
                    !options.forceDataPath)
                {
                    var changeRepr = JSON.stringify({
                        type: ch.type,
                        service: ch.service.name,
                        instance: ch.inst && ch.instance.instance
                    });
                    return next(new errors.UpdateError(format(
                        '%s updates are locked: %s ' +
                        '(use --force-data-path flag)', ch.service.name,
                        changeRepr)));
                }
            }
            next();
        },

        function ensureVmMinPlatform(_, next) {
            var ch, server;
            var errs = [];
            for (var i = 0; i < changes.length; i++) {
                ch = changes[i];
                if (ch.service.type !== 'vm') {
                    continue;
                }
                if (ch.type === 'update-service') {
                    for (var j = 0; j < insts.length; j++) {
                        var inst = insts[j];
                        if (inst.service === ch.service.name) {
                            server = serverFromUuidOrHostname[inst.server];
                            if (server.current_platform <
                                self.config.vmMinPlatform)
                            {
                                errs.push(new errors.UpdateError(format(
                                    'insufficient platform for service "%s" ' +
                                    'instance "%s" on server "%s" (current ' +
                                    'platform is "%s", require minimum "%s")',
                                    inst.service, inst.instance, inst.server,
                                    server.current_platform,
                                    self.config.vmMinPlatform)));
                            }
                        }
                    }
                } else if (ch.type === 'update-instance') {
                    throw new Error('TODO');
                } else if (ch.type === 'create-instance') {
                    server = serverFromUuidOrHostname[ch.server];
                    throw new Error('TODO');
                }
            }
            if (errs.length) {
                var er = (errs.length === 1) ? errs[0] :
                    new errors.MultiError(errs);
                next(er);
            } else {
                next();
            }
        },

        function minImageBuildDateFromSvcName(_, next) {
            if (options.forceBypassMinImage) {
                return next();
            }
            var ch, server;
            var errs = [];
            for (var i = 0; i < changes.length; i++) {
                ch = changes[i];
                if (ch.service.type !== 'vm') {
                    continue;
                }
                if (ch.type === 'update-service') {
                    for (var j = 0; j < insts.length; j++) {
                        var inst = insts[j];
                        if (inst.service !== ch.service.name) {
                            continue;
                        }
                        if (!self.config.svcMinImages[inst.service]) {
                            continue;
                        }
                        var minImg = self.config.svcMinImages[inst.service];
                        if (!inst.version) {
                            var msg = format('Unknown image ' +
                                'version for service "%s". Cannot evaluate ' +
                                'if minimal requirements for update are met ' +
                                'by the current image. This can be fixed ' +
                                'by re-importing the image into the DC via:' +
                                '\n\n\tsdc-imgadm '+
                                'import %s -s https://updates.joyent.com?' +
                                'channel=*', inst.service, inst.image);

                            errs.push(new errors.UpdateError(msg));
                            continue;
                        }
                        var parts = inst.version.split('-');
                        var curImg = parts[parts.length - 2];
                        if (minImg > curImg) {
                            errs.push(new errors.UpdateError(format(
                                'image for service "%s" is too old for ' +
                                'sdcadm update (min image build date ' +
                                'is "%s" current image build date is "%s")',
                                inst.service,
                                minImg,
                                curImg
                            )));
                        }
                    }
                } else if (ch.type === 'update-instance') {
                    throw new Error('TODO');
                } else if (ch.type === 'create-instance') {
                    server = serverFromUuidOrHostname[ch.server];
                    console.log(server); // shut make check up about unused var
                    throw new Error('TODO');
                }

            }
            if (errs.length) {
                var er = (errs.length === 1) ? errs[0] :
                    new errors.MultiError(errs);
                next(er);
            } else {
                next();
            }
        },

        function getChannel(_, next) {
            if (options.noVerbose) {
                return next();
            }
            self.getDefaultChannel(function (err, channel) {
                // Will not fail the whole operation due to channel not found
                if (err) {
                    return next();
                }
                progress('Using channel %s', channel);
                return next();
            });
        },

        function createPlan(_, next) {
            log.debug({changes: changes}, 'createPlan');
            var targ = common.deepObjCopy(insts);
            for (var i = 0; i < changes.length; i++) {
                var ch = changes[i];
                switch (ch.type) {
                case 'update-service':
                    for (var j = 0; j < targ.length; j++) {
                        var inst = targ[j];
                        if (inst.service === ch.service.name) {
                            inst.image = ch.image.uuid;
                            inst.version = ch.image.version;
                        }
                    }
                    break;
                case 'create':
                    // Create instance for an existing service:
                    if (options.skipHACheck) {
                        ch.force = true;
                    }
                    break;
                // TODO: other change types
                default:
                    return next(new errors.InternalError({
                        message: 'unknown ch.type: ' + ch.type
                    }));
                }
            }
            plan = new UpdatePlan({
                curr: insts,
                targ: targ,
                changes: changes,
                justImages: justImages
            });
            next();
        },

        function determineProcedures(_, next) {
            procedures.coordinatePlan({
                plan: plan,
                sdcadm: self,
                serverFromUuidOrHostname: serverFromUuidOrHostname,
                log: log,
                progress: progress,
                noVerbose: options.noVerbose,
                servers: options.servers || []
            }, function (err, procs_) {
                plan.procs = procs_;
                next(err);
            });
        }

    ]}, function finishUp(err) {
        cb(err, plan);
    });
};


SdcAdm.prototype.summarizePlan = function summarizePlan(options) {
    assert.object(options, 'options');
    assert.object(options.plan, 'options.plan');
    assert.optionalFunc(options.progress, 'options.progress');

    options.plan.procs.forEach(function (proc) {
        options.progress(common.indent(proc.summarize()));
    });
};



/**
 * Execute an update plan.
 * The caller should be holding a `<SdcAdm>.acquireLock()`.
 *
 * @param options {Object}  Required.
 *      - plan {Object} Required. The update plan as returned by
 *        `genUpdatePlan`.
 *      - progress {Function} Optional. A function that is called
 *        with progress messages. Called like printf, i.e. passing in
 *        `console.log` or a Bunyan `log.info.bind(log)` is fine.
 *      - dryRun {Boolean} Optional. Default false.
 * @param cb {Function} Callback of the form `function (err)`.
 */
SdcAdm.prototype.execUpdatePlan = function execUpdatePlan(options, cb) {
    assert.object(options, 'options');
    assert.object(options.plan, 'options.plan');
    assert.optionalFunc(options.progress, 'options.progress');
    assert.optionalBool(options.dryRun, 'options.dryRun');
    assert.optionalString(options.uuid, 'options.uuid');
    assert.optionalNumber(options.concurrency, 'options.concurrency');
    // We need a pointer to the update directory when we're trying to rollback:
    assert.optionalString(options.upDir, 'options.upDir');
    assert.func(cb, 'cb');
    var self = this;
    var log = self.log;
    var progress = options.progress || function () {};
    var plan = options.plan;
    var rollback = plan.rollback || false;

    var start = new Date();
    var wrkDir;
    var hist;

    vasync.pipeline({funcs: [
        function checkReprovisionLock(_, next) {
            self.reprovFailLock_IsLocked(function (err, lockMsg) {
                if (lockMsg) {
                    return next(new errors.InternalError(format(
                        'Update is locked because of an earlier core zone ' +
                            'reprovision failure during\n' +
                        'an "sdcadm update". Some details of the failure ' +
                            'are in:\n' +
                        '       %s\n' +
                        'You must manually recover or delete that core zone ' +
                                'instance, then\n' +
                        'remove "%s" to continue. See ' +
                        '<https://smartos.org/bugview/TOOLS-1241> for details.',
                        self._reprovFailLockPath, self._reprovFailLockPath)));
                }
                return next();
            });
        },
        function createWrkDir(_, next) {
            var stamp = sprintf('%d%02d%02dT%02d%02d%02dZ',
                start.getUTCFullYear(),
                start.getUTCMonth()+1,
                start.getUTCDate(),
                start.getUTCHours(),
                start.getUTCMinutes(),
                start.getUTCSeconds());
            wrkDir = (rollback ?
                    '/var/sdcadm/rollbacks/' : '/var/sdcadm/updates/'
                    ) + stamp;
            progress('Create work dir: ' + wrkDir);
            if (options.dryRun) {
                return next();
            }
            mkdirp(wrkDir, function (err) {
                if (err) {
                    next(new errors.InternalError({
                        message: 'error creating work dir: ' + wrkDir,
                        cause: err
                    }));
                    return;
                }
                next();
            });
        },

        function savePlan(_, next) {
            if (options.dryRun) {
                return next();
            }
            var planFile = path.resolve(wrkDir, 'plan.json');
            fs.writeFile(planFile,
                plan.serialize(),
                'utf8',
                function (err) {
                    if (err) {
                        return next(new errors.InternalError({
                            cause: err,
                            message: 'error saving update plan: ' + planFile
                        }));
                    }
                    next();
                });
        },

        function saveBeginningToHistory(_, next) {
            if (options.dryRun || options.justImages) {
                return next();
            }
            var obj = {
                changes: plan.changes
            };

            if (options.uuid) {
                obj.uuid = options.uuid;
            }

            if (options.dryRun) {
                return next();
            }

            self.history.saveHistory(obj, function (err, hst) {
                if (err) {
                    return next(err);
                }
                hist = hst;
                return next();
            });
        },

        function execProcedures(_, next) {
            if (options.dryRun) {
                return next();
            }
            vasync.forEachPipeline({
                inputs: plan.procs,
                func: function execProc(proc, nextProc) {
                    log.debug({summary: proc.summarize()}, 'execProc');
                    proc.execute({
                        sdcadm: self,
                        plan: plan,
                        progress: progress,
                        log: log,
                        wrkDir: wrkDir,
                        upDir: options.upDir,
                        concurrency: options.concurrency || 0
                    }, nextProc);
                }
            }, next);
        }

    ]}, function (err) {
        if (options.dryRun || options.justImages) {
            return cb(err);
        }

        // Add error to history in case the update execution failed:
        if (err) {
            // TOOLS-879: sdcadm update should tell user about the error:
            progress('Update error: %j', err);
            if (!hist) {
                self.log.warn('History not saved for update');
                return cb(err);
            }

            hist.error = err;
        }

        if (!hist) {
            self.log.warn('History not saved for update');
            return cb();
        }
        // No need to add `history.finished` here, History instance will handle
        self.history.updateHistory(hist, function (err2, hist2) {
            if (err) {
                cb(err);
            } else if (err2) {
                cb(err2);
            } else {
                cb();
            }
        });
    });
};

/**
 * Get sdcadm buildstamp
 *
 * @param cb {Function} Callback of the form `function (err, stamp)`
 */
SdcAdm.prototype.getBuildTime = function getBuildTime(cb) {
    assert.func(cb, 'cb');
    var self = this;
    // Avoid to re-run:
    if (self.currBuildTime) {
        return cb(null, self.currBuildTime);
    }
    // SDC buildstamps are '$branch-$buildtime-g$sha'. The '$branch'
    // can have hyphens in it.
    var buildstampPath = path.resolve(__dirname, '..', 'etc',
        'buildstamp');
    fs.readFile(buildstampPath, 'utf8', function (err, data) {
        if (err) {
            return cb(new errors.InternalError({
                message: 'error getting current buildstamp',
                path: buildstampPath,
                cause: err
            }));
        }
        var parts = data.trim().split(/-/g);
        // Drop possible '-dirty' on the buildstamp.
        if (parts[parts.length - 1] === 'dirty') {
            parts.pop();
        }
        self.currBuildTime = parts[parts.length - 2];
        return cb(null);
    });
};

/**
 * Get sdcadm available images.
 *
 * To be used by both sdcadm self-update and sdcadm avail.
 *
 * @param cb {Function} Callback of the form `function (err, images {Array})`.
 */
SdcAdm.prototype._selfAvailable = function _selfAvailable(cb) {
    assert.func(cb, 'cb');
    var self = this;
    var log = self.log;
    var currVer = pkg.version;
    var images = [];

    vasync.pipeline({funcs: [
        function getCurrBuildtime(_, next) {
            self.getBuildTime(function (err) {
                return next(err);
            });
        },
        function findSdcAdmCandidates(_, next) {
            var filters = {
                name: 'sdcadm'
            };
            self.updates.listImages(filters, function (err, candidates) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'updates'));
                }

                // Filter out versions before the current.
                candidates = candidates.filter(function dropLowerVer(c) {
                    if (semver.lt(c.version, currVer)) {
                        //log.trace({candidate: c, currVer: currVer},
                        //    'drop sdcadm candidate (lower ver)');
                        return false;
                    }
                    return true;
                });

                // Filter out buildstamps <= the current (to exclude
                // earlier builds at the same `version`).
                candidates = candidates.filter(function dropLowerStamp(c) {
                    var buildtime = c.tags.buildstamp.split(/-/g)
                            .slice(-2, -1)[0];
                    if (buildtime <= self.currBuildTime) {
                        log.trace({candidate: c, buildtime: buildtime,
                            currBuildTime: self.currBuildTime},
                            'drop sdcadm candidate (<= buildtime)');
                        return false;
                    }
                    return true;
                });

                // Sort by (version, publish date) and select the latest
                if (candidates.length) {
                    candidates.sort(function (a, b) {
                        var ver = semver.compare(a.version, b.version);
                        if (ver) {
                            return ver;
                        }
                        var aParts = a.tags.buildstamp.split('-');
                        var bParts = b.tags.buildstamp.split('-');
                        var aStamp = aParts[aParts.length - 2];
                        var bStamp = bParts[bParts.length - 2];
                        if (aStamp > bStamp) {
                            return 1;
                        } else if (aStamp < bStamp) {
                            return -1;
                        } else {
                            return 0;
                        }
                    });
                    images = candidates;
                }
                next();
            });
        }
    ]}, function finishUp(err) {
        if (err) {
            return cb(err);
        }
        return cb(null, images);
    });
};

/**
 * Update to the latest available sdcadm package.
 *
 * @param options {Object}  Required.
 *      - image {String}. Required. The image we want to udpate to, either
 *        'latest' or a valid sdcadm image UUID.
 *      - allowMajorUpdate {Boolean} Optional. Default false. By default
 *        self-update will only consider versions of the same major version.
 *      - dryRun {Boolean} Optional. Default false. Go through the motions
 *        without actually updating.
 *      - progress {Function} Optional. A function that is called
 *        with progress messages. Called as `progress(<string>)`. E.g. passing
 *        console.log is legal.
 * @param cb {Function} Callback of the form `function (err)`.
 */
SdcAdm.prototype.selfUpdate = function selfUpdate(options, cb) {
    assert.object(options, 'options');
    assert.string(options.image, 'options.image');
    assert.optionalBool(options.allowMajorUpdate, 'options.allowMajorUpdate');
    assert.optionalBool(options.dryRun, 'options.dryRun');
    assert.optionalFunc(options.progress, 'options.progress');
    assert.func(cb, 'cb');
    var self = this;
    var log = self.log;
    var progress = options.progress || function () {};

    var unlock;
    var dryRunPrefix = (options.dryRun ? '[dry-run] ' : '');
    var currVer = pkg.version;
    var updateManifest;
    var installerPath;
    var start;
    var wrkDir;
    var hist;
    var changes = [
    {
        type: 'service',
        service: {
            type: 'service',
            name: 'sdcadm',
            version: currVer
        }
    }];
    vasync.pipeline({funcs: [
        function getLock(_, next) {
            if (options.dryRun) {
                return next();
            }
            self.acquireLock({progress: progress}, function (lockErr, unlock_) {
                unlock = unlock_;
                next(lockErr);
            });
        },

        function setStart(_, next) {
            // Set start time after getting lock to avoid collisions in wrkDir.
            start = new Date();
            next();
        },

        function getCurrBuildtime(_, next) {
            self.getBuildTime(function (err) {
                return next(err);
            });
        },

        function findLatestSdcAdm(_, next) {
            if (options.image !== 'latest') {
                return next();
            }

            self._selfAvailable(function (err, candidates) {
                if (err) {
                    return next(err);
                }
                // Unless `allowMajorUpdate`, filter out major updates (and
                // warn).
                if (!options.allowMajorUpdate) {
                    var currMajor = currVer.split(/\./)[0] + '.x';
                    var droppedVers = [];
                    candidates = candidates.filter(function dropMajor(c) {
                        var drop = !semver.satisfies(c.version, currMajor);
                        if (drop) {
                            droppedVers.push(c.version);
                            log.trace({candidate: c, currMajor: currMajor},
                                'drop sdcadm candidate (major update)');
                        }
                        return !drop;
                    });
                    if (droppedVers.length) {
                        droppedVers.sort(semver.compare);
                        progress('Skipping available major sdcadm '
                            + 'update, version %s (use --allow-major-update '
                            + 'to allow)',
                            droppedVers[droppedVers.length - 1]);
                    }
                }

                if (candidates.length) {
                    updateManifest = candidates[candidates.length - 1];
                    changes[0].image = updateManifest;
                    progress('%sUpdate to sdcadm %s (%s)', dryRunPrefix,
                        updateManifest.version,
                        updateManifest.tags.buildstamp);
                } else {
                    var ch = self.updates.channel;
                    progress('Already up-to-date (using %s update channel).',
                        ch ? '"'+ch+'"' : 'default');
                }
                next();
            });
        },

        // REVIEW: Do we need to complain regarding updates to the same image
        // when a given image UUID is provided?
        function findSdcadmByUUID(_, next) {
            if (options.image === 'latest') {
                return next();
            }
            self.updates.getImage(options.image, function (err, img) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'updates'));
                }

                // Unless `allowMajorUpdate`, filter out major updates (and
                // warn).
                if (!options.allowMajorUpdate) {
                    var currMajor = currVer.split(/\./)[0] + '.x';
                    if (!semver.satisfies(img.version, currMajor)) {
                        log.trace({candidate: img, currMajor: currMajor},
                            'drop sdcadm candidate (major update)');
                        progress('Skipping sdcadm self-update to version %s' +
                            '(use --allow-major-update to allow)',
                            img.version);
                        return next(new errors.UsageError('Major sdcadm ' +
                            'version update requires --allow-major-update ' +
                            'option'));
                    }
                }
                updateManifest = img;
                changes[0].image = img;
                progress('%sUpdate to sdcadm %s (%s)', dryRunPrefix,
                    updateManifest.version,
                    updateManifest.tags.buildstamp);
                return next();
            });
        },

        function saveChangesToHistory(_, next) {
            if (!updateManifest || options.dryRun) {
                return next();
            }

            self.history.saveHistory({
                changes: changes
            }, function (err, hst) {
                if (err) {
                    return next(err);
                }
                hist = hst;
                return next();
            });
        },

        function downloadInstaller(_, next) {
            if (!updateManifest) {
                return next();
            }

            progress('%sDownload update from %s', dryRunPrefix,
                self.config.updatesServerUrl);
            if (options.dryRun) {
                return next();
            }
            // TODO progress bar on this
            installerPath = '/var/tmp/sdcadm-' + updateManifest.uuid;
            self.updates.getImageFile(updateManifest.uuid, installerPath,
                    function (downloadErr) {
                if (downloadErr) {
                    next(new errors.InternalError({
                        message: 'error downloading sdcadm package',
                        updatesServerUrl: self.config.updatesServerUrl,
                        uuid: updateManifest.uuid,
                        cause: downloadErr
                    }));
                    return;
                }
                fs.chmod(installerPath, 0755, function (chmodErr) {
                    if (chmodErr) {
                        next(new errors.InternalError({
                            message: 'error chmoding sdcadm installer',
                            path: installerPath,
                            cause: chmodErr
                        }));
                        return;
                    }
                    next();
                });
            });
        },

        function createWrkDir(_, next) {
            if (!updateManifest) {
                return next();
            }
            var stamp = sprintf('%d%02d%02dT%02d%02d%02dZ',
                start.getUTCFullYear(),
                start.getUTCMonth()+1,
                start.getUTCDate(),
                start.getUTCHours(),
                start.getUTCMinutes(),
                start.getUTCSeconds());
            wrkDir = '/var/sdcadm/self-updates/' + stamp;
            mkdirp(wrkDir, function (err) {
                if (err) {
                    next(new errors.InternalError({
                        message: 'error creating work dir: ' + wrkDir,
                        cause: err
                    }));
                    return;
                }
                next();
            });
        },

        function runInstaller(_, next) {
            if (!updateManifest) {
                return next();
            }
            progress('%sRun sdcadm installer (log at %s/install.log)',
                dryRunPrefix, wrkDir);
            if (options.dryRun) {
                return next();
            }
            var cmd = format('%s >%s/install.log 2>&1', installerPath,
                wrkDir);
            var env = common.objCopy(process.env);
            env.TRACE = '1';
            env.SDCADM_LOGDIR = wrkDir; // bwcompat for sdcadm <1.2.0 installers
            env.SDCADM_WRKDIR = wrkDir;
            var execOpts = {env: env};
            log.trace({cmd: cmd}, 'run sdcadm installer');
            exec(cmd, execOpts, function (err, stdout, stderr) {
                log.trace({cmd: cmd, err: err, stdout: stdout, stderr: stderr},
                    'ran sdcadm installer');
                if (err) {
                    // TODO: The installer *does* typically restore the old one
                    // on failure. There is a swap (two `mv`s) during which a
                    // crash will leave in inconsistent state. We could check
                    // for that here and cleanup, or just warn about the
                    // situation.
                    return next(new errors.InternalError({
                        message: 'error running sdcadm installer',
                        cmd: cmd,
                        stdout: stdout,
                        stderr: stderr,
                        cause: err
                    }));
                }
                next();
            });
        }

    ]}, function finishUp(err) {
        vasync.pipeline({funcs: [
            function dropLock(_, next) {
                if (options.dryRun) {
                    return next();
                }
                self.releaseLock({unlock: unlock}, next);
            },
            function updateHist(_, next) {
                if (!updateManifest || options.dryRun) {
                    return next();
                }
                // Add error to history in case the update execution failed:
                if (err) {
                    if (!hist) {
                        self.log.warn('History not set for self-update');
                        return next(err);
                    }
                    hist.error = err;
                }
                if (!hist) {
                    self.log.warn('History not set for self-update');
                    return next();
                }
                // No need to add `history.finished` here:
                self.history.updateHistory(hist, function (err2, hist2) {
                    if (err2) {
                        next(err2);
                    } else {
                        next();
                    }
                });
            },
            function noteCompletion(_, next) {
                if (!updateManifest || err) {
                    return next();
                }
                progress('%sUpdated to sdcadm %s (%s, elapsed %ss)',
                    dryRunPrefix, updateManifest.version,
                    updateManifest.tags.buildstamp,
                    Math.floor((Date.now() - start) / 1000));
                next();
            }
        ]}, function done(finishUpErr) {
            // We shouldn't ever get a `finishUpErr`. Let's be loud if we do.
            if (finishUpErr) {
                log.fatal({err: finishUpErr},
                    'unexpected error finishing up self-update');
            }
            cb(err || finishUpErr);
        });
    });
};


SdcAdm.prototype._dcMaintInfoPath = '/var/sdcadm/dc-maint.json';

/**
 * Maintenance mode current status.
 *
 * @param cb {Function} Callback of the form `function (err, status)`.
 *      where `status` is an object like the following:
 *          {maint: false}         // not in maint mode
 *          {maint: true}          // in maint mode, don't have start time
 *          {maint: true, startTime: <date>}
 */
SdcAdm.prototype.dcMaintStatus = function dcMaintStatus(cb) {
    assert.func(cb, 'cb');
    var self = this;
    var log = self.log;

    var sdcApp = self.sdc;
    var services = {};
    var maint = false;
    var cloudapiMaint;
    var dockerMaint;
    var startTime;

    vasync.pipeline({funcs: [
        function getCloudapiSvc(_, next) {
            var filters = {
                application_uuid: sdcApp.uuid,
                name: 'cloudapi'
            };
            self.sapi.listServices(filters, function (svcsErr, svcs) {
                if (svcsErr) {
                    return next(new errors.SDCClientError(svcsErr, 'sapi'));
                } else if (!svcs || svcs.length !== 1) {
                    return next();
                }
                services.cloudapi = svcs[0];
                next();
            });
        },

        function getDockerSvc(_, next) {
            var filters = {
                application_uuid: sdcApp.uuid,
                name: 'docker'
            };
            self.sapi.listServices(filters, function (svcsErr, svcs) {
                if (svcsErr) {
                    return next(new errors.SDCClientError(svcsErr, 'sapi'));
                } else if (!svcs || svcs.length !== 1) {
                    return next();
                }
                services.docker = svcs[0];
                next();
            });
        },

        function checkIfInMaint(_, next) {
            cloudapiMaint = services.cloudapi && services.cloudapi.metadata &&
                services.cloudapi.metadata.CLOUDAPI_READONLY;
            dockerMaint = services.docker && services.docker.metadata &&
                services.docker.metadata.DOCKER_READONLY;
            log.debug({cloudapi_maint: cloudapiMaint},
                'maint mode from CLOUDAPI_READONLY');
            log.debug({docker_maint: dockerMaint},
                      'maint mode from DOCKER_READONLY');
            next();
        },

        /**
         * Showing the start time is strictly a convenience.
         */
        function loadStartTime(_, next) {
            if (!cloudapiMaint || !dockerMaint) {
                return next();
            } else {
                maint = true;
            }

            fs.readFile(self._dcMaintInfoPath, 'utf8', function (err, content) {
                if (err) {
                    // This is a convenience step. Just note this.
                    log.warn({dcMaintInfoPath: self._dcMaintInfoPath, err: err},
                        'could not loading dc-maint info file');
                } else {
                    try {
                        startTime = JSON.parse(content).startTime;
                    } catch (parseErr) {
                        log.warn(parseErr,
                            'could not parse dc-maint info file');
                    }
                }
                next();
            });
        }

    ]}, function (err) {
        if (err) {
            cb(err);
        } else {
            var status = {maint: maint};
            if (startTime) {
                status.startTime = startTime;
            }
            cb(null, status);
        }
    });
};


/**
 * Enter maintenance mode.
 *
 * @param opts {Object}  Required.
 *      - progress {Function} Optional. A function that is called
 *        with progress messages. Called like printf, i.e. passing in
 *        `console.log` or a Bunyan `log.info.bind(log)` is fine.
 * @param cb {Function} Callback of the form `function (err)`.
 */
SdcAdm.prototype.dcMaintStart = function dcMaintStart(opts, cb) {
    assert.object(opts, 'opts');
    assert.optionalFunc(opts.progress, 'opts.progress');
    assert.func(cb, 'cb');
    var self = this;
    var progress = opts.progress || function () {};

    var sdcApp = self.sdc;
    var services = {};
    var headnode;
    var putCloudapiIntoMaint = false;
    var putDockerIntoMaint = false;
    var startTime;

    vasync.pipeline({funcs: [
        function getHeadnode(_, next) {
            self.cnapi.listServers({
                headnode: true
            }, function (err, servers) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'cnapi'));
                }
                headnode = servers[0];
                return next();
            });
        },

        function getCloudapiSvc(_, next) {
            var filters = {
                application_uuid: sdcApp.uuid,
                name: 'cloudapi'
            };
            self.sapi.listServices(filters, function (svcsErr, svcs) {
                if (svcsErr) {
                    return next(new errors.SDCClientError(svcsErr, 'sapi'));
                }
                services.cloudapi  = svcs && svcs.length && svcs[0];
                next();
            });
        },

        function getDockerSvc(_, next) {
            var filters = {
                application_uuid: sdcApp.uuid,
                name: 'docker'
            };
            self.sapi.listServices(filters, function (svcsErr, svcs) {
                if (svcsErr) {
                    return next(new errors.SDCClientError(svcsErr, 'sapi'));
                }
                services.docker = svcs && svcs.length && svcs[0];
                next();
            });
        },

        function getSapiInstances(_, next) {
            progress('Getting SDC\'s sapi instances from SAPI');

            var keys = Object.keys(services);

            vasync.forEachParallel({ inputs: keys, func:
                function (key, feNext) {
                    var serviceUuid = services[key].uuid;

                    self.sapi.listInstances({
                        service_uuid: serviceUuid
                    }, function (instErr, insts) {
                        if (instErr) {
                            return feNext(instErr);
                        }

                        if (!insts.length) {
                            progress('No ' + key + ' instances to update');
                            delete services[key];
                            feNext();
                            return;
                        }

                        services[key].zone = insts[0];

                        return feNext();
                    });
                }},
                function (err) {
                    next(err);
                });
        },

        function checkIfCloudapiInMaint(_, next) {
            if (services.cloudapi) {
                if (services.cloudapi.metadata.CLOUDAPI_READONLY === true) {
                    progress('Cloudapi service already in read-only mode');
                } else {
                    putCloudapiIntoMaint = true;
                }
            }
            next();
        },

        function checkIfDockerInMaint(_, next) {
            if (services.docker) {
                if (services.docker.metadata.DOCKER_READONLY === true) {
                    progress('Docker service already in read-only mode');
                } else {
                    putDockerIntoMaint = true;
                }
            }
            next();
        },

        function setCloudapiReadonly(_, next) {
            if (!putCloudapiIntoMaint) {
                return next();
            }
            progress('Putting cloudapi in read-only mode');
            startTime = new Date();
            self.sapi.updateService(
                services.cloudapi.uuid,
                { metadata: {CLOUDAPI_READONLY: true } },
                function (err, svc) {
                    if (err) {
                        return next(new errors.SDCClientError(err, 'sapi'));
                    }
                    next();
                });
        },

        function setDockerReadonly(_, next) {
            if (!putDockerIntoMaint) {
                return next();
            }
            progress('Putting docker in read-only mode');
            startTime = new Date();
            self.sapi.updateService(
                services.docker.uuid,
                { metadata: { DOCKER_READONLY: true } },
                function (err, svc) {
                    if (err) {
                        return next(new errors.SDCClientError(err, 'sapi'));
                    }
                    next();
                });
        },

        function maybeRefreshCloudapiConfigAgent(_, next) {
            var zone = services.cloudapi && services.cloudapi.zone;
            if (zone) {
                svcadm.svcadmRefresh({
                    server_uuid: headnode.uuid,
                    zone: zone.uuid,
                    wait: true,
                    fmri: 'config-agent',
                    sdcadm: self,
                    log: self.log
                }, next);
            } else {
                next();
            }
        },

        function maybeRefreshDockerConfigAgent(_, next) {
            var zone = services.docker && services.docker.zone;
            if (zone) {
                svcadm.svcadmRefresh({
                    server_uuid: headnode.uuid,
                    zone: zone.uuid,
                    wait: true,
                    fmri: 'config-agent',
                    sdcadm: self,
                    log: self.log
                }, next);
            } else {
                next();
            }
        },

        /**
         * TODO: add readonly status to /--ping on cloudapi and watch for that.
         */

        function saveStartTime(_, next) {
            if (!putCloudapiIntoMaint && !putDockerIntoMaint) {
                return next();
            }
            var info = JSON.stringify({
                'startTime': startTime
            }, null, 4);
            fs.writeFile(self._dcMaintInfoPath, info, 'utf8', next);
        },

        function waitForWorkflowDrain(_, next) {
            progress('Waiting up to 5 minutes for workflow jobs to drain');
            var remaining = 60;
            var MAX_ERRS = 3;
            var numErrs = 0;
            setTimeout(pollJobs, 5000);

            function pollJobs() {
                remaining--;
                if (remaining <= 0) {
                    return next(new errors.InternalError({
                        message: 'timeout waiting for workflow jobs to drain'
                    }));
                }
                self.wfapi.listJobs({execution: 'running', limit: 10},
                        function (rErr, rJobs) {
                    if (rErr) {
                        numErrs++;
                        self.log.error(rErr, 'error listing running jobs');
                        if (numErrs >= MAX_ERRS) {
                            return next(rErr);
                        }
                    } else if (rJobs.length > 0) {
                        self.log.debug({numJobs: rJobs.length}, 'running jobs');
                        return setTimeout(pollJobs, 5000);
                    }
                    self.wfapi.listJobs({execution: 'queued', limit: 10},
                            function (qErr, qJobs) {
                        if (qErr) {
                            numErrs++;
                            self.log.error(qErr, 'error listing queued jobs');
                            if (numErrs >= MAX_ERRS) {
                                return next(qErr);
                            }
                        } else if (qJobs.length > 0) {
                            self.log.debug({numJobs: qJobs.length},
                                'queued jobs');
                            return setTimeout(pollJobs, 5000);
                        }
                        progress('Workflow cleared of running and queued jobs');
                        next();
                    });
                });
            }
        }
    ]}, cb);
};


/**
 * Leave maintenance mode.
 *
 * @param opts {Object}  Required.
 *      - progress {Function} Optional. A function that is called
 *        with progress messages. Called like printf, i.e. passing in
 *        `console.log` or a Bunyan `log.info.bind(log)` is fine.
 * @param cb {Function} Callback of the form `function (err)`.
 */
SdcAdm.prototype.dcMaintStop = function dcMaintStop(opts, cb) {
    assert.object(opts, 'opts');
    assert.optionalFunc(opts.progress, 'opts.progress');
    assert.func(cb, 'cb');
    var self = this;
    var log = self.log;
    var progress = opts.progress || function () {};

    var headnode;
    var sdcApp = self.sdc;
    var services = {};
    var disableCloudapiMaint = false;
    var disableDockerMaint = false;

    vasync.pipeline({funcs: [
        function getHeadnode(_, next) {
            self.cnapi.listServers({
                headnode: true
            }, function (err, servers) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'cnapi'));
                }
                headnode = servers[0];
                return next();
            });
        },

        function getCloudapiSvc(_, next) {
            var filters = {
                application_uuid: sdcApp.uuid,
                name: 'cloudapi'
            };
            self.sapi.listServices(filters, function (svcsErr, svcs) {
                if (svcsErr) {
                    return next(new errors.SDCClientError(svcsErr, 'sapi'));
                }
                services.cloudapi = svcs && svcs.length && svcs[0];
                next();
            });
        },

        function getDockerSvc(_, next) {
            var filters = {
                application_uuid: sdcApp.uuid,
                name: 'docker'
            };
            self.sapi.listServices(filters, function (svcsErr, svcs) {
                if (svcsErr) {
                    return next(new errors.SDCClientError(svcsErr, 'sapi'));
                }
                services.docker = svcs && svcs.length && svcs[0];
                next();
            });
        },

        function getSapiInstances(_, next) {
            progress('Getting SDC\'s sapi instances from SAPI');

            var keys = Object.keys(services);

            vasync.forEachParallel({ inputs: keys, func:
                function (key, feNext) {
                    var serviceUuid = services[key].uuid;

                    self.sapi.listInstances({
                        service_uuid: serviceUuid
                    }, function (instErr, insts) {
                        if (instErr) {
                            return feNext(instErr);
                        }

                        if (!insts.length) {
                            progress('No ' + key + ' instances to update');
                            delete services[key];
                            feNext();
                            return;
                        }

                        services[key].zone = insts[0];

                        return feNext();
                    });
                }},
                function (err) {
                    next(err);
                });
        },

        function checkIfCloudapiInMaint(_, next) {
            if (services.cloudapi) {
                if (services.cloudapi.metadata.CLOUDAPI_READONLY !== true) {
                    progress('Cloudapi service is not in read-only mode');
                } else {
                    disableCloudapiMaint = true;
                }
            }
            next();
        },
        function checkIfDockerInMaint(_, next) {
            if (services.docker) {
                if (services.docker.metadata.DOCKER_READONLY !== true) {
                    progress('Docker service is not in read-only mode');
                } else {
                    disableDockerMaint = true;
                }
            }
            next();
        },

        function setCloudapiWriteable(_, next) {
            if (!disableCloudapiMaint) {
                return next();
            }
            progress('Taking cloudapi out of read-only mode');
            self.sapi.updateService(
                services.cloudapi.uuid,
                { metadata: { CLOUDAPI_READONLY: false } },
                function (err, svc) {
                    if (err) {
                        return next(new errors.SDCClientError(err, 'sapi'));
                    }
                    next();
                });
        },
        function setDockerWriteable(_, next) {
            if (!disableDockerMaint) {
                return next();
            }
            progress('Taking docker out of read-only mode');
            self.sapi.updateService(
                services.docker.uuid,
                { metadata: { DOCKER_READONLY: false } },
                function (err, svc) {
                    if (err) {
                        return next(new errors.SDCClientError(err, 'sapi'));
                    }
                    next();
                });
        },
        function maybeRefreshCloudapiConfigAgent(_, next) {
            var zone = services.cloudapi && services.cloudapi.zone;
            if (zone) {
                svcadm.svcadmRefresh({
                    server_uuid: headnode.uuid,
                    zone: zone.uuid,
                    wait: true,
                    fmri: 'config-agent',
                    sdcadm: self,
                    log: self.log
                }, next);
            } else {
                next();
            }
        },

        function maybeRefreshDockerConfigAgent(_, next) {
            var zone = services.docker && services.docker.zone;
            if (zone) {
                svcadm.svcadmRefresh({
                    server_uuid: headnode.uuid,
                    zone: zone.uuid,
                    wait: true,
                    fmri: 'config-agent',
                    sdcadm: self,
                    log: self.log
                }, next);
            } else {
                next();
            }
        },

        /**
         * Note: We aren't waiting for config-agent in the cloudapi instance(s)
         * to effect this change. TODO: add readonly status to /--ping on
         * cloudapi and watch for that. ... on all instances?
         */

        function rmInfoFile(_, next) {
            if (!disableCloudapiMaint && !disableDockerMaint) {
                return next();
            }
            fs.unlink(self._dcMaintInfoPath, function (err) {
                if (err) {
                    // The info file is sugar. Don't fail if it isn't there.
                    log.warn({dcMaintInfoPath: self._dcMaintInfoPath, err: err},
                        'could not remove dc-maint info file');
                }
                next();
            });
        }

    ]}, cb);
};

/**
 * Check SAPI config against system "reality" and print out inconsistencies
 *
 * @param cb {Function} Callback of the form `function (err, result)`.
 */

SdcAdm.prototype.checkConfig = function (opts, cb) {
    var self = this;
    // SAPI values for sdc application:
    var sdc = self.sdc.metadata;
    // Name of SAPI services for VMs:
    var services;
    // Headnode sysinfo:
    var sysinfo;
    // External and admin networks:
    var admin;
    var external;

    // Errors:
    var errs = [];

    function getSysinfo(_, next) {
        self.cnapi.listServers({
            headnode: true,
            extras: 'sysinfo'
        }, function (err, res) {
            if (err) {
                return next(err);
            }
            sysinfo = (res && res.length > 0 ? res[0].sysinfo : null);

            Object.keys(sysinfo['Network Interfaces']).filter(function (k) {
                return (sysinfo['Network Interfaces'][k]['NIC Names'][0] ===
                    'admin');
            }).map(function (k) {
                if (sysinfo['Network Interfaces'][k]['MAC Address'] !==
                    sdc.admin_nic) {
                    errs.push('SAPI sdc admin_nic did not match with GZ ' +
                        'Admin MAC Address');
                }
                if (sysinfo['Network Interfaces'][k].ip4addr !== sdc.admin_ip) {
                    errs.push('SAPI sdc admin_ip did not match with GZ ' +
                        'Admin IPv4 Address');
                }
            });

            Object.keys(sysinfo['Virtual Network Interfaces']).
                filter(function (k) {
                return (k === 'external0');
            }).map(function (k) {
                if (sysinfo['Virtual Network Interfaces'][k].ip4addr !==
                    sdc.external_ip) {
                    errs.push('SAPI sdc external_ip did not match with GZ ' +
                        'External IPv4 Address');
                }
            });

            return next();
        });
    }


    function getNetworks(_, next) {
        self.napi.listNetworks({name: 'admin'}, function (err, res) {
            if (err) {
                return next(err);
            }
            admin = (res && res.length > 0 ? res[0] : null);
            if (admin.subnet.split('/')[0] !== sdc.admin_network) {
                errs.push('SAPI sdc admin_network did not match with value '+
                    'defined in NAPI');
            }
            if (admin.netmask !== sdc.admin_netmask) {
                errs.push('SAPI sdc admin_netmask did not match with value '+
                    'defined in NAPI');
            }
            // PEDRO: Note we should stop assuming external network will always
            // exist and, therefore, shouldn't return error on the next NAPI
            // call:
            self.napi.listNetworks({name: 'external'}, function (err2, res2) {
                if (err2) {
                    return next(err2);
                }
                external = (res2 && res2.length > 0 ? res2[0] : null);
                if (external.subnet &&
                    external.subnet.split('/')[0] !== sdc.external_network) {
                    errs.push('SAPI sdc external_network did not match with '+
                        'value defined in NAPI');
                }
                if (external.netmask !== sdc.external_netmask) {
                    errs.push('SAPI sdc external_netmask did not match with '+
                        'value defined in NAPI');
                }
                if (external.gateway !== sdc.external_gateway) {
                    errs.push('SAPI sdc external_gateway did not match with '+
                        'value defined in NAPI');
                }
                if (external.provision_start_ip !==
                    sdc.external_provisionable_start) {
                    errs.push('SAPI sdc external_provisionable_start did not '+
                        'match with value defined in NAPI');
                }
                if (external.provision_end_ip !==
                        sdc.external_provisionable_end) {
                    errs.push('SAPI sdc external_provisionable_end did not '+
                        'match with value defined in NAPI');
                }
                return next();
            });
        });
    }

    function getDcFromUfds(_, next) {
        self.ufds.search('o=smartdc', {
            scope: 'sub',
            filter: sprintf('(&(objectclass=datacenter)(datacenter=%s))',
                self.config.datacenter_name)
        }, function (err, res) {
            if (err) {
                return next(err);
            }
            if (!res) {
                errs.push('No DC information found in UFDS');
                return next();
            }
            res.forEach(function (r) {
                if (r.region !== sdc.region_name) {
                    errs.push(sprintf(
                        'region did not match with region_name for entry ' +
                        'with DN: %s', r.dn));
                }
                if (r.datacenter !== sdc.datacenter_name) {
                    errs.push(sprintf(
                        'data center did not match with datacenter_name for ' +
                        'entry with DN: %s', r.dn));
                }
                // company_name and location are not required for anything to
                // work properly, therefore, skipping them here
            });
            return next();
        });
    }

    function getUfdsAdmin(_, next) {
        self.ufds.search('o=smartdc', {
            scope: 'sub',
            filter: sprintf('(&(objectclass=sdcperson)(uuid=%s))',
                self.config.ufds_admin_uuid)
        }, function (err, res) {
            if (err) {
                return next(err);
            }

            var ufdsAdmin = (res && res.length > 0 ? res[0] : null);

            if (!ufdsAdmin) {
                errs.push('Cannot find UFDS admin user');
            }

            if (ufdsAdmin.login !== sdc.ufds_admin_login) {
                errs.push('UFDS admin login did not match SAPI ' +
                    'ufds_admin_login');
            }

            if (ufdsAdmin.email !== sdc.ufds_admin_email) {
                errs.push('UFDS admin email did not match SAPI ' +
                    'ufds_admin_email');
            }

            self.ufds.search(sprintf('uuid=%s, ou=users, o=smartdc',
                        self.config.ufds_admin_uuid), {
                scope: 'sub',
                filter: sprintf('(objectclass=sdckey)',
                    self.config.ufds_admin_key_fp)
            }, function (err2, res2) {
                if (err2) {
                    return next(err2);
                }

                if (!res2.length) {
                    errs.push('Cannot find UFDS admin key');
                    return next();
                }

                var sdcKey = res2.filter(function (k) {
                    return (k.fingerprint === sdc.ufds_admin_key_fingerprint);
                })[0];

                if (!sdcKey) {
                    errs.push('Cannot find UFDS admin key');
                    return next();
                }

                if (sdcKey.openssh !== sdc.ufds_admin_key_openssh.trim()) {
                    errs.push('UFDS Admin key did not match with SAPI '+
                            'ufds_admin_key_openssh');
                }
                return next();
            });
        });
    }

    // PEDRO: Shall we really care about core zone Admin IP addresses here?:
    // (Ignoring for now)
    function getVmsIps(_, next) {
        var filters = {
            query: sprintf('(&(tags=*-smartdc_type=core-*)' +
                   '(|(state=running)(state=provisioning)(state=stopped))' +
                   '(owner_uuid=%s))', self.config.ufds_admin_uuid)
        };
        self.vmapi.listVms(filters, function (vmsErr, _vms) {
            if (vmsErr) {
                return next(vmsErr);
            }
            return next();
        });

    }

    self.sapi.listServices({
        application_uuid: sdc.uuid
    }, function (err2, res2) {
        if (err2) {
            return cb(err2);
        }
        if (!res2.length) {
            return cb('Cannot find SDC services in SAPI');
        }

        services = res2.filter(function (s) {
            return (s.type === 'vm');
        }).map(function (s) {
            return (s.name);
        });

        vasync.pipeline({
            funcs: [
                getSysinfo,
                getNetworks,
                getDcFromUfds,
                getUfdsAdmin,
                getVmsIps
            ]
        }, function (err4, _res) {
            if (err4) {
                return cb(err4);
            }

            // PEDRO: Note the exceptions listed below. I bet we could
            // remove most of these variables anyway, and left a single
            // value for *_pw.
            services.forEach(function (s) {
                if (!sdc[s + '_root_pw'] && s !== 'manta' && s !== 'sapi') {
                    errs.push(sprintf('Missing %s_root_pw in SAPI', s));
                }

                if (!sdc[s + '_admin_ips'] && s !== 'cloudapi' &&
                    s !== 'manta' && s !== 'sdcsso') {
                    errs.push(sprintf('Missing %s_admin_ips in SAPI', s));
                }

                if (s !== 'manatee' && s !== 'binder' &&
                    s !== 'manta' && s !== 'cloudapi') {
                    if (!sdc[s + '_domain']) {
                        errs.push(sprintf('Missing %s_domain in SAPI', s));
                    }
                    if (!sdc[s.toUpperCase() + '_SERVICE']) {
                        errs.push(sprintf('Missing %s_SERVICE in SAPI',
                                s.toUpperCase()));
                    }
                }
            });
            // Check that ufds_remote_ip is present if this is not master:
            if (!sdc.ufds_is_master || sdc.ufds_is_master === 'false') {
                if (!sdc.ufds_remote_ip) {
                    errs.push('Missing SAPI variable "ufds_remote_ip"');
                }
            }
            return self.ufds.close(function (err3) {
                return cb(null, errs);
            });
        });
    });
};


/**
 * Check health of given SAPI instances.
 *
 * @param opts {Object}  Required.
 *      - insts {Array} Optional. Instance objects as returned by listInsts.
 *        When given, `uuids` will be ignored.
 *      - uuids {Array} Optional. SAPI instance (or service) UUIDs to check.
 *        If not given and insts isn't present, then all SDC instances are
 *        checked.
 * @param cb {Function} Callback of the form `function (err, results)`.
 */
SdcAdm.prototype.checkHealth = function checkHealth(opts, cb) {
    var self = this;
    assert.object(opts, 'opts');
    assert.optionalArrayOfString(opts.uuids, 'opts.uuids');
    assert.optionalArrayOfObject(opts.insts, 'opts.insts');
    assert.optionalString(opts.type, 'opts.type');
    assert.optionalArrayOfString(opts.servers, 'opts.servers');
    assert.func(cb, 'cb');

    var svcLookup = {};
    var uuidLookup;
    var insts;
    var headnode;

    if (opts.insts) {
        insts = opts.insts;
    } else if (opts.uuids) {
        uuidLookup = {};
        opts.uuids.forEach(function (id) { uuidLookup[id] = true; });
    }

    // No need to keep these variables global to the whole sdcadm module:
    var pingPaths = {
        // vms
        amon:     '/ping',
        cloudapi: '/--ping',
        cnapi:    '/ping',
        fwapi:    '/ping',
        imgapi:   '/ping',
        napi:     '/ping',
        papi:     '/ping',
        sapi:     '/ping',
        vmapi:    '/ping',
        workflow: '/ping',
        // agents
        firewaller: '/status'
    };

    var pingPorts = {
        cloudapi: 443,
        firewaller: 2021
    };

    // We can ping instances either when we checked for svcs health using
    // Ur client or when we did straight at the Headnode cmd. Shared code
    // by these two functions:
    function _pingInstance(inst, next) {

        var pingPath = pingPaths[inst.service];

        if (!pingPath) {
            inst.healthy = true;
            return next(null, inst);
        }

        var port = pingPorts[inst.service] || 80;

        var httpClient = (port === 443 ? https : http);

        httpClient.get({
            hostname: (inst.ip || inst.server_ip),
            port: port,
            path: pingPath,
            agent: false,
            rejectUnauthorized: false
        }, function (res) {
            self.log.debug({ http_response: res.statusCode },
                           'HTTP result for ' + inst.instance);

            inst.healthy = (res.statusCode === 200);

            if (!inst.healthy) {
                inst.health_errors = [ {
                    message: 'ping check to ' + inst.ip + ' failed with ' +
                             'HTTP code ' + res.statusCode
                } ];
            }

            return next(null, inst);
        }).once('error', function (e) {
            inst.healthy = false;

            inst.health_errors = [ {
                message: 'ping check to ' + inst.ip + ' failed: ' +
                         e.message
            } ];

            return next(null, inst);
        });
    }


    function connectToUr(_, next) {
        // Will wait, at least, for the 5000 msecs we gave to ur client
        // as connect timeout before we call it and move into the "no-ur"
        // branch:
        var t = setTimeout(function () {
            if (self.urConnTimedOut) {
                self.log.error('Error connecting to Ur Agent');
                return next();
            }
        }, 5500); // Note this timeout is intentionally longer than Ur
        // client connect timeout.

        // If the connection times out, this will never be reached, and the
        // function above should call next
        if (!self.urConnTimedOut) {
            self.ur.once('ready', function () {
                clearTimeout(t);
                return next();
            });
        }
    }

    function lookupServices(_, next) {
        if (opts.insts) {
            return next();
        }
        var svcOpts = {};
        if (opts.type) {
            svcOpts.type = opts.type;
        }
        self.getServices(svcOpts, function (err, svcs) {
            if (err) {
                if (!err.message) {  // TODO(trentm): why this?!
                    err = new Error(err);
                }
                return next(err);
            }

            self.log.debug({ services: svcs }, 'Look up services');

            if (uuidLookup) {
                svcs = svcs.filter(function (svc) {
                    var found = uuidLookup[svc.uuid];

                    if (found) {
                        delete uuidLookup[svc.uuid];
                    }

                    return found;
                });
            }

            svcs.forEach(function (svc) {
                if (svc.type === 'vm' || svc.type === 'agent') {
                    svcLookup[svc.name] = true;
                }
            });

            return next();
        });
    }

    function lookupInstances(_, next) {
        if (opts.insts) {
            return next();
        }

        var svcOpts = {};
        if (opts.type) {
            svcOpts.types = [opts.type];
        }

        self.listInsts(svcOpts, function (err, insts_) {
            if (err) {
                if (!err.message) {
                    err = new Error(err);
                }
                return next(err);
            }

            self.log.debug({ instances: insts_ }, 'Look up instances');

            insts = insts_.filter(function (inst) {
                if (inst.type !== 'vm' && inst.type !== 'agent') {
                    return false;
                }

                if (!svcLookup[inst.service] &&
                    !(uuidLookup && uuidLookup[inst.instance])) {
                    return false;
                }

                if (uuidLookup) {
                    delete uuidLookup[inst.instance];
                }

                if (inst.type === 'vm' && !inst.ip &&
                        inst.service !== 'hostvolume') {
                    self.log.error(inst.instance, 'VM has no admin IP, skip!');
                    return false;
                }

                return true;
            });

            if (uuidLookup && Object.keys(uuidLookup).length > 0) {
                var msg = 'unrecognized service or instances: ' +
                    Object.keys(uuidLookup).join(', ');
                return next(new Error(msg));
            }

            return next();
        });
    }

    function checkInst(inst, next) {
        if (inst.server === headnode.UUID) {
            return checkHeadnodeInst(inst, next);
        }

        if (!self.urConnTimedOut) {
            return checkUrInst(inst, next);
        }

        // Do nothing, since it's not a local instance, and we cannot
        // connect to Ur to query remote instances status
        return next();

    }

    function checkUrInst(inst, next) {
        var script;
        if (inst.type === 'vm') {
            script = 'svcs -vxz ' + inst.instance;
        } else if (inst.type === 'agent') {
            script = 'svcs -vx ' + inst.service;
        } else if (inst.alias === 'global') {
            script = 'svcs -vx';
        } else {
            return next();
        }

        // there are a couple agents which don't actually have SMF services,
        // so skip them
        if (inst.service.match(/(agents_core|cabase)$/)) {
            return next();
        }

        self.ur.exec({
            script: script,
            server_uuid: inst.server,
            timeout: 5000
        }, function (err, result) {
            if (err) {
                inst.health_errors = [ {
                    message: err.message
                }];
                return next(null, inst);
            }

            self.log.debug({ ur_response: result },
                           'Ur result for ' + inst.instance);

            if (result.exit_status !== 0 ||
                result.stderr !== '' ||
                !(result.stdout === '' ||
                  result.stdout.match(/State\: online/))) {

                inst.healthy = false;

                var errs = [];

                if (result.exit_status !== 0) {
                    errs.push('svcs returned ' + result.exit_status);
                }

                if (result.stderr) {
                    errs.push('stderr: ' + result.stderr.replace(/\n+$/, ''));
                }

                if (!(result.stdout === '' ||
                      result.stdout.match(/State\: online/))) {
                    errs.push('stdout: ' + result.stdout.replace(/\n+$/, ''));
                }

                if (errs.length > 0) {
                    inst.health_errors = errs.map(function (error) {
                        return { message: 'SMF svcs check failed: ' + error };
                    });
                }

                return next(null, inst);
            }

            return _pingInstance(inst, next);
        });
    }

    // Used only when cannot stablish a connection to the AMQP server:
    function checkHeadnodeInst(inst, next) {
        var argv;

        if (inst.type === 'vm') {
            argv = ['/usr/bin/svcs', '-vxz', inst.instance];
        } else if (inst.type === 'agent') {
            argv = ['/usr/bin/svcs', '-vx', inst.service];
        } else if (inst.alias === 'global') {
            argv = ['/usr/bin/svcs', '-vx'];
        } else {
            return next();
        }

        // there are a couple agents which don't actually have SMF services,
        // so skip them
        if (inst.service.match(/(agents_core|cabase)$/)) {
            return next();
        }

        common.execFilePlus({
            argv: argv,
            log: self.log
        }, function (err, stdout, stderr) {
            var errs = [];

            if (err) {
                errs.push(err);
            }

            if (stderr) {
                errs.push('stderr: ' + stderr.replace(/\n+$/, ''));
            }

            if (!(stdout === '' || stdout.match(/State\: online/))) {
                errs.push('stdout: ' + stdout.replace(/\n+$/, ''));
            }

            if (errs.length > 0) {
                inst.healthy = false;
                inst.health_errors = errs.map(function (error) {
                    return { message: 'SMF svcs check failed: ' + error };
                });
                return next(null, inst);
            }

            return _pingInstance(inst, next);
        });
    }

    // Intentionally not dealing into CNAPI here, since we may also need
    // to rely into sysinfo to know the name of installed agents:
    function getHeadnodeSysinfo(_, next) {
        var argv = ['/usr/bin/sysinfo'];
        common.execFilePlus({
            argv: argv,
            log: self.log
        }, function (err, stdout, stderr) {
            if (err) {
                return next(err);
            }
            try {
                headnode = JSON.parse(stdout.trim());
                if (!opts.insts) {
                    insts.push({
                        type: 'global',
                        instance: headnode.UUID,
                        alias: 'global',
                        service: 'global',
                        hostname: 'headnode',
                        server: headnode.UUID
                    });
                }
            } catch (e) {
                return next(e);
            }
            return next();
        });
    }

    vasync.pipeline({ funcs: [
        connectToUr, lookupServices, lookupInstances, getHeadnodeSysinfo
    ]}, function (err) {
        if (err) {
            self.log.error({err: err}, 'checkHealth pipeline cb');
            return cb(err);
        }

        // If servers to lookup were given as arguments, ignore whatever
        // not into these servers:
        if (opts.servers && opts.servers.length) {
            insts = insts.filter(function (ins) {
                return (opts.servers.indexOf(ins.server) !== -1 ||
                        opts.servers.indexOf(ins.hostname) !== -1);
            });
        }

        vasync.forEachParallel({
            inputs: insts,
            func: checkInst
        }, function (err2, results) {
            self.ur.close();
            // Might need to re-user ur latest, need to reset it in order
            // to be able to re-connect:
            delete self._ur;

            if (err2) {
                self.log.error({err: err2}, 'checkHealth parallel cb');
                return cb(new errors.InternalError(new Error(err2)));
            }

            var healthResults = results.successes.filter(function (res) {
                return res;
            });

            // Notify about results being fetched locally and AMQP down:
            if (self.urConnTimedOut) {
                healthResults.push({
                    type: 'service',
                    instance: '00000000-0000-0000-0000-000000000000',
                    alias: 'rabbitmq0',
                    service: 'rabbitmq',
                    hostname: 'headnode',
                    healthy: false,
                    health_errors: [ {
                        message: 'Ur Client cannot connect to AMQP server.\n' +
                            'Providing results only for vms/agents running ' +
                            'into Headnode'
                    }]
                });
            }

            return cb(null, healthResults);
        });
    });
};

SdcAdm.prototype.createCloudapiInstance =
function createCloudapiInstance(opts, callback) {
    var self = this;
    var sapi = self.sapi;
    assert.func(opts.progress, 'opts.progress');

    var networks;
    var progress = opts.progress;
    var cloudapisvc;
    var changes = [];
    var img, history, headnode;

    // find cloudapi service, get service uuid
    // use sapi.createInstance to create the service

    vasync.pipeline({ funcs: [
        function (_, next) {
            sapi.listServices({ name: 'cloudapi' }, function (err, svcs) {
                if (err) {
                    return next(err);
                }
                if (svcs.length !== 1) {
                    return next(new Error(
                        'expected 1 cloudapi service, found %d', svcs.length));
                }
                cloudapisvc = svcs[0];
                next();
            });
        },
        function (_, next) {
            getNetworksAdminExternal({}, function (err, nets) {
                if (err) {
                    return next(err);
                }
                networks = nets;
                next();
            });
        },
        function (_, next) {
            self.updates.listImages({
                name: 'cloudapi'
            }, function (err, images) {
                if (err) {
                    next(err);
                } else if (images && images.length) {
                    img = images[images.length - 1]; //XXX presuming sorted
                    next();
                } else {
                    next(new errors.UpdateError('no "cloudapi" image found'));
                }
            });
        },
        function (_, next) {
            changes.push({
                image: img,
                service: cloudapisvc,
                type: 'add-instance',
                inst: {
                    type: 'vm',
                    alias: opts.alias,
                    version: img.version,
                    service: 'cloudapi',
                    image: img.uuid
                }
            });
            self.history.saveHistory({
                changes: changes
            }, function (err, hst) {
                if (err) {
                    return next(err);
                }
                history = hst;
                return next();
            });
        },
        function getHeadnode(_, next) {
            self.cnapi.listServers({
                headnode: true
            }, function (err, servers) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'cnapi'));
                }
                headnode = servers[0];
                return next();
            });
        },
        function (_, next) {
            var cOpts = {
                params: {
                    server_uuid: headnode.uuid,
                    alias: opts.alias,
                    networks: [
                        {
                            uuid: networks.admin.uuid
                        },
                        {
                            primary: true,
                            uuid: networks.external.uuid
                        }
                    ]
                }
            };
            sapi.createInstance(cloudapisvc.uuid, cOpts, function (err, inst) {
                if (err) {
                    return next(err);
                }
                changes[0].inst.zonename = changes[0].inst.uuid = inst.uuid;
                next();
            });
        },
        function hupHermes(_, next) {
            svcadm.restartHermes({
                sdcadm: self,
                log: self.log,
                progress: progress
            }, next);
        }
    ] }, function (err) {
        if (!history) {
            self.log.warn('History not set for post-setup cloudapi');
            return callback(err);
        }
        history.changes = changes;
        if (err) {
            history.error = err;
        }
        // No need to add `history.finished` here, History instance will do
        self.history.updateHistory(history, function (err2, hist2) {
            if (err) {
                callback(err);
            } else if (err2) {
                callback(err2);
            } else {
                progress('cloudapi0 zone created');
                callback();
            }
        });
    });

    function getNetworksAdminExternal(err, cb) {
        var napi = self.napi;
        var foundnets = {};

        napi.listNetworks({ name: ['admin', 'external'] },
        function (listerr, nets) {
            if (listerr) {
                return cb(err);
            }

            if (!nets.length) {
                return cb(new Error('Couldn\'t find admin network in NAPI'));
            }
            for (var i in nets) {
                foundnets[nets[i].name] = nets[i];
            }

            cb(null, foundnets);
        });
    }
};

// Extracted from setupCommonExternalNics b/c it's also used by DownloadImages
// to check if the reason for an IMGAPI failure could be the lack of external
// nic into imgapi zone
SdcAdm.prototype.checkMissingExternalNics =
function checkMissingExternalNics(opts, cb) {
    var self = this;
    assert.func(opts.progress, 'opts.progress');
    assert.func(cb, 'cb');

    var sapi = self.sapi;
    var napi = self.napi;

    var svcadminui;
    var svcimgapi;
    var doadminui = true;
    var doimgapi = true;

    var netexternal;

    function getInstance(svcname, callback) {
        sapi.listServices({ name: svcname }, onServices);

        function onServices(err, svcs) {
            if (err) {
                return cb(err);
            }
            if (!svcs.length) {
                return cb(new Error(
                    'Couldn\'t find imgapi SAPI service'));
            }

            sapi.listInstances({ service_uuid: svcs[0].uuid },
            function (listerr, inst) {
                if (listerr) {
                    return cb(listerr);
                }
                callback(null, inst[0]);
            });
        }
    }

    vasync.pipeline({ funcs: [
        // Look up details for the adminui, imgapi instances.
        function (_, next) {
            getInstance('adminui', function (err, inst) {
                if (err) {
                    return cb(err);
                }
                svcadminui = inst;
                next();
            });
        },
        function (_, next) {
            getInstance('imgapi', function (err, inst) {
                if (err) {
                    return cb(err);
                }
                svcimgapi = inst;
                next();
            });
        },
        // Grab the external network details.
        function (_, next) {
            var listOpts = { name: 'external' };
            napi.listNetworks(listOpts, function (err, nets) {
                if (err) {
                    return cb(err);
                }

                if (!nets.length) {
                    return cb(new Error(
                        'Couldn\'t find external network in NAPI'));
                }

                netexternal = nets[0];
                next();
            });
        },
        // Check what NICS the imgapi and adminui zones currently have. Only do
        // work for those which do not yet have an external nic.
        function (_, next) {
            var listOpts = {
                belongs_to_type: 'zone',
                belongs_to_uuid: [ svcimgapi.uuid, svcadminui.uuid ]
            };
            napi.listNics(listOpts, function (err, nics) {
                if (err) {
                    return cb(err);
                }

                if (!nics.length) {
                    return cb(new Error(
                        'Couldn\'t find NICs for imgapi or adminui'));
                }

                for (var i = 0, nic; i < nics.length; i++) {
                    nic = nics[i];
                    if (nic.belongs_to_uuid === svcadminui.uuid &&
                        nic.nic_tag === 'external')
                    {
                        doadminui = false;
                    } else if (nic.belongs_to_uuid === svcimgapi.uuid &&
                        nic.nic_tag === 'external')
                    {
                        doimgapi = false;
                    }
                }

                next();
            });
        }
    ]}, function (err) {
        if (err) {
            cb(err);
        } else {
            cb(null, {
                doimgapi: doimgapi,
                doadminui: doadminui,
                svcadminui: svcadminui,
                svcimgapi: svcimgapi,
                netexternal: netexternal
            });
        }
    });
};

SdcAdm.prototype.setupCommonExternalNics = function
setupCommonExternalNics(opts, cb) {
    var self = this;
    assert.func(opts.progress, 'options.progress');

    var progress = opts.progress;

    var svcadminui;
    var svcimgapi;
    var doadminui = true;
    var doimgapi = true;

    var netexternal;
    var changes = [];
    var history;
    var napisvc;


    function addExternaNicToZone(svcobj, subcb) {
        var addparams = {
            uuid: svcobj.uuid,
            networks: [
                { 'uuid': netexternal.uuid, primary: true }
            ]
        };
        self.vmapi.addNicsAndWait(addparams, subcb);
    }

    vasync.pipeline({ funcs: [
        function (_, next) {
            self.checkMissingExternalNics(opts, function (err, res) {
                if (err) {
                    return next(err);
                }
                doimgapi = res.doimgapi;
                doadminui = res.doadminui;
                svcadminui = res.svcadminui;
                svcimgapi = res.svcimgapi;
                netexternal = res.netexternal;
                next();
            });
        },

        function (_, next) {
            if (!doadminui && !doimgapi) {
                return next();
            }
            self.sapi.listServices({ name: 'napi' }, function (err, svcs) {
                if (err) {
                    return next(err);
                }
                if (svcs.length !== 1) {
                    return next(new Error(
                        'expected 1 napi service, found %d', svcs.length));
                }
                napisvc = svcs[0];
                next();
            });
        },

        function (_, next) {
            if (!doadminui && !doimgapi) {
                return next();
            }
            changes.push({
                service: napisvc,
                type: 'add-nics',
                inst: {
                    network: netexternal.uuid,
                    adminui: doadminui,
                    imgapi: doimgapi
                }
            });
            self.history.saveHistory({
                changes: changes
            }, function (err, hst) {
                if (err) {
                    return next(err);
                }
                history = hst;
                return next();
            });
        },

        function (_, next) {
            if (!doadminui) {
                progress('AdminUI already has an external nic');
                return next();
            }
            addExternaNicToZone(svcadminui, function (err) {
                if (err) {
                    return next(err);
                }
                progress('Added external nic to adminui');
                next();
            });
        },

        function (_, next) {
            if (!doimgapi) {
                progress('IMGAPI already has an external nic');
                return next();
            }
            addExternaNicToZone(svcimgapi, function (err) {
                if (err) {
                    return next(err);
                }
                progress('Added external nic to imgapi');
                next();
            });
        }
    ]}, function (err) {
        if (!history) {
            self.log.info(
                'History not set for post-setup common-external-nics');
            return cb(err);
        }
        history.changes = changes;
        if (err) {
            history.error = err;
        }
        self.history.updateHistory(history, function (err2, hist2) {
            if (err) {
                cb(err);
            } else if (err2) {
                cb(err2);
            } else {
                cb();
            }
        });
    });
};


/*
 * Generate a rollback plan from the contents of the given update plan.
 *
 * @param options {Object}  Required.
 *      - updatePlan {Object} Required. The update plan.
 *      - progress {Function} Optional. A function that is called
 *        with progress messages. Called like printf, i.e. passing in
 *        `console.log` or a Bunyan `log.info.bind(log)` is fine.
 * @param cb {Function} Callback of the form `function (err, plan)`.
 */
SdcAdm.prototype.genRollbackPlan = function genRollbackPlan(options, cb) {
    assert.object(options, 'options');
    assert.object(options.updatePlan, 'options.updatePlan');
    assert.optionalFunc(options.progress, 'options.progress');
    assert.optionalString(options.uuid, 'options.uuid');
    assert.func(cb, 'cb');
    var self = this;
    var log = self.log;
    var progress = options.progress || function () {};

    var serverFromUuidOrHostname;
    var rbPlan = {};
    var upPlan = options.updatePlan;
    var svcs;
    var svcFromName;
    var insts;
    var changes;
    var plan;
    var servers;

    vasync.pipeline({funcs: [

        function getServers(_, next) {
            self.cnapi.listServers(function (err, servers_) {
                servers = servers_ || [];
                serverFromUuidOrHostname = {};
                for (var i = 0; i < servers.length; i++) {
                    serverFromUuidOrHostname[servers[i].uuid] = servers[i];
                    serverFromUuidOrHostname[servers[i].hostname] = servers[i];
                }
                next(err);
            });
        },

        function getSvcs(_, next) {
            self.getServices({}, function (err, svcs_) {
                svcs = svcs_ || [];
                svcFromName = {};
                for (var i = 0; i < svcs.length; i++) {
                    svcFromName[svcs[i].name] = svcs[i];
                }
                next(err);
            });
        },

        function getInsts(_, next) {
            self.listInsts(function (err, insts_) {
                insts = insts_;
                next(err);
            });
        },

        function genRbSpecFromUpdate(_, next) {
            rbPlan.changes = [];
            upPlan.changes.forEach(function (change) {
                var chg = {
                    service: change.service,
                    type: (change.type === 'update-service') ?
                        'rollback-service' : 'unknown'
                };
                if (change.service.type === 'vm') {
                    if (change.service.name === 'assets') {
                        chg.rb_img = change.inst.image;
                    } else {
                        chg.rb_img = change.service.params.image_uuid;
                    }
                }
                rbPlan.changes.push(chg);
            });
            next();
        },

        function getImgs(_, next) {
            var _changes = [];
            vasync.forEachParallel({
                inputs: rbPlan.changes,
                func: function (chg, next_) {
                    if (chg.service.type === 'vm') {
                        self.getImage({
                            uuid: chg.rb_img
                        }, function (e, img) {
                            if (e) {
                                return next_(e);
                            }
                            chg.image = img;
                            delete chg.rb_img;
                            _changes.push(chg);
                            return next_();
                        });
                    } else {
                        _changes.push(chg);
                        return next_();
                    }
                }
            }, function (err) {
                rbPlan.changes = _changes;
                next(err);
            });
        },

        function getChannel(_, next) {
            self.getDefaultChannel(function (err, channel) {
                // Will not fail the whole operation due to channel not found
                if (err) {
                    return next();
                }
                progress('Using channel %s', channel);
                return next();
            });
        },

        function createPlan(_, next) {
            changes = rbPlan.changes;
            var targ = common.deepObjCopy(insts);
            for (var i = 0; i < changes.length; i++) {
                var ch = changes[i];
                for (var j = 0; j < targ.length; j++) {
                    var inst = targ[j];
                    if (inst.service === ch.service.name) {
                        inst.image = ch.image.uuid;
                        inst.version = ch.image.version;
                    }
                }
            }

            plan = new UpdatePlan({
                curr: insts,
                targ: targ,
                changes: changes,
                rollback: true,
                justImages: false
            });
            next();
        },

        function determineProcedures(_, next) {
            procedures.coordinatePlan({
                plan: plan,
                sdcadm: self,
                serverFromUuidOrHostname: serverFromUuidOrHostname,
                log: log,
                progress: progress
            }, function (err, procs_) {
                plan.procs = procs_;
                next(err);
            });
        }
    ]}, function finishRb(err) {
        cb(err, plan);
    });
};

//---- exports

module.exports = SdcAdm;
