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
 * First pass procedure for updating sapi service
 *
 * Limitations:
 * - the service must only have one instance
 * - the instance must be on the headnode (where `sdcadm` is running)
 */
function UpdateSingleHNSapiV1(options) {
    assert.arrayOfObject(options.changes, 'options.changes');
    this.changes = options.changes;
}
util.inherits(UpdateSingleHNSapiV1, Procedure);

UpdateSingleHNSapiV1.prototype.summarize = function sapiv1Summarize() {
    return this.changes.map(function (ch) {
        return sprintf('update "%s" service to image %s (%s@%s)',
            ch.service.name, ch.image.uuid, ch.image.name, ch.image.version);
    }).join('\n');
};


UpdateSingleHNSapiV1.prototype.execute = function sapiv1Execute(opts, cb) {
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

    function updateSapi(change, nextSvc) {
        var inst = change.inst;
        var arg = {
            change: change,
            opts: opts,
            userScript: false,
            HA: false,
            tmpAlias: inst.alias + 'tmp',
            tmpUUID: null
        };
        vasync.pipeline({funcs: [
            s.getUserScript,
            s.writeOldUserScriptForRollback,
            s.updateSvcUserScript,
            s.updateVmUserScript,
            s.updateSapiSvc,
            s.imgadmInstall,

            // Workaround SAPI-199 and TOOLS-638
            function updateServiceSapiURL(_, next) {
                progress('Updating \'sapi-url\' in SAPI');
                sdcadm.sapi.updateService(change.service.uuid, {
                    metadata: {
                        'sapi-url': 'http://' +
                            change.service.metadata.SERVICE_DOMAIN
                    }
                }, errors.sdcClientErrWrap(next, 'sapi'));
            },

            function updateVmSapiURL(_, next) {
                progress('Updating \'sapi-url\' in VM ' + inst.zonename);
                vmadm.vmUpdate(inst.zonename, {
                    set_customer_metadata: {
                        'sapi-url': 'http://' +
                            change.service.metadata.SERVICE_DOMAIN
                    }
                }, opts, next);
            },
            s.checkHA,
            /**
             * Create a temporary "sapiXtmp" instance when no HA
             */
            s.provisionTmpVm,
            s.waitForTmpInstToBeUp,
            s.getTmpInstanceUUID,
            s.checkIfTmpVMHasErrors,
            function waitUntilTmpInDNS(_, next) {
                if (arg.HA) {
                    return next();
                }
                return s.waitUntilVmInDNS({
                    log: opts.log,
                    progress: progress,
                    zonename: arg.tmpUUID,
                    alias: arg.tmpAlias,
                    domain: change.service.metadata.SERVICE_DOMAIN
                }, next);
            },
            // Common to both HA/no-HA
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
            // And, again, no-HA only:,
            function disableTmpVMRegistrar(_, next) {
                if (arg.HA) {
                    return next();
                }

                return s.disableVMRegistrar({
                    log: opts.log,
                    progress: progress,
                    zonename: arg.tmpUUID
                }, next);
            },
            function waitUntilTmpVMNotInDNS(_, next) {
                if (arg.HA) {
                    return next();
                }
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
        ], arg: arg}, nextSvc);
    }

    // Mirroring UpdateStatelessServicesV1 above, even though here we should
    // only have one instance.
    vasync.forEachPipeline({
        inputs: self.changes,
        func: updateSapi
    }, cb);

};
//---- exports

module.exports = {
    UpdateSingleHNSapiV1: UpdateSingleHNSapiV1
};
// vim: set softtabstop=4 shiftwidth=4:
