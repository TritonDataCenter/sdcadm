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
var util = require('util');
var format = util.format;
var child_process = require('child_process');
var execFile = child_process.execFile;
var vasync = require('vasync');

var errors = require('../errors');
var common = require('../common');

var Procedure = require('./procedure').Procedure;
var s = require('./shared');

/**
 * Procedure for updating binder.
 *
 * This is the second replacement for "upgrade-binder.sh" from the
 * incr-upgrade scripts.
 *
 */
function UpdateBinderV2(options) {
    assert.arrayOfObject(options.changes, 'options.changes');
    this.changes = options.changes;
}
util.inherits(UpdateBinderV2, Procedure);

UpdateBinderV2.prototype.summarize = function ushiSummarize() {
    return this.changes.map(function (ch) {
        var out;
        if (ch.type === 'update-instance') {
            out = [sprintf('update instance "%s" (%s)',
                        ch.inst.instance, ch.inst.alias),
                    common.indent(sprintf('of service "%s" to image %s',
                        ch.service.name, ch.image.uuid)),
                    common.indent(sprintf('(%s@%s)',
                        ch.image.name, ch.image.version), 8)];
        } else {
            var img = ch.image;
            var word = (ch.type === 'rollback-service') ?
                'rollback' : 'update';

            out = [sprintf('%s "%s" service to image %s', word,
                            ch.service.name, img.uuid),
                        common.indent(sprintf('(%s@%s)',
                            img.name, img.version))];
            if (ch.insts) {
                out[0] += ':';
                out = out.concat(ch.insts.map(function (inst) {
                    if (inst.image === img.uuid) {
                        return common.indent(sprintf(
                            'instance "%s" (%s) is already at version %s',
                            inst.zonename, inst.alias, img.version));
                    } else {
                        return common.indent(sprintf(
                            'instance "%s" (%s) on server %s',
                            inst.zonename, inst.alias, inst.server));
                    }
                }));
            }
        }
        return out.join('\n');
    }).join('\n');
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
    var sdcadm = opts.sdcadm;
    var log = opts.log;
    var progress = opts.progress;
    var rollback = opts.plan.rollback || false;

    function updateBinder(change, nextSvc) {
        var insts = change.insts || [change.inst];

        var arg = {
            change: change,
            opts: opts,
            userScript: false,
            HA: true,
            /*
             * UUIDs of the binder instances with a zookeeper role of followers
             *
             */
            followers: [],
            /*
             * UUID of the binder instance with zookeeper role of leader
             */
            leader: null,
            /*
             * Instance Object. Leader instance, in case that it will be
             * updated during the current process.
             */
            leaderInst: null,
            /*
             * Array of Instance Objects. Follower instances that will be
             * updated. Note that it might not be all of them.
             */
            followerInsts: [],
            /*
             * Is zookeeper running in standalone mode?
             */
            standalone: false
        };

        if (opts.plan.changes.length > 1) {
            progress('');
            progress('--- Updating %s ...', change.service.name);
        }

        var funcs = [
            /*
             * Do not rely into instances provided by change, make sure we get
             * all the binder instances from VMAPI to find ZK leader.
             */
            function getAllBinderVms(ctx, next) {
                progress('Getting Triton\'s binder instances');
                sdcadm.listInsts({
                    svcs: ['binder']
                }, function (instsErr, instances) {
                    if (instsErr) {
                        next(instsErr);
                        return;
                    }
                    ctx.allInsts = instances;
                    next();
                });
            },
            /*
             * We'll take advantage of this function to fill ctx.binderIps
             * variable, since we'll need it for several steps below.
             */
            function findZkLeader(ctx, next) {
                ctx.binderIps = [];
                progress('Looking for zk leader');
                vasync.forEachParallel({
                    inputs: ctx.allInsts,
                    func: function zkInstStatus(vm, next_) {
                        ctx.binderIps.push(vm.ip);
                        var c = format(
                            'echo stat | nc %s 2181 | grep -i "mode"', vm.ip);
                        common.execPlus({
                            cmd: c,
                            log: opts.log
                        }, function (err, stdout, _) {
                            if (err) {
                                // The command throws an error while ZK is
                                // transitioning from standalone to cluster
                                next_(null, {
                                    instance: vm.zonename,
                                    mode: 'transitioning'
                                });
                            } else {
                                next_(null, {
                                    instance: vm.zonename,
                                    mode: stdout.trim().replace(/^Mode:\s/, '')
                                });
                            }
                        });
                    }
                }, function (err, res) {
                    if (err) {
                        next(err);
                        return;
                    }

                    res.successes.filter(function (r) {
                        if (r.mode === 'leader') {
                            ctx.leader = r.instance;
                        } else if (r.mode === 'standalone') {
                            ctx.leader = r.instance;
                            ctx.standalone = true;
                            ctx.HA = false;
                        } else {
                            ctx.followers.push(r.instance);
                        }
                    });
                    next();
                });
            },
            /*
             * Once we know zookeeper roles, we can populate the variables
             * ctx.leaderInst and ctx.followerInsts appropriately.
             */
            function classifyInstances(ctx, next) {
                insts.forEach(function (ins) {
                    if (ins.zonename === ctx.leader) {
                        ctx.leaderInst = ins;
                    } else {
                        ctx.followerInsts.push(ins);
                    }
                });
                next();
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
                            next_(new errors.InternalError({
                                message: msg,
                                cause: err
                            }));
                            return;
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
                            next_(new errors.UpdateError(format(
                                'binder vm %s has no "%s" delegate dataset, ' +
                                'upgrading it would lose image file data',
                                vm.uuid, expectedDs)));
                            return;
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

            function updateVmsUserScript(ctx, next) {
                vasync.forEachParallel({
                    func: function (inst, next_) {
                        s.updateVmUserScriptRemote({
                            service: ctx.change.service,
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

            function installVmsImg(ctx, next) {
                // Pipeline, not parallel, just in case we have several
                // instances on the same server:
                vasync.forEachPipeline({
                    inputs: insts,
                    func: function installVmImg(inst, next_) {
                        s.imgadmInstallRemote({
                            progress: progress,
                            img: ctx.change.image,
                            log: opts.log,
                            server: inst.server
                        }, next_);
                    }
                }, next);
            },

            // Update everything but leader:

            function reprovisionFollowers(ctx, next) {
                if (!ctx.HA || !ctx.followerInsts.length) {
                    next();
                    return;
                }
                vasync.forEachPipeline({
                    inputs: ctx.followerInsts,
                    func: function reprovFollower(inst, next_) {
                        s.reprovisionRemote({
                            server: inst.server,
                            img: ctx.change.image,
                            zonename: inst.zonename,
                            progress: progress,
                            log: opts.log,
                            sdcadm: opts.sdcadm
                        }, next_);
                    }
                }, next);
            },

            function waitFollowers(ctx, next) {
                if (!ctx.HA || !ctx.followerInsts.length) {
                    next();
                    return;
                }
                vasync.forEachPipeline({
                    inputs: ctx.followerInsts,
                    func: function waitFollower(inst, next_) {
                        progress('Wait (sleep) for %s instance %s to come up',
                            ctx.change.service.name, inst.zonename);
                        setTimeout(next_, 60 * 1000);
                    }
                }, next);
            },

            function checkAllInstancesJoinedZkCluster(ctx, next) {
                if (!ctx.HA || !ctx.followerInsts.length) {
                    next();
                    return;
                }
                progress('Waiting for zk instances to re-join ZK cluster');

                s.wait4ZkCluster({
                    ips: ctx.binderIps,
                    log: opts.log
                }, next);
            },

            function waitForZkClusterOk(ctx, next) {
                if (!ctx.HA || !ctx.followerInsts.length) {
                    next();
                    return;
                }
                progress('Waiting for ZK cluster to reach a steady state');

                s.wait4ZkOk({
                    ips: ctx.binderIps,
                    log: opts.log
                }, next);
            },

            function reprovisionLeader(ctx, next) {
                if (!ctx.leaderInst) {
                    next();
                    return;
                }
                progress('Updating ZK leader');
                s.reprovisionRemote({
                    server: ctx.leaderInst.server,
                    img: ctx.change.image,
                    zonename: ctx.leaderInst.zonename,
                    progress: progress,
                    log: opts.log,
                    sdcadm: opts.sdcadm
                }, next);
            },

            function waitForLeader(ctx, next) {
                if (!ctx.leaderInst) {
                    next();
                    return;
                }
                progress('Wait (sleep) for %s instance %s to come up',
                    ctx.change.service.name, ctx.leader);
                setTimeout(next, 60 * 1000);
            },

            function checkAgainAllInstancesJoinedZkCluster(ctx, next) {
                if (!ctx.leaderInst || ctx.standalone) {
                    next();
                    return;
                }
                progress('Waiting for zk leader to re-join ZK cluster');

                s.wait4ZkCluster({
                    ips: ctx.binderIps,
                    log: opts.log
                }, next);
            },

            function waitAgainForZkClusterOk(ctx, next) {
                if (!ctx.leaderInst || ctx.standalone) {
                    next();
                    return;
                }
                progress('Waiting for zk leader to reach a steady state');

                s.wait4ZkOk({
                    ips: ctx.binderIps,
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
// --- exports

module.exports = {
    UpdateBinderV2: UpdateBinderV2
};
// vim: set softtabstop=4 shiftwidth=4:
