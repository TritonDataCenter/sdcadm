/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */
var assert = require('assert-plus');
var sprintf = require('extsprintf').sprintf;
var util = require('util');
var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');
var Procedure = require('./procedure').Procedure;
var s = require('./shared');

function UpdateSapiV2(options) {
    assert.arrayOfObject(options.changes, 'options.changes');
    this.changes = options.changes;
}
util.inherits(UpdateSapiV2, Procedure);

UpdateSapiV2.prototype.summarize = function sapiv2Summarize() {
    var out = [];
    this.changes.forEach(function summarizeChange(ch) {
        if (ch.type === 'update-instance') {
            out.push(sprintf('update instance "%s" (%s)\n' +
                        'of service "%s" to image %s\n', ch.inst.instance,
                        ch.inst.alias, ch.service.name, ch.image.uuid),
                    common.indent(sprintf('(%s@%s)',
                        ch.image.name, ch.image.version)));
        } else {
            var word = (ch.type === 'rollback-service') ?
                'rollback' : 'update';
            var img = ch.image;
            var msg = sprintf('%s "%s" service to image %s\n',
                        word, ch.service.name, img.uuid) +
                    common.indent(sprintf('(%s@%s)', img.name, img.version));

            if (ch.insts) {
                msg += ':\n';
                msg += ch.insts.map(function (inst) {
                    return common.indent(sprintf(
                        'instance "%s" (%s) on server %s',
                        inst.zonename, inst.alias, inst.server));
                }).join('\n');
            } else if (ch.inst) {
                msg += ':\n';
                msg += common.indent(sprintf(
                        'instance "%s" (%s) on server %s',
                        ch.inst.zonename, ch.inst.alias, ch.inst.server));
            }
            out.push(msg);
        }
    });

    return out.join('\n');
};


UpdateSapiV2.prototype.execute = function sapiv2Execute(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.plan, 'opts.plan');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.progress, 'opts.progress');
    assert.string(opts.wrkDir, 'opts.wrkDir');
    assert.func(cb, 'cb');
    var self = this;
    var progress = opts.progress;
    var rollback = opts.plan.rollback || false;
    var sdcadm = opts.sdcadm;


    function updateSapi(change, nextSvc) {

        const SAPI_URL = 'http://' + change.service.metadata.SERVICE_DOMAIN;

        var arg = {
            change: change,
            opts: opts,
            userScript: false,
            tmpUUID: null
        };

        if (!change.insts) {
            change.insts = change.inst ? [change.inst] : [];
        }

        if (opts.plan.changes.length > 1) {
            progress('');
            progress('--- Updating %s ...', change.service.name);
        }

        var funcs = [
            function ensureFullMode(_, next) {
                progress('Verifying SAPI full mode');
                sdcadm.sapi.getMode(function (err, m) {
                    if (err) {
                        next(err);
                        return;
                    }

                    if (m !== 'full') {
                        var msg = 'SAPI is not in full mode. ' +
                            'This could mean initial setup failed. ' +
                            'Please fix SAPI VMs before continue.';
                        next(new errors.UpdateError(new Error(msg), 'sapi'));
                        return;
                    }
                    next();
                });
            }
        ];

        if (rollback) {
            funcs.push(s.getOldUserScript);
        } else {
            funcs.push(s.getUserScript);
            funcs.push(s.writeOldUserScriptForRollback);
        }
        funcs.push(s.updateSvcUserScript);

        change.insts.forEach(function updateInstsVmUserScript(ins) {
            funcs.push(function updateVmUserScript(_, next) {
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

        funcs.push(s.updateSapiSvc);
        // Workaround SAPI-199 and TOOLS-638
        funcs.push(function updateServiceSapiURL(_, next) {
            progress('Updating \'sapi-url\' in SAPI');
            sdcadm.sapi.updateService(change.service.uuid, {
                metadata: {
                    'sapi-url': SAPI_URL
                }
            }, errors.sdcClientErrWrap(next, 'sapi'));
        });

        change.insts.forEach(function (ins) {
            funcs = funcs.concat(
                function imgadmInstallForInstance(_, next) {
                    return s.imgadmInstallRemote({
                        progress: progress,
                        img: change.image,
                        log: opts.log,
                        server: ins.server
                    }, next);
                },
                function reprovisionInstance(_, next) {
                    s.reprovisionRemote({
                        server: ins.server,
                        img: change.image,
                        zonename: ins.zonename,
                        progress: progress,
                        log: opts.log,
                        sdcadm: opts.sdcadm
                    }, next);
                },
                function waitForInstanceToBeUp(_, next) {
                    s.waitForInstToBeUp({
                        opts: {
                            progress: progress,
                            sdcadm: opts.sdcadm,
                            log: opts.log
                        },
                        change: {
                            inst: ins
                        }
                    }, next);
                },
                function updateVmSapiUrl(_, next) {
                    s.updateVmMetadataRemote({
                        sdcadm: opts.sdcadm,
                        progress: progress,
                        zonename: ins.zonename,
                        log: opts.log,
                        server: ins.server,
                        metadata: {
                            'sapi-url': SAPI_URL
                        }
                    }, next);
                }
            );
        });

        vasync.pipeline({funcs: funcs, arg: arg}, nextSvc);

    }

    vasync.forEachPipeline({
        inputs: self.changes,
        func: updateSapi
    }, cb);
};

// --- exports

module.exports = {
    UpdateSapiV2: UpdateSapiV2
};
// vim: set softtabstop=4 shiftwidth=4:
