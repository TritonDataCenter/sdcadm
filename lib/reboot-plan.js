/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016, Joyent, Inc.
 */

/*
 * Collection of 'sdcadm reboot-plan ...' CLI commands
 * for working towards controlled and safe reboots of selected servers in a
 * typical SDC setup.
 * One of the least specified and hardest parts of SDC upgrades is managing
 * the reboots of CNs and the headnode safely. In particular:
 *
 * - controlling reboots of the "core" servers (those with SDC core components,
 *   esp. the HA binders and manatees)
 * - reasonably helpful tooling for rebooting (subsets of) the other servers in
 *   a DC: rolling reboots, reboot rates.
 *
 * Subcommands will handle:
 *
 * - Creation/execution/cancelation of a reboot plan
 * - Check status of currently queued/in-progress reboot plan
 *
 */

var p = console.log;
var util = require('util'),
    format = util.format;

var sprintf = require('extsprintf').sprintf;
var tabula = require('tabula');
var ProgressBar = require('progbar').ProgressBar;
var vasync = require('vasync');
var assert = require('assert-plus');
var cmdln = require('cmdln'),
    Cmdln = cmdln.Cmdln;

var common = require('./common');
var errors = require('./errors');
var svcadm = require('./svcadm');

/**
 * Intended to be used by the RebootPlanCLI class and from whatever else
 * needing to perform any action related to a reboot plan
 */
function RebootPlan(top) {
    this.top = top;
    this.sdcadm = top.sdcadm;
    this.progress = top.progress;
    this.log = top.log;
}

// TODO: Update when we merge reboot-plan branch into CNAPI master
RebootPlan.MIN_CNAPI_VERSION = '20160422T080819Z';

RebootPlan.prototype.minCnapiVersion = function minCnapiVersion(cb) {
    var self = this;
    self.sdcadm.listInsts({
        svcs: ['cnapi']
    }, function (err, instances) {
        if (err) {
            cb(err);
        } else {
            var cnapiInsts = instances.filter(function (i) {
                return (i.service === 'cnapi');
            });

            var parts = cnapiInsts[0].version.split('-');
            var curImg = parts[parts.length - 2];
            if (RebootPlan.MIN_CNAPI_VERSION > curImg) {
                cb(new errors.UpdateError(format(
                    'image for cnapi is too old for `sdcadm reboot-plan`\n' +
                    'min image build date is "%s" current image is "%s"',
                    RebootPlan.MIN_CNAPI_VERSION,
                    curImg
                )));
            } else {
                cb();
            }
        }
    });
};

RebootPlan.prototype.getCoreServers = function getCoreServers(cb) {
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

RebootPlan.prototype.create = function create(opts, cb) {
    assert.object(opts, 'opts');

    var self = this;

    var serverRecs;
    var coreServersUuid = [];
    var planCoreServers = [];
    var planNonCoreServers = [];
    var samePlatformServers = [];
    var downgradePlatformServers = [];
    var summary = [];

    vasync.pipeline({funcs: [
        function cnapiVersion(_, next) {
            self.minCnapiVersion(next);
        },
        function serverList(_, next) {
            self.sdcadm.cnapi.listServers({
                // setup: true // REVIEW: Return all of them?
            }, function (err, recs) {
                if (err) {
                    next(err);
                    return;
                }
                serverRecs = recs;
                next();
            });
        },
        function getCoreServersUuids(_, next) {
            self.getCoreServers(function (err, cServers) {
                if (err) {
                    next(err);
                    return;
                }
                coreServersUuid = cServers;
                next();
            });
        },
        function validateProvidedServers(_, next) {
            if (!opts.servers) {
                next();
                return;
            }
            var errs = [];
            var uuids = serverRecs.map(function (s) {
                return (s.uuid);
            });
            opts.servers.forEach(function (s) {
                if (uuids.indexOf(s) === -1) {
                    errs.push(s);
                }
            });
            if (errs.length) {
                next(new errors.UsageError(
                    'The following servers are not valid: ' +
                    errs.join(', ')));
                return;
            }
            next();
        },
        function selectProvidedServers(_, next) {
            if (!opts.servers) {
                next();
                return;
            }
            serverRecs.forEach(function (s) {
                if (opts.servers.indexOf(s.uuid)) {
                    if (coreServersUuid.indexOf(s.uuid) !== -1) {
                        planCoreServers.push(s);
                    } else {
                        planNonCoreServers.push(s);
                    }
                }
            });
            next();
        },
        function selectCoreServers(_, next) {
            if (!opts.core) {
                next();
                return;
            }
            serverRecs.forEach(function (s) {
                if (coreServersUuid.indexOf(s.uuid) !== -1) {
                    planCoreServers.push(s);
                }
            });
            next();
        },
        function selectNonCoreServers(_, next) {
            if (!opts.nonCore) {
                next();
                return;
            }
            serverRecs.forEach(function (s) {
                if (coreServersUuid.indexOf(s.uuid) === -1) {
                    planNonCoreServers.push(s);
                }
            });
            next();
        },
        function selectAllServers(_, next) {
            if (!opts.all) {
                next();
                return;
            }
            serverRecs.forEach(function (s) {
                if (coreServersUuid.indexOf(s.uuid) !== -1) {
                    planCoreServers.push(s);
                } else {
                    planNonCoreServers.push(s);
                }
            });
            next();
        },
        function checkServersPlatforms(_, next) {
            planCoreServers = planCoreServers.filter(function (s) {
                if (s.current_platform === s.boot_platform) {
                    if (opts.skipCurrent) {
                        return false;
                    }
                    samePlatformServers.push(s);
                    return true;
                } else if (s.current_platform > s.boot_platform) {
                    downgradePlatformServers.push(s);
                    return true;
                } else {
                    return true;
                }
            });

            planNonCoreServers = planNonCoreServers.filter(function (s) {
                if (s.current_platform === s.boot_platform) {
                    if (opts.skipCurrent) {
                        return false;
                    }
                    samePlatformServers.push(s);
                    return true;
                } else if (s.current_platform > s.boot_platform) {
                    downgradePlatformServers.push(s);
                    return true;
                } else {
                    return true;
                }
            });
            next();
        },
        function createPlanSummary(_, next) {
            p('Generating plan summary');
            var corePlatforms = {};
            planCoreServers.forEach(function (s) {
                if (s.headnode) {
                    summary.unshift(sprintf(
                        'Reboot headnode: platform %s -> %s',
                        s.current_platform, s.boot_platform));
                } else {
                    if (!corePlatforms[s.current_platform]) {
                        corePlatforms[s.current_platform] = {};
                    }

                    if (!corePlatforms[s.current_platform][s.boot_platform]) {
                        corePlatforms[s.current_platform][s.boot_platform] = [];
                    }
                    corePlatforms[s.current_platform][s.boot_platform].push(s);
                }
            });

            /* BEGIN JSSTYLED */
            Object.keys(corePlatforms).forEach(function (currPlatform) {
                Object.keys(corePlatforms[currPlatform]).forEach(function (bootPlatform) {
                    summary.push(sprintf(
                        'Reboot %d core server%s: platform %s -> %s',
                        corePlatforms[currPlatform][bootPlatform].length,
                        (corePlatforms[currPlatform][bootPlatform].length > 1 ? 's' : ''),
                        currPlatform, bootPlatform));
                });
            });
            /* END JSSTYLED */
            var platforms = {};
            planNonCoreServers.forEach(function (s) {
                if (!platforms[s.current_platform]) {
                    platforms[s.current_platform] = {};
                }

                if (!platforms[s.current_platform][s.boot_platform]) {
                    platforms[s.current_platform][s.boot_platform] = [];
                }
                platforms[s.current_platform][s.boot_platform].push(s);
            });

            /* BEGIN JSSTYLED */
            Object.keys(platforms).forEach(function (currPlatform) {
                Object.keys(platforms[currPlatform]).forEach(function (bootPlatform) {
                    summary.push(sprintf(
                        'Reboot %d server%s: platform %s -> %s',
                        platforms[currPlatform][bootPlatform].length,
                        (platforms[currPlatform][bootPlatform].length > 1 ? 's' : ''),
                        currPlatform, bootPlatform));
                });
            });
            /* END JSSTYLED */
            next();
        },
        function confirm(_, next) {
            p('');
            if (samePlatformServers.length && !opts.ignoreWarnings) {
                /* BEGIN JSSTYLED */
                p('Warning: The following servers will reboot without a platform change');
                p('(use \'--skip-current\' to exclude servers already on target boot platform):');
                samePlatformServers.forEach(function (s) {
                    p('\t' + s.hostname + '(' + s.uuid + ')');
                });
                p('');
                p('Aborting');
                cb();
                return;
                /* END JSSTYLED */
            }

            if (downgradePlatformServers.length && !opts.ignoreWarnings) {
                /* BEGIN JSSTYLED */
                p('Warning: The following servers will reboot with a platform *downgrade*:');
                downgradePlatformServers.forEach(function (s) {
                    p('\t' + s.hostname + '(' + s.uuid + ')');
                });
                p('');
                p('Aborting');
                cb();
                return;
                /* END JSSTYLED */
            }

            if (opts.yes) {
                next();
                return;
            }

            if (!summary.length) {
                p('Error: plan has zero servers to reboot');
                p('Aborting');
                cb();
                return;
            }

            p('The following reboot plan will be created:');
            p(common.indent(summary.join('\n')));
            p('');

            var msg = 'Would you like to continue? [y/N] ';
            common.promptYesNo({msg: msg, default: 'n'}, function (answer) {
                if (answer !== 'y') {
                    p('Aborting');
                    cb();
                    return;
                }
                p('');
                next();
                return;
            });
        },
        // Finally, save plan into CNAPI
        function savePlanIntoCnapi(_, next) {
            if (opts.dryRun) {
                return next();
            }
            p('Creating reboot plan');
            var sUuids = planCoreServers.map(function (s) {
                return s.uuid;
            }).concat(planNonCoreServers.map(function (s) {
                return s.uuid;
            }));

            self.sdcadm.cnapi.post({
                path: '/reboot-plans'
            }, {
                concurrency: opts.rate,
                servers: sUuids
            }, function cnapiCb(cnapiErr, cnapiRes) {
                if (cnapiErr) {
                    next(new errors.SDCClientError(cnapiErr, 'cnapi'));
                    return;
                }

                if (!cnapiRes.uuid) {
                    next(new errors.InternalError(
                                'Unexpected CNAPI response'));
                    return;
                }

                p(sprintf(
                    'Created reboot plan %s (%d servers, %d max concurrency)',
                    cnapiRes.uuid,
                    sUuids.length,
                    opts.rate
                ));

                next();
            });
        }
    ]}, function pipelineCb(pipelineErr) {
        if (pipelineErr) {
            cb(pipelineErr);
            return;
        }

        if (opts.run) {
            self.run({
                watch: opts.watch
            }, cb);
        } else {
            cb();
        }
    });
};


RebootPlan.prototype.getCurrentPlan = function getCurrentPlan(callback) {
    var self = this;
    var u = '/reboot-plans?limit=1&include_reboots=true';
    self.sdcadm.cnapi.get(u, function (listErr, listRes) {
        if (listErr) {
            callback(new errors.SDCClientError(listErr, 'cnapi'));
            return;
        }
        callback(null, listRes[0]);
    });
};


RebootPlan.prototype.run = function run(opts, callback) {
    var self = this;
    assert.object(opts, 'opts');
    self.getCurrentPlan(function (err, plan) {
        if (err) {
            callback(err);
            return;
        }

        if (!plan) {
            p('There are no pending reboot plans');
            callback();
            return;
        }

        if (plan.state === 'canceled' || plan.state === 'complete' ||
                plan.state === 'running') {
            p('Plan is already %', plan.state);
            callback();
            return;
        }

        var planOpts = {
            action: 'run'
        };

        if (opts.singleStep) {
            planOpts.single_step = true;
        }

        var planUri = format('/reboot-plans/%s', plan.uuid);
        self.sdcadm.cnapi.put(planUri, planOpts, function (cnapiErr) {
            if (cnapiErr) {
                callback(new errors.SDCClientError(cnapiErr, 'cnapi'));
                return;
            }
            p('Plan execution has been %s',
                    (plan.execution === 'created' ? 'started' : 'continued'));

            svcadm.svcadmRestart({
                fmri: '/smartdc/sdcadm-agent:default',
                log: self.log
            }, function (svcadmErr) {
                if (svcadmErr) {
                    callback(svcadmErr);
                    return;
                }

                if (opts.watch) {
                    self.watch(callback);
                } else {
                    callback();
                }
            });
        });
    });
};

RebootPlan.prototype.status = function status(callback) {
    var self = this;
    self.getCurrentPlan(function (err, plan) {
        if (err) {
            callback(err);
            return;
        }

        if (!plan) {
            p('There are no pending reboot plans');
            callback();
            return;
        }

        self.getCoreServers(function (cSErr, cSUuids) {
            if (cSErr) {
                callback(cSErr);
                return;
            }

            p('Reboot plan %s (%d servers, %d max concurrency):',
                    plan.uuid, plan.reboots.length, plan.concurrency);
            p('- Reboot plan state: %s', plan.state);

            var rebootedServers = 0;
            var pendingServers = 0;
            var curReboots = [];
            var canceledReboots = [];
            plan.reboots.forEach(function (r) {
                if (r.operational_at) {
                    rebootedServers += 1;
                } else if (r.canceled_at) {
                    canceledReboots.push(r);
                } else if (!r.started_at) {
                    pendingServers += 1;
                } else {
                    curReboots.push(r);
                }
            });

            p('- Rebooted: %s servers, pending to reboot: %s servers',
                    rebootedServers, pendingServers);

            if (canceledReboots.length) {
                canceledReboots.forEach(function (cr) {
                    p('- Canceled reboot of%s server %s: platform %s -> %s',
                            (cSUuids.indexOf(cr.server_uuid) !== -1 ?
                                ' core' : ''),
                            cr.server_uuid,
                            cr.current_platform,
                            cr.boot_platform);
                });
            }

            if (curReboots.length) {
                curReboots.forEach(function (cr) {
                    p('- Rebooting%s server %s: platform %s -> %s',
                            (cSUuids.indexOf(cr.server_uuid) !== -1 ?
                                ' core' : ''),
                            cr.server_uuid,
                            cr.current_platform,
                            cr.boot_platform);
                });
            }
            callback();
        });
    });
};

RebootPlan.prototype.stop = function stop(callback) {
    var self = this;
    self.getCurrentPlan(function (err, plan) {
        if (err) {
            callback(err);
            return;
        }

        if (!plan) {
            p('There are no pending reboot plans');
            callback();
            return;
        }

        if (plan.state === 'complete' || plan.state === 'canceled') {
            p('Plan is already %s', plan.state);
            callback();
            return;
        }

        if (plan.state === 'stopped' || plan.state === 'created') {
            p('Plan is not running');
            callback();
            return;
        }

        var planUri = format('/reboot-plans/%s', plan.uuid);
        self.sdcadm.cnapi.put(planUri, {
            action: 'stop'
        }, function (cnapiErr) {
            if (cnapiErr) {
                callback(new errors.SDCClientError(cnapiErr, 'cnapi'));
                return;
            }
            p('Plan execution has been stopped');
            callback();
        });
    });
};

RebootPlan.prototype.cancel = function cancel(callback) {
    var self = this;
    self.getCurrentPlan(function (err, plan) {
        if (err) {
            callback(err);
            return;
        }

        if (!plan) {
            p('There are no pending reboot plans');
            callback();
            return;
        }

        if (plan.state === 'running') {
            p('Plan is running. Please, stop it before cancelling');
            callback();
            return;
        }

        if (plan.state === 'canceled' || plan.state === 'complete') {
            p('Plan is already %s', plan.state);
            callback();
            return;
        }

        var planUri = format('/reboot-plans/%s', plan.uuid);
        self.sdcadm.cnapi.put(planUri, {
            action: 'cancel'
        }, function (cnapiErr) {
            if (cnapiErr) {
                callback(new errors.SDCClientError(cnapiErr, 'cnapi'));
                return;
            }
            p('Plan execution has been canceled');
            callback();
        });
    });
};


RebootPlan.prototype.pollReboot = function pollReboot(opts, callback) {

    assert.object(opts, 'opts');
    assert.object(opts.reboot, 'opts.reboot');
    assert.optionalObject(opts.bar, 'opts.bar');
    assert.bool(opts.isCoreServer, 'opts.isCoreServer');
    assert.func(callback, 'callback');

    var self = this;
    var reboot = opts.reboot;
    p('- Rebooting%s server %s: platform %s -> %s',
                            opts.isCoreServer ? ' core' : '',
                            reboot.server_uuid,
                            reboot.current_platform,
                            reboot.boot_platform);

    function duration(ms) {
        var secs = Math.floor(ms / 1000);
        var mins = Math.floor(secs / 60);
        return format('%dm%ds', mins, (secs % 60));
    }

    vasync.pipeline({
        arg: reboot,
        funcs: [
            function getRebootJob(arg, next) {
                self.sdcadm.wfapi.getJob(arg.job_uuid, function (err, job) {
                    if (err) {
                        next(new errors.SDCClientError(err, 'wfapi'));
                        return;
                    }
                    if (job.execution === 'failed' ||
                            job.execution === 'canceled') {
                        next(new Error('Job execution ' + job.execution));
                        return;
                    }

                    arg.reboot_uuid = job.params.reboot_uuid;
                    next();
                });
            },
            function pollJobFinished(arg, next) {
                function _pollJobFinished(cb) {
                    var attempts = 0;
                    var errs = 0;
                    var timeout = 5000;  // 5 seconds
                    var limit = 720;     // 1 hour
                    var id = arg.job_uuid;

                    var poll = function () {
                        self.sdcadm.wfapi.getJob(id, function (err, job) {
                            attempts++;
                            if (err) {
                                errs++;
                                if (errs >= 5) {
                                    return next(new errors.SDCClientError(
                                                err, 'wfapi'));
                                } else {
                                    return setTimeout(poll, timeout);
                                }
                            }
                            if (job && job.execution && (
                                        job.execution === 'succeeded' ||
                                        job.execution === 'failed' ||
                                        job.execution === 'canceled'
                            )) {
                                return cb(null, job);
                            } else if (attempts > limit) {
                                return cb(new Error('polling for reboot job' +
                                            ' timed out'), job);
                            }
                            return setTimeout(poll, timeout);
                        });
                    };
                    poll();
                }

                _pollJobFinished(function (err, job) {
                    if (err) {
                        next(err);
                        return;
                    }
                    if (job && job.execution && (job.execution === 'failed' ||
                            job.execution === 'canceled')) {
                        next(new Error('Job execution ' + job.execution));
                        return;
                    }
                    arg.finished_at = new Date().toISOString();
                    next();
                });
            },
            function pollServerStatus(arg, next) {
                function _pollServerStatus(cb) {
                    var attempts = 0;
                    var errs = 0;
                    var timeout = 5000;  // 5 seconds
                    var limit = 720;     // 1 hour
                    var u = format('/servers/%s', arg.server_uuid);

                    var poll = function () {
                        self.sdcadm.cnapi.get(u, function (err, srv) {
                            attempts++;

                            if (err) {
                                errs++;
                                if (errs >= 5) {
                                    return next(err);
                                } else {
                                    return setTimeout(poll, timeout);
                                }
                            }

                            if (srv && srv.status === 'running' &&
                                (new Date(srv.last_boot) >
                                 new Date(arg.finished_at))) {
                                return cb(null, srv);
                            } else if (attempts > limit) {
                                return cb(new Error(
                                    'polling for server reboot timed out'),
                                        srv);
                            }
                            return setTimeout(poll, timeout);
                        });
                    };
                    poll();
                }

                _pollServerStatus(function (err, srv) {
                    if (err) {
                        next(err);
                        return;
                    }

                    var start = new Date(reboot.started_at);
                    var end = new Date(srv.last_boot);

                    p('- Rebooted%s server %s: %s - %s (%s)',
                        opts.isCoreServer ? ' core' : '',
                        reboot.server_uuid,
                        start.toISOString(),
                        end.toISOString(),
                        duration(end - start));

                    next();
                });
            },
            function pollServerOperational(arg, next) {
                p('- Waiting for%s server %s SDC services to be operational',
                        opts.isCoreServer ? ' core' : '',
                        reboot.server_uuid);

                function _pollJobOperational(cb) {
                    var attempts = 0;
                    var errs = 0;
                    var timeout = 5000;  // 5 seconds
                    var limit = 720;     // 1 hour
                    var u = format('/reboot-plans/%s/reboots/%s',
                            arg.reboot_plan_uuid,
                            arg.reboot_uuid);

                    var poll = function () {
                        self.sdcadm.cnapi.get(u, function (err, res) {
                            attempts++;

                            if (err) {
                                errs++;
                                if (errs >= 5) {
                                    return next(err);
                                } else {
                                    return setTimeout(poll, timeout);
                                }
                            }
                            if (res && res.operational_at) {
                                return cb(null, res);
                            } else if (attempts > limit) {
                                return cb(new Error(
                                        'polling for reboot timed out'), res);
                            }
                            return setTimeout(poll, timeout);
                        });
                    };
                    poll();
                }

                _pollJobOperational(function (err, reb) {
                    if (err) {
                        next(err);
                        return;
                    }

                    arg.operational_at = reb.operational_at;
                    next();
                });
            }
        ]
    }, function pipeCb(pipeErr) {
        if (pipeErr) {
            callback(pipeErr);
            return;
        }
        callback(null, reboot);
    });
};

RebootPlan.prototype.pollPlan = function pollPlan(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.plan, 'opts.plan');
    assert.optionalObject(opts.bar, 'opts.bar');
    assert.object(opts.coreServers, 'opts.coreServers');
    assert.func(callback, 'callback');

    var self = this;

    var plan = opts.plan;
    var cs = opts.coreServers;
    var u = '/reboot-plans/' + plan.uuid;
    self.sdcadm.cnapi.get(u, function (cnapiErr, aPlan) {
        if (cnapiErr) {
            callback(cnapiErr);
            return;
        }

        // If we're done with the plan, just return now
        if (aPlan.state !== 'running') {
            callback(null, aPlan);
            return;
        }

        var curReboots = plan.reboots.filter(function (r) {
            r.reboot_plan_uuid = aPlan.uuid;
            return (!r.operational_at && r.started_at);
        });

        vasync.forEachParallel({
            inputs: curReboots,
            func: function _pollReboot(ctx, cb) {
                self.pollReboot({
                    reboot: ctx,
                    bar: opts.bar,
                    isCoreServer: (cs.indexOf(ctx.server_uuid) !== -1)
                }, cb);
            }
        }, function (err, results) {
            if (err) {
                callback(err);
                return;
            }
            // REVIEW: Should return something else than the plan?
            callback(null, aPlan);
            return;
        });
    });
};

RebootPlan.prototype.watch = function watch(callback) {
    var self = this;
    self.getCurrentPlan(function (err, plan) {
        if (err) {
            callback(err);
            return;
        }

        if (!plan) {
            p('There are no pending reboot plans');
            callback();
            return;
        }

        if (plan.state === 'created' || plan.state === 'stopped') {
            p('Reboot plan is not running.');
            p('In order to run plan %s execute `reboot-plan run` subcommand',
                    plan.uuid);
            callback();
            return;
        }

        process.on('SIGINT', function rebootPlanInfo() {
            p('Stopped watching reboot plan %s', plan.uuid);
            p('**Note: The reboot plan is still running! ' +
                    'Use `sdcadm reboot-plan stop` to stop it.**');
            process.exit(0);
        });

        self.getCoreServers(function (cSErr, cSUuids) {
            if (cSErr) {
                callback(cSErr);
                return;
            }

            var rebootedServers = 0;
            var pendingServers = 0;
            var curReboots = [];
            var canceledReboots = [];
            var bar;

            plan.reboots.forEach(function (r) {
                if (r.operational_at) {
                    rebootedServers += 1;
                } else if (r.canceled_at) {
                    canceledReboots.push(r);
                    rebootedServers += 1;
                } else if (!r.started_at) {
                    pendingServers += 1;
                } else {
                    curReboots.push(r);
                }
            });

            p('- Rebooted: %s servers, pending to reboot: %s servers',
                    rebootedServers, pendingServers);

            if (canceledReboots.length) {
                canceledReboots.forEach(function (cr) {
                    p('- Canceled reboot of%s server %s: platform %s -> %s',
                            (cSUuids.indexOf(cr.server_uuid) !== -1 ?
                                ' core' : ''),
                            cr.server_uuid,
                            cr.current_platform,
                            cr.boot_platform);
                });
            }

            if (plan.state === 'canceled' || plan.state === 'complete') {
                p('Plan is %s', plan.state);
                callback();
                return;
            }

            if (process.stderr.isTTY) {
                bar = new ProgressBar({
                    size: plan.reboots.length,
                    bytes: false,
                    filename: format('Running reboot plan %s (%d servers,' +
                                ' %d max concurrency):',
                                plan.uuid, plan.reboots.length,
                                plan.concurrency)
                });
                bar.advance(rebootedServers);
                if (rebootedServers) {
                    bar.log(format('- Rebooted: %s servers, pending to ' +
                            'reboot: %s servers',
                            rebootedServers, pendingServers));
                }
            }

            // Should probably print from the reboot themselves, since
            // we're gonna call that recursively for reboots' batches
            if (curReboots.length) {
                curReboots.forEach(function (cr) {
                    p('- Rebooting%s server %s: platform %s -> %s',
                            (cSUuids.indexOf(cr.server_uuid) !== -1 ?
                                ' core' : ''),
                            cr.server_uuid,
                            cr.current_platform,
                            cr.boot_platform);
                });
            }
            // And from here, let's poll plan's reboots for completion progress
            function doPollPlan() {
                self.pollPlan({
                    plan: plan,
                    coreServers: cSUuids,
                    bar: bar
                }, function (planErr, aPlan) {
                    if (planErr) {
                        callback(planErr);
                        return;
                    }

                    if (aPlan.state !== 'running') {
                        self.progress('\nPlan %s. Check sdcadm-reboot-plan ' +
                                'logs for the details.', aPlan.state);
                        bar.end();
                        callback();
                        return;
                    }

                    plan = aPlan;
                    doPollPlan();
                });

            }
            doPollPlan();
        });
    });
};


// --- RebootPlan CLI class

function RebootPlanCLI(top) {
    this.top = top;
    Cmdln.call(this, {
        name: 'sdcadm experimental reboot-plan',
        desc: 'Reboot plan related sdcadm commands.\n' +
              '\n' +
              'CLI commands for working towards controlled and safe\n' +
              'reboots of selected servers in a typical SDC setup.',
        helpOpts: {
            minHelpCol: 24 /* line up with option help */
        }
    });
}
util.inherits(RebootPlanCLI, Cmdln);

RebootPlanCLI.prototype.init = function init(opts, args, callback) {
    this.sdcadm = this.top.sdcadm;
    this.progress = this.top.progress;
    this.log = this.top.log;
    this.rebootPlan = new RebootPlan(this.top);
    Cmdln.prototype.init.apply(this, arguments);
};


RebootPlanCLI.prototype.do_create = function do_create(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    var servers = args.length ? args : undefined;

    var errMsg;
    // Server selection options are mutually exclusive:
    if (opts.core && opts.non_core) {
        errMsg = '"--core" and "--non-core" options are mutually exclusive.';
    } else if (opts.core && opts.all) {
        errMsg = '"--core" and "--all" options are mutually exclusive.';
    } else if (opts.non_core && opts.all) {
        errMsg = '"--non-core" and "--all" options are mutually exclusive.';
    } else if (servers && (opts.core || opts.non_core || opts.all)) {
        errMsg = '"--core", "--non-core" or "--all" options cannot be used' +
            'with explicit server selection.';
    }

    if (opts.watch && !opts.run) {
        errMsg = '"--watch" option should be specified together with ' +
            '"--run" option.';
    }

    if (opts.run && opts.dry_run) {
        errMsg = '"--run" and "--dry-run" options are mutually exclusive';
    }

    if (errMsg) {
        return cb(new errors.UsageError(errMsg));
    }

    var createOpts = {
        dryRun: opts.dry_run,
        yes: opts.yes,
        servers: servers,
        core: opts.core,
        nonCore: opts.non_core,
        all: opts.all,
        rate: Number(opts.rate),
        ignoreWarnings: opts.ignore_warnings,
        skipCurrent: opts.skip_current,
        run: opts.run,
        watch: opts.watch
    };

    self.rebootPlan.create(createOpts, cb);
};

RebootPlanCLI.prototype.do_create.help = (
    'Create a reboot plan.\n' +
    /* BEGIN JSSTYLED */
    '\n' +
    'Usage:\n' +
    'sdcadm experimental reboot-plan create [OPTIONS] [SERVER] [SERVER]... \n' +
    '\n' +
    'Use "--all" to reboot all the non-core setup servers or pass a specific set\n' +
    'of SERVERs. A "SERVER" is a server UUID or hostname. In a larger datacenter,\n' +
    'getting a list of the wanted servers can be a chore. The\n' +
    '"sdc-server lookup ..." tool is useful for this.\n' +
    '\n' +
    'Examples:\n' +
    '\n' +
    '    # Reboot all non-core servers.\n' +
    '    sdcadm reboot-plan create --non-core\n' +
    '\n' +
    '    # Reboot non-core setup servers with the "pkg=aegean" trait.\n' +
    '    sdcadm reboot-plan create \\\n' +
    '        $(sdc-server lookup setup=true traits.pkg=aegean)\n' +
    '\n' +
    '    # Reboot non-core setup servers, excluding those with a "internal=PKGSRC" trait.\n' +
    '    sdcadm reboot-plan create \\\n' +
    '        $(sdc-server lookup setup=true \'traits.internal!~PKGSRC\')\n' +
    '\n' +
    '    # One liner to run and watch the reboot plan right after creating it\n' +
    '    sdcadm reboot-plan create --all --run --watch\n' +
    '\n' +
    /* END JSSTYLED */
    '\n' +
    '{{options}}'
);

RebootPlanCLI.prototype.do_create.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['yes', 'y'],
        type: 'bool',
        help: 'Answer yes to all confirmations.'
    },
    {
        names: ['dry-run', 'n'],
        type: 'bool',
        help: 'Go through the motions without actually rebooting.'
    },
    {
        names: ['rate', 'N'],
        type: 'integer',
        'default': 5,
        help: 'Number of servers to reboot simultaneously. Default: 5.',
        helpArg: 'N'
    },
    {
        names: ['ignore-warnings', 'W'],
        type: 'bool',
        help: 'Create the reboot plan despite of emiting warnings for ' +
            'servers already on the target platform (or other warnings).'
    },
    {
        names: ['skip-current', 's'],
        type: 'bool',
        help: 'Use to skip reboot of servers already on target boot platform.'
    },
    {
        names: ['run', 'r'],
        type: 'bool',
        help: 'Run the reboot-plan right after create it.'
    },
    {
        names: ['watch', 'w'],
        type: 'bool',
        help: 'Watch the reboot plan execution.'
    },
    {
        group: 'Server selection'
    },
    {
        names: ['core'],
        type: 'bool',
        help: 'Reboot the servers with SDC core components.' +
            'Note that this will include the headnode.'
    },
    {
        names: ['non-core'],
        type: 'bool',
        help: 'Reboot the servers without SDC core components.'
    },
    {
        names: ['all', 'a'],
        type: 'bool',
        help: 'Reboot all the servers.'
    }
];


RebootPlanCLI.prototype.do_run = function do_run(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        self.do_help('help', {}, [subcmd], cb);
        return;
    }

    var options = {
        watch: opts.watch
    };

    self.rebootPlan.run(options, cb);
};

RebootPlanCLI.prototype.do_run.help = (
    'Execute/continue the current reboot plan.\n' +
    '\n' +
    'Usage:\n' +
    'sdcadm experimental reboot-plan run [OPTIONS]\n' +
    '\n' +
    '{{options}}'
);

RebootPlanCLI.prototype.do_run.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['watch', 'w'],
        type: 'bool',
        help: 'Watch for execution of the plan once it has been started.'
    }
];


RebootPlanCLI.prototype.do_status = function do_status(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        self.do_help('help', {}, [subcmd], cb);
        return;
    }
    self.rebootPlan.status(cb);
};

RebootPlanCLI.prototype.do_status.help = (
    'Show status of the current reboot plan.\n' +
    '\n' +
    'Usage:\n' +
    'sdcadm experimental reboot-plan status [OPTIONS]\n' +
    '\n' +
    '{{options}}'
);

RebootPlanCLI.prototype.do_status.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];

RebootPlanCLI.prototype.do_watch = function do_watch(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        self.do_help('help', {}, [subcmd], cb);
        return;
    }
    self.rebootPlan.watch(cb);
};

RebootPlanCLI.prototype.do_watch.help = (
    'Watch (and wait for) the currently running reboot plan.\n' +
    '\n' +
    'Usage:\n' +
    'sdcadm experimental reboot-plan watch [OPTIONS]\n' +
    '\n' +
    '{{options}}'
);

RebootPlanCLI.prototype.do_watch.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];

RebootPlanCLI.prototype.do_stop = function do_stop(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        self.do_help('help', {}, [subcmd], cb);
        return;
    }
    self.rebootPlan.stop(cb);
};

RebootPlanCLI.prototype.do_stop.help = (
    'Stop execution of the currently running reboot plan.\n' +
    '\n' +
    'Usage:\n' +
    'sdcadm experimental reboot-plan stop [OPTIONS]\n' +
    '\n' +
    '{{options}}'
);

RebootPlanCLI.prototype.do_stop.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];

RebootPlanCLI.prototype.do_cancel = function do_cancel(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        self.do_help('help', {}, [subcmd], cb);
        return;
    }
    self.rebootPlan.cancel(cb);
};

RebootPlanCLI.prototype.do_cancel.help = (
    'Cancel the current reboot plan.\n' +
    '\n' +
    'Usage:\n' +
    'sdcadm experimental reboot-plan cancel [OPTIONS]\n' +
    '\n' +
    '{{options}}'
);

RebootPlanCLI.prototype.do_cancel.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];

// Run just a single step of the reboot plan, and stop there until operator
// requests for the next step to run:
RebootPlanCLI.prototype.do_next = function do_next(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        self.do_help('help', {}, [subcmd], cb);
        return;
    }
    opts.singleStep = true;
    self.rebootPlan.run(opts, cb);
};

RebootPlanCLI.prototype.do_next.help = (
    'Execute the next step of the current reboot plan.\n' +
    '\n' +
    'Like "run" but only the next step of the reboot plan will be executed.\n' +
    '\n' +
    'Usage:\n' +
    'sdcadm experimental reboot-plan next [OPTIONS]\n' +
    '\n' +
    '{{options}}'
);

RebootPlanCLI.prototype.do_next.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['watch', 'w'],
        type: 'bool',
        help: 'Watch (and wait) for execution of the plan\'s step.'
    }
];

//---- exports

module.exports = {
    RebootPlanCLI: RebootPlanCLI
};
