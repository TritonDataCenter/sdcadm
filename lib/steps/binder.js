/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018 Joyent, Inc.
 */

/*
 * Steps for checking all the "core" VMs for the correct resolvers.
 */

var assert = require('assert-plus');
var vasync = require('vasync');

var errors = require('../errors');
var shared = require('../procedures/shared');

/**
 * Compare current resolvers value for 'core' VMs with expected value
 * from 'binder' instances, and return an object containing only those
 * VMs which need an update.
 *
 * Callback function will be called with the aforementioned object as
 * its second argument, (the first argument will be any error which could
 * happen during the process).
 *
 * Format for this object is:
 *
 * {
 *      VM_UUID: {
 *          expected: [resolvers],
 *          current: [resolvers]
 *      },
 *      VM_UUID_2: ...
 * }
 *
 */
function checkCoreVmInstancesResolvers(arg, cb) {
    assert.object(arg, 'arg');
    assert.func(arg.progress, 'arg.progress');
    assert.object(arg.log, 'arg.log');
    assert.object(arg.sdcadm, 'arg.sdcadm');
    assert.object(arg.sdcadm.sdcApp, 'arg.sdcaadm.sdcApp');
    assert.optionalObject(arg.ctx, 'arg.ctx');
    assert.func(cb, 'cb');

    var sdcadm = arg.sdcadm;
    var context = arg.ctx || {};
    var app = sdcadm.sdcApp;

    vasync.pipeline({
        arg: context,
        funcs: [
            function getBinderSvc(ctx, next) {
                if (ctx.binderSvc) {
                    next();
                    return;
                }
                sdcadm.sapi.listServices({
                    name: 'binder',
                    application_uuid: app.uuid
                }, function (svcErr, svcs) {
                    if (svcErr) {
                        next(svcErr);
                        return;
                    }
                    if (svcs.length) {
                        ctx.binderSvc = svcs[0];
                    }
                    next();
                });
            },

            function getBinderInsts(ctx, next) {
                if (ctx.binderInsts) {
                    next();
                    return;
                }
                sdcadm.sapi.listInstances({
                    service_uuid: ctx.binderSvc.uuid
                }, function (instErr, insts) {
                    if (instErr) {
                        next(instErr);
                        return;
                    }
                    ctx.binderInsts = insts;
                    next();
                });
            },

            function getBinderVms(ctx, next) {
                if (ctx.binderVms && ctx.binderIps) {
                    next();
                    return;
                }
                sdcadm.vmapi.listVms({
                    'tag.smartdc_role': 'binder',
                    state: 'running'
                }, function (vmsErr, vms) {
                    if (vmsErr) {
                        next(vmsErr);
                        return;
                    }
                    ctx.binderVms = vms;
                    // Binder instances have only admin Ips:
                    ctx.binderIps = vms.map(function (vm) {
                        return (vm.nics[0].ip);
                    });
                    next();
                });
            },

            function getExternalNetworkResolvers(ctx, next) {
                if (ctx.externalNetworkResolvers) {
                    next();
                    return;
                }
                sdcadm.napi.listNetworks({
                    name: 'external'
                }, function (err, nets) {
                    if (err) {
                        next(new errors.SDCClientError(
                            err, 'napi'));
                        return;
                    }

                    if (!nets.length) {
                        next(new errors.InternalError(new Error(
                            'Cannot find external network in NAPI')));
                        return;
                    }

                    ctx.externalNetworkResolvers = nets[0].resolvers;
                    next();
                });
            },

            function getSdcVmServices(ctx, next) {
                if (ctx.coreSvcs) {
                    next();
                    return;
                }
                sdcadm.getServices({
                    type: 'vm'
                }, function (svcsErr, svcs) {
                    if (svcsErr) {
                        next(svcsErr);
                        return;
                    }
                    ctx.coreSvcs = svcs.map(function (s) {
                        return s.uuid;
                    }).filter(function (x) {
                        return (x !== undefined && x !== null);
                    });
                    next();
                });
            },

            function getSdcSapiVmInstances(ctx, next) {
                if (ctx.coreInstances) {
                    next();
                    return;
                }
                vasync.forEachPipeline({
                    inputs: ctx.coreSvcs,
                    func: function getSvcInstances(service, nextSvc) {
                        if (!ctx.coreInstances) {
                            ctx.coreInstances = [];
                        }

                        sdcadm.sapi.listInstances({
                            service_uuid: service
                        }, function (sapiErr, insts) {
                            if (sapiErr) {
                                nextSvc(new errors.SDCClientError(
                                    sapiErr, 'sapi'));
                                return;
                            }
                            ctx.coreInstances = ctx.coreInstances.concat(
                                insts.map(function (ins) {
                                    return ins.uuid;
                                })
                            );
                            nextSvc();
                        });
                    }
                }, next);
            },

            function getSdcCoreVms(ctx, next) {
                if (ctx.coreVms) {
                    next();
                    return;
                }

                vasync.forEachPipeline({
                    inputs: ctx.coreInstances,
                    func: function getInstanceVm(inst, nextInst) {
                        if (!ctx.coreVms) {
                            ctx.coreVms = [];
                        }

                        sdcadm.vmapi.getVm({
                            uuid: inst
                        }, function (vmapiErr, vm) {
                            if (vmapiErr) {
                                nextInst(new errors.SDCClientError(
                                    vmapiErr, 'vmapi'));
                                return;
                            }
                            ctx.coreVms.push(vm);
                            nextInst();
                        });
                    }
                }, next);

            },

            function checkVmResolvers(ctx, next) {
                ctx.fixableResolvers = {};

                vasync.forEachParallel({
                    inputs: ctx.coreVms,
                    func: function checkResolvers(vm, nextVm) {
                        // Binder VMs and eventually, anything we want to
                        // avoid resolvers:
                        if ((vm.resolvers && vm.resolvers.length === 0) &&
                            vm.internal_metadata &&
                            (vm.internal_metadata.set_resolvers === false)) {
                            nextVm();
                            return;
                        }

                        var hasAdminNic = false;
                        var unknownNicTag = false;
                        var resolvers = [];
                        vm.nics.forEach(function (nic) {
                            if (nic.nic_tag === 'admin') {
                                resolvers = resolvers.concat(
                                    ctx.binderIps);
                                hasAdminNic = true;
                            } else if (nic.nic_tag === 'external') {
                                resolvers = resolvers.concat(
                                    ctx.externalNetworkResolvers);
                            } else {
                                unknownNicTag = nic.nic_tag;
                            }
                        });

                        if (unknownNicTag) {
                            arg.progress('Skip VM %s (%s): unknown NIC tag %s',
                                vm.uuid, vm.alias, unknownNicTag);
                            nextVm();
                            return;
                        }

                        if (!hasAdminNic) {
                            nextVm();
                            return;
                        }

                        // Resolvers must match exactly on the same order:
                        var fixResolvers = false;
                        fixResolvers = resolvers.some(function (el, id) {
                            return (vm.resolvers[id] !== el);
                        });
                        if (!fixResolvers) {
                            fixResolvers = vm.resolvers.some(function (el, id) {
                                return (resolvers[id] !== el);
                            });
                        }
                        if (fixResolvers) {
                            ctx.fixableResolvers[vm.uuid] = {
                                current: vm.resolvers,
                                expected: resolvers,
                                alias: vm.alias
                            };
                        }
                        nextVm();
                    }
                }, next);
            }
        ]
    }, function (pipeErr) {
        cb(pipeErr, context.fixableResolvers);
    });
}

/**
 * The expected format for 'arg.fixableResolvers' is the value
 * returnted by checkCoreVmInstancesResolvers.
 */
function updateCoreVmsResolvers(arg, cb) {
    assert.object(arg, 'arg');
    assert.func(arg.progress, 'arg.progress');
    assert.object(arg.log, 'arg.log');
    assert.object(arg.sdcadm, 'arg.sdcadm');
    assert.object(arg.fixableResolvers, 'arg.fixableResolvers');
    assert.func(cb, 'cb');

    var sdcadm = arg.sdcadm;
    var log = arg.log.child({ component: 'updateCoreVmsResolvers'}, true);

    vasync.forEachPipeline({
        inputs: Object.keys(arg.fixableResolvers),
        func: function updateVmResolvers(vm, nextVm) {
            log.debug({
                vm: vm,
                resolvers: arg.fixableResolvers[vm].expected
            }, 'Updating VM resolvers');

            sdcadm.vmapi.updateVm({
                uuid: vm,
                payload: {
                    resolvers: arg.fixableResolvers[vm].expected
                }
            }, function (vmapiErr, vmapiRes) {
                if (vmapiErr) {
                    nextVm(new errors.SDCClientError(vmapiErr, 'vmapi'));
                    return;
                }

                log.debug(vmapiRes, 'waiting for VM job');

                shared.waitForJob({
                    sdcadm: sdcadm,
                    job_uuid: vmapiRes.job_uuid
                }, function (jobErr) {
                    if (jobErr) {
                        nextVm(new errors.SDCClientError(jobErr, 'wfapi'));
                        return;
                    }
                    arg.progress('Updated resolvers for vm: %s', vm);
                    nextVm();
                });
            });
        }
    }, cb);
}
// --- exports

module.exports = {
    checkCoreVmInstancesResolvers: checkCoreVmInstancesResolvers,
    updateCoreVmsResolvers: updateCoreVmsResolvers
};

// vim: set softtabstop=4 shiftwidth=4:
