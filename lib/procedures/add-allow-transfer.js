/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

'use strict';

/*
 * Procedure to add the IPs of instances of a given service to the CNS service's
 * allow_transfer list through SAPI. This allows these instances to issue
 * AXFR/IXFR requests to CNS.
 */
var assert = require('assert-plus');
var sprintf = require('extsprintf').sprintf;
var util = require('util');
var vasync = require('vasync');

var errors = require('../errors');
var Procedure = require('./procedure').Procedure;

/*
 * Constructor options:
 * - svcName (String): Name of service whose instances' IPs we're adding
 * - nicTag (String): Nic tag used when determining which IP to add (e.g.
 *   'admin')
 * - volatile (Boolean): Optional; false by default. Caller should set this to
 *   true if we're running other procedures in `runProcs` that might create,
 *   delete, or modify instances of 'svcName' or CNS in their execute()
 *   functions. Setting 'volatile' to true will defer the work of determining
 *   which IPs to add from the prepare() function to the execute() function.
 *   Assuming the caller places the other relevant procedures before this
 *   procedure in the procedure list, this will ensure that all changes to
 *   instances have been made before this procedure's execute() function runs,
 *   allowing an accurate lookup of services and IPs.
 */
function AddAllowTransferProcedure(options) {
    assert.object(options, 'options');
    assert.string(options.svcName, 'options.svcName');
    assert.string(options.nicTag, 'options.nicTag');
    assert.optionalBool(options.volatile, 'options.volatile');

    this.svcName = options.svcName;
    this.nicTag = options.nicTag;
    this.volatile = options.volatile === undefined ? false : options.volatile;
}
util.inherits(AddAllowTransferProcedure, Procedure);

/*
 * Get the CNS service object and the IPs of all instances of 'svcName', and
 * determine which IPs aren't in the CNS service's allow_transfer list. If
 * 'volatile' is true, defers this work to the execute() function.
 *
 * Object properties set by this method, if 'volatile' is false, are:
 * - cnsSvc (Object): CNS service object
 * - newIps (Array of String): IPs not yet in the allow_transfer list
 */
AddAllowTransferProcedure.prototype.prepare =
    function addAllowTransferPrepare(opts, cb) {

    const self = this;

    assert.object(opts, 'opts');
    assert.func(cb, 'cb');

    assert.string(self.svcName, 'self.svcName');
    assert.string(self.nicTag, 'self.nicTag');
    assert.bool(self.volatile, 'self.volatile');

    /*
     * If the user has specified the 'volatile' flag, return early; defer all
     * work to the 'execute' function.
     */
    if (self.volatile) {
        cb(null, false);
        return;
    }

    self.doVolatileOperations(opts, function didVolatile(err, results) {
        if (err) {
            cb(err);
            return;
        }
        const nothingToDo = self.newIps.length === 0;
        cb(null, nothingToDo);
    });
};


AddAllowTransferProcedure.prototype.summarize =
    function addAllowTransferSummarize() {

    const self = this;
    let msg = '';

    if (self.volatile) {
        /*
         * If the user has specified the 'volatile' flag, print a generic update
         * message -- we don't know the specific IPs yet.
         */
        msg = sprintf('Add all "%s" service %s IPs to CNS allow_transfer list',
            self.svcName, self.nicTag);
    } else {
        /*
         * Otherwise, verify that prepare has run already and print the specific
         * new IPs.
         */
        assert.array(self.newIps, 'self.newIps');
        assert.object(self.cnsSvc, 'self.cnsSvc');
        if (self.newIps.length > 0) {
            msg = sprintf(
                'Add new "%s" service %s IPs (%s) to CNS allow_transfer list',
                self.svcName, self.nicTag, self.newIps.join(', '));
        }
    }

    return msg;
};

/*
 * Add the new IPs to the CNS service's allow_transfer list. If 'volatile' is
 * true, this method also does the work of getting these IPs.
 *
 * Object properties set by this method, if 'volatile' is true, are:
 * - cnsSvc (Object): CNS service object
 * - newIps (Array of String) IPs not yet in the allow_transfer list
 *
 * If 'volatile' is false, these properties will have been set by prepare().
 */
AddAllowTransferProcedure.prototype.execute =
    function addAllowTransferExecute(opts, cb) {

    const self = this;
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.sdcadm.sapi, 'opts.sdcadm.sapi');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.ui, 'opts.ui');

    assert.func(cb, 'cb');

    const sapi = opts.sdcadm.sapi;
    const log = opts.log;
    const ui = opts.ui;

    vasync.pipeline({
        arg: {},
        funcs: [
            function doVolatileIfNecessary(_, next) {
                if (!self.volatile) {
                    next();
                    return;
                }
                self.doVolatileOperations(opts, next);
            }, function writeIps(_, next) {
                /*
                 * However we got here, volatile or not, these fields should
                 * exist at this point.
                 */
                assert.arrayOfString(self.newIps, 'self.newIps');
                assert.object(self.cnsSvc, 'self.cnsSvc');

                /*
                 * If the user specified the 'volatile' option, we may be here
                 * even though there's nothing to do -- we couldn't have known
                 * this ahead of time. Thus, we check if the list of new IPs is
                 * empty and return early if so.
                 */
                if (self.volatile && (self.newIps.length === 0)) {
                    ui.info('No new IPs to add for "%s" service', self.svcName);
                    log.info({
                        cnsSvc: self.cnsSvc.uuid,
                        volatile: true
                    }, 'No new IPs to add to CNS allow_transfer list');
                    next();
                    return;
                }

                const existingIps = self.cnsSvc.metadata.allow_transfer;
                const updatedIps = existingIps.concat(self.newIps);
                sapi.updateService(self.cnsSvc.uuid, {
                    metadata: {
                        allow_transfer: updatedIps
                    }
                }, function updatedCnsSvc(err) {
                    if (err) {
                        next(err);
                        return;
                    }
                    ui.info('Added %s to CNS allow_transfer list',
                        self.newIps.join(', '));
                    log.info({
                        newIps: self.newIps,
                        updatedIps: updatedIps,
                        cnsSvc: self.cnsSvc.uuid,
                        volatile: self.volatile
                    }, 'Added new IPs to CNS allow_transfer list');
                    next();
                });
            }
        ]
    }, cb);
};

/*
 * This method groups the set of operations whose place of execution in the
 * runProcs sequence is determined by the presence of the 'volatile' flag. This
 * method should be called from prepare() or execute() rather than directly.
 *
 * Object properties set by this method are:
 * - cnsSvc (Object): CNS service object
 * - newIps (Array of String): IPs not yet in the allow_transfer list
 */
AddAllowTransferProcedure.prototype.doVolatileOperations =
    function doVolatileOperations(opts, cb) {

    const self = this;

    assert.object(opts, 'opts');
    assert.func(cb, 'cb');

    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.sdcadm.sapi, 'opts.sdcadm.sapi');
    assert.object(opts.sdcadm.vmapi, 'opts.sdcadm.vmapi');

    assert.string(self.svcName, 'self.svcName');
    assert.string(self.nicTag, 'self.nicTag');

    const sdcadm = opts.sdcadm;
    const sapi = opts.sdcadm.sapi;
    const vmapi = opts.sdcadm.vmapi;
    const svcName = self.svcName;
    const nicTag = self.nicTag;

    let newIps = [];
    let cnsSvc;

    vasync.pipeline({
        arg: {},
        funcs: [
            sdcadm.ensureSdcApp.bind(sdcadm),
            function getCnsSvc(_, next) {
                sapi.listServices({
                    name: 'cns',
                    application_uuid: sdcadm.sdcApp.uuid
                }, function gotCnsSvc(err, svcs) {
                    if (err) {
                        next(new errors.SDCClientError(err, 'sapi'));
                        return;
                    }
                    assert.equal(svcs.length, 1, 'svcs.length === 1');
                    cnsSvc = svcs[0];
                    next();
                });
            },
            // Get the uuid corresponding to 'svcName'
            function getSvcUuid(ctx, next) {
                sapi.listServices({
                    name: svcName,
                    application_uuid: sdcadm.sdcApp.uuid
                }, function gotSvcs(err, svcs) {
                    if (err) {
                        next(new errors.SDCClientError(err, 'sapi'));
                        return;
                    }
                    if (svcs.length === 0) {
                        next(new errors.InternalError({
                            message: sprintf('No service found with name %s ' +
                                'under sdc application', svcName)
                        }));
                        return;
                    }
                    if (svcs.length > 1) {
                        next(new errors.InternalError({
                            message: sprintf('Multiple services found with ' +
                                'name %s under sdc application',
                                svcName)
                        }));
                        return;
                    }
                    ctx.svcUuid = svcs[0].uuid;
                    next();
                });
            },
            function getInstances(ctx, next) {
                sapi.listInstances({
                    service_uuid: ctx.svcUuid
                }, function gotInstances(err, insts) {
                    if (err) {
                        next(new errors.SDCClientError(err, 'sapi'));
                        return;
                    }
                    ctx.insts = insts;
                    next();
                });
            },
            function getNewIps(ctx, next) {
                /*
                 * We use a set to avoid doing a bunch of linear list
                 * lookups later.
                 */
                const existingIpSet = new Set(cnsSvc.metadata.allow_transfer);

                vasync.forEachParallel({
                    inputs: ctx.insts,
                    func: function getIp(inst, nextInst) {
                        vmapi.getVm({
                            uuid: inst.uuid
                        }, function gotVm(vmErr, vm) {
                            if (vmErr) {
                                nextInst(new errors.SDCClientError(vmErr,
                                    'vmapi'));
                                return;
                            }
                            // Find the IP corresponding to nicTag
                            var ip;
                            for (var i = 0; i < vm.nics.length; i++) {
                                var nic = vm.nics[i];
                                if (nic.nic_tag === nicTag) {
                                    ip = nic.ip;
                                }
                            }
                            if (ip === undefined) {
                                nextInst(new errors.InternalError(
                                    '%s instance %s has no %s ip',
                                    svcName, vm.uuid, nicTag));
                                return;
                            }
                            /*
                             * Add the IP to the list of new IPs if it isn't
                             * already in the allow_transfer set.
                             */
                            if (!existingIpSet.has(ip)) {
                                newIps.push(ip);
                            }
                            nextInst();
                        });
                    }
                }, next);
            }
        ]
    }, function pipelineDone(err) {
        if (err) {
            cb(err);
            return;
        }
        self.cnsSvc = cnsSvc;
        self.newIps = newIps;
        cb(null);
    });
};


// --- exports

module.exports = {
    AddAllowTransferProcedure: AddAllowTransferProcedure
};

// vim: set softtabstop=4 shiftwidth=4:
