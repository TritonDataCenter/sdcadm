/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */


var p = console.log;
var assert = require('assert-plus');
var sprintf = require('extsprintf').sprintf;
var util = require('util'),
    format = util.format;
var child_process = require('child_process'),
    execFile = child_process.execFile,
    spawn = child_process.spawn;
var fs = require('fs');
var path = require('path');
var os = require('os');
var vasync = require('vasync');

var errors = require('../errors'),
    InternalError = errors.InternalError;
var common = require('../common');
var vmadm = require('../vmadm');
var svcadm = require('../svcadm');

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
    var rollback = opts.plan.rollback || false;

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
                return callback(err);
            }
            // REVIEW: Shall we try/catch here?
            var manateeShard = JSON.parse(stdout);
            return callback(null, manateeShard);
        });
    }


    function disableManatee(server, zone, callback) {
        log.trace({
            server: server,
            zone: zone
        }, 'Disabling manatee services (sdc-oneachnode)');
        var argv = [
            '/opt/smartdc/bin/sdc-oneachnode',
            '-n',
            server,
            format('svcadm -z %s disable -s manatee-sitter; ', zone) +
            format('svcadm -z %s disable -s manatee-snapshotter; ', zone) +
            format('svcadm -z %s disable -s manatee-backupserver;', zone)
        ];
        common.execFilePlus({
            argv: argv,
            log: log
        }, function (err, stdout, stderr) {
            if (err) {
                callback(err);
            } else {
                callback();
            }
        });
    }


    function restartSitter(server, zone, callback) {
        log.trace({
            server: server,
            zone: zone
        }, 'Restarting manatee sitter (sdc-oneachnode)');
        var argv = [
            '/opt/smartdc/bin/sdc-oneachnode',
            '-n',
            server,
            format('/usr/sbin/svcadm -z %s restart manatee-sitter', zone)
        ];
        common.execFilePlus({
            argv: argv,
            log: log
        }, function (err, stdout, stderr) {
            if (err) {
                callback(err);
            } else {
                callback();
            }
        });

    }


    function checkSitterStatus(server, zone, callback) {
        return s.manateeSitterSvcStatus({
            log: log,
            server: server,
            vm: zone
        }, callback);
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
            /* JSSTYLED */
            format('/usr/sbin/zfs get -H -o value canmount zones/%s/data/manatee', zone)
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
                return callback(new errors.InternalError({
                    message: 'error running zfs get canmount',
                    cmd: argv.join(' '),
                    stdout: stdout,
                    stderr: stderr,
                    cause: err
                }));
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
            format('/usr/sbin/zfs set canmount=noauto zones/%s/data/manatee', zone)
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
                return callback(new errors.InternalError({
                    message: 'error running zfs set canmount=noauto',
                    cmd: argv.join(' '),
                    stdout: stdout,
                    stderr: stderr,
                    cause: err
                }));
            }
            callback();
        });
    }


    function waitForDisabled(server, inst, flag, callback) {
        var counter = 0;
        var limit = 12;
        function _waitForDisabled() {
            var argv = [
                '/opt/smartdc/bin/sdc-oneachnode',
                '-j',
                '-n',
                server,
                /* JSSTYLED */
                format('/usr/sbin/zlogin %s \'json %s < /opt/smartdc/manatee/etc/sitter.json\'', inst, flag)
            ];
            common.execFilePlus({
                argv: argv,
                log: log
            }, function (err, stdout, stderr) {
                if (err) {
                    callback(err);
                } else {
                    var res = JSON.parse(stdout.trim());
                    counter += 1;
                    if (res[0].result.stdout.trim() === 'false') {
                        callback();
                    } else {
                        if (counter < limit) {
                            return setTimeout(_waitForDisabled, 5000);
                        } else {
                            return callback(format(
                                'Timeout (60s) waiting for config flag' +
                                ' %s to be disabled', flag));
                        }

                    }
                }
            });
        }
        _waitForDisabled();
    }


    function waitForEnabled(server, zuuid, flag, callback) {
        var counter = 0;
        var limit = 12;
        function _waitForEnabled() {
            var argv = [
                '/opt/smartdc/bin/sdc-oneachnode',
                '-j',
                '-n',
                server,
                /* JSSTYLED */
                format('/usr/sbin/zlogin %s \'json %s < /opt/smartdc/manatee/etc/sitter.json\'', zuuid, flag)
            ];
            common.execFilePlus({
                argv: argv,
                log: self.log
            }, function (err, stdout, stderr) {
                if (err) {
                    callback(err);
                } else {
                    var res = JSON.parse(stdout.trim());
                    counter += 1;
                    if (res[0].result.stdout.trim() === 'true') {
                        callback();
                    } else {
                        if (counter < limit) {
                            return setTimeout(_waitForEnabled, 5000);
                        } else {
                            return callback(format(
                                'Timeout (60s) waiting for config flag' +
                                ' %s to be enabled', flag));
                        }

                    }
                }
            });
        }
        _waitForEnabled();
    }


    function updateManatee(change, nextSvc) {
        var arg = {
            change: change,
            opts: opts,
            userScript: false,
            HA: false,
            shard: {
            }
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
            return s.waitForManatee({
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
                    return next(svcErr);
                }
                if (!svcs.length) {
                    return next(new errors.SDCClientError(new Error(
                        'No services named "moray"'), 'sapi'));
                }
                var moraySvc = svcs[0];
                var imgUUID = moraySvc.params.image_uuid;
                sdcadm.imgapi.getImage(imgUUID, function (err, img_) {
                    if (err) {
                        return next(err);
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
                        return next(new errors.ValidationError(new Error(msg),
                            'sdcadm'));
                    }
                    return next();
                });
            });
        }

        function disallowv1tov2Updates(_, next) {
            var imgUUID = (arg.HA) ? arg.change.insts[0].image :
                arg.change.inst.image;
            sdcadm.imgapi.getImage(imgUUID, function (err, img_) {
                if (err) {
                    return next(err);
                }
                var parts = img_.version.split('-');
                var curVer = parts[parts.length - 2];
                if (curVer < UpdateManateeV2.MIN_V2_TIMESTAMP) {
                    var msg =
                        'Cannot update manateee from any version built ' +
                        'before' + UpdateManateeV2.MIN_V2_TIMESTAMP +
                        ' (current version was built ' + curVer + ')';
                    progress(msg);
                    return next(new errors.ValidationError(new Error(msg),
                        'sdcadm'));
                }
                return next();
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
                return next(new errors.ValidationError(new Error(msg),
                    'sdcadm'));
            }
            if (curVer >= UpdateManateeV2.SAPI_224_MIN_TS) {
                pastSAPI224 = true;
                progress('Target version is new enough to avoid ' +
                    'setting SAPI back to proto mode');
            }
            return next();
        }

        function checkCurrentManateeVersion(_, next) {
            progress('Verifying manatee current version');
            var imgUUID = arg.HA ?
                arg.change.insts[0].image : arg.change.inst.image;
            sdcadm.imgapi.getImage(imgUUID, function (err, img_) {
                if (err) {
                    return next(err);
                }
                var parts = img_.version.split('-');
                var curVer = parts[parts.length - 2];
                if (curVer >= UpdateManateeV2.MIN_PG_STATUS_VERSION) {
                    hasPgStatus = true;
                    progress('manatee-adm version is >= 2.1.0.' +
                            ' Using new commands');
                }
                return next();
            });
        }


        function freeze(_, next) {
            if (!arg.HA || version === '1.0.0' || isFrozen) {
                return next();
            }
            progress('Freezing cluster state');
            common.manateeFreeze({
                server: arg.shard.async.server_uuid,
                vm: arg.shard.async.zoneId,
                reason: 'sdcadm ' + opts.wrkDir,
                log: log
            }, function (err) {
                if (err) {
                    return next(err);
                }
                isFrozen = true;
                return next();
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

            s.updateSapiSvc,

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
                        return next(err);
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
                        return next(new errors.UpdateError(new Error(msg),
                                    'manatee-adm'));
                    }
                    // Refuse to update HA setup w/o all the shard members.
                    // Instead, suggest to complete HA setup
                    if (arg.HA && (!arg.shard.async || !arg.shard.sync)) {
                        var msg2 = 'Cannot find sync and/or async peers. ' +
                            'Please complete the HA setup by running:\n\t' +
                            'sdcadm post-setup ha-manatee\n before ' +
                            'attempting the update again.';
                        progress(msg2);
                        return next(new errors.UpdateError(new Error(msg2),
                                    'sdcadm'));

                    }
                    // For now can handle only a single 'async' manatee
                    if (arg.shard.async && arg.shard.async.length) {
                        arg.shard.async = arg.shard.async[0];
                    }
                    return next();
                });
            },

            function getShardServers(_, next) {
                progress('Getting Server Information for manatee VMs');
                if (!arg.HA) {
                    arg.shard.primary.server_uuid = change.inst.server;
                    arg.shard.primary.server_hostname = change.inst.hostname;
                    arg.shard.primary.alias = change.inst.alias;
                    return next();
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
                        callback();
                    }
                }, next);
            },

            function getMorayVms(_, next) {
                progress('Getting SDC\'s moray vms from VMAPI');
                sdcadm.vmapi.listVms({
                    'tag.smartdc_role': 'moray',
                    state: 'running'
                }, function (vmsErr, vms_) {
                    if (vmsErr) {
                        return next(vmsErr);
                    }
                    morayVms = vms_;
                    return next();
                });
            },

            function getWorkflowVms(_, next) {
                progress('Getting SDC\'s workflow vms from VMAPI');
                sdcadm.vmapi.listVms({
                    'tag.smartdc_role': 'workflow',
                    state: 'running'
                }, function (vmsErr, vms_) {
                    if (vmsErr) {
                        return next(vmsErr);
                    }
                    wfVms = vms_;
                    return next();
                });
            },

            function installPrimaryImage(_, next) {
                if (!arg.HA) {
                    return s.imgadmInstall(arg, next);
                } else {
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
                if (!arg.HA) {
                    return next();
                }

                if (arg.shard.async.server_uuid ===
                        arg.shard.primary.server_uuid) {
                    return next();
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
                    return next();
                }

                if ((arg.shard.sync.server_uuid ===
                        arg.shard.primary.server_uuid) ||
                        (arg.shard.sync.server_uuid ===
                         arg.shard.async.server_uuid)) {
                    return next();
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
                    return next();
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
                                return next_(cmErr);
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
                                return setCanmountNoauto(
                                    vm.server_uuid, vm.zoneId, next_);
                            }

                            log.trace({
                                vm: vm
                            }, 'canmount already set to noauto');
                            return next_();
                        });
                    }
                }, function (cmErr) {
                    next(cmErr);
                });
            },

            // We need to hack SAPI_PROTO_MODE and turn
            // it back on during the time we're gonna have moray down.
            // Otherwise, config-agent will try to publish the manatee zone IP
            // to SAPI and, if in full mode, it will obviously fail due to no
            // moray.
            function getLocalSapi(_, next) {
                if (pastSAPI224) {
                    return next();
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
                    return next();
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
                    return next();
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
                        return next(err);
                    }
                    // Not implemented until 2.0.0
                    if (stder) {
                        version = '1.0.0';
                    } else {
                        version = stdou;
                    }
                    return next();
                });
            },

            // --------------- HA only --------------------------------------
            function verifyFullHA(_, next) {
                if (!arg.HA) {
                    return next();
                }

                progress('Verifying full HA setup');
                if (!arg.shard.sync || !arg.shard.async) {
                    progress(
                        'Incomplete HA setup. Please finish manatee setup' +
                        'and make sure primary, sync and async peers are ' +
                        'running before trying manatee update.');
                    next('HA setup error');
                }

                return next();
            },

            function freezeClusterState(_, next) {
                return freeze(_,  next);
            },

            function disableAsync(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Disabling "async" manatee');
                disableManatee(arg.shard.async.server_uuid,
                        arg.shard.async.zoneId, next);
            },

            function waitForAsyncDisabled(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Waiting for manatee async to be disabled');
                waitForManatee('async', 'disabled',
                        arg.shard.primary.server_uuid,
                        arg.shard.primary.zoneId, hasPgStatus, next);
            },

            function reprovisionAsync(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Reprovisioning "async" manatee');
                return s.reprovisionRemote({
                    server: arg.shard.async.server_uuid,
                    img: arg.change.image,
                    zonename: arg.shard.async.zoneId,
                    progress: progress,
                    log: log,
                    sdcadm: opts.sdcadm
                }, next);
            },

            function waitForAsync(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Wait for manatee instance %s to come up',
                    arg.shard.async.zoneId);
                return s.waitForInstToBeUp({
                    change: {
                        server: arg.shard.async.server_uuid,
                        type: 'create',
                        service: 'manatee',
                        image: arg.change.image.uuid,
                        inst: {
                            instance: arg.shard.async.zoneId,
                            zonename: arg.shard.async.zoneId,
                            uuid: arg.shard.async.zoneId,
                            server: arg.shard.async.server_uuid,
                            service: 'manatee',
                            image: arg.change.image.uuid,
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
                if (!arg.HA || version !== '1.0.0') {
                    return next();
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
                if (!arg.HA) {
                    return next();
                }
                progress('Waiting for manatee async to be online');
                waitForManatee('async', 'enabled',
                        arg.shard.primary.server_uuid,
                        arg.shard.primary.zoneId, hasPgStatus, next);
            },

            function freezeBeforeSync(_, next) {
                return freeze(_,  next);
            },

            function disableSync(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Disabling "sync" manatee');
                disableManatee(arg.shard.sync.server_uuid,
                        arg.shard.sync.zoneId, next);
            },

            function waitForSyncDisabled(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Waiting for manatee sync to be disabled');
                waitForManatee('sync', 'disabled',
                        arg.shard.primary.server_uuid,
                        arg.shard.primary.zoneId, hasPgStatus, next);
            },


            function reprovisionSync(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Reprovisioning "sync" manatee');
                return s.reprovisionRemote({
                    server: arg.shard.sync.server_uuid,
                    img: arg.change.image,
                    zonename: arg.shard.sync.zoneId,
                    progress: progress,
                    log: log,
                    sdcadm: opts.sdcadm
                }, next);
            },

            function waitForSync(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Wait for manatee instance %s to come up',
                    arg.shard.sync.zoneId);
                return s.waitForInstToBeUp({
                    change: {
                        server: arg.shard.sync.server_uuid,
                        type: 'create',
                        service: 'manatee',
                        image: arg.change.image.uuid,
                        inst: {
                            instance: arg.shard.sync.zoneId,
                            zonename: arg.shard.sync.zoneId,
                            uuid: arg.shard.sync.zoneId,
                            server: arg.shard.sync.server_uuid,
                            service: 'manatee',
                            image: arg.change.image.uuid,
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
                if (!arg.HA) {
                    return next();
                }
                progress('Waiting for manatee sync to be online');
                waitForManatee('sync', 'enabled', arg.shard.primary.server_uuid,
                        arg.shard.primary.zoneId, hasPgStatus, next);
            },

            function freezeBeforePrimary(_, next) {
                return freeze(_,  next);
            },

            // ---- Shared between HA and no-HA -------------------------------
            function reprovisionPrimary(_, next) {
                progress('Reprovisioning "primary" manatee');
                return s.reprovisionRemote({
                    server: arg.shard.primary.server_uuid,
                    img: arg.change.image,
                    zonename: arg.shard.primary.zoneId,
                    progress: progress,
                    log: log,
                    sdcadm: opts.sdcadm
                }, next);
            },

            function waitForPrimaryInstance(_, next) {
                progress('Wait for manatee instance %s to come up',
                    arg.shard.primary.zoneId);
                return s.waitForInstToBeUp({
                    change: {
                        server: arg.shard.primary.server_uuid,
                        type: 'create',
                        service: 'manatee',
                        image: arg.change.image.uuid,
                        inst: {
                            instance: arg.shard.primary.zoneId,
                            zonename: arg.shard.primary.zoneId,
                            uuid: arg.shard.primary.zoneId,
                            server: arg.shard.primary.server_uuid,
                            service: 'manatee',
                            image: arg.change.image.uuid,
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
                    return next();
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
                    return next();
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
                    return next();
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
                }, function (wfErr, wfRes) {
                    if (wfErr) {
                        return next(wfErr);
                    }
                    return next();
                });
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
                }, function (wfErr, wfRes) {
                    if (wfErr) {
                        return next(wfErr);
                    }
                    return next();
                });
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
                }, function (morErr, morRes) {
                    if (morErr) {
                        return next(morErr);
                    }
                    return next();
                });
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
                }, function (morErr, morRes) {
                    if (morErr) {
                        return next(morErr);
                    }
                    return next();
                });
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
                                return next_(err);
                            }
                            if (stdout.indexOf('maintenance') === -1) {
                                return next_();
                            }
                            s.disableRemoteSvc({
                                server: vm.server_uuid,
                                zone: vm.uuid,
                                fmri: 'wf-runner',
                                log: log
                            }, function (err2) {
                                if (err2) {
                                    return next_(err2);
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
                }, function (wfErr, wfRes) {
                    if (wfErr) {
                        return next(wfErr);
                    }
                    return next();
                });
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
                }, function (wfErr, wfRes) {
                    if (wfErr) {
                        return next(wfErr);
                    }
                    return next();
                });
            },

            function resetSapiToFullMode(_, next) {
                if (pastSAPI224) {
                    return next();
                }
                progress('Restoring SAPI to full mode');
                sdcadm.sapi.setMode('full', next);
            },

            function ensureFullMode(_, next) {
                if (pastSAPI224) {
                    return next();
                }
                progress('Verifying SAPI full mode');
                sdcadm.sapi.getMode(function (err, mode) {
                    if (err) {
                        return next(err);
                    }

                    if (mode !== 'full') {
                        var msg = 'Unable to set SAPI to full mode.';
                        return next(new errors.UpdateError(new Error(
                                    msg), 'sapi'));
                    }
                    return next();
                });
            },

            function waitForShardHA(_, next) {
                if (!arg.HA) {
                    return next();
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
                                return next(new errors.UpdateError(new Error(
                                    msg), 'manatee-adm'));
                            } else {
                                return next(err);
                            }
                        }
                        return next();
                    });
            },

            function unfreezeClusterState(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Unfreezing cluster state');
                common.manateeAdmRemote({
                    server: arg.shard.async.server_uuid,
                    vm: arg.shard.async.zoneId,
                    cmd: 'unfreeze',
                    log: log
                }, function (err, stdou, stder) {
                    if (err) {
                        return next(err);
                    } else if (stder) {
                        return next(new errors.InternalError(stder));
                    }
                    return next();
                });
            }

        ]), arg: arg}, nextSvc);
    }

    vasync.forEachPipeline({
        inputs: self.changes,
        func: updateManatee
    }, cb);

};


//---- exports

module.exports = {
    UpdateManateeV2: UpdateManateeV2
};
// vim: set softtabstop=4 shiftwidth=4:
