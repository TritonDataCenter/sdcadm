/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
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
 * Procedure for updating moray service, HA
 */
function UpdateMorayV2(options) {
    assert.arrayOfObject(options.changes, 'options.changes');
    this.changes = options.changes;
}
util.inherits(UpdateMorayV2, Procedure);

UpdateMorayV2.prototype.summarize = function morayv2Summarize() {
    if (this.changes[0].type === 'update-instance') {
        return this.changes.map(function (ch) {
            return sprintf('update instance "%s" (%s)\n' +
                    'of service "%s" to image %s\n', ch.inst.instance,
                    ch.inst.alias, ch.service.name, ch.image.uuid) +
                common.indent(sprintf('(%s@%s)',
                    ch.image.name, ch.image.version));
        }).join('\n');
    } else {
        var word = (this.changes[0].type === 'rollback-service') ?
            'rollback' : 'update';
        var c0 = this.changes[0];
        var img = c0.image;
        var out = [sprintf('%s "%s" service to image %s', word,
                        c0.service.name, img.uuid),
                    common.indent(sprintf('(%s@%s)', img.name, img.version))];
        if (c0.insts) {
            out[0] += ':';
            out = out.concat(c0.insts.map(function (inst) {
                return common.indent(sprintf('instance "%s" (%s) in server %s',
                    inst.zonename, inst.alias, inst.server));
            }));
        }
        return out.join('\n');
    }
};


UpdateMorayV2.prototype.execute = function morayv2Execute(opts, cb) {
    common.assertStrictOptions('morayv2Execute', opts, {
        sdcadm: 'object',
        plan: 'object',
        log: 'object',
        progress: 'func',
        wrkDir: 'string'
    });
    assert.func(cb, 'cb');

    var self = this;
    var progress = opts.progress;
    var rollback = opts.plan.rollback || false;

    function updateMoray(change, nextSvc) {
        var inst = change.inst;

        var arg = {
            change: change,
            opts: opts,
            userScript: false,
            HA: false,
            tmpAlias: null,
            tmpUUID: null
        };

        if (change.insts && change.insts.length > 1) {
            arg.HA = true;
        } else {
            arg.tmpAlias = inst.alias + 'tmp';
        }

        if (opts.plan.changes.length > 1) {
            progress('');
            progress('--- Updating %s ...', change.service.name);
        }

        var funcs = [];

        if (rollback) {
            funcs.push(s.getOldUserScript);
        } else {
            funcs.push(s.getUserScript);
            funcs.push(s.writeOldUserScriptForRollback);
        }

        funcs.push(s.updateSvcUserScript);

        if (arg.HA) {
            change.insts.forEach(function (ins) {
                funcs.push(function (_, next) {
                    s.updateVmUserScriptRemote({
                        service: change.service,
                        progress: progress,
                        zonename: ins.zonename,
                        log: opts.log,
                        server: ins.server,
                        userScript: arg.userScript
                    }, next);
                });
            });
        } else {
            funcs.push(s.updateVmUserScript);
        }

        funcs.push(s.updateSapiSvc);

        if (arg.HA) {
            change.insts.forEach(function (ins) {
                funcs = funcs.concat([
                    function imgadmInstall(_, next) {
                        return s.imgadmInstallRemote({
                            progress: progress,
                            img: change.image,
                            log: opts.log,
                            server: ins.server
                        }, next);
                    },
                    function disableInstRegistrar(_, next) {
                        s.disableVMRegistrarRemote({
                            progress: progress,
                            zonename: ins.zonename,
                            log: opts.log,
                            server: ins.server
                        }, next);
                    },
                    function waitUntilInstNotInDNS(_, next) {
                        s.waitUntilVMNotInDNS({
                            log: opts.log,
                            progress: progress,
                            zonename: ins.zonename,
                            alias: ins.alias,
                            server: ins.server,
                            domain: change.service.metadata.SERVICE_DOMAIN
                        }, next);
                    },
                    function reprovisionInst(_, next) {
                        s.reprovisionRemote({
                            server: ins.server,
                            img: change.image,
                            zonename: ins.zonename,
                            progress: progress,
                            log: opts.log,
                            sdcadm: opts.sdcadm
                        }, next);
                    },
                    function waitForInstToBeUp(_, next) {
                        progress('Wait (sleep) for %s instance %s to come up',
                            ins.service, ins.zonename);
                        setTimeout(next, 15 * 1000);
                    },
                    function waitUntilInstInDNS(_, next) {
                        s.waitUntilVmInDNS({
                            log: opts.log,
                            progress: progress,
                            zonename: ins.zonename,
                            server: ins.server,
                            alias: ins.alias,
                            domain: change.service.metadata.SERVICE_DOMAIN
                        }, next);
                    }
                ]);
            });
        } else {
            funcs = funcs.concat([
                s.imgadmInstall,
                function getHeadnode(_, next) {
                    opts.sdcadm.cnapi.listServers({
                        headnode: true
                    }, function (err, servers) {
                        if (err) {
                            return next(new errors.SDCClientError(err,
                                'cnapi'));
                        }
                        arg.server_uuid = servers[0].uuid;
                        return next();
                    });
                },
                /**
                 * Create a temporary "morayXtmp" instance when no HA
                 */
                s.provisionTmpVm,
                s.waitForTmpInstToBeUp,
                s.getTmpInstanceUUID,
                s.checkIfTmpVMHasErrors,
                function waitUntilTmpInDNS(_, next) {
                    return s.waitUntilVmInDNS({
                        log: opts.log,
                        progress: progress,
                        zonename: arg.tmpUUID,
                        alias: arg.tmpAlias,
                        server: inst.server,
                        domain: change.service.metadata.SERVICE_DOMAIN
                    }, next);
                },
                function disableVMRegistrar(_, next) {
                    return s.disableVMRegistrar({
                        log: opts.log,
                        progress: progress,
                        zonename: inst.zonename
                    }, next);
                },
                function waitUntilVMNotInDNS(_, next) {
                    s.waitUntilVMNotInDNS({
                        log: opts.log,
                        progress: progress,
                        zonename: inst.zonename,
                        server: inst.server,
                        alias: inst.alias,
                        domain: change.service.metadata.SERVICE_DOMAIN
                    }, next);
                },
                s.reprovision,
                s.waitForInstToBeUp,
                function waitUntilVmInDNS(_, next) {
                    s.waitUntilVmInDNS({
                        log: opts.log,
                        progress: progress,
                        zonename: inst.zonename,
                        alias: inst.alias,
                        server: inst.server,
                        domain: change.service.metadata.SERVICE_DOMAIN
                    }, next);
                },
                function disableTmpVMRegistrar(_, next) {
                    return s.disableVMRegistrar({
                        log: opts.log,
                        progress: progress,
                        zonename: arg.tmpUUID
                    }, next);
                },
                function waitUntilTmpVMNotInDNS(_, next) {
                    return s.waitUntilVMNotInDNS({
                        log: opts.log,
                        progress: progress,
                        zonename: arg.tmpUUID,
                        alias: arg.tmpAlias,
                        server: inst.server,
                        domain: change.service.metadata.SERVICE_DOMAIN
                    }, next);
                },
                s.stopTmpVm,
                s.destroyTmpVM
            ]);
        }
        vasync.pipeline({funcs: funcs, arg: arg}, nextSvc);
    }

    vasync.forEachPipeline({
        inputs: self.changes,
        func: updateMoray
    }, cb);
};
//---- exports

module.exports = {
    UpdateMorayV2: UpdateMorayV2
};
// vim: set softtabstop=4 shiftwidth=4:
