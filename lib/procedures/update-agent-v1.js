/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018 Joyent, Inc.
 */


const assert = require('assert-plus');
const sprintf = require('extsprintf').sprintf;
const util = require('util');
const format = util.format;
const vasync = require('vasync');
const semver = require('semver');
const ProgressBar = require('progbar').ProgressBar;

const errors = require('../errors'),
    SDCClientError = errors.SDCClientError,
    UpdateError = errors.UpdateError,
    MultiError = errors.MultiError;

const common = require('../common');
const steps = require('../steps');

const Procedure = require('./procedure').Procedure;
const s = require('./shared');

/**
 * Procedure for updating the different agent services.
 */
function UpdateAgentV1(options) {
    assert.arrayOfObject(options.changes, 'options.changes');
    this.changes = options.changes;
}
util.inherits(UpdateAgentV1, Procedure);


UpdateAgentV1.prototype.summarize = function uaSummarize() {
    return this.changes.map(function (ch) {
        const img = ch.image;
        let out;
        if (ch.type === 'update-service') {
            out = [sprintf('update "%s" service to image %s',
                        ch.service.name, img.uuid),
                        common.indent(sprintf('(%s@%s)',
                        img.name, img.version))];
            if (ch.insts.length) {
                out.push(sprintf('on %d servers', ch.insts.length));
            }
        } else if (ch.type === 'update-instances') {
            out = [sprintf('update instances of service "%s" to image %s',
                        ch.service.name, img.uuid),
                        common.indent(sprintf('(%s@%s)',
                        img.name, img.version))];
            if (ch.insts.length) {
                out.push(sprintf('on %d servers', ch.insts.length));
            }
        } else if (ch.type === 'update-instance') {
            out = [sprintf('update "%s" instance of "%s" service',
                        ch.instance.instance, ch.service.name),
                        common.indent(sprintf('to image %s (%s@%s)',
                        img.uuid, img.name, img.version))];
        } else if (ch.type === 'create-instances') {
            if (ch.insts.length > 1) {
                out = [sprintf('create new instances of "%s" service',
                        ch.service.name),
                    common.indent(sprintf('using image %s (%s@%s)',
                        img.uuid, img.name, img.version)),
                    common.indent(sprintf('on %d servers:',
                        ch.insts.length))
                ];
                out = out.concat(ch.insts.map(function (inst) {
                    return common.indent(sprintf('%s (%s)',
                        inst.server, inst.hostname), 8);
                }));
            } else {
                out = [sprintf('create a new instance of "%s" service',
                            ch.service.name),
                            common.indent(sprintf('on server %s (%s)',
                                ch.insts[0].server, ch.insts[0].hostname)),
                            common.indent(sprintf('using image %s (%s@%s)',
                            img.uuid, img.name, img.version))];
            }
        }
        return out.join('\n');
    }).join('\n');
};

// The minimal required CNAPI version (CNAPI-508, CNAPI-511):
UpdateAgentV1.MIN_CNAPI_VERSION = '20150407T172714Z';
// The first cn-agent version able to run install_agent task, including
// updating itself through cn-agent-setup service:
UpdateAgentV1.MIN_CN_AGENT_VERSION = '2015-11-14T08:05:36Z';


UpdateAgentV1.prototype.execute = function uaExecute(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.plan, 'opts.plan');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.progress, 'opts.progress');
    assert.string(opts.wrkDir, 'opts.wrkDir');
    assert.optionalNumber(opts.concurrency, 'opts.concurrency');
    assert.func(callback, 'callback');
    const self = this;
    let progress = opts.progress;
    let sdcadm = opts.sdcadm;
    let log = opts.log;
    // Given we may have errors for some CNs, and not from some others, we
    // need to store errors and report at end:
    let errs = [];
    let completed = 0;
    const concurrency = opts.concurrency || 1;

    let cnAgentInsts = [];
    // We'll try to call "refresh_agents" task only once per CN, instead of
    // one time for each agent we setup into a given CN.
    let cnsToRefresh = [];
    // When we are updating several agents at time, we need a single progbar
    // for all the agents
    let bar;

    /*
     * When updating more than one agent, we could save some time by
     * skipping the repetition of some steps needed only once.
     */
    function checklist(done) {
        let context = {
            progress: progress,
            log: log,
            sdcadm: sdcadm
        };
        vasync.pipeline({arg: context, funcs: [
            function ensureSdcApp(_, next) {
                sdcadm.ensureSdcApp({}, next);
            },
            /*
             * Check if cn-agent service is already on SAPI. Otherwise,
             * inform the user how to add it.
             */
            function checkCnAgentSvcOnSapi(_, next) {
                sdcadm.getSvc({
                    svc: 'cn-agent',
                    app: sdcadm.sdcApp.uuid,
                    allowNone: true
                }, function (err, svc) {
                    if (err) {
                        next(err);
                    } else if (!svc) {
                        next(new UpdateError(
                            'cn-agent service does not exist. Please run:\n' +
                            '\n    sdcadm experimental update-other\n' +
                            '\nand install latest agentsshar using:\n\n    ' +
                            'sdcadm experimental upate-agents --all --latest' +
                            '\n\nbefore trying to update individual agents'));
                    } else {
                        next();
                    }
                });
            },
            /*
             * Unless CNAPI has been updated to a version newer than
             * MIN_CNAPI_VERSION, tell the user about the CNAPI version
             * required for the update.
             */
            function checkMinCNAPIVersion(_, next) {
                progress('Verifying that CNAPI is able to run agent updates');
                sdcadm.listInsts({
                    svcs: ['cnapi', 'cn-agent']
                }, function (err, instances) {
                    if (err) {
                        next(err);
                    } else {
                        let cnapiInsts = instances.filter(function (i) {
                            return (i.service === 'cnapi');
                        });
                        cnAgentInsts = instances.filter(function (i) {
                            return (i.service === 'cn-agent');
                        });
                        let parts = cnapiInsts[0].version.split('-');
                        let curImg = parts[parts.length - 2];
                        if (UpdateAgentV1.MIN_CNAPI_VERSION > curImg) {
                            next(new UpdateError(format(
                                'image for cnapi is too old for `sdcadm ' +
                                'update agents` (min image build date\n' +
                                'is "%s" current image build date is' +
                                ' "%s")',
                                UpdateAgentV1.MIN_CNAPI_VERSION,
                                curImg
                            )));
                        } else if (!cnAgentInsts.length) {
                            next(new UpdateError('cn-agent is not installed ' +
                                'on any Compute Node.\nIn order to be able to' +
                                'update individual agents you need to run:\n' +
                                '    sdcadm experimental update-agents'));
                        } else {
                            next();
                        }
                    }
                });
            },

            steps.noRabbit.noRabbitEnable

        ]}, done);

    }

    function waitForCnapiTask(taskid, done) {
        // Wait for 20 minutes should be long enough given the update
        // of an agent usually takes less than 2 minutes
        sdcadm.cnapi.waitTask(taskid, {
            timeout: 20 * 60
        }, function waitTaskCb(waitTaskErr, task) {
            if (waitTaskErr) {
                done(new SDCClientError(waitTaskErr, 'cnapi'));
                return;
            }
            if (!task || !task.status || task.status !== 'complete') {
                let msg = '';
                if (task.status === 'failure') {
                    msg = format('Task %s failed', taskid);
                    if (task.history[0].event.error) {
                        msg += ' with error: ' +
                            task.history[0].event.error.message;
                    }
                } else {
                    msg = format('Timeout(30m) waiting for task %s',
                        taskid);
                }
                progress(msg);
                done(new errors.InternalError({
                    message: msg
                }));
                return;
            }
            done();
        });
    }

    function updateAgent(change, nextSvc) {
        log.debug({change: change}, 'updateAgent');

        let context = {
            progress: progress,
            log: log,
            sdcadm: sdcadm
        };

        vasync.pipeline({arg: context, funcs: [
            /*
             * We will bump Service Image only when a request to update the
             * agent in all the servers have been made
             */
            function updateSapiSvcImage(_, next) {
                if (change.type !== 'update-service') {
                    next();
                    return;
                }
                s.updateSapiSvc({
                    change: change,
                    opts: {
                        sdcadm: sdcadm,
                        progress: progress
                    }
                }, next);
            },

            /*
             * Guard against duplicate agent instance entries (see TOOLS-1521)
             */
            function preventDuplicateInstances(_, next) {
                const instUUIDs = change.insts.map(function (ins) {
                    return ins.instance;
                });

                const duplicates = instUUIDs.some(function (ins, pos) {
                    return (instUUIDs.indexOf(ins) !== pos);
                });

                if (duplicates.length) {
                    next(new UpdateError(format(
                        'there are duplicated instances for agent %s',
                        change.insts[0].service)));
                    return;
                }
                next();
            },

            function checkCNsAvailability(_, next) {
                // Move into the next step if we have zero instances:
                if (change.insts.length === 0) {
                    next();
                    return;
                }
                sdcadm.cnapi.listServers({
                    uuids: change.insts.map(function (i) {
                        return (i.server);
                    }).join(',')
                }, function (sErr, servers) {
                    if (sErr) {
                        next(new errors.SDCClientError(sErr, 'cnapi'));
                        return;
                    }
                    let unavailable = [];
                    servers.forEach(function (srv) {
                        if (srv.status !== 'running' ||
                            (srv.status === 'running' &&
                             srv.transitional_status !== '')) {
                            unavailable.push(srv.uuid);
                        }
                    });
                    if (unavailable.length) {
                        next(new UpdateError(format(
                            'The following servers are not available:\n%s\n' +
                            'Please make sure of these servers availability ' +
                            'or remove them from the list of servers to ' +
                            'update before continue.', unavailable.join(','))));
                        return;
                    }
                    next();
                });
            },


            function updateAgentOnServers(_, next) {
                if (process.stderr.isTTY) {
                    completed = 0;
                    bar = new ProgressBar({
                        size: change.insts.length,
                        bytes: false,
                        filename: format('%s %s', (change.type ===
                            'create-instances' ?
                            'Creating instance of' : 'Updating'),
                            change.service.name)
                    });
                    bar.advance(completed); // Draw progbar, initially at 0.
                }

                // Check sysinfo has changed and contains the new image uuid
                // when we are updating cn-agent
                function waitUntilAgentsChange(server_uuid, _cb) {
                    let counter = 0;
                    const limit = 360;
                    function _waitServer() {
                        counter += 1;
                        sdcadm.cnapi.getServer(server_uuid,
                                function (err, server) {
                            if (err) {
                                _cb(new SDCClientError(err, 'cnapi'));
                                return;
                            }
                            let theAgent = server.agents.filter(
                                    function (a) {
                                return (a.name === 'cn-agent');
                            })[0];

                            if (theAgent.image_uuid === change.image.uuid) {
                                _cb();
                            } else if (counter < limit) {
                                setTimeout(_waitServer, 5000);
                            } else {
                                let msg = format('Timeout(30m) waiting for ' +
                                        'cn-agent update on server %s',
                                        server_uuid);
                                progress(msg);
                                _cb(new UpdateError(msg));
                            }
                        });
                    }
                    _waitServer();
                }

                function upAgent(arg, cb) {
                    log.debug({
                        arg: arg
                    }, 'Updating agent instance');

                    let cnAgentInstance = (arg.service === 'cn-agent') ? arg :
                        cnAgentInsts.filter(function (i) {
                            return (i.server === arg.server);
                        })[0];

                    if (!arg.image) {
                        errs.push(new UpdateError(format('Unknown image for ' +
                            '%s in server %s', arg.service, arg.server)));
                        cb();
                        return;
                    }

                    if (!cnAgentInstance.version) {
                        errs.push(new UpdateError(format('Unknown version' +
                            ' for cn-agent in server %s', arg.server)));
                        cb();
                        return;
                    }

                    // Check if HN/CN has the minimal required cn-agent version
                    // to be able to update agents:
                    if (!(semver.satisfies('1.5.1', cnAgentInstance.version) ||
                        semver.ltr('1.5.1', cnAgentInstance.version))) {
                        errs.push(new UpdateError(format('Invalid ' +
                            'cn-agent version in server %s.\nMinimal ' +
                            'version to run agent updates is 1.5.1 (current ' +
                            'version is %s)',
                            arg.server, cnAgentInstance.version)));
                        cb();
                        return;
                    }

                    sdcadm.cnapi.post({
                        path: format('/servers/%s/install-agent',
                                      arg.server)
                    }, {
                        image_uuid: change.image.uuid
                    }, function cnapiCb(er2, res) {
                        if (er2) {
                            cb(new SDCClientError(er2, 'cnapi'));
                            return;
                        }

                        // cn-agent update_task always does the
                        // refresh-agents call from cn-agent itself:
                        if (cnsToRefresh.indexOf(arg.server) === -1 &&
                            arg.service !== 'cn-agent') {
                            cnsToRefresh.push(arg.server);
                        }

                        log.debug({
                            svc: arg.service,
                            server: arg.server,
                            image: change.image.uuid
                        }, 'Waiting for install_agent task to complete');


                        let fun, argum;
                        if (arg.service === 'cn-agent') {
                            fun = waitUntilAgentsChange;
                            argum = arg.server;
                        } else {
                            fun = waitForCnapiTask;
                            argum = res.id;
                        }

                        fun(argum, function (er3) {
                            if (er3) {
                                errs.push(er3);
                            } else {
                                log.debug({
                                    svc: arg.service,
                                    server: arg.server
                                }, 'Agent successfully updated');
                            }
                            cb();
                        });

                    });
                }

                let queue = vasync.queue(upAgent, concurrency);
                queue.push(change.insts, function doneOne() {
                    if (bar) {
                        completed += 1;
                        bar.advance(completed);
                    }
                });
                queue.close();
                queue.on('end', function done() {
                    if (bar) {
                        bar.end();
                        bar = null;
                    }
                    if (change.type === 'create-instances') {
                        progress('successfully created instance of agent %s.',
                            change.service.name);
                    } else {
                        progress('%s agent update has run in all servers.',
                                change.service.name);
                    }
                    if (errs.length) {
                        progress('Errors will be reported below:');
                        next(new MultiError(errs));
                    } else {
                        next();
                    }
                });
            }
        ]}, nextSvc);
    }

    checklist(function (err) {
        if (err) {
            callback(err);
            return;
        }

        let ctx = {
            refreshCns: cnsToRefresh
        };

        vasync.pipeline({arg: ctx, funcs: [
            function execChanges(_, changesCb) {
                vasync.forEachPipeline({
                    inputs: self.changes,
                    func: updateAgent
                }, changesCb);
            },

            function execRefreshAgents(arg, refreshCb) {
                progress('Retrieving updated agents information from servers');
                let refreshCns = arg.refreshCns;
                let refreshErrs = [];
                function refreshAgents(cn, nextCN) {
                    sdcadm.cnapi.post({
                        path: format('/servers/%s/refresh-agents', cn)
                    }, {}, function cnapiCb(refrErr, refrRes) {
                        if (refrErr) {
                            refreshErrs.push(
                                new SDCClientError(refrErr, 'cnapi'));
                            nextCN();
                            return;
                        }

                        waitForCnapiTask(refrRes.id, function (waitErr) {
                            if (waitErr) {
                                refreshErrs.push(
                                    new SDCClientError(waitErr, 'cnapi'));
                                nextCN();
                                return;
                            }
                            nextCN();
                        });
                    });
                }

                let queue = vasync.queue(refreshAgents, concurrency);
                queue.push(refreshCns);
                queue.close();
                queue.on('end', function queueDone() {
                    if (refreshErrs.length) {
                        refreshCb(refreshErrs);
                    }
                    refreshCb();
                });
            }

        ]}, callback);
    });

};

// --- exports

module.exports = {
    UpdateAgentV1: UpdateAgentV1
};
// vim: set softtabstop=4 shiftwidth=4:
