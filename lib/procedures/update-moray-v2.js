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
 * Procedure for updating moray service, HA
 */
function UpdateMorayV2(options) {
    assert.arrayOfObject(options.changes, 'options.changes');
    this.changes = options.changes;
}
util.inherits(UpdateMorayV2, Procedure);

UpdateMorayV2.prototype.summarize = function morayv2Summarize() {
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


UpdateMorayV2.prototype.execute = function morayv2Execute(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.plan, 'opts.plan');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.progress, 'opts.progress');
    assert.string(opts.wrkDir, 'opts.wrkDir');
    assert.func(cb, 'cb');
    var self = this;
    var progress = opts.progress;

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

        var funcs = [
            s.getUserScript,
            s.writeOldUserScriptForRollback,
            s.updateSvcUserScript
        ];

        if (arg.HA) {
            funcs.push(function updateFirstInstUserScript(_, next) {
                s.updateVmUserScriptRemote({
                    service: change.service,
                    progress: progress,
                    zonename: change.insts[0].zonename,
                    log: opts.log,
                    server: change.insts[0].server,
                    userScript: arg.userScript
                }, next);
            });
            funcs.push(function updateSecondInstUserScript(_, next) {
                s.updateVmUserScriptRemote({
                    service: change.service,
                    progress: progress,
                    zonename: change.insts[1].zonename,
                    log: opts.log,
                    server: change.insts[1].server,
                    userScript: arg.userScript
                }, next);
            });

        } else {
            funcs.push(s.updateVmUserScript);
        }

        funcs.push(s.updateSapiSvc);

        if (arg.HA) {
            funcs = funcs.concat([
                function imgadmInstallForFirstInst(_, next) {
                    return s.imgadmInstallRemote({
                        progress: progress,
                        img: change.image,
                        log: opts.log,
                        server: change.insts[0].server
                    }, next);
                },
                function disableFirstInstRegistrar(_, next) {
                    s.disableVMRegistrarRemote({
                        progress: progress,
                        zonename: change.insts[0].zonename,
                        log: opts.log,
                        server: change.insts[0].server
                    }, next);
                },
                function waitUntilFirstInstNotInDNS(_, next) {
                    s.waitUntilVMNotInDNS({
                        log: opts.log,
                        progress: progress,
                        zonename: change.insts[0].zonename,
                        alias: change.insts[0].alias,
                        domain: change.service.metadata.SERVICE_DOMAIN
                    }, next);
                },
                function reprovisionFirstInst(_, next) {
                    s.reprovisionRemote({
                        server: change.insts[0].server,
                        img: change.image,
                        zonename: change.insts[0].zonename,
                        progress: progress,
                        log: opts.log
                    }, next);
                },
                function waitForFirstInstToBeUp(_, next) {
                    progress('Wait (sleep) for %s instance %s to come up',
                        change.insts[0].service, change.insts[0].zonename);
                    setTimeout(next, 15 * 1000);
                },
                function waitUntilFirstInstInDNS(_, next) {
                    s.waitUntilVmInDNS({
                        log: opts.log,
                        progress: progress,
                        zonename: change.insts[0].zonename,
                        alias: change.insts[0].alias,
                        domain: change.service.metadata.SERVICE_DOMAIN
                    }, next);
                },
                // Second instance.
                // TODO(pedro): Shall we assume we could have more than 2?
                function imgadmInstallForSecondInst(_, next) {
                    return s.imgadmInstallRemote({
                        progress: progress,
                        img: change.image,
                        log: opts.log,
                        server: change.insts[1].server
                    }, next);
                },
                function disableSecondInstRegistrar(_, next) {
                    s.disableVMRegistrarRemote({
                        progress: progress,
                        zonename: change.insts[1].zonename,
                        log: opts.log,
                        server: change.insts[1].server
                    }, next);
                },
                function waitUntilSecondInstNotInDNS(_, next) {
                    s.waitUntilVMNotInDNS({
                        log: opts.log,
                        progress: progress,
                        zonename: change.insts[1].zonename,
                        alias: change.insts[1].alias,
                        domain: change.service.metadata.SERVICE_DOMAIN
                    }, next);
                },
                function reprovisionSecondInst(_, next) {
                    s.reprovisionRemote({
                        server: change.insts[1].server,
                        img: change.image,
                        zonename: change.insts[1].zonename,
                        progress: progress,
                        log: opts.log
                    }, next);
                },
                function waitForSecondInstToBeUp(_, next) {
                    progress('Wait (sleep) for %s instance %s to come up',
                        change.insts[1].service, change.insts[1].zonename);
                    setTimeout(next, 15 * 1000);
                },
                function waitUntilSecondInstInDNS(_, next) {
                    s.waitUntilVmInDNS({
                        log: opts.log,
                        progress: progress,
                        zonename: change.insts[1].zonename,
                        alias: change.insts[1].alias,
                        domain: change.service.metadata.SERVICE_DOMAIN
                    }, next);
                }
            ]);
        } else {
            funcs = funcs.concat([
                s.imgadmInstall,
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
