/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */


var assert = require('assert-plus');
var sprintf = require('extsprintf').sprintf;
var util = require('util');
var format = util.format;
var vasync = require('vasync');
var semver = require('semver');
var ProgressBar = require('progbar').ProgressBar;

var errors = require('../errors'),
    SDCClientError = errors.SDCClientError,
    UpdateError = errors.UpdateError,
    MultiError = errors.MultiError;

var common = require('../common');
var steps = require('../steps');

var Procedure = require('./procedure').Procedure;
var s = require('./shared');

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
        var img = ch.image;
        var out;
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
    var self = this;
    var progress = opts.progress;
    var sdcadm = opts.sdcadm;
    var log = opts.log;
    // Given we may have errors for some CNs, and not from some others, we
    // need to store errors and report at end:
    var errs = [];
    // Progress bar
    var bar;
    var completed = 0;
    var concurrency = opts.concurrency || 1;

    function updateAgent(change, nextSvc) {
        log.debug({change: change}, 'updateAgent');

        var cnAgentInsts = [];

        var context = {
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
                        var cnapiInsts = instances.filter(function (i) {
                            return (i.service === 'cnapi');
                        });
                        cnAgentInsts = instances.filter(function (i) {
                            return (i.service === 'cn-agent');
                        });
                        var parts = cnapiInsts[0].version.split('-');
                        var curImg = parts[parts.length - 2];
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

            /*
             * Guard against duplicate agent instance entries (see TOOLS-1521)
             */
            function preventDuplicateInstances(_, next) {
                var instUUIDs = change.insts.map(function (ins) {
                    return ins.instance;
                });

                var duplicates = instUUIDs.some(function (ins, pos) {
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
                    steps.servers.ensureServersRunning({
                        servers: servers
                    }, next);
                });
            },

            steps.noRabbit.noRabbitEnable,

            function updateAgentOnServers(_, next) {
                if (process.stderr.isTTY) {
                    bar = new ProgressBar({
                        size: change.insts.length,
                        bytes: false,
                        filename: format('%s %s', (change.type ===
                            'create-instances' ?
                            'Creating instance of' : 'Updating'),
                            change.service.name)
                    });
                    bar.advance(0); // Draw initial progbar at 0.
                }

                // Check task completion by taskid when we are updating
                // anything but cn-agent:
                function waitUntilTaskCompletes(taskid, _cb) {
                    var counter = 0;
                    var limit = 360;
                    function _waitTask() {
                        counter += 1;
                        sdcadm.cnapi.getTask(taskid, function (err, task) {
                            if (err) {
                                _cb(new SDCClientError(err, 'cnapi'));
                                return;
                            }

                            if (task.status === 'failure') {
                                var msg = format('Task %s failed', taskid);
                                if (task.history[0].event.error) {
                                    msg += ' with error: ' +
                                        task.history[0].event.error.message;
                                }
                                _cb(new UpdateError(msg));
                            } else if (task.status === 'complete') {
                                _cb();
                            } else if (counter < limit) {
                                setTimeout(_waitTask, 5000);
                            } else {
                                var message = format(
                                    'Timeout(30m) waiting for task %s', taskid);
                                progress(message);
                                _cb(new UpdateError(message));
                            }
                        });
                    }
                    _waitTask();
                }

                // Check sysinfo has changed and contains the new image uuid
                // when we are updating cn-agent
                function waitUntilAgentsChange(server_uuid, _cb) {
                    var counter = 0;
                    var limit = 360;
                    function _waitServer() {
                        counter += 1;
                        sdcadm.cnapi.getServer(server_uuid,
                                function (err, server) {
                            if (err) {
                                _cb(new SDCClientError(err, 'cnapi'));
                                return;
                            }
                            var theAgent = server.agents.filter(
                                    function (a) {
                                return (a.name === 'cn-agent');
                            })[0];

                            if (theAgent.image_uuid === change.image.uuid) {
                                _cb();
                            } else if (counter < limit) {
                                setTimeout(_waitServer, 5000);
                            } else {
                                var msg = format('Timeout(30m) waiting for ' +
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

                    var cnAgentInstance = (arg.service === 'cn-agent') ? arg :
                        cnAgentInsts.filter(function (i) {
                            return (i.server === arg.server);
                        })[0];

                    if (!arg.image) {
                        errs.push(new UpdateError(format('Unknown image for ' +
                            '%s in server %s', arg.service, arg.server)));
                        return cb();
                    }

                    if (!cnAgentInstance.version) {
                        errs.push(new UpdateError(format('Unknown version' +
                            ' for cn-agent in server %s', arg.server)));
                        return cb();
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
                        return cb();
                    }

                    return sdcadm.cnapi.post({
                        path: format('/servers/%s/install-agent',
                                      arg.server)
                    }, {
                        image_uuid: change.image.uuid
                    }, function cnapiCb(er2, res) {
                        if (er2) {
                            return cb(new SDCClientError(er2, 'cnapi'));
                        }

                        log.debug({
                            svc: arg.service,
                            server: arg.server,
                            image: change.image.uuid
                        }, 'Waiting for install_agent task to complete');

                        var fun, argum;
                        if (arg.service === 'cn-agent') {
                            fun = waitUntilAgentsChange;
                            argum = arg.server;
                        } else {
                            fun = waitUntilTaskCompletes;
                            argum = res.id;
                        }

                        return fun(argum, function (er3) {
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

                var queue = vasync.queue(upAgent, concurrency);
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

    vasync.forEachPipeline({
        inputs: self.changes,
        func: updateAgent
    }, callback);

};

// --- exports

module.exports = {
    UpdateAgentV1: UpdateAgentV1
};
// vim: set softtabstop=4 shiftwidth=4:
