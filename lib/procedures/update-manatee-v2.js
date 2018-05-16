/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018 Joyent, Inc.
 */


var assert = require('assert-plus');
var sprintf = require('extsprintf').sprintf;
var util = require('util'),
    format = util.format;
var os = require('os');
var vasync = require('vasync');

var errors = require('../errors');
var common = require('../common');
var svcadm = require('../svcadm');
var steps = require('../steps');

var Procedure = require('./procedure').Procedure;
var s = require('./shared');

/**
 * Update manatee service.
 *
 * HA is assumed and, when not present, a temporary manateeXtmp instance will
 * be created (and destroyed once update is finished).
 *
 * Note that update/rollback to any version previous to '20141204T233537Z'
 * is not supported
 */

function UpdateManateeV2(options) {
    assert.arrayOfObject(options.changes, 'options.changes');
    this.changes = options.changes;
}
util.inherits(UpdateManateeV2, Procedure);

// Version since we moved from manatee-1.0 to manatee-2.0 and modified
// leader election (timestamp set for moray):
UpdateManateeV2.V2_TIMESTAMP = '20141204T233537Z';
// Minimal manatee version (from here, we're updating to 2.0, including
// MANATEE-247 fixes for ONWM):
UpdateManateeV2.MIN_V2_TIMESTAMP = '20150109T184454Z';
// From here, we can avoid nonsensical SAPI dance due to SAPI-224:
UpdateManateeV2.SAPI_224_MIN_TS = '20150127T004028Z';
// From this version we have new manatee-adm subcommands:
UpdateManateeV2.MIN_PG_STATUS_VERSION = '20150320T174220Z';

UpdateManateeV2.prototype.summarize = function manateev2Summarize() {
    var word = (this.changes[0].type === 'rollback-service') ?
        'rollback' : 'update';
    var c0 = this.changes[0];
    var img = c0.image;
    var out = [sprintf('%s "%s" service to image %s', word,
                    c0.service.name, img.uuid),
                common.indent(sprintf('(%s@%s)', img.name, img.version))];
    if (c0.insts) {
        out[0] += ':';
        out = out.concat(c0.insts.map(function (inst) {
            return common.indent(sprintf('instance "%s" (%s) in server %s',
                inst.zonename, inst.alias, inst.server));
        }));
    }
    return out.join('\n');
};


UpdateManateeV2.prototype.execute = function manateev2Execute(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.plan, 'opts.plan');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.progress, 'opts.progress');
    assert.string(opts.wrkDir, 'opts.wrkDir');
    assert.func(cb, 'cb');
    var self = this;
    var log = opts.log;
    var progress = opts.progress;
    var sdcadm = opts.sdcadm;
    var rollback = opts.plan.rollback || false;

    // We need this to retrieve shard info using local manatee instance:
    function getShardStateLocally(manateeUUID, hasManatee21, callback) {
        var argv = [
            '/usr/sbin/zlogin',
            manateeUUID,
            'source ~/.bashrc; ' +
                '/opt/smartdc/manatee/node_modules/.bin/manatee-adm ' +
                (hasManatee21 ? 'zk-state' : 'state')
        ];

        common.execFilePlus({
            argv: argv,
            log: log
        }, function (err, stdout, stderr) {
            if (err) {
                callback(err);
                return;
            }
            // REVIEW: Shall we try/catch here?
            var manateeShard = JSON.parse(stdout);
            callback(null, manateeShard);
        });
    }

    function getCanmount(server, zone, callback) {
        log.trace({
            server: server,
            zone: zone
        }, 'Getting canmount value (sdc-oneachnode)');

        var argv = [
            '/opt/smartdc/bin/sdc-oneachnode',
            '-j',
            '-n',
            server,
            format('/usr/sbin/zfs get -H -o value canmount ' +
                'zones/%s/data/manatee', zone)
        ];

        common.execFilePlus({
            argv: argv,
            log: log
        }, function (err, stdout, stderr) {
            log.trace({
                cmd: argv.join(' '),
                err: err,
                stdout: stdout,
                stderr: stderr
            }, 'ran zfs get canmount command');

            if (err) {
                callback(new errors.InternalError({
                    message: 'error running zfs get canmount',
                    cmd: argv.join(' '),
                    stdout: stdout,
                    stderr: stderr,
                    cause: err
                }));
                return;
            }

            var res = JSON.parse(stdout.trim());
            callback(null, res[0].result.stdout.trim());
        });
    }

    function setCanmountNoauto(server, zone, callback) {
        log.trace({
            server: server,
            zone: zone
        }, 'Setting canmount=noauto (sdc-oneachnode)');

        var argv = [
            '/opt/smartdc/bin/sdc-oneachnode',
            '-n',
            server,
            /* JSSTYLED */
            format('/usr/sbin/zfs set canmount=noauto ' +
                'zones/%s/data/manatee', zone)
        ];
        common.execFilePlus({
            argv: argv,
            log: log
        }, function (err, stdout, stderr) {
            log.trace({
                cmd: argv.join(' '),
                err: err,
                stdout: stdout,
                stderr: stderr
            }, 'ran zfs set canmount=noauto command');

            if (err) {
                callback(new errors.InternalError({
                    message: 'error running zfs set canmount=noauto',
                    cmd: argv.join(' '),
                    stdout: stdout,
                    stderr: stderr,
                    cause: err
                }));
                return;
            }
            callback();
        });
    }


    function updateManatee(change, nextSvc) {
        var arg = {
            change: change,
            opts: opts,
            userScript: false,
            HA: false,
            shard: {
            },
            // In case of failure, prevent update procedure to re-run updates
            // of instances already updated on the previous attempt:
            async_updated: false,
            sync_updated: false,
            primary_updated: false
        };
        var manateeUUID;
        var sapiUUID;
        var morayVms;
        var wfVms;
        var version;
        var pastSAPI224 = false;

        // TOOLS-975: As a workaround for any manatee instance affected by
        // MANATEE-280, we'll make sure and eventually re-freeze the shard
        // if necessary:
        var isFrozen = false;

        // Check if can use new pg-status subcommand instead of deprecated
        // manatee-adm status:
        var hasPgStatus = false;


        if (change.insts && change.insts.length > 1) {
            arg.HA = true;
        }

        // Wait for manatee given state. If any of the members is "deposed",
        // it will return immediately, since there will be no update:
        function waitForManatee(
                role, state, server, zone, hasManatee21, callback
        ) {
            s.waitForManatee({
                log: log,
                server: server,
                manateeUUID: zone,
                state: state,
                role: role,
                hasManatee21: hasManatee21
            }, callback);
        }

        // We need to make sure that we have moray updated to a 2.0
        // compatible version:
        function verifyMorayVersion(_, next) {
            sdcadm.sapi.listServices({
                name: 'moray',
                application_uuid: change.service.application_uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    next(svcErr);
                    return;
                }
                if (!svcs.length) {
                    next(new errors.SDCClientError(new Error(
                        'No services named "moray"'), 'sapi'));
                    return;
                }
                var moraySvc = svcs[0];
                var imgUUID = moraySvc.params.image_uuid;
                sdcadm.imgapi.getImage(imgUUID, function (err, img_) {
                    if (err) {
                        next(err);
                        return;
                    }
                    var parts = img_.version.split('-');
                    var curVer = parts[parts.length - 2];
                    if (curVer < UpdateManateeV2.V2_TIMESTAMP) {
                        var msg =
                            'Cannot update manateee until moray is updated ' +
                            'to a version built after ' +
                            UpdateManateeV2.V2_TIMESTAMP + ' (current ' +
                            'version was built ' + curVer + ')';
                        progress(msg);
                        next(new errors.ValidationError(new Error(msg),
                            'sdcadm'));
                        return;
                    }
                    next();
                });
            });
        }

        function disallowv1tov2Updates(_, next) {
            var imgUUID = (arg.HA) ? arg.change.insts[0].image :
                arg.change.inst.image;
            sdcadm.imgapi.getImage(imgUUID, function (err, img_) {
                if (err) {
                    next(err);
                    return;
                }
                var parts = img_.version.split('-');
                var curVer = parts[parts.length - 2];
                if (curVer < UpdateManateeV2.MIN_V2_TIMESTAMP) {
                    var msg =
                        'Cannot update manateee from any version built ' +
                        'before' + UpdateManateeV2.MIN_V2_TIMESTAMP +
                        ' (current version was built ' + curVer + ')';
                    progress(msg);
                    next(new errors.ValidationError(new Error(msg),
                        'sdcadm'));
                    return;
                }
                next();
            });
        }

        // We also need to make sure that we are upgrading to manatee v2.0,
        // updates to v1.0 are not supported by this tool:
        function verifyManateeVersion(_, next) {
            progress('Verifying manatee target version');
            var parts = arg.change.image.version.split('-');
            var curVer = parts[parts.length - 2];
            if (curVer < UpdateManateeV2.MIN_V2_TIMESTAMP) {
                var msg =
                    'Cannot update manateee ' +
                    'to a version built before than ' +
                    UpdateManateeV2.MIN_V2_TIMESTAMP + ' (current ' +
                    'version was built ' + curVer + ')';
                progress(msg);
                next(new errors.ValidationError(new Error(msg),
                    'sdcadm'));
                return;
            }
            if (curVer >= UpdateManateeV2.SAPI_224_MIN_TS) {
                pastSAPI224 = true;
                progress('Target version is new enough to avoid ' +
                    'setting SAPI back to proto mode');
            }
            next();
        }

        function checkCurrentManateeVersion(_, next) {
            progress('Verifying manatee current version');
            var imgUUID = arg.HA ?
                arg.change.insts[0].image : arg.change.inst.image;
            sdcadm.imgapi.getImage(imgUUID, function (err, img_) {
                if (err) {
                    next(err);
                    return;
                }
                var parts = img_.version.split('-');
                var curVer = parts[parts.length - 2];
                if (curVer >= UpdateManateeV2.MIN_PG_STATUS_VERSION) {
                    hasPgStatus = true;
                    progress('manatee-adm version is >= 2.1.0.' +
                            ' Using new commands');
                }
                next();
            });
        }

        function freeze(_, next) {
            if (!arg.HA || version === '1.0.0' || isFrozen) {
                next();
                return;
            }
            progress('Freezing cluster state');
            common.manateeFreeze({
                server: arg.shard.async.server_uuid,
                vm: arg.shard.async.zoneId,
                reason: 'sdcadm ' + opts.wrkDir,
                log: log
            }, function (err) {
                if (err) {
                    next(err);
                    return;
                }
                isFrozen = true;
                next();
            });
        }

        if (opts.plan.changes.length > 1) {
            progress('');
            progress('--- Updating %s ...', change.service.name);
        }

        var funcs = [];

        if (rollback) {
            funcs.push(s.getOldUserScript);
        } else {
            funcs.push(s.getUserScript);
            funcs.push(s.writeOldUserScriptForRollback);
        }

        funcs = funcs.concat([
            s.updateSvcUserScript,
            verifyMorayVersion,
            disallowv1tov2Updates,
            verifyManateeVersion,
            checkCurrentManateeVersion
        ]);

        if (!arg.HA) {
            funcs.push(s.updateVmUserScript);
        } else {
            change.insts.forEach(function (i) {
                funcs.push(function updateInstUserScript(_, next) {
                    s.updateVmUserScriptRemote({
                        service: change.service,
                        progress: progress,
                        zonename: i.zonename,
                        log: opts.log,
                        server: i.server,
                        userScript: arg.userScript
                    }, next);
                });
            });
        }

        vasync.pipeline({funcs: funcs.concat([

            /*
             * We cannot generally proceed successfully through this
             * update process if Ur is not available at all, so ensure
             * we have a connection now.
             */
            function getUrConnection(ctx, next) {
                sdcadm.getUrConnection(function (err, urconn) {
                    if (err) {
                        next(new errors.InternalError({
                            cause: err,
                            message: 'ur failure'
                        }));
                        return;
                    }
                    assert.object(urconn);
                    ctx.urconn = urconn;
                    next();
                });
            },

            s.updateSapiSvc,

            /*
             * Ensure that the Manatee SAPI service, and each Manatee VM, have
             * been increased to an appropriate minimum size before updating.
             */
            function updateManateeSizeParameters(_, next) {
                steps.updateSizeParameters({
                    progress: progress,
                    service: change.service,
                    log: log,
                    sdcadm: sdcadm,
                    params: sdcadm.config.updatedSizeParameters.manatee
                }, next);
            },

            function getLocalManatee(_, next) {
                progress('get local manatee');
                if (!arg.HA) {
                    manateeUUID = change.inst.zonename;
                } else {
                    var hostname = os.hostname();
                    manateeUUID = change.insts.filter(function (x) {
                        return (x.hostname === hostname);
                    })[0].zonename;
                }
                log.debug('Local manatee instance found: %s', manateeUUID);
                next();
            },


            // TOOLS-1025: Using `manatee-adm status` is deprecated since
            // MANATEE-266. When possible (hasPgStatus == true) we should
            // use the new commands instead.
            function getShard(_, next) {
                progress('Getting shard state from local manatee');
                getShardStateLocally(manateeUUID, hasPgStatus,
                        function (err, st) {
                    if (err) {
                        next(err);
                        return;
                    }
                    Object.keys(st).forEach(function (m) {
                        if (['primary', 'sync', 'async'].indexOf(m) !== -1) {
                            arg.shard[m] = st[m];
                        }
                    });
                    if (st.deposed && st.deposed.length) {
                        var msg = 'manatee instance ' +
                            st.deposed[0].zoneId + ' is on deposed state. ' +
                            'Please log into this VM an run:\n\t ' +
                            '`manatee-adm rebuild`\n before attempting the ' +
                            'update again.';
                        progress(msg);
                        next(new errors.UpdateError(new Error(msg),
                                    'manatee-adm'));
                        return;
                    }
                    // Refuse to update HA setup w/o all the shard members.
                    // Instead, suggest to complete HA setup
                    if (arg.HA && (!arg.shard.async || !arg.shard.sync)) {
                        var msg2 = 'Cannot find sync and/or async peers. ' +
                            'Please complete the HA setup by running:\n\t' +
                            'sdcadm post-setup ha-manatee\n before ' +
                            'attempting the update again.';
                        progress(msg2);
                        next(new errors.UpdateError(new Error(msg2),
                                    'sdcadm'));
                        return;

                    }
                    // For now can handle only a single 'async' manatee
                    if (arg.shard.async && arg.shard.async.length) {
                        arg.shard.async = arg.shard.async[0];
                    }
                    next();
                });
            },

            function getShardServers(_, next) {
                progress('Getting Server Information for manatee VMs');
                if (!arg.HA) {
                    arg.shard.primary.server_uuid = change.inst.server;
                    arg.shard.primary.server_hostname = change.inst.hostname;
                    arg.shard.primary.alias = change.inst.alias;
                    arg.shard.primary.image = change.inst.image;
                    next();
                    return;
                }


                vasync.forEachParallel({
                    inputs: Object.keys(arg.shard),
                    func: function getManateeServer(role, callback) {
                        var inst = change.insts.filter(function (x) {
                            return (x.zonename === arg.shard[role].zoneId);
                        })[0];
                        arg.shard[role].server_uuid = inst.server;
                        arg.shard[role].server_hostname = inst.hostname;
                        arg.shard[role].alias = inst.alias;
                        arg.shard[role].image = inst.image;
                        arg.shard[role].role = role;
                        callback();
                    }
                }, next);
            },

            function urDiscovery(ctx, next) {
                if (!arg.HA) {
                    next();
                    return;
                }
                var nodes = [arg.shard.primary.server_uuid];
                if (arg.shard.sync) {
                    nodes.push(arg.shard.sync.server_uuid);
                }
                if (arg.shard.async) {
                    nodes.push(arg.shard.async.server_uuid);
                }
                nodes = nodes.sort().filter(function (item, pos, ary) {
                    return (!pos || item !== ary[pos - 1]);
                });
                common.urDiscovery({
                    sdcadm: sdcadm,
                    progress: progress,
                    nodes: nodes,
                    urconn: ctx.urconn
                }, function (err, urAvailServers) {
                    if (err) {
                        next(err);
                        return;
                    }
                    ctx.urServersToUpdate = urAvailServers;
                    next();
                });
            },


            function getMorayVms(_, next) {
                progress('Getting SDC\'s moray vms from VMAPI');
                sdcadm.vmapi.listVms({
                    'tag.smartdc_role': 'moray',
                    state: 'running'
                }, function (vmsErr, vms_) {
                    if (vmsErr) {
                        next(vmsErr);
                        return;
                    }
                    morayVms = vms_;
                    next();
                });
            },

            function getWorkflowVms(_, next) {
                progress('Getting SDC\'s workflow vms from VMAPI');
                sdcadm.vmapi.listVms({
                    'tag.smartdc_role': 'workflow',
                    state: 'running'
                }, function (vmsErr, vms_) {
                    if (vmsErr) {
                        next(vmsErr);
                        return;
                    }
                    wfVms = vms_;
                    next();
                });
            },

            function checkInstanceImages(_, next) {
                if (!arg.HA || opts.plan.forceSameImage) {
                    next();
                    return;
                }
                vasync.forEachParallel({
                    inputs: [
                        arg.shard.primary,
                        arg.shard.sync,
                        arg.shard.async
                    ],
                    func: function (vm, next_) {
                        sdcadm.imgapi.getImage(vm.image, function (err, img_) {
                            if (err) {
                                next_(err);
                                return;
                            }
                            if (img_.uuid === arg.change.image.uuid) {
                                arg[vm.role + '_updated'] = true;
                            }
                            next_();
                        });
                    }
                }, next);
            },

            function installPrimaryImage(_, next) {
                if (!arg.HA) {
                    s.imgadmInstall(arg, next);
                } else {
                    if (arg.primary_updated) {
                        next();
                        return;
                    }
                    progress('Installing image %s\n    (%s@%s) on server %s',
                        arg.change.image.uuid, arg.change.image.name,
                        arg.change.image.version,
                        arg.shard.primary.server_uuid);

                    s.imgadmInstallRemote({
                        server: arg.shard.primary.server_uuid,
                        img: arg.change.image,
                        progress: progress,
                        log: log
                    }, next);
                }
            },

            function installImageAsyncServer(_, next) {
                if (!arg.HA || arg.async_updated ||
                    (arg.shard.async.server_uuid ===
                        arg.shard.primary.server_uuid)) {
                    next();
                    return;
                }

                progress('Installing image %s\n    (%s@%s) on server %s',
                    arg.change.image.uuid, arg.change.image.name,
                    arg.change.image.version, arg.shard.async.server_uuid);

                s.imgadmInstallRemote({
                    server: arg.shard.async.server_uuid,
                    img: arg.change.image,
                    progress: progress,
                    log: log
                }, next);
            },

            function installImageSyncServer(_, next) {
                if (!arg.HA) {
                    next();
                    return;
                }

                if ((arg.shard.sync.server_uuid ===
                        arg.shard.primary.server_uuid) ||
                        (arg.shard.sync.server_uuid ===
                         arg.shard.async.server_uuid)) {
                    next();
                    return;
                }

                if (arg.sync_updated) {
                    next();
                    return;
                }

                progress('Installing image %s\n    (%s@%s) on server %s',
                    arg.change.image.uuid, arg.change.image.name,
                    arg.change.image.version, arg.shard.sync.server_uuid);

                s.imgadmInstallRemote({
                    server: arg.shard.sync.server_uuid,
                    img: arg.change.image,
                    progress: progress,
                    log: log
                }, next);
            },

            // TOOLS-1223: ensure automatic fix for MANATEE-292
            function setCanmount(_, next) {
                if (!arg.HA) {
                    next();
                    return;
                }
                vasync.forEachParallel({
                    inputs: [
                        arg.shard.primary,
                        arg.shard.sync,
                        arg.shard.async
                    ],
                    func: function _setCanmount(vm, next_) {
                        getCanmount(vm.server_uuid, vm.zoneId,
                                function (cmErr, canmount) {
                            if (cmErr) {
                                next_(cmErr);
                                return;
                            }

                            if (canmount !== 'noauto') {
                                log.trace({
                                    vm: vm,
                                    canmount: canmount
                                }, 'canmount not set to noauto');

                                progress(
                                    'Setting canmount=noauto ' +
                                    'for /zones/%s/data/manatee',
                                    vm.zoneId);
                                setCanmountNoauto(
                                    vm.server_uuid, vm.zoneId, next_);
                                return;
                            }

                            log.trace({
                                vm: vm
                            }, 'canmount already set to noauto');
                            next_();
                        });
                    }
                }, next);
            },

            // We need to hack SAPI_PROTO_MODE and turn
            // it back on during the time we're gonna have moray down.
            // Otherwise, config-agent will try to publish the manatee zone IP
            // to SAPI and, if in full mode, it will obviously fail due to no
            // moray.
            function getLocalSapi(_, next) {
                if (pastSAPI224) {
                    next();
                    return;
                }
                progress('Running vmadm lookup to get local sapi');
                var argv = [
                    '/usr/sbin/vmadm',
                    'lookup',
                    'state=running',
                    'alias=~sapi'
                ];
                common.execFilePlus({
                    argv: argv,
                    log: log
                }, function (err, stdout, stderr) {
                    if (err) {
                        next(err);
                    } else {
                        var sapis = stdout.trim().split('\n');
                        sapiUUID = sapis[0];
                        log.debug('Local sapi instance found: %s',
                            sapiUUID);
                        next();
                    }
                });
            },

            function setSapiProtoMode(_, next) {
                if (pastSAPI224) {
                    next();
                    return;
                }
                progress('Set SAPI back to proto mode');
                var argv = [
                    '/usr/sbin/zlogin',
                    sapiUUID,
                    '/usr/sbin/mdata-put SAPI_PROTO_MODE true'
                ];
                common.execFilePlus({
                    argv: argv,
                    log: log
                }, function (err, stdout, stderr) {
                    if (err) {
                        next(err);
                    } else {
                        next();
                    }
                });
            },

            function restartSapiIntoProtoMode(_, next) {
                if (pastSAPI224) {
                    next();
                    return;
                }
                progress('Restarting SAPI in proto mode');
                svcadm.svcadmRestart({
                    zone: sapiUUID,
                    fmri: '/smartdc/application/sapi:default',
                    log: log
                }, next);
            },

            function getManateeAdmVersion(_, next) {
                progress('Checking manatee-adm version');
                common.manateeAdmRemote({
                    server: arg.shard.primary.server_uuid,
                    vm: arg.shard.primary.zoneId,
                    cmd: 'version',
                    log: log
                }, function (err, stdou, stder) {
                    if (err) {
                        next(err);
                        return;
                    }
                    // Not implemented until 2.0.0
                    if (stder) {
                        version = '1.0.0';
                    } else {
                        version = stdou;
                    }
                    next();
                });
            },

            // --------------- HA only --------------------------------------
            function verifyFullHA(_, next) {
                if (!arg.HA) {
                    next();
                    return;
                }

                progress('Verifying full HA setup');
                if (!arg.shard.sync || !arg.shard.async) {
                    progress(
                        'Incomplete HA setup. Please finish manatee setup' +
                        'and make sure primary, sync and async peers are ' +
                        'running before trying manatee update.');
                    next('HA setup error');
                }

                next();
            },

            function freezeClusterState(_, next) {
                freeze(_,  next);
            },

            function reprovisionAsync(_, next) {
                if (!arg.HA || arg.async_updated) {
                    next();
                    return;
                }
                progress('Reprovisioning "async" manatee');
                s.reprovisionRemote({
                    server: arg.shard.async.server_uuid,
                    img: arg.change.image,
                    zonename: arg.shard.async.zoneId,
                    progress: progress,
                    log: log,
                    sdcadm: opts.sdcadm
                }, next);
            },

            function waitForAsync(_, next) {
                if (!arg.HA || arg.async_updated) {
                    next();
                    return;
                }
                progress('Wait for manatee instance %s to come up',
                    arg.shard.async.zoneId);
                s.waitForInstToBeUp({
                    change: {
                        server: arg.shard.async.server_uuid,
                        type: 'update-instance',
                        service: 'manatee',
                        image: arg.change.image,
                        inst: {
                            instance: arg.shard.async.zoneId,
                            zonename: arg.shard.async.zoneId,
                            uuid: arg.shard.async.zoneId,
                            server: arg.shard.async.server_uuid,
                            service: 'manatee',
                            image: arg.change.image.uuid,
                            version: arg.change.image.version,
                            type: 'vm'
                        }
                    },
                    opts: {
                        progress: progress,
                        sdcadm: sdcadm,
                        log: log
                    }
                }, next);
            },

            function asyncStateBackfill(_, next) {
                if (!arg.HA || version !== '1.0.0' || arg.async_updated) {
                    next();
                    return;
                }
                progress('Backfilling cluster state');
                common.manateeAdmRemote({
                    server: arg.shard.async.server_uuid,
                    vm: arg.shard.async.zoneId,
                    cmd: 'state-backfill -y',
                    log: log
                }, next);
            },

            function waitForHA(_, next) {
                if (!arg.HA || arg.async_updated) {
                    next();
                    return;
                }
                progress('Waiting for manatee async to be online');
                waitForManatee('async', 'enabled',
                        arg.shard.primary.server_uuid,
                        arg.shard.primary.zoneId, hasPgStatus, next);
            },

            function freezeBeforeSync(_, next) {
                freeze(_,  next);
            },

            function reprovisionSync(_, next) {
                if (!arg.HA || arg.sync_updated) {
                    next();
                    return;
                }
                progress('Reprovisioning "sync" manatee');
                s.reprovisionRemote({
                    server: arg.shard.sync.server_uuid,
                    img: arg.change.image,
                    zonename: arg.shard.sync.zoneId,
                    progress: progress,
                    log: log,
                    sdcadm: opts.sdcadm
                }, next);
            },

            function waitForSync(_, next) {
                if (!arg.HA || arg.sync_updated) {
                    next();
                    return;
                }
                progress('Wait for manatee instance %s to come up',
                    arg.shard.sync.zoneId);
                s.waitForInstToBeUp({
                    change: {
                        server: arg.shard.sync.server_uuid,
                        type: 'update-instance',
                        service: 'manatee',
                        image: arg.change.image,
                        inst: {
                            instance: arg.shard.sync.zoneId,
                            zonename: arg.shard.sync.zoneId,
                            uuid: arg.shard.sync.zoneId,
                            server: arg.shard.sync.server_uuid,
                            service: 'manatee',
                            image: arg.change.image.uuid,
                            version: arg.change.image.version,
                            type: 'vm'
                        }
                    },
                    opts: {
                        progress: progress,
                        sdcadm: sdcadm,
                        log: log
                    }
                }, next);
            },

            function waitForHASync(_, next) {
                if (!arg.HA || arg.sync_updated) {
                    next();
                    return;
                }
                progress('Waiting for manatee sync to be online');
                waitForManatee('sync', 'enabled', arg.shard.primary.server_uuid,
                        arg.shard.primary.zoneId, hasPgStatus, next);
            },

            function freezeBeforePrimary(_, next) {
                freeze(_,  next);
            },

            // ---- Shared between HA and no-HA -------------------------------
            function reprovisionPrimary(_, next) {
                if (arg.HA && arg.primary_updated) {
                    next();
                    return;
                }
                progress('Reprovisioning "primary" manatee');
                s.reprovisionRemote({
                    server: arg.shard.primary.server_uuid,
                    img: arg.change.image,
                    zonename: arg.shard.primary.zoneId,
                    progress: progress,
                    log: log,
                    sdcadm: opts.sdcadm
                }, next);
            },

            function waitForPrimaryInstance(_, next) {
                if (arg.HA && arg.primary_updated) {
                    next();
                    return;
                }

                progress('Wait for manatee instance %s to come up',
                    arg.shard.primary.zoneId);
                s.waitForInstToBeUp({
                    change: {
                        server: arg.shard.primary.server_uuid,
                        type: 'update-instance',
                        service: 'manatee',
                        image: arg.change.image,
                        inst: {
                            instance: arg.shard.primary.zoneId,
                            zonename: arg.shard.primary.zoneId,
                            uuid: arg.shard.primary.zoneId,
                            server: arg.shard.primary.server_uuid,
                            service: 'manatee',
                            image: arg.change.image.uuid,
                            version: arg.change.image.version,
                            type: 'vm'
                        }
                    },
                    opts: {
                        progress: progress,
                        sdcadm: sdcadm,
                        log: log
                    }
                }, next);
            },

            // ----------- Again, no-HA only ----------------------------------
            function noHAStateBackfill(_, next) {
                if (arg.HA || version !== '1.0.0') {
                    next();
                    return;
                }
                progress('Backfilling cluster state');
                common.manateeAdmRemote({
                    server: arg.shard.primary.server_uuid,
                    vm: arg.shard.primary.zoneId,
                    cmd: 'state-backfill -y',
                    log: log
                }, next);
            },

            function waitForPrimaryPG(_, next) {
                if (arg.HA) {
                    next();
                    return;
                }
                progress('Wait for primary PostgreSQL');
                common.waitForPostgresUp({
                    server: arg.shard.primary.server_uuid,
                    vm: arg.shard.primary.zoneId,
                    log: log
                }, next);
            },

            // Something is setting the ONWM to off on this case, which should
            // not happen. Take it back
            function setONWM(_, next) {
                if (arg.HA) {
                    next();
                    return;
                }
                progress('Ensure ONE NODE WRITE MODE');
                common.manateeAdmRemote({
                    server: arg.shard.primary.server_uuid,
                    vm: arg.shard.primary.zoneId,
                    cmd: 'set-onwm -m on -y',
                    log: log
                }, next);
            },

            function disableWorkflowRunners(_, next) {
                progress('Disabling wf-runner services');
                vasync.forEachParallel({
                    inputs: wfVms,
                    func: function disableWfRunner(vm, next_) {
                        s.disableRemoteSvc({
                            server: vm.server_uuid,
                            zone: vm.uuid,
                            fmri: 'wf-runner',
                            log: log
                        }, next_);
                    }
                }, next);
            },

            function disableWorkflowApis(_, next) {
                progress('Disabling wf-api services');
                vasync.forEachParallel({
                    inputs: wfVms,
                    func: function disableWfApi(vm, next_) {
                        s.disableRemoteSvc({
                            server: vm.server_uuid,
                            zone: vm.uuid,
                            fmri: 'wf-api',
                            log: log
                        }, next_);
                    }
                }, next);
            },

            function disableMorays(_, next) {
                progress('Disabling moray services');
                vasync.forEachParallel({
                    inputs: morayVms,
                    func: function disableMoray(vm, next_) {
                        s.disableRemoteSvc({
                            server: vm.server_uuid,
                            zone: vm.uuid,
                            fmri: '*moray-202*',
                            log: log
                        }, next_);
                    }
                }, next);
            },

            function enableMorays(_, next) {
                progress('Enabling moray services');
                vasync.forEachParallel({
                    inputs: morayVms,
                    func: function enableMoray(vm, next_) {
                        s.enableRemoteSvc({
                            server: vm.server_uuid,
                            zone: vm.uuid,
                            fmri: '*moray-202*',
                            log: log
                        }, next_);
                    }
                }, next);
            },

            function wait4Morays(_, next) {
                progress('Waiting for moray services to be up');
                s.wait4Morays({
                    vms: morayVms,
                    sdcadm: sdcadm
                }, next);
            },

            function enableWfRunners(_, next) {
                progress('Enabling wf-runner services');
                vasync.forEachParallel({
                    inputs: wfVms,
                    func: function enableWfRunner(vm, next_) {
                        // In case initial disable timed out, let's make sure
                        // we properly enable it:
                        s.enableRemoteSvc({
                            server: vm.server_uuid,
                            zone: vm.uuid,
                            fmri: 'wf-runner',
                            log: log
                        }, function (err, stdout, stderr) {
                            if (err) {
                                next_(err);
                                return;
                            }
                            if (stdout.indexOf('maintenance') === -1) {
                                next_();
                                return;
                            }
                            s.disableRemoteSvc({
                                server: vm.server_uuid,
                                zone: vm.uuid,
                                fmri: 'wf-runner',
                                log: log
                            }, function (err2) {
                                if (err2) {
                                    next_(err2);
                                    return;
                                }
                                s.enableRemoteSvc({
                                    server: vm.server_uuid,
                                    zone: vm.uuid,
                                    fmri: 'wf-runner',
                                    log: log
                                }, next_);
                            });
                        });
                    }
                }, next);
            },

            function enableWfApis(_, next) {
                progress('Enabling wf-api services');
                vasync.forEachParallel({
                    inputs: wfVms,
                    func: function enableWfApi(vm, next_) {
                        s.enableRemoteSvc({
                            server: vm.server_uuid,
                            zone: vm.uuid,
                            fmri: 'wf-api',
                            log: log
                        }, next_);
                    }
                }, next);
            },

            function resetSapiToFullMode(_, next) {
                if (pastSAPI224) {
                    next();
                    return;
                }
                progress('Restoring SAPI to full mode');
                sdcadm.sapi.setMode('full', next);
            },

            function ensureFullMode(_, next) {
                if (pastSAPI224) {
                    next();
                    return;
                }
                progress('Verifying SAPI full mode');
                sdcadm.sapi.getMode(function (err, mode) {
                    if (err) {
                        next(err);
                        return;
                    }

                    if (mode !== 'full') {
                        var msg = 'Unable to set SAPI to full mode.';
                        next(new errors.UpdateError(new Error(
                                    msg), 'sapi'));
                        return;
                    }
                    next();
                });
            },

            function waitForShardHA(_, next) {
                if (!arg.HA) {
                    next();
                    return;
                }
                progress('Waiting for manatee shard to reach full HA');
                waitForManatee('async', 'enabled',
                    arg.shard.async.server_uuid,
                    arg.shard.async.zoneId, hasPgStatus, function (err) {
                        if (err) {
                            if (err === 'deposed') {
                                var msg = 'manatee instance ' +
                                    arg.shard.primary.zoneId + ' on server ' +
                                    arg.shard.primary.server_uuid + ' is on ' +
                                    'deposed state. Please log into this ' +
                                    'VM an run:\n\t `manatee-adm rebuild`.';
                                progress(msg);
                                next(new errors.UpdateError(new Error(
                                    msg), 'manatee-adm'));
                            } else {
                                next(err);
                            }
                            return;
                        }
                        next();
                    });
            },

            function unfreezeClusterState(_, next) {
                if (!arg.HA) {
                    next();
                    return;
                }
                progress('Unfreezing cluster state');
                common.manateeAdmRemote({
                    server: arg.shard.async.server_uuid,
                    vm: arg.shard.async.zoneId,
                    cmd: 'unfreeze',
                    log: log
                }, function (err, stdout, stderr) {
                    if (err) {
                        next(err);
                        return;
                    } else if (stderr) {
                        next(new errors.InternalError({
                            message: stderr
                        }));
                        return;
                    }
                    next();
                });
            }

        ]), arg: arg}, nextSvc);
    }

    vasync.forEachPipeline({
        inputs: self.changes,
        func: updateManatee
    }, cb);

};


// --- exports

module.exports = {
    UpdateManateeV2: UpdateManateeV2
};
// vim: set softtabstop=4 shiftwidth=4:
