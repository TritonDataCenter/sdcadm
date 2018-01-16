/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018 Joyent, Inc.
 */

var assert = require('assert-plus');
var sprintf = require('extsprintf').sprintf;
var util = require('util');
var vasync = require('vasync');
var verror = require('verror');

var errors = require('../errors');
var common = require('../common');

var Procedure = require('./procedure').Procedure;
var s = require('./shared');

var TMP_VM_RE = /^moray\d+tmp$/;

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
            out = out.concat(c0.insts.filter(function filterTmpInsts(inst) {
                return !TMP_VM_RE.test(inst.alias);
            }).map(function instanceMsg(inst) {
                return common.indent(sprintf('instance "%s" (%s) in server %s',
                    inst.zonename, inst.alias, inst.server));
            }));
        }
        return out.join('\n');
    }
};

/*
 * The update of moray service instances will happen as follows:
 *
 * First, we're gonna check if we're on HA setup and, if that's the
 * case, we'll just proceed with the update of each one of the existing
 * instances, giving that the existence of more of one moray instance
 * grants the availability of the service and, therefore, of all the
 * APIs involved into the update process.
 *
 * In case we're not on HA setup, we need to create a temporary instance
 * (usually aliased moray0tmp), in order to avoid service disruption during
 * the upgrade process. Once the update has been completed, we remove the
 * temporary instance, leaving system on the same state we found it.
 *
 * Sometimes, we may fail destroying this temporary instance, either leaving
 * the zone around, or destroying the zone, but leaving the sapi record not
 * removed. This can cause the next update attempt to incorrectly interpret
 * that we're into HA setup, which is not correct. In case we've just left
 * the SAPI record around, we'll destroy it and continue normally. If we've
 * also left the VM, we'll take advantage of it in order to speed up the
 * update process and, once we're done, remove it, returning the system to
 * the expected state.
 */

UpdateMorayV2.prototype.execute = function morayv2Execute(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.plan, 'opts.plan');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.progress, 'opts.progress');
    assert.func(cb, 'cb');

    var self = this;
    var progress = opts.progress;
    var rollback = opts.plan.rollback || false;
    var sdcadm = opts.sdcadm;

    function updateMoray(change, nextSvc) {

        var arg = {
            change: change,
            opts: opts,
            userScript: false,
            // We already know if we're on HA setup from `checkServiceHA`:
            HA: change.HA,
            tmpAlias: null,
            tmpUUID: null,
            tmpInstanceExists: false
        };


        if (opts.plan.changes.length > 1) {
            progress('');
            progress('--- Updating %s ...', change.service.name);
        }

        var funcs = [];

        if (change.tmpInsts) {
            // If we have temporary instances around we want to check if
            // those are just legacy SAPI instances w/o a running VM and
            // clear them, or if we could take advantage of those temporary
            // instances to speed up the update process otherwise:
            funcs.push(function checkTmpInstsVms(ctx, next) {
                vasync.forEachParallel({
                    func: function getVmapiVm(tmpInst, nextVm) {
                        sdcadm.vmapi.getVm({
                            uuid: tmpInst.uuid
                        }, function (vmErr, vm) {
                            if (vmErr) {
                                if (verror.hasCauseWithName(
                                    vmErr, 'ResourceNotFoundError')) {
                                    ctx.tmpInstToRemove =
                                        ctx.tmpInstToRemove || [];
                                    ctx.tmpInstToRemove.push(tmpInst.uuid);
                                    nextVm();
                                    return;
                                }
                                nextVm(new errors.SDCClientError(vmErr,
                                    'vmapi'));
                                return;
                            }

                            if (vm.state !== 'running') {
                                ctx.tmpInstToRemove = ctx.tmpInstToRemove || [];
                                ctx.tmpInstToRemove.push(tmpInst.uuid);
                            } else {
                                // We can safely set tmpAlias and tmpUUID
                                // values here to our existing tmp instance
                                ctx.tmpAlias = tmpInst.params.alias;
                                ctx.tmpUUID = tmpInst.uuid;
                                ctx.tmpInstanceExists = true;
                            }
                            nextVm();
                        });
                    },
                    inputs: ctx.change.tmpInsts
                }, next);
            });
            // Remove SAPI instances without a running VM from change.tmpInsts:
            funcs.push(function removeDestroyedInsts(ctx, next) {
                if (!ctx.tmpInstToRemove || !ctx.tmpInstToRemove.length) {
                    next();
                    return;
                }
                ctx.change.tmpInsts = ctx.change.tmpInsts.filter(
                    function removeDestroyedInst(inst) {
                    return (!ctx.tmpInstToRemove.indexOf(inst.uuid));
                });
                next();
            });
            // Remove SAPI instances w/o a running VM from SAPI:
            funcs.push(function removeInstFromSapi(ctx, next) {
                if (!ctx.tmpInstToRemove || !ctx.tmpInstToRemove.length) {
                    next();
                    return;
                }
                vasync.forEachParallel({
                    inputs: ctx.tmpInstToRemove,
                    func: function removeFromSapi(inst, nextInst) {
                        sdcadm.sapi.deleteInstance(inst, function (remErr) {
                            if (remErr && !verror.hasCauseWithName(remErr,
                                'ResourceNotFoundError')) {
                                nextInst(new errors.SDCClientError(remErr,
                                    'sapi'));
                                return;
                            }
                            nextInst();
                        });
                    }
                }, next);
            });
        }

        if (change.tmpInsts || !arg.HA) {
            funcs.push(function setTmpInstAlias(ctx, next) {
                if (ctx.tmpAlias) {
                    next();
                    return;
                }
                ctx.tmpAlias  = ctx.change.insts[0].alias + 'tmp';
                next();
            });
        }

        if (rollback) {
            funcs.push(s.getOldUserScript);
        } else {
            funcs.push(s.getUserScript);
            funcs.push(s.writeOldUserScriptForRollback);
        }

        funcs.push(s.updateSvcUserScript);

        change.insts.forEach(function (ins) {
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

        if (arg.HA) {
            change.insts.forEach(function (ins) {
                funcs = funcs.concat([
                    function imgadmInstallForInst(_, next) {
                        s.imgadmInstallRemote({
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
                            domain: change.service.metadata.SERVICE_DOMAIN,
                            cnapi: opts.sdcadm.cnapi
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
                    function waitForEachInstanceToBeUp(_, next) {
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
                    function waitUntilEachInstInDNS(_, next) {
                        s.waitUntilVmInDNS({
                            log: opts.log,
                            progress: progress,
                            zonename: ins.zonename,
                            server: ins.server,
                            alias: ins.alias,
                            domain: change.service.metadata.SERVICE_DOMAIN,
                            cnapi: opts.sdcadm.cnapi
                        }, next);
                    }
                ]);
            });
        } else {
            funcs = funcs.concat([
                function imgadmInstall(ctx, next) {
                    s.imgadmInstallRemote({
                        progress: progress,
                        img: ctx.change.image,
                        log: opts.log,
                        server: ctx.change.inst.server
                    }, next);
                },
                /**
                 * Create a temporary "morayXtmp" instance when no HA
                 */
                function provisionTmpVm(ctx, next) {
                    if (ctx.tmpInstanceExists) {
                        next();
                        return;
                    }
                    var provOpts = {
                        opts: {
                            progress: progress,
                            sdcadm: opts.sdcadm,
                            log: opts.log
                        },
                        tmpAlias: ctx.tmpAlias,
                        change: ctx.change,
                        server_uuid: ctx.change.inst.server
                    };
                    s.provisionTmpVm(provOpts, function provCb(provErr) {
                        if (provErr) {
                            next(provErr);
                            return;
                        }
                        if (!provOpts.tmpUUID) {
                            next(new errors.InternalError('Provisioning ' +
                                'temporary VM did not return VM UUID'));
                            return;
                        }
                        ctx.tmpUUID = provOpts.tmpUUID;
                        next();
                    });
                },

                function waitForTmpInstToBeUp(ctx, next) {
                    if (ctx.tmpInstanceExists) {
                        next();
                        return;
                    }
                    s.waitForInstToBeUp({
                        opts: {
                            progress: progress,
                            sdcadm: opts.sdcadm,
                            log: opts.log
                        },
                        tmpUUID: ctx.tmpUUID,
                        change: ctx.change
                    }, next);
                },
                function waitUntilTmpInDNS(ctx, next) {
                    if (ctx.tmpInstanceExists) {
                        next();
                        return;
                    }
                    s.waitUntilVmInDNS({
                        log: opts.log,
                        progress: progress,
                        zonename: ctx.tmpUUID,
                        alias: ctx.tmpAlias,
                        server: ctx.change.inst.server,
                        domain: ctx.change.service.metadata.SERVICE_DOMAIN,
                        cnapi: opts.sdcadm.cnapi
                    }, next);
                },
                function disableVMRegistrar(ctx, next) {
                    s.disableVMRegistrar({
                        log: opts.log,
                        progress: progress,
                        zonename: ctx.change.inst.zonename
                    }, next);
                },
                function waitUntilVMNotInDNS(ctx, next) {
                    s.waitUntilVMNotInDNS({
                        log: opts.log,
                        progress: progress,
                        zonename: ctx.change.inst.zonename,
                        server: ctx.change.inst.server,
                        alias: ctx.change.inst.alias,
                        domain: ctx.change.service.metadata.SERVICE_DOMAIN,
                        cnapi: opts.sdcadm.cnapi
                    }, next);
                },
                function reprovisionSingleInst(ctx, next) {
                    s.reprovisionRemote({
                        server: ctx.change.inst.server,
                        img: ctx.change.image,
                        zonename: ctx.change.inst.zonename,
                        progress: progress,
                        log: opts.log,
                        sdcadm: opts.sdcadm
                    }, next);
                },
                function waitForInstanceToBeUp(ctx, next) {
                    s.waitForInstToBeUp({
                        opts: {
                            progress: progress,
                            sdcadm: opts.sdcadm,
                            log: opts.log
                        },
                        change: {
                            inst: ctx.change.inst
                        }
                    }, next);
                },
                function waitUntilInstInDNS(ctx, next) {
                    s.waitUntilVmInDNS({
                        log: opts.log,
                        progress: progress,
                        zonename: ctx.change.inst.zonename,
                        server: ctx.change.inst.server,
                        alias: ctx.change.inst.alias,
                        domain: ctx.change.service.metadata.SERVICE_DOMAIN,
                        cnapi: opts.sdcadm.cnapi
                    }, next);
                },
                function disableTmpVMRegistrar(ctx, next) {
                    s.disableVMRegistrar({
                        zonename: ctx.tmpUUID,
                        alias: ctx.change.inst.alias,
                        server: ctx.change.inst.server,
                        domain: ctx.change.service.metadata.SERVICE_DOMAIN,
                        sdcadm: opts.sdcadm
                    }, next);
                },
                function waitUntilTmpVMNotInDNS(ctx, next) {
                    s.waitUntilVMNotInDNS({
                        log: opts.log,
                        progress: progress,
                        zonename: ctx.tmpUUID,
                        alias: ctx.tmpAlias,
                        server: ctx.change.inst.server,
                        domain: ctx.change.service.metadata.SERVICE_DOMAIN,
                        cnapi: opts.sdcadm.cnapi
                    }, next);
                },
                function destroyTmpVm(ctx, next) {
                    s.destroyTmpVM(ctx, next);
                }
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
                nextSvc(new errors.SDCClientError(err, 'SAPI'));
                return;
            }
            if (!insts || !insts.length) {
                nextSvc(new errors.InternalError(
                    'Cannot find any instance in SAPI'));
                return;
            }
            // Try to find if any of the existing SAPI instances is a temporary
            // one left around from a previous update failure:
            var tmpInsts = insts.filter(function findTmpInsts(ins) {
                return (ins.params && ins.params.alias &&
                    TMP_VM_RE.test(ins.params.alias));
            });
            if (tmpInsts.length) {
                change.tmpInsts = tmpInsts;
                // In case we have temporary instances, we will not update
                // them. Just take advantage of it (probably will have just
                // a single temporary instance) in order to speed up the
                // update process. Remove temporary instances from main
                // "insts" object:
                if (change.insts) {
                    change.insts = change.insts.filter(
                        function skipTmpInst(ins) {
                        return (ins.alias && !TMP_VM_RE.test(ins.alias));
                    });
                }
            }

            // Shortcut to single instance update:
            if (change.insts && change.insts.length === 1 && !change.inst) {
                change.inst = change.insts[0];
            }

            // Having a temporary instance doesn't mean we're on HA setup:
            if ((insts.length > 1 && !tmpInsts.length) ||
                (insts.length >= tmpInsts.length + 1)) {
                change.HA = true;
            }

            if (!change.insts) {
                change.insts = [change.inst];
            }
            updateMoray(change, nextSvc);
        });
    }

    vasync.forEachPipeline({
        inputs: self.changes,
        func: checkServiceHA
    }, cb);
};
// --- exports

module.exports = {
    UpdateMorayV2: UpdateMorayV2
};
// vim: set softtabstop=4 shiftwidth=4:
