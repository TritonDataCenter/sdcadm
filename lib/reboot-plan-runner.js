/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016, Joyent, Inc.
 */

/**
 * Standalone process which runs a reboot plan.
 *
 * The reboot plan can run complete or just a single step,
 * depending on process arguments.
 *
 * The process can re-attach to a reboot plan in progress. This is used for
 * the reboot of the headnode where the process itself runs with the help of
 * a transient SMF manifest.
 */

var util = require('util'),
    format = util.format;

var dashdash = require('dashdash');
var uuid = require('node-uuid');
var vasync = require('vasync');
var assert = require('assert-plus');

var errors = require('./errors');
var logging = require('./logging');
var SdcAdm = require('./sdcadm');
var shared = require('./procedures/shared');
var common = require('./common');

var options = [
    {
        name: 'version',
        type: 'bool',
        help: 'Print tool version and exit.'
    },
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Print this help and exit.'
    },
    {
        names: ['verbose', 'v'],
        type: 'arrayOfBool',
        help: 'Verbose output. Use multiple times for more verbose.'
    }
];

function RebootPlanRunner() {
    this.parser = dashdash.createParser({options: options});
}

RebootPlanRunner.prototype.init = function init(callback) {
    var self = this;

    // Generate a UUID we can use both for logs and sdcadm history:
    this.uuid = uuid();

    try {
        this.opts = this.parser.parse(process.argv);
    } catch (e1) {
        return callback(e1);
    }

    // Wrap into try/catch block and handle ENOSPC and EACCES with friendlier
    // messages:
    try {
        this.log = logging.createLogger({
            name: 'sdcadm',
            component: 'reboot-plan-runner',
            logToFile: true,
            verbose: Boolean(self.opts.verbose)
        });
    } catch (e) {
        if (e.code && e.code === 'ENOSPC') {
            return callback('Not enought space to create log file');
        } else if (e.code && e.code === 'EACCES') {
            return callback('Insufficient permissions to create log file');
        } else {
            return callback(e);
        }
    }

    /**
     * Call this to emit a progress message to the "user" on stdout.
     * Takes args like `console.log(...)`.
     */
    this.progress = function progress() {
        var args_ = Array.prototype.slice.call(arguments);
        self.log.debug.apply(self.log, [ {progress: true} ].concat(args_));
        console.log.apply(null, args_);
    };

    var sdcadmOpts = {
        log: self.log,
        uuid: self.uuid
    };

    // SdcAdm should handle the version call, return version and exit
    if (self.opts.version) {
        sdcadmOpts.version = self.opts.version;
    }

    self.sdcadm = new SdcAdm(sdcadmOpts);
    self.sdcadm.init(callback);
};

// Dupe from RebootPlan
RebootPlanRunner.prototype.getCoreServers = function getCoreServers(cb) {
    var self = this;
    var coreServersUuid = [];
    var filters = {
        state: 'active',
        owner_uuid: self.sdcadm.config.ufds_admin_uuid,
        'tag.smartdc_type': 'core'
    };
    self.sdcadm.vmapi.listVms(filters, function (vmsErr, coreVms) {
        if (vmsErr) {
            cb(vmsErr);
            return;
        }

        coreVms.forEach(function (vm) {
            if (coreServersUuid.indexOf(vm.server_uuid) === -1) {
                coreServersUuid.push(vm.server_uuid);
            }
        });

        return cb(null, coreServersUuid);
    });
};

// Note that a single reboot failure will make the whole plan to fail and
// plan state be set to "canceled"
RebootPlanRunner.prototype.run = function run(callback) {
    var self = this;

    assert.func(callback, 'callback');

    // Fetch "running" reboot plan or exit(0) "nothing to do"
    var planQs = '/reboot-plans?include_reboots=true&state=pending';
    self.sdcadm.cnapi.get(planQs, function getPlansCb(getPlansErr, plans) {
        if (getPlansErr) {
            return callback(new errors.SDCClientError(getPlansErr, 'cnapi'));
        }

        if (!plans.length) {
            self.progress('No pending reboot plans.');
            return callback(false);
        }

        self.plan = plans[0];

        if (self.plan.state === 'stopped' || self.plan.state === 'created') {
            self.progress('Plan is not running');
            return callback(false);
        }

        var reboots = self.plan.reboots.filter(function (r) {
            return (!r.operational_at && !r.canceled_at);
        });

        if (!reboots.length) {
            self.progress('Plan completed.');
            return self.finishPlan('finish', callback);
        }

        var steps = self.plan.single_step ? [reboots[0]] : reboots;
        var successAction = (!self.plan.single_step || reboots.length === 1) ?
                                'finish' : 'stop';

        function doneCb(err) {
            if (err) {
                self.log.error({err: err}, 'Error executing reboot');
                self.progress('Reboot failed with error: %s', err.message);
                return self.finishPlan(successAction, callback);
            }
            // Progress step/plan finished
            if (successAction === 'finish') {
                self.progress('Plan completed.');
            } else {
                self.progress('Plan\'s step completed.');
            }
            return self.finishPlan(successAction, callback);
        }

        if (self.plan.single_step) {
            return self.doReboot(reboots[0], doneCb);
        }

        // Given we want to be able to stop the execution of the plan during
        // any of its steps, we need to execute in parallel "up to concurrency"
        // reboots, then execute the next batch of reboots if everything went
        // well or, in case of failure, stop the process as soon as possible.

        // Here, we'll just split the initial array in batches of "concurrency"
        // elements:
        function chunks(arr, size) {
            if (!arr.length) {
                return [];
            }
            var res = [];
            while (arr.length) {
                res.push(arr.splice(0, size));
            }
            return res;
        }

        function rebootBatch(batch, cb) {
            vasync.forEachParallel({
                func: function _doReboot(rb, _next) {
                    self.doReboot(rb, _next);
                },
                inputs: batch
            }, cb);
        }

        self.getCoreServers(function (csErr, csUuids) {
            if (csErr) {
                callback(csErr);
                return;
            }

            // We cannot reboot core servers in batches. Get them out of the
            // list now and prepend them, individually, later:
            var coreReboots = [];
            steps = steps.filter(function (step) {
                if (csUuids.indexOf(step.server_uuid) !== -1) {
                    coreReboots.push(step);
                    return false;
                }
                return true;
            });

            var batches = chunks(steps, self.plan.concurrency);

            if (coreReboots.length) {
                coreReboots.forEach(function (cr) {
                    batches.unshift([cr]);
                });
            }

            vasync.forEachPipeline({
                func: rebootBatch,
                inputs: batches
            }, doneCb);
        });
    });
};


RebootPlanRunner.prototype.finishPlan = function finishPlan(action, callback) {
    assert.string(action, 'action');
    assert.func(callback, 'callback');
    var self = this;
    self.sdcadm.cnapi.put('/reboot-plans/' + self.plan.uuid, {
        action: action
    }, function (err) {
        if (err) {
            return callback(new errors.SDCClientError(err, 'cnapi'));
        }
        return callback();
    });
};

RebootPlanRunner.prototype.waitForJob = function waitForJob(job_uuid, cb) {
    var self = this;

    assert.string(job_uuid, 'job_uuid');
    assert.func(cb, 'cb');

    function pollJob(callback) {
        var attempts = 0;
        var errs = 0;

        var timeout = 5000;  // 5 seconds
        var limit = 720;     // 1 hour

        var poll = function () {
            self.sdcadm.wfapi.getJob(job_uuid, function (err, job) {
                attempts++;

                if (err) {
                    errs++;
                    if (errs >= 5) {
                        return cb(err);
                    } else {
                        return setTimeout(poll, timeout);
                    }
                }

                if (job && (job.execution === 'succeeded' ||
                            job.execution === 'failed' ||
                            job.execution === 'canceled')) {
                    return callback(null, job);
                } else if (attempts > limit) {
                    return callback(new Error(
                                'polling for import job timed out'), job);
                }

                return setTimeout(poll, timeout);
            });
        };

        poll();
    }

    pollJob(function (err, job) {
        if (err) {
            return cb(err);
        }
        var result = job.chain_results.pop();
        if (result.error) {
            var errmsg = result.error.message || JSON.stringify(result.error);
            return cb(new Error(errmsg));
        } else {
            return cb(null, job);
        }
    });
};


RebootPlanRunner.prototype.waitForSvcs = function waitForSvcs(reboot, cb) {
    var self = this;
    assert.object(reboot, 'reboot');
    assert.func(cb, 'cb');
    self.log.debug({reboot: reboot}, 'wait for svcs argument');

    function pollSvcs(callback) {
        var attempts = 0;
        var errs = 0;

        var timeout = 5000;  // 5 seconds
        var limit = 720;     // 1 hour

        var poll = function () {
            self.sdcadm.checkHealth({
                servers: [reboot.server_uuid]
            }, function (healthErr, healthRes) {
                attempts++;

                if (healthErr) {
                    errs++;
                    if (errs >= 5) {
                        return cb(healthErr);
                    } else {
                        return setTimeout(poll, timeout);
                    }
                }

                if (healthRes.some(function (svc) {
                    return !svc.healthy;
                })) {
                    if (attempts > limit) {
                        return callback(new Error(
                            'polling for svcs health timed out'), healthRes);
                    } else {
                        return setTimeout(poll, timeout);
                    }
                } else {
                    return callback(null, healthRes);
                }
            });
        };
        poll();
    }

    pollSvcs(cb);
};


RebootPlanRunner.prototype.doReboot = function doReboot(reboot, callback) {
    assert.object(reboot, 'reboot');
    assert.func(callback, 'callback');
    var self = this;
    // Check if the plan has been canceled or stopped before we go ahead with
    // the reboot. (The plan can be stopped or canceled during the execution
    // of the previous reboot, for example).
    self.log.info({reboot: reboot, plan: self.plan}, 'Current reboot');
    var planQs = '/reboot-plans/' + self.plan.uuid;
    self.sdcadm.cnapi.get(planQs, function (getPlanErr, plan) {
        if (getPlanErr) {
            return callback(new errors.SDCClientError(getPlanErr, 'cnapi'));
        }

        if (plan.state !== 'running') {
            self.plan = plan;
            return callback();
        }

        var rebootUuid;

        vasync.pipeline({
            arg: {reboot: reboot},
            funcs: [
                // If the server is a headnode we rather check core svcs before
                // trying to move forward on more verifications
                function checkHeadnodeSvcs(ctx, next) {
                    if (!ctx.reboot.headnode) {
                        return next();
                    }
                    self.log.trace({
                        server: ctx.reboot.server_uuid
                    }, 'Waiting for headnode services');
                    self.waitForSvcs(ctx.reboot, function (err, svcs) {
                        if (err) {
                            return next(new errors.InternalError({
                                cause: err,
                                message: 'Cannot verify headnode services' +
                                    ' health'
                            }));
                        }

                        return next();
                    });
                },
                function prepareManatee(ctx, next) {
                    self.log.trace({
                        server: ctx.reboot.server_uuid
                    }, 'Preparing manatee instances');
                    self.sdcadm.listInsts({
                        types: ['vm'],
                        svcs: ['manatee']
                    }, function (err, insts) {
                        if (err) {
                            return next(err);
                        }

                        insts = insts.filter(function (inst) {
                            return (inst.server &&
                                    inst.server === ctx.reboot.server_uuid);
                        });

                        // Move forward if none of the manatee instances is
                        // on this Server:
                        if (!insts.length) {
                            return next();
                        }

                        ctx.manatees = insts;

                        shared.getShardState({
                            log: self.log,
                            server: ctx.reboot.server_uuid,
                            manateeUUID: ctx.manatees[0].instance
                        }, function (err2, st) {
                            if (err2) {
                                return next(new errors.InternalError({
                                    cause: err2,
                                    message: 'Cannot get manatee shard state'
                                }));
                            }

                            // Need to know this on a later step:
                            ctx.shardRole = (st.async && st.async.length) ?
                                'async' : (st.sync ? 'sync' : 'primary');

                            // Move forward if primary manatee is not involved:
                            if (!ctx.manatees.some(function (m) {
                                return (st.primary.zoneId === m.instance);
                            })) {
                                return next();
                            }

                            // At this point, we have a primary manatee; freeze
                            // the shard to unfreeze it later
                            ctx.primaryManatee = true;
                            self.log.trace({
                                server: ctx.reboot.server_uuid
                            }, 'Freezing manatee shard');
                            common.manateeFreeze({
                                server: ctx.reboot.server_uuid,
                                vm: ctx.manatees[0].instance,
                                reason: 'sdcadm reboot-plan',
                                log: self.log
                            }, function (err3) {
                                if (err3) {
                                    return next(new errors.InternalError({
                                        cause: err3,
                                        message: 'Cannot freeze manatee shard'
                                    }));
                                }
                                return next();
                            });
                        });
                    });
                },
                function createRebootJob(ctx, next) {
                    if (ctx.reboot.job_uuid) {
                        return next();
                    }
                    self.log.trace({
                        server: ctx.reboot.server_uuid
                    }, 'Creating reboot job');
                    self.sdcadm.cnapi.post({
                        path: format('/servers/%s/reboot',
                            ctx.reboot.server_uuid)
                    }, {
                        drain: true,
                        reboot_plan: plan.uuid
                    }, function (err, res) {
                        if (err) {
                            return next(new errors.SDCClientError(err,
                                        'cnapi'));
                        }
                        ctx.reboot.job_uuid = res.job_uuid;
                        return next(null);
                    });
                },
                // We need to get the reboot job b/c it is the only way we can
                // get the reboot uuid, not exposed by CNAPI anywhere else:
                function getRebootJob(ctx, next) {
                    self.sdcadm.wfapi.getJob(ctx.reboot.job_uuid,
                            function (err, job) {
                        if (err) {
                            return next(new errors.SDCClientError(err,
                                        'wfapi'));
                        }

                        rebootUuid = ctx.reboot_uuid = job.params.reboot_uuid;
                        ctx.job_finished = ctx.reboot.finished_at ? true :
                            ((job.execution === 'succeeded' ||
                            job.execution === 'failed' ||
                            job.execution === 'canceled') ? true : false);
                        if (ctx.job_finished) {
                            ctx.job_execution = job.execution;
                        }
                        return next(null);
                    });
                },
                function pollRebootJob(ctx, next) {
                    if (ctx.job_finished) {
                        return next();
                    }
                    self.log.trace({
                        server: ctx.reboot.server_uuid
                    }, 'Polling reboot job for completion');
                    self.waitForJob(ctx.reboot.job_uuid, function (jErr, job) {
                        if (jErr) {
                            return next(jErr);
                        }
                        ctx.job_finished = true;
                        ctx.job_execution = job.execution;
                        return next(null);
                    });
                },
                function checkCoreSvcs(ctx, next) {
                    // Already verified headnode core services before, move
                    // forward:
                    if (ctx.reboot.headnode) {
                        return next();
                    }

                    if (!ctx.job_execution ||
                            ctx.job_execution !== 'succeeded') {
                        return next(new errors.InternalError({message: format(
                            'Reboot job failed for server %s (%s)',
                            ctx.reboot.server_uuid,
                            ctx.reboot.server_hostname)}));
                    }
                    self.log.trace({
                        server: ctx.reboot.server_uuid
                    }, 'Waiting for core services');

                    self.waitForSvcs(ctx.reboot, function (err, svcs) {
                        if (err) {
                            return next(new errors.InternalError({
                                cause: err,
                                message: format(
                                    'Cannot verify services health into CN %s',
                                    ctx.reboot.server_uuid)
                            }));
                        }

                        return next(null);
                    });
                },
                function checkManateeShard(ctx, next) {
                    if (!ctx.manatees) {
                        return next();
                    }
                    self.log.trace({
                        server: ctx.reboot.server_uuid
                    }, 'Waiting for manatee shard');

                    // TODO: It might be possible to add an optional
                    // timeout value to this function, given we know
                    // production servers might need more time to
                    // reboot than the default
                    shared.waitForManatee({
                        log: self.log,
                        server: ctx.reboot.server_uuid,
                        role: ctx.shardRole,
                        manateeUUID: ctx.manatees[0].instance,
                        state: 'enabled'
                    }, next);
                },
                function unfreezeManatee(ctx, next) {
                    if (!ctx.primaryManatee) {
                        return next();
                    }
                    self.log.trace({
                        server: ctx.reboot.server_uuid
                    }, 'Unfreezing manatee shard');
                    common.manateeAdmRemote({
                        server: ctx.reboot.server_uuid,
                        vm: ctx.manatees[0].instance,
                        cmd: 'unfreeze',
                        log: self.log
                    }, function (err) {
                        if (err) {
                            return next(new errors.InternalError({
                                cause: err,
                                message: 'Cannot unfreeze manatee shard'
                            }));
                        }
                        return next();
                    });
                },
                function updateReboot(ctx, next) {
                    self.log.trace({
                        server: ctx.reboot.server_uuid
                    }, 'Updating reboot record (operational_at)');
                    var rebootUrl = format('/reboot-plans/%s/reboots/%s',
                            self.plan.uuid, ctx.reboot_uuid);
                    self.sdcadm.cnapi.put(rebootUrl, {
                        operational_at: new Date().toISOString()
                    }, function (err) {
                        if (err) {
                            return next(new errors.SDCClientError(err,
                                        'cnapi'));
                        }
                        return next(null);
                    });
                }
            ]
        }, function (rebootErr) {
            if (rebootErr && rebootUuid) {
                self.log.trace({
                        server: reboot.server_uuid
                    }, 'Updating reboot record (canceled_at)');
                // Attempt to "cancel" the reboot before buble up the error:
                var rebootUrl = format('/reboot-plans/%s/reboots/%s',
                        self.plan.uuid, rebootUuid);
                self.sdcadm.cnapi.put(rebootUrl, {
                    canceled_at: new Date().toISOString()
                }, function (cancelErr) {
                    if (cancelErr) {
                        self.log.error({err: cancelErr},
                                'Error canceling reboot');
                    }
                    return callback(rebootErr);
                });
            }
            return callback(rebootErr);
        });
    });
};

//---- exports

module.exports = RebootPlanRunner;


//---- mainline

if (require.main === module) {
    // SAPI, binder or some other core service migth be down when we first try
    // to init the process - for example, right after a headnode reboot. We'll
    // try to init the service during 15 minutes before we fail and buble up
    // the issue to svcadm
    var runner = new RebootPlanRunner();
    var initAttempts = 0;
    var initTimeout = 10000;  // 10 seconds
    var initLimit = 90;     // 15 minutes
    var initRunner = function () {
        initAttempts += 1;
        runner.init(function (err) {
            if (err) {
                console.error('sdcadm reboot-plan-runner: error: %s',
                        err.message);
                if (initAttempts < initLimit) {
                    setTimeout(initRunner, initTimeout);
                    return;
                } else {
                    process.exit(1);
                }
            }

            runner.run(function (er2) {
                if (er2) {
                    console.error('sdcadm reboot-plan-runner: error: %s',
                            er2.message);
                    if (initAttempts < initLimit) {
                        setTimeout(initRunner, initTimeout);
                        return;
                    } else {
                        process.exit(1);
                    }
                }
                console.info('Done!');
                process.exit(0);
            });
        });
    };
    initRunner();
}
