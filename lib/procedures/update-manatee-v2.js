/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
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
 */

function UpdateManateeV2(options) {
    assert.arrayOfObject(options.changes, 'options.changes');
    this.changes = options.changes;
}
util.inherits(UpdateManateeV2, Procedure);

// Version since we moved from manatee-1.0 to manatee-2.0 and modified
// leader election (timestam set for moray):
UpdateManateeV2.V2_TIMESTAMP = '20141204T233537Z';
// Minimal manatee version (from here, we're updating to 2.0):
UpdateManateeV2.MIN_V2_TIMESTAMP = '20141218T222828Z';

UpdateManateeV2.prototype.summarize = function manateev2Summarize() {
    var c0 = this.changes[0];
    var img = c0.image;
    var out = [sprintf('update "%s" service to image %s (%s@%s)',
                    c0.service.name, img.uuid, img.name, img.version)];
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

    // We need this many times
    function getShardStatusLocally(manateeUUID, callback) {
        var argv = [
            '/usr/sbin/zlogin',
            manateeUUID,
            'source ~/.bashrc; ' +
                '/opt/smartdc/manatee/node_modules/.bin/manatee-adm status'
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


    // Run the manatee-adm subcommand given by "cmd" into the provided server.
    // We assume that there will be a manatee VM with UUID vmUUID into the
    // given server.
    function manateeAdmRemote(server, vmUUID, cmd, callback) {
        var argv = [
            '/opt/smartdc/bin/sdc-oneachnode',
            '-j',
            format('-n %s ', server),
            format('/usr/sbin/zlogin %s ', vmUUID) +
            '\'source ~/.bashrc; ' +
            '/opt/smartdc/manatee/node_modules/.bin/manatee-adm ' + cmd + ' \''
        ];

        common.execFilePlus({
            argv: argv,
            log: log
        }, function (err, stdout, stderr) {
            if (err) {
                return callback(err);
            }
            try {
                // Due to the -j option of sdc-oneachnode:
                var res = JSON.parse(stdout);
                var out = res[0].result.stdout.trim() || null;
                var stde = res[0].result.stderr.trim() || null;
                return callback(null, out, stde);
            } catch (e) {
                // In case of error, just return the raw result for later
                // inspection, given it doesn't have the expected JSON format:
                return callback(err, stdout, stderr);
            }
        });
    }

    function getShardStatus(server, manateeUUID, callback) {
        function statusCb(err, stdout, stderr) {
            if (err) {
                return callback(err);
            }
            var manateeShard = JSON.parse(stdout);
            return callback(null, manateeShard);
        }
        manateeAdmRemote(server, manateeUUID, 'status', statusCb);
    }

    function disableManatee(server, zone, callback) {
        log.trace({
            server: server,
            zone: zone
        }, 'Disabling manatee services (sdc-oneachnode)');
        var argv = [
            '/opt/smartdc/bin/sdc-oneachnode',
            format('-n %s ', server),
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
            format('-n %s ', server),
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

    // Same than imgadmInstall but through sdc-oneachnode
    function imgadmInstallRemote(server, img, callback) {
        return s.imgadmInstallRemote({
            server: server,
            img: img,
            progress: progress,
            log: log
        }, callback);
    }

    // Reprovision through sdc-oneachnode
    function reprovisionRemote(server, zonename, img, callback) {
        return s.reprovisionRemote({
            server: server,
            img: img,
            zonename: zonename,
            progress: progress,
            log: log
        }, callback);
    }
    // Wait for manatee given state
    function waitForManatee(state, server, zone, callback) {
        var counter = 0;
        var limit = 180;
        function _waitForStatus() {
            getShardStatus(server, zone, function (err, obj) {
                counter += 1;

                if (err) {
                    return callback(err);
                }

                var mode = 'transition';
                var up;
                if (!obj.sdc) {
                    mode = 'transition';
                } else if (Object.keys(obj.sdc).length === 0) {
                    mode = 'empty';
                } else if (obj.sdc.primary && obj.sdc.sync && obj.sdc.async) {
                    up = obj.sdc.async.repl && !obj.sdc.async.repl.length &&
                        Object.keys(obj.sdc.async.repl).length === 0;
                    if (up && obj.sdc.sync.repl) {
                        mode = 'async';
                    }
                } else if (obj.sdc.primary && obj.sdc.sync && obj.sdc.deposed) {
                    mode = 'deposed';
                } else if (obj.sdc.primary && obj.sdc.sync) {
                    up = obj.sdc.sync.repl && !obj.sdc.sync.repl.length &&
                        Object.keys(obj.sdc.sync.repl).length === 0;
                    if (up && obj.sdc.primary.repl) {
                        mode = 'sync';
                    }
                } else if (obj.sdc.primary) {
                    up = obj.sdc.primary.repl && !obj.sdc.primary.repl.length &&
                        Object.keys(obj.sdc.primary.repl).length === 0;
                    if (up) {
                        mode = 'primary';
                    }
                }

                if (mode === state) {
                    return callback(null);
                }
                // If mode is deposed, it will not change nevermore, let's
                // return here and avoid waiting for anything else
                if (mode === 'deposed') {
                    return callback('deposed');
                }

                if (counter < limit) {
                    return setTimeout(_waitForStatus, 5000);
                } else {
                    return callback(format(
                        'Timeout (15m) waiting for manatee to reach %s',
                        state));
                }

            });
        }
        _waitForStatus();
    }


    function waitForDisabled(server, inst, flag, callback) {
        var counter = 0;
        var limit = 12;
        function _waitForDisabled() {
            var argv = [
                '/opt/smartdc/bin/sdc-oneachnode',
                '-j',
                format('-n %s', server),
                format('/usr/sbin/zlogin %s ', inst) +
                format('\'json %s < ' +
                        '/opt/smartdc/manatee/etc/sitter.json\'', flag)
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
                format('-n %s', server),
                format('/usr/sbin/zlogin %s ', zuuid) +
                format('\'json %s < ' +
                        '/opt/smartdc/manatee/etc/sitter.json\'', flag)
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


    function waitForPostgresUp(server, zone, callback) {
        var counter = 0;
        var limit = 36;
        function _waitForPostgresUp() {
            var args = [
                format('-n %s ', server),
                format('/usr/sbin/zlogin %s ', zone) +
                '\'/opt/local/bin/psql -U postgres -t -A -c ' +
                '"SELECT NOW() AS when;"\''
            ];

            var child = spawn('/opt/smartdc/bin/sdc-oneachnode', args);
            var stdout = [];
            var stderr = [];
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', function (so) {
                stdout.push(so);
            });
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', function (se) {
                stderr.push(se);
            });

            child.on('close', function vmadmDone(code, signal) {
                stdout = stdout.join('');
                stderr = stderr.join('');
                log.debug({
                    code: code,
                    signal: signal,
                    stdout: stdout,
                    stderr: stderr
                }, 'Ping PostgreSQL');

                counter += 1;

                if ((code || signal)) {
                    if (counter < limit) {
                        return setTimeout(_waitForPostgresUp, 5000);
                    } else {
                        return callback('Timeout (60s) waiting for Postgres');
                    }
                } else {
                    return callback();
                }
            });
        }
        _waitForPostgresUp();
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

        if (change.insts && change.insts.length > 1) {
            arg.HA = true;
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
        function verifyManateeVersion(_, next) {
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
            return next();
        }

        // We also need to make sure that we are upgrading to manatee v2.0,
        // updates to v1.0 are not supported by this tool:

        var funcs = [
            s.getUserScript,
            s.writeOldUserScriptForRollback,
            s.updateSvcUserScript,
            verifyMorayVersion,
            verifyManateeVersion
        ];

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

            function getShard(_, next) {
                progress('Running manatee-adm status in local manatee');
                getShardStatusLocally(manateeUUID, function (err, st) {
                    if (err) {
                        return next(err);
                    }
                    Object.keys(st.sdc).forEach(function (m) {
                        arg.shard[m] = st.sdc[m];
                    });
                    return next();
                });
            },

            function getShardServers(_, next) {
                progress('Getting Compute Nodes Information for manatee VMs');
                if (!arg.HA) {
                    arg.shard.primary.server_uuid =
                        change.inst.server;
                    return next();
                }
                var servers = {};
                vasync.forEachParallel({
                    inputs: Object.keys(arg.shard).map(function (m) {
                        return (arg.shard[m].zoneId);
                    }),
                    func: function getManateeServer(vm_uuid, callback) {
                        servers[vm_uuid] = change.insts.filter(function (x) {
                            return (x.zonename === vm_uuid);
                        })[0].server;
                        callback();
                    }
                }, function (err, result) {
                    if (err) {
                        return next(err);
                    }
                    Object.keys(arg.shard).forEach(function (m) {
                        arg.shard[m].server_uuid = servers[arg.shard[m].zoneId];
                    });
                    return next();
                });
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

            function installPrimaryImage(_, next) {
                if (!arg.HA) {
                    return s.imgadmInstall(arg, next);
                } else {
                    progress('Installing image %s (%s@%s) on server %s',
                        arg.change.image.uuid, arg.change.image.name,
                        arg.change.image.version,
                        arg.shard.primary.server_uuid);

                    imgadmInstallRemote(arg.shard.primary.server_uuid,
                            arg.change.image, next);
                }
            },

            // We need to hack SAPI_PROTO_MODE and turn
            // it back on during the time we're gonna have moray down.
            // Otherwise, config-agent will try to publish the manatee zone IP
            // to SAPI and, if in full mode, it will obviously fail due to no
            // moray.
            function getLocalSapi(_, next) {
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
                progress('Restarting SAPI in proto mode');
                svcadm.svcadmRestart({
                    zone: sapiUUID,
                    fmri: '/smartdc/application/sapi:default',
                    log: log
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
                }, function (morErr, morRes) {
                    if (morRes) {
                        return next(morErr);
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
                        'Incomplete HA setup. Please, finish manatee setup' +
                        'and make sure primary, sync and async peers are ' +
                        'running before trying manatee update.');
                    next('HA setup error');
                }

                return next();
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
                progress('Waiting for manatee shard to reach "sync" status');
                waitForManatee('sync', arg.shard.primary.server_uuid,
                        arg.shard.primary.zoneId, next);
            },

            function installImageAsyncServer(_, next) {
                if (!arg.HA) {
                    return next();
                }

                if (arg.shard.async.server_uuid ===
                        arg.shard.primary.server_uuid) {
                    return next();
                }

                progress('Installing image %s (%s@%s) on server %s',
                    arg.change.image.uuid, arg.change.image.name,
                    arg.change.image.version, arg.shard.async.server_uuid);

                imgadmInstallRemote(arg.shard.async.server_uuid,
                        arg.change.image, next);
            },

            function reprovisionAsync(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Reprovisioning "async" manatee');
                reprovisionRemote(arg.shard.async.server_uuid,
                        arg.shard.async.zoneId, arg.change.image, next);
            },

            function waitForAsync(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Wait (60s) for manatee instance %s to come up',
                    arg.shard.async.zoneId);
                setTimeout(next, 60 * 1000);
            },

            function asyncStateBackfill(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Backfilling cluster state');
                manateeAdmRemote(arg.shard.async.server_uuid,
                        arg.shard.async.zoneId,
                        'state-backfill -y', function (err, stdou, stder) {
                            if (err) {
                                return next(err);
                            }
                            return next();
                        });
            },

            function waitForHA(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Waiting for manatee shard to reach "async" status');
                waitForManatee('async', arg.shard.primary.server_uuid,
                        arg.shard.primary.zoneId, next);
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
                progress('Waiting for manatee shard to reach "sync" status');
                waitForManatee('sync', arg.shard.primary.server_uuid,
                        arg.shard.primary.zoneId, next);
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

                progress('Installing image %s (%s@%s) on server %s',
                    arg.change.image.uuid, arg.change.image.name,
                    arg.change.image.version, arg.shard.sync.server_uuid);

                imgadmInstallRemote(arg.shard.sync.server_uuid,
                        arg.change.image, next);
            },


            function reprovisionSync(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Reprovisioning "sync" manatee');
                reprovisionRemote(arg.shard.sync.server_uuid,
                        arg.shard.sync.zoneId, arg.change.image, next);
            },

            function waitForSync(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Wait (60s) for manatee instance %s to come up',
                    arg.shard.sync.zoneId);
                setTimeout(next, 60 * 1000);
            },

            function waitForHASync(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Waiting for manatee shard to reach "async" status');
                waitForManatee('async', arg.shard.primary.server_uuid,
                        arg.shard.primary.zoneId, next);
            },

            function disablePrimaryManatee(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Disabling manatee services on "primary" manatee');
                disableManatee(arg.shard.primary.server_uuid,
                        arg.shard.primary.zoneId, next);
            },

            function waitForShardPromotion(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Waiting for shard promotion before "primary" update');
                var counter = 0;
                var limit = 36;
                function _waitForShardPromotion() {
                    getShardStatus(arg.shard.async.server_uuid,
                            arg.shard.async.zoneId,
                            function (err, shard) {
                        if (err) {
                            return next(err);
                        }
                        if (shard.sdc.primary.zoneId !==
                            arg.shard.primary.zoneId) {
                            return next();
                        } else {
                            if (counter < limit) {
                                return setTimeout(_waitForShardPromotion, 5000);
                            } else {
                                return next('Timeout (3min) waiting ' +
                                    'for shard promotion');
                            }
                        }
                    });
                }
                _waitForShardPromotion();
            },

            // ---- Shared between HA and no-HA -------------------------------
            function reprovisionPrimary(_, next) {
                progress('Reprovisioning "primary" manatee');
                return reprovisionRemote(arg.shard.primary.server_uuid,
                        arg.shard.primary.zoneId, arg.change.image, next);
            },

            function waitForPrimaryInstance(_, next) {
                // For now we are using the lame 60s sleep from incr-upgrade's
                // upgrade-all.sh.
                // TODO: improve this to use instance "up" checks from TOOLS-551
                progress('Wait (60s) for manatee instance %s to come up',
                    arg.shard.primary.zoneId);
                setTimeout(next, 60 * 1000);
            },

            // ----------- Again, no-HA only ----------------------------------
            function noHAStateBackfill(_, next) {
                if (arg.HA) {
                    return next();
                }
                progress('Backfilling cluster state');
                manateeAdmRemote(arg.shard.primary.server_uuid,
                        arg.shard.primary.zoneId,
                        'state-backfill -y', function (err, stdou, stder) {
                            if (err) {
                                return next(err);
                            }
                            return next();
                        });
            },

            function waitForPrimaryPG(_, next) {
                if (arg.HA) {
                    return next();
                }
                waitForPostgresUp(arg.shard.primary.server_uuid,
                        arg.shard.primary.zoneId, next);
            },

            // Something is setting the ONWM to off on this case, which should
            // not happen. Take it back
            function setONWM(_, next) {
                if (arg.HA) {
                    return next();
                }
                progress('Ensure ONE NODE WRITE MODE');
                manateeAdmRemote(arg.shard.primary.server_uuid,
                        arg.shard.primary.zoneId,
                        'set-onwm -m on -y', function (err, stdou, stder) {
                            if (err) {
                                return next(err);
                            }
                            return next();
                        });
            },

            // ------------ And, finally, the last HA couple ------------------
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
                    if (morRes) {
                        return next(morErr);
                    }
                    return next();
                });
            },

            function wait4Morays(_, next) {
                progress('Waiting (2mins) for moray services to be up');
                setTimeout(next, 120 * 1000);
            },

            function resetSapiToFullMode(_, next) {
                progress('Restoring SAPI to full mode');
                sdcadm.sapi.setMode('full', next);
            },

            function unfreezeClusterState(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Unfreezing cluster state');
                manateeAdmRemote(arg.shard.async.server_uuid,
                        arg.shard.async.zoneId,
                        'unfreeze', function (err, stdou, stder) {
                            if (err) {
                                return next(err);
                            }
                            return next();
                        });
            },

            function waitForShardHA(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Waiting for manatee shard to reach "async" status');
                waitForManatee('async',
                    arg.shard.async.server_uuid,
                    arg.shard.async.zoneId, function (err) {
                        if (err) {
                            if (err === 'deposed') {
                                var msg = 'manatee instance ' +
                                    arg.shard.primary.zoneId + ' on server ' +
                                    arg.shard.primary.server_uuid + ' is on ' +
                                    'deposed state. Please, log into this ' +
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
