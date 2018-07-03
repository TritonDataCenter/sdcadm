/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var assert = require('assert-plus');
var sprintf = require('extsprintf').sprintf;
var util = require('util');
var vasync = require('vasync');

var errors = require('../errors');
var common = require('../common');
var vmadm = require('../vmadm');

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
        return this.changes.map(function (ch) {
            return sprintf('%s "%s" service to image %s\n', word,
                    ch.service.name, ch.image.uuid) +
                common.indent(sprintf('(%s@%s)',
                    ch.image.name, ch.image.version));
        }).join('\n');
    }
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
    var rollback = opts.plan.rollback || false;

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

        vasync.pipeline({funcs: funcs.concat([
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
            function getHeadnode(_, next) {
                sdcadm.getCurrServerUuid(function (err, hn) {
                    if (err) {
                        next(err);
                        return;
                    }
                    arg.server_uuid = hn;
                    next();
                });
            },
            /**
             * Create a temporary "sapiXtmp" instance when no HA
             */
            s.provisionTmpVm,
            s.waitForTmpInstToBeUp,
            s.getTmpInstanceUUID,
            s.checkIfTmpVMHasErrors,
            function waitUntilTmpInDNS(_, next) {
                if (arg.HA) {
                    next();
                    return;
                }
                s.waitUntilVmInDNS({
                    log: opts.log,
                    progress: progress,
                    zonename: arg.tmpUUID,
                    alias: arg.tmpAlias,
                    server: inst.server,
                    domain: change.service.metadata.SERVICE_DOMAIN,
                    cnapi: opts.sdcadm.cnapi
                }, next);
            },
            // Common to both HA/no-HA
            function disableVMRegistrar(_, next) {
                s.disableVMRegistrar({
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
                    server: inst.server,
                    domain: change.service.metadata.SERVICE_DOMAIN,
                    cnapi: opts.sdcadm.cnapi
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
                    domain: change.service.metadata.SERVICE_DOMAIN,
                    cnapi: opts.sdcadm.cnapi
                }, next);
            },
            // And, again, no-HA only:,
            function disableTmpVMRegistrar(_, next) {
                if (arg.HA) {
                    next();
                    return;
                }

                s.disableVMRegistrar({
                    log: opts.log,
                    progress: progress,
                    zonename: arg.tmpUUID
                }, next);
            },
            function waitUntilTmpVMNotInDNS(_, next) {
                if (arg.HA) {
                    next();
                    return;
                }
                s.waitUntilVMNotInDNS({
                    log: opts.log,
                    progress: progress,
                    zonename: arg.tmpUUID,
                    alias: arg.tmpAlias,
                    server: inst.server,
                    domain: change.service.metadata.SERVICE_DOMAIN,
                    cnapi: opts.sdcadm.cnapi
                }, next);
            },
            s.stopTmpVm,
            s.destroyTmpVM
        ]), arg: arg}, nextSvc);
    }

    // Mirroring UpdateStatelessServicesV1, even though here we should
    // only have one instance.
    vasync.forEachPipeline({
        inputs: self.changes,
        func: updateSapi
    }, cb);

};
// --- exports

module.exports = {
    UpdateSingleHNSapiV1: UpdateSingleHNSapiV1
};
// vim: set softtabstop=4 shiftwidth=4:
