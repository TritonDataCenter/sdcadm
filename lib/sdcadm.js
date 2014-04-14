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

var UA = format('%s/%s (node/%s; openssl/%s)', pkg.name, pkg.version,
        process.versions.node, process.versions.openssl);


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

    var userAgent = UA;
    this.__defineGetter__('sapi', function () {
        if (self._sapi === undefined) {
            self._sapi = new sdcClients.SAPI({
                url: self.config.sapi.url,
                agent: false,
                userAgent: userAgent,
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
                userAgent: userAgent,
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
                userAgent: userAgent,
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
                userAgent: userAgent,
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
                userAgent: userAgent,
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
 * Gather a JSON object for each installed SDC component giving its id and
 * version.
 *
 * "Components" include: SDC core zones, agents, platforms.
 *
 * TODO:
 * - gz tools
 * - sdcadm itself
 * - buildstamp field once have more consistent semver versioning
 *
 * All types will have these fields:
 *      component
 *      version
 *      server
 *      hostname
 */
SdcAdm.prototype.gatherComponentVersions = function gatherComponentVersions(
        options, cb) {
    var self = this;
    assert.object(options, 'options');
    assert.func(cb, 'cb');

    var comps = [];
    var serversFromUuid = {};
    vasync.parallel({funcs: [
        function getAgentsAndPlatforms(next) {
            var serverOpts = {
                extras: 'sysinfo'
            };
            self.cnapi.listServers(serverOpts, function (serversErr, servers) {
                if (serversErr) {
                    return next(serversErr);
                }
                servers.forEach(function (server) {
                    serversFromUuid[server.uuid] = server;

                    var sdcVersion = server.sysinfo['SDC Version'] || '6.5';
                    comps.push({
                        type: 'platform',
                        component: format('%s:platform', server.hostname),
                        version: format('%s:%s', sdcVersion,
                            server.current_platform),
                        role: 'platform',
                        sdc_version: sdcVersion,
                        platform: server.current_platform,
                        server: server.uuid,
                        hostname: server.hostname
                    });

                    (server.sysinfo['SDC Agents'] || []).forEach(
                            function (agent) {
                        comps.push({
                            type: 'agent',
                            component: format('%s:%s', server.hostname,
                                agent.name),
                            role: agent.name,
                            version: agent.version,
                            server: server.uuid,
                            hostname: server.hostname
                        })
                    });
                });
                next();
            });
        },
        function getCoreZones(next) {
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
                })
                vasync.forEachParallel({
                    inputs: vms,
                    func: function addOneCoreZone(vm, nextVm) {
                        self.imgapi.getImage(vm.image_uuid, function (e, img) {
                            if (e) {
                                return nextVm(e);
                            }
                            comps.push({
                                type: 'zone',
                                component: vm.alias,
                                version: img.version,
                                uuid: vm.uuid,
                                role: vm.tags.smartdc_role,
                                image_uuid: vm.image_uuid,
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
        cb(err, comps);
    });
};




/**
 * Upgrade to the latest available sdcadm package.
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
    var logDir;
    vasync.pipeline({funcs: [
        // TODO: move out to `self._vasyncAcquireLock` and `self._vasyncReleaseLock`
        function acquireLock(_, next) {
            if (!updateManifest || options.dryRun) {
                start = new Date();
                return next();
            }
            var acquireLogTimeout = setTimeout(function () {
                logCb(format('Waiting for sdcadm lock', uuid));
            }, 1000);
            log.debug({lockPath: self._lockPath}, 'acquire lock');
            lock(self._lockPath, function (lockErr, unlock_) {
                if (lockErr) {
                    next(new errors.InternalError({
                        message: 'error acquiring lock',
                        lockPath: self._lockPath,
                        cause: lockErr
                    }));
                    return;
                }
                log.debug({lockPath: self._lockPath}, 'acquired lock');
                if (acquireLogTimeout) {
                    clearTimeout(acquireLogTimeout);
                }
                // Set start time after getting lock to avoid collisions in
                // log dir.
                start = new Date();
                unlock = unlock_;
                next();
            });
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
                    return next(new errors.UpdatesServerError(err));
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
                            + 'upgrade, version %s (use --allow-major-update '
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

        function createLogdir(_, next) {
            var stamp = sprintf('%d%02d%02dT%02d%02d%02dZ',
                start.getUTCFullYear(),
                start.getUTCMonth()+1,
                start.getUTCDate(),
                start.getUTCHours(),
                start.getUTCMinutes(),
                start.getUTCSeconds())
            logDir = '/var/sdcadm/self-updates/' + stamp;
            mkdirp(logDir, function (err) {
                if (err) {
                    next(new errors.InternalError({
                        message: 'error creating logdir: ' + logDir,
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
                dryRunPrefix, logDir));
            if (options.dryRun) {
                return next();
            }
            var cmd = format('%s >%s/install.log 2>&1', installerPath,
                logDir);
            var env = common.objCopy(process.env);
            env.TRACE = '1';
            env.SDCADM_LOGDIR = logDir;
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
                if (!unlock) {
                    return next();
                }
                log.debug({lockPath: self._lockPath}, 'releasing lock');
                unlock(function (unlockErr) {
                    if (unlockErr) {
                        next(new errors.InternalError({
                            message: 'error releasing lock',
                            lockPath: self._lockPath,
                            cause: unlockErr
                        }));
                        return;
                    }
                    log.debug({lockPath: self._lockPath}, 'released lock');
                    next();
                });
            },
            function noteCompletion(_, next) {
                if (!updateManifest || err) {
                    return next();
                }
                logCb(format('%sUpgraded to sdcadm %s (%s)',
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
