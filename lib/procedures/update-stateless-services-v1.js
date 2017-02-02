/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */

var assert = require('assert-plus');
var sprintf = require('extsprintf').sprintf;
var util = require('util');
var vasync = require('vasync');

var Procedure = require('./procedure').Procedure;
var s = require('./shared');
var common = require('../common');
var errors = require('../errors');

/**
 * Procedure for updating a set of stateless SDC services.
 *
 * This procedure doesn't have the previous version limitations of only being
 * able to update single service instances constrained to the Headnode.
 *
 * Limitations:
 * - we only support the "stateless" easy-to-update services that don't require
 *   any migrations, bootstrapping, etc.
 */
function UpdateStatelessServices(options) {
    assert.arrayOfObject(options.changes, 'options.changes');
    this.changes = options.changes;
}
util.inherits(UpdateStatelessServices, Procedure);


UpdateStatelessServices.prototype.summarize = function ussv2Summarize() {
    var out = [];
    this.changes.forEach(function (ch) {
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

UpdateStatelessServices.prototype.execute = function ussv2Execute(opts, cb) {
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

    function updateService(change, nextSvc) {
        var inst = change.inst;

        var arg = {
            change: change,
            opts: opts,
            userScript: false,
            HA: false,
            tmpUUID: null
        };

        if ((change.insts && change.insts.length > 1) || change.HA) {
            arg.HA = true;
        }

        if (opts.plan.changes.length > 1) {
            progress('');
            progress('--- Updating %s ...', change.service.name);
        }

        var funcs = [];
        if (change.service.metadata) {  // workaround for assets (TOOLS-695)
            if (rollback) {
                funcs.push(s.getOldUserScript);
            } else {
                funcs.push(s.getUserScript);
                funcs.push(s.writeOldUserScriptForRollback);
            }

            funcs.push(s.updateSvcUserScript);
        }

        if (arg.HA) { // Assume assets will not be HA setup for now
            change.insts.forEach(function (ins) {
                if (change.service.params.delegate_dataset) {
                    funcs.push(function (_, next) {
                        s.ensureDelegateDataset({
                            service: change.service,
                            progress: progress,
                            zonename: ins.zonename,
                            log: opts.log,
                            server: ins.server
                        }, next);
                    });
                }
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
        } else if (change.inst) {
            /*
             * If the service params require a delegate dataset, then ensure
             * the instance has one.
             *
             * Also another workaround for assets, which has a limited hacked
             * in 'service' object.
             */
            if (change.service.params) {
                assert.optionalBool(change.service.params.delegate_dataset,
                    'change.service.params.delegate_dataset');
                if (change.service.params.delegate_dataset) {
                    funcs.push(function (_, next) {
                        s.ensureDelegateDataset({
                            service: change.service,
                            progress: progress,
                            zonename: inst.zonename,
                            log: opts.log,
                            server: inst.server
                        }, next);
                    });
                }
            }

            funcs.push(function (_, next) {
                s.updateVmUserScriptRemote({
                    service: change.service,
                    progress: progress,
                    zonename: inst.zonename,
                    log: opts.log,
                    server: inst.server,
                    userScript: arg.userScript
                }, next);
            });
        }

        if (change.service.metadata) {  // workaround for assets (TOOLS-695)
            funcs.push(s.updateSapiSvc);
        }

        if (arg.HA) {
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
                    }
                );
            });
        } else if (change.inst) {
            funcs = funcs.concat([
                function imgadmInstall(_, next) {
                    return s.imgadmInstallRemote({
                        progress: progress,
                        img: change.image,
                        log: opts.log,
                        server: inst.server
                    }, next);
                },
                function reprovisionInst(_, next) {
                    s.reprovisionRemote({
                        server: inst.server,
                        img: change.image,
                        zonename: inst.zonename,
                        progress: progress,
                        log: opts.log,
                        sdcadm: opts.sdcadm
                    }, next);
                },
                s.waitForInstToBeUp
            ]);
        }
        vasync.pipeline({funcs: funcs, arg: arg}, nextSvc);
    }

    // TOOLS-1465: when updating individual instances, need to double check if
    // service is part or not of an HA setup
    function checkServiceHA(change, nextSvc) {
        opts.sdcadm.sapi.listInstances({
            service_uuid: change.service.uuid
        }, function (err, insts) {
            if (err) {
                return nextSvc(new errors.SDCClientError(err, 'SAPI'));
            }
            if (insts.length > 1) {
                change.HA = true;
                if (!change.insts) {
                    change.insts = [change.inst];
                }
            }
            return updateService(change, nextSvc);
        });
    }

    vasync.forEachPipeline({
        inputs: self.changes,
        func: checkServiceHA
    }, cb);
};


//---- exports

module.exports = {
    UpdateStatelessServices: UpdateStatelessServices
};
// vim: set softtabstop=4 shiftwidth=4:
