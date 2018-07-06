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

var vasync = require('vasync');

var Procedure = require('./procedure').Procedure;
var s = require('./shared');
var common = require('../common');
var errors = require('../errors');
var steps = require('../steps');
var svcadm = require('../svcadm');
function CreateServiceInstanceV1(options) {
    assert.arrayOfObject(options.changes, 'options.changes');
    this.changes = options.changes;
}
util.inherits(CreateServiceInstanceV1, Procedure);

CreateServiceInstanceV1.prototype.summarize = function csiv1Summarize() {
    return this.changes.map(function (ch) {
        var out = sprintf('create "%s" service instance\n' +
            '    using image %s (%s@%s)\n',
            ch.service.name, ch.image.uuid, ch.image.name, ch.image.version);
        if (ch.servers.length === 1) {
            out += sprintf('    on server %s', ch.servers[0]);
        } else {
            out += util.format('    on %d servers:', ch.servers.length);
            out = [out].concat(
                ch.servers.map(function (serv) {
                    return common.indent(serv, 8);
            })).join('\n');
        }
        return out;
    }).join('\n');
};

CreateServiceInstanceV1.prototype.execute = function csiv1Execute(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.plan, 'opts.plan');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.progress, 'opts.progress');
    assert.string(opts.wrkDir, 'opts.wrkDir');
    assert.func(cb, 'cb');
    var self = this;
    var sdcadm = opts.sdcadm;
    var progress = opts.progress;

    function createSvcInst(change, nextSvc) {
        var arg = {
            change: change,
            opts: opts,
            img: change.image,
            servers: change.servers,
            userScript: false,
            progress: progress,
            log: opts.log
        };
        var alias;

        var funcs = [
            function getSvcInstances(ctx, next) {
                progress('Getting SDC\'s %s instances from SAPI',
                        change.service.name);
                sdcadm.sapi.listInstances({
                    service_uuid: change.service.uuid
                }, function sapiListInstsCb(instErr, insts) {
                    if (instErr) {
                        next(instErr);
                        return;
                    }
                    // It doesn't really matter if we have no instances, the
                    // command could have failed creating the first one, and we
                    // may be trying to re-run from there
                    ctx.instances = insts;
                    next();
                });
            },
            function avoidCloudAPIFirstInstance(ctx, next) {
                if (ctx.instances.length === 0 &&
                        change.service.name === 'cloudapi') {
                    next(new errors.UsageError(
                        'First CloudAPI instance should be created using ' +
                        '`sdcadm post-setup cloudapi`.'));
                    return;
                }
                next();
            },
            // See TOOLS-1940 (first sapi instance is created w/o parameters
            // during headnode initial setup):
            function fixSapiZeroAlias(ctx, next) {
                if (change.service.name !== 'sapi') {
                    next();
                    return;
                }
                steps.sapi.fixInstanceAlias({
                    sdcadm: sdcadm,
                    instances: ctx.instances
                }, function fixInstCb(fixInstErr, fixedInsts) {
                    if (fixInstErr) {
                        next(fixInstErr);
                        return;
                    }
                    ctx.instances = fixedInsts;
                    next();
                });
            },
            // Get the ordinal number corresponding to the next instance so
            // all the created instances for a given service have consecutive
            // numbers:
            function getNextInstOrd(ctx, next) {
                ctx.nextId = s.getNextInstAliasOrdinal(ctx).nextId;
                next();
            }
        ];

        if (change.service.metadata) {  // workaround for assets (TOOLS-695)
            funcs = funcs.concat([
                s.getUserScript,
                s.writeOldUserScriptForRollback,
                s.updateSvcUserScript,
                s.updateSapiSvc
            ]);
        }

        change.servers.forEach(function (server) {
            funcs = funcs.concat(
                function generateAlias(ctx, next) {
                    alias = change.service.name + ctx.nextId;
                    ctx.nextId += 1;
                    next();
                },
                function imgadmInstallForInstance(_, next) {
                    s.imgadmInstallRemote({
                        progress: progress,
                        img: change.image,
                        log: opts.log,
                        server: server
                    }, next);
                },
                function createInstance(_, next) {
                    change.server = server;
                    s.createInstance({
                        opts: {
                            progress: progress,
                            sdcadm: opts.sdcadm,
                            log: opts.log
                        },
                        server: server,
                        img: change.image,
                        alias: alias,
                        change: change
                    }, next);
                },
                function waitForInstanceToBeUp(_, next) {
                    s.waitForInstToBeUp({
                        opts: {
                            progress: progress,
                            sdcadm: opts.sdcadm,
                            log: opts.log
                        },
                        change: change
                    }, next);
                }
            );
        });

        funcs.push(function hupHermes(_, next) {
            svcadm.restartHermes({
                sdcadm: sdcadm,
                log: opts.log,
                progress: progress
            }, next);
        });

        opts.log.info({change: change},
                'CreateServiceInstanceV1 createSvcInst');
        vasync.pipeline({funcs: funcs, arg: arg}, nextSvc);
    }

    vasync.forEachPipeline({
        inputs: self.changes,
        func: createSvcInst
    }, cb);

};


// --- exports

module.exports = {
    CreateServiceInstanceV1: CreateServiceInstanceV1
};
// vim: set softtabstop=4 shiftwidth=4:
