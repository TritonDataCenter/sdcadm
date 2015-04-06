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
var vasync = require('vasync');

var common = require('../common');

var Procedure = require('./procedure').Procedure;
var s = require('./shared');

/**
 * Procedure for updating mahi service, HA.
 */
function UpdateMahiV2(options) {
    assert.arrayOfObject(options.changes, 'options.changes');
    this.changes = options.changes;
}
util.inherits(UpdateMahiV2, Procedure);

UpdateMahiV2.prototype.summarize = function ushiSummarize() {
    var word = (this.changes[0].type === 'rollback-service') ?
        'rollback' : 'update';
    var c0 = this.changes[0];
    var img = c0.image;
    var out = [sprintf('%s "%s" service to image %s (%s@%s)', word,
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

UpdateMahiV2.prototype.execute = function ushiExecute(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.plan, 'opts.plan');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.progress, 'opts.progress');
    assert.string(opts.wrkDir, 'opts.wrkDir');
    assert.func(cb, 'cb');
    var self = this;
    var progress = opts.progress;
    var rollback = opts.plan.rollback || false;

    function updateMahi(change, nextSvc) {
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
                    s.ensureDelegateDataset({
                        service: change.service,
                        progress: progress,
                        zonename: ins.zonename,
                        log: opts.log,
                        server: ins.server
                    }, next);
                });
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
            funcs.push(function (_, next) {
                s.ensureDelegateDataset({
                    service: change.service,
                    progress: progress,
                    zonename: inst.zonename,
                    log: opts.log,
                    server: inst.server
                }, next);
            });
            funcs.push(s.updateVmUserScript);
        }

        funcs.push(s.updateSapiSvc);

        if (arg.HA) {
            change.insts.forEach(function (ins) {
                funcs = funcs.concat(
                    function imgadmInstall(_, next) {
                        return s.imgadmInstallRemote({
                            progress: progress,
                            img: change.image,
                            log: opts.log,
                            server: ins.server
                        }, next);
                    },
                    function reprovisionInst(_, next) {
                        s.reprovisionRemote({
                            server: ins.server,
                            img: change.image,
                            zonename: ins.zonename,
                            progress: progress,
                            log: opts.log
                        }, next);
                    },
                    function waitForInstToBeUp(_, next) {
                        progress('Wait (sleep) for %s instance %s to come up',
                            ins.service, ins.zonename);
                        setTimeout(next, 15 * 1000);
                    }
                );
            });
        } else {
            funcs = funcs.concat([
                s.imgadmInstall,
                s.reprovision,
                s.waitForInstToBeUp
            ]);
        }
        vasync.pipeline({funcs: funcs, arg: arg}, nextSvc);
    }

    vasync.forEachPipeline({
        inputs: self.changes,
        func: updateMahi
    }, cb);
};
//---- exports

module.exports = {
    UpdateMahiV2: UpdateMahiV2
};
// vim: set softtabstop=4 shiftwidth=4:
