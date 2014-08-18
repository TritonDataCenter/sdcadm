/*
 * Copyright (c) 2014, Joyent, Inc. All rights reserved.
 *
 * Core SdcAdm class.
 */

var assert = require('assert-plus');
var exec = require('child_process').exec;
var format = require('util').format;
var fs = require('fs');
var p = console.log;
var path = require('path');
var mkdirp = require('mkdirp');
var sdcClients = require('sdc-clients');
var semver = require('semver');
var sprintf = require('extsprintf').sprintf;
var vasync = require('vasync');
var WfClient = require('wf-client');

var common = require('./common');
var errors = require('./errors');
var lock = require('./locker').lock;
var pkg = require('../package.json');
var procedures = require('./procedures');

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

    this.v = UPDATE_PLAN_FORMAT_VER;
    this.curr = options.curr;
    this.targ = options.targ;
    this.changes = options.changes;
    this.justImages = options.justImages;
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
    assert.optionalString(options.profile, 'options.profile');
    var self = this;

    this.log = options.log;

    self._lockPath = '/var/run/sdcadm.lock';

    self.userAgent = UA;
    Object.defineProperty(this, 'sapi', {
        get: function () {
            if (self._sapi === undefined) {
                self._sapi = new sdcClients.SAPI({
                    url: self.config.sapi.url,
                    agent: false,
                    userAgent: self.userAgent,
                    log: self.log
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
                    log: self.log
                });
            }
            return self._cnapi;
        }
    });
    Object.defineProperty(this, 'vmapi', {
        get: function () {
            if (self._vmapi === undefined) {
                self._vmapi = new sdcClients.VMAPI({
                    url: self.config.vmapi.url,
                    agent: false,
                    userAgent: self.userAgent,
                    log: self.log
                });
            }
            return self._vmapi;
        }
    });
    Object.defineProperty(this, 'imgapi', {
        get: function () {
            if (self._imgapi === undefined) {
                self._imgapi = new sdcClients.IMGAPI({
                    url: self.config.imgapi.url,
                    agent: false,
                    userAgent: self.userAgent,
                    log: self.log
                });
            }
            return self._imgapi;
        }
    });
    Object.defineProperty(this, 'updates', {
        get: function () {
            if (self._updates === undefined) {
                self._updates = new sdcClients.IMGAPI({
                    url: self.config.updatesServerUrl,
                    agent: false,
                    userAgent: self.userAgent,
                    log: self.log
                });
            }
            return self._updates;
        }
    });
    Object.defineProperty(this, 'napi', {
        get: function () {
            if (self._napi === undefined) {
                self._napi = new sdcClients.NAPI({
                    url: self.config.napi.url,
                    agent: false,
                    userAgent: self.userAgent,
                    log: self.log
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
                    log: self.log.child({client: 'wfapi'}, true)
                });
            }
            return self._wfapi;
        }
    });
    // NOTE: A method using self.ufds should take care of
    // calling self._ufds.close(function (err) {});
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
}


SdcAdm.prototype.init = function init(cb) {
    var self = this;
    var opts = {
        log: self.log
    };
    common.loadConfig(opts, function (err, config) {
        if (err) {
            return cb(err);
        }
        self.config = config;
        if (self.config.serverUuid) {
            self.userAgent += ' server=' + self.config.serverUuid;
        }
        cb();
    });
};


/**
 * Gather a JSON object for each installed SDC service instance.
 *
 * "Services" include: SDC core vms and agents.
 *
 * TODO:
 * - gz tools
 * - sdcadm itself (need to get the manifest file installed for this)
 * - buildstamp field once have more consistent semver versioning
 *
 * All types will have these fields:
 *      type            type of service, e.g. 'vm', 'agent', 'platform'
 *      service         name of service, e.g. 'vmapi, 'provisioner', 'platform'
 *      image           image UUID (Note: Platforms and agents aren't
 *                      currently distributed as separate "images" in
 *                      updates.joyent.com. Until they are `image === null`.)
 *      version         version string, e.g. '1.2.3', '7.0/20140101T12:43:55Z'
 *      server          server uuid
 *      hostname        server hostname
 */
SdcAdm.prototype.getInstances = function getInstances(opts, cb) {
    var self = this;
    assert.object(opts, 'opts');
    assert.func(cb, 'cb');

    var insts = [];
    var serversFromUuid = {};
    vasync.pipeline({funcs: [
        function getAgentsAndPlatforms(_, next) {
            var serverOpts = {
                extras: 'sysinfo'
            };
            self.cnapi.listServers(serverOpts, function (serversErr, servers) {
                if (serversErr) {
                    return next(serversErr);
                }
                servers.forEach(function (server) {
                    serversFromUuid[server.uuid] = server;

                    // TODO: re-include platforms via SAPI.
                    //var sdcVersion = server.sysinfo['SDC Version'] || '6.5';
                    //var version = format('%s:%s', sdcVersion,
                    //    server.current_platform);
                    //insts.push({
                    //    type: 'platform',
                    //    service: 'platform',
                    //    version: version,
                    //    image: null,
                    //    sdc_version: sdcVersion,
                    //    platform: server.current_platform,
                    //    server: server.uuid,
                    //    hostname: server.hostname
                    //});

                    (server.sysinfo['SDC Agents'] || []).forEach(
                            function (agent) {
                        insts.push({
                            type: 'agent',
                            service: agent.name,
                            instance: server.uuid + '/' + agent.name,
                            version: agent.version,
                            image: agent.image, // TODO will come eventually
                            server: server.uuid,
                            hostname: server.hostname
                        });
                    });
                });
                next();
            });
        },
        function getCoreZones(_, next) {
            // 'cloudapi' zones typically don't have `tags.smartdc_core=true`
            // so we can't filter on that. And VMAPI doesn't support filtering
            // on presence of a tag (e.g. `smartdc_role`.)
            var filters = {
                state: 'active',
                owner_uuid: self.config.ufds_admin_uuid
            };
            self.vmapi.listVms(filters, function (vmsErr, vms) {
                if (vmsErr) {
                    return next(vmsErr);
                }
                vms = vms.filter(function (vm) {
                    return vm.tags && vm.tags.smartdc_role;
                });
                // TODO: log vms info here.
                vasync.forEachParallel({
                    inputs: vms,
                    func: function addOneCoreZone(vm, nextVm) {
                        self.imgapi.getImage(vm.image_uuid, function (e, img) {
                            if (e) {
                                return nextVm(e);
                            }
                            insts.push({
                                type: 'vm',
                                alias: vm.alias,
                                version: img.version,
                                instance: vm.uuid,
                                zonename: vm.uuid,
                                service: vm.tags.smartdc_role,
                                image: vm.image_uuid,
                                server: vm.server_uuid,
                                hostname: serversFromUuid[
                                    vm.server_uuid].hostname
                            });
                            nextVm();
                        });
                    }
                }, next);
            });
        }
    ]}, function (err) {
        cb(err, insts);
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

    var app;
    var svcs = [];
    vasync.pipeline({funcs: [
        function getSdcApp(_, next) {
            self.sapi.listApplications({name: 'sdc'}, function (appErr, app_) {
                if (appErr) {
                    return next(new errors.SDCClientError(appErr, 'sapi'));
                }
                app = (app_ && app_.length > 0 ? app_[0] : null);
                next();
            });
        },
        function getSapiSvcs(_, next) {
            // 'cloudapi' zones typically don't have `tags.smartdc_core=true`
            // so we can't filter on that. And VMAPI doesn't support filtering
            // on presence of a tag (e.g. `smartdc_role`.)
            var filters = {
                application_uuid: app.uuid
            };
            self.sapi.listServices(filters, function (svcsErr, svcs_) {
                if (svcsErr) {
                    return next(new errors.SDCClientError(svcsErr, 'sapi'));
                }
                svcs = svcs_;
                var haveAssets = false;
                svcs.forEach(function (svc) {
                    // TODO(trent): want SAPI to have this eventually
                    svc.type = 'vm';
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
                agent.type = 'agent';
                svcs.push(agent);
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
 * @param options {Object} Required.
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
 * Return an array of candidate images (the full image objects) for a
 * give service update.
 *
 * TODO: support this for a particular instance as well by passing in `inst`.
 *
 * @param options {Object} Required.
 *      - serviceName {UUID} Required. The name of service for which to
 *        find candidates.
 *      - insts {Array} Required. Current DC instances as from `getInstances()`.
 * @param cb {Function} `function (err, img)`
 */
SdcAdm.prototype.getCandidateImages = function getCandidateImages(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.serviceName, 'opts.serviceName');
    assert.arrayOfObject(opts.insts, 'opts.insts');
    assert.func(cb, 'cb');
    var self = this;

    var currImgs = [];
    var imgs;

    vasync.pipeline({funcs: [
        function getCurrImgs(_, next) {
            var currImgUuids = {};
            opts.insts.forEach(function (inst) {
                if (inst.service === opts.serviceName) {
                    currImgUuids[inst.image] = true;
                }
            });
            currImgUuids = Object.keys(currImgUuids);

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
            var filter = {
                name: self.config.imgNameFromSvcName[opts.serviceName],
                version: '~master'  // for now just master builds
                // TODO want server-side "published_at >= ..."
            };

            self.updates.listImages(filter, function (uErr, allImgs) {
                if (uErr) {
                    return next(uErr);
                }
                imgs = allImgs;

                common.sortArrayOfObjects(currImgs, ['published_at']);

                // Filter on published_at >= oldest current image.
                // TODO: Remove this when have server-side filtering for this.
                if (currImgs.length) {
                    var cutoff = currImgs[currImgs.length - 1].published_at;
                    imgs = imgs.filter(function (img) {
                        return img.published_at >= cutoff;
                    });
                }

                // Exclude the oldest curr image (i.e. this is how we allow
                // equality on `>=published_at` but still avoid no-op "updates"
                // to the same image.
                if (currImgs) {
                    var excludeUuid = currImgs[currImgs.length - 1].uuid;
                    imgs = imgs.filter(function (img) {
                        return img.uuid !== excludeUuid;
                    });
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
    assert.func(opts.logCb, 'opts.logCb');
    assert.func(cb, 'cb');
    var self = this;
    var log = self.log;

    var acquireLogTimeout = setTimeout(function () {
        opts.logCb('Waiting for sdcadm lock');
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
 *      - logCb {Function} Optional. A function that is called
 *        with progress messages. Called as `logCb(<string>)`. E.g. passing
 *        console.log is legal.
 *      - forceRabbitmq {Boolean} Optional. Allow rabbitmq to be updated, as it
 *        will not be by default
 *      - justImages {Boolean} Optional. Generate a plan that just imports
 *        the images. Default false.
 * @param cb {Function} Callback of the form `function (err, plan)`.
 */
SdcAdm.prototype.genUpdatePlan = function genUpdatePlan(options, cb) {
    assert.object(options, 'options');
    assert.arrayOfObject(options.changes, 'options.changes');
    assert.optionalFunc(options.logCb, 'options.logCb');
    assert.optionalBool(options.justImages, 'options.justImages');
    assert.optionalBool(options.forceRabbitmq, 'options.forceRabbitmq');
    assert.func(cb, 'cb');
    var self = this;
    var log = self.log;
    var logCb = options.logCb || function () {};
    var justImages = Boolean(options.justImages);

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
                    if (change.type && change.type !== 'update-instance') {
                        errs.push(new errors.ValidationError(
                            'invalid type "update-instance" change in ' +
                            repr));
                    } else {
                        change.type = 'update-instance';
                    }
                    validateString(change.instance, '"instance" in ' + repr);
                    validateKeys(['type', 'instance', 'image'], change, repr);
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
                    validateKeys(['type', 'service', 'image'], change, repr);
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
            self.cnapi.listServers(function (err, servers_) {
                servers = servers_;
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
                svcs = svcs_;
                svcFromName = {};
                for (var i = 0; i < svcs.length; i++) {
                    svcFromName[svcs[i].name] = svcs[i];
                }
                next(err);
            });
        },

        function getInsts(_, next) {
            self.getInstances({}, function (err, insts_) {
                insts = insts_;
                next(err);
            });
        },

        function resolveChanges(_, next) {
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
                        p('TODO instance (what is service?):', ch.instance, ch);
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

                    // Get info on the image, if specified, else all candidate
                    // images.
                    if (ch.image) {
                        self.getImage({uuid: ch.image}, function (iErr, img) {
                            if (iErr) {
                                return nextChange(new errors.UpdateError(
                                    iErr,
                                    format('unknown image "%s" from %s',
                                        ch.image, changeRepr)));
                            }
                            ch.image = img;
                            nextChange();
                        });
                    } else {
                        logCb(format('Finding candidate update images '
                            + 'for the "%s" service.', ch.service.name));
                        self.getCandidateImages({
                            serviceName: ch.service.name,
                            insts: insts
                        }, function (iErr, imgs) {
                            if (iErr) {
                                return nextChange(new errors.InternalError({
                                    cause: iErr,
                                    message: 'error finding candidate '
                                        + 'images for ' + changeRepr
                                }));
                            }
                            ch.images = imgs;
                            nextChange();
                        });
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
                typeTarg = ch.type.split('-')[1];
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
                    var inst = ch.instance.instance;
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
                typeTarg = ch.type.split('-')[1];
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
                    ch.type === 'update-instance') {
                    if (ch.image) {
                        var currImgUuids = {};
                        insts.forEach(function (inst) {
                            if (inst.service === ch.service.name) {
                                currImgUuids[inst.image] = true;
                            }
                        });
                        currImgUuids = Object.keys(currImgUuids);
                        if (currImgUuids.length === 1 &&
                            currImgUuids[0] === ch.image.uuid) {
                            // Update to the same image as currently in use
                            // was request.
                            log.debug({change: ch, currImgUuids: currImgUuids},
                                'dropNoop: same image as all insts');
                            return false;
                        }
                    } else if (!ch.images || ch.images.length === 0) {
                        // No available update candidates were found.
                        log.debug({change: ch},
                            'dropNoop: no update candidates');
                        return false;
                    }
                }
                return true;
            });
            next();
        },

        function resolveDeps(_, next) {
            // We don't do deps yet, so just pick the latest avail img.
            // TODO: deps
            log.debug({changes: changes}, 'resolveDeps start');
            for (var i = 0; i < changes.length; i++) {
                var ch = changes[i];
                if (!ch.image && ch.images.length) {
                    assert.arrayOfObject(ch.images,
                        'changes['+i+'].images');
                    ch.images.sort(function (a, b) {
                        return common.cmp(a.published_at, b.published_at);
                    });
                    ch.image = ch.images[ch.images.length - 1];
                }
                delete ch.images;
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
                             stance: ch.instance && ch.instance.instance
                        });
                        return next(new errors.UpdateError(format(
                            'rabbitmq updates are locked: %s ' +
                            '(use --force-rabbitmq flag)', changeRepr)));
                }
            }
            next();
        },

        // TODO: collect all violations and report them all at once
        function ensureVmMinPlatform(_, next) {
            var ch, server;
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
                                return next(new errors.UpdateError(format(
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
            next();
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
                log: log
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
    assert.optionalFunc(options.logCb, 'options.logCb');

    var summary = options.plan.procs.map(
            function (proc) { return proc.summarize(); }).join('\n');
    options.logCb(common.indent(summary));
};



/**
 * Execute an update plan.
 * The caller should be holding a `<SdcAdm>.acquireLock()`.
 *
 * @param options {Object}  Required.
 *      - plan {Object} Required. The update plan as returned by
 *        `genUpdatePlan`.
 *      - logCb {Function} Optional. A function that is called
 *        with progress messages. Called as `logCb(<string>)`. E.g. passing
 *        console.log is legal.
 *      - dryRun {Boolean} Optional. Default false.
 * @param cb {Function} Callback of the form `function (err)`.
 */
SdcAdm.prototype.execUpdatePlan = function execUpdatePlan(options, cb) {
    assert.object(options, 'options');
    assert.object(options.plan, 'options.plan');
    assert.optionalFunc(options.logCb, 'options.logCb');
    assert.optionalBool(options.dryRun, 'options.dryRun');
    assert.func(cb, 'cb');
    var self = this;
    var log = self.log;
    var logCb = options.logCb || function () {};
    var plan = options.plan;

    var start = new Date();
    var wrkDir;

    vasync.pipeline({funcs: [
        function createWrkDir(_, next) {
            var stamp = sprintf('%d%02d%02dT%02d%02d%02dZ',
                start.getUTCFullYear(),
                start.getUTCMonth()+1,
                start.getUTCDate(),
                start.getUTCHours(),
                start.getUTCMinutes(),
                start.getUTCSeconds());
            wrkDir = '/var/sdcadm/updates/' + stamp;
            logCb('Create work dir: ' + wrkDir);
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
                        logCb: logCb,
                        log: log,
                        wrkDir: wrkDir
                    }, nextProc);
                }
            }, next);
        }

    ]}, cb);
};


/**
 * Update to the latest available sdcadm package.
 *
 * TODO:
 * - support passing in a package UUID to which to update
 *
 * @param options {Object}  Required.
 *      - allowMajorUpdate {Boolean} Optional. Default false. By default
 *        self-update will only consider versions of the same major version.
 *      - dryRun {Boolean} Optional. Default false. Go through the motions
 *        without actually updating.
 *      - logCb {Function} Optional. A function that is called
 *        with progress messages. Called as `logCb(<string>)`. E.g. passing
 *        console.log is legal.
 * @param cb {Function} Callback of the form `function (err)`.
 */
SdcAdm.prototype.selfUpdate = function selfUpdate(options, cb) {
    assert.object(options, 'options');
    assert.optionalBool(options.allowMajorUpdate, 'options.allowMajorUpdate');
    assert.optionalBool(options.dryRun, 'options.dryRun');
    assert.optionalFunc(options.logCb, 'options.logCb');
    assert.func(cb, 'cb');
    var self = this;
    var log = self.log;
    var logCb = options.logCb || function () {};

    var unlock;
    var dryRunPrefix = (options.dryRun ? '[dry-run] ' : '');
    var currVer = pkg.version;
    var currBuildtime;
    var updateManifest;
    var installerPath;
    var start;
    var wrkDir;
    vasync.pipeline({funcs: [
        function getLock(_, next) {
            if (options.dryRun) {
                return next();
            }
            self.acquireLock({logCb: logCb}, function (lockErr, unlock_) {
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
            // SDC buildstamps are '$branch-$buildtime-g$sha'. The '$branch'
            // can have hyphens in it.
            var buildstampPath = path.resolve(__dirname, '..', 'etc',
                'buildstamp');
            fs.readFile(buildstampPath, 'utf8', function (err, data) {
                if (err) {
                    next(new errors.InternalError({
                        message: 'error getting current buildstamp',
                        path: buildstampPath,
                        cause: err
                    }));
                    return;
                }
                var parts = data.trim().split(/-/g);
                currBuildtime = parts[parts.length - 2];
                next();
            });
        },

        function findLatestSdcAdm(_, next) {
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
                        logCb(format('Skipping available major sdcadm '
                            + 'update, version %s (use --allow-major-update '
                            + 'to allow)',
                            droppedVers[droppedVers.length - 1]));
                    }
                }

                // Filter out buildstamps <= the current (to exclude
                // earlier builds at the same `version`).
                candidates = candidates.filter(function dropLowerStamp(c) {
                    var buildtime = c.tags.buildstamp.split(/-/g)
                            .slice(-2, -1)[0];
                    if (buildtime <= currBuildtime) {
                        log.trace({candidate: c, buildtime: buildtime},
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
                        } else if (a.tags.buildstamp > b.tags.buildstamp) {
                            return 1;
                        } else if (a.tags.buildstamp < b.tags.buildstamp) {
                            return -1;
                        } else {
                            return 0;
                        }
                    });
                    updateManifest = candidates[candidates.length - 1];
                    logCb(format('%sUpdate to sdcadm %s (%s)', dryRunPrefix,
                        updateManifest.version,
                        updateManifest.tags.buildstamp));
                } else {
                    logCb(format('No available sdcadm updates in %s',
                        self.config.updatesServerUrl));
                }
                next();
            });
        },

        function downloadInstaller(_, next) {
            if (!updateManifest) {
                return next();
            }

            logCb(format('%sDownload update from %s', dryRunPrefix,
                self.config.updatesServerUrl));
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
            logCb(format('%sRun sdcadm installer (log at %s/install.log)',
                dryRunPrefix, wrkDir));
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
            function noteCompletion(_, next) {
                if (!updateManifest || err) {
                    return next();
                }
                logCb(format('%sUpdated to sdcadm %s (%s, elapsed %ss)',
                    dryRunPrefix, updateManifest.version,
                    updateManifest.tags.buildstamp,
                    Math.floor((Date.now() - start) / 1000)));
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



/**
 * Enter maintenance mode.
 *
 * @param opts {Object}  Required.
 *      - logCb {Function} Optional. A function that is called
 *        with progress messages. Called as `logCb(<string>)`. E.g. passing
 *        console.log is legal.
 * @param cb {Function} Callback of the form `function (err)`.
 */
SdcAdm.prototype.dcMaintStart = function dcMaintStart(opts, cb) {
    assert.object(opts, 'opts');
    assert.optionalFunc(opts.logCb, 'opts.logCb');
    assert.func(cb, 'cb');
    var self = this;
    var log = self.log;
    var logCb = opts.logCb || function () {};

    var sdcApp;
    var cloudapiSvc;
    var doIt = false;
    var startTime;
    var dcMaintInfoPath = '/var/sdcadm/dc-maint.json';

    vasync.pipeline({funcs: [
        function getSdcApp(_, next) {
            self.sapi.listApplications({name: 'sdc'}, function (appErr, apps) {
                if (appErr) {
                    return next(new errors.SDCClientError(appErr, 'sapi'));
                } else if (!apps || apps.length !== 1) {
                    return next(new errors.InternalError({
                        message: format(
                            'unexpected number of "sdc" SAPI apps: %j', apps)
                    }));
                }
                sdcApp = apps[0];
                next();
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
                } else if (!svcs || svcs.length !== 1) {
                    return next(new errors.InternalError({
                        message: format('unexpected number of "cloudapi" ' +
                            'SAPI svcs: %j', svcs)
                    }));
                }
                cloudapiSvc = svcs[0];
                next();
            });
        },
        function checkIfInMaint(_, next) {
            if (cloudapiSvc.metadata.CLOUDAPI_READONLY === true) {
                logCb('Already in DC maint.');
            } else {
                doIt = true;
            }
            next();
        },

        function setCloudapiReadonly(_, next) {
            if (!doIt) {
                return next();
            }
            logCb('Putting cloudapi in read-only mode');
            startTime = new Date();
            self.sapi.updateService(
                cloudapiSvc.uuid,
                {metadata: {CLOUDAPI_READONLY: true}},
                function (err, svc) {
                    if (err) {
                        return next(new errors.SDCClientError(err, 'sapi'));
                    }
                    next();
                });
        },

        /**
         * Note: We aren't waiting for config-agent in the cloudapi instance(s)
         * to effect this change. TODO: add readonly status to /--ping on
         * cloudapi and watch for that.
         */

        function saveStartTime(_, next) {
            if (!doIt) {
                return next();
            }
            var info = JSON.stringify({
                'startTime': startTime
            }, null, 4);;
            fs.writeFile(dcMaintInfoPath, info, 'utf8', next);
        },

        function waitForWorkflowDrain(_, next) {
            logCb('Waiting up to 5 minutes for workflow jobs to drain');
            var remaining = 60;
            var MAX_ERRS = 3;
            var numErrs = 0;
            setTimeout(pollJobs, 5000);

            function pollJobs() {
                remaining--;
                if (remaining <= 0) {
                    return next(new errors.SdcAdmError({
                        message: 'timeout waiting for workflow jobs to drain'
                    }));
                }
                self.wfapi.listJobs({execution: 'running', limit: 10}, function (rErr, rJobs) {
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
                    self.wfapi.listJobs({execution: 'queued', limit: 10}, function (qErr, qJobs) {
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
                        logCb('Workflow cleared of running and queued jobs')
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
 *      - logCb {Function} Optional. A function that is called
 *        with progress messages. Called as `logCb(<string>)`. E.g. passing
 *        console.log is legal.
 * @param cb {Function} Callback of the form `function (err)`.
 */
SdcAdm.prototype.dcMaintStop = function dcMaintStop(opts, cb) {
    assert.object(opts, 'opts');
    assert.optionalFunc(opts.logCb, 'opts.logCb');
    assert.func(cb, 'cb');
    var self = this;
    var log = self.log;
    var logCb = opts.logCb || function () {};

    var sdcApp;
    var cloudapiSvc;
    var doIt = false;
    var startTime;
    var dcMaintInfoPath = '/var/sdcadm/dc-maint.json';

/*
 *XXX START HERE
sdc-sapi /services/a3961a6e-478f-4a10-982c-6f90359c05ca -X PUT -d '{"metadata":{"CLOUDAPI_READONLY":false}}'
*/
XXX

    vasync.pipeline({funcs: [
        function getSdcApp(_, next) {
            self.sapi.listApplications({name: 'sdc'}, function (appErr, apps) {
                if (appErr) {
                    return next(new errors.SDCClientError(appErr, 'sapi'));
                } else if (!apps || apps.length !== 1) {
                    return next(new errors.InternalError({
                        message: format(
                            'unexpected number of "sdc" SAPI apps: %j', apps)
                    }));
                }
                sdcApp = apps[0];
                next();
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
                } else if (!svcs || svcs.length !== 1) {
                    return next(new errors.InternalError({
                        message: format('unexpected number of "cloudapi" ' +
                            'SAPI svcs: %j', svcs)
                    }));
                }
                cloudapiSvc = svcs[0];
                next();
            });
        },
        function checkIfInMaint(_, next) {
            if (cloudapiSvc.metadata.CLOUDAPI_READONLY === true) {
                logCb('Already in DC maint.');
            } else {
                doIt = true;
            }
            next();
        },

        function setCloudapiReadonly(_, next) {
            if (!doIt) {
                return next();
            }
            logCb('Putting cloudapi in read-only mode');
            startTime = new Date();
            self.sapi.updateService(
                cloudapiSvc.uuid,
                {metadata: {CLOUDAPI_READONLY: true}},
                function (err, svc) {
                    if (err) {
                        return next(new errors.SDCClientError(err, 'sapi'));
                    }
                    next();
                });
        },

        /**
         * Note: We aren't waiting for config-agent in the cloudapi instance(s)
         * to effect this change. TODO: add readonly status to /--ping on
         * cloudapi and watch for that.
         */

        function saveStartTime(_, next) {
            if (!doIt) {
                return next();
            }
            var info = JSON.stringify({
                'startTime': startTime
            }, null, 4);;
            fs.writeFile(dcMaintInfoPath, info, 'utf8', next);
        },

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
    var sdc;
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
                        'datacenter did not match with datacenter_name for ' +
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

    self.sapi.listApplications({name: 'sdc'}, function (err, res) {
        if (err) {
            return cb(err);
        }
        sdc = (res && res.length > 0 ? res[0].metadata : null);
        if (!sdc) {
            return cb('Cannot find SDC application in SAPI');
        }
        self.sapi.listServices({
            application_uuid: res[0].uuid
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
    });

};

//---- exports

module.exports = SdcAdm;
