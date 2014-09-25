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
 * First pass procedure for updating moray service
 *
 * Limitations:
 * - the service must only have one instance
 * - the instance must be on the headnode (where `sdcadm` is running)
 */
function UpdateSingleHNMorayV1(options) {
    assert.arrayOfObject(options.changes, 'options.changes');
    this.changes = options.changes;
}
util.inherits(UpdateSingleHNMorayV1, Procedure);

UpdateSingleHNMorayV1.prototype.summarize = function morayv1Summarize() {
    return this.changes.map(function (ch) {
        return sprintf('update "%s" service to image %s (%s@%s)',
            ch.service.name, ch.image.uuid, ch.image.name, ch.image.version);
    }).join('\n');
};


UpdateSingleHNMorayV1.prototype.execute = function morayv1Execute(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.plan, 'opts.plan');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.progress, 'opts.progress');
    assert.string(opts.wrkDir, 'opts.wrkDir');
    assert.func(cb, 'cb');
    var self = this;

    function updateMoray(change, nextSvc) {
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
            s.checkHA,
            /**
             * Create a temporary "morayXtmp" instance when no HA
             */
            s.provisionTmpVm,
            s.waitForTmpInstToBeUp,
            s.getTmpInstanceUUID,
            s.checkIfTmpVMHasErrors,
            s.waitUntilTmpInDNS,
            s.disableVMRegistrar,
            s.waitUntilVMNotInDNS,
            // Common to both HA/no-HA
            s.reprovision,
            s.waitForInstToBeUp,
            s.waitUntilVmInDNS,
            // And, again, no-HA only:
            s.disableTmpVMRegistrar,
            s.waitUntilTmpVMNotInDNS,
            s.stopTmpVm,
            s.destroyTmpVM
        ], arg: arg}, nextSvc);
    }

    // Mirroring UpdateStatelessServicesV1 above, even though here we should
    // only have one instance.
    vasync.forEachPipeline({
        inputs: self.changes,
        func: updateMoray
    }, cb);
};
//---- exports

module.exports = {
    UpdateSingleHNMorayV1: UpdateSingleHNMorayV1
};
// vim: set softtabstop=4 shiftwidth=4:
