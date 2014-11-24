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
var vasync = require('vasync');

var errors = require('../errors'),
    InternalError = errors.InternalError;
var common = require('../common');
var vmadm = require('../vmadm');
var svcadm = require('../svcadm');

var Procedure = require('./procedure').Procedure;
var s = require('./shared');
/**
 * Procedure for updating zookeeper service, HA
 */
function UpdateZookeeperV2(options) {
    assert.arrayOfObject(options.changes, 'options.changes');
    this.changes = options.changes;
}
util.inherits(UpdateZookeeperV2, Procedure);

UpdateZookeeperV2.prototype.summarize = function zKv2Summarize() {
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


UpdateZookeeperV2.prototype.execute = function zKv2Execute(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.plan, 'opts.plan');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.progress, 'opts.progress');
    assert.string(opts.wrkDir, 'opts.wrkDir');
    assert.func(cb, 'cb');
    var self = this;
    var progress = opts.progress;


    function updateZookeeper(change, nextSvc) {
        // We assume HA for zookeeper, given it should be installed using
        // sdcadm post-setup zookeeper, which creates a minimum of 3 cluster
        // members:
        var insts = change.insts;
        var leader;
        var followers = [];

        var arg = {
            change: change,
            opts: opts,
            userScript: false,
            HA: false
        };

        var sapiUUID;

        if (insts && insts.length > 1) {
            arg.HA = true;
        } else {
            return cb(new errors.UsageError(
                'Cannot update a single zookeeper instance. Please, run ' +
                '\'sdcadm post-setup zookeeper\' to complete the zookeeper ' +
                'install before you try upgrades.'));
        }

        var funcs = [
            function findZkLeader(_, next) {
                progress('Looking for zk leader');
                vasync.forEachParallel({
                    inputs: insts,
                    func: function zkInstStatus(inst, next_) {
                        var c = format(
                            'echo stat | nc %s 2181 | grep -i "mode"', inst.ip);
                        common.execPlus({
                            cmd: c,
                            log: opts.log
                        }, function (err, stdout, stderr) {
                            if (err) {
                                // The command throws an error while ZK is
                                // transitioning from standalone to cluster
                                next_(null, {
                                    instance: inst,
                                    mode: 'transitioning'
                                });
                            } else {
                                next_(null, {
                                    instance: inst,
                                    mode: stdout.trim().replace(/^Mode:\s/, '')
                                });
                            }
                        });
                    }
                }, function (err, res) {
                    if (err) {
                        return next(err);
                    }

                    res.successes.filter(function (r) {
                        if (r.mode === 'leader') {
                            leader = r.instance;
                        } else {
                            followers.push(r.instance);
                        }
                    });

                    if (!leader) {
                        return next(new errors.InternalError(
                            'Unable to find zookeeper leader, aborting'));
                    }

                    return next();
                });
            },

            s.getUserScript,
            s.writeOldUserScriptForRollback,
            s.updateSvcUserScript,

            function updateVmsUserScript(_, next) {
                vasync.forEachParallel({
                    func: function (inst, next_) {
                        s.updateVmUserScriptRemote({
                            service: change.service,
                            progress: progress,
                            zonename: inst.zonename,
                            log: opts.log,
                            server: inst.server,
                            userScript: arg.userScript
                        }, next_);
                    },
                    inputs: insts
                }, next);
            },

            s.updateSapiSvc,

            function installVmsImg(_, next) {
                // Pipeline, not parallel, just in case we have several
                // instances on the same server:
                vasync.forEachPipeline({
                    inputs: insts,
                    func: function installVmImg(inst, next_) {
                        s.imgadmInstallRemote({
                            progress: progress,
                            img: change.image,
                            log: opts.log,
                            server: inst.server
                        }, next_);
                    }
                }, next);
            },


            // We need to hack SAPI_PROTO_MODE and turn
            // it back on during the time we're gonna have zk down.
            // Otherwise, config-agent will try to publish the zk zone IP
            // to SAPI and, if in full mode, it will obviously fail due to no
            // manatee. We don't know if this will happen for one of the
            // followers or for the leader, therefore, we'll wrap the whole
            // process from here.
            // TODO(pedro): This is a dupe of manatee no-HA, move into shared.
            // TODO(pedro): Drop all this stuff if we make manatee-HA a
            // requirement for `sdcadm update`
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
                    log: opts.log
                }, function (err, stdout, stderr) {
                    if (err) {
                        next(err);
                    } else {
                        var sapis = stdout.trim().split('\n');
                        sapiUUID = sapis[0];
                        opts.log.debug('Local sapi instance found: %s',
                            sapiUUID);
                        next();
                    }
                });
            },
            // Do not try this at home!. This is just a hack for no-HA setups,
            // solely for testing/development purposes; any reasonable manatee
            // setup must have HA.
            function setSapiProtoMode(_, next) {
                progress('Temporary set SAPI back to proto mode');
                var argv = [
                    '/usr/sbin/zlogin',
                    sapiUUID,
                    '/usr/sbin/mdata-put SAPI_PROTO_MODE true'
                ];
                common.execFilePlus({
                    argv: argv,
                    log: opts.log
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
                    log: opts.log
                }, next);
            },

            // Update everything but leader:

            function reprovisionFollowers(_, next) {
                vasync.forEachPipeline({
                    inputs: followers,
                    func: function reprovFollower(inst, next_) {
                        s.reprovisionRemote({
                            server: inst.server,
                            img: change.image,
                            zonename: inst.zonename,
                            progress: progress,
                            log: opts.log
                        }, next_);
                    }
                }, next);
            },

            function waitFollowers(_, next) {
                vasync.forEachPipeline({
                    inputs: followers,
                    func: function waitFollower(inst, next_) {
                        progress('Wait (sleep) for %s instance %s to come up',
                            change.service.name, inst.zonename);
                        setTimeout(next_, 60 * 1000);
                    }
                }, next);
            },

            function checkAllInstancesJoinedZkCluster(_, next) {
                progress('Waiting for zk instances to re-join ZK cluster');
                var ips = insts.map(function (inst) {
                    return (inst.ip);
                });

                s.wait4ZkCluster({
                    ips: ips,
                    log: opts.log
                }, next);
            },

            function waitForZkClusterOk(_, next) {
                progress('Waiting for ZK cluster to reach a steady state');
                var ips = insts.map(function (inst) {
                    return (inst.ip);
                });

                s.wait4ZkOk({
                    ips: ips,
                    log: opts.log
                }, next);
            },

            function reprovisionLeader(_, next) {
                progress('Updating ZK leader');
                s.reprovisionRemote({
                    server: leader.server,
                    img: change.image,
                    zonename: leader.zonename,
                    progress: progress,
                    log: opts.log
                }, next);
            },

            function waitForLeader(_, next) {
                progress('Wait (sleep) for %s instance %s to come up',
                    change.service.name, leader.zonename);
                setTimeout(next, 60 * 1000);
            },

            function checkAgainAllInstancesJoinedZkCluster(_, next) {
                progress('Waiting for zk leader to re-join ZK cluster');
                var ips = insts.map(function (inst) {
                    return (inst.ip);
                });

                s.wait4ZkCluster({
                    ips: ips,
                    log: opts.log
                }, next);
            },

            function waitAgainForZkClusterOk(_, next) {
                progress('Waiting for zk leader to reach a steady state');
                var ips = insts.map(function (inst) {
                    return (inst.ip);
                });

                s.wait4ZkOk({
                    ips: ips,
                    log: opts.log
                }, next);
            },
            // TODO(pedro): Remove if we make manatee-HA a requirement of
            // `sdcadm update`.
            function resetSapiToFullMode(_, next) {
                progress('Restoring SAPI to full mode');
                opts.sdcadm.sapi.setMode('full', next);
            }
        ];
        vasync.pipeline({funcs: funcs, arg: arg}, nextSvc);
    }

    vasync.forEachPipeline({
        inputs: self.changes,
        func: updateZookeeper
    }, cb);
};
//---- exports

module.exports = {
    UpdateZookeeperV2: UpdateZookeeperV2
};
// vim: set softtabstop=4 shiftwidth=4:
