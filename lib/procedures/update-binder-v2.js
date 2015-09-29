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
 * Procedure for updating binder.
 *
 * This is the second replacement for "upgrade-binder.sh" from the
 * incr-upgrade scripts.
 */
function UpdateBinderV2(options) {
    assert.arrayOfObject(options.changes, 'options.changes');
    this.changes = options.changes;
}
util.inherits(UpdateBinderV2, Procedure);

UpdateBinderV2.prototype.summarize = function ushiSummarize() {
    var word = (this.changes[0].type === 'rollback-service') ?
        'rollback' : 'update';
    var c0 = this.changes[0];
    var img = c0.image;
    var out = [sprintf('%s "%s" service to image %s (%s@%s)', word,
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

UpdateBinderV2.prototype.execute = function ushiExecute(opts, cb) {
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
    var rollback = opts.plan.rollback || false;

    function updateBinder(change, nextSvc) {
        var insts = change.insts || [change.inst];
        var leader;
        var standalone = false;
        var followers = [];

        var arg = {
            change: change,
            opts: opts,
            userScript: false,
            HA: false
        };

        if (insts && insts.length > 1) {
            arg.HA = true;
        }

        if (opts.plan.changes.length > 1) {
            progress('');
            progress('--- Updating %s ...', change.service.name);
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
                        } else if (r.mode === 'standalone') {
                            leader = r.instance;
                            standalone = true;
                        } else {
                            followers.push(r.instance);
                        }
                    });

                    return next();
                });
            }
        ];

        if (rollback) {
            funcs.push(s.getOldUserScript);
        } else {
            funcs.push(s.getUserScript);
            funcs.push(s.writeOldUserScriptForRollback);
        }


        funcs.push(function bailIfNoDelegateDataset(_, next) {
            vasync.forEachParallel({
                func: function bailIfBinderHasNoDelegate(inst, next_) {
                    var argv = [
                        '/opt/smartdc/bin/sdc-oneachnode',
                        '-j',
                        format('-n %s ', inst.server),
                        format('/usr/sbin/vmadm get %s', inst.zonename)
                    ];
                    var env = common.objCopy(process.env);
                    // Get 'debug' level logging in imgadm >=2.6.0 without
                    // triggering trace level logging in imgadm versions before
                    // that. Trace level logging is too much here.
                    env.IMGADM_LOG_LEVEL = 'debug';
                    var execOpts = {
                        encoding: 'utf8',
                        env: env
                    };
                    log.trace({argv: argv}, 'Looking for vm dataset');
                    function remoteCb(err, stdout, stderr) {
                        if (err) {
                            var msg = format(
                                'error looking for vm dataset %s:\n' +
                                '\targv: %j\n' +
                                '\texit status: %s\n' +
                                '\tstdout:\n%s\n' +
                                '\tstderr:\n%s', inst.alias,
                                argv, err.code, stdout.trim(), stderr.trim());
                            return next_(new errors.InternalError({
                                message: msg,
                                cause: err
                            }));
                        }

                        var expectedDs = sprintf('zones/%s/data',
                                inst.zonename);
                        var res = JSON.parse(stdout.trim())[0].result.stdout;
                        var vm = JSON.parse(res);
                        log.debug({
                            expectedDs: expectedDs,
                            vm: vm
                        }, 'binder vm');

                        if (vm.datasets.indexOf(expectedDs) === -1) {
                            return next_(new errors.UpdateError(format(
                                'binder vm %s has no "%s" delegate dataset, ' +
                                'upgrading it would lose image file data',
                                vm.uuid, expectedDs)));
                        }
                        next_();

                    }
                    execFile(argv[0], argv.slice(1), execOpts, remoteCb);
                },
                inputs: insts
            }, next);
        });

        funcs = funcs.concat([
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

            // Update everything but leader:

            function reprovisionFollowers(_, next) {
                if (!arg.HA) {
                    return next();
                }
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
                if (!arg.HA) {
                    return next();
                }
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
                if (!arg.HA) {
                    return next();
                }
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
                if (!arg.HA) {
                    return next();
                }
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
                if (!leader) {
                    return next();
                }
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
                if (!leader) {
                    return next();
                }
                progress('Wait (sleep) for %s instance %s to come up',
                    change.service.name, leader.zonename);
                setTimeout(next, 60 * 1000);
            },

            function checkAgainAllInstancesJoinedZkCluster(_, next) {
                if (!leader || standalone) {
                    return next();
                }
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
                if (!leader || standalone) {
                    return next();
                }
                progress('Waiting for zk leader to reach a steady state');
                var ips = insts.map(function (inst) {
                    return (inst.ip);
                });

                s.wait4ZkOk({
                    ips: ips,
                    log: opts.log
                }, next);
            }
        ]);
        vasync.pipeline({funcs: funcs, arg: arg}, nextSvc);
    }

    vasync.forEachPipeline({
        inputs: self.changes,
        func: updateBinder
    }, cb);
};
//---- exports

module.exports = {
    UpdateBinderV2: UpdateBinderV2
};
// vim: set softtabstop=4 shiftwidth=4:
