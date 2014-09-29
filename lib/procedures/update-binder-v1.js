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
 * A limited first attempt procedure for updating binder.
 *
 * This is the first replacement for "upgrade-binder.sh" from the
 * incr-upgrade scripts.
 *
 * Limitations:
 * - the service must only have one instance
 * - the instance must be on the headnode (where `sdcadm` is running)
 */
function UpdateBinderV1(options) {
    assert.arrayOfObject(options.changes, 'options.changes');
    this.changes = options.changes;
}
util.inherits(UpdateBinderV1, Procedure);

UpdateBinderV1.prototype.summarize = function ushiSummarize() {
    return this.changes.map(function (ch) {
        return sprintf('update "%s" service to image %s (%s@%s)',
            ch.service.name, ch.image.uuid, ch.image.name, ch.image.version);
    }).join('\n');
};

UpdateBinderV1.prototype.execute = function ushiExecute(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.plan, 'opts.plan');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.progress, 'opts.progress');
    assert.string(opts.wrkDir, 'opts.wrkDir');
    assert.func(cb, 'cb');
    var self = this;
    var log = opts.log;
    // var progress = opts.progress;

    // Mirroring UpdateStatelessServicesV1 above, even though here we should
    // only have one instance.
    vasync.forEachPipeline({
        inputs: self.changes,
        func: updateBinder
    }, cb);


    function updateBinder(change, nextSvc) {
        var arg = {
            change: change,
            opts: opts,
            userScript: false
        };
        var inst = change.inst;
        vasync.pipeline({funcs: [
            function bailIfBinderHasNoDelegate(_, next) {
                vmadm.vmGet(inst.zonename, {log: log}, function (err, vm) {
                    if (err) {
                        return next(err);
                    }
                    var expectedDs = sprintf('zones/%s/data', inst.zonename);
                    log.debug({expectedDs: expectedDs, vm: vm}, 'binder vm');
                    if (vm.datasets.indexOf(expectedDs) === -1) {
                        return next(new errors.UpdateError(format(
                            'binder vm %s has no "%s" delegate dataset, ' +
                            'upgrading it would lose image file data',
                            vm.uuid, expectedDs)));
                    }
                    next();
                });
            },
            s.getUserScript,
            s.writeOldUserScriptForRollback,
            s.updateSvcUserScript,
            s.updateVmUserScript,
            s.updateSapiSvc,
            s.imgadmInstall,
            s.reprovision,
            s.waitForInstToBeUp
        ], arg: arg}, nextSvc);
    }
};
//---- exports

module.exports = {
    UpdateBinderV1: UpdateBinderV1
};
// vim: set softtabstop=4 shiftwidth=4:
