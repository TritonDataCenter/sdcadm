/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/**
 * Procedure for removing a given set of Triton services and all their
 * instances. Originally this was implemented to remove the CA set of services,
 * but it might be useful as generic functionality at some point.
 */

'use strict';

var assert = require('assert-plus');
var semver = require('semver');
var sprintf = require('extsprintf').sprintf;
var util = require('util');
var vasync = require('vasync');
var VError = require('verror');

var errors = require('../errors');
var Procedure = require('./procedure').Procedure;
var steps = require('../steps');


// The set of known services for which we'll go the extra mile on removal.
// Typically we'd bail early if SAPI didn't know about the service anymore.
// For the following services we'll look harder for instances, even though
// SAPI doesn't know about them. See related notes in `.viable()` below.
const TYPE_FROM_KNOWN_SVC_NAME = {
    'ca': 'vm',
    'cabase': 'agent',
    'cainstsvc': 'agent'
};

// In TRITON-1173, support for uninstalling GZ agent instances was added.
// The following versions are required for that support.
const CNAPI_MIN_VERSION = '1.19.0';
const CN_AGENT_MIN_VERSION = '2.8.0';


function RemoveServicesProcedure(opts) {
    assert.arrayOfString(opts.svcNames, 'opts.svcNames');
    assert.ok(opts.svcNames.length > 0, 'at least one service name');
    assert.optionalArrayOfString(opts.includeServerNames,
        'opts.includeServerNames');
    assert.optionalArrayOfString(opts.excludeServerNames,
        'opts.excludeServerNames');

    this.svcNames = opts.svcNames;
    this.includeServerNames = opts.includeServerNames;
    this.excludeServerNames = opts.excludeServerNames;
}
util.inherits(RemoveServicesProcedure, Procedure);


RemoveServicesProcedure.prototype.prepare = function prepare(opts, cb) {
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.ui, 'opts.ui');

    var sdcadm = opts.sdcadm;
    var self = this;
    var ui = opts.ui;

    self.actions = [];

    vasync.pipeline({arg: {}, funcs: [
        sdcadm.ensureSdcApp.bind(sdcadm),

        // Gather the service and instance info from SAPI.
        //
        // If a given service name isn't in SAPI, typically we would error out
        // here. However, if it is one of the "known" services, then we will
        // search for instances in VMAPI and CNAPI that may exist, but not in
        // SAPI.
        //
        // How could this happen? Typically the SAPI entries would only be
        // removed after actual instance removal. However, say 'cabase' was
        // removed and then an operator installed an old agentsshar, which
        // included the cabase agent, on some CNs.
        function getSapiSvcs(ctx, next) {
            ui.info('Gathering SAPI service data.');

            let actionItems = [];
            // At least one svc being removed is of type=agent.
            ctx.haveAgentSvc = false;
            self.sapiSvcFromSvcName = {};

            vasync.forEachParallel({
                inputs: self.svcNames,
                func: function getSapiSvc(svcName, nextSvc) {
                    sdcadm.getSvc({
                        app: 'sdc',
                        svc: svcName,
                        allowNone: true
                    }, function (err, svc) {
                        if (err) {
                            nextSvc(err);
                        } else if (svc) {
                            self.sapiSvcFromSvcName[svcName] = svc;
                            actionItems.push({
                                desc: sprintf('remove "%s" SAPI service',
                                    svcName),
                                args: {
                                    service_uuid: svc.uuid
                                }
                            });
                            if (svc.type === 'agent') {
                                ctx.haveAgentSvc = true;
                            }
                            nextSvc();
                        } else if (TYPE_FROM_KNOWN_SVC_NAME[svcName]) {
                            if (TYPE_FROM_KNOWN_SVC_NAME[svcName] === 'agent') {
                                ctx.haveAgentSvc = true;
                            }
                            nextSvc();
                        } else {
                            nextSvc(new errors.UsageError(
                                'unknown SAPI service: ' + svcName));
                        }
                    });
                }
            }, function doneGetSapiSvcs(err) {
                if (actionItems.length) {
                    self.actions.push({
                        action: 'RemoveSapiSvcs',
                        items: actionItems
                    });
                }
                next(err);
            });
        },

        function getSapiInsts(_, next) {
            // Dev Note: I'm avoiding using sdcadm.listInst here because it
            // already avoids SAPI and relies on CNAPI and VMAPI for actual
            // inst info. Because we are going to remove insts we need to know
            // if SAPI has the inst or not. Longer term I think the abstraction
            // sdcadm.listInsts is providing is leaky and should be removed.
            ui.info('Gathering SAPI instance data.');
            self.sapiInstsFromSvcName = {};
            let actionItems = [];
            vasync.forEachParallel({
                inputs: self.svcNames,
                func: function getSapiInstsForSvc(svcName, nextSvc) {
                    var sapiSvc = self.sapiSvcFromSvcName[svcName];
                    if (!sapiSvc) {
                        self.sapiInstsFromSvcName[svcName] = [];
                        nextSvc();
                        return;
                    }

                    sdcadm.sapi.listInstances({
                        service_uuid: sapiSvc.uuid
                    }, function onInsts(err, insts) {
                        if (err) {
                            nextSvc(err);
                        } else {
                            self.sapiInstsFromSvcName[svcName] = insts;
                            for (let inst of insts) {
                                actionItems.push({
                                    desc: sprintf(
                                        'remove "%s" SAPI instance %s',
                                        svcName, inst.uuid),
                                    args: {
                                        instance_uuid: inst.uuid
                                    }
                                });
                            }
                            nextSvc();
                        }
                    });
                }
            }, function finished(err) {
                if (actionItems.length) {
                    self.actions.push({
                        action: 'RemoveSapiInsts',
                        items: actionItems
                    });
                }
                next(err);
            });
        },

        // We may need the CNAPI server version below later to determine if
        // it has the 'ServerRemoveAgents' functionality we need.
        function getCnapiVer(ctx, next) {
            if (!ctx.haveAgentSvc) {
                next();
                return;
            }

            sdcadm.cnapi.ping(function onPing(err, _body, _req, res) {
                if (err) {
                    next(err);
                } else {
                    ctx.cnapiServerHeader = res.headers['server'];
                    let match = /^cnapi\/(\d+\.\d+\.\d+)$/.exec(
                        ctx.cnapiServerHeader);
                    if (match) {
                       ctx.cnapiVer = match[1];
                    }
                    next();
                }
            });
        },

        function gatherServersForAgentRemovals(ctx, next) {
            if (!ctx.haveAgentSvc) {
                next();
                return;
            }

            ui.info('Gathering server agent data.');
            steps.servers.selectServers({
                log: opts.log,
                sdcadm: sdcadm,
                includeServerNames: self.includeServerNames,
                excludeServerNames: self.excludeServerNames,
                // Allow not running servers. We warn about them below.
                allowNotRunning: true,
                serverExtras: ['agents']
            }, function selectedServers(err, servers) {
                self.servers = servers;
                next(err);
            });
        },

        // We use CNAPI data for agent instances because (a) we don't (at
        // least currently) trust that SAPI knows about all actual instances and
        // (b) currently SAPI's DeleteInstance for an instance of type=agent
        // does *not* actually go and uninstall the agent.
        function determineAgentInsts(ctx, next) {
            let actionItems = [];
            let viableErrs = [];

            // Get an array of servers holding an instance of each
            // service name to remove.
            self.serversFromSvcName = {};
            for (let svcName of self.svcNames) {
                self.serversFromSvcName[svcName] = [];
            }
            for (let server of self.servers) {
                let agentsToRemove = [];
                let cnAgentInfo;

                if (server.agents) {
                    for (let agent of server.agents) {
                        if (agent.name === 'cn-agent') {
                            cnAgentInfo = agent;
                        }
                        let sfsn = self.serversFromSvcName[agent.name];
                        if (sfsn) {
                            sfsn.push(server);
                            agentsToRemove.push(agent.name);
                        }
                    }
                }

                if (agentsToRemove) {
                    // Ensure sufficient cn-agent ver for agent uninstall.
                    if (!cnAgentInfo || !cnAgentInfo.version) {
                        viableErrs.push(new VError('could not determine ' +
                            'cn-agent version for server %s (%s)',
                            server.uuid, server.hostname));
                    } else if (semver.lt(cnAgentInfo.version,
                        CN_AGENT_MIN_VERSION)) {
                        viableErrs.push(new VError('cn-agent on server ' +
                            '%s (%s) does not support agent uninstall: ' +
                            'require v%s or later, have v%s',
                            server.uuid, server.hostname,
                            CN_AGENT_MIN_VERSION, cnAgentInfo.version));
                    } else if (agentsToRemove.length > 0) {
                        agentsToRemove.sort();
                        actionItems.push({
                            desc: sprintf(
                                'uninstall %s from server %s (%s)',
                                agentsToRemove.join(', '),
                                server.uuid,
                                server.hostname),
                            args: {
                                server_uuid: server.uuid,
                                agents: agentsToRemove
                            }
                        });
                    }
                }
            }

            if (actionItems.length) {
                // Ensure sufficient CNAPI version for agent uninstall.
                if (!ctx.cnapiVer) {
                    viableErrs.push(new VError('could not determine CNAPI' +
                        'version from "Server: %s" header',
                        ctx.cnapiServerHeader));
                } else if (semver.lt(ctx.cnapiVer, CNAPI_MIN_VERSION)) {
                    viableErrs.push(new VError('CNAPI does not support ' +
                        'agent uninstall: require v%s or later, have v%s',
                        CNAPI_MIN_VERSION, ctx.cnapiVer));
                } else {
                    self.actions.push({
                        action: 'UninstallAgents',
                        items: actionItems
                    });
                }
            }

            next(VError.errorFromList(viableErrs));
        },

        // XXX Include actions for VMs that don't have a SAPI instance.
        function getVmInsts(_, next) {
            ui.info('Gathering VM instance data.');
            self.vmInstsFromSvcName = {};
            vasync.forEachParallel({
                inputs: self.svcNames,
                func: function getVmInstsForSvc(svcName, nextSvc) {
                    var filters = {
                        state: 'active',
                        owner_uuid: sdcadm.config.ufds_admin_uuid,
                        'tag.smartdc_role': svcName
                    };
                    sdcadm.vmapi.listVms(filters, function (err, vms) {
                        if (err) {
                            nextSvc(new errors.SDCClientError(err, 'vmapi'));
                        } else {
                            self.vmInstsFromSvcName[svcName] = vms;
                            nextSvc();
                        }
                    });
                }
            }, next);
        }
    ]}, function finished(err) {
        if (err) {
            cb(err);
        } else {
            // We've been adding the actions in the reverse order we want to
            // execute them.
            self.actions.reverse();

            var nothingToDo = (self.actions.length === 0);
            cb(null, nothingToDo);
        }
    });
};


RemoveServicesProcedure.prototype.summarize = function summarize() {
    // Example summary:
    //      - Remove 'ca' service: SAPI records, 1 vm instance
    //          - VM $uuid (ca0)
    //      - Remove 'cabase' service: SAPI records, 230 agent instances
    //          - warning: 2 servers that have instances are not running:
    //              - server $uuid ($hostname)
    //              - server $uuid ($hostname)
    //      - Remove 'cainstsvc' service: 2 agent instances

    var self = this;
    var lines = [];

    for (let svcName of self.svcNames) {
        let vmInsts = self.vmInstsFromSvcName[svcName];
        let serversWithAgent = self.serversFromSvcName[svcName];
        let sapiInsts = self.sapiInstsFromSvcName[svcName];
        let sapiSvc = self.sapiSvcFromSvcName[svcName];
        let type;

        let line = [sprintf('- Remove "%s" service:', svcName)];
        let details = [];
        if (sapiSvc || sapiInsts.length) {
            details.push('SAPI records');
        }
        if (vmInsts.length) {
            type = 'vm';
            details.push(sprintf('%d vm instance%s', vmInsts.length,
                vmInsts.length === 1 ? '' : 's'));
        } else if (serversWithAgent.length) {
            type = 'agent';
            details.push(sprintf('%d agent instance%s', serversWithAgent.length,
                serversWithAgent.length === 1 ? '' : 's'));
        }
        if (details.length === 0) {
            details.push('nothing to do');
        }
        line.push(details.join(', '));
        lines.push(line.join(' '));

        if (type === 'vm') {
            for (let vm of vmInsts) {
                lines.push(sprintf('    - VM %s (%s)', vm.uuid, vm.alias));
            }
        } else if (type === 'agent') {
            var notRunningServers = serversWithAgent
                .filter(s => s.status !== 'running');
            if (notRunningServers.length) {
                lines.push(sprintf('    - warning: %d %s:',
                    notRunningServers.length,
                    (notRunningServers.length === 1 ?
                        'server that has an instance is not running' :
                        'servers that have instances are not running')));
                for (let s of notRunningServers) {
                    lines.push(sprintf('        - server %s (%s)',
                        s.uuid, s.hostname));
                }
            }
        }
    }

    return lines.join('\n');
};

RemoveServicesProcedure.prototype._actionRemoveSapiSvcs =
function _actionRemoveSapiSvcs(opts, cb) {
    // An item looks like this:
    //    {
    //        "desc": "remove \"cainstsvc\" SAPI service",
    //        "args": {
    //            "service_uuid": "f85f3b49-3b87-4dec-934e-195535a2a10d"
    //        }
    //    },
    assert.arrayOfObject(opts.items, 'opts.items');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.ui, 'opts.ui');
    assert.object(opts.log, 'opts.log');
    assert.func(cb, 'cb');

    let log = opts.log;
    let sapi = opts.sdcadm.sapi;
    let ui = opts.ui;
    ui.barStart({name: 'remove SAPI services', size: opts.items.length});

    // For now we don't bother parallelizing this. We don't expect the number
    // of svcs being deleted in one call to be large.
    vasync.forEachPipeline({
        inputs: opts.items,
        func: function removeSapiSvc(item, nextItem) {
            // ui.info('- start: ' + item.desc);

            sapi.deleteService(item.args.service_uuid, function onDel(err) {
                log.debug({err: err}, 'sapi.deleteService');
                if (err) {
                    var e = new VError(err, 'error deleting SAPI service %s',
                        item.args.service_uuid);
                    ui.error(e.message);
                    ui.barAdvance(1);
                    nextItem(e);
                } else {
                    // ui.info('- completed: ' + item.desc);
                    ui.barAdvance(1);
                    nextItem();
                }
            });
        }
    }, function finish(err) {
        ui.barEnd();
        cb(err);
    });
};

RemoveServicesProcedure.prototype._actionRemoveSapiInsts =
function _actionRemoveSapiInsts(opts, cb) {
    // An item looks like this:
    //    {
    //        "desc": "remove \"ca\" SAPI instance c0c9cf3b-...-651f095eb09e",
    //        "args": {
    //            "instance_uuid": "c0c9cf3b-3337-454e-940a-651f095eb09e"
    //        }
    //    }
    assert.arrayOfObject(opts.items, 'opts.items');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.ui, 'opts.ui');
    assert.object(opts.log, 'opts.log');
    assert.func(cb, 'cb');

    let sapi = opts.sdcadm.sapi;
    let ui = opts.ui;
    ui.barStart({name: 'remove SAPI instances', size: opts.items.length});

    // Removing a SAPI *vm* instance will also delete the VM. Removing a
    // SAPI *agent* instance only deletes the SAPI database record.
    const CONCURRENCY = 10;
    let errs = [];
    let removeSapiInst = function (item, nextItem) {
        var log = opts.log.child({item: item}, true);
        // ui.info('- start: ' + item.desc);

        sapi.deleteInstance(item.args.instance_uuid, function onDel(err) {
            log.debug({err: err}, 'sapi.deleteInstance');
            if (err) {
                var e = new VError(err, 'error deleting instance %s',
                    item.args.instance_uuid);
                ui.error(e.message);
                ui.barAdvance(1);
                nextItem(e);
            } else {
                // ui.info('- completed: ' + item.desc);
                ui.barAdvance(1);
                nextItem();
            }
        });
    };
    let queue = vasync.queue(removeSapiInst, CONCURRENCY);

    queue.on('end', function () {
        cb(VError.errorFromList(errs));
    });

    queue.push(opts.items, function onItemComplete(err) {
        ui.barEnd();
        if (err) {
            errs.push(err);
        }
    });

    queue.close();
};

RemoveServicesProcedure.prototype._actionUninstallAgents =
function _actionUninstallAgents(opts, cb) {
    // An item looks like this:
    //    {
    //        "desc": "uninstall cabase, cainstsvc from server 56...b3 (RA123)",
    //        "args": {
    //            "server_uuid": "564dfb70-91c8-73d0-4f85-2ac2427c4ab3",
    //            "agents": [
    //                "cabase",
    //                "cainstsvc"
    //            ]
    //        }
    //    }
    assert.arrayOfObject(opts.items, 'opts.items');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.ui, 'opts.ui');
    assert.object(opts.log, 'opts.log');
    assert.func(cb, 'cb');

    let cnapi = opts.sdcadm.cnapi;
    const CONCURRENCY = 10;
    let errs = [];
    let ui = opts.ui;
    ui.barStart({name: 'uninstall agents', size: opts.items.length});

    let uninstallAgentsOnServer = function (item, nextItem) {
        var log = opts.log.child({item: item}, true);
        // ui.info('- start: ' + item.desc);
        // var start = Date.now();

        vasync.pipeline({arg: {}, funcs: [
            function tellCnapi(ctx, next) {
                // XXX does this client pass along request-id for this sdcadm?
                cnapi.uninstallAgents(item.args.server_uuid, {
                    agents: item.args.agents
                }, function (err, task) {
                    log.debug({err: err, task: task}, 'cnapi.uninstallAgents');
                    if (err) {
                        next(err);
                    } else {
                        assert.uuid(task.id,
                            'have a task from CNAPI ServerUninstallAgents');
                        ctx.taskId = task.id;
                        next();
                    }
                });
            },

            function waitForTaskCompletion(ctx, next) {
                const AGENT_UNINSTALL_TIMEOUT_S = 60;

                cnapi.waitTask(ctx.taskId, {
                    timeout: AGENT_UNINSTALL_TIMEOUT_S
                }, function (err, task) {
                    log.debug({err: err, task: task}, 'cnapi.waitTask');
                    if (err) {
                        next(err);
                    } else {
                        ctx.task = task;
                        next();
                    }
                });
            },

            function interpretTask(ctx, next) {
                // A successful task looks like:
                //    {
                //      "id": "16f22ff1-8715-6dae-99ca-905ef15248b2",
                //      "req_id": "c207a3a1-8a3d-63b4-8946-d63f44f0c8c3",
                //      "task": "agents_uninstall",
                //      "server_uuid": "564dfb70-91c8-73d0-4f85-2ac2427c4ab3",
                //      "status": "complete",
                //      "timestamp": "2019-02-12T22:18:26.351Z",
                //      "history": [
                //        {
                //          "name": "finish",
                //          "timestamp": "2019-02-12T22:18:32.892Z",
                //          "event": {}
                //        }
                //      ]
                //    }
                //
                // A failed task looks like:
                //    {
                //      "id": "45e47792-fdbb-c332-d58a-c68bae724dc7",
                //      "req_id": "9912b352-490b-45aa-e547-ab6b5a4300d5",
                //      "task": "agents_uninstall",
                //      "server_uuid": "260cac77-0381-4b7e-9ed3-dba43887115f",
                //      "status": "failure",
                //      "timestamp": "2019-02-13T00:31:56.624Z",
                //      "history": [
                //        {
                //          "name": "error",
                //          "timestamp": "2019-02-13T00:31:57.158Z",
                //          "event": {
                //            "error": {
                //              "message": "<error message from cn-agent>"
                //            }
                //          }
                //        },
                //        {
                //          "name": "finish",
                //          "timestamp": "2019-02-13T00:31:57.158Z",
                //          "event": {}
                //        }
                //      ]
                //    }
                if (ctx.task.status === 'complete') {
                    next();
                } else if (ctx.task.status === 'failure') {
                    var errMsg = (ctx.task.history.length > 0 &&
                        ctx.task.history[0].name === 'error'
                        ? ctx.task.history[0].event.error.message
                        : 'unknown error');
                    next(new VError('CNAPI agents_uninstall task %s failed: %s',
                        ctx.task.id, errMsg));
                } else {
                    next(new VError('unknown "status" for CNAPI task %s: %s',
                        ctx.task.id, ctx.task.status));
                }
            }
        ]}, function finishUninstall(err) {
            if (err) {
                var e = new VError(err, 'error uninstalling %s on server %s',
                    item.args.agents.join(', '), item.args.server_uuid);
                ui.error(e.message);
                ui.barAdvance(1);
                nextItem(e);
            } else {
                // var elapsed = Math.round((Date.now() - start) / 1000);
                // ui.info('- completed (' + elapsed + 's): ' + item.desc);
                ui.barAdvance(1);
                nextItem();
            }
        });
    };
    let queue = vasync.queue(uninstallAgentsOnServer, CONCURRENCY);

    queue.on('end', function () {
        ui.barEnd();
        cb(VError.errorFromList(errs));
    });

    queue.push(opts.items, function onItemComplete(err) {
        if (err) {
            errs.push(err);
        }
    });

    queue.close();
};


RemoveServicesProcedure.prototype.execute = function execute(opts, cb) {
    var log = opts.log;
    var self = this;

    log.debug({actions: self.actions}, 'RemoveServicesProcedure.execute');

    vasync.forEachPipeline({
        inputs: self.actions,
        func: function dispatchAction(action, nextAction) {
            self['_action' + action.action].bind(self)({
                items: action.items,
                log: log,
                ui: opts.ui,
                sdcadm: opts.sdcadm
            }, nextAction);
        }
    }, function done(err) {
        cb(err);
    });
};


// --- exports

module.exports = {
    RemoveServicesProcedure: RemoveServicesProcedure
};
