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

var vasync = require('vasync');

var Procedure = require('./procedure').Procedure;
var s = require('./shared');
var common = require('../common');

/**
 * This is a limited first pass procedure for updating a set of stateless SDC
 * services.
 *
 * Limitations:
 * - the service must only have one instance
 * - the instance must be on the headnode (where `sdcadm` is running)
 * - we only support the "stateless" easy-to-update services that don't require
 *   any migrations, bootstrapping, etc.
 */
function UpdateStatelessServicesV1(options) {
    assert.arrayOfObject(options.changes, 'options.changes');
    this.changes = options.changes;
}
util.inherits(UpdateStatelessServicesV1, Procedure);

UpdateStatelessServicesV1.prototype.summarize = function ussv1Summarize() {
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

UpdateStatelessServicesV1.prototype.execute = function ussv1Execute(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.plan, 'opts.plan');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.progress, 'opts.progress');
    assert.string(opts.wrkDir, 'opts.wrkDir');
    assert.func(cb, 'cb');
    var self = this;
    var rollback = opts.plan.rollback || false;

    function updateSvc(change, nextSvc) {
        var arg = {
            change: change,
            opts: opts,
            userScript: false
        };

        if (opts.plan.changes.length > 1) {
            opts.progress('');
            opts.progress('--- Updating %s ...', change.service.name);
        }

        var steps = [];
        if (rollback) {
            steps.push(s.getOldUserScript);
        } else {
            steps.push(s.getUserScript);
            steps.push(s.writeOldUserScriptForRollback);
        }
        if (change.service.metadata) {  // workaround for assets (TOOLS-695)
            if (rollback) {
                steps.push(s.getOldUserScript);
            } else {
                steps.push(s.getUserScript);
                steps.push(s.writeOldUserScriptForRollback);
            }
            steps = steps.concat([
                s.updateSvcUserScript,
                s.updateSapiSvc
            ]);
        }
        if (change.inst) {
            // Some svcs might not have an instance (e.g. the manta zone).
            steps = steps.concat([
                s.updateVmUserScript,
                s.imgadmInstall,
                s.reprovision,
                s.waitForInstToBeUp
            ]);
        }

        opts.log.info({change: change}, 'UpdateStatelessServicesV1 updateSvc');
        vasync.pipeline({funcs: steps, arg: arg}, nextSvc);
    }

    // For now we'll update services in series.
    // TODO: Should eventually be able to do this in parallel, or batches.
    vasync.forEachPipeline({
        inputs: self.changes,
        func: updateSvc
    }, cb);
};



//---- exports

module.exports = {
    UpdateStatelessServicesV1: UpdateStatelessServicesV1
};
// vim: set softtabstop=4 shiftwidth=4:
