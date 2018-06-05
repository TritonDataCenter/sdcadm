/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018 Joyent, Inc.
 */

/*
 * Zookeeper related steps shared across different sdcadm subcommands
 */
var fs = require('fs');
var path = require('path');
var util = require('util');

var assert = require('assert-plus');
var mkdirp = require('mkdirp');
var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');
var shared = require('../procedures/shared');

/*
 * Not exported helper functions
 */
function execFileAndParseJSONOutput(opts, cb) {
    assert.object(opts, 'opts');
    assert.array(opts.argv, 'opts.argv');
    assert.object(opts.log, 'opts.log');
    assert.func(cb, 'cb');

    common.execFilePlus({
        argv: opts.argv,
        log: opts.log
    }, function execFilePlusCb(execErr, stdout, stderr) {
        if (execErr) {
            cb(execErr);
            return;
        }
        var res, parseErr;
        try {
            // Due to the -j option of sdc-oneachnode:
            res = JSON.parse(stdout);

        } catch (e) {
            parseErr = e;
            opts.log.error({
                err: e,
                stdout: stdout,
                stderr: stderr,
                argv: opts.argv
            }, 'sdc-oneachnode execFileAndParseJSONOutput');
        }
        var out = res[0].result.stdout.trim() || null;
        var err = res[0].result.stderr.trim() || null;
        opts.log.debug({
            stdout: out,
            stderr: err,
            argv: opts.argv
        }, 'sdc-oneachnode execFileAndParseJSONOutput');
        cb(parseErr);
    });
}


function execRemoteOnVm(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.cmd, 'opts.cmd');
    assert.uuid(opts.vm_uuid, 'opts.vm_uuid');
    assert.uuid(opts.server_uuid, 'opts.server_uuid');
    assert.object(opts.log, 'opts.log');
    assert.func(cb, 'cb');

    common.execRemote({
        cmd: opts.cmd,
        vm: opts.vm_uuid,
        server: opts.server_uuid,
        log: opts.log
    }, function execRemoteCb(err, stdout, stderr) {
        if (err) {
            cb(err);
            return;
        }
        if (stderr) {
            cb(new errors.InternalError({
                message: stderr
            }));
            return;
        }
        cb();
    });
}


/*
 * Create a backup of Zookeeper's data directory
 * (/zookeeper/zookeeper/version-2) which can be used to rebuild the status
 * of the ZK system by replaying the transaction log.
 *
 * This can be used by new machines to reach the status the leader is at
 * at the moment of the backup creation.
 *
 * The callback function should have the signature:
 *      `callback(err, backupDirTimestamp)`
 */
function backupZKData(opts, callback) {
    assert.object(opts, 'opts');
    assert.func(opts.progress, 'opts.progress');
    assert.optionalObject(opts.ctx, 'opts.ctx');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.sdcadm.sdcApp, 'opts.sdcadm.sdcApp');
    assert.func(callback, 'callback');

    var sdcadm = opts.sdcadm;
    var context = opts.ctx || {};
    var app = sdcadm.sdcApp;

    vasync.pipeline({arg: context, funcs: [
        function getBinderSvc(ctx, next) {
            if (ctx.binderSvc) {
                next();
                return;
            }
            sdcadm.sapi.listServices({
                name: 'binder',
                application_uuid: app.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    next(svcErr);
                    return;
                }
                if (svcs.length) {
                    ctx.binderSvc = svcs[0];
                }
                next();
            });
        },

        function getBinderInsts(ctx, next) {
            if (ctx.binderInsts) {
                next();
                return;
            }
            sdcadm.sapi.listInstances({
                service_uuid: ctx.binderSvc.uuid
            }, function (instErr, insts) {
                if (instErr) {
                    next(instErr);
                    return;
                }
                ctx.binderInsts = insts;
                next();
            });
        },

        function getBinderVms(ctx, next) {
            if (ctx.binderVms && ctx.binderIps) {
                next();
                return;
            }
            sdcadm.vmapi.listVms({
                'tag.smartdc_role': 'binder',
                state: 'running'
            }, function vmapiCb(vmsErr, vms) {
                if (vmsErr) {
                    next(vmsErr);
                    return;
                }
                ctx.binderVms = vms;
                // Binder instances have only admin Ips:
                ctx.binderIps = vms.map(function ipFromNic(vm) {
                    return (vm.nics[0].ip);
                });
                next();
            });
        },
        // Sets `ctx.wrkDir` and creates the directory. Also sets `ctx.stamp`.
        function createWrkDir(ctx, next) {
            var start = new Date();
            ctx.stamp = common.utcTimestamp(start);
            ctx.wrkDir = '/var/sdcadm/ha-binder/' + ctx.stamp;
            opts.progress('Create work dir: ' + ctx.wrkDir);

            mkdirp(ctx.wrkDir, function (err) {
                if (err) {
                    next(new errors.InternalError({
                        message: 'error creating work dir: ' + ctx.wrkDir,
                        cause: err
                    }));
                    return;
                }
                next();
            });
        },

        function disableZkForBakup(ctx, next) {
            ctx._1stVm = ctx.binderVms[0];
            opts.progress('Disabling zookeeper for data backup');
            shared.disableRemoteSvc({
                server: ctx._1stVm.server_uuid,
                zone: ctx._1stVm.uuid,
                fmri: 'zookeeper',
                log: opts.log
            }, next);
        },

        function backupZookeeperData(ctx, next) {
            opts.progress('Creating backup of zookeeper data directory ' +
                    '(this may take some time)');
            execRemoteOnVm({
                cmd: 'cd /zookeeper/zookeeper; ' +
                    '/opt/local/bin/tar czf zookeeper-' + ctx.stamp +
                    '.tgz version-2',
                vm_uuid: ctx._1stVm.uuid,
                server_uuid: ctx._1stVm.server_uuid,
                log: opts.log
            }, next);
        },

        function enableZkAfterBackup(ctx, next) {
            opts.progress('Enabling zookeeper after data backup');
            shared.enableRemoteSvc({
                server: ctx._1stVm.server_uuid,
                zone: ctx._1stVm.uuid,
                fmri: 'zookeeper',
                log: opts.log
            }, next);
        },

        function copyZkBackupToWorkDir(ctx, next) {
            opts.progress('Copying backup of zookeeper data to: %s',
                ctx.wrkDir);
            var argv = [
                '/opt/smartdc/bin/sdc-oneachnode',
                '-j',
                '-T',
                '300',
                '-n',
                ctx._1stVm.server_uuid,
                '-p',
                util.format(
                    '/zones/%s/root/zookeeper/zookeeper/zookeeper-%s.tgz',
                    ctx.binderVms[0].uuid, ctx.stamp
                ),
                '--clobber',
                '-d',
                ctx.wrkDir
            ];

            execFileAndParseJSONOutput({
                argv: argv,
                log: opts.log
            }, next);
        },

        function renameZkBackup(ctx, next) {
            ctx.fname = path.join(ctx.wrkDir,
                    util.format('zookeeper-%s.tgz', ctx.stamp));
            opts.progress('Moving backup of zookeeper data to: %s', ctx.fname);
            fs.rename(
                path.join(ctx.wrkDir, ctx._1stVm.server_uuid),
                ctx.fname, next);
        }

    ]}, function pipeCb(err) {
        callback(err, context.stamp);
    });
}


/*
 * Replace binder's VM zookeeper's data directory with the contents of
 * a previously made ZK's data backup.
 */
function replaceZKData(opts, callback) {
    assert.object(opts, 'opts');
    assert.func(opts.progress, 'opts.progress');
    assert.object(opts.vm, 'opts.vm');
    assert.uuid(opts.vm.uuid, 'opts.vm.uuid');
    assert.uuid(opts.vm.server_uuid, 'opts.vm.server_uuid');
    assert.string(opts.stamp, 'opts.stamp');
    assert.object(opts.log, 'opts.log');
    assert.func(callback, 'callback');

    var vm = opts.vm;
    var workingDir = '/var/sdcadm/ha-binder/' + opts.stamp;
    var context = {
        stamp: opts.stamp,
        wrkDir: workingDir,
        fname: path.join(workingDir,
                    util.format('zookeeper-%s.tgz', opts.stamp))
    };

     vasync.pipeline({arg: context, funcs: [
         function disableZk(_, next) {
             opts.progress('Disabling zookeeper in ' + vm.uuid);
             shared.disableRemoteSvc({
                server: vm.server_uuid,
                zone: vm.uuid,
                fmri: 'zookeeper',
                log: opts.log
            }, next);
         },

        // rm -Rf /zookeeper/zookeeper/version-2 from the instance
        function removeZkDataFromInst(_, next) {
            opts.progress('Clearing zookeeper data into ' + vm.uuid);
            execRemoteOnVm({
                cmd: 'rm -Rf /zookeeper/zookeeper/version-2',
                vm_uuid: vm.uuid,
                server_uuid: vm.server_uuid,
                log: opts.log
            }, next);
        },

        // Copy data from provided backup into the binder instance
        function copyZkDataIntoNewInsts(ctx, next) {
            opts.progress('Copying zookeeper data into ' + vm.uuid);

            var argv = [
                '/opt/smartdc/bin/sdc-oneachnode',
                '-j',
                '-T',
                '300',
                '-n',
                vm.server_uuid,
                '-g',
                ctx.fname,
                '--clobber',
                '-d',
                util.format('/zones/%s/root/zookeeper/zookeeper',
                        vm.uuid)
            ];
            execFileAndParseJSONOutput({
                argv: argv,
                log: opts.log
            }, next);
        },
        // Untar data from backup into the new binder instance
        function untarZkDataIntoNewInst(ctx, next) {
            opts.progress('Extracting zookeeper data into instance ' +
                vm.uuid + ' (may take some time)');
            execRemoteOnVm({
                cmd: 'cd /zookeeper/zookeeper; ' +
                    '/opt/local/bin/tar xf zookeeper-' +
                    ctx.stamp + '.tgz',
                vm_uuid: vm.uuid,
                server_uuid: vm.server_uuid,
                log: opts.log
            }, next);
        },
        // enable zookeeper into the new binder instances
        function enableZkIntoNewInsts(_, next) {
            opts.progress('Enabling zookeeper into instance ' + vm.uuid);
            shared.enableRemoteSvc({
                server: vm.server_uuid,
                zone: vm.uuid,
                fmri: 'zookeeper',
                log: opts.log
            }, next);
        }

     ]}, function pipeCb(pipeErr) {
         callback(pipeErr);
     });
}

function clearZKBackup(opts, callback) {
    assert.object(opts, 'opts');
    assert.func(opts.progress, 'opts.progress');
    assert.object(opts.vm, 'opts.vm');
    assert.uuid(opts.vm.uuid, 'opts.vm.uuid');
    assert.uuid(opts.vm.server_uuid, 'opts.vm.server_uuid');
    assert.string(opts.stamp, 'opts.stamp');
    assert.object(opts.log, 'opts.log');
    assert.func(callback, 'callback');

    var vm = opts.vm;
    opts.progress('Removing zookeeper data backup from %s',
            vm.uuid);
    execRemoteOnVm({
        cmd: 'rm /zookeeper/zookeeper/zookeeper-' + opts.stamp + '.tgz',
        vm_uuid: vm.uuid,
        server_uuid: vm.server_uuid,
        log: opts.log
    }, callback);
}

/*
 * We usually gather all the information about `sdc` application, binder,
 * manatee, moray instances before we attempt any configuration changes,
 * just in case any of our services didn't come up clear.
 *
 * Expected callback signature is `function(err, context)` where the
 * returned `context` object will contain the properties:
 * - moraySvc (Object)
 * - manateeSvc (Object)
 * - morayVms (Array of VM Objects)
 * - manateeVms (Array of VM Objects)
 * - shard (Manatee Shard Object including server uuids for every VM)
 * - hasManatee21 (Boolean)
 *
 */
function getCoreZkConfig(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.progress, 'opts.progress');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.sdcadm.sdcApp, 'opts.sdcadm.sdcApp');
    assert.func(callback, 'callback');

    var app = opts.sdcadm.sdcApp;
    var context = {};

    vasync.pipeline({arg: context, funcs: [
        function getMorayService(ctx, next) {
            opts.progress('Getting SDC\'s moray details from SAPI');
            opts.sdcadm.sapi.listServices({
                name: 'moray',
                application_uuid: app.uuid
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
                ctx.moraySvc = svcs[0];
                next();
            });
        },

        function getMorayVms(ctx, next) {
            opts.progress('Getting SDC\'s moray vms from VMAPI');
            opts.sdcadm.vmapi.listVms({
                'tag.smartdc_role': 'moray',
                state: 'running'
            }, function (vmsErr, vms) {
                if (vmsErr) {
                    next(vmsErr);
                    return;
                }
                ctx.morayVms = vms;
                next();
            });
        },

        function getManateeService(ctx, next) {
            opts.progress('Getting SDC\'s manatee details from SAPI');
            opts.sdcadm.sapi.listServices({
                name: 'manatee',
                application_uuid: app.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    next(svcErr);
                    return;
                }
                if (!svcs.length) {
                    next(new errors.SDCClientError(new Error(
                        'No services named "manatee"'), 'sapi'));
                    return;
                }
                ctx.manateeSvc = svcs[0];
                next();
            });
        },

        function getManateeVms(ctx, next) {
            opts.progress('Getting SDC\'s manatees vms from VMAPI');
            opts.sdcadm.vmapi.listVms({
                'tag.smartdc_role': 'manatee',
                state: 'running'
            }, function (vmsErr, vms) {
                if (vmsErr) {
                    next(vmsErr);
                    return;
                }
                ctx.manateeVms = vms;
                next();
            });
        },

        function getShard(ctx, next) {
            opts.progress('Getting manatee shard status');
            var vm = ctx.manateeVms[0];

            shared.getShardState({
                server: vm.server_uuid,
                manateeUUID: vm.uuid,
                log: opts.log
            }, function getShardStateCb(err, st) {
                if (err) {
                    next(err);
                    return;
                }
                ctx.shard = st;
                // Also set server uuid for each one of the manatees on the
                // shard to simplify next steps:
                ctx.manateeVms.forEach(function setShardVmServer(v) {
                    var primary = ctx.shard.primary;
                    var sync = ctx.shard.sync;
                    var async = ctx.shard.async;
                    if (primary.zoneId === v.uuid) {
                        ctx.shard.primary.server = v.server_uuid;
                    } else if (sync && sync.zoneId === v.uuid) {
                        ctx.shard.sync.server = v.server_uuid;
                    } else if (async && async.length) {
                        ctx.shard.async = async.map(function (v2) {
                            if (v2.zoneId === v.uuid) {
                                v2.server = v.server_uuid;
                            }
                            return (v2);
                        });
                    }
                });
                next();
            });
        },

        // Check manatee-adm version in order to take advantage of latest
        // available sub-commands if possible:
        function getManateeVersion(ctx, next) {
            opts.sdcadm.imgapi.getImage(ctx.manateeVms[0].image_uuid, {
            }, function getImgCb(err, image) {
                if (err) {
                    next(err);
                } else {
                    var parts = image.version.split('-');
                    var curVer = parts[parts.length - 2];
                    if (curVer >= '20150320T174220Z') {
                        ctx.hasManatee21 = true;
                    }
                    next();
                }
            });
        }

    ]}, function pipeCb(pipeErr) {
        callback(pipeErr, context);
    });
}

/*
 * Once we've added one or more binder instances, we need to reconfigure
 * everything from `sdc` application to all the services where ZK_SERVERS
 * are included, alongside with all those service's instances, including
 * synchronous calls to config agent everywhere
 */
function updateCoreZkConfig(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.ctx, 'opts.ctx');

    assert.object(opts.ctx.binderInsts, 'opts.ctx.binderInsts');
    assert.object(opts.ctx.binderVms, 'opts.ctx.binderVms');
    assert.object(opts.ctx.binderIps, 'opts.ctx.binderIps');
    assert.object(opts.ctx.moraySvc, 'opts.ctx.moraySvc');
    assert.object(opts.ctx.manateeSvc, 'opts.ctx.manateeSvc');
    assert.object(opts.ctx.manateeVms, 'opts.ctx.manateeVms');
    assert.bool(opts.ctx.hasManatee21, 'opts.ctx.hasManatee21');
    assert.object(opts.ctx.morayVms, 'opts.ctx.morayVms');

    assert.object(opts.log, 'opts.log');
    assert.func(opts.progress, 'opts.progress');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.sdcadm.sdcApp, 'opts.sdcadm.sdcApp');
    assert.func(callback, 'callback');

    var app = opts.sdcadm.sdcApp;
    var context = Object.assign({
        HA_ZK_JSON: []
    }, opts.ctx);

    vasync.pipeline({arg: context, funcs: [

        function prepareClusterPayload(ctx, next) {
            ctx.binderVms.forEach(function jsonFromInst(vm) {
                var instance = ctx.binderInsts.filter(function (i) {
                    return (i.uuid === vm.uuid);
                })[0];

                ctx.HA_ZK_JSON.push({
                    host: vm.nics[0].ip,
                    port: 2181,
                    num: Number(instance.metadata.ZK_ID)
                });
            });

            // Set a value for special property "last" for just the final
            // element of the collection
            ctx.HA_ZK_JSON[ctx.HA_ZK_JSON.length - 1].last = true;
            next();
        },

        function cfgSdcApp(ctx, next) {
            opts.progress('Updating Binder service config in SAPI');
            opts.sdcadm.sapi.updateApplication(app.uuid, {
                metadata: {
                    ZK_SERVERS: ctx.HA_ZK_JSON
                }
            }, next);
        },

        // Set ZK_SERVERS, not ZK_HA_SERVERS
        function cfgMoraySvc(ctx, next) {
            opts.progress('Updating Moray service config in SAPI');
            opts.sdcadm.sapi.updateService(ctx.moraySvc.uuid, {
                metadata: {
                    ZK_SERVERS: ctx.HA_ZK_JSON
                }
            }, next);
        },

        // Set ZK_SERVERS, not ZK_HA_SERVERS
        function cfgManateeSvc(ctx, next) {
            opts.progress('Updating Manatee service config in SAPI');
            opts.sdcadm.sapi.updateService(ctx.manateeSvc.uuid, {
                metadata: {
                    ZK_SERVERS: ctx.HA_ZK_JSON
                }
            }, next);
        },

        // Call config-agent sync for all the binder VMs
        function callConfigAgentSyncForAllBinders(ctx, next) {
            opts.progress('Reloading config for all the binder VMs');
            vasync.forEachParallel({
                inputs: ctx.binderVms,
                func: function callCfgSync(vm, nextInst) {
                    common.callConfigAgentSync({
                        vm: vm.uuid,
                        server: vm.server_uuid,
                        log: opts.log
                    }, nextInst);
                }
            }, next);
        },

        function waitForZkClusterOk(ctx, next) {
            opts.progress('Waiting for ZK cluster to reach a steady state');

            shared.wait4ZkOk({
                ips: ctx.binderIps,
                log: opts.log
            }, next);
        },

        function checkAllInstancesJoinedZkCluster(ctx, next) {
            opts.progress('Waiting for binder instances to join ZK cluster');

            shared.wait4ZkCluster({
                ips: ctx.binderIps,
                log: opts.log
            }, next);
        },

        function getZkLeaderIP(ctx, next) {
            opts.progress('Getting ZK leader IP');

            shared.getZkLeaderIP({
                ips: ctx.binderIps,
                log: opts.log
            }, function (err, ip) {
                if (err) {
                    next(err);
                    return;
                }
                ctx.leaderIP = ip;
                next();
            });
        },



        // Call config-agent sync for all the manatee VMs
        function callConfigAgentSyncForAllManatees(ctx, next) {
            opts.progress('Reloading config for all the manatee VMs');
            vasync.forEachParallel({
                inputs: ctx.manateeVms,
                func: function callCfgSync(vm, next_) {
                    common.callConfigAgentSync({
                        vm: vm.uuid,
                        server: vm.server_uuid,
                        log: opts.log
                    }, next_);
                }
            }, next);
        },

        // HUP Manatee (Already waits for manatee shard to
        // reach the desired status):
        function disableManatee(ctx, next) {
            shared.disableManateeSitter({
                progress: opts.progress,
                log: opts.log,
                leaderIP: ctx.leaderIP,
                shard: ctx.shard,
                hasManatee21: ctx.hasManatee21
            }, next);
        },

        function enableManatee(ctx, next) {
            shared.enableManateeSitter({
                progress: opts.progress,
                log: opts.log,
                leaderIP: ctx.leaderIP,
                shard: ctx.shard,
                hasManatee21: ctx.hasManatee21
            }, next);
        },

        // Call config-agent sync for all the moray VMs
        function callConfigAgentSyncForAllMorays(ctx, next) {
            opts.progress('Reloading config for all the moray VMs');
            vasync.forEachParallel({
                inputs: ctx.morayVms,
                func: function callCfgSync(vm, next_) {
                    common.callConfigAgentSync({
                        vm: vm.uuid,
                        server: vm.server_uuid,
                        log: opts.log
                    }, next_);
                }
            }, next);
        },

        // HUP morays:
        function restartMorays(ctx, next) {
            opts.progress('Restarting moray services');
            vasync.forEachParallel({
                inputs: ctx.morayVms,
                func: function restartMoray(vm, next_) {
                    shared.restartRemoteSvc({
                        server: vm.server_uuid,
                        zone: vm.uuid,
                        fmri: '*moray-202*',
                        log: opts.log
                    }, next_);
                }
            }, next);
        },

        function wait4Morays(ctx, next) {
            opts.progress('Waiting for moray services to be up into' +
                    ' every moray instance');
            shared.wait4Morays({
                vms: ctx.morayVms,
                sdcadm: opts.sdcadm
            }, next);
        },

        function unfreezeManatee(ctx, next) {
            opts.progress('Unfreezing manatee shard');
            common.manateeAdmRemote({
                server: ctx.manateeVms[0].server_uuid,
                vm: ctx.manateeVms[0].uuid,
                cmd: 'unfreeze',
                log: opts.log
            }, function (err, _, stder) {
                if (err) {
                    next(err);
                    return;
                } else if (stder) {
                    next(new errors.InternalError({
                        message: stder
                    }));
                    return;
                }
                next();
            });
        }

    ]}, callback);
}

// --- exports

module.exports = {
    backupZKData: backupZKData,
    replaceZKData: replaceZKData,
    clearZKBackup: clearZKBackup,
    getCoreZkConfig: getCoreZkConfig,
    updateCoreZkConfig: updateCoreZkConfig
};

// vim: set softtabstop=4 shiftwidth=4:
