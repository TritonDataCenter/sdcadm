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

var common = require('./common');
var errors = require('./errors');
var lock = require('./locker').lock;
var pkg = require('../package.json');
var procedures = require('./procedures');

var UA = format('%s/%s (node/%s; openssl/%s)', pkg.name, pkg.version,
        process.versions.node, process.versions.openssl);
var UPDATE_PLAN_FORMAT_VER = 1;


//---- UpdatePlan class
// A light data object with a couple conveninence functions.

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
}



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

    //XXX Still need this?
    // Until we have a smartdc using restify with mcavage/node-restify#498
    // we need client_res and client_req serializers.
    //this.log = options.log.child({
    //    serializers: restify.bunyan.serializers
    //});
    this.log = options.log;

    self._lockPath = '/var/run/sdcadm.lock';

    self.userAgent = UA;
    this.__defineGetter__('sapi', function () {
        if (self._sapi === undefined) {
            self._sapi = new sdcClients.SAPI({
                url: self.config.sapi.url,
                agent: false,
                userAgent: self.userAgent,
                log: self.log
            });
        }
        return self._sapi;
    });
    this.__defineGetter__('cnapi', function () {
        if (self._cnapi === undefined) {
            self._cnapi = new sdcClients.CNAPI({
                url: self.config.cnapi.url,
                agent: false,
                userAgent: self.userAgent,
                log: self.log
            });
        }
        return self._cnapi;
    });
    this.__defineGetter__('vmapi', function () {
        if (self._vmapi === undefined) {
            self._vmapi = new sdcClients.VMAPI({
                url: self.config.vmapi.url,
                agent: false,
                userAgent: self.userAgent,
                log: self.log
            });
        }
        return self._vmapi;
    });
    this.__defineGetter__('imgapi', function () {
        if (self._imgapi === undefined) {
            self._imgapi = new sdcClients.IMGAPI({
                url: self.config.imgapi.url,
                agent: false,
                userAgent: self.userAgent,
                log: self.log
            });
        }
        return self._imgapi;
    });
    this.__defineGetter__('updates', function () {
        if (self._updates === undefined) {
            self._updates = new sdcClients.IMGAPI({
                url: self.config.updatesServerUrl,
                agent: false,
                userAgent: self.userAgent,
                log: self.log
            });
        }
        return self._updates;
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
 * "Services" include: SDC core zones and agents.
 *
 * TODO:
 * - gz tools
 * - sdcadm itself (need to get the manifest file installed for this)
 * - buildstamp field once have more consistent semver versioning
 *
 * All types will have these fields:
 *      type            type of service, e.g. 'zone', 'agent', 'platform'
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

                    // XXX Excluding platforms from SDC "services" for now.
                    //     To be discussed.
                    //var sdcVersion = server.sysinfo['SDC Version'] || '6.5';
                    //var version = format('%s:%s', sdcVersion,
                    //    server.current_platform);
                    //insts.push({
                    //    type: 'platform',
                    //    service: 'platform',
                    //    version: version,
                    //    image: null, // XXX don't yet have platforms in updates.jo
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
                            image: null, // XXX unknown right now
                            server: server.uuid,
                            hostname: server.hostname
                        })
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
                                type: 'zone',
                                alias: vm.alias,
                                version: img.version,
                                instance: vm.uuid,
                                zonename: vm.uuid,
                                service: vm.tags.smartdc_role,
                                image: vm.image_uuid,
                                server: vm.server_uuid,
                                hostname: serversFromUuid[vm.server_uuid].hostname
                            });
                            nextVm();
                        });
                    }
                }, next);
            });
        },
    ]}, function (err) {
        cb(err, insts);
    });
};


/**
 * Gather a JSON object for each installed SDC service.
 *
 * "Services" include: SDC core zones and agents.
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
                app = app_;
                next(appErr); // XXX InternalError
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
                    return next(svcsErr); // XXX InternalError
                }
                svcs = svcs_;
                svcs.forEach(function (svc) {
                    // XXX want SAPI to have this eventually
                    svc.type = 'zone';
                });
                next();
            });
        },
        function getAgents(_, next) {
            // XXX Hardcode "known" agents for now until SAPI handles agents.
            // Excluding "marlin". Should we include hagfish-watcher?
            [
                {
                  "name": "cabase",
                },
                {
                  "name": "hagfish-watcher",
                },
                {
                  "name": "agents_core",
                },
                {
                  "name": "firewaller",
                },
                {
                  "name": "amon-agent",
                },
                {
                  "name": "cainstsvc",
                },
                {
                  "name": "provisioner",
                },
                {
                  "name": "amon-relay",
                },
                {
                  "name": "heartbeater",
                },
                {
                  "name": "smartlogin",
                },
                {
                  "name": "zonetracker",
                }
            ].forEach(function (agent) {
                agent.type = 'agent';
                svcs.push(agent);
            });
            // XXX Do we want "version" from sysinfo? Where to get "image"?
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
    var log = self.log;

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
    var log = self.log;

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
                            nextImg(iErr)
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
                // XXX want server-side "published_at >= XXX"
            };

            self.updates.listImages(filter, function (uErr, allImgs) {
                if (uErr) {
                    return next(uErr);
                }
                imgs = allImgs;

                common.sortArrayOfObjects(currImgs, ['published_at']);

                // XXX filter on published_at >= oldest current image. Remove
                // this when have server-side filtering for this.
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


SdcAdm.prototype._acquireLock = function _acquireLock(opts, cb) {
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

SdcAdm.prototype._releaseLock = function _releaseLock(opts, cb) {
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
            next(new errors.InternalError({
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
 * 3. zone delete-instance: 'type:delete' and 'instance' (the VM uuid or alias)
 * 4. delete-service: 'type:delete-service' and 'service'
 * 5. zone update-instance: 'instance', optional 'type:update-instance'
 * 6. agent update-instance:
 *          'service' and 'server'
 *    or
 *          'instance'
 *    with optional 'type:update-instance'.
 * 7. update-service: 'service', optional 'type:update-service'.
 *
 * Except 'delete-service', 'image' is optional for all, otherwise the latest
 * available image is implied.
 *
 * @param options {Object}  Required.
 *      - changes {Array} Required. The update spec array of objects.
 *      - logCb {Function} Optional. A function that is called
 *        with progress messages. Called as `logCb(<string>)`. E.g. passing
 *        console.log is legal.
 *      - justImages {Boolean} Optional. Generate a plan that just imports
 *        the images. Default false.
 * @param cb {Function} Callback of the form `function (err, plan)`.
 */
SdcAdm.prototype.genUpdatePlan = function genUpdatePlan(options, cb) {
    assert.object(options, 'options');
    assert.arrayOfObject(options.changes, 'options.changes');
    assert.optionalFunc(options.logCb, 'options.logCb');
    assert.optionalBool(options.justImages, 'options.justImages');
    assert.func(cb, 'cb');
    var self = this;
    var log = self.log;
    var logCb = options.logCb || function () {};
    var justImages = Boolean(options.justImages);

    var changes;
    var unlock;
    var servers;
    var svcs;
    var svcFromName;
    var insts;
    var plan;
    vasync.pipeline({funcs: [
        /**
         * Basic validation of keys of the changes. Validation of values is
         * later after we have the update lock.
         */
        // XXX no asserts, not UsageError, ValidationError instead
        function validateChanges(_, next) {
            var errs = [];
            for (var i = 0; i < options.changes.length; i++) {
                var change = options.changes[i];
                var repr = JSON.stringify(change);
                assert.optionalString(change.image, '"image" in ' + repr);
                if (change.type === 'create') {
                    // 1. create-instance
                    assert.string(change.service, '"service" in ' + repr);
                    assert.string(change.server, '"server" in %s' + repr);
                    validateKeys(['type', 'server', 'service', 'image'],
                        change, repr);
                } else if (change.type === 'delete' && change.service
                        && change.server) {
                    // 2. agent delete-instance
                    assert.string(change.service, '"service" in ' + repr);
                    assert.string(change.server, '"server" in %s' + repr);
                    validateKeys(['type', 'server', 'service', 'image'],
                        change, repr);
                } else if (change.type === 'delete') {
                    // 2. agent delete-instance
                    // 3. zone delete-instance
                    assert.string(change.instance, '"instance" in ' + repr);
                    validateKeys(['type', 'instance', 'image'], change, repr);
                } else if (change.type === 'delete-service') {
                    // 4. delete-service
                    assert.string(change.service, '"service" in ' + repr);
                    validateKeys(['type', 'service'], change, repr);
                } else if (change.service && change.server) {
                    // 6. agent update-instance
                    if (change.type && change.type !== 'update-instance') {
                        errs.push(new errors.UsageError(
                            'invalid type "update-instance" change in ' +
                            repr));
                    } else {
                        change.type = 'update-instance';
                    }
                    assert.string(change.service, '"service" in ' + repr);
                    assert.string(change.server, '"server" in ' + repr);
                    validateKeys(['type', 'service', 'service', 'image'],
                        change, repr);
                } else if (change.instance) {
                    // 5. zone update-instance
                    // 6. agent update-instance
                    if (change.type && change.type !== 'update-instance') {
                        errs.push(new errors.UsageError(
                            'invalid type "update-instance" change in ' +
                            repr));
                    } else {
                        change.type = 'update-instance';
                    }
                    assert.string(change.instance, '"instance" in ' + repr);
                    validateKeys(['type', 'instance', 'image'], change, repr);
                } else if (change.service) {
                    // 7. update-service
                    if (change.type && change.type !== 'update-service') {
                        errs.push(new errors.UsageError(
                            'invalid type "update-service" change in ' +
                            repr));
                    } else {
                        change.type = 'update-service';
                    }
                    assert.string(change.service, '"service" in ' + repr);
                    validateKeys(['type', 'service', 'image'], change, repr);
                } else {
                    errs.push(new errors.UsageError('invalid change: ' + repr));
                }
            }
            if (errs.length === 1) {
                next(errs[0]);
            } else if (errs.length > 1) {
                next(new errors.MultiError(errs));
            } else {
                next();
            }

            function validateKeys(allowed, change, repr) {
                var extraKeys = Object.keys(change).filter(function (k) {
                    return !~allowed.indexOf(k);
                });
                if (extraKeys.length) {
                    errs.push(new errors.UsageError(format(
                        'invalid extra fields "%s" in %s',
                        extraKeys.join('", "'), repr)));
                }
            }
        },

        function acquireLock(_, next) {
            self._acquireLock({logCb: logCb}, function (lockErr, unlock_) {
                unlock = unlock_;
                next(lockErr);
            });
        },

        function getServers(_, next) {
            self.cnapi.listServers(function (err, servers_) {
                servers = servers_;
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
            changes = common.deepObjCopy(options.changes);
            vasync.forEachParallel({inputs: changes, func:
                function resolveChange(ch, nextChange) {
                    var changeRepr = JSON.stringify(ch);
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
                        var found = false;
                        for (var i = 0; i < insts.length; i++) {
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
                        var found = false;
                        for (var i = 0; i < insts.length; i++) {
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
                        p('XXX instance (what is service?):', ch.instance);
                        ch.server = XXX;
                    }
                    if (ch.server) {
                        var found = false;
                        for (var i = 0; i < servers.length; i++) {
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
                            // Update to the same image as currently in used
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
                // XXX other change types
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

        /**
         * XXX trim no-ops and downgrades: handle in `determineProcedures`.
         *      TODO: First pass drop no-ops without force.
         *
         * Want the confirmation to break out instances meaningfully.
         * Examples:

This update will make the following changes:
    download 1 image (69 MiB):
        image 6261c204-e75d-11e3-91fa-a311fd4ab601 (ca@master-20140529T180636Z-gf4e65ef)
    update "ca" service (1 instance) to image 6261c204-e75d-11e3-91fa-a311fd4ab601 (ca@master-20140529T180636Z-gf4e65ef)

    update "ca" service (2 instances) to image 6261c204-e75d-11e3-91fa-a311fd4ab601 (ca@master-20140529T180636Z-gf4e65ef)

    update "vm-agent" service (300 instances) to image 6261c204-e75d-11e3-91fa-a311fd4ab601 (vm-agent@1.2.3):
        289 instances will be updated from image $oldImageUuid1
        1 instance will be updated from image $oldImageUuid2
        10 instances already at image $imageUuid

    update "vm-agent" service (300 instances) to image 6261c204-e75d-11e3-91fa-a311fd4ab601 (vm-agent@1.2.3):
        300 instances forced downgrade from image $oldImageUuid1

         *
         * XXX
         * What does that break-out example look like in code path? That
         * needs to be in the result of 'determineProcedures'. A -F will
         * translate to a `'allowNoopOrDowngrade':true` or similar, which
         * 'determineProcedures' will handle.
         */
        function determineProcedures(_, next) {
            procedures.coordinatePlan({
                plan: plan,
                sdcadm: self,
                log: log
            }, function (err, procs_) {
                plan.procs = procs_;
                next(err);
            });
        }

    ]}, function finishUp(err) {
        vasync.pipeline({funcs: [
            function releaseLock(_, next) {
                if (!unlock) {
                    return next();
                }
                self._releaseLock({unlock: unlock}, next);
            }
        ]}, function done(finishUpErr) {
            // We shouldn't ever get a `finishUpErr`. Let's be loud if we do.
            if (finishUpErr) {
                log.fatal({err: finishUpErr},
                    'unexpected error finishing up genUpdatePlan');
            }
            if (err || finishUpErr) {
                cb(err || finishUpErr);
            } else {
                cb(null, plan);
            }
        });
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

    var changes = plan.changes; // For now assume have `plan.changes`
    var unlock;
    var start;
    var wrkDir;

    vasync.pipeline({funcs: [
        function acquireLock(_, next) {
            self._acquireLock({logCb: logCb}, function (lockErr, unlock_) {
                unlock = unlock_;
                next(lockErr);
            });
        },

        function setStart(_, next) {
            // Set start time after getting lock to avoid collisions in log dir.
            start = new Date();
            next();
        },

        function createWrkDir(_, next) {
            var stamp = sprintf('%d%02d%02dT%02d%02d%02dZ',
                start.getUTCFullYear(),
                start.getUTCMonth()+1,
                start.getUTCDate(),
                start.getUTCHours(),
                start.getUTCMinutes(),
                start.getUTCSeconds())
            wrkDir = '/var/sdcadm/updates/' + stamp;
            logCb('Create work dir: ' + wrkDir)
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
                        log: log
                    }, nextProc);
                }
            }, next);
        },

    ]}, function finishUp(err) {
        vasync.pipeline({funcs: [
            function releaseLock(_, next) {
                self._releaseLock({unlock: unlock}, next);
            }
        ]}, function done(finishUpErr) {
            // We shouldn't ever get a `finishUpErr`. Let's be loud if we do.
            if (finishUpErr) {
                log.fatal({err: finishUpErr},
                    'unexpected error finishing up execUpdatePlan');
            }
            cb(err || finishUpErr, plan);
        });
    });
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
    var currBuildstamp;
    var updateManifest;
    var installerPath;
    var start;
    var wrkDir;
    vasync.pipeline({funcs: [
        function acquireLock(_, next) {
            if (options.dryRun) {
                start = new Date();
                return next();
            }
            self._acquireLock({logCb: logCb}, function (lockErr, unlock_) {
                unlock = unlock_;
                next(lockErr);
            });
        },
        function setStart(_, next) {
            // Set start time after getting lock to avoid collisions in log dir.
            start = new Date();
            next();
        },

        function getCurrBuildstamp(_, next) {
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
                currBuildstamp = data.trim();
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
                            //log.trace({candidate: c, currMajor: currMajor},
                            //    'drop sdcadm candidate (major update)');
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
                    if (c.tags.buildstamp <= currBuildstamp) {
                        //log.trace({candidate: c},
                        //    'drop sdcadm candidate (<= buildstamp)');
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
                    logCb('%sUpdate to sdcadm %s (%s)', dryRunPrefix,
                        updateManifest.version, updateManifest.tags.buildstamp);
                } else {
                    logCb('No available sdcadm updates in %s',
                        self.config.updatesServerUrl);
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
            var stamp = sprintf('%d%02d%02dT%02d%02d%02dZ',
                start.getUTCFullYear(),
                start.getUTCMonth()+1,
                start.getUTCDate(),
                start.getUTCHours(),
                start.getUTCMinutes(),
                start.getUTCSeconds())
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
            function releaseLock(_, next) {
                self._releaseLock({unlock: unlock}, next);
            },
            function noteCompletion(_, next) {
                if (!updateManifest || err) {
                    return next();
                }
                logCb(format('%sUpdated to sdcadm %s (%s)',
                    dryRunPrefix, updateManifest.version,
                    updateManifest.tags.buildstamp));
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


//---- exports

module.exports = SdcAdm;
